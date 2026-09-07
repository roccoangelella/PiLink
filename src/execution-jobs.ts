import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HarnessPolicy } from "./harness.js";
import { operationBase, resolveWorkspacePath } from "./harness.js";
import { filterExecutionEnvironment } from "./execution-environment.js";

export const EXECUTION_JOB_STATUSES = ["running", "completed", "failed", "cancelled", "orphaned"] as const;
export type ExecutionJobStatus = typeof EXECUTION_JOB_STATUSES[number];

export interface ExecutionJobStartInput {
  ownerId: string;
  ownerName: string;
  command: string;
  cwd?: string;
  label?: string;
}

export interface ExecutionJobSnapshot {
  jobId: string;
  ownerId: string;
  ownerName: string;
  label?: string;
  cwd: string;
  workerPid: number;
  status: ExecutionJobStatus;
  exitCode?: number | null;
  signal?: string | null;
  startedAt: string;
  finishedAt?: string;
  stdoutBytes: number;
  stderrBytes: number;
}

export interface ExecutionJobOutputChunk {
  jobId: string;
  stream: "stdout" | "stderr";
  offset: number;
  nextOffset: number;
  eof: boolean;
  text: string;
}

interface ExecutionJobMetadata {
  version: 1;
  jobId: string;
  ownerId: string;
  ownerName: string;
  label?: string;
  cwd: string;
  workerPid: number;
  startedAt: string;
}

interface ExecutionJobSpec {
  version: 1;
  command: string;
  cwd: string;
}

interface ExecutionJobResult {
  version: 1;
  exitCode: number | null;
  signal: string | null;
  finishedAt: string;
}

interface ExecutionJobCancelMarker {
  version: 1;
  cancelledAt: string;
}

export interface ExecutionJobStoreOptions {
  workspace: string;
  dataDir: string;
  now?: () => Date;
}

const MAX_COMMAND_BYTES = 256 * 1024;
const MAX_LABEL_BYTES = 512;
const MAX_OUTPUT_READ_BYTES = 64 * 1024;
const MAX_RETAINED_JOBS = 256;
const FORCE_KILL_DELAY_MS = 1_000;
const JOB_ID_PATTERN = /^exec_[0-9a-f-]{36}$/u;

export class ExecutionJobStore {
  readonly workspace: string;
  readonly rootDir: string;
  private readonly now: () => Date;

  constructor(options: ExecutionJobStoreOptions) {
    this.workspace = path.resolve(options.workspace);
    const projectKey = createHash("sha256").update(this.workspace, "utf8").digest("hex");
    this.rootDir = path.join(path.resolve(options.dataDir), "execution-jobs", projectKey);
    this.now = options.now ?? (() => new Date());
  }

  async start(policy: HarnessPolicy, input: ExecutionJobStartInput): Promise<ExecutionJobSnapshot> {
    if (!policy.unsafeFullAccess) throw new Error("durable execution jobs require explicit full-access mode");
    const command = validateCommand(input.command);
    const ownerId = validateIdentity(input.ownerId, "ownerId");
    const ownerName = validateIdentity(input.ownerName, "ownerName");
    const label = input.label === undefined ? undefined : validateLabel(input.label);
    const cwd = await this.resolveCwd(policy, input.cwd);

    await this.ensureRoot();
    await this.pruneTerminalJobs();

    const jobId = `exec_${randomUUID()}`;
    const jobDir = this.jobDir(jobId);
    await fs.mkdir(jobDir, { recursive: false, mode: 0o700 });
    const startedAt = this.now().toISOString();
    const spec: ExecutionJobSpec = { version: 1, command, cwd };
    await writePrivateJson(path.join(jobDir, "spec.json"), spec);
    await fs.writeFile(path.join(jobDir, "stdout.log"), "", { mode: 0o600 });
    await fs.writeFile(path.join(jobDir, "stderr.log"), "", { mode: 0o600 });

    const worker = this.spawnWorker(jobDir);
    if (!worker.pid) throw new Error("durable execution worker did not expose a process id");
    const metadata: ExecutionJobMetadata = {
      version: 1,
      jobId,
      ownerId,
      ownerName,
      ...(label ? { label } : {}),
      cwd,
      workerPid: worker.pid,
      startedAt,
    };
    await writePrivateJson(path.join(jobDir, "metadata.json"), metadata);
    worker.unref();
    return this.snapshotFor(ownerId, jobId);
  }

  async status(ownerId: string, jobId: string): Promise<ExecutionJobSnapshot> {
    return this.snapshotFor(validateIdentity(ownerId, "ownerId"), validateJobId(jobId));
  }

  async wait(ownerId: string, jobId: string, maximumWaitSeconds: number, signal?: AbortSignal): Promise<ExecutionJobSnapshot> {
    const validatedOwner = validateIdentity(ownerId, "ownerId");
    const validatedJob = validateJobId(jobId);
    if (!Number.isSafeInteger(maximumWaitSeconds) || maximumWaitSeconds < 1 || maximumWaitSeconds > 60) {
      throw new Error("maximumWaitSeconds must be an integer from 1 through 60");
    }
    const deadline = Date.now() + maximumWaitSeconds * 1_000;
    while (true) {
      if (signal?.aborted) throw new Error("execution job wait was cancelled");
      const snapshot = await this.snapshotFor(validatedOwner, validatedJob);
      if (snapshot.status !== "running" || Date.now() >= deadline) return snapshot;
      await delay(Math.min(250, Math.max(1, deadline - Date.now())), signal);
    }
  }

  async output(
    ownerId: string,
    jobId: string,
    stream: "stdout" | "stderr",
    offset = 0,
    limitBytes = 16 * 1024,
  ): Promise<ExecutionJobOutputChunk> {
    const validatedOwner = validateIdentity(ownerId, "ownerId");
    const validatedJob = validateJobId(jobId);
    await this.assertOwned(validatedOwner, validatedJob);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("offset must be a non-negative integer");
    if (!Number.isSafeInteger(limitBytes) || limitBytes < 1 || limitBytes > MAX_OUTPUT_READ_BYTES) {
      throw new Error(`limitBytes must be an integer from 1 through ${MAX_OUTPUT_READ_BYTES}`);
    }
    const outputPath = path.join(this.jobDir(validatedJob), `${stream}.log`);
    const stat = await fs.stat(outputPath);
    const clampedOffset = Math.min(offset, stat.size);
    const bytesToRead = Math.min(limitBytes, stat.size - clampedOffset);
    const handle = await fs.open(outputPath, "r");
    try {
      const buffer = Buffer.alloc(bytesToRead);
      if (bytesToRead > 0) await handle.read(buffer, 0, bytesToRead, clampedOffset);
      return {
        jobId: validatedJob,
        stream,
        offset: clampedOffset,
        nextOffset: clampedOffset + bytesToRead,
        eof: clampedOffset + bytesToRead >= stat.size,
        text: buffer.toString("utf8"),
      };
    } finally {
      await handle.close();
    }
  }

  async tail(ownerId: string, jobId: string, limitBytes = 8 * 1024): Promise<{ stdout: string; stderr: string }> {
    const validatedOwner = validateIdentity(ownerId, "ownerId");
    const validatedJob = validateJobId(jobId);
    await this.assertOwned(validatedOwner, validatedJob);
    if (!Number.isSafeInteger(limitBytes) || limitBytes < 0 || limitBytes > MAX_OUTPUT_READ_BYTES) {
      throw new Error(`limitBytes must be an integer from 0 through ${MAX_OUTPUT_READ_BYTES}`);
    }
    const [stdout, stderr] = await Promise.all([
      readTail(path.join(this.jobDir(validatedJob), "stdout.log"), limitBytes),
      readTail(path.join(this.jobDir(validatedJob), "stderr.log"), limitBytes),
    ]);
    return { stdout, stderr };
  }

  async cancel(ownerId: string, jobId: string): Promise<ExecutionJobSnapshot> {
    const validatedOwner = validateIdentity(ownerId, "ownerId");
    const validatedJob = validateJobId(jobId);
    const metadata = await this.assertOwned(validatedOwner, validatedJob);
    const before = await this.snapshotFromMetadata(metadata);
    if (before.status !== "running") return before;

    const marker: ExecutionJobCancelMarker = { version: 1, cancelledAt: this.now().toISOString() };
    await writePrivateJson(path.join(this.jobDir(validatedJob), "cancelled.json"), marker);
    terminateProcessTree(metadata.workerPid, "SIGTERM");
    const forceTimer = setTimeout(() => {
      if (isProcessAlive(metadata.workerPid)) terminateProcessTree(metadata.workerPid, "SIGKILL");
    }, FORCE_KILL_DELAY_MS);
    forceTimer.unref();
    return this.snapshotFromMetadata(metadata);
  }

  private spawnWorker(jobDir: string): ChildProcess {
    const workerPath = fileURLToPath(new URL("./execution-job-worker.js", import.meta.url));
    return spawn(process.execPath, [workerPath, jobDir], {
      cwd: operationBase({ workspace: this.workspace, workingDirectory: this.workspace, unsafeFullAccess: true }),
      env: filterExecutionEnvironment(process.env),
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: "ignore",
    });
  }

  private async resolveCwd(policy: HarnessPolicy, suppliedCwd?: string): Promise<string> {
    const resolved = await resolveWorkspacePath(policy, suppliedCwd ?? operationBase(policy));
    const canonical = await fs.realpath(resolved);
    const stat = await fs.stat(canonical);
    if (!stat.isDirectory()) throw new Error("execution job cwd must be an existing directory");
    return canonical;
  }

  private async snapshotFor(ownerId: string, jobId: string): Promise<ExecutionJobSnapshot> {
    const metadata = await this.assertOwned(ownerId, jobId);
    return this.snapshotFromMetadata(metadata);
  }

  private async snapshotFromMetadata(metadata: ExecutionJobMetadata): Promise<ExecutionJobSnapshot> {
    const dir = this.jobDir(metadata.jobId);
    const [result, cancelled, stdoutStat, stderrStat] = await Promise.all([
      readOptionalJson<ExecutionJobResult>(path.join(dir, "result.json")),
      readOptionalJson<ExecutionJobCancelMarker>(path.join(dir, "cancelled.json")),
      fs.stat(path.join(dir, "stdout.log")),
      fs.stat(path.join(dir, "stderr.log")),
    ]);
    let status: ExecutionJobStatus;
    if (cancelled) status = "cancelled";
    else if (result) status = result.exitCode === 0 ? "completed" : "failed";
    else status = isProcessAlive(metadata.workerPid) ? "running" : "orphaned";
    return {
      jobId: metadata.jobId,
      ownerId: metadata.ownerId,
      ownerName: metadata.ownerName,
      ...(metadata.label ? { label: metadata.label } : {}),
      cwd: metadata.cwd,
      workerPid: metadata.workerPid,
      status,
      ...(result ? { exitCode: result.exitCode, signal: result.signal, finishedAt: result.finishedAt } : {}),
      startedAt: metadata.startedAt,
      stdoutBytes: stdoutStat.size,
      stderrBytes: stderrStat.size,
    };
  }

  private async assertOwned(ownerId: string, jobId: string): Promise<ExecutionJobMetadata> {
    const metadata = await readJson<ExecutionJobMetadata>(path.join(this.jobDir(jobId), "metadata.json"));
    if (!metadata || metadata.version !== 1 || metadata.jobId !== jobId) throw new Error("execution job metadata is malformed");
    if (metadata.ownerId !== ownerId) throw new Error("execution job is not owned by this OAuth client");
    return metadata;
  }

  private async ensureRoot(): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    await fs.chmod(this.rootDir, 0o700).catch(() => undefined);
  }

  private async pruneTerminalJobs(): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(this.rootDir, { withFileTypes: true });
    } catch (error: unknown) {
      if (isNodeError(error, "ENOENT")) return;
      throw error;
    }
    const jobs: Array<{ jobId: string; updatedMs: number; terminal: boolean }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !JOB_ID_PATTERN.test(entry.name)) continue;
      try {
        const metadata = await readJson<ExecutionJobMetadata>(path.join(this.jobDir(entry.name), "metadata.json"));
        const snapshot = await this.snapshotFromMetadata(metadata);
        const stat = await fs.stat(this.jobDir(entry.name));
        jobs.push({ jobId: entry.name, updatedMs: stat.mtimeMs, terminal: snapshot.status !== "running" });
      } catch {
        // Preserve malformed state for operator inspection rather than deleting it automatically.
      }
    }
    if (jobs.length < MAX_RETAINED_JOBS) return;
    const removable = jobs
      .filter((job) => job.terminal)
      .sort((left, right) => left.updatedMs - right.updatedMs)
      .slice(0, jobs.length - MAX_RETAINED_JOBS + 1);
    for (const job of removable) await fs.rm(this.jobDir(job.jobId), { recursive: true, force: true });
    if (jobs.length - removable.length >= MAX_RETAINED_JOBS) {
      throw new Error("execution job retention is full of active or non-prunable jobs");
    }
  }

  private jobDir(jobId: string): string {
    return path.join(this.rootDir, validateJobId(jobId));
  }
}

function validateCommand(value: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error("command must be a non-empty string without NUL bytes");
  if (Buffer.byteLength(value, "utf8") > MAX_COMMAND_BYTES) throw new Error(`command exceeds ${MAX_COMMAND_BYTES} UTF-8 bytes`);
  return value;
}

function validateIdentity(value: string, field: string): string {
  if (typeof value !== "string" || !value || value.includes("\0") || Buffer.byteLength(value, "utf8") > 256) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

function validateLabel(value: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || Buffer.byteLength(value, "utf8") > MAX_LABEL_BYTES) {
    throw new Error("label is invalid");
  }
  return value.trim();
}

function validateJobId(value: string): string {
  if (typeof value !== "string" || !JOB_ID_PATTERN.test(value)) throw new Error("invalid execution job id");
  return value;
}

function terminateProcessTree(pid: number, signal: NodeJS.Signals): void {
  try {
    if (process.platform === "win32") process.kill(pid, signal);
    else process.kill(-pid, signal);
  } catch (error: unknown) {
    if (!isNodeError(error, "ESRCH")) throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    if (isNodeError(error, "ESRCH")) return false;
    return true;
  }
}

async function writePrivateJson(filePath: string, value: unknown): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await fs.rename(tempPath, filePath);
  await fs.chmod(filePath, 0o600).catch(() => undefined);
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

async function readOptionalJson<T>(filePath: string): Promise<T | undefined> {
  try {
    return await readJson<T>(filePath);
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function readTail(filePath: string, limitBytes: number): Promise<string> {
  if (limitBytes === 0) return "";
  const stat = await fs.stat(filePath);
  const offset = Math.max(0, stat.size - limitBytes);
  const length = stat.size - offset;
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    if (length > 0) await handle.read(buffer, 0, length, offset);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("execution job wait was cancelled"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(new Error("execution job wait was cancelled"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}
