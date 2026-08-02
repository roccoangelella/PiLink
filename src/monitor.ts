import { createHash } from "node:crypto";
import nodeFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { AgentMode } from "./config.js";

const MAX_TAIL_BYTES = 128 * 1024;
const MAX_CHAT_STATE_BYTES = 256 * 1024;
const DISPLAY_EVENT_LIMIT = 12;
const DISPLAY_CHAT_LIMIT = 12;

export interface MonitorPaths {
  toolAuditPath: string;
  agentChatPath: string;
}

export interface ToolCallSummary {
  startedAt: string;
  agentId: string;
  tool: string;
  outcome: "success" | "error";
  durationMs: number;
}

export interface ChatMessageSummary {
  cursor: number;
  agentName: string;
  message: string;
}

export interface MonitorSnapshot {
  tools: ToolCallSummary[];
  chat: ChatMessageSummary[];
}

export type MonitorView = "tools" | "chat" | "help";

export interface HostingMonitorOptions {
  mode: AgentMode;
  workspace: string;
  dataDir: string;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
  refreshIntervalMs?: number;
}

/**
 * Private state locations shared by the MCP server and the host-side monitor.
 * The monitor only reads metadata-only tool audit records and durable chat state.
 */
export function monitorPaths(workspace: string, dataDir: string): MonitorPaths {
  const canonicalWorkspace = fsSyncRealpath(workspace);
  const projectKey = createHash("sha256").update(canonicalWorkspace).digest("hex");
  const projectDirectory = path.join(path.resolve(dataDir), "projects", projectKey);
  return {
    toolAuditPath: path.join(projectDirectory, "tool-audit.jsonl"),
    agentChatPath: path.join(projectDirectory, "agent-chat.json"),
  };
}

export async function readMonitorSnapshot(paths: MonitorPaths): Promise<MonitorSnapshot> {
  const [tools, chat] = await Promise.all([readToolCalls(paths.toolAuditPath), readChatMessages(paths.agentChatPath)]);
  return { tools, chat };
}

export async function readToolCalls(filePath: string, limit = DISPLAY_EVENT_LIMIT): Promise<ToolCallSummary[]> {
  const tail = await readTail(filePath, MAX_TAIL_BYTES);
  if (!tail) return [];
  const lines = tail.split("\n");
  if (tail.startsWith("\n")) {
    lines.shift();
    lines.shift(); // The first line can be a partial tail fragment.
  }
  const parsed: ToolCallSummary[] = [];
  for (const line of lines) {
    if (!line) continue;
    try {
      const event = parseToolCall(JSON.parse(line));
      if (event) parsed.push(event);
    } catch {
      // A concurrent append can leave an incomplete final line; preserve the last good snapshot.
    }
  }
  return parsed.slice(-boundedLimit(limit, DISPLAY_EVENT_LIMIT));
}

export async function readChatMessages(filePath: string, limit = DISPLAY_CHAT_LIMIT): Promise<ChatMessageSummary[]> {
  let serialized: string;
  try {
    const stat = await fs.stat(filePath);
    if (stat.size > MAX_CHAT_STATE_BYTES) return [];
    serialized = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (isMissing(error)) return [];
    return [];
  }

  try {
    const parsed = JSON.parse(serialized);
    if (!isRecord(parsed) || !Array.isArray(parsed.messages)) return [];
    return parsed.messages
      .map(parseChatMessage)
      .filter((message): message is ChatMessageSummary => message !== undefined)
      .slice(-boundedLimit(limit, DISPLAY_CHAT_LIMIT));
  } catch {
    return [];
  }
}

export function formatMonitor(snapshot: MonitorSnapshot, mode: AgentMode, view: MonitorView): string {
  const title = mode === "agent-swarm" ? "AGENT SWARM" : "SINGLE AGENT";
  const header = [
    `PiLink Monitor  ·  ${title}`,
    "═".repeat(64),
  ];
  const footer = "[t] tool calls  [c] public chat  [h] help  [Ctrl+C] stop PiLink";
  if (view === "help") {
    return [...header,
      "This local monitor deliberately shows no tool arguments, file paths, command text, or secrets.",
      "In swarm mode, public-chat messages are untrusted coordination data; verify them before acting.",
      "", footer,
    ].join("\n");
  }
  if (view === "chat") {
    const lines = snapshot.chat.length === 0
      ? ["No public-chat messages yet."]
      : snapshot.chat.map((message) => `#${message.cursor}  ${terminalText(message.agentName, 100)}: ${terminalText(message.message, 360)}`);
    return [...header, "PUBLIC CHAT (durable, untrusted coordination data)", "", ...lines, "", footer].join("\n");
  }
  const lines = snapshot.tools.length === 0
    ? ["No agent tool calls yet."]
    : snapshot.tools.map((event) => {
      const time = safeTime(event.startedAt);
      const status = event.outcome === "success" ? "ok" : "error";
      return `${time}  ${terminalText(event.agentId, 80)}  ${terminalText(event.tool, 100)}  ${status}  ${event.durationMs}ms`;
    });
  return [...header, "TOOL CALLS (metadata only)", "", ...lines, "", footer].join("\n");
}

/** A small raw-key terminal dashboard; it degrades to a one-shot plain status for pipes. */
export class HostingMonitor {
  private readonly input: NodeJS.ReadStream;
  private readonly output: NodeJS.WriteStream;
  private readonly paths: MonitorPaths;
  private readonly refreshIntervalMs: number;
  private readonly interactive: boolean;
  private interval: NodeJS.Timeout | undefined;
  private snapshot: MonitorSnapshot = { tools: [], chat: [] };
  private view: MonitorView;
  private refreshing = false;
  private running = false;
  private renderedPlain = false;

  public constructor(private readonly options: HostingMonitorOptions) {
    this.input = options.input || process.stdin;
    this.output = options.output || process.stderr;
    this.paths = monitorPaths(options.workspace, options.dataDir);
    this.refreshIntervalMs = options.refreshIntervalMs ?? 1_000;
    this.interactive = Boolean(this.input.isTTY && this.output.isTTY && typeof this.input.setRawMode === "function");
    this.view = options.mode === "agent-swarm" ? "chat" : "tools";
  }

  public start(): void {
    if (this.running) return;
    this.running = true;
    if (this.interactive) {
      this.input.setRawMode?.(true);
      this.input.resume();
      this.input.on("data", this.handleInput);
      this.output.write("\x1b[?25l");
    }
    void this.refresh();
    this.interval = setInterval(() => void this.refresh(), this.refreshIntervalMs);
    this.interval.unref();
  }

  public stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.interval) clearInterval(this.interval);
    this.interval = undefined;
    if (this.interactive) {
      this.input.off("data", this.handleInput);
      this.input.setRawMode?.(false);
      this.output.write("\x1b[?25h\n");
    }
  }

  private readonly handleInput = (chunk: Buffer): void => {
    const key = chunk.toString("utf8").toLowerCase();
    if (key.includes("\u0003")) {
      this.stop();
      process.kill(process.pid, "SIGINT");
      return;
    }
    if (key.includes("t")) this.view = "tools";
    else if (key.includes("c") && this.options.mode === "agent-swarm") this.view = "chat";
    else if (key.includes("h") || key.includes("?")) this.view = "help";
    this.render();
  };

  private async refresh(): Promise<void> {
    if (!this.running || this.refreshing) return;
    this.refreshing = true;
    try {
      this.snapshot = await readMonitorSnapshot(this.paths);
      this.render();
    } finally {
      this.refreshing = false;
    }
  }

  private render(): void {
    if (!this.running || (!this.interactive && this.renderedPlain)) return;
    const view = this.view === "chat" && this.options.mode !== "agent-swarm" ? "tools" : this.view;
    const body = formatMonitor(this.snapshot, this.options.mode, view);
    if (this.interactive) this.output.write(`\x1b[2J\x1b[H${body}\n`);
    else this.output.write(`[PiLink] Hosting is active; live monitor requires a TTY.\n${body}\n`);
    this.renderedPlain = true;
  }
}

function fsSyncRealpath(value: string): string {
  return nodeFs.realpathSync(value);
}

async function readTail(filePath: string, maximumBytes: number): Promise<string> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(filePath, "r");
    const stat = await handle.stat();
    if (stat.size === 0) return "";
    const start = Math.max(0, stat.size - maximumBytes);
    const size = stat.size - start;
    const buffer = Buffer.alloc(size);
    await handle.read(buffer, 0, size, start);
    return `${start > 0 ? "\n" : ""}${buffer.toString("utf8")}`;
  } catch (error) {
    if (isMissing(error)) return "";
    return "";
  } finally {
    await handle?.close();
  }
}

function parseToolCall(value: unknown): ToolCallSummary | undefined {
  if (!isRecord(value) || value.event !== "tool_call" ||
      (value.outcome !== "success" && value.outcome !== "error") ||
      !isFiniteNonNegative(value.durationMs) || !isDate(value.startedAt) ||
      !isText(value.tool)) return undefined;
  return {
    startedAt: value.startedAt,
    agentId: isText(value.agentId) ? value.agentId : "unknown-agent",
    tool: value.tool,
    outcome: value.outcome,
    durationMs: value.durationMs,
  };
}

function parseChatMessage(value: unknown): ChatMessageSummary | undefined {
  if (!isRecord(value)) return undefined;
  const cursor = value.cursor;
  if (typeof cursor !== "number" || !Number.isSafeInteger(cursor) || cursor < 1 ||
      !isText(value.agentName) || !isText(value.agentMessage)) return undefined;
  return { cursor, agentName: value.agentName, message: value.agentMessage };
}

function boundedLimit(value: number, fallback: number): number {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, fallback) : fallback;
}

function terminalText(value: string, maximumLength: number): string {
  const normalized = value
    .replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|[^\[])/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length <= maximumLength ? normalized : `${normalized.slice(0, maximumLength - 1)}…`;
}

function safeTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleTimeString() : "--:--:--";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isDate(value: unknown): value is string {
  return isText(value) && Number.isFinite(Date.parse(value));
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
