import { createHmac, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import express from "express";
import type { Server } from "node:http";
import {
  GATEWAY_DEFAULT_REQUEST_TIMEOUT_SECONDS,
  GATEWAY_MODEL,
  GatewayRequestTimeoutError,
  LlmGatewayJobStore,
  type GatewayMessage,
  type GatewayRequestPayload,
} from "./llm-gateway-store.js";

export interface GatewayApiOptions {
  store: LlmGatewayJobStore;
  apiKey: string;
  port: number;
  requestTimeoutSeconds?: number;
  host?: string;
  log?: (message: string) => void;
}

export interface StartedGatewayApi {
  server: Server;
  host: string;
  port: number;
  baseUrl: string;
  close: () => Promise<void>;
}

const MAX_API_KEY_BYTES = 512;
const MAX_MODEL_BYTES = 128;
const MAX_BODY_BYTES = "2mb";
const ALLOWED_COMPLETION_KEYS = new Set(["model", "messages", "stream"]);
const ALLOWED_MESSAGE_KEYS = new Set(["role", "content", "name", "tool_call_id"]);
const MESSAGE_ROLES = new Set(["system", "developer", "user", "assistant", "tool"]);

export function deriveGatewayApiKey(jwtSecret: string): string {
  if (typeof jwtSecret !== "string" || jwtSecret.length < 32) throw new Error("JWT secret is unavailable for gateway API-key derivation");
  return `plg_${createHmac("sha256", jwtSecret)
    .update("pilink/llm-gateway/local-api-key/v1", "utf8")
    .digest("base64url")}`;
}

export function startGatewayApi(options: GatewayApiOptions): StartedGatewayApi {
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    throw new Error("PiLink LLM gateway API is loopback-only");
  }
  if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new Error("Gateway API port must be an integer from 0 through 65535");
  }
  const requestTimeoutSeconds = options.requestTimeoutSeconds ?? GATEWAY_DEFAULT_REQUEST_TIMEOUT_SECONDS;
  if (!Number.isSafeInteger(requestTimeoutSeconds) || requestTimeoutSeconds < 1 || requestTimeoutSeconds > 24 * 60 * 60) {
    throw new Error("Gateway request timeout must be a positive integer number of seconds");
  }
  const apiKey = validateApiKey(options.apiKey);
  const log = options.log ?? ((message: string) => console.error(message));

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: MAX_BODY_BYTES }));
  app.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (!authenticateApiKey(req.headers.authorization, apiKey)) {
      res.status(401).json(openAiError("invalid_api_key", "Invalid PiLink gateway API key"));
      return;
    }
    next();
  });

  app.get("/v1/gateway/status", async (_req, res) => {
    try {
      res.json(await options.store.status());
    } catch {
      res.status(500).json(openAiError("gateway_state_error", "Unable to read PiLink gateway state"));
    }
  });

  app.post("/v1/gateway/release", async (req, res) => {
    try {
      const reason = optionalReleaseReason(req.body);
      await options.store.release(reason);
      res.json(await options.store.status());
    } catch (error) {
      res.status(400).json(openAiError("invalid_request_error", errorMessage(error, "Unable to release the PiLink gateway")));
    }
  });

  app.post("/v1/chat/completions", async (req, res) => {
    let payload: GatewayRequestPayload;
    try {
      payload = parseCompletionRequest(req.body);
    } catch (error) {
      res.status(400).json(openAiError("invalid_request_error", errorMessage(error, "Invalid chat completion request")));
      return;
    }

    try {
      if (!await options.store.isAvailable()) {
        res.status(503).json(openAiError(
          "pilink_chat_inactive",
          "No active ChatGPT gateway loop. Send the PiLink wake command in the connected ChatGPT conversation first.",
        ));
        return;
      }

      const job = await options.store.enqueueRequest(payload);
      const controller = new AbortController();
      let responseClosed = false;
      const onClose = () => {
        responseClosed = true;
        if (!res.writableEnded) controller.abort();
      };
      res.once("close", onClose);

      try {
        const result = await options.store.waitForResult(job.requestId, requestTimeoutSeconds, controller.signal);
        if (responseClosed && !res.writableEnded) return;
        if (result.status === "completed") {
          const created = Math.floor(Date.parse(result.createdAt) / 1000);
          res.json({
            id: `chatcmpl_${result.requestId.slice(4)}`,
            object: "chat.completion",
            created: Number.isFinite(created) ? created : Math.floor(Date.now() / 1000),
            model: payload.model || GATEWAY_MODEL,
            choices: [{
              index: 0,
              message: { role: "assistant", content: result.response ?? "" },
              finish_reason: "stop",
            }],
          });
          return;
        }
        if (result.status === "failed") {
          res.status(502).json(openAiError("gateway_completion_failed", result.error || "ChatGPT failed to complete the gateway request"));
          return;
        }
        res.status(499).json(openAiError("gateway_request_cancelled", result.error || "Gateway request was cancelled"));
      } catch (error) {
        if (error instanceof GatewayRequestTimeoutError) {
          await options.store.cancelRequest(job.requestId, "Gateway request timed out").catch(() => undefined);
          if (!res.headersSent) res.status(504).json(openAiError("gateway_timeout", error.message));
          return;
        }
        if (controller.signal.aborted) {
          await options.store.cancelRequest(job.requestId, "Local API client disconnected").catch(() => undefined);
          return;
        }
        throw error;
      } finally {
        res.off("close", onClose);
      }
    } catch (error) {
      if (!res.headersSent) {
        const message = errorMessage(error, "PiLink gateway request failed");
        const status = /queue is full/iu.test(message) ? 429 : 500;
        res.status(status).json(openAiError(status === 429 ? "rate_limit_error" : "gateway_error", message));
      }
    }
  });

  app.use((_req, res) => {
    res.status(404).json(openAiError("not_found", "Gateway endpoint not found"));
  });

  const server = app.listen(options.port, host);
  server.unref();
  server.once("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      log(`[Gateway] Could not bind local API on ${host}:${options.port}: address already in use.`);
    } else {
      log(`[Gateway] Local API error: ${error.message}`);
    }
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address !== null
    ? (address as AddressInfo).port
    : options.port;
  const baseUrl = `http://${host}:${actualPort}/v1`;
  log(`[Gateway] OpenAI-compatible endpoint: ${baseUrl}`);
  log(`[Gateway] Model field: ${GATEWAY_MODEL} (selection remains controlled by the ChatGPT conversation)`);
  log(`[Gateway] API key: ${apiKey}`);
  log("[Gateway] Send the wake command in ChatGPT, then keep that conversation in gateway_exchange until released.");

  return {
    server,
    host,
    port: actualPort,
    baseUrl,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

function parseCompletionRequest(value: unknown): GatewayRequestPayload {
  if (!isRecord(value)) throw new Error("Request body must be a JSON object");
  for (const key of Object.keys(value)) {
    if (!ALLOWED_COMPLETION_KEYS.has(key)) throw new Error(`Unsupported chat completion field '${key}'`);
  }
  if (typeof value.model !== "string" || !value.model.trim()) throw new Error("model is required");
  if (Buffer.byteLength(value.model, "utf8") > MAX_MODEL_BYTES) throw new Error("model is too long");
  if (value.stream === true) throw new Error("stream=true is not supported by PiLink gateway yet");
  if (value.stream !== undefined && value.stream !== false) throw new Error("stream must be false when supplied");
  if (!Array.isArray(value.messages) || value.messages.length === 0) throw new Error("messages must be a non-empty array");

  const messages: GatewayMessage[] = value.messages.map((candidate) => {
    if (!isRecord(candidate)) throw new Error("Each message must be an object");
    for (const key of Object.keys(candidate)) {
      if (!ALLOWED_MESSAGE_KEYS.has(key)) throw new Error(`Unsupported message field '${key}'`);
    }
    if (typeof candidate.role !== "string" || !MESSAGE_ROLES.has(candidate.role)) throw new Error("Message role is invalid");
    if (typeof candidate.content !== "string") throw new Error("Message content must be a string");
    const message: GatewayMessage = {
      role: candidate.role as GatewayMessage["role"],
      content: candidate.content,
    };
    if (candidate.name !== undefined) {
      if (typeof candidate.name !== "string") throw new Error("Message name must be a string");
      message.name = candidate.name;
    }
    if (candidate.tool_call_id !== undefined) {
      if (typeof candidate.tool_call_id !== "string") throw new Error("tool_call_id must be a string");
      message.tool_call_id = candidate.tool_call_id;
    }
    return message;
  });
  return { model: value.model, messages };
}

function optionalReleaseReason(value: unknown): string {
  if (value === undefined) return "Gateway released by the local operator";
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "reason")) throw new Error("Release body may contain only reason");
  if (value.reason === undefined) return "Gateway released by the local operator";
  if (typeof value.reason !== "string" || !value.reason.trim() || Buffer.byteLength(value.reason, "utf8") > 64 * 1024) {
    throw new Error("Release reason is invalid");
  }
  return value.reason;
}

function validateApiKey(value: string): string {
  if (!value || Buffer.byteLength(value, "utf8") > MAX_API_KEY_BYTES || /[\r\n\0]/u.test(value)) {
    throw new Error("Gateway API key is invalid");
  }
  return value;
}

function authenticateApiKey(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = header.slice("Bearer ".length);
  const left = Buffer.from(supplied, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function openAiError(type: string, message: string) {
  return { error: { type, message } };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
