import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CollaborationSessionStore } from "./collaboration-sessions.js";

export const AGENT_WORK_LIFECYCLES = [
  "working",
  "waiting_for_task",
  "offline",
  "released",
] as const;
export type AgentWorkLifecycle = typeof AGENT_WORK_LIFECYCLES[number];

export const AGENT_WORK_STATE_LIMIT = 500;
export const AGENT_WORK_RELEASE_REASON_MAX_BYTES = 8 * 1024;
export const AGENT_WORK_TASK_BOARD_TOKEN_PATTERN = /^wt_[A-Za-z0-9_-]{43}$/u;
export const AGENT_WORK_DEFAULT_MAX_WAIT_SECONDS = 30;
export const AGENT_WORK_MAX_WAIT_SECONDS = 60;

const WORK_LOCK_TIMEOUT_MS = 5_000;
const WORK_STALE_LOCK_MS = 30_000;
const WORK_LOCK_RETRY_MS = 25;
const COLLABORATION_SESSION_ID_PATTERN = /^cs_[A-Za-z0-9_-]{24}$/u;
const ROLE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;

export interface AgentWorkParticipantInput {
  collaborationSessionId: string;
  agentId: string;
  agentName: string;
  canonicalRoleId: string;
  occupancyLabel: string;
}

export interface AgentWorkState extends AgentWorkParticipantInput {
  lifecycle: AgentWorkLifecycle;
  consecutiveTimeouts: number;
  lastChatCursor?: number;
  taskBoardToken?: string;
  releasedByCollaborationSessionId?: string;
  releaseReason?: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface AgentWorkLoopStoreOptions {
  workspace: string;
  dataDir?: string;
  now?: () => Date;
  collaborationSessionStore?: CollaborationSessionStore;
}

export interface AgentWorkListOptions {
  lifecycles?: AgentWorkLifecycle[];
  limit?: number;
}

export interface AgentWorkOutcomeInput {
  collaborationSessionId: string;
  changed: boolean;
  chatCursor: number;
  taskBoardToken: string;
}

export interface AgentWorkManagerReleaseInput {
  managerCollaborationSessionId: string;
  targetCollaborationSessionId: string;
  expectedRevision: number;
  reason: string;
}

interface StoredAgentWorkState {
  version: 1;
  projectKey: string;
  participants: AgentWorkState[];
}

interface SharedAgentWorkState {
  queue: Promise<void>;
}

const sharedStates = new Map<string, SharedAgentWorkState>();

/** Durable project-scoped work-seeking lifecycle for verified collaboration sessions. */
export class AgentWorkLoopStore {
  public readonly workspace: string;
  public readonly projectKey: string;
  public readonly statePath: string;

  private readonly dataDir: string;
  private readonly projectDir: string;
  private readonly lockPath: string;
  private readonly now: () => Date;
  private readonly collaborationSessionStore?: CollaborationSessionStore;
  private readonly sharedState: SharedAgentWorkState;

  public constructor(options: AgentWorkLoopStoreOptions) {
    const selectedDataDir = options.dataDir || process.env.PI_DATA_DIR;
    if (!selectedDataDir) throw new Error("AgentWorkLoopStore requires dataDir or PI_DATA_DIR");

    this.workspace = fs.realpathSync(options.workspace);
    this.dataDir = path.resolve(selectedDataDir);
    if (isWithin(this.workspace, this.dataDir)) {
      throw new Error("Agent work-loop data must not be stored under the workspace");
    }

    this.now = options.now || (() => new Date());
    this.collaborationSessionStore = options.collaborationSessionStore;
    this.projectKey = createHash("sha256").update(this.workspace).digest("hex");
    this.projectDir = path.join(this.dataDir, "projects", this.projectKey);
    this.statePath = path.join(this.projectDir, "agent-work-loop.json");
    this.lockPath = `${this.statePath}.lock`;
    this.sharedState = sharedStates.get(this.statePath) || { queue: Promise.resolve() };
    sharedStates.set(this.statePath, this.sharedState);
  }

  public async register(input: AgentWorkParticipantInput): Promise<AgentWorkState> {
    const participant = validateParticipant(input);
    return this.enqueue(async () => {
      await this.assertAuthoritativeSessionUsable(participant);
      const state = await this.readReconciledState();
      const existing = state.participants.find(
        (candidate) => candidate.collaborationSessionId === participant.collaborationSessionId,
      );
      if (existing) {
        requireSameParticipant(existing, participant);
        if (existing.lifecycle === "released" || existing.lifecycle !== "offline") return copyState(existing);
        const updated: AgentWorkState = {
          ...existing,
          lifecycle: "working",
          consecutiveTimeouts: 0,
          updatedAt: this.nowIso(),
          revision: existing.revision + 1,
        };
        await this.persist(replaceParticipant(state, updated));
        return copyState(updated);
      }

      const now = this.nowIso();
      const created: AgentWorkState = {
        ...participant,
        lifecycle: "working",
        consecutiveTimeouts: 0,
        createdAt: now,
        updatedAt: now,
        revision: 1,
      };
      const nextParticipants = makeRoomForParticipant(state.participants);
      const next = withParticipants(state, [...nextParticipants, created]);
      await this.persist(next);
      return copyState(created);
    });
  }

  public async get(collaborationSessionId: string): Promise<AgentWorkState> {
    const normalizedId = validateSessionId(collaborationSessionId, "collaborationSessionId");
    return this.enqueue(async () => {
      const state = await this.readReconciledState();
      return copyState(requireParticipant(state, normalizedId));
    });
  }

  public async list(options: AgentWorkListOptions = {}): Promise<AgentWorkState[]> {
    const lifecycles = validateLifecycles(options.lifecycles);
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > AGENT_WORK_STATE_LIMIT) {
      throw new Error(`limit must be an integer between 1 and ${AGENT_WORK_STATE_LIMIT}`);
    }
    return this.enqueue(async () => {
      const state = await this.readReconciledState();
      return state.participants
        .filter((participant) => !lifecycles || lifecycles.has(participant.lifecycle))
        .slice()
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) ||
          right.collaborationSessionId.localeCompare(left.collaborationSessionId))
        .slice(0, limit)
        .map(copyState);
    });
  }

  public async markWorking(collaborationSessionId: string): Promise<AgentWorkState> {
    const normalizedId = validateSessionId(collaborationSessionId, "collaborationSessionId");
    return this.enqueue(async () => {
      const state = await this.readReconciledState();
      const participant = requireParticipant(state, normalizedId);
      if (participant.lifecycle === "released") return copyState(participant);
      if (participant.lifecycle === "working") return copyState(participant);
      const updated: AgentWorkState = {
        ...participant,
        lifecycle: "working",
        consecutiveTimeouts: 0,
        updatedAt: this.nowIso(),
        revision: participant.revision + 1,
      };
      await this.persist(replaceParticipant(state, updated));
      return copyState(updated);
    });
  }

  public async markWaiting(collaborationSessionId: string): Promise<AgentWorkState> {
    const normalizedId = validateSessionId(collaborationSessionId, "collaborationSessionId");
    return this.enqueue(async () => {
      const state = await this.readReconciledState();
      const participant = requireParticipant(state, normalizedId);
      if (participant.lifecycle === "released") return copyState(participant);
      if (participant.lifecycle === "waiting_for_task") return copyState(participant);
      const updated: AgentWorkState = {
        ...participant,
        lifecycle: "waiting_for_task",
        updatedAt: this.nowIso(),
        revision: participant.revision + 1,
      };
      await this.persist(replaceParticipant(state, updated));
      return copyState(updated);
    });
  }

  public async recordOutcome(input: AgentWorkOutcomeInput): Promise<AgentWorkState> {
    const collaborationSessionId = validateSessionId(input.collaborationSessionId, "collaborationSessionId");
    if (typeof input.changed !== "boolean") throw new Error("changed must be a boolean");
    const chatCursor = validateCursor(input.chatCursor);
    const taskBoardToken = validateTaskBoardToken(input.taskBoardToken);

    return this.enqueue(async () => {
      const state = await this.readReconciledState();
      const participant = requireParticipant(state, collaborationSessionId);
      if (participant.lifecycle === "released") return copyState(participant);
      const updated: AgentWorkState = {
        ...participant,
        lifecycle: input.changed ? "working" : "waiting_for_task",
        consecutiveTimeouts: input.changed ? 0 : Math.min(20, participant.consecutiveTimeouts + 1),
        lastChatCursor: chatCursor,
        taskBoardToken,
        updatedAt: this.nowIso(),
        revision: participant.revision + 1,
      };
      await this.persist(replaceParticipant(state, updated));
      return copyState(updated);
    });
  }

  public async disconnect(collaborationSessionId: string): Promise<AgentWorkState | undefined> {
    const normalizedId = validateSessionId(collaborationSessionId, "collaborationSessionId");
    return this.enqueue(async () => {
      const state = await this.readReconciledState();
      const participant = state.participants.find(
        (candidate) => candidate.collaborationSessionId === normalizedId,
      );
      if (!participant) return undefined;
      if (participant.lifecycle === "released" || participant.lifecycle === "offline") return copyState(participant);
      const updated: AgentWorkState = {
        ...participant,
        lifecycle: "offline",
        updatedAt: this.nowIso(),
        revision: participant.revision + 1,
      };
      await this.persist(replaceParticipant(state, updated));
      return copyState(updated);
    });
  }

  public async releaseByManager(input: AgentWorkManagerReleaseInput): Promise<AgentWorkState> {
    const managerCollaborationSessionId = validateSessionId(
      input.managerCollaborationSessionId,
      "managerCollaborationSessionId",
    );
    const targetCollaborationSessionId = validateSessionId(
      input.targetCollaborationSessionId,
      "targetCollaborationSessionId",
    );
    if (managerCollaborationSessionId === targetCollaborationSessionId) {
      throw new Error("A manager cannot permanently release its own collaboration session through this tool");
    }
    const expectedRevision = validateRevision(input.expectedRevision, "expectedRevision");
    const reason = validateRequiredText(input.reason, "reason", AGENT_WORK_RELEASE_REASON_MAX_BYTES);

    return this.enqueue(async () => {
      const state = await this.readReconciledState();
      const participant = requireParticipant(state, targetCollaborationSessionId);
      if (participant.revision !== expectedRevision) {
        throw new Error(`Stale work-state revision: expected ${expectedRevision}, current ${participant.revision}`);
      }
      if (participant.lifecycle === "released") return copyState(participant);
      if (participant.lifecycle !== "waiting_for_task" && participant.lifecycle !== "offline") {
        throw new Error("Target collaboration session must be waiting_for_task or offline before permanent release");
      }
      const updated: AgentWorkState = {
        ...participant,
        lifecycle: "released",
        releasedByCollaborationSessionId: managerCollaborationSessionId,
        releaseReason: reason,
        updatedAt: this.nowIso(),
        revision: participant.revision + 1,
      };
      await this.persist(replaceParticipant(state, updated));
      return copyState(updated);
    });
  }

  private nowIso(): string {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("now must return a valid Date");
    return value.toISOString();
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.sharedState.queue.then(() => this.withStateLock(operation));
    this.sharedState.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async withStateLock<T>(operation: () => Promise<T>): Promise<T> {
    await this.ensureDirectories();
    const token = `${process.pid}:${randomBytes(16).toString("hex")}`;
    const deadline = Date.now() + WORK_LOCK_TIMEOUT_MS;
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
        if (Date.now() >= deadline) throw new Error("Timed out waiting for the agent work-loop store lock");
        await delay(WORK_LOCK_RETRY_MS);
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
      const lock = await fs.promises.stat(this.lockPath);
      if (Date.now() - lock.mtimeMs <= WORK_STALE_LOCK_MS) return;
      const owner = (await fs.promises.readFile(this.lockPath, "utf8")).trim();
      const ownerPid = parseLockOwnerPid(owner);
      if (ownerPid === undefined || isProcessAlive(ownerPid)) return;
      const currentLock = await fs.promises.stat(this.lockPath);
      const currentOwner = (await fs.promises.readFile(this.lockPath, "utf8")).trim();
      if (currentOwner !== owner || currentLock.dev !== lock.dev || currentLock.ino !== lock.ino) return;
      await fs.promises.rm(this.lockPath);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
  }

  private async assertAuthoritativeSessionUsable(participant: AgentWorkParticipantInput): Promise<void> {
    if (!this.collaborationSessionStore) return;
    const session = (await this.collaborationSessionStore.listByActor(participant.agentId)).find(
      (candidate) => candidate.collaborationSessionId === participant.collaborationSessionId,
    );
    if (!session || session.status === "released" || session.status === "revoked") {
      throw new Error("Collaboration session is not active or resumable");
    }
  }

  private async readReconciledState(): Promise<StoredAgentWorkState> {
    const state = await this.readStateFile();
    if (!this.collaborationSessionStore || state.participants.length === 0) return state;

    const sessionsByActor = new Map<string, Awaited<ReturnType<CollaborationSessionStore["listByActor"]>>>();
    for (const agentId of new Set(state.participants.map((participant) => participant.agentId))) {
      sessionsByActor.set(agentId, await this.collaborationSessionStore.listByActor(agentId));
    }

    let changed = false;
    const now = this.nowIso();
    const participants = state.participants.map((participant) => {
      if (participant.lifecycle === "released" || participant.lifecycle === "offline") return participant;
      const session = sessionsByActor.get(participant.agentId)?.find(
        (candidate) => candidate.collaborationSessionId === participant.collaborationSessionId,
      );
      if (session && session.status !== "released" && session.status !== "revoked") return participant;
      changed = true;
      return {
        ...participant,
        lifecycle: "offline" as const,
        updatedAt: now,
        revision: participant.revision + 1,
      };
    });
    if (!changed) return state;
    const reconciled = withParticipants(state, participants);
    await this.persist(reconciled);
    return reconciled;
  }

  private async readStateFile(): Promise<StoredAgentWorkState> {
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
      throw new Error("Malformed agent work-loop state: invalid JSON");
    }
    return validateStoredState(parsed, this.projectKey);
  }

  private async persist(state: StoredAgentWorkState): Promise<void> {
    await this.ensureDirectories();
    const temporaryPath = path.join(
      this.projectDir,
      `.agent-work-loop-${process.pid}-${randomBytes(12).toString("hex")}.tmp`,
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
      throw new Error("Agent work-loop data must not be stored under the workspace");
    }
    await fs.promises.chmod(this.dataDir, 0o700);
    const projectsDir = path.join(this.dataDir, "projects");
    await fs.promises.mkdir(projectsDir, { recursive: true, mode: 0o700 });
    const canonicalProjectsDir = await fs.promises.realpath(projectsDir);
    if (!isWithin(canonicalDataDir, canonicalProjectsDir)) {
      throw new Error("Agent work-loop projects directory escapes the configured data directory");
    }
    await fs.promises.chmod(projectsDir, 0o700);
    await fs.promises.mkdir(this.projectDir, { recursive: true, mode: 0o700 });
    const canonicalProjectDir = await fs.promises.realpath(this.projectDir);
    if (!isWithin(canonicalProjectsDir, canonicalProjectDir)) {
      throw new Error("Agent work-loop project directory escapes the configured data directory");
    }
    await fs.promises.chmod(this.projectDir, 0o700);
  }
}

export function computeAgentWaitSeconds(
  consecutiveTimeouts: number,
  maximumSeconds: number = AGENT_WORK_DEFAULT_MAX_WAIT_SECONDS,
  random: () => number = Math.random,
): number {
  if (!Number.isSafeInteger(consecutiveTimeouts) || consecutiveTimeouts < 0) {
    throw new Error("consecutiveTimeouts must be a non-negative integer");
  }
  if (!Number.isSafeInteger(maximumSeconds) || maximumSeconds < 1 || maximumSeconds > AGENT_WORK_MAX_WAIT_SECONDS) {
    throw new Error(`maximumSeconds must be between 1 and ${AGENT_WORK_MAX_WAIT_SECONDS}`);
  }
  const randomValue = random();
  if (!Number.isFinite(randomValue) || randomValue < 0 || randomValue >= 1) {
    throw new Error("random must return a finite number in [0, 1)");
  }
  const cap = Math.min(maximumSeconds, 2 ** Math.min(consecutiveTimeouts, 10));
  const floor = Math.max(1, Math.ceil(cap / 2));
  return Math.min(maximumSeconds, floor + Math.floor(randomValue * (cap - floor + 1)));
}

export function makeAgentTaskBoardToken(serializedBoard: string): string {
  if (typeof serializedBoard !== "string") throw new Error("serializedBoard must be a string");
  return `wt_${createHash("sha256").update(serializedBoard, "utf8").digest("base64url")}`;
}

function emptyState(projectKey: string): StoredAgentWorkState {
  return { version: 1, projectKey, participants: [] };
}

function withParticipants(state: StoredAgentWorkState, participants: AgentWorkState[]): StoredAgentWorkState {
  return { ...state, participants };
}

function replaceParticipant(state: StoredAgentWorkState, participant: AgentWorkState): StoredAgentWorkState {
  return withParticipants(
    state,
    state.participants.map((candidate) =>
      candidate.collaborationSessionId === participant.collaborationSessionId ? participant : candidate),
  );
}

function requireParticipant(state: StoredAgentWorkState, collaborationSessionId: string): AgentWorkState {
  const participant = state.participants.find(
    (candidate) => candidate.collaborationSessionId === collaborationSessionId,
  );
  if (!participant) throw new Error("Unknown collaboration session work state");
  return participant;
}

function makeRoomForParticipant(participants: AgentWorkState[]): AgentWorkState[] {
  if (participants.length < AGENT_WORK_STATE_LIMIT) return participants;
  const removable = participants
    .filter((participant) => participant.lifecycle === "released" || participant.lifecycle === "offline")
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))[0];
  if (!removable) throw new Error(`Agent work-loop state limit of ${AGENT_WORK_STATE_LIMIT} active sessions reached`);
  return participants.filter(
    (participant) => participant.collaborationSessionId !== removable.collaborationSessionId,
  );
}

function validateStoredState(value: unknown, expectedProjectKey: string): StoredAgentWorkState {
  if (!isRecord(value)) throw new Error("Malformed or mismatched agent work-loop state");
  assertOnlyKeys(value, ["version", "projectKey", "participants"], "agent work-loop state");
  if (value.version !== 1 || value.projectKey !== expectedProjectKey || !Array.isArray(value.participants)) {
    throw new Error("Malformed or mismatched agent work-loop state");
  }
  if (value.participants.length > AGENT_WORK_STATE_LIMIT) {
    throw new Error("Malformed agent work-loop state: participant limit exceeded");
  }
  const seen = new Set<string>();
  const participants = value.participants.map((candidate) => {
    if (!isRecord(candidate)) throw new Error("Malformed agent work-loop participant");
    const participant = validateStoredParticipant(candidate);
    if (seen.has(participant.collaborationSessionId)) {
      throw new Error("Malformed agent work-loop state: duplicate collaboration session");
    }
    seen.add(participant.collaborationSessionId);
    return participant;
  });
  return { version: 1, projectKey: expectedProjectKey, participants };
}

function validateStoredParticipant(value: Record<string, unknown>): AgentWorkState {
  assertOnlyKeys(value, [
    "collaborationSessionId",
    "agentId",
    "agentName",
    "canonicalRoleId",
    "occupancyLabel",
    "lifecycle",
    "consecutiveTimeouts",
    "lastChatCursor",
    "taskBoardToken",
    "releasedByCollaborationSessionId",
    "releaseReason",
    "createdAt",
    "updatedAt",
    "revision",
  ], "agent work-loop participant");
  const participant = validateParticipant({
    collaborationSessionId: value.collaborationSessionId as string,
    agentId: value.agentId as string,
    agentName: value.agentName as string,
    canonicalRoleId: value.canonicalRoleId as string,
    occupancyLabel: value.occupancyLabel as string,
  });
  const lifecycle = validateLifecycle(value.lifecycle);
  const consecutiveTimeouts = validateNonNegativeInteger(value.consecutiveTimeouts, "consecutiveTimeouts", 20);
  const lastChatCursor = value.lastChatCursor === undefined ? undefined : validateCursor(value.lastChatCursor);
  const taskBoardToken = value.taskBoardToken === undefined
    ? undefined
    : validateTaskBoardToken(value.taskBoardToken);
  const releasedByCollaborationSessionId = value.releasedByCollaborationSessionId === undefined
    ? undefined
    : validateSessionId(value.releasedByCollaborationSessionId, "releasedByCollaborationSessionId");
  const releaseReason = value.releaseReason === undefined
    ? undefined
    : validateRequiredText(value.releaseReason, "releaseReason", AGENT_WORK_RELEASE_REASON_MAX_BYTES);
  const state: AgentWorkState = {
    ...participant,
    lifecycle,
    consecutiveTimeouts,
    lastChatCursor,
    taskBoardToken,
    releasedByCollaborationSessionId,
    releaseReason,
    createdAt: validateDate(value.createdAt, "createdAt"),
    updatedAt: validateDate(value.updatedAt, "updatedAt"),
    revision: validateRevision(value.revision, "revision"),
  };
  if (lifecycle === "released") {
    if (!releasedByCollaborationSessionId || !releaseReason) {
      throw new Error("Malformed released agent work state: missing manager provenance");
    }
  } else if (releasedByCollaborationSessionId !== undefined || releaseReason !== undefined) {
    throw new Error("Malformed non-released agent work state: unexpected release provenance");
  }
  return state;
}

function validateParticipant(input: AgentWorkParticipantInput): AgentWorkParticipantInput {
  const canonicalRoleId = validateRoleId(input.canonicalRoleId, "canonicalRoleId");
  const occupancyLabel = validateRoleId(input.occupancyLabel, "occupancyLabel");
  return {
    collaborationSessionId: validateSessionId(input.collaborationSessionId, "collaborationSessionId"),
    agentId: validateRequiredText(input.agentId, "agentId", 256),
    agentName: validateRequiredText(input.agentName, "agentName", 100),
    canonicalRoleId,
    occupancyLabel,
  };
}

function requireSameParticipant(existing: AgentWorkState, input: AgentWorkParticipantInput): void {
  if (existing.agentId !== input.agentId ||
      existing.agentName !== input.agentName ||
      existing.canonicalRoleId !== input.canonicalRoleId ||
      existing.occupancyLabel !== input.occupancyLabel) {
    throw new Error("Collaboration session work-state binding mismatch");
  }
}

function validateLifecycles(values: AgentWorkLifecycle[] | undefined): Set<AgentWorkLifecycle> | undefined {
  if (values === undefined) return undefined;
  if (!Array.isArray(values) || values.length < 1 || values.length > AGENT_WORK_LIFECYCLES.length) {
    throw new Error("lifecycles must be a non-empty array of known lifecycle values");
  }
  return new Set(values.map(validateLifecycle));
}

function validateLifecycle(value: unknown): AgentWorkLifecycle {
  if (typeof value !== "string" || !AGENT_WORK_LIFECYCLES.includes(value as AgentWorkLifecycle)) {
    throw new Error("Invalid agent work lifecycle");
  }
  return value as AgentWorkLifecycle;
}

function validateSessionId(value: unknown, field: string): string {
  if (typeof value !== "string" || !COLLABORATION_SESSION_ID_PATTERN.test(value)) {
    throw new Error(`${field} must be a valid collaboration session ID`);
  }
  return value;
}

function validateRoleId(value: unknown, field: string): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 128 || !ROLE_ID_PATTERN.test(value)) {
    throw new Error(`${field} must be a bounded lowercase role identifier`);
  }
  return value;
}

function validateTaskBoardToken(value: unknown): string {
  if (typeof value !== "string" || !AGENT_WORK_TASK_BOARD_TOKEN_PATTERN.test(value)) {
    throw new Error("taskBoardToken must be an opaque token returned by agent_work_wait");
  }
  return value;
}

function validateCursor(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error("chatCursor must be a non-negative safe integer");
  }
  return value as number;
}

function validateRevision(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${field} must be a positive integer`);
  return value as number;
}

function validateNonNegativeInteger(value: unknown, field: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new Error(`${field} must be an integer between 0 and ${maximum}`);
  }
  return value as number;
}

function validateRequiredText(value: unknown, field: string, maximumBytes: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} must be non-empty`);
  if (Buffer.byteLength(normalized, "utf8") > maximumBytes) {
    throw new Error(`${field} exceeds ${maximumBytes} UTF-8 bytes`);
  }
  return normalized;
}

function validateDate(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${field} must be an ISO date`);
  return value;
}

function copyState(state: AgentWorkState): AgentWorkState {
  return { ...state };
}

function parseLockOwnerPid(value: string): number | undefined {
  const [rawPid] = value.split(":", 1);
  const pid = Number(rawPid);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error, "EPERM");
  }
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unexpected) throw new Error(`Malformed ${label}: unexpected field '${unexpected}'`);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.promises.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
