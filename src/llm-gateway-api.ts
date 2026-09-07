import { createHmac, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import express, { type Response } from "express";
import type { Server } from "node:http";
import {
  GATEWAY_DEFAULT_REQUEST_TIMEOUT_SECONDS,
  GATEWAY_MODEL,
  GatewayRequestTimeoutError,
  LlmGatewayJobStore,
  type GatewayAssistantCompletion,
  type GatewayRequestPayload,
} from "./llm-gateway-store.js";
import { validateGatewayRequestPayload } from "./llm-gateway-protocol.js";

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

interface ParsedCompletionRequest {
  payload: GatewayRequestPayload;
  stream: boolean;
  includeUsage: boolean;
}

const MAX_API_KEY_BYTES = 512;
const MAX_BODY_BYTES = "2mb";
const ALLOWED_COMPLETION_KEYS = new Set([
  "model",
  "messages",
  "stream",
  "stream_options",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "temperature",
  "top_p",
  "max_tokens",
  "max_completion_tokens",
  "store",
  "user",
  "stop",
  "seed",
  "n",
  "presence_penalty",
  "frequency_penalty",
  "logit_bias",
  "response_format",
  "service_tier",
  "reasoning_effort",
  "prompt_cache_key",
  "prompt_cache_retention",
  "tool_stream",
  "chat_template_kwargs",
]);
const ALLOWED_MESSAGE_KEYS = new Set([
  "role",
  "content",
  "name",
  "tool_call_id",
  "tool_calls",
  "refusal",
  "reasoning_content",
  "reasoning_details",
]);
const ALLOWED_TOOL_KEYS = new Set(["type", "function"]);
const ALLOWED_FUNCTION_KEYS = new Set(["name", "description", "parameters", "strict"]);
const ALLOWED_TOOL_CHOICE_KEYS = new Set(["type", "function"]);
const ALLOWED_TOOL_CHOICE_FUNCTION_KEYS = new Set(["name"]);
const ALLOWED_STREAM_OPTIONS_KEYS = new Set(["include_usage"]);

export function deriveGatewayApiKey(jwtSecret: string): string {
  if (typeof jwtSecret !== "string" || jwtSecret.length < 32) throw new Error("JWT secret is unavailable for gateway API-key derivation");
  return `plg_${createHmac("sha256", jwtSecret)
    .update("pilink/llm-gateway/local-api-key/v1", "utf8")
    .digest("base64url")}`;
}

export function startGatewayApi(options: GatewayApiOptions): StartedGatewayApi {
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") throw new Error("PiLink LLM gateway API is loopback-only");
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

  app.get("/v1/models", (_req, res) => {
    res.json({
      object: "list",
      data: [{ id: GATEWAY_MODEL, object: "model", created: 0, owned_by: "pilink" }],
    });
  });

  app.get("/v1/models/:model", (req, res) => {
    if (req.params.model !== GATEWAY_MODEL) {
      res.status(404).json(openAiError("model_not_found", `Model '${req.params.model}' is not available`));
      return;
    }
    res.json({ id: GATEWAY_MODEL, object: "model", created: 0, owned_by: "pilink" });
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
    let parsed: ParsedCompletionRequest;
    try {
      parsed = parseCompletionRequest(req.body);
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

      const job = await options.store.enqueueRequest(parsed.payload);
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
          const completion = result.response ?? { content: "" };
          if (parsed.stream) {
            sendBufferedChatCompletionStream(res, result.requestId, result.createdAt, parsed.payload.model, completion, parsed.includeUsage);
          } else {
            res.json(chatCompletionObject(result.requestId, result.createdAt, parsed.payload.model, completion));
          }
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
    if (error.code === "EADDRINUSE") log(`[Gateway] Could not bind local API on ${host}:${options.port}: address already in use.`);
    else log(`[Gateway] Local API error: ${error.message}`);
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address !== null ? (address as AddressInfo).port : options.port;
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

function parseCompletionRequest(value: unknown): ParsedCompletionRequest {
  if (!isRecord(value)) throw new Error("Request body must be a JSON object");
  assertAllowedKeys(value, ALLOWED_COMPLETION_KEYS, "chat completion");
  if (typeof value.model !== "string" || !value.model.trim()) throw new Error("model is required");
  if (!Array.isArray(value.messages) || value.messages.length === 0) throw new Error("messages must be a non-empty array");
  for (const [index, message] of value.messages.entries()) {
    if (!isRecord(message)) throw new Error(`messages[${index}] must be an object`);
    assertAllowedKeys(message, ALLOWED_MESSAGE_KEYS, `messages[${index}]`);
  }
  if (value.tools !== undefined) validateOpenAiToolEnvelope(value.tools);
  if (value.tool_choice !== undefined) validateOpenAiToolChoiceEnvelope(value.tool_choice);

  const stream = value.stream === undefined ? false : validateBoolean(value.stream, "stream");
  const includeUsage = parseStreamOptions(value.stream_options, stream);
  const payload = validateGatewayRequestPayload({
    model: value.model,
    messages: value.messages,
    ...(value.tools === undefined ? {} : { tools: value.tools }),
    ...(value.tool_choice === undefined ? {} : { toolChoice: value.tool_choice }),
    ...(value.parallel_tool_calls === undefined ? {} : { parallelToolCalls: value.parallel_tool_calls }),
  });
  return { payload, stream, includeUsage };
}

function validateOpenAiToolEnvelope(value: unknown): void {
  if (!Array.isArray(value)) throw new Error("tools must be an array");
  for (const [index, tool] of value.entries()) {
    if (!isRecord(tool)) throw new Error(`tools[${index}] must be an object`);
    assertAllowedKeys(tool, ALLOWED_TOOL_KEYS, `tools[${index}]`);
    if (!isRecord(tool.function)) throw new Error(`tools[${index}].function must be an object`);
    assertAllowedKeys(tool.function, ALLOWED_FUNCTION_KEYS, `tools[${index}].function`);
  }
}

function validateOpenAiToolChoiceEnvelope(value: unknown): void {
  if (value === "none" || value === "auto" || value === "required") return;
  if (!isRecord(value)) throw new Error("tool_choice is invalid");
  assertAllowedKeys(value, ALLOWED_TOOL_CHOICE_KEYS, "tool_choice");
  if (!isRecord(value.function)) throw new Error("tool_choice.function must be an object");
  assertAllowedKeys(value.function, ALLOWED_TOOL_CHOICE_FUNCTION_KEYS, "tool_choice.function");
}

function parseStreamOptions(value: unknown, stream: boolean): boolean {
  if (value === undefined) return false;
  if (!stream) throw new Error("stream_options may be supplied only when stream=true");
  if (!isRecord(value)) throw new Error("stream_options must be an object");
  assertAllowedKeys(value, ALLOWED_STREAM_OPTIONS_KEYS, "stream_options");
  return value.include_usage === undefined ? false : validateBoolean(value.include_usage, "stream_options.include_usage");
}

function chatCompletionObject(
  requestId: string,
  createdAt: string,
  model: string,
  completion: GatewayAssistantCompletion,
) {
  return {
    id: completionId(requestId),
    object: "chat.completion",
    created: createdSeconds(createdAt),
    model: model || GATEWAY_MODEL,
    choices: [{
      index: 0,
      message: assistantMessage(completion),
      finish_reason: finishReason(completion),
    }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function sendBufferedChatCompletionStream(
  res: Response,
  requestId: string,
  createdAt: string,
  model: string,
  completion: GatewayAssistantCompletion,
  includeUsage: boolean,
): void {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const base = {
    id: completionId(requestId),
    object: "chat.completion.chunk",
    created: createdSeconds(createdAt),
    model: model || GATEWAY_MODEL,
  };
  const delta: Record<string, unknown> = { role: "assistant" };
  if (completion.content !== null) delta.content = completion.content;
  if (completion.tool_calls?.length) {
    delta.tool_calls = completion.tool_calls.map((call, index) => ({
      index,
      id: call.id,
      type: "function",
      function: { name: call.function.name, arguments: call.function.arguments },
    }));
  }
  writeSse(res, {
    ...base,
    choices: [{ index: 0, delta, finish_reason: null }],
  });
  writeSse(res, {
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason(completion) }],
  });
  if (includeUsage) {
    writeSse(res, {
      ...base,
      choices: [],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

function assistantMessage(completion: GatewayAssistantCompletion) {
  return {
    role: "assistant",
    content: completion.content,
    ...(completion.tool_calls?.length ? { tool_calls: completion.tool_calls } : {}),
  };
}

function finishReason(completion: GatewayAssistantCompletion): "stop" | "tool_calls" {
  return completion.tool_calls?.length ? "tool_calls" : "stop";
}

function writeSse(res: Response, value: unknown): void {
  res.write(`data: ${JSON.stringify(value)}\n\n`);
}

function completionId(requestId: string): string {
  return `chatcmpl_${requestId.slice(4)}`;
}

function createdSeconds(createdAt: string): number {
  const created = Math.floor(Date.parse(createdAt) / 1000);
  return Number.isFinite(created) ? created : Math.floor(Date.now() / 1000);
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
  if (!value || Buffer.byteLength(value, "utf8") > MAX_API_KEY_BYTES || /[\r\n\0]/u.test(value)) throw new Error("Gateway API key is invalid");
  return value;
}

function authenticateApiKey(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = header.slice("Bearer ".length);
  const left = Buffer.from(supplied, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, field: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`Unsupported ${field} field '${key}'`);
  }
}

function validateBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} must be boolean`);
  return value;
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
