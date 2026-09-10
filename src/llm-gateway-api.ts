import { createHmac, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import express, { type NextFunction, type Request, type Response } from "express";
import type { Server } from "node:http";
import {
  GATEWAY_DEFAULT_QUEUE_TIMEOUT_SECONDS,
  GATEWAY_DEFAULT_REQUEST_TIMEOUT_SECONDS,
  GATEWAY_MODEL,
  GatewayRequestQueueTimeoutError,
  GatewayRequestTimeoutError,
  LlmGatewayJobStore,
  type GatewayAssistantCompletion,
  type GatewayRequestPayload,
} from "./llm-gateway-store.js";
import { validateGatewayRequestPayload } from "./llm-gateway-protocol.js";

export type GatewayApiProfile = "compatibility" | "strict";

export interface GatewayApiOptions {
  store: LlmGatewayJobStore;
  apiKey: string;
  port: number;
  requestTimeoutSeconds?: number;
  queueTimeoutSeconds?: number;
  host?: string;
  profile?: GatewayApiProfile;
  log?: (message: string) => void;
}

export interface StartedGatewayApi {
  server: Server;
  host: string;
  port: number;
  baseUrl: string;
  /** Resolves only after listen succeeds and port/baseUrl contain the bound address. */
  ready: Promise<void>;
  close: () => Promise<void>;
}

interface ParsedCompletionRequest {
  payload: GatewayRequestPayload;
  stream: boolean;
  includeUsage: boolean;
  profile: GatewayApiProfile;
  warnings: string[];
}

class GatewayApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    message: string,
    readonly param?: string,
  ) {
    super(message);
    this.name = "GatewayApiRequestError";
  }
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
const GATEWAY_PROFILE_HEADER = "X-PiLink-Gateway-Profile";
const GATEWAY_WARNING_HEADER = "X-PiLink-Gateway-Warnings";
const GATEWAY_STREAM_HEADER = "X-PiLink-Gateway-Stream";
const GATEWAY_USAGE_HEADER = "X-PiLink-Gateway-Usage";
const IGNORED_COMPATIBILITY_FIELDS = new Set([
  "temperature",
  "top_p",
  "max_tokens",
  "max_completion_tokens",
  "store",
  "user",
  "stop",
  "seed",
  "presence_penalty",
  "frequency_penalty",
  "logit_bias",
  "service_tier",
  "reasoning_effort",
  "prompt_cache_key",
  "prompt_cache_retention",
  "tool_stream",
  "chat_template_kwargs",
]);
const STRICT_REJECTED_FIELDS = new Set([
  ...IGNORED_COMPATIBILITY_FIELDS,
  "stream_options",
  "response_format",
]);

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
  const queueTimeoutSeconds = options.queueTimeoutSeconds ?? GATEWAY_DEFAULT_QUEUE_TIMEOUT_SECONDS;
  if (!Number.isSafeInteger(queueTimeoutSeconds) || queueTimeoutSeconds < 1 || queueTimeoutSeconds > 24 * 60 * 60) {
    throw new Error("Gateway queue timeout must be a positive integer number of seconds");
  }
  const apiKey = validateApiKey(options.apiKey);
  const configuredProfile = validateProfile(options.profile ?? "compatibility");
  const log = options.log ?? ((message: string) => console.error(message));

  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (!authenticateApiKey(req.headers.authorization, apiKey)) {
      res.status(401).json(openAiError("invalid_api_key", "Invalid PiLink gateway API key"));
      return;
    }
    next();
  });
  app.use(express.json({ limit: MAX_BODY_BYTES }));

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

  app.get("/v1/gateway/capabilities", (_req, res) => {
    res.json(gatewayCapabilities(configuredProfile));
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
    let profile: GatewayApiProfile;
    try {
      profile = requestProfile(req.headers[GATEWAY_PROFILE_HEADER.toLowerCase()], configuredProfile);
      res.setHeader(GATEWAY_PROFILE_HEADER, profile);
      parsed = parseCompletionRequest(req.body, profile);
      applyCapabilityHeaders(res, parsed);
    } catch (error) {
      const requestError = asRequestError(error);
      const requestedProfile = safeRequestProfile(req.headers[GATEWAY_PROFILE_HEADER.toLowerCase()], configuredProfile);
      res.setHeader(GATEWAY_PROFILE_HEADER, requestedProfile);
      res.status(requestError.status).json(openAiError(requestError.type, requestError.message, requestError.param));
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
        const result = await options.store.waitForResult(
          job.requestId,
          requestTimeoutSeconds,
          controller.signal,
          queueTimeoutSeconds,
        );
        if (responseClosed && !res.writableEnded) return;
        if (result.status === "completed") {
          const completion = result.response ?? { content: "" };
          if (parsed.stream) {
            sendBufferedChatCompletionStream(res, result.requestId, result.createdAt, completion, parsed.includeUsage, parsed.profile);
          } else {
            res.json(chatCompletionObject(result.requestId, result.createdAt, completion, parsed.profile));
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
          await options.store.cancelRequest(job.requestId, error.message).catch(() => undefined);
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
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = expressErrorStatus(error);
    if (status === 413 || (isRecord(error) && error.type === "entity.too.large")) {
      res.status(413).json(openAiError("invalid_request_error", "Request body exceeds PiLink's 2 MiB limit."));
      return;
    }
    if (status === 400 || (isRecord(error) && error.type === "entity.parse.failed")) {
      res.status(400).json(openAiError("invalid_request_error", "Request body must be valid JSON."));
      return;
    }
    res.status(500).json(openAiError("gateway_error", "PiLink gateway request failed"));
  });

  let actualPort = options.port;
  let currentBaseUrl = gatewayBaseUrl(host, actualPort);
  let resolveReady: () => void = () => undefined;
  let rejectReady: (error: Error) => void = () => undefined;
  let readySettled = false;
  let bindState: "pending" | "listening" | "failed" | "closed" = "pending";
  let closeRequested = false;
  let closePromise: Promise<void> | undefined;
  let resolveClose: (() => void) | undefined;
  let rejectClose: ((error: Error) => void) | undefined;
  let closeCallInFlight = false;
  let closeSettled = false;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // Closing before listen rejects readiness by design. This handler keeps a
  // caller that only awaits close() from creating an unhandled rejection.
  void ready.catch(() => undefined);

  const finishClose = (error?: Error): void => {
    if (!closePromise || closeSettled) return;
    closeSettled = true;
    if (error) rejectClose?.(error);
    else resolveClose?.();
  };
  const issueClose = (): void => {
    if (closeSettled || closeCallInFlight) return;
    closeCallInFlight = true;
    try {
      // Calling close while listen/DNS setup is pending cancels the pending
      // bind. Do not use server.listening as a readiness test: it is false
      // during that interval, and returning there leaves a late listener.
      server.close((error) => {
        closeCallInFlight = false;
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        if (error && code !== "ERR_SERVER_NOT_RUNNING") {
          finishClose(error);
          return;
        }
        // ERR_SERVER_NOT_RUNNING is only terminal once the bind lifecycle has
        // emitted close or failed. If DNS setup races this call, the
        // listening/error handlers below finish the same close promise.
        if (bindState !== "pending") finishClose();
      });
    } catch (error) {
      closeCallInFlight = false;
      finishClose(error instanceof Error ? error : new Error(String(error)));
    }
  };
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closeRequested = true;
    if (!readySettled) {
      readySettled = true;
      rejectReady(gatewayClosedError());
    }
    closePromise = new Promise<void>((resolve, reject) => {
      resolveClose = resolve;
      rejectClose = reject;
    });
    issueClose();
    return closePromise;
  };

  const server = app.listen(options.port, host);
  server.unref();
  const started = {
    server,
    host,
    get port() { return actualPort; },
    get baseUrl() { return currentBaseUrl; },
    ready,
    close,
  } as StartedGatewayApi;
  server.once("close", () => {
    bindState = "closed";
    if (closeRequested) finishClose();
  });
  server.once("listening", () => {
    bindState = "listening";
    const address = server.address();
    if (typeof address !== "object" || address === null) {
      bindState = "failed";
      const error = new Error("Gateway API did not report a bound loopback address");
      if (!readySettled) {
        readySettled = true;
        rejectReady(error);
      }
      if (closeRequested) issueClose();
      return;
    }
    actualPort = (address as AddressInfo).port;
    currentBaseUrl = gatewayBaseUrl(host, actualPort);
    if (closeRequested) {
      issueClose();
      return;
    }
    if (!readySettled) {
      readySettled = true;
      log(`[Gateway] OpenAI-compatible endpoint: ${currentBaseUrl}`);
      log(`[Gateway] Model field: ${GATEWAY_MODEL} (selection remains controlled by the ChatGPT conversation)`);
      log(`[Gateway] API key: ${apiKey}`);
      log("[Gateway] Send the wake command in ChatGPT, then keep that conversation in gateway_exchange until released.");
      resolveReady();
    }
  });
  server.once("error", (error: NodeJS.ErrnoException) => {
    bindState = "failed";
    const message = error.code === "EADDRINUSE"
      ? `Could not bind local API on ${host}:${options.port}: address already in use.`
      : `Local API error: ${error.message}`;
    log(`[Gateway] ${message}`);
    if (!readySettled) {
      readySettled = true;
      rejectReady(error instanceof Error ? error : new Error(message));
    }
    if (closeRequested) finishClose();
  });

  return started;
}

function parseCompletionRequest(value: unknown, profile: GatewayApiProfile): ParsedCompletionRequest {
  if (!isRecord(value)) throw new GatewayApiRequestError(400, "invalid_request_error", "Request body must be a JSON object");
  assertAllowedKeys(value, ALLOWED_COMPLETION_KEYS, "chat completion");
  if (typeof value.model !== "string" || !value.model.trim()) throw new GatewayApiRequestError(400, "invalid_request_error", "model is required", "model");
  if (value.model !== GATEWAY_MODEL) {
    throw new GatewayApiRequestError(404, "model_not_found", `The requested model is not available; use model '${GATEWAY_MODEL}'.`, "model");
  }
  if (!Array.isArray(value.messages) || value.messages.length === 0) throw new GatewayApiRequestError(400, "invalid_request_error", "messages must be a non-empty array", "messages");

  const n = value.n;
  if (n !== undefined && (!Number.isSafeInteger(n) || n !== 1)) {
    throw new GatewayApiRequestError(400, "unsupported_parameter", "PiLink supports only n=1; multiple choices are not available.", "n");
  }

  const strictControls = profile === "strict" ? strictUnsupportedControls(value) : [];
  if (strictControls.length > 0) {
    throw new GatewayApiRequestError(
      400,
      "unsupported_parameter",
      `The strict gateway profile rejects unsupported controls: ${strictControls.join(", ")}.`,
      strictControls[0],
    );
  }

  for (const [index, message] of value.messages.entries()) {
    if (!isRecord(message)) throw new GatewayApiRequestError(400, "invalid_request_error", `messages[${index}] must be an object`, `messages[${index}]`);
    assertAllowedKeys(message, ALLOWED_MESSAGE_KEYS, `messages[${index}]`);
  }
  if (value.tools !== undefined) validateOpenAiToolEnvelope(value.tools);
  if (value.tool_choice !== undefined) validateOpenAiToolChoiceEnvelope(value.tool_choice);
  if (profile === "strict" && hasStrictSchemaRequest(value.tools)) {
    throw new GatewayApiRequestError(
      400,
      "unsupported_parameter",
      "The strict gateway profile does not implement function strict:true schema enforcement.",
      "tools[].function.strict",
    );
  }

  const stream = value.stream === undefined ? false : validateBoolean(value.stream, "stream");
  const includeUsage = parseStreamOptions(value.stream_options, stream);
  const warnings = profile === "compatibility" ? compatibilityWarnings(value, includeUsage) : [];
  const payload = validateGatewayRequestPayload({
    model: GATEWAY_MODEL,
    messages: value.messages,
    ...(value.tools === undefined ? {} : { tools: value.tools }),
    ...(value.tool_choice === undefined ? {} : { toolChoice: value.tool_choice }),
    ...(value.parallel_tool_calls === undefined ? {} : { parallelToolCalls: value.parallel_tool_calls }),
  });
  return { payload, stream, includeUsage, profile, warnings };
}

function strictUnsupportedControls(value: Record<string, unknown>): string[] {
  return Object.keys(value).filter((key) => STRICT_REJECTED_FIELDS.has(key));
}

function hasStrictSchemaRequest(value: unknown): boolean {
  return Array.isArray(value) && value.some((tool) =>
    isRecord(tool) && isRecord(tool.function) && tool.function.strict === true,
  );
}

function compatibilityWarnings(value: Record<string, unknown>, includeUsage: boolean): string[] {
  const ignored = Object.keys(value).filter((key) => IGNORED_COMPATIBILITY_FIELDS.has(key));
  const warnings: string[] = [];
  if (ignored.length > 0) warnings.push(`ignored_controls=${ignored.join(",")}`);
  if (value.response_format !== undefined) warnings.push("unsupported=response_format");
  if (hasStrictSchemaRequest(value.tools)) warnings.push("unsupported=strict");
  if (includeUsage) warnings.push("usage=unavailable");
  return warnings;
}

function applyCapabilityHeaders(res: Response, parsed: ParsedCompletionRequest): void {
  res.setHeader(GATEWAY_USAGE_HEADER, "unavailable");
  if (parsed.stream) res.setHeader(GATEWAY_STREAM_HEADER, "buffered");
  if (parsed.warnings.length > 0) res.setHeader(GATEWAY_WARNING_HEADER, parsed.warnings.join("; "));
}

function requestProfile(value: string | string[] | undefined, configured: GatewayApiProfile): GatewayApiProfile {
  if (value === undefined) return configured;
  if (Array.isArray(value) || (value !== "compatibility" && value !== "strict")) {
    throw new GatewayApiRequestError(400, "invalid_request_error", `Use ${GATEWAY_PROFILE_HEADER}: compatibility or strict.`);
  }
  // A strict server profile cannot be weakened by a request header. A
  // compatibility server may opt one request into the stricter contract.
  return configured === "strict" || value === "strict" ? "strict" : "compatibility";
}

function safeRequestProfile(value: string | string[] | undefined, configured: GatewayApiProfile): GatewayApiProfile {
  try {
    return requestProfile(value, configured);
  } catch {
    return configured;
  }
}

function validateProfile(value: unknown): GatewayApiProfile {
  if (value !== "compatibility" && value !== "strict") {
    throw new Error("Gateway API profile must be 'compatibility' or 'strict'");
  }
  return value;
}

function gatewayCapabilities(configuredProfile: GatewayApiProfile) {
  return {
    object: "pilink.gateway.capabilities",
    version: 1,
    model: GATEWAY_MODEL,
    configured_profile: configuredProfile,
    default_profile: configuredProfile,
    profile_header: GATEWAY_PROFILE_HEADER,
    profiles: {
      compatibility: {
        default: configuredProfile === "compatibility",
        request_selectable: configuredProfile === "compatibility",
        preserves_ignored_controls: true,
        warning_header: GATEWAY_WARNING_HEADER,
      },
      strict: {
        default: configuredProfile === "strict",
        opt_in: configuredProfile === "compatibility",
        rejects_ignored_controls: true,
        rejects_function_strict_schema: true,
        rejects_response_format: true,
        rejects_unavailable_usage_options: true,
      },
    },
    contract: {
      model: GATEWAY_MODEL,
      accepted_models: [GATEWAY_MODEL],
      n: { accepted: [1], rejects_other: true },
      choices: 1,
      tools: "function",
      response_format: "unsupported",
      function_strict_schema: "unsupported",
      streaming: "buffered",
      usage: "unavailable",
      compatibility_usage_fields: "legacy_zeroes_only",
    },
    ignored_compatibility_controls: [...IGNORED_COMPATIBILITY_FIELDS],
  };
}

function gatewayBaseUrl(host: string, port: number): string {
  const urlHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${urlHost}:${port}/v1`;
}

function gatewayClosedError(): NodeJS.ErrnoException {
  const error = new Error("Gateway API closed before it became ready") as NodeJS.ErrnoException;
  error.code = "ERR_GATEWAY_CLOSED";
  return error;
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
  completion: GatewayAssistantCompletion,
  profile: GatewayApiProfile,
) {
  return {
    id: completionId(requestId),
    object: "chat.completion",
    created: createdSeconds(createdAt),
    model: GATEWAY_MODEL,
    choices: [{
      index: 0,
      message: assistantMessage(completion),
      finish_reason: finishReason(completion),
    }],
    ...(profile === "compatibility"
      ? { usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }
      : {}),
  };
}

function sendBufferedChatCompletionStream(
  res: Response,
  requestId: string,
  createdAt: string,
  completion: GatewayAssistantCompletion,
  includeUsage: boolean,
  profile: GatewayApiProfile,
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
    model: GATEWAY_MODEL,
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
  if (profile === "compatibility" && includeUsage) {
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

function asRequestError(error: unknown): GatewayApiRequestError {
  if (error instanceof GatewayApiRequestError) return error;
  return new GatewayApiRequestError(400, "invalid_request_error", errorMessage(error, "Invalid chat completion request"));
}

function openAiError(type: string, message: string, param?: string) {
  return { error: { type, message, ...(param ? { param } : {}) } };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function expressErrorStatus(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  const status = error.statusCode ?? error.status;
  return typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599
    ? status
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
