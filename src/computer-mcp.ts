import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { HarnessPolicy } from "./harness.js";
import {
  createSystemComputerBackend,
  type ComputerAction,
  type ComputerBackend,
  type ComputerObservation,
} from "./computer.js";
import type { ToolAuditEventInput } from "./audit.js";

export interface ComputerToolAuditSink {
  record(input: ToolAuditEventInput): Promise<void>;
}

interface ComputerToolResult {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

const pointCoordinate = z.number().int().min(0).max(32_767);
const observeAfterMs = z.number().int().min(0).max(3_000).optional()
  .describe("Optional delay in milliseconds before PiLink captures the post-action screenshot. Defaults to 250 ms for state-changing actions.");
const mouseButton = z.enum(["left", "middle", "right"]).optional()
  .describe("Mouse button. Defaults to left.");

const computerActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("click").describe("Move to the coordinate and click once."),
    x: pointCoordinate.describe("Absolute X coordinate in screenshot pixels."),
    y: pointCoordinate.describe("Absolute Y coordinate in screenshot pixels."),
    button: mouseButton,
    observe_after_ms: observeAfterMs,
  }).strict(),
  z.object({
    action: z.literal("double_click").describe("Move to the coordinate and double-click."),
    x: pointCoordinate.describe("Absolute X coordinate in screenshot pixels."),
    y: pointCoordinate.describe("Absolute Y coordinate in screenshot pixels."),
    button: mouseButton,
    observe_after_ms: observeAfterMs,
  }).strict(),
  z.object({
    action: z.literal("move").describe("Move the mouse pointer without clicking."),
    x: pointCoordinate.describe("Absolute X coordinate in screenshot pixels."),
    y: pointCoordinate.describe("Absolute Y coordinate in screenshot pixels."),
    observe_after_ms: observeAfterMs,
  }).strict(),
  z.object({
    action: z.literal("drag").describe("Drag from one absolute screen coordinate to another."),
    from_x: pointCoordinate.describe("Starting X coordinate in screenshot pixels."),
    from_y: pointCoordinate.describe("Starting Y coordinate in screenshot pixels."),
    to_x: pointCoordinate.describe("Destination X coordinate in screenshot pixels."),
    to_y: pointCoordinate.describe("Destination Y coordinate in screenshot pixels."),
    button: mouseButton,
    observe_after_ms: observeAfterMs,
  }).strict(),
  z.object({
    action: z.literal("scroll").describe("Scroll horizontally and/or vertically at the current pointer location."),
    dx: z.number().int().min(-100).max(100).describe("Horizontal scroll steps. Positive scrolls right; negative scrolls left."),
    dy: z.number().int().min(-100).max(100).describe("Vertical scroll steps. Positive scrolls down; negative scrolls up."),
    observe_after_ms: observeAfterMs,
  }).strict(),
  z.object({
    action: z.literal("type").describe("Type literal text using the active desktop keyboard focus."),
    text: z.string().max(4_000).describe("Literal text to type. PiLink never evaluates it as a shell command."),
    observe_after_ms: observeAfterMs,
  }).strict(),
  z.object({
    action: z.literal("keypress").describe("Press one key or a modifier chord."),
    keys: z.array(z.string().min(1).max(32).describe("Key name such as CTRL, L, ENTER, TAB, ESC, or F5."))
      .min(1).max(8)
      .describe("Keys pressed as one chord, for example [\"CTRL\", \"L\"]."),
    observe_after_ms: observeAfterMs,
  }).strict(),
  z.object({
    action: z.literal("wait").describe("Wait without injecting input, then capture the desktop again."),
    duration_ms: z.number().int().min(0).max(10_000).describe("Time to wait in milliseconds."),
    observe_after_ms: observeAfterMs,
  }).strict(),
]);

const observationOutputSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  cursor: z.object({ x: z.number().int().nonnegative(), y: z.number().int().nonnegative() }).strict().optional(),
  captured_at: z.string(),
  backend: z.string(),
}).strict();

const actionOutputSchema = observationOutputSchema.extend({
  action: z.enum(["click", "double_click", "move", "drag", "scroll", "type", "keypress", "wait"]),
}).strict();

export function registerComputerTools(
  server: McpServer,
  policy: HarnessPolicy,
  scopes: string,
  audit?: ComputerToolAuditSink,
  clientId?: string,
  backend?: ComputerBackend,
): void {
  if (policy.computerControl !== true) return;
  const selectedBackend = backend ?? createSystemComputerBackend();

  server.registerTool("computer_observe", {
    title: "Observe Desktop",
    description: "Capture the current desktop as a PNG image for visual reasoning. Computer Use is an explicit Single Agent add-on and the screenshot may contain sensitive information visible on the desktop.",
    inputSchema: z.object({}).strict(),
    outputSchema: observationOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (_args, extra) => auditedComputerCall("computer_observe", policy, audit, clientId, extra.sessionId, async () => {
    if (!scopeAllowsRead(scopes)) return computerToolError("Token scope does not permit 'computer_observe'");
    try {
      return observationResult(await selectedBackend.observe());
    } catch (error) {
      return computerToolError(safeError(error, "Desktop observation failed"));
    }
  }));

  server.registerTool("computer_action", {
    title: "Act on Desktop",
    description: "Perform one mouse, keyboard, scroll, drag, or wait action on the local desktop, then return a fresh screenshot. Coordinates are absolute pixels from the latest observation. This tool can trigger arbitrary GUI side effects in other applications.",
    inputSchema: computerActionSchema,
    outputSchema: actionOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, (args, extra) => auditedComputerCall("computer_action", policy, audit, clientId, extra.sessionId, async () => {
    if (!scopeAllowsWrite(scopes)) return computerToolError("Token scope does not permit 'computer_action'");
    try {
      const action = normalizeAction(args);
      await selectedBackend.action(action);
      const settleMs = args.observe_after_ms ?? (action.action === "wait" ? 0 : 250);
      if (settleMs > 0) await delay(settleMs);
      const observation = await selectedBackend.observe();
      return actionResult(observation, action.action);
    } catch (error) {
      return computerToolError(safeError(error, "Desktop action failed"));
    }
  }));
}

function normalizeAction(input: z.infer<typeof computerActionSchema>): ComputerAction {
  switch (input.action) {
    case "click":
    case "double_click":
      return { action: input.action, x: input.x, y: input.y, ...(input.button ? { button: input.button } : {}) };
    case "move":
      return { action: "move", x: input.x, y: input.y };
    case "drag":
      return {
        action: "drag",
        fromX: input.from_x,
        fromY: input.from_y,
        toX: input.to_x,
        toY: input.to_y,
        ...(input.button ? { button: input.button } : {}),
      };
    case "scroll":
      return { action: "scroll", dx: input.dx, dy: input.dy };
    case "type":
      return { action: "type", text: input.text };
    case "keypress":
      return { action: "keypress", keys: input.keys };
    case "wait":
      return { action: "wait", durationMs: input.duration_ms };
  }
}

function observationResult(observation: ComputerObservation): ComputerToolResult {
  const structuredContent: Record<string, unknown> = {
    width: observation.width,
    height: observation.height,
    captured_at: observation.capturedAt,
    backend: observation.backend,
    ...(observation.cursor ? { cursor: observation.cursor } : {}),
  };
  return {
    content: [
      {
        type: "image",
        data: observation.data.toString("base64"),
        mimeType: observation.mimeType,
      },
      {
        type: "text",
        text: JSON.stringify(structuredContent),
      },
    ],
    structuredContent,
  };
}

function actionResult(observation: ComputerObservation, action: ComputerAction["action"]): ComputerToolResult {
  const result = observationResult(observation);
  const structuredContent = {
    ...(result.structuredContent ?? {}),
    action,
  };
  return {
    ...result,
    content: result.content.map((entry) => entry.type === "text"
      ? { type: "text" as const, text: JSON.stringify(structuredContent) }
      : entry),
    structuredContent,
  };
}

async function auditedComputerCall(
  tool: string,
  policy: HarnessPolicy,
  audit: ComputerToolAuditSink | undefined,
  clientId: string | undefined,
  sessionId: string | undefined,
  operation: () => Promise<ComputerToolResult>,
): Promise<ComputerToolResult> {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  let outcome: ToolAuditEventInput["outcome"] = "error";
  try {
    const result = await operation();
    outcome = result.isError ? "error" : "success";
    return result;
  } finally {
    if (audit) {
      void audit.record({
        callId: `call_${randomUUID()}`,
        ...(clientId ? { agentId: clientId } : {}),
        ...(sessionId ? { sessionId } : {}),
        tool,
        startedAt,
        durationMs: Date.now() - startedAtMs,
        outcome,
        accessMode: policy.unsafeFullAccess ? "full-access" : "workspace",
      }).catch(() => console.error(`[AUDIT] Failed to persist metadata for tool '${tool}'`));
    }
  }
}

function computerToolError(message: string): ComputerToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

function scopeAllowsRead(scopes: string): boolean {
  const granted = new Set(scopes.split(/\s+/u).filter(Boolean));
  return granted.has("mcp:tools") || granted.has("mcp:read");
}

function scopeAllowsWrite(scopes: string): boolean {
  const granted = new Set(scopes.split(/\s+/u).filter(Boolean));
  return granted.has("mcp:tools") || granted.has("mcp:write");
}

function safeError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : fallback;
  return message.replace(/[\u0000-\u001f\u007f]+/gu, " ").slice(0, 1_000) || fallback;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
