import { loadEnvironment, loadRuntimeConfig } from "./config.js";
import { deriveGatewayApiKey } from "./llm-gateway-api.js";
import { gatewayApiPortForMcp } from "./llm-gateway-ports.js";
import { gatewayCompactOutputEnabled, writeGatewayCompactBlock } from "./llm-gateway-output.js";

export interface GatewayConnectorInfo {
  mcpUrl: string;
  apiBaseUrl: string;
  apiKey: string;
  pairingUrl?: string;
  verificationCode?: string;
  expiresAt?: string;
}

export async function openGatewayConnectorWindow(waitMilliseconds = 30_000): Promise<GatewayConnectorInfo> {
  loadEnvironment();
  const config = loadRuntimeConfig();
  const deadline = Date.now() + waitMilliseconds;
  let lastError: Error | undefined;

  while (Date.now() <= deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${config.port}/admin/oauth/pairing`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.bootstrapSecret}`,
          accept: "application/json",
        },
        redirect: "error",
        signal: AbortSignal.timeout(2_000),
      });
      const body = await response.text();
      if (!response.ok) {
        if (response.status === 404 || response.status === 403) {
          throw new Error(`PiLink could not open the ChatGPT registration window (HTTP ${response.status}).`);
        }
        throw new RetryableGatewayConnectError(`PiLink connector setup is not ready yet (HTTP ${response.status}).`);
      }
      if (Buffer.byteLength(body, "utf8") > 16 * 1024) {
        throw new Error("PiLink returned an oversized connector setup response.");
      }
      const pairing = parsePairing(body);
      return {
        mcpUrl: `${config.serverUrl.replace(/\/$/u, "")}/sse`,
        apiBaseUrl: `http://127.0.0.1:${gatewayApiPort(process.env.PI_LLM_GATEWAY_PORT, config.port)}/v1`,
        apiKey: process.env.PI_LLM_GATEWAY_API_KEY?.trim() || deriveGatewayApiKey(config.jwtSecret),
        ...pairing,
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (!(lastError instanceof RetryableGatewayConnectError) && !isConnectionRetry(lastError)) throw lastError;
      if (Date.now() >= deadline) break;
      await delay(150);
    }
  }

  throw new Error(
    `PiLink gateway started but its local OAuth setup endpoint did not become ready${lastError ? `: ${lastError.message}` : "."}`,
  );
}

export function printGatewayReady(info: GatewayConnectorInfo): void {
  const interactiveApproval = process.stdin.isTTY === true && process.stderr.isTTY === true && process.env.CI !== "true";
  const lines = [
    "",
    "PiLink Gateway",
    "  Status        ready",
    interactiveApproval
      ? "  ChatGPT OAuth DCR open for 5 minutes; approve new connections in this terminal."
      : "  ChatGPT OAuth owner pairing required before a new connector can be authorized.",
    `  Logs          ${gatewayCompactOutputEnabled() ? "compact" : "verbose"}`,
    "",
    "Connection details",
    `  ChatGPT MCP   ${info.mcpUrl}`,
    `  Local API     ${info.apiBaseUrl}`,
    `  API key       ${info.apiKey}`,
  ];
  if (!interactiveApproval && info.pairingUrl && info.verificationCode) {
    lines.push(
      `  Owner pairing ${info.pairingUrl}`,
      `  Verify code   ${info.verificationCode}`,
    );
  }
  lines.push(
    "  OAuth setup   pilink gateway connect",
    "  Wake          @PiLink wake",
  );
  if (gatewayCompactOutputEnabled()) {
    lines.push("  Debug logs    PILINK_TERMINAL_LOGS=verbose pilink gateway start");
  }
  writeGatewayCompactBlock(lines);
}

export async function runGatewayConnect(): Promise<number> {
  try {
    const info = await openGatewayConnectorWindow(3_000);
    printGatewayReady(info);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function parsePairing(body: string): Pick<GatewayConnectorInfo, "pairingUrl" | "verificationCode" | "expiresAt"> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("PiLink returned an invalid connector setup response.");
  }
  if (!isRecord(parsed)) throw new Error("PiLink returned an invalid connector setup response.");
  const pairingUrl = parsed.pairing_url;
  const verificationCode = parsed.verification_code;
  const expiresAt = parsed.expires_at;
  if (
    typeof pairingUrl !== "string" ||
    typeof verificationCode !== "string" ||
    typeof expiresAt !== "string" ||
    !/^https?:\/\//u.test(pairingUrl) ||
    !/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/u.test(verificationCode) ||
    !Number.isFinite(Date.parse(expiresAt))
  ) {
    throw new Error("PiLink returned an invalid connector setup response.");
  }
  return { pairingUrl, verificationCode, expiresAt };
}

function gatewayApiPort(value: string | undefined, mcpPort: number): number {
  if (value === undefined || !value.trim()) return gatewayApiPortForMcp(mcpPort);
  if (!/^\d+$/u.test(value.trim())) throw new Error("PI_LLM_GATEWAY_PORT must be an integer TCP port.");
  const port = Number(value.trim());
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PI_LLM_GATEWAY_PORT must be from 1 through 65535.");
  }
  return port;
}

function isConnectionRetry(error: Error): boolean {
  return /fetch failed|ECONNREFUSED|aborted|socket|network/iu.test(error.message);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class RetryableGatewayConnectError extends Error {}
