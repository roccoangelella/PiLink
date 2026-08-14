import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type ToolAuditOutcome = "success" | "error";
export type ToolAuditAccessMode = "workspace" | "full-access";

export interface ToolAuditEventInput {
  callId: string;
  agentId?: string;
  sessionId?: string;
  tool: string;
  startedAt: string;
  durationMs: number;
  outcome: ToolAuditOutcome;
  accessMode: ToolAuditAccessMode;
  exitCode?: number | null;
  timedOut?: boolean;
  cancelled?: boolean;
  truncated?: boolean;
}

export interface ToolAuditEvent {
  version: 1;
  event: "tool_call";
  callId: string;
  agentId?: string;
  sessionId?: string;
  tool: string;
  startedAt: string;
  durationMs: number;
  outcome: ToolAuditOutcome;
  accessMode: ToolAuditAccessMode;
  exitCode?: number | null;
  timedOut?: boolean;
  cancelled?: boolean;
  truncated?: boolean;
}

export interface ToolAuditLogOptions {
  workspace: string;
  dataDir: string;
  maximumBytes?: number;
}

export const TOOL_AUDIT_DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
export const TOOL_AUDIT_MAX_READ_EVENTS = 200;
const TOOL_AUDIT_READ_MAX_BYTES_PER_FILE = 1024 * 1024;
const TOOL_AUDIT_READ_MIN_BYTES_PER_FILE = 64 * 1024;
const TOOL_AUDIT_MAX_LINE_BYTES = 4 * 1024;
const TOOL_AUDIT_MAX_SCANNED_LINES = 4 * 1024;
const TOOL_AUDIT_EVENT_KEYS = new Set([
  "version",
  "event",
  "callId",
  "agentId",
  "sessionId",
  "tool",
  "startedAt",
  "durationMs",
  "outcome",
  "accessMode",
  "exitCode",
  "timedOut",
  "cancelled",
  "truncated",
]);
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

  public flush(): Promise<void> {
    return appendQueues.get(this.logPath) || Promise.resolve();
  }

  /** Read the newest validated metadata events without loading either complete log. */
  public readRecent(limit: number): Promise<ToolAuditEvent[]> {
    const selectedLimit = validateReadLimit(limit);
    const previous = appendQueues.get(this.logPath) || Promise.resolve();
    const operation = previous.then(() => this.readRecentAfterWrites(selectedLimit));
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

  private async readRecentAfterWrites(limit: number): Promise<ToolAuditEvent[]> {
    const projectDirectory = await this.resolveReadableProjectDirectory();
    if (!projectDirectory) return [];

    const active = await readRecentFile(projectDirectory, path.basename(this.logPath), limit);
    if (active.length >= limit) return active.slice(-limit);

    const rotated = await readRecentFile(
      projectDirectory,
      path.basename(this.rotatedLogPath),
      limit - active.length,
    );
    return [...rotated, ...active].slice(-limit);
  }

  private async resolveReadableProjectDirectory(): Promise<string | undefined> {
    try {
      const canonicalDataDir = await fs.promises.realpath(this.dataDir);
      if (isWithin(this.workspace, canonicalDataDir)) {
        throw new Error("Tool audit data must not be stored under the workspace");
      }

      const canonicalProjectsDir = await fs.promises.realpath(path.join(this.dataDir, "projects"));
      if (canonicalProjectsDir !== path.join(canonicalDataDir, "projects")) {
        throw new Error("Tool audit projects directory is not canonical");
      }

      const canonicalProjectDir = await fs.promises.realpath(this.projectDir);
      if (canonicalProjectDir !== path.join(canonicalProjectsDir, this.projectKey)) {
        throw new Error("Tool audit project directory is not canonical");
      }
      return canonicalProjectDir;
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) return undefined;
      throw error;
    }
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
  if (input.sessionId !== undefined) event.sessionId = validateText(input.sessionId, "sessionId", 200);
  if (input.exitCode !== undefined) event.exitCode = validateExitCode(input.exitCode);
  if (input.timedOut !== undefined) event.timedOut = validateBoolean(input.timedOut, "timedOut");
  if (input.cancelled !== undefined) event.cancelled = validateBoolean(input.cancelled, "cancelled");
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

function validateReadLimit(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > TOOL_AUDIT_MAX_READ_EVENTS) {
    throw new Error(`limit must be a safe integer between 1 and ${TOOL_AUDIT_MAX_READ_EVENTS}`);
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

async function readRecentFile(
  projectDirectory: string,
  fileName: string,
  limit: number,
): Promise<ToolAuditEvent[]> {
  const requestedPath = path.join(projectDirectory, fileName);
  let canonicalPath: string;
  try {
    canonicalPath = await fs.promises.realpath(requestedPath);
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return [];
    throw new Error("Tool audit log cannot be opened safely");
  }
  if (path.dirname(canonicalPath) !== projectDirectory || path.basename(canonicalPath) !== fileName) {
    throw new Error("Tool audit log escapes its project directory");
  }

  let file: fs.promises.FileHandle;
  try {
    file = await fs.promises.open(canonicalPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    throw new Error("Tool audit log cannot be opened safely");
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0) {
      throw new Error("Tool audit log must be a regular file");
    }
    if (stat.size === 0) return [];

    const desiredBytes = Math.min(
      TOOL_AUDIT_READ_MAX_BYTES_PER_FILE,
      Math.max(TOOL_AUDIT_READ_MIN_BYTES_PER_FILE, limit * TOOL_AUDIT_MAX_LINE_BYTES),
    );
    const offset = Math.max(0, stat.size - desiredBytes);
    const length = Math.min(stat.size, desiredBytes);
    const buffer = Buffer.alloc(length);
    let total = 0;
    while (total < length) {
      const result = await file.read(buffer, total, length - total, offset + total);
      if (result.bytesRead === 0) break;
      total += result.bytesRead;
    }
    return parseRecentEvents(buffer.subarray(0, total), offset === 0, limit);
  } finally {
    await file.close();
  }
}

function parseRecentEvents(buffer: Buffer, startsAtFileBoundary: boolean, limit: number): ToolAuditEvent[] {
  let text = buffer.toString("utf8");
  if (!startsAtFileBoundary) {
    const firstNewline = text.indexOf("\n");
    if (firstNewline === -1) return [];
    text = text.slice(firstNewline + 1);
  }

  const finalNewline = text.lastIndexOf("\n");
  if (finalNewline === -1) return [];
  const lines = text.slice(0, finalNewline).split("\n");
  const maximumScannedLines = Math.min(
    TOOL_AUDIT_MAX_SCANNED_LINES,
    Math.max(256, limit * 16),
  );
  const events: ToolAuditEvent[] = [];
  let scanned = 0;
  for (let index = lines.length - 1; index >= 0 && events.length < limit && scanned < maximumScannedLines; index -= 1) {
    scanned += 1;
    const line = lines[index].endsWith("\r") ? lines[index].slice(0, -1) : lines[index];
    const event = parseStoredEvent(line);
    if (event) events.push(event);
  }
  return events.reverse();
}

function parseStoredEvent(line: string): ToolAuditEvent | undefined {
  if (line.length === 0 || Buffer.byteLength(line, "utf8") > TOOL_AUDIT_MAX_LINE_BYTES) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || Object.keys(value).some((key) => !TOOL_AUDIT_EVENT_KEYS.has(key))) return undefined;
  if (value.version !== 1 || value.event !== "tool_call") return undefined;

  try {
    const event: ToolAuditEvent = {
      version: 1,
      event: "tool_call",
      callId: validateText(value.callId, "callId", 200),
      tool: validateText(value.tool, "tool", 100),
      startedAt: validateTimestamp(value.startedAt),
      durationMs: validateNonNegativeInteger(value.durationMs, "durationMs"),
      outcome: validateOutcome(value.outcome),
      accessMode: validateAccessMode(value.accessMode),
    };
    if (Object.hasOwn(value, "agentId")) event.agentId = validateText(value.agentId, "agentId", 200);
    if (Object.hasOwn(value, "sessionId")) event.sessionId = validateText(value.sessionId, "sessionId", 200);
    if (Object.hasOwn(value, "exitCode")) event.exitCode = validateExitCode(value.exitCode);
    if (Object.hasOwn(value, "timedOut")) event.timedOut = validateBoolean(value.timedOut, "timedOut");
    if (Object.hasOwn(value, "cancelled")) event.cancelled = validateBoolean(value.cancelled, "cancelled");
    if (Object.hasOwn(value, "truncated")) event.truncated = validateBoolean(value.truncated, "truncated");
    return event;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFileSystemError(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
