import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type ToolAuditOutcome = "success" | "error";
export type ToolAuditAccessMode = "workspace" | "full-access";

export interface ToolAuditEventInput {
  callId: string;
  agentId?: string;
  tool: string;
  startedAt: string;
  durationMs: number;
  outcome: ToolAuditOutcome;
  accessMode: ToolAuditAccessMode;
  exitCode?: number | null;
  timedOut?: boolean;
  truncated?: boolean;
}

export interface ToolAuditEvent {
  version: 1;
  event: "tool_call";
  callId: string;
  agentId?: string;
  tool: string;
  startedAt: string;
  durationMs: number;
  outcome: ToolAuditOutcome;
  accessMode: ToolAuditAccessMode;
  exitCode?: number | null;
  timedOut?: boolean;
  truncated?: boolean;
}

export interface ToolAuditLogOptions {
  workspace: string;
  dataDir: string;
  maximumBytes?: number;
}

export const TOOL_AUDIT_DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const appendQueues = new Map<string, Promise<void>>();

/** Project-scoped, metadata-only audit log. Callers decide whether failures are fatal. */
export class ToolAuditLog {
  public readonly workspace: string;
  public readonly projectKey: string;
  public readonly logPath: string;
  public readonly rotatedLogPath: string;

  private readonly dataDir: string;
  private readonly projectDir: string;
  private readonly maximumBytes: number;

  public constructor(options: ToolAuditLogOptions) {
    this.workspace = fs.realpathSync(options.workspace);
    this.dataDir = path.resolve(options.dataDir);
    if (isWithin(this.workspace, this.dataDir)) {
      throw new Error("Tool audit data must not be stored under the workspace");
    }

    this.maximumBytes = validatePositiveInteger(options.maximumBytes ?? TOOL_AUDIT_DEFAULT_MAX_BYTES, "maximumBytes");
    this.projectKey = createHash("sha256").update(this.workspace).digest("hex");
    this.projectDir = path.join(this.dataDir, "projects", this.projectKey);
    this.logPath = path.join(this.projectDir, "tool-audit.jsonl");
    this.rotatedLogPath = path.join(this.projectDir, "tool-audit.1.jsonl");
  }

  public record(input: ToolAuditEventInput): Promise<void> {
    const event = normalizeEvent(input);
    const previous = appendQueues.get(this.logPath) || Promise.resolve();
    const operation = previous.then(() => this.append(event));
    appendQueues.set(this.logPath, operation.then(() => undefined, () => undefined));
    return operation;
  }

  private async append(event: ToolAuditEvent): Promise<void> {
    await this.ensureDirectories();
    const serialized = `${JSON.stringify(event)}\n`;
    const existingBytes = await fileSize(this.logPath);
    if (existingBytes > 0 && existingBytes + Buffer.byteLength(serialized, "utf8") > this.maximumBytes) {
      await fs.promises.rm(this.rotatedLogPath, { force: true });
      await fs.promises.rename(this.logPath, this.rotatedLogPath);
      await fs.promises.chmod(this.rotatedLogPath, 0o600);
    }

    const file = await fs.promises.open(this.logPath, "a", 0o600);
    try {
      await file.chmod(0o600);
      await file.writeFile(serialized, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
  }

  private async ensureDirectories(): Promise<void> {
    await fs.promises.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const canonicalDataDir = await fs.promises.realpath(this.dataDir);
    if (isWithin(this.workspace, canonicalDataDir)) {
      throw new Error("Tool audit data must not be stored under the workspace");
    }
    await fs.promises.chmod(canonicalDataDir, 0o700);

    const projectsDir = path.join(canonicalDataDir, "projects");
    await fs.promises.mkdir(projectsDir, { recursive: true, mode: 0o700 });
    const canonicalProjectsDir = await fs.promises.realpath(projectsDir);
    if (!isWithin(canonicalDataDir, canonicalProjectsDir)) {
      throw new Error("Tool audit projects directory escapes the configured data directory");
    }
    await fs.promises.chmod(canonicalProjectsDir, 0o700);

    await fs.promises.mkdir(this.projectDir, { recursive: true, mode: 0o700 });
    const canonicalProjectDir = await fs.promises.realpath(this.projectDir);
    if (!isWithin(canonicalProjectsDir, canonicalProjectDir)) {
      throw new Error("Tool audit project directory escapes the configured data directory");
    }
    await fs.promises.chmod(canonicalProjectDir, 0o700);
  }
}

function normalizeEvent(input: ToolAuditEventInput): ToolAuditEvent {
  const event: ToolAuditEvent = {
    version: 1,
    event: "tool_call",
    callId: validateText(input.callId, "callId", 200),
    tool: validateText(input.tool, "tool", 100),
    startedAt: validateTimestamp(input.startedAt),
    durationMs: validateNonNegativeInteger(input.durationMs, "durationMs"),
    outcome: validateOutcome(input.outcome),
    accessMode: validateAccessMode(input.accessMode),
  };

  if (input.agentId !== undefined) event.agentId = validateText(input.agentId, "agentId", 200);
  if (input.exitCode !== undefined) event.exitCode = validateExitCode(input.exitCode);
  if (input.timedOut !== undefined) event.timedOut = validateBoolean(input.timedOut, "timedOut");
  if (input.truncated !== undefined) event.truncated = validateBoolean(input.truncated, "truncated");
  return event;
}

function validateText(value: unknown, field: string, maximumBytes: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`${field} must be non-empty`);
  if (Buffer.byteLength(trimmed, "utf8") > maximumBytes) {
    throw new Error(`${field} exceeds ${maximumBytes} UTF-8 bytes`);
  }
  return trimmed;
}

function validateTimestamp(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error("startedAt must be an ISO-8601 timestamp");
  }
  return new Date(value).toISOString();
}

function validateNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value as number;
}

function validatePositiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value as number;
}

function validateOutcome(value: unknown): ToolAuditOutcome {
  if (value !== "success" && value !== "error") throw new Error("outcome must be success or error");
  return value;
}

function validateAccessMode(value: unknown): ToolAuditAccessMode {
  if (value !== "workspace" && value !== "full-access") {
    throw new Error("accessMode must be workspace or full-access");
  }
  return value;
}

function validateExitCode(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value)) throw new Error("exitCode must be a safe integer or null");
  return value as number;
}

function validateBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

async function fileSize(filePath: string): Promise<number> {
  try {
    return (await fs.promises.stat(filePath)).size;
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
