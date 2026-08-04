import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AgentRoleAssignment } from "./roles.js";
import { validateAgentRoleAssignment } from "./roles.js";

export const COORDINATION_TASK_STATUSES = [
  "open",
  "assigned",
  "working",
  "blocked",
  "completed",
  "failed",
  "cancelled",
] as const;

export type CoordinationTaskStatus = typeof COORDINATION_TASK_STATUSES[number];
export type CoordinationAuthority = "controller" | "agent";

export interface CoordinationIdentity {
  actorId: string;
  actorName: string;
  authority: CoordinationAuthority;
  agentId?: string;
}

export interface CoordinationChatMessage {
  cursor: number;
  actorId: string;
  actorName: string;
  agentId?: string;
  message: string;
  createdAt: string;
}

export interface CoordinationChatReadResult {
  messages: CoordinationChatMessage[];
  oldestCursor: number;
  latestCursor: number;
  nextCursor: number;
  gap: boolean;
}

export interface CoordinationTask {
  taskId: string;
  title: string;
  details?: string;
  status: CoordinationTaskStatus;
  statusMessage?: string;
  artifact?: string;
  createdByActorId: string;
  createdByActorName: string;
  assignedAgentId?: string;
  assignedAgentName?: string;
  assignedRole?: AgentRoleAssignment;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export const COORDINATION_AUDIT_KINDS = [
  "agent_chat_post",
  "agent_task_create",
  "agent_task_assign",
  "agent_task_update",
] as const;

export type CoordinationAuditKind = typeof COORDINATION_AUDIT_KINDS[number];

/** Metadata-only: message bodies, task details, artifacts, and status text are excluded. */
export interface CoordinationAuditEvent {
  sequence: number;
  eventId: string;
  kind: CoordinationAuditKind;
  namespace: string;
  actorId: string;
  actorName: string;
  agentId?: string;
  taskId?: string;
  chatCursor?: number;
  fromStatus?: CoordinationTaskStatus;
  toStatus?: CoordinationTaskStatus;
  createdAt: string;
}

export interface CoordinationAuditReadResult {
  events: CoordinationAuditEvent[];
  oldestSequence: number;
  latestSequence: number;
  nextSequence: number;
  gap: boolean;
}

export interface AgentCoordinationStoreOptions {
  workspace: string;
  dataDir: string;
  namespace: string;
  chatLimit?: number;
  taskLimit?: number;
  auditLimit?: number;
  now?: () => Date;
  taskIdFactory?: () => string;
  eventIdFactory?: () => string;
}

export interface AgentChatPostInput extends CoordinationIdentity {
  message: string;
}

export interface AgentChatReadInput {
  after?: number;
  limit?: number;
}

export interface AgentTaskCreateInput extends CoordinationIdentity {
  title: string;
  details?: string;
}

export interface AgentTaskListInput {
  statuses?: readonly CoordinationTaskStatus[];
  assignedAgentId?: string;
  limit?: number;
}

export interface AgentTaskAssignInput extends CoordinationIdentity {
  taskId: string;
  expectedRevision: number;
  assignedAgentId: string;
  assignedAgentName: string;
  assignedRole?: AgentRoleAssignment;
  statusMessage?: string;
}

export interface AgentTaskUpdateInput extends CoordinationIdentity {
  taskId: string;
  expectedRevision: number;
  status: Exclude<CoordinationTaskStatus, "open" | "assigned">;
  statusMessage?: string;
  artifact?: string;
}

interface StoredCoordinationState {
  version: 1;
  projectKey: string;
  namespace: string;
  nextChatCursor: number;
  nextAuditSequence: number;
  chat: CoordinationChatMessage[];
  tasks: CoordinationTask[];
  audit: CoordinationAuditEvent[];
}

interface SharedCoordinationState {
  queue: Promise<void>;
}

const DEFAULT_CHAT_LIMIT = 500;
const DEFAULT_TASK_LIMIT = 500;
const DEFAULT_AUDIT_LIMIT = 2_000;
const MAX_CHAT_LIMIT = 10_000;
const MAX_TASK_LIMIT = 10_000;
const MAX_AUDIT_LIMIT = 50_000;
const CHAT_MESSAGE_MAX_BYTES = 16 * 1024;
const TASK_TITLE_MAX_BYTES = 256;
const TASK_DETAILS_MAX_BYTES = 16 * 1024;
const TASK_STATUS_MESSAGE_MAX_BYTES = 16 * 1024;
const TASK_ARTIFACT_MAX_BYTES = 32 * 1024;
const ID_MAX_BYTES = 256;
const NAME_MAX_BYTES = 100;
const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u;
const FORBIDDEN_TEXT_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const FORBIDDEN_SINGLE_LINE_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;
const LOCK_RETRY_MS = 25;
const TASK_STATUSES = new Set<string>(COORDINATION_TASK_STATUSES);
const TERMINAL_TASK_STATUSES = new Set<CoordinationTaskStatus>(["completed", "failed", "cancelled"]);
const AGENT_TASK_STATUSES = new Set<CoordinationTaskStatus>(["working", "blocked", "completed", "failed"]);
const sharedStates = new Map<string, SharedCoordinationState>();

/**
 * Compact durable chat/task control plane for one canonical workspace and one
 * explicit namespace.  It is transport-neutral; OAuth/MCP adapters must supply
 * the already-authenticated CoordinationIdentity.
 */
export class AgentCoordinationStore {
  public readonly workspace: string;
  public readonly dataDir: string;
  public readonly namespace: string;
  public readonly projectKey: string;
  public readonly statePath: string;

  private readonly projectDir: string;
  private readonly lockPath: string;
  private readonly chatLimit: number;
  private readonly taskLimit: number;
  private readonly auditLimit: number;
  private readonly now: () => Date;
  private readonly taskIdFactory: () => string;
  private readonly eventIdFactory: () => string;
  private readonly sharedState: SharedCoordinationState;

  public constructor(options: AgentCoordinationStoreOptions) {
    if (!options || typeof options !== "object") throw new Error("AgentCoordinationStore options are required");
    this.workspace = canonicalDirectory(options.workspace, "workspace");
    this.dataDir = path.resolve(requiredSingleLineText(options.dataDir, "dataDir", 4096));
    if (isWithin(this.workspace, this.dataDir)) {
      throw new Error("Agent coordination data must be outside the workspace");
    }
    this.namespace = validateNamespace(options.namespace);
    this.projectKey = createHash("sha256").update(this.workspace, "utf8").digest("hex");
    this.projectDir = path.join(this.dataDir, "agents", this.projectKey, this.namespace);
    this.statePath = path.join(this.projectDir, "coordination.json");
    this.lockPath = `${this.statePath}.lock`;
    this.chatLimit = boundedInteger(options.chatLimit ?? DEFAULT_CHAT_LIMIT, "chatLimit", 1, MAX_CHAT_LIMIT);
    this.taskLimit = boundedInteger(options.taskLimit ?? DEFAULT_TASK_LIMIT, "taskLimit", 1, MAX_TASK_LIMIT);
    this.auditLimit = boundedInteger(options.auditLimit ?? DEFAULT_AUDIT_LIMIT, "auditLimit", 1, MAX_AUDIT_LIMIT);
    this.now = options.now ?? (() => new Date());
    this.taskIdFactory = options.taskIdFactory ?? randomUUID;
    this.eventIdFactory = options.eventIdFactory ?? (() => `evt_${randomUUID()}`);
    this.nowIso();
    this.sharedState = sharedStates.get(this.statePath) ?? { queue: Promise.resolve() };
    sharedStates.set(this.statePath, this.sharedState);
  }

  public async agentChatPost(input: AgentChatPostInput): Promise<CoordinationChatMessage> {
    const identity = validateIdentity(input);
    const messageText = requiredText(input.message, "message", CHAT_MESSAGE_MAX_BYTES);
    return this.enqueue(async () => {
      const state = await this.readState();
      const createdAt = this.nowIso();
      const message: CoordinationChatMessage = {
        cursor: state.nextChatCursor,
        actorId: identity.actorId,
        actorName: identity.actorName,
        agentId: identity.agentId,
        message: messageText,
        createdAt,
      };
      const event = this.auditEvent(state, "agent_chat_post", identity, {
        chatCursor: message.cursor,
      });
      const next: StoredCoordinationState = {
        ...state,
        nextChatCursor: state.nextChatCursor + 1,
        nextAuditSequence: state.nextAuditSequence + 1,
        chat: [...state.chat, message].slice(-this.chatLimit),
        audit: [...state.audit, event].slice(-this.auditLimit),
      };
      await this.persist(next);
      return copyChatMessage(message);
    });
  }

  public async agentChatRead(input: AgentChatReadInput = {}): Promise<CoordinationChatReadResult> {
    const after = optionalCursor(input.after, "after");
    const limit = boundedInteger(input.limit ?? Math.min(100, this.chatLimit), "limit", 1, this.chatLimit);
    return this.enqueue(async () => {
      const state = await this.readState();
      const oldestCursor = state.chat[0]?.cursor ?? 0;
      const latestCursor = state.chat.at(-1)?.cursor ?? 0;
      if (after !== undefined && after > latestCursor) throw new Error("Agent chat cursor is ahead of the latest cursor");
      const gap = after !== undefined && state.chat.length > 0 && after < oldestCursor - 1;
      const eligible = after === undefined
        ? state.chat.slice(-limit)
        : state.chat.filter((message) => message.cursor > after).slice(0, limit);
      return {
        messages: eligible.map(copyChatMessage),
        oldestCursor,
        latestCursor,
        nextCursor: eligible.at(-1)?.cursor ?? after ?? latestCursor,
        gap,
      };
    });
  }

  public async agentTaskCreate(input: AgentTaskCreateInput): Promise<CoordinationTask> {
    const identity = validateIdentity(input);
    const title = requiredSingleLineText(input.title, "title", TASK_TITLE_MAX_BYTES);
    const details = optionalText(input.details, "details", TASK_DETAILS_MAX_BYTES);
    return this.enqueue(async () => {
      const state = await this.readState();
      const createdAt = this.nowIso();
      const taskId = validateIdentifier(this.taskIdFactory(), "generated taskId");
      if (state.tasks.some((task) => task.taskId === taskId)) throw new Error(`Duplicate generated task ID '${taskId}'`);
      const task: CoordinationTask = {
        taskId,
        title,
        details,
        status: "open",
        createdByActorId: identity.actorId,
        createdByActorName: identity.actorName,
        createdAt,
        updatedAt: createdAt,
        revision: 1,
      };
      const tasks = makeTaskRoom(state.tasks, this.taskLimit);
      const event = this.auditEvent(state, "agent_task_create", identity, {
        taskId,
        toStatus: "open",
      });
      const next: StoredCoordinationState = {
        ...state,
        nextAuditSequence: state.nextAuditSequence + 1,
        tasks: [...tasks, task],
        audit: [...state.audit, event].slice(-this.auditLimit),
      };
      await this.persist(next);
      return copyTask(task);
    });
  }

  public async agentTaskList(input: AgentTaskListInput = {}): Promise<CoordinationTask[]> {
    const statuses = validateStatusFilter(input.statuses);
    const assignedAgentId = input.assignedAgentId === undefined
      ? undefined
      : validateIdentifier(input.assignedAgentId, "assignedAgentId");
    const limit = boundedInteger(input.limit ?? Math.min(100, this.taskLimit), "limit", 1, this.taskLimit);
    return this.enqueue(async () => {
      const state = await this.readState();
      return state.tasks
        .filter((task) => !statuses || statuses.has(task.status))
        .filter((task) => !assignedAgentId || task.assignedAgentId === assignedAgentId)
        .slice()
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.taskId.localeCompare(left.taskId))
        .slice(0, limit)
        .map(copyTask);
    });
  }

  public async agentTaskAssign(input: AgentTaskAssignInput): Promise<CoordinationTask> {
    const identity = validateIdentity(input);
    if (identity.authority !== "controller") throw new Error("Only the local controller may assign tasks");
    const taskId = validateIdentifier(input.taskId, "taskId");
    const expectedRevision = positiveInteger(input.expectedRevision, "expectedRevision");
    const assignedAgentId = validateIdentifier(input.assignedAgentId, "assignedAgentId");
    const assignedAgentName = requiredSingleLineText(input.assignedAgentName, "assignedAgentName", NAME_MAX_BYTES);
    const assignedRole = input.assignedRole === undefined ? undefined : validateAgentRoleAssignment(input.assignedRole);
    const statusMessage = optionalText(input.statusMessage, "statusMessage", TASK_STATUS_MESSAGE_MAX_BYTES);
    return this.enqueue(async () => {
      const state = await this.readState();
      const task = requireTask(state, taskId);
      requireRevision(task, expectedRevision);
      if (TERMINAL_TASK_STATUSES.has(task.status)) throw new Error(`Task is already ${task.status}`);
      const updated: CoordinationTask = {
        ...task,
        status: "assigned",
        statusMessage,
        artifact: undefined,
        assignedAgentId,
        assignedAgentName,
        assignedRole,
        updatedAt: this.nowIso(),
        revision: task.revision + 1,
      };
      const event = this.auditEvent(state, "agent_task_assign", identity, {
        taskId,
        agentId: assignedAgentId,
        fromStatus: task.status,
        toStatus: "assigned",
      });
      await this.persist({
        ...state,
        nextAuditSequence: state.nextAuditSequence + 1,
        tasks: replaceTask(state.tasks, updated),
        audit: [...state.audit, event].slice(-this.auditLimit),
      });
      return copyTask(updated);
    });
  }

  public async agentTaskUpdate(input: AgentTaskUpdateInput): Promise<CoordinationTask> {
    const identity = validateIdentity(input);
    const taskId = validateIdentifier(input.taskId, "taskId");
    const expectedRevision = positiveInteger(input.expectedRevision, "expectedRevision");
    const targetStatus = validateUpdateStatus(input.status);
    const statusMessage = optionalText(input.statusMessage, "statusMessage", TASK_STATUS_MESSAGE_MAX_BYTES);
    const artifact = optionalText(input.artifact, "artifact", TASK_ARTIFACT_MAX_BYTES);
    if ((targetStatus === "blocked" || targetStatus === "failed") && !statusMessage) {
      throw new Error(`statusMessage is required when task status is ${targetStatus}`);
    }
    if (artifact && targetStatus !== "completed" && targetStatus !== "failed") {
      throw new Error("artifact is permitted only for completed or failed tasks");
    }
    return this.enqueue(async () => {
      const state = await this.readState();
      const task = requireTask(state, taskId);
      requireRevision(task, expectedRevision);
      requireTaskUpdateAuthority(identity, task, targetStatus);
      requireTaskTransition(task.status, targetStatus, identity.authority);
      const updated: CoordinationTask = {
        ...task,
        status: targetStatus,
        statusMessage,
        artifact,
        updatedAt: this.nowIso(),
        revision: task.revision + 1,
      };
      const event = this.auditEvent(state, "agent_task_update", identity, {
        taskId,
        fromStatus: task.status,
        toStatus: targetStatus,
      });
      await this.persist({
        ...state,
        nextAuditSequence: state.nextAuditSequence + 1,
        tasks: replaceTask(state.tasks, updated),
        audit: [...state.audit, event].slice(-this.auditLimit),
      });
      return copyTask(updated);
    });
  }

  public async auditRead(after?: number, limit = Math.min(100, this.auditLimit)): Promise<CoordinationAuditReadResult> {
    const cursor = optionalCursor(after, "after");
    const selectedLimit = boundedInteger(limit, "limit", 1, this.auditLimit);
    return this.enqueue(async () => {
      const state = await this.readState();
      const oldestSequence = state.audit[0]?.sequence ?? 0;
      const latestSequence = state.audit.at(-1)?.sequence ?? 0;
      if (cursor !== undefined && cursor > latestSequence) throw new Error("Audit cursor is ahead of the latest sequence");
      const gap = cursor !== undefined && state.audit.length > 0 && cursor < oldestSequence - 1;
      const events = cursor === undefined
        ? state.audit.slice(-selectedLimit)
        : state.audit.filter((event) => event.sequence > cursor).slice(0, selectedLimit);
      return {
        events: events.map(copyAuditEvent),
        oldestSequence,
        latestSequence,
        nextSequence: events.at(-1)?.sequence ?? cursor ?? latestSequence,
        gap,
      };
    });
  }

  private auditEvent(
    state: StoredCoordinationState,
    kind: CoordinationAuditKind,
    identity: Readonly<CoordinationIdentity>,
    fields: Partial<Pick<CoordinationAuditEvent, "agentId" | "taskId" | "chatCursor" | "fromStatus" | "toStatus">>,
  ): CoordinationAuditEvent {
    return {
      sequence: state.nextAuditSequence,
      eventId: validateIdentifier(this.eventIdFactory(), "generated eventId"),
      kind,
      namespace: this.namespace,
      actorId: identity.actorId,
      actorName: identity.actorName,
      agentId: fields.agentId ?? identity.agentId,
      taskId: fields.taskId,
      chatCursor: fields.chatCursor,
      fromStatus: fields.fromStatus,
      toStatus: fields.toStatus,
      createdAt: this.nowIso(),
    };
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.sharedState.queue.then(() => this.withLock(operation));
    this.sharedState.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await this.ensureDirectories();
    const token = `${process.pid}:${randomBytes(16).toString("hex")}`;
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    while (true) {
      try {
        const handle = await fs.promises.open(this.lockPath, "wx", 0o600);
        let initializationError: unknown;
        try {
          await handle.writeFile(`${token}\n`, "utf8");
          await handle.sync();
        } catch (error) {
          initializationError = error;
        } finally {
          try {
            await handle.close();
          } catch (error) {
            initializationError ??= error;
          }
        }
        if (initializationError !== undefined) {
          await fs.promises.rm(this.lockPath, { force: true });
          throw initializationError;
        }
        break;
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) throw error;
        await this.removeStaleLock();
        if (Date.now() >= deadline) throw new Error("Timed out waiting for the agent coordination lock");
        await delay(LOCK_RETRY_MS);
      }
    }
    try {
      return await operation();
    } finally {
      try {
        const owner = (await fs.promises.readFile(this.lockPath, "utf8")).trim();
        if (owner === token) await fs.promises.rm(this.lockPath, { force: true });
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) throw error;
      }
    }
  }

  private async removeStaleLock(): Promise<void> {
    try {
      const first = await fs.promises.stat(this.lockPath);
      if (Date.now() - first.mtimeMs <= STALE_LOCK_MS) return;
      const owner = (await fs.promises.readFile(this.lockPath, "utf8")).trim();
      const pid = parseLockPid(owner);
      if (pid === undefined || processIsAlive(pid)) return;
      const second = await fs.promises.stat(this.lockPath);
      const currentOwner = (await fs.promises.readFile(this.lockPath, "utf8")).trim();
      if (currentOwner !== owner || second.dev !== first.dev || second.ino !== first.ino) return;
      await fs.promises.rm(this.lockPath);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
  }

  private async readState(): Promise<StoredCoordinationState> {
    let serialized: string;
    try {
      serialized = await fs.promises.readFile(this.statePath, "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return emptyState(this.projectKey, this.namespace);
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized);
    } catch {
      throw new Error("Malformed agent coordination state: invalid JSON");
    }
    return validateState(parsed, this.projectKey, this.namespace, this.chatLimit, this.taskLimit, this.auditLimit);
  }

  private async persist(state: StoredCoordinationState): Promise<void> {
    const temporary = path.join(this.projectDir, `.coordination-${process.pid}-${randomBytes(12).toString("hex")}.tmp`);
    try {
      const handle = await fs.promises.open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(state)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.promises.chmod(temporary, 0o600);
      await fs.promises.rename(temporary, this.statePath);
      await fs.promises.chmod(this.statePath, 0o600);
      await syncDirectory(this.projectDir);
    } catch (error) {
      await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async ensureDirectories(): Promise<void> {
    await fs.promises.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const canonicalDataDir = await fs.promises.realpath(this.dataDir);
    if (isWithin(this.workspace, canonicalDataDir)) throw new Error("Agent coordination data must be outside the workspace");
    await fs.promises.chmod(canonicalDataDir, 0o700);
    let current = canonicalDataDir;
    for (const segment of ["agents", this.projectKey, this.namespace]) {
      current = path.join(current, segment);
      await fs.promises.mkdir(current, { recursive: true, mode: 0o700 });
      const canonical = await fs.promises.realpath(current);
      if (!isWithin(canonicalDataDir, canonical)) throw new Error("Agent coordination directory escapes dataDir");
      await fs.promises.chmod(canonical, 0o700);
      current = canonical;
    }
  }

  private nowIso(): string {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("now must return a valid Date");
    return value.toISOString();
  }
}

function emptyState(projectKey: string, namespace: string): StoredCoordinationState {
  return {
    version: 1,
    projectKey,
    namespace,
    nextChatCursor: 1,
    nextAuditSequence: 1,
    chat: [],
    tasks: [],
    audit: [],
  };
}

function validateState(
  value: unknown,
  projectKey: string,
  namespace: string,
  chatLimit: number,
  taskLimit: number,
  auditLimit: number,
): StoredCoordinationState {
  if (!isRecord(value) || value.version !== 1 || value.projectKey !== projectKey || value.namespace !== namespace) {
    throw new Error("Malformed or mismatched agent coordination state");
  }
  assertOnlyKeys(value, [
    "version", "projectKey", "namespace", "nextChatCursor", "nextAuditSequence", "chat", "tasks", "audit",
  ], "agent coordination state");
  const nextChatCursor = positiveInteger(value.nextChatCursor, "nextChatCursor");
  const nextAuditSequence = positiveInteger(value.nextAuditSequence, "nextAuditSequence");
  if (!Array.isArray(value.chat) || value.chat.length > chatLimit) throw new Error("Malformed agent coordination chat");
  if (!Array.isArray(value.tasks) || value.tasks.length > taskLimit) throw new Error("Malformed agent coordination tasks");
  if (!Array.isArray(value.audit) || value.audit.length > auditLimit) throw new Error("Malformed agent coordination audit");
  const chat = value.chat.map(validateStoredChat);
  requireContiguous(chat.map((message) => message.cursor), nextChatCursor, "chat cursor");
  const taskIds = new Set<string>();
  const tasks = value.tasks.map((candidate) => {
    const task = validateStoredTask(candidate);
    if (taskIds.has(task.taskId)) throw new Error("Malformed agent coordination state: duplicate task ID");
    taskIds.add(task.taskId);
    return task;
  });
  const eventIds = new Set<string>();
  const audit = value.audit.map((candidate) => {
    const event = validateStoredAudit(candidate);
    if (eventIds.has(event.eventId)) throw new Error("Malformed coordination audit: duplicate event ID");
    eventIds.add(event.eventId);
    return event;
  });
  if (audit.some((event) => event.namespace !== namespace)) {
    throw new Error("Malformed or mismatched coordination audit namespace");
  }
  requireContiguous(audit.map((event) => event.sequence), nextAuditSequence, "audit sequence");
  return { version: 1, projectKey, namespace, nextChatCursor, nextAuditSequence, chat, tasks, audit };
}

function validateStoredChat(value: unknown): CoordinationChatMessage {
  if (!isRecord(value)) throw new Error("Malformed agent chat message");
  assertOnlyKeys(value, ["cursor", "actorId", "actorName", "agentId", "message", "createdAt"], "agent chat message");
  return {
    cursor: positiveInteger(value.cursor, "chat cursor"),
    actorId: validateIdentifier(value.actorId, "actorId"),
    actorName: requiredSingleLineText(value.actorName, "actorName", NAME_MAX_BYTES),
    agentId: value.agentId === undefined ? undefined : validateIdentifier(value.agentId, "agentId"),
    message: requiredText(value.message, "message", CHAT_MESSAGE_MAX_BYTES),
    createdAt: validateIso(value.createdAt, "createdAt"),
  };
}

function validateStoredTask(value: unknown): CoordinationTask {
  if (!isRecord(value)) throw new Error("Malformed coordination task");
  assertOnlyKeys(value, [
    "taskId", "title", "details", "status", "statusMessage", "artifact", "createdByActorId",
    "createdByActorName", "assignedAgentId", "assignedAgentName", "assignedRole", "createdAt", "updatedAt", "revision",
  ], "coordination task");
  const status = validateTaskStatus(value.status);
  const assignedAgentId = value.assignedAgentId === undefined ? undefined : validateIdentifier(value.assignedAgentId, "assignedAgentId");
  const assignedAgentName = value.assignedAgentName === undefined
    ? undefined
    : requiredSingleLineText(value.assignedAgentName, "assignedAgentName", NAME_MAX_BYTES);
  if ((assignedAgentId === undefined) !== (assignedAgentName === undefined)) {
    throw new Error("Malformed coordination task assignment");
  }
  if (value.assignedRole !== undefined && assignedAgentId === undefined) {
    throw new Error("Malformed coordination task: role has no assigned agent");
  }
  if (status === "open" && assignedAgentId !== undefined) {
    throw new Error("Malformed coordination task: open task retains an assignment");
  }
  if (status !== "open" && status !== "cancelled" && assignedAgentId === undefined) {
    throw new Error("Malformed coordination task: active or completed assignment has no agent");
  }
  const statusMessage = optionalText(value.statusMessage, "statusMessage", TASK_STATUS_MESSAGE_MAX_BYTES);
  const artifact = optionalText(value.artifact, "artifact", TASK_ARTIFACT_MAX_BYTES);
  if ((status === "blocked" || status === "failed") && !statusMessage) {
    throw new Error(`Malformed coordination task: ${status} task has no status message`);
  }
  if (artifact && status !== "completed" && status !== "failed") {
    throw new Error("Malformed coordination task: artifact is attached to a non-terminal outcome");
  }
  const createdAt = validateIso(value.createdAt, "createdAt");
  const updatedAt = validateIso(value.updatedAt, "updatedAt");
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new Error("Malformed coordination task: updatedAt precedes createdAt");
  }
  return {
    taskId: validateIdentifier(value.taskId, "taskId"),
    title: requiredSingleLineText(value.title, "title", TASK_TITLE_MAX_BYTES),
    details: optionalText(value.details, "details", TASK_DETAILS_MAX_BYTES),
    status,
    statusMessage,
    artifact,
    createdByActorId: validateIdentifier(value.createdByActorId, "createdByActorId"),
    createdByActorName: requiredSingleLineText(value.createdByActorName, "createdByActorName", NAME_MAX_BYTES),
    assignedAgentId,
    assignedAgentName,
    assignedRole: value.assignedRole === undefined ? undefined : validateAgentRoleAssignment(value.assignedRole),
    createdAt,
    updatedAt,
    revision: positiveInteger(value.revision, "revision"),
  };
}

function validateStoredAudit(value: unknown): CoordinationAuditEvent {
  if (!isRecord(value)) throw new Error("Malformed coordination audit event");
  assertOnlyKeys(value, [
    "sequence", "eventId", "kind", "namespace", "actorId", "actorName", "agentId", "taskId",
    "chatCursor", "fromStatus", "toStatus", "createdAt",
  ], "coordination audit event");
  if (typeof value.kind !== "string" || !COORDINATION_AUDIT_KINDS.includes(value.kind as CoordinationAuditKind)) {
    throw new Error("Malformed coordination audit kind");
  }
  const event: CoordinationAuditEvent = {
    sequence: positiveInteger(value.sequence, "audit sequence"),
    eventId: validateIdentifier(value.eventId, "eventId"),
    kind: value.kind as CoordinationAuditKind,
    namespace: validateNamespace(value.namespace),
    actorId: validateIdentifier(value.actorId, "actorId"),
    actorName: requiredSingleLineText(value.actorName, "actorName", NAME_MAX_BYTES),
    agentId: value.agentId === undefined ? undefined : validateIdentifier(value.agentId, "agentId"),
    taskId: value.taskId === undefined ? undefined : validateIdentifier(value.taskId, "taskId"),
    chatCursor: value.chatCursor === undefined ? undefined : positiveInteger(value.chatCursor, "chatCursor"),
    fromStatus: value.fromStatus === undefined ? undefined : validateTaskStatus(value.fromStatus),
    toStatus: value.toStatus === undefined ? undefined : validateTaskStatus(value.toStatus),
    createdAt: validateIso(value.createdAt, "createdAt"),
  };
  validateAuditShape(event);
  return event;
}

function validateAuditShape(event: CoordinationAuditEvent): void {
  if (event.kind === "agent_chat_post") {
    if (!event.chatCursor || event.taskId || event.fromStatus || event.toStatus) {
      throw new Error("Malformed agent_chat_post audit event");
    }
    return;
  }
  if (!event.taskId || event.chatCursor) throw new Error(`Malformed ${event.kind} audit event`);
  if (event.kind === "agent_task_create") {
    if (event.fromStatus || event.toStatus !== "open") throw new Error("Malformed agent_task_create audit event");
    return;
  }
  if (!event.fromStatus || !event.toStatus) throw new Error(`Malformed ${event.kind} audit transition`);
  if (event.kind === "agent_task_assign" && (!event.agentId || event.toStatus !== "assigned")) {
    throw new Error("Malformed agent_task_assign audit event");
  }
}

function validateIdentity(value: CoordinationIdentity): CoordinationIdentity {
  if (!value || typeof value !== "object") throw new Error("coordination identity must be an object");
  if (value.authority !== "controller" && value.authority !== "agent") throw new Error("Invalid coordination authority");
  const agentId = value.agentId === undefined ? undefined : validateIdentifier(value.agentId, "agentId");
  if (value.authority === "agent" && !agentId) throw new Error("Agent authority requires agentId");
  return Object.freeze({
    actorId: validateIdentifier(value.actorId, "actorId"),
    actorName: requiredSingleLineText(value.actorName, "actorName", NAME_MAX_BYTES),
    authority: value.authority,
    agentId,
  });
}

function requireTaskUpdateAuthority(
  identity: CoordinationIdentity,
  task: CoordinationTask,
  targetStatus: CoordinationTaskStatus,
): void {
  if (identity.authority === "controller") return;
  if (!identity.agentId || task.assignedAgentId !== identity.agentId) {
    throw new Error("Agent may update only a task assigned to that exact agent ID");
  }
  if (!AGENT_TASK_STATUSES.has(targetStatus)) throw new Error(`Agent may not set task status to ${targetStatus}`);
}

function requireTaskTransition(
  from: CoordinationTaskStatus,
  to: CoordinationTaskStatus,
  authority: CoordinationAuthority,
): void {
  if (TERMINAL_TASK_STATUSES.has(from)) throw new Error(`Task is already ${from}`);
  if (from === to) throw new Error(`Task is already ${to}`);
  if (to === "cancelled" && authority !== "controller") throw new Error("Only the local controller may cancel tasks");
  if (from === "open" && to !== "cancelled") throw new Error("Open task must be assigned before work begins");
  if (from === "blocked" && to === "completed") return;
}

function makeTaskRoom(tasks: CoordinationTask[], limit: number): CoordinationTask[] {
  if (tasks.length < limit) return tasks;
  const removable = tasks
    .filter((task) => TERMINAL_TASK_STATUSES.has(task.status))
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt) || left.taskId.localeCompare(right.taskId))[0];
  if (!removable) throw new Error(`Coordination task limit of ${limit} active tasks reached`);
  return tasks.filter((task) => task.taskId !== removable.taskId);
}

function validateStatusFilter(value: unknown): ReadonlySet<CoordinationTaskStatus> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) throw new Error("statuses must be a non-empty array");
  const statuses = new Set<CoordinationTaskStatus>();
  for (const candidate of value) statuses.add(validateTaskStatus(candidate));
  return statuses;
}

function validateTaskStatus(value: unknown): CoordinationTaskStatus {
  if (typeof value !== "string" || !TASK_STATUSES.has(value)) throw new Error("Invalid coordination task status");
  return value as CoordinationTaskStatus;
}

function validateUpdateStatus(value: unknown): Exclude<CoordinationTaskStatus, "open" | "assigned"> {
  const status = validateTaskStatus(value);
  if (status === "open" || status === "assigned") throw new Error("Use agentTaskAssign to assign or reassign a task");
  return status;
}

function requireTask(state: StoredCoordinationState, taskId: string): CoordinationTask {
  const task = state.tasks.find((candidate) => candidate.taskId === taskId);
  if (!task) throw new Error(`Unknown coordination task '${taskId}'`);
  return task;
}

function requireRevision(task: CoordinationTask, expectedRevision: number): void {
  if (task.revision !== expectedRevision) {
    throw new Error(`Stale task revision: expected ${expectedRevision}, current ${task.revision}`);
  }
}

function replaceTask(tasks: CoordinationTask[], updated: CoordinationTask): CoordinationTask[] {
  return tasks.map((task) => task.taskId === updated.taskId ? updated : task);
}

function validateNamespace(value: unknown): string {
  if (typeof value !== "string" || !NAMESPACE_PATTERN.test(value)) {
    throw new Error("namespace must be a lowercase identifier of at most 64 characters");
  }
  return value;
}

function validateIdentifier(value: unknown, field: string): string {
  const selected = requiredSingleLineText(value, field, ID_MAX_BYTES);
  if (!IDENTIFIER_PATTERN.test(selected)) {
    throw new Error(`${field} contains unsupported identifier characters`);
  }
  return selected;
}

function requiredText(value: unknown, field: string, maximumBytes: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} must be non-empty`);
  if (Buffer.byteLength(normalized, "utf8") > maximumBytes) throw new Error(`${field} exceeds ${maximumBytes} UTF-8 bytes`);
  if (FORBIDDEN_TEXT_CHARACTERS.test(normalized)) {
    throw new Error(`${field} contains control or bidirectional formatting characters`);
  }
  return normalized;
}

function requiredSingleLineText(value: unknown, field: string, maximumBytes: number): string {
  const normalized = requiredText(value, field, maximumBytes);
  if (FORBIDDEN_SINGLE_LINE_CHARACTERS.test(normalized)) {
    throw new Error(`${field} contains control or bidirectional formatting characters`);
  }
  return normalized;
}

function optionalText(value: unknown, field: string, maximumBytes: number): string | undefined {
  return value === undefined ? undefined : requiredText(value, field, maximumBytes);
}

function canonicalDirectory(value: unknown, field: string): string {
  const selected = requiredSingleLineText(value, field, 4096);
  if (!path.isAbsolute(selected)) throw new Error(`${field} must be absolute`);
  let canonical: string;
  try {
    canonical = fs.realpathSync(selected);
  } catch {
    throw new Error(`${field} directory does not exist: ${selected}`);
  }
  if (!fs.statSync(canonical).isDirectory()) throw new Error(`${field} is not a directory`);
  return canonical;
}

function boundedInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${field} must be a positive integer`);
  return value as number;
}

function optionalCursor(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${field} must be a non-negative integer`);
  return value as number;
}

function validateIso(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${field} must be an ISO timestamp`);
  return value;
}

function requireContiguous(values: number[], next: number, field: string): void {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index] !== values[index - 1] + 1) throw new Error(`Malformed ${field} sequence`);
  }
  if (values.length > 0 && next !== values.at(-1)! + 1) throw new Error(`Malformed ${field} counter`);
  if (values.length === 0 && next !== 1) throw new Error(`Malformed ${field} counter`);
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const selected = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!selected.has(key)) throw new Error(`Malformed ${label}: unexpected field '${key}'`);
  }
}

function copyChatMessage(value: CoordinationChatMessage): CoordinationChatMessage {
  return { ...value };
}

function copyTask(value: CoordinationTask): CoordinationTask {
  return { ...value, assignedRole: value.assignedRole ? { ...value.assignedRole } : undefined };
}

function copyAuditEvent(value: CoordinationAuditEvent): CoordinationAuditEvent {
  return { ...value };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function parseLockPid(value: string): number | undefined {
  const match = /^(\d+):[a-f0-9]{32}$/u.exec(value);
  if (!match) return undefined;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error, "EPERM");
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await fs.promises.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
