import { loadEnvironment, loadRuntimeConfig } from "./config.js";
import { deriveGatewayApiKey } from "./llm-gateway-api.js";

export type GatewayControlAction = "status" | "release";

export async function runGatewayControl(action: GatewayControlAction, reason?: string): Promise<number> {
  try {
    loadEnvironment();
    const config = loadRuntimeConfig();
    const defaultPort = config.port <= 65525 ? config.port + 10 : 3210;
    const port = gatewayPort(process.env.PI_LLM_GATEWAY_PORT, defaultPort);
    const apiKey = process.env.PI_LLM_GATEWAY_API_KEY?.trim() || deriveGatewayApiKey(config.jwtSecret);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3_000);
    timer.unref();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/gateway/${action}`, {
        method: action === "release" ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          ...(action === "release" ? { "Content-Type": "application/json" } : {}),
        },
        ...(action === "release" ? { body: JSON.stringify(reason ? { reason } : {}) } : {}),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => undefined) as Record<string, unknown> | undefined;
      if (!response.ok) {
        const error = isRecord(payload?.error) && typeof payload?.error.message === "string"
          ? payload.error.message
          : `Gateway control request failed (${response.status})`;
        console.error(error);
        return 1;
      }
      printStatus(payload);
      return 0;
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      /fetch failed|aborted|ECONNREFUSED/iu.test(message)
        ? "PiLink gateway is not reachable on this machine. Start it with 'pilink gateway start' and wake the connected ChatGPT conversation."
        : message,
    );
    return 1;
  }
}

function printStatus(payload: Record<string, unknown> | undefined): void {
  if (!payload) {
    console.log("Gateway status unavailable");
    return;
  }
  const state = typeof payload.state === "string" ? payload.state : "unknown";
  console.log(`Gateway: ${state}`);
  if (typeof payload.last_exchange_at === "string") console.log(`Last exchange: ${payload.last_exchange_at}`);
  for (const key of ["queued", "claimed", "completed", "failed", "cancelled"] as const) {
    if (typeof payload[key] === "number") console.log(`${key}: ${payload[key]}`);
  }
  if (typeof payload.release_reason === "string") console.log(`Release reason: ${payload.release_reason}`);
}

function gatewayPort(value: string | undefined, fallback: number): number {
  if (value === undefined || !value.trim()) return fallback;
  if (!/^\d+$/u.test(value.trim())) throw new Error("PI_LLM_GATEWAY_PORT must be an integer TCP port");
  const selected = Number(value);
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > 65535) {
    throw new Error("PI_LLM_GATEWAY_PORT must be from 1 through 65535");
  }
  return selected;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
