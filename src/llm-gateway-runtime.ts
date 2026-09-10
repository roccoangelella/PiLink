import { loadRuntimeConfig } from "./config.js";
import { deriveGatewayApiKey, startGatewayApi, type StartedGatewayApi } from "./llm-gateway-api.js";
import { gatewayApiPortForMcp } from "./llm-gateway-ports.js";
import {
  GATEWAY_DEFAULT_CLAIM_LEASE_SECONDS,
  GATEWAY_DEFAULT_QUEUE_TIMEOUT_SECONDS,
  GATEWAY_DEFAULT_REQUEST_TIMEOUT_SECONDS,
  GATEWAY_DEFAULT_STALE_SECONDS,
  GATEWAY_MODEL,
  LlmGatewayJobStore,
} from "./llm-gateway-store.js";

export const GATEWAY_STARTUP_PROBE_TIMEOUT_MS = 3_000;

export interface LlmGatewayRuntime {
  store: LlmGatewayJobStore;
  api: StartedGatewayApi;
  apiKey: string;
  ready: Promise<void>;
}

let sharedRuntime: LlmGatewayRuntime | undefined;

export function gatewayModeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(?:1|true|yes|on)$/iu.test(env.PI_LLM_GATEWAY_ENABLED?.trim() ?? "");
}

export function getLlmGatewayRuntime(): LlmGatewayRuntime {
  if (sharedRuntime) return sharedRuntime;
  if (!gatewayModeEnabled()) throw new Error("PiLink LLM gateway mode is not enabled");

  const config = loadRuntimeConfig();
  const staleAfterSeconds = gatewayInteger(
    process.env.PI_LLM_GATEWAY_STALE_SECONDS,
    GATEWAY_DEFAULT_STALE_SECONDS,
    "PI_LLM_GATEWAY_STALE_SECONDS",
  );
  const requestTimeoutSeconds = gatewayInteger(
    process.env.PI_LLM_GATEWAY_REQUEST_TIMEOUT_SECONDS,
    GATEWAY_DEFAULT_REQUEST_TIMEOUT_SECONDS,
    "PI_LLM_GATEWAY_REQUEST_TIMEOUT_SECONDS",
  );
  const queueTimeoutSeconds = gatewayInteger(
    process.env.PI_LLM_GATEWAY_QUEUE_TIMEOUT_SECONDS,
    GATEWAY_DEFAULT_QUEUE_TIMEOUT_SECONDS,
    "PI_LLM_GATEWAY_QUEUE_TIMEOUT_SECONDS",
  );
  const claimLeaseSeconds = gatewayInteger(
    process.env.PI_LLM_GATEWAY_CLAIM_LEASE_SECONDS,
    Math.max(GATEWAY_DEFAULT_CLAIM_LEASE_SECONDS, requestTimeoutSeconds + 60),
    "PI_LLM_GATEWAY_CLAIM_LEASE_SECONDS",
  );
  const defaultGatewayPort = gatewayApiPortForMcp(config.port);
  const gatewayPort = gatewayPortValue(process.env.PI_LLM_GATEWAY_PORT, defaultGatewayPort);
  const apiKey = process.env.PI_LLM_GATEWAY_API_KEY?.trim() || deriveGatewayApiKey(config.jwtSecret);
  const profile = gatewayProfile(process.env.PI_LLM_GATEWAY_PROFILE);
  const store = new LlmGatewayJobStore({
    workspace: config.workspace,
    dataDir: config.dataDir,
    staleAfterSeconds,
    claimLeaseSeconds,
  });
  const activation = store.activate();
  let api: StartedGatewayApi;
  try {
    api = startGatewayApi({
      store,
      apiKey,
      port: gatewayPort,
      requestTimeoutSeconds,
      queueTimeoutSeconds,
      profile,
    });
  } catch (error) {
    // Activation starts before synchronous API validation/bind setup. Consume
    // its rejection if API construction fails so startup cannot orphan an
    // unhandled durable-store promise.
    void activation.catch(() => undefined);
    throw error;
  }
  // Attach to both startup branches immediately. In particular, an occupied
  // API port can fail before a slower durable-store activation completes.
  const ready = Promise.all([activation, api.ready]).then(() =>
    probeGatewayReadiness(api.baseUrl, apiKey),
  );
  ready.catch((error: unknown) => {
    console.error(`[Gateway] Unable to become ready: ${error instanceof Error ? error.message : String(error)}`);
    void api.close().catch(() => undefined);
  });
  sharedRuntime = { store, api, apiKey, ready };
  return sharedRuntime;
}

export async function probeGatewayReadiness(
  baseUrl: string,
  apiKey: string,
  request: typeof fetch = fetch,
  timeoutMs = GATEWAY_STARTUP_PROBE_TIMEOUT_MS,
): Promise<void> {
  const controller = new AbortController();
  let timedOut = false;
  let rejectDeadline: (reason?: unknown) => void = () => undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    rejectDeadline(new Error("Gateway readiness probe deadline elapsed"));
  }, timeoutMs);
  timer.unref();
  try {
    const response = await Promise.race([
      request(`${baseUrl}/models`, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      }),
      deadline,
    ]);
    if (!response.ok) throw new Error(`Gateway readiness probe returned HTTP ${response.status}`);
    const body = await Promise.race([response.json() as Promise<{ data?: Array<{ id?: unknown }> }>, deadline]);
    if (body.data?.[0]?.id !== GATEWAY_MODEL) {
      throw new Error("Gateway readiness probe did not expose the pilink model");
    }
  } catch (error) {
    if (timedOut) throw new Error(`Gateway readiness probe timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function gatewayInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || !value.trim()) return fallback;
  if (!/^\d+$/u.test(value.trim())) throw new Error(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 24 * 60 * 60) {
    throw new Error(`${name} must be between 1 and 86400 seconds`);
  }
  return parsed;
}

function gatewayProfile(value: string | undefined): "compatibility" | "strict" {
  if (value === undefined || !value.trim()) return "compatibility";
  const profile = value.trim().toLowerCase();
  if (profile === "compatibility" || profile === "strict") return profile;
  throw new Error("PI_LLM_GATEWAY_PROFILE must be 'compatibility' or 'strict'");
}

function gatewayPortValue(value: string | undefined, fallback: number): number {
  if (value === undefined || !value.trim()) return fallback;
  if (!/^\d+$/u.test(value.trim())) throw new Error("PI_LLM_GATEWAY_PORT must be an integer TCP port");
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("PI_LLM_GATEWAY_PORT must be from 1 through 65535");
  return port;
}
