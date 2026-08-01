import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const AGENT_TASK_LIMIT = 200;
export const AGENT_TASK_TITLE_MAX_BYTES = 256;
export const AGENT_TASK_DETAILS_MAX_BYTES = 8 * 1024;
export const AGENT_TASK_MESSAGE_MAX_BYTES = 8 * 1024;
export const AGENT_TASK_ARTIFACT_MAX_BYTES = 16 * 1024;
export const AGENT_TASK_DEFAULT_LEASE_SECONDS = 15 * 60;
export const AGENT_TASK_MAX_LEASE_SECONDS = 24 * 60 * 60;

export const AGENT_TASK_STATUSES = [
  "open",
  "working",
  "input_required",
  "completed",
  "failed",
  "cancelled",
] as const;

export type AgentTaskStatus = typeof AGENT_TASK_STATUSES[number];

export interface AgentTaskIdentity {
  agentId: string;
  agentName: string;
}

export interface AgentTask {
  taskId: string;
  title: string;
  details?: string;
  status: AgentTaskStatus;
  statusMessage?: string;
  artifact?: string;
  createdByAgentId: string;
  createdByAgentName: string;
  ownerAgentId?: string;
  ownerAgentName?: string;
  leaseExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface AgentTaskStoreOptions {
  workspace: string;
  dataDir?: string;
  now?: () => Date;
}

export interface AgentTaskCreateInput extends AgentTaskIdentity {
  title: string;
  details?: string;
}

export interface AgentTaskClaimInput extends AgentTaskIdentity {
  taskId: string;
  leaseSeconds?: number;
}

export interface AgentTaskUpdateInput extends AgentTaskIdentity {
  taskId: string;
  statusMessage?: string;
}

export interface AgentTaskCompleteInput extends AgentTaskUpdateInput {
  artifact?: string;
}

export interface AgentTaskListOptions {
  statuses?: AgentTaskStatus[];
  limit?: number;
}

interface StoredAgentTaskState {
  version: 1;
  projectKey: string;
  tasks: AgentTask[];
}

interface SharedAgentTaskState {
  state?: StoredAgentTaskState;
  stateLoad?: Promise<StoredAgentTaskState>;
  mutationQueue: Promise<void>;
}

const sharedStates = new Map<string, SharedAgentTaskState>();
const terminalStatuses = new Set<AgentTaskStatus>(["completed", "failed", "cancelled"]);
const leasedStatuses = new Set<AgentTaskStatus>(["working", "input_required"]);

/** Durable typed coordination tasks for one canonical workspace. */
export class AgentTaskStore {
  public readonly workspace: string;
  public readonly projectKey: string;
  public readonly statePath: string;

  private readonly dataDir: string;
  private readonly projectDir: string;
  private readonly now: () => Date;
  private readonly sharedState: SharedAgentTaskState;

  public constructor(options: AgentTaskStoreOptions) {
    const selectedDataDir = options.dataDir || process.env.PI_DATA_DIR;
    if (!selectedDataDir) throw new Error("AgentTaskStore requires dataDir or PI_DATA_DIR");

    this.workspace = fs.realpathSync(options.workspace);
    this.dataDir = path.resolve(selectedDataDir);
    if (isWithin(this.workspace, this.dataDir)) {
      throw new Error("Agent task data must not be stored under the workspace");
    }

    this.now = options.now || (() => new Date());
    this.projectKey = createHash("sha256").update(this.workspace).digest("hex");
    this.projectDir = path.join(this.dataDir, "projects", this.projectKey);
    this.statePath = path.join(this.projectDir, "agent-tasks.json");
    this.sharedState = sharedStates.get(this.statePath) || { mutationQueue: Promise.resolve() };
    sharedStates.set(this.statePath, this.sharedState);
  }

  public async create(input: AgentTaskCreateInput): Promise<AgentTask> {
    const identity = validateIdentity(input);
    const title = validateRequiredText(input.title, "title", AGENT_TASK_TITLE_MAX_BYTES);
    const details = validateOptionalText(input.details, "details", AGENT_TASK_DETAILS_MAX_BYTES);

    return this.enqueueMutation(async () => {
      const state = await this.loadFreshState();
      const now = this.nowIso();
      const task: AgentTask = {
        taskId: randomUUID(),
        title,
        details,
        status: "open",
        createdByAgentId: identity.agentId,
        createdByAgentName: identity.agentName,
        createdAt: now,
        updatedAt: now,
        revision: 1,
      };
      const tasks = makeRoomForTask(state.tasks);
      const next = this.withTasks([...tasks, task]);
      await this.persistAndCache(next);
      return copyTask(task);
    });
  }

  public async get(taskId: string): Promise<AgentTask> {
    const normalizedTaskId = validateTaskId(taskId);
    return this.enqueueMutation(async () => {
      const state = await this.loadFreshState();
      const task = requireTask(state, normalizedTaskId);
      return copyTask(task);
    });
  }

  public async list(options: AgentTaskListOptions = {}): Promise<AgentTask[]> {
    const statuses = validateStatuses(options.statuses);
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > AGENT_TASK_LIMIT) {
      throw new Error(`limit must be an integer between 1 and ${AGENT_TASK_LIMIT}`);
    }

    return this.enqueueMutation(async () => {
      const state = await this.loadFreshState();
      const filtered = statuses
        ? state.tasks.filter((task) => statuses.has(task.status))
        : state.tasks;
      return filtered
        .slice()
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.taskId.localeCompare(left.taskId))
        .slice(0, limit)
        .map(copyTask);
    });
  }

  public async claim(input: AgentTaskClaimInput): Promise<AgentTask> {
    const identity = validateIdentity(input);
    const taskId = validateTaskId(input.taskId);
    const leaseSeconds = validateLeaseSeconds(input.leaseSeconds);

    return this.enqueueMutation(async () => {
      const state = await this.loadFreshState();
      const task = requireTask(state, taskId);
      if (terminalStatuses.has(task.status)) throw new Error(`Task is already ${task.status}`);
      if (task.status !== "open" && task.ownerAgentId !== identity.agentId) {
        throw new Error(`Task is already claimed by ${task.ownerAgentName}`);
      }

      const now = this.nowIso();
      const updated: AgentTask = {
        ...task,
        status: "working",
        statusMessage: undefined,
        ownerAgentId: identity.agentId,
        ownerAgentName: identity.agentName,
        leaseExpiresAt: this.leaseExpiryIso(leaseSeconds),
        updatedAt: now,
        revision: task.revision + 1,
      };
      const next = replaceTask(state, updated);
      await this.persistAndCache(next);
      return copyTask(updated);
    });
  }

  public async renew(input: AgentTaskClaimInput): Promise<AgentTask> {
    const identity = validateIdentity(input);
    const taskId = validateTaskId(input.taskId);
    const leaseSeconds = validateLeaseSeconds(input.leaseSeconds);

    return this.enqueueMutation(async () => {
      const state = await this.loadFreshState();
      const task = requireOwnedLeasedTask(state, taskId, identity.agentId);
      const updated: AgentTask = {
        ...task,
        leaseExpiresAt: this.leaseExpiryIso(leaseSeconds),
        updatedAt: this.nowIso(),
        revision: task.revision + 1,
      };
      const next = replaceTask(state, updated);
      await this.persistAndCache(next);
      return copyTask(updated);
    });
  }

  public async requestInput(input: AgentTaskUpdateInput & { leaseSeconds?: number }): Promise<AgentTask> {
    const identity = validateIdentity(input);
    const taskId = validateTaskId(input.taskId);
    const statusMessage = validateRequiredText(input.statusMessage, "statusMessage", AGENT_TASK_MESSAGE_MAX_BYTES);
    const leaseSeconds = validateLeaseSeconds(input.leaseSeconds);

    return this.enqueueMutation(async () => {
      const state = await this.loadFreshState();
      const task = requireOwnedLeasedTask(state, taskId, identity.agentId);
      const updated: AgentTask = {
        ...task,
        status: "input_required",
        statusMessage,
        leaseExpiresAt: this.leaseExpiryIso(leaseSeconds),
        updatedAt: this.nowIso(),
        revision: task.revision + 1,
      };
      const next = replaceTask(state, updated);
      await this.persistAndCache(next);
      return copyTask(updated);
    });
  }

  public async release(input: AgentTaskUpdateInput): Promise<AgentTask> {
    const identity = validateIdentity(input);
    const taskId = validateTaskId(input.taskId);
    const statusMessage = validateOptionalText(input.statusMessage, "statusMessage", AGENT_TASK_MESSAGE_MAX_BYTES);

    return this.enqueueMutation(async () => {
      const state = await this.loadFreshState();
      const task = requireOwnedLeasedTask(state, taskId, identity.agentId);
      const updated: AgentTask = {
        ...task,
        status: "open",
        statusMessage,
        ownerAgentId: undefined,
        ownerAgentName: undefined,
        leaseExpiresAt: undefined,
        updatedAt: this.nowIso(),
        revision: task.revision + 1,
      };
      const next = replaceTask(state, updated);
      await this.persistAndCache(next);
      return copyTask(updated);
    });
  }

  public async complete(input: AgentTaskCompleteInput): Promise<AgentTask> {
    return this.finish(input, "completed");
  }

  public async fail(input: AgentTaskCompleteInput): Promise<AgentTask> {
    return this.finish(input, "failed");
  }

  public async cancel(input: AgentTaskUpdateInput): Promise<AgentTask> {
    const identity = validateIdentity(input);
    const taskId = validateTaskId(input.taskId);
    const statusMessage = validateOptionalText(input.statusMessage, "statusMessage", AGENT_TASK_MESSAGE_MAX_BYTES);

    return this.enqueueMutation(async () => {
      const state = await this.loadFreshState();
      const task = requireTask(state, taskId);
      if (terminalStatuses.has(task.status)) throw new Error(`Task is already ${task.status}`);
      const authorized = task.createdByAgentId === identity.agentId || task.ownerAgentId === identity.agentId;
      if (!authorized) throw new Error("Only the task creator or current owner may cancel it");

      const updated = terminalTask(task, "cancelled", this.nowIso(), statusMessage);
      const next = replaceTask(state, updated);
      await this.persistAndCache(next);
      return copyTask(updated);
    });
  }

  private async finish(input: AgentTaskCompleteInput, status: "completed" | "failed"): Promise<AgentTask> {
    const identity = validateIdentity(input);
    const taskId = validateTaskId(input.taskId);
    const statusMessage = validateOptionalText(input.statusMessage, "statusMessage", AGENT_TASK_MESSAGE_MAX_BYTES);
    const artifact = validateOptionalText(input.artifact, "artifact", AGENT_TASK_ARTIFACT_MAX_BYTES);

    return this.enqueueMutation(async () => {
      const state = await this.loadFreshState();
      const task = requireOwnedLeasedTask(state, taskId, identity.agentId);
      const updated = terminalTask(task, status, this.nowIso(), statusMessage, artifact);
      const next = replaceTask(state, updated);
      await this.persistAndCache(next);
      return copyTask(updated);
    });
  }

  private async loadFreshState(): Promise<StoredAgentTaskState> {
    const current = await this.loadState();
    const nowValue = this.now();
    if (!(nowValue instanceof Date) || !Number.isFinite(nowValue.getTime())) throw new Error("now must return a valid Date");
    const nowMs = nowValue.getTime();
    let changed = false;
    const tasks = current.tasks.map((task) => {
      if (!leasedStatuses.has(task.status) || !task.leaseExpiresAt) return task;
      if (Date.parse(task.leaseExpiresAt) > nowMs) return task;
      changed = true;
      return {
        ...task,
        status: "open" as const,
        statusMessage: "Lease expired; task returned to open",
        ownerAgentId: undefined,
        ownerAgentName: undefined,
        leaseExpiresAt: undefined,
        updatedAt: nowValue.toISOString(),
        revision: task.revision + 1,
      };
    });
    if (!changed) return current;
    const state = this.withTasks(tasks);
    await this.persistAndCache(state);
    return state;
  }

  private withTasks(tasks: AgentTask[]): StoredAgentTaskState {
    return { version: 1, projectKey: this.projectKey, tasks };
  }

  private async enqueueMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const operation = this.sharedState.mutationQueue.then(mutation);
    this.sharedState.mutationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async loadState(): Promise<StoredAgentTaskState> {
    if (this.sharedState.state) return this.sharedState.state;
    const stateLoad = this.sharedState.stateLoad || this.readStateFile();
    this.sharedState.stateLoad = stateLoad;
    try {
      const state = await stateLoad;
      this.sharedState.state = state;
      return state;
    } finally {
      if (this.sharedState.stateLoad === stateLoad) this.sharedState.stateLoad = undefined;
    }
  }

  private async readStateFile(): Promise<StoredAgentTaskState> {
    await this.ensureDirectories();
    let serialized: string;
    try {
      serialized = await fs.promises.readFile(this.statePath, "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return emptyState(this.projectKey);
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized);
    } catch {
      throw new Error("Malformed agent task state: invalid JSON");
    }
    return validateState(parsed, this.projectKey);
  }

  private async persistAndCache(state: StoredAgentTaskState): Promise<void> {
    await this.persistState(state);
    this.sharedState.state = state;
  }

  private async persistState(state: StoredAgentTaskState): Promise<void> {
    await this.ensureDirectories();
    const temporaryPath = path.join(
      this.projectDir,
      `.agent-tasks-${process.pid}-${randomBytes(12).toString("hex")}.tmp`,
    );
    try {
      const file = await fs.promises.open(temporaryPath, "wx", 0o600);
      try {
        await file.writeFile(`${JSON.stringify(state)}\n`, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await fs.promises.rename(temporaryPath, this.statePath);
      await syncDirectory(this.projectDir);
    } catch (error) {
      await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async ensureDirectories(): Promise<void> {
    await fs.promises.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const canonicalDataDir = await fs.promises.realpath(this.dataDir);
    if (isWithin(this.workspace, canonicalDataDir)) {
      throw new Error("Agent task data must not be stored under the workspace");
    }
    await fs.promises.chmod(this.dataDir, 0o700);
    const projectsDir = path.join(this.dataDir, "projects");
    await fs.promises.mkdir(projectsDir, { recursive: true, mode: 0o700 });
    const canonicalProjectsDir = await fs.promises.realpath(projectsDir);
    if (!isWithin(canonicalDataDir, canonicalProjectsDir)) {
      throw new Error("Agent task projects directory escapes the configured data directory");
    }
    await fs.promises.chmod(projectsDir, 0o700);
    await fs.promises.mkdir(this.projectDir, { recursive: true, mode: 0o700 });
    const canonicalProjectDir = await fs.promises.realpath(this.projectDir);
    if (!isWithin(canonicalProjectsDir, canonicalProjectDir)) {
      throw new Error("Agent task project directory escapes the configured data directory");
    }
    await fs.promises.chmod(this.projectDir, 0o700);
  }

  private nowIso(): string {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("now must return a valid Date");
    return value.toISOString();
  }

  private leaseExpiryIso(leaseSeconds: number): string {
    const now = this.now();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("now must return a valid Date");
    return new Date(now.getTime() + leaseSeconds * 1_000).toISOString();
  }
}

function terminalTask(
  task: AgentTask,
  status: "completed" | "failed" | "cancelled",
  now: string,
  statusMessage?: string,
  artifact?: string,
): AgentTask {
  return {
    ...task,
    status,
    statusMessage,
    artifact,
    ownerAgentId: undefined,
    ownerAgentName: undefined,
    leaseExpiresAt: undefined,
    updatedAt: now,
    revision: task.revision + 1,
  };
}

function makeRoomForTask(tasks: AgentTask[]): AgentTask[] {
  if (tasks.length < AGENT_TASK_LIMIT) return tasks;
  const removableIndex = tasks.findIndex((task) => terminalStatuses.has(task.status));
  if (removableIndex < 0) throw new Error(`Agent task limit of ${AGENT_TASK_LIMIT} active tasks reached`);
  return tasks.filter((_, index) => index !== removableIndex);
}

function replaceTask(state: StoredAgentTaskState, updated: AgentTask): StoredAgentTaskState {
  return {
    ...state,
    tasks: state.tasks.map((task) => task.taskId === updated.taskId ? updated : task),
  };
}

function requireTask(state: StoredAgentTaskState, taskId: string): AgentTask {
  const task = state.tasks.find((candidate) => candidate.taskId === taskId);
  if (!task) throw new Error("Agent task not found");
  return task;
}

function requireOwnedLeasedTask(state: StoredAgentTaskState, taskId: string, agentId: string): AgentTask {
  const task = requireTask(state, taskId);
  if (!leasedStatuses.has(task.status) || !task.ownerAgentId) throw new Error(`Task is not currently claimed`);
  if (task.ownerAgentId !== agentId) throw new Error(`Task is claimed by ${task.ownerAgentName}`);
  return task;
}

function validateState(value: unknown, expectedProjectKey: string): StoredAgentTaskState {
  if (!isRecord(value) || value.version !== 1 || value.projectKey !== expectedProjectKey || !Array.isArray(value.tasks)) {
    throw new Error("Malformed or mismatched agent task state");
  }
  if (value.tasks.length > AGENT_TASK_LIMIT) throw new Error("Malformed agent task state: task limit exceeded");

  const taskIds = new Set<string>();
  const tasks = value.tasks.map((candidate) => validateStoredTask(candidate, taskIds));
  return { version: 1, projectKey: expectedProjectKey, tasks };
}

function validateStoredTask(value: unknown, taskIds: Set<string>): AgentTask {
  if (!isRecord(value)) throw new Error("Malformed agent task state: invalid task");
  const taskId = validateTaskId(value.taskId);
  if (taskIds.has(taskId)) throw new Error("Malformed agent task state: duplicate task ID");
  taskIds.add(taskId);

  const status = validateStatus(value.status);
  const task: AgentTask = {
    taskId,
    title: validateRequiredText(value.title, "title", AGENT_TASK_TITLE_MAX_BYTES),
    details: validateOptionalText(value.details, "details", AGENT_TASK_DETAILS_MAX_BYTES),
    status,
    statusMessage: validateOptionalText(value.statusMessage, "statusMessage", AGENT_TASK_MESSAGE_MAX_BYTES),
    artifact: validateOptionalText(value.artifact, "artifact", AGENT_TASK_ARTIFACT_MAX_BYTES),
    createdByAgentId: validateAgentId(value.createdByAgentId),
    createdByAgentName: validateRequiredText(value.createdByAgentName, "createdByAgentName", 100),
    ownerAgentId: value.ownerAgentId === undefined ? undefined : validateAgentId(value.ownerAgentId),
    ownerAgentName: validateOptionalText(value.ownerAgentName, "ownerAgentName", 100),
    leaseExpiresAt: validateOptionalDate(value.leaseExpiresAt, "leaseExpiresAt"),
    createdAt: validateDate(value.createdAt, "createdAt"),
    updatedAt: validateDate(value.updatedAt, "updatedAt"),
    revision: validateRevision(value.revision),
  };

  const hasCompleteLease = Boolean(task.ownerAgentId && task.ownerAgentName && task.leaseExpiresAt);
  const hasAnyLease = Boolean(task.ownerAgentId || task.ownerAgentName || task.leaseExpiresAt);
  if (leasedStatuses.has(status) && !hasCompleteLease) {
    throw new Error("Malformed agent task state: claimed task lacks owner or lease");
  }
  if (!leasedStatuses.has(status) && hasAnyLease) {
    throw new Error("Malformed agent task state: unclaimed task has owner or lease");
  }
  if (!terminalStatuses.has(status) && task.artifact !== undefined) {
    throw new Error("Malformed agent task state: non-terminal task has an artifact");
  }
  return task;
}

function validateIdentity(value: AgentTaskIdentity): AgentTaskIdentity {
  return {
    agentId: validateAgentId(value.agentId),
    agentName: validateRequiredText(value.agentName, "agentName", 100),
  };
}

function validateAgentId(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error("agentId must be non-empty");
  if (Buffer.byteLength(value.trim(), "utf8") > 256) throw new Error("agentId exceeds 256 UTF-8 bytes");
  return value.trim();
}

function validateTaskId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("taskId must be a UUID v4");
  }
  return value.toLowerCase();
}

function validateLeaseSeconds(value: unknown): number {
  const selected = value === undefined ? AGENT_TASK_DEFAULT_LEASE_SECONDS : value;
  if (typeof selected !== "number" || !Number.isSafeInteger(selected) || selected < 1 || selected > AGENT_TASK_MAX_LEASE_SECONDS) {
    throw new Error(`leaseSeconds must be an integer between 1 and ${AGENT_TASK_MAX_LEASE_SECONDS}`);
  }
  return selected;
}

function validateStatuses(value: unknown): Set<AgentTaskStatus> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) throw new Error("statuses must be a non-empty array");
  return new Set(value.map(validateStatus));
}

function validateStatus(value: unknown): AgentTaskStatus {
  if (typeof value !== "string" || !AGENT_TASK_STATUSES.includes(value as AgentTaskStatus)) {
    throw new Error("Invalid agent task status");
  }
  return value as AgentTaskStatus;
}

function validateRequiredText(value: unknown, field: string, maximumBytes: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${field} must be non-empty`);
  if (Buffer.byteLength(trimmed, "utf8") > maximumBytes) throw new Error(`${field} exceeds ${maximumBytes} UTF-8 bytes`);
  return trimmed;
}

function validateOptionalText(value: unknown, field: string, maximumBytes: number): string | undefined {
  if (value === undefined) return undefined;
  return validateRequiredText(value, field, maximumBytes);
}

function validateDate(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${field} must be an ISO date`);
  return new Date(value).toISOString();
}

function validateOptionalDate(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : validateDate(value, field);
}

function validateRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error("revision must be a positive integer");
  return value as number;
}

function emptyState(projectKey: string): StoredAgentTaskState {
  return { version: 1, projectKey, tasks: [] };
}

function copyTask(task: AgentTask): AgentTask {
  return { ...task };
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (process.platform !== "win32") throw error;
  } finally {
    await handle?.close();
  }
}
