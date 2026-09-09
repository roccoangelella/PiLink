import { loadRuntimeConfig } from "./config.js";
import { deriveGatewayApiKey, startGatewayApi, type StartedGatewayApi } from "./llm-gateway-api.js";
import { gatewayApiPortForMcp } from "./llm-gateway-ports.js";
import {
  GATEWAY_DEFAULT_CLAIM_LEASE_SECONDS,
  GATEWAY_DEFAULT_QUEUE_TIMEOUT_SECONDS,
  GATEWAY_DEFAULT_REQUEST_TIMEOUT_SECONDS,
  GATEWAY_DEFAULT_STALE_SECONDS,
  LlmGatewayJobStore,
} from "./llm-gateway-store.js";

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
  const store = new LlmGatewayJobStore({
    workspace: config.workspace,
    dataDir: config.dataDir,
    staleAfterSeconds,
    claimLeaseSeconds,
  });
  const ready = store.activate();
  ready.catch((error) => {
    console.error(`[Gateway] Unable to initialize durable gateway state: ${error instanceof Error ? error.message : String(error)}`);
  });
  const api = startGatewayApi({
    store,
    apiKey,
    port: gatewayPort,
    requestTimeoutSeconds,
    queueTimeoutSeconds,
  });
  sharedRuntime = { store, api, apiKey, ready };
  return sharedRuntime;
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

function gatewayPortValue(value: string | undefined, fallback: number): number {
  if (value === undefined || !value.trim()) return fallback;
  if (!/^\d+$/u.test(value.trim())) throw new Error("PI_LLM_GATEWAY_PORT must be an integer TCP port");
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("PI_LLM_GATEWAY_PORT must be from 1 through 65535");
  return port;
}
