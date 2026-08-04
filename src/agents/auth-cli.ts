import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import {
  inspectAgentAuth,
  loginAgentProvider,
  logoutAgentProvider,
  type AgentAuthEvent,
  type AgentAuthPrompt,
  type AgentAuthType,
} from "./auth-service.js";

export const AGENT_AUTH_PROTOCOL = "vspilink-agent-auth-v1";

interface PendingPrompt {
  secret: boolean;
  resolve(value: string): void;
  reject(error: Error): void;
  cleanup(): void;
}

type Emit = (message: Record<string, unknown>) => void;

/**
 * NDJSON sidecar used by the graphical VS Code flow. Secret answers travel
 * only from the extension to this process over stdin and are never echoed.
 */
export async function runAgentAuthCli(args: readonly string[]): Promise<number> {
  const [command = "capabilities", ...rest] = args;
  const flags = parseFlags(rest);
  const emit: Emit = (message) => {
    process.stdout.write(`${JSON.stringify({ protocol: AGENT_AUTH_PROTOCOL, ...message })}\n`);
  };
  try {
    if (command === "capabilities" || command === "catalog" || command === "status") {
      const catalog = await inspectAgentAuth(flags.agentDir);
      emit({ type: "result", command, catalog });
      return 0;
    }
    if (command === "logout") {
      const providerId = requiredFlag(flags.provider, "--provider");
      await logoutAgentProvider(providerId, flags.agentDir);
      emit({ type: "complete", command, providerId });
      return 0;
    }
    if (command !== "login") throw new Error("Unknown agent-auth command");

    const providerId = requiredFlag(flags.provider, "--provider");
    const authType = validateAuthType(requiredFlag(flags.authType, "--auth-type"));
    const oauthMethod = flags.oauthMethod;
    const controller = new AbortController();
    const pending = new Map<string, PendingPrompt>();
    const input = createInterface({ input: process.stdin, terminal: false });
    const cancel = () => controller.abort(new Error("Agent login cancelled"));
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    input.on("line", (line) => consumePromptResponse(line, pending));
    input.once("close", () => {
      for (const prompt of pending.values()) prompt.reject(new Error("Agent login input closed"));
      pending.clear();
    });
    emit({ type: "ready", command: "login", providerId, authType });
    try {
      const result = await loginAgentProvider({
        providerId,
        authType,
        agentDir: flags.agentDir,
        interaction: {
          signal: controller.signal,
          prompt: (prompt) => {
            if (prompt.type === "select" && oauthMethod && prompt.options.some((option) => option.id === oauthMethod)) {
              return Promise.resolve(oauthMethod);
            }
            return requestPrompt(prompt, pending, emit, controller.signal);
          },
          notify: (event) => emit({ type: "auth_event", event: publicAuthEvent(event) }),
        },
      });
      emit({ type: "complete", command: "login", result });
      return 0;
    } finally {
      process.off("SIGINT", cancel);
      process.off("SIGTERM", cancel);
      input.close();
      for (const prompt of pending.values()) prompt.reject(new Error("Agent login completed"));
      pending.clear();
    }
  } catch (error) {
    emit({ type: "error", code: "agent_auth_failed", message: safeMessage(error) });
    return 1;
  }
}

interface AuthCliFlags {
  provider?: string;
  authType?: string;
  oauthMethod?: string;
  agentDir?: string;
}

function parseFlags(args: readonly string[]): AuthCliFlags {
  const parsed: AuthCliFlags = {};
  const supported = new Map([
    ["--provider", "provider"],
    ["--auth-type", "authType"],
    ["--oauth-method", "oauthMethod"],
    ["--agent-dir", "agentDir"],
  ] as const);
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    const field = supported.get(key as typeof supported extends Map<infer K, string> ? K : never);
    if (!field) throw new Error(`Unknown agent-auth option: ${key}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--") || /[\0\r\n]/.test(value)) throw new Error(`${key} requires a value`);
    (parsed as Record<string, string>)[field] = value;
    index += 1;
  }
  return parsed;
}

function requestPrompt(
  prompt: AgentAuthPrompt,
  pending: Map<string, PendingPrompt>,
  emit: Emit,
  loginSignal: AbortSignal,
): Promise<string> {
  if (pending.size >= 4) return Promise.reject(new Error("Too many pending agent login prompts"));
  const promptId = randomUUID();
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      operation();
    };
    const abort = () => finish(() => reject(new Error("Agent login prompt cancelled")));
    const cleanup = () => {
      pending.delete(promptId);
      loginSignal.removeEventListener("abort", abort);
      prompt.signal?.removeEventListener("abort", abort);
    };
    pending.set(promptId, {
      secret: prompt.type === "secret",
      resolve: (value) => finish(() => resolve(value)),
      reject: (error) => finish(() => reject(error)),
      cleanup,
    });
    loginSignal.addEventListener("abort", abort, { once: true });
    prompt.signal?.addEventListener("abort", abort, { once: true });
    emit({
      type: "prompt",
      prompt: {
        promptId,
        kind: prompt.type,
        message: bounded(prompt.message, 1_000),
        ...(prompt.type !== "select" && prompt.placeholder
          ? { placeholder: bounded(prompt.placeholder, 1_000) }
          : {}),
        ...(prompt.type === "select"
          ? {
              options: prompt.options.slice(0, 100).map((option) => ({
                id: bounded(option.id, 200),
                label: bounded(option.label, 300),
                ...(option.description ? { description: bounded(option.description, 500) } : {}),
              })),
            }
          : {}),
      },
    });
  });
}

function consumePromptResponse(line: string, pending: Map<string, PendingPrompt>): void {
  if (!line || Buffer.byteLength(line, "utf8") > 32 * 1024) return;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (record.protocol !== AGENT_AUTH_PROTOCOL || record.type !== "prompt_response") return;
  if (typeof record.promptId !== "string" || typeof record.value !== "string") return;
  const prompt = pending.get(record.promptId);
  if (!prompt) return;
  if (Buffer.byteLength(record.value, "utf8") > 16 * 1024 || /[\0\r\n]/.test(record.value)) {
    prompt.reject(new Error("Agent login response is invalid"));
    return;
  }
  prompt.resolve(record.value);
}

function publicAuthEvent(event: AgentAuthEvent): Record<string, unknown> {
  if (event.type === "auth_url") {
    return {
      type: event.type,
      url: safeExternalUrl(event.url),
      ...(event.instructions ? { instructions: bounded(event.instructions, 1_000) } : {}),
    };
  }
  if (event.type === "device_code") {
    return {
      type: event.type,
      userCode: bounded(event.userCode, 200),
      verificationUri: safeExternalUrl(event.verificationUri),
      ...(event.intervalSeconds !== undefined ? { intervalSeconds: boundedNumber(event.intervalSeconds) } : {}),
      ...(event.expiresInSeconds !== undefined ? { expiresInSeconds: boundedNumber(event.expiresInSeconds) } : {}),
    };
  }
  return {
    type: event.type,
    message: bounded(event.message, 1_000),
    ...(event.links
      ? {
          links: event.links.slice(0, 20).map((link) => ({
            url: safeExternalUrl(link.url),
            ...(link.label ? { label: bounded(link.label, 300) } : {}),
          })),
        }
      : {}),
  };
}

function safeExternalUrl(value: string): string {
  if (value.length > 4_096 || /[\0\r\n]/.test(value)) throw new Error("Agent login URL is invalid");
  const url = new URL(value);
  const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password) {
    throw new Error("Agent login URL is not allowed");
  }
  return url.toString();
}

function validateAuthType(value: string): AgentAuthType {
  if (value === "oauth" || value === "api_key") return value;
  throw new Error("--auth-type must be oauth or api_key");
}

function requiredFlag(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Agent authentication failed";
  return bounded(message, 1_000)
    .replace(/\bBearer\s+\S+/giu, "Bearer [REDACTED]")
    .replace(/([?&](?:code|token|secret|key|state)=)[^&\s]+/giu, "$1[REDACTED]")
    .replace(/\b[A-Za-z0-9_-]{64,}\b/gu, "[REDACTED]");
}

function bounded(value: string, maxBytes: number): string {
  const clean = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, " ");
  if (Buffer.byteLength(clean, "utf8") <= maxBytes) return clean;
  return Buffer.from(clean, "utf8").subarray(0, maxBytes).toString("utf8").replace(/\uFFFD$/u, "");
}

function boundedNumber(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(24 * 60 * 60, value)) : 0;
}
