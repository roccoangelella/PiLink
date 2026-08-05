import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const AGENT_ACTIVITY_EVENT_KINDS = [
  "claim",
  "progress",
  "finding",
  "blocker",
  "question",
  "decision",
  "handoff",
  "verification",
  "commit",
  "completion",
  "note",
  "system",
] as const;

export const AGENT_ACTIVITY_IMPORTANCE = ["routine", "important", "requires_user"] as const;
export const AGENT_ACTIVITY_SOURCES = ["agent", "server"] as const;

export const AGENT_ACTIVITY_DEFAULT_PAGE_SIZE = 50;
export const AGENT_ACTIVITY_MAX_PAGE_SIZE = 200;
export const AGENT_ACTIVITY_SUMMARY_MAX_BYTES = 512;
export const AGENT_ACTIVITY_DETAILS_MAX_BYTES = 8 * 1024;
export const AGENT_ACTIVITY_MAX_PATHS = 50;
export const AGENT_ACTIVITY_MAX_ARTIFACTS = 20;
export const AGENT_ACTIVITY_DEFAULT_MAX_EVENTS = 100_000;
export const AGENT_ACTIVITY_DEFAULT_MAX_STATE_BYTES = 64 * 1024 * 1024;

const AGENT_ACTIVITY_LOCK_TIMEOUT_MS = 5_000;
const AGENT_ACTIVITY_STALE_LOCK_MS = 30_000;
const AGENT_ACTIVITY_LOCK_RETRY_MS = 25;

export type AgentActivityEventKind = typeof AGENT_ACTIVITY_EVENT_KINDS[number];
export type AgentActivityImportance = typeof AGENT_ACTIVITY_IMPORTANCE[number];
export type AgentActivitySource = typeof AGENT_ACTIVITY_SOURCES[number];

export interface AgentActivityActor {
  agentId: string;
  agentName: string;
  agentInstanceId?: string;
  collaborationSessionId?: string;
}

export interface AgentActivityArtifactRef {
  uri: string;
  name?: string;
  mediaType?: string;
}

export interface AgentActivityAppendContext {
  source: AgentActivitySource;
  actor: AgentActivityActor;
  idempotencyKey?: string;
}

export interface AgentActivityAppendInput {
  kind: AgentActivityEventKind;
  importance?: AgentActivityImportance;
  summary: string;
  details?: string;
  taskId?: string;
  contextId?: string;
  correlationId?: string;
  causationEventId?: string;
  paths?: string[];
  artifactRefs?: AgentActivityArtifactRef[];
}

export interface AgentActivityEvent {
  version: 1;
  cursor: number;
  eventId: string;
  recordedAt: string;
  source: AgentActivitySource;
  actor: AgentActivityActor;
  kind: AgentActivityEventKind;
  importance: AgentActivityImportance;
  summary: string;
  details?: string;
  taskId?: string;
  contextId?: string;
  correlationId?: string;
  causationEventId?: string;
  idempotencyKey?: string;
  paths?: string[];
  artifactRefs?: AgentActivityArtifactRef[];
}

export interface AgentActivityListOptions {
  cursor?: string;
  limit?: number;
  taskId?: string;
  contextId?: string;
  correlationId?: string;
  kinds?: AgentActivityEventKind[];
  agentId?: string;
  importance?: AgentActivityImportance[];
  since?: string;
}

export interface AgentActivityPage {
  events: AgentActivityEvent[];
  nextCursor: string;
  hasMore: boolean;
}

export interface AgentActivityStoreOptions {
  workspace: string;
  dataDir?: string;
  now?: () => Date;
  lockTimeoutMs?: number;
  staleLockMs?: number;
  lockRetryMs?: number;
  maximumEvents?: number;
  maximumStateBytes?: number;
}

interface NormalizedActivityInput {
  source: AgentActivitySource;
  actor: AgentActivityActor;
  kind: AgentActivityEventKind;
  importance: AgentActivityImportance;
  summary: string;
  details?: string;
  taskId?: string;
  contextId?: string;
  correlationId?: string;
  causationEventId?: string;
  idempotencyKey?: string;
  paths?: string[];
  artifactRefs?: AgentActivityArtifactRef[];
  recordedAt: string;
}

interface StoredAgentActivityState {
  version: 1;
  projectKey: string;
  nextCursor: number;
  events: AgentActivityEvent[];
}

interface ActivityCursorPayload {
  version: 1;
  projectKey: string;
  after: number;
}

interface ActivityLockOwner {
  version: 1;
  pid: number;
  token: string;
}

const mutationQueues = new Map<string, Promise<void>>();

const appendContextKeys = new Set(["source", "actor", "idempotencyKey"]);

const appendInputKeys = new Set([
  "kind",
  "importance",
  "summary",
  "details",
  "taskId",
  "contextId",
  "correlationId",
  "causationEventId",
  "paths",
  "artifactRefs",
]);

const actorKeys = new Set(["agentId", "agentName", "agentInstanceId", "collaborationSessionId"]);
const artifactKeys = new Set(["uri", "name", "mediaType"]);
const eventKeys = new Set([
  "version",
  "cursor",
  "eventId",
  "recordedAt",
  "source",
  "actor",
  "kind",
  "importance",
  "summary",
  "details",
  "taskId",
  "contextId",
  "correlationId",
  "causationEventId",
  "idempotencyKey",
  "paths",
  "artifactRefs",
]);

/**
 * Durable project-scoped activity ledger core.
 *
 * Events are immutable once appended. The default backend persists one private,
 * atomically replaced state file, while the public API remains independent of
 * that representation so a transactional or segmented backend can replace it.
 */
export class AgentActivityStore {
  public readonly workspace: string;
  public readonly projectKey: string;
  public readonly statePath: string;

  private readonly dataDir: string;
  private readonly projectDir: string;
  private readonly lockPath: string;
  private readonly now: () => Date;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;
  private readonly lockRetryMs: number;
  private readonly maximumEvents: number;
  private readonly maximumStateBytes: number;

  public constructor(options: AgentActivityStoreOptions) {
    const selectedDataDir = options.dataDir || process.env.PI_DATA_DIR;
    if (!selectedDataDir) throw new Error("AgentActivityStore requires dataDir or PI_DATA_DIR");

    this.workspace = fs.realpathSync(options.workspace);
    this.dataDir = path.resolve(selectedDataDir);
    if (isWithin(this.workspace, this.dataDir)) {
      throw new Error("Agent activity data must not be stored under the workspace");
    }

    this.now = options.now || (() => new Date());
    this.lockTimeoutMs = validatePositiveInteger(
      options.lockTimeoutMs ?? AGENT_ACTIVITY_LOCK_TIMEOUT_MS,
      "lockTimeoutMs",
    );
    this.staleLockMs = validatePositiveInteger(
      options.staleLockMs ?? AGENT_ACTIVITY_STALE_LOCK_MS,
      "staleLockMs",
    );
    this.lockRetryMs = validatePositiveInteger(
      options.lockRetryMs ?? AGENT_ACTIVITY_LOCK_RETRY_MS,
      "lockRetryMs",
    );
    this.maximumEvents = validatePositiveInteger(
      options.maximumEvents ?? AGENT_ACTIVITY_DEFAULT_MAX_EVENTS,
      "maximumEvents",
    );
    this.maximumStateBytes = validatePositiveInteger(
      options.maximumStateBytes ?? AGENT_ACTIVITY_DEFAULT_MAX_STATE_BYTES,
      "maximumStateBytes",
    );
    this.projectKey = createHash("sha256").update(this.workspace).digest("hex");
    this.projectDir = path.join(this.dataDir, "projects", this.projectKey);
    this.statePath = path.join(this.projectDir, "agent-activity.json");
    this.lockPath = `${this.statePath}.lock`;
  }

  public async append(
    context: AgentActivityAppendContext,
    input: AgentActivityAppendInput,
  ): Promise<AgentActivityEvent> {
    const normalized = normalizeAppendInput(context, input, nowIso(this.now));
    return this.enqueueMutation(async () => {
      const state = await this.readStateFile();

      if (normalized.idempotencyKey !== undefined) {
        const existing = state.events.find((event) => event.idempotencyKey === normalized.idempotencyKey);
        if (existing) {
          if (!hasSameSemanticPayload(existing, normalized)) {
            throw new Error("Agent activity idempotency key conflicts with an existing event");
          }
          return copyEvent(existing);
        }
      }

      if (normalized.causationEventId !== undefined &&
          !state.events.some((event) => event.eventId === normalized.causationEventId)) {
        throw new Error("causationEventId must reference an existing earlier activity event");
      }

      if (state.events.length >= this.maximumEvents) {
        throw new Error(`Agent activity event limit of ${this.maximumEvents} reached`);
      }
      if (!Number.isSafeInteger(state.nextCursor) || state.nextCursor < 1 || state.nextCursor === Number.MAX_SAFE_INTEGER) {
        throw new Error("Agent activity cursor space is exhausted");
      }

      const cursor = state.nextCursor;
      const event: AgentActivityEvent = {
        version: 1,
        cursor,
        eventId: createEventId(cursor),
        recordedAt: normalized.recordedAt,
        source: normalized.source,
        actor: copyActor(normalized.actor),
        kind: normalized.kind,
        importance: normalized.importance,
        summary: normalized.summary,
      };
      if (normalized.details !== undefined) event.details = normalized.details;
      if (normalized.taskId !== undefined) event.taskId = normalized.taskId;
      if (normalized.contextId !== undefined) event.contextId = normalized.contextId;
      if (normalized.correlationId !== undefined) event.correlationId = normalized.correlationId;
      if (normalized.causationEventId !== undefined) event.causationEventId = normalized.causationEventId;
      if (normalized.idempotencyKey !== undefined) event.idempotencyKey = normalized.idempotencyKey;
      if (normalized.paths !== undefined) event.paths = [...normalized.paths];
      if (normalized.artifactRefs !== undefined) event.artifactRefs = normalized.artifactRefs.map(copyArtifact);

      const next: StoredAgentActivityState = {
        version: 1,
        projectKey: this.projectKey,
        nextCursor: cursor + 1,
        events: [...state.events, event],
      };
      await this.persistState(next);
      return copyEvent(event);
    });
  }

  public async list(options: AgentActivityListOptions = {}): Promise<AgentActivityPage> {
    await (mutationQueues.get(this.statePath) || Promise.resolve());
    const state = await this.readStateFile();
    const filters = normalizeListOptions(options, this.projectKey);

    const events: AgentActivityEvent[] = [];
    let scannedCursor = filters.after;
    let hasMore = false;

    for (let index = 0; index < state.events.length; index += 1) {
      const event = state.events[index];
      if (event.cursor <= filters.after) continue;
      scannedCursor = event.cursor;
      if (!matchesFilters(event, filters)) continue;
      events.push(copyEvent(event));
      if (events.length === filters.limit) {
        hasMore = state.events.slice(index + 1).some((candidate) => matchesFilters(candidate, filters));
        break;
      }
    }

    return {
      events,
      nextCursor: encodeCursor(this.projectKey, scannedCursor),
      hasMore,
    };
  }

  private enqueueMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const previous = mutationQueues.get(this.statePath) || Promise.resolve();
    const operation = previous.then(() => this.withStateLock(mutation));
    mutationQueues.set(this.statePath, operation.then(() => undefined, () => undefined));
    return operation;
  }

  private async withStateLock<T>(operation: () => Promise<T>): Promise<T> {
    await this.ensureDirectories();
    const owner: ActivityLockOwner = {
      version: 1,
      pid: process.pid,
      token: randomBytes(16).toString("hex"),
    };
    const serializedOwner = `${JSON.stringify(owner)}\n`;
    const deadline = Date.now() + this.lockTimeoutMs;

    while (true) {
      try {
        const handle = await fs.promises.open(this.lockPath, "wx", 0o600);
        let initializationError: unknown;
        try {
          await handle.writeFile(serializedOwner, "utf8");
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
        if (Date.now() >= deadline) throw new Error("Timed out waiting for the agent activity store lock");
        await delay(this.lockRetryMs);
      }
    }

    try {
      return await operation();
    } finally {
      try {
        const currentOwner = await fs.promises.readFile(this.lockPath, "utf8");
        if (currentOwner === serializedOwner) await fs.promises.rm(this.lockPath, { force: true });
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) throw error;
      }
    }
  }

  private async removeStaleLock(): Promise<void> {
    let initialStat: fs.Stats;
    let initialSerialized: string;
    try {
      initialStat = await fs.promises.stat(this.lockPath);
      if (Date.now() - initialStat.mtimeMs <= this.staleLockMs) return;
      initialSerialized = await fs.promises.readFile(this.lockPath, "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return;
      throw error;
    }

    const owner = parseLockOwner(initialSerialized);
    if (!owner || isProcessAlive(owner.pid)) return;

    try {
      const currentStat = await fs.promises.stat(this.lockPath);
      const currentSerialized = await fs.promises.readFile(this.lockPath, "utf8");
      if (currentStat.mtimeMs !== initialStat.mtimeMs || currentSerialized !== initialSerialized) return;
      await fs.promises.rm(this.lockPath, { force: true });
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
  }

  private async readStateFile(): Promise<StoredAgentActivityState> {
    await this.ensureDirectories();
    let serialized: string;
    try {
      serialized = await fs.promises.readFile(this.statePath, "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return emptyState(this.projectKey);
      throw error;
    }

    if (Buffer.byteLength(serialized, "utf8") > this.maximumStateBytes) {
      throw new Error(`Agent activity state exceeds ${this.maximumStateBytes} UTF-8 bytes`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized);
    } catch {
      throw new Error("Malformed agent activity state: invalid JSON");
    }
    return validateStoredState(parsed, this.projectKey);
  }

  private async persistState(state: StoredAgentActivityState): Promise<void> {
    await this.ensureDirectories();
    const serialized = `${JSON.stringify(state)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > this.maximumStateBytes) {
      throw new Error(`Agent activity state exceeds ${this.maximumStateBytes} UTF-8 bytes`);
    }
    const temporaryPath = path.join(
      this.projectDir,
      `.agent-activity-${process.pid}-${randomBytes(12).toString("hex")}.tmp`,
    );
    try {
      const file = await fs.promises.open(temporaryPath, "wx", 0o600);
      try {
        await file.writeFile(serialized, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await fs.promises.rename(temporaryPath, this.statePath);
      await fs.promises.chmod(this.statePath, 0o600);
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
      throw new Error("Agent activity data must not be stored under the workspace");
    }
    await fs.promises.chmod(canonicalDataDir, 0o700);

    const projectsDir = path.join(canonicalDataDir, "projects");
    await fs.promises.mkdir(projectsDir, { recursive: true, mode: 0o700 });
    const canonicalProjectsDir = await fs.promises.realpath(projectsDir);
    if (!isWithin(canonicalDataDir, canonicalProjectsDir)) {
      throw new Error("Agent activity projects directory escapes the configured data directory");
    }
    await fs.promises.chmod(canonicalProjectsDir, 0o700);

    await fs.promises.mkdir(this.projectDir, { recursive: true, mode: 0o700 });
    const canonicalProjectDir = await fs.promises.realpath(this.projectDir);
    if (!isWithin(canonicalProjectsDir, canonicalProjectDir)) {
      throw new Error("Agent activity project directory escapes the configured data directory");
    }
    await fs.promises.chmod(canonicalProjectDir, 0o700);
  }
}

interface NormalizedListOptions {
  after: number;
  limit: number;
  taskId?: string;
  contextId?: string;
  correlationId?: string;
  kinds?: Set<AgentActivityEventKind>;
  agentId?: string;
  importance?: Set<AgentActivityImportance>;
  since?: string;
}

function normalizeAppendInput(
  context: AgentActivityAppendContext,
  input: AgentActivityAppendInput,
  recordedAt: string,
): NormalizedActivityInput {
  if (!isRecord(context)) throw new Error("Agent activity append context must be an object");
  assertOnlyKeys(context, appendContextKeys, "Agent activity append context");
  if (!isRecord(input)) throw new Error("Agent activity input must be an object");
  assertOnlyKeys(input, appendInputKeys, "Agent activity input");

  const source = validateSource(context.source);
  const actor = validateActor(context.actor);
  const idempotencyKey = validateOptionalIdentifier(context.idempotencyKey, "idempotencyKey");
  if (source === "server" && idempotencyKey === undefined) {
    throw new Error("Server-derived activity events require idempotencyKey");
  }
  const kind = validateKind(input.kind);
  const importance = input.importance === undefined ? "routine" : validateImportance(input.importance);
  const summary = validateContentText(input.summary, "summary", AGENT_ACTIVITY_SUMMARY_MAX_BYTES);
  const details = validateOptionalContentText(input.details, "details", AGENT_ACTIVITY_DETAILS_MAX_BYTES);
  const taskId = validateOptionalIdentifier(input.taskId, "taskId");
  const contextId = validateOptionalIdentifier(input.contextId, "contextId");
  const correlationId = validateOptionalIdentifier(input.correlationId, "correlationId");
  const causationEventId = input.causationEventId === undefined
    ? undefined
    : validateEventId(input.causationEventId, "causationEventId");
  const paths = validatePaths(input.paths);
  const artifactRefs = validateArtifacts(input.artifactRefs);

  return {
    source,
    actor,
    kind,
    importance,
    summary,
    details,
    taskId,
    contextId,
    correlationId,
    causationEventId,
    idempotencyKey,
    paths,
    artifactRefs,
    recordedAt: validateTimestamp(recordedAt, "recordedAt"),
  };
}

function normalizeListOptions(options: AgentActivityListOptions, projectKey: string): NormalizedListOptions {
  if (!isRecord(options)) throw new Error("Agent activity list options must be an object");
  const allowed = new Set([
    "cursor",
    "limit",
    "taskId",
    "contextId",
    "correlationId",
    "kinds",
    "agentId",
    "importance",
    "since",
  ]);
  assertOnlyKeys(options, allowed, "Agent activity list options");

  const limit = options.limit ?? AGENT_ACTIVITY_DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > AGENT_ACTIVITY_MAX_PAGE_SIZE) {
    throw new Error(`limit must be an integer between 1 and ${AGENT_ACTIVITY_MAX_PAGE_SIZE}`);
  }

  const result: NormalizedListOptions = {
    after: options.cursor === undefined ? 0 : decodeCursor(options.cursor, projectKey),
    limit,
  };
  if (options.taskId !== undefined) result.taskId = validateIdentifier(options.taskId, "taskId");
  if (options.contextId !== undefined) result.contextId = validateIdentifier(options.contextId, "contextId");
  if (options.correlationId !== undefined) {
    result.correlationId = validateIdentifier(options.correlationId, "correlationId");
  }
  if (options.agentId !== undefined) result.agentId = validateIdentifier(options.agentId, "agentId");
  if (options.since !== undefined) result.since = validateTimestamp(options.since, "since");
  if (options.kinds !== undefined) {
    if (!Array.isArray(options.kinds) || options.kinds.length === 0) {
      throw new Error("kinds must be a non-empty array");
    }
    result.kinds = new Set(options.kinds.map(validateKind));
  }
  if (options.importance !== undefined) {
    if (!Array.isArray(options.importance) || options.importance.length === 0) {
      throw new Error("importance must be a non-empty array");
    }
    result.importance = new Set(options.importance.map(validateImportance));
  }
  return result;
}

function validateStoredState(value: unknown, expectedProjectKey: string): StoredAgentActivityState {
  if (!isRecord(value) || value.version !== 1 || value.projectKey !== expectedProjectKey || !Array.isArray(value.events)) {
    throw new Error("Malformed or mismatched agent activity state");
  }
  if (!Number.isSafeInteger(value.nextCursor) || value.nextCursor < 1) {
    throw new Error("Malformed agent activity state: invalid cursor counter");
  }

  const events: AgentActivityEvent[] = [];
  const eventIds = new Set<string>();
  const idempotencyKeys = new Set<string>();
  let previousEventId: string | undefined;

  for (let index = 0; index < value.events.length; index += 1) {
    const event = validateStoredEvent(value.events[index]);
    const expectedCursor = index + 1;
    if (event.cursor !== expectedCursor) {
      throw new Error("Malformed agent activity state: non-contiguous cursors");
    }
    if (!eventIdMatchesCursor(event.eventId, event.cursor)) {
      throw new Error("Malformed agent activity state: event ID does not match cursor");
    }
    if (previousEventId !== undefined && event.eventId <= previousEventId) {
      throw new Error("Malformed agent activity state: event IDs are not monotonically ordered");
    }
    if (eventIds.has(event.eventId)) throw new Error("Malformed agent activity state: duplicate event ID");
    if (event.causationEventId !== undefined && !eventIds.has(event.causationEventId)) {
      throw new Error("Malformed agent activity state: causation must reference an earlier event");
    }
    if (event.idempotencyKey !== undefined) {
      if (idempotencyKeys.has(event.idempotencyKey)) {
        throw new Error("Malformed agent activity state: duplicate idempotency key");
      }
      idempotencyKeys.add(event.idempotencyKey);
    }
    eventIds.add(event.eventId);
    previousEventId = event.eventId;
    events.push(event);
  }

  if (value.nextCursor !== events.length + 1) {
    throw new Error("Malformed agent activity state: invalid cursor counter");
  }
  return { version: 1, projectKey: expectedProjectKey, nextCursor: value.nextCursor, events };
}

function validateStoredEvent(value: unknown): AgentActivityEvent {
  if (!isRecord(value)) throw new Error("Malformed agent activity state: invalid event");
  assertOnlyKeys(value, eventKeys, "Stored agent activity event");
  if (value.version !== 1) throw new Error("Malformed agent activity state: invalid event version");
  if (!Number.isSafeInteger(value.cursor) || value.cursor < 1) {
    throw new Error("Malformed agent activity state: invalid event cursor");
  }

  const normalized = normalizeAppendInput({
    source: value.source as AgentActivitySource,
    actor: value.actor as AgentActivityActor,
    idempotencyKey: value.idempotencyKey as string | undefined,
  }, {
    kind: value.kind as AgentActivityEventKind,
    importance: value.importance as AgentActivityImportance,
    summary: value.summary as string,
    details: value.details as string | undefined,
    taskId: value.taskId as string | undefined,
    contextId: value.contextId as string | undefined,
    correlationId: value.correlationId as string | undefined,
    causationEventId: value.causationEventId as string | undefined,
    paths: value.paths as string[] | undefined,
    artifactRefs: value.artifactRefs as AgentActivityArtifactRef[] | undefined,
  }, value.recordedAt as string);

  const event: AgentActivityEvent = {
    version: 1,
    cursor: value.cursor,
    eventId: validateEventId(value.eventId, "eventId"),
    recordedAt: normalized.recordedAt,
    source: normalized.source,
    actor: normalized.actor,
    kind: normalized.kind,
    importance: normalized.importance,
    summary: normalized.summary,
  };
  if (normalized.details !== undefined) event.details = normalized.details;
  if (normalized.taskId !== undefined) event.taskId = normalized.taskId;
  if (normalized.contextId !== undefined) event.contextId = normalized.contextId;
  if (normalized.correlationId !== undefined) event.correlationId = normalized.correlationId;
  if (normalized.causationEventId !== undefined) event.causationEventId = normalized.causationEventId;
  if (normalized.idempotencyKey !== undefined) event.idempotencyKey = normalized.idempotencyKey;
  if (normalized.paths !== undefined) event.paths = normalized.paths;
  if (normalized.artifactRefs !== undefined) event.artifactRefs = normalized.artifactRefs;
  return event;
}

function validateActor(value: unknown): AgentActivityActor {
  if (!isRecord(value)) throw new Error("actor must be an object");
  assertOnlyKeys(value, actorKeys, "actor");
  const actor: AgentActivityActor = {
    agentId: validateIdentifier(value.agentId, "actor.agentId"),
    agentName: validateText(value.agentName, "actor.agentName", 100),
  };
  if (value.agentInstanceId !== undefined) {
    actor.agentInstanceId = validateIdentifier(value.agentInstanceId, "actor.agentInstanceId");
  }
  if (value.collaborationSessionId !== undefined) {
    actor.collaborationSessionId = validateIdentifier(
      value.collaborationSessionId,
      "actor.collaborationSessionId",
    );
  }
  return actor;
}

function validateArtifacts(value: unknown): AgentActivityArtifactRef[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > AGENT_ACTIVITY_MAX_ARTIFACTS) {
    throw new Error(`artifactRefs must contain between 1 and ${AGENT_ACTIVITY_MAX_ARTIFACTS} entries`);
  }
  const seen = new Set<string>();
  return value.map((candidate, index) => {
    if (!isRecord(candidate)) throw new Error(`artifactRefs[${index}] must be an object`);
    assertOnlyKeys(candidate, artifactKeys, `artifactRefs[${index}]`);
    const artifact: AgentActivityArtifactRef = {
      uri: validateArtifactUri(candidate.uri, `artifactRefs[${index}].uri`),
    };
    if (seen.has(artifact.uri)) throw new Error("artifactRefs must not contain duplicate URIs");
    seen.add(artifact.uri);
    if (candidate.name !== undefined) {
      artifact.name = validateContentText(candidate.name, `artifactRefs[${index}].name`, 256);
    }
    if (candidate.mediaType !== undefined) {
      artifact.mediaType = validateMediaType(candidate.mediaType, `artifactRefs[${index}].mediaType`);
    }
    return artifact;
  });
}

function validatePaths(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > AGENT_ACTIVITY_MAX_PATHS) {
    throw new Error(`paths must contain between 1 and ${AGENT_ACTIVITY_MAX_PATHS} entries`);
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const candidate = validateText(value[index], `paths[${index}]`, 1024).replaceAll("\\", "/");
    if (candidate.startsWith("/") || /^[A-Za-z]:\//.test(candidate)) {
      throw new Error(`paths[${index}] must be workspace-relative`);
    }
    const segments = candidate.split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      throw new Error(`paths[${index}] contains an unsafe path segment`);
    }
    if (/[ -]/.test(candidate)) {
      throw new Error(`paths[${index}] contains control characters`);
    }
    if (seen.has(candidate)) throw new Error("paths must not contain duplicates");
    seen.add(candidate);
    normalized.push(candidate);
  }
  return normalized;
}

function validateArtifactUri(value: unknown, field: string): string {
  const uri = validateText(value, field, 2048);
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(uri)) {
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      throw new Error(`${field} must be a valid URI`);
    }
    if (!["pilink:", "urn:"].includes(parsed.protocol)) {
      throw new Error(`${field} uses an unsupported URI scheme`);
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error(`${field} must not contain credentials, query parameters, or fragments`);
    }
    rejectSensitiveContent(uri, field);
    return uri;
  }
  rejectSensitiveContent(uri, field);
  return validatePaths([uri])![0];
}

function validateMediaType(value: unknown, field: string): string {
  const mediaType = validateText(value, field, 128);
  if (!/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(mediaType)) {
    throw new Error(`${field} must be a valid media type`);
  }
  return mediaType.toLowerCase();
}

function validateSource(value: unknown): AgentActivitySource {
  if (typeof value !== "string" || !AGENT_ACTIVITY_SOURCES.includes(value as AgentActivitySource)) {
    throw new Error("source must be agent or server");
  }
  return value as AgentActivitySource;
}

function validateKind(value: unknown): AgentActivityEventKind {
  if (typeof value !== "string" || !AGENT_ACTIVITY_EVENT_KINDS.includes(value as AgentActivityEventKind)) {
    throw new Error("Invalid agent activity event kind");
  }
  return value as AgentActivityEventKind;
}

function validateImportance(value: unknown): AgentActivityImportance {
  if (typeof value !== "string" || !AGENT_ACTIVITY_IMPORTANCE.includes(value as AgentActivityImportance)) {
    throw new Error("Invalid agent activity importance");
  }
  return value as AgentActivityImportance;
}

function validateOptionalIdentifier(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : validateIdentifier(value, field);
}

function validateIdentifier(value: unknown, field: string): string {
  const identifier = validateText(value, field, 256);
  if (/[ -]/.test(identifier)) throw new Error(`${field} contains control characters`);
  return identifier;
}

function validateEventId(value: unknown, field: string): string {
  const eventId = validateIdentifier(value, field);
  if (!/^evt_[0-9a-z]{12}_[0-9a-f]{16}$/.test(eventId)) {
    throw new Error(`${field} must be a valid activity event ID`);
  }
  return eventId;
}

function validateText(value: unknown, field: string, maximumBytes: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${field} must be non-empty`);
  if (Buffer.byteLength(trimmed, "utf8") > maximumBytes) {
    throw new Error(`${field} exceeds ${maximumBytes} UTF-8 bytes`);
  }
  return trimmed;
}

function validateContentText(value: unknown, field: string, maximumBytes: number): string {
  const text = validateText(value, field, maximumBytes);
  rejectSensitiveContent(text, field);
  return text;
}

function validateOptionalContentText(value: unknown, field: string, maximumBytes: number): string | undefined {
  return value === undefined ? undefined : validateContentText(value, field, maximumBytes);
}

function rejectSensitiveContent(value: string, field: string): void {
  const secretPatterns = [
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i,
    /\bauthorization\s*:\s*bearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
    /\bbearer\s+[A-Za-z0-9._~+/=-]{20,}/i,
    /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|private[_-]?key)\s*[:=]\s*["']?[^\s"',}]{4,}/i,
  ];
  if (secretPatterns.some((pattern) => pattern.test(value))) {
    throw new Error(`${field} appears to contain secret material`);
  }

  const rawPayloadPatterns = [
    /<(?:tool_call|tool_result|function_call)\b/i,
    /"(?:arguments|tool_input|tool_result|stdout|stderr|environment|env)"\s*:/i,
  ];
  if (rawPayloadPatterns.some((pattern) => pattern.test(value))) {
    throw new Error(`${field} appears to contain a raw tool payload`);
  }
}

function validateTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${field} must be an ISO-8601 timestamp`);
  }
  return new Date(value).toISOString();
}

function validatePositiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value as number;
}

function nowIso(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("now must return a valid Date");
  return value.toISOString();
}

function createEventId(cursor: number): string {
  return `evt_${cursor.toString(36).padStart(12, "0")}_${randomBytes(8).toString("hex")}`;
}

function eventIdMatchesCursor(eventId: string, cursor: number): boolean {
  return eventId.slice(4, 16) === cursor.toString(36).padStart(12, "0");
}

function hasSameSemanticPayload(event: AgentActivityEvent, input: NormalizedActivityInput): boolean {
  return JSON.stringify(semanticPayloadFromEvent(event)) === JSON.stringify(semanticPayloadFromInput(input));
}

function semanticPayloadFromEvent(event: AgentActivityEvent): Record<string, unknown> {
  return {
    source: event.source,
    actor: event.actor,
    kind: event.kind,
    importance: event.importance,
    summary: event.summary,
    details: event.details,
    taskId: event.taskId,
    contextId: event.contextId,
    correlationId: event.correlationId,
    causationEventId: event.causationEventId,
    paths: event.paths,
    artifactRefs: event.artifactRefs,
  };
}

function semanticPayloadFromInput(input: NormalizedActivityInput): Record<string, unknown> {
  return {
    source: input.source,
    actor: input.actor,
    kind: input.kind,
    importance: input.importance,
    summary: input.summary,
    details: input.details,
    taskId: input.taskId,
    contextId: input.contextId,
    correlationId: input.correlationId,
    causationEventId: input.causationEventId,
    paths: input.paths,
    artifactRefs: input.artifactRefs,
  };
}

function matchesFilters(event: AgentActivityEvent, filters: NormalizedListOptions): boolean {
  if (filters.taskId !== undefined && event.taskId !== filters.taskId) return false;
  if (filters.contextId !== undefined && event.contextId !== filters.contextId) return false;
  if (filters.correlationId !== undefined && event.correlationId !== filters.correlationId) return false;
  if (filters.kinds !== undefined && !filters.kinds.has(event.kind)) return false;
  if (filters.agentId !== undefined && event.actor.agentId !== filters.agentId) return false;
  if (filters.importance !== undefined && !filters.importance.has(event.importance)) return false;
  if (filters.since !== undefined && event.recordedAt < filters.since) return false;
  return true;
}

function encodeCursor(projectKey: string, after: number): string {
  const payload: ActivityCursorPayload = { version: 1, projectKey, after };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(value: unknown, expectedProjectKey: string): number {
  if (typeof value !== "string" || !value) throw new Error("cursor must be a non-empty string");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid agent activity cursor");
  }
  if (!isRecord(parsed) || parsed.version !== 1 || parsed.projectKey !== expectedProjectKey ||
      !Number.isSafeInteger(parsed.after) || parsed.after < 0) {
    throw new Error("Invalid or mismatched agent activity cursor");
  }
  return parsed.after;
}

function emptyState(projectKey: string): StoredAgentActivityState {
  return { version: 1, projectKey, nextCursor: 1, events: [] };
}

function copyActor(actor: AgentActivityActor): AgentActivityActor {
  return { ...actor };
}

function copyArtifact(artifact: AgentActivityArtifactRef): AgentActivityArtifactRef {
  return { ...artifact };
}

function copyEvent(event: AgentActivityEvent): AgentActivityEvent {
  const copy: AgentActivityEvent = {
    ...event,
    actor: copyActor(event.actor),
  };
  if (event.paths !== undefined) copy.paths = [...event.paths];
  if (event.artifactRefs !== undefined) copy.artifactRefs = event.artifactRefs.map(copyArtifact);
  return copy;
}

function assertOnlyKeys(value: object, allowed: Set<string>, label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unsupported field '${key}'`);
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function parseLockOwner(serialized: string): ActivityLockOwner | undefined {
  try {
    const value: unknown = JSON.parse(serialized);
    if (!isRecord(value)) return undefined;
    assertOnlyKeys(value, new Set(["version", "pid", "token"]), "Agent activity lock owner");
    if (value.version !== 1 || !Number.isSafeInteger(value.pid) || value.pid < 1 ||
        typeof value.token !== "string" || !/^[0-9a-f]{32}$/.test(value.token)) {
      return undefined;
    }
    return { version: 1, pid: value.pid, token: value.token };
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNodeError(error, "ESRCH")) return false;
    // EPERM and unknown platform errors are ambiguous, so fail safely and
    // retain the lock rather than risk admitting a concurrent writer.
    return true;
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
