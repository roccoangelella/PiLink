import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const COLLABORATION_SESSION_STATUSES = ["active", "expired", "released", "revoked"] as const;
export type CollaborationSessionStatus = typeof COLLABORATION_SESSION_STATUSES[number];

export const COLLABORATION_SESSION_LABEL_MAX_BYTES = 256;
export const COLLABORATION_SESSION_ROLE_MAX_BYTES = 128;
export const COLLABORATION_SESSION_DEFAULT_TTL_SECONDS = 24 * 60 * 60;
export const COLLABORATION_SESSION_MAX_TTL_SECONDS = 30 * 24 * 60 * 60;
export const COLLABORATION_SESSION_DEFAULT_RESUME_GRACE_SECONDS = 7 * 24 * 60 * 60;
export const COLLABORATION_SESSION_MAX_RESUME_GRACE_SECONDS = 90 * 24 * 60 * 60;
export const COLLABORATION_SESSION_LIMIT = 200;

const SESSION_LOCK_TIMEOUT_MS = 5_000;
const SESSION_STALE_LOCK_MS = 30_000;
const SESSION_LOCK_RETRY_MS = 25;
const SESSION_ID_PATTERN = /^cs_[A-Za-z0-9_-]{24}$/;
const SESSION_HANDLE_PATTERN = /^(cs_[A-Za-z0-9_-]{24})\.([A-Za-z0-9_-]{43})$/;
const SESSION_HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface CollaborationSessionIdentity {
  agentId: string;
  agentName: string;
}

export interface CollaborationSession {
  collaborationSessionId: string;
  projectKey: string;
  agentId: string;
  agentName: string;
  label?: string;
  requestedRoleId?: string;
  status: CollaborationSessionStatus;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
  expiresAt: string;
  resumeUntil: string;
  releasedAt?: string;
  revokedAt?: string;
  revision: number;
}

export interface CollaborationSessionCredential {
  session: CollaborationSession;
  collaborationSessionHandle: string;
}

export interface CollaborationSessionStoreOptions {
  workspace: string;
  dataDir?: string;
  now?: () => Date;
  defaultTtlSeconds?: number;
  resumeGraceSeconds?: number;
  maxSessions?: number;
}

export interface CollaborationSessionStartInput extends CollaborationSessionIdentity {
  label?: string;
  requestedRoleId?: string;
  ttlSeconds?: number;
}

export interface CollaborationSessionHandleInput {
  agentId: string;
  collaborationSessionHandle: string;
}

export interface CollaborationSessionResumeInput extends CollaborationSessionHandleInput {
  agentName: string;
  ttlSeconds?: number;
}

interface StoredCollaborationSession extends CollaborationSession {
  credentialHash: string;
}

interface StoredCollaborationSessionState {
  version: 1;
  projectKey: string;
  sessions: StoredCollaborationSession[];
}

interface SharedSessionState {
  queue: Promise<void>;
}

const sharedStates = new Map<string, SharedSessionState>();

/**
 * Durable project-scoped logical agent sessions.
 *
 * The public collaborationSessionId is safe to expose in task/activity views.
 * The collaborationSessionHandle is a separate bearer capability whose safe
 * delivery is the responsibility of a trusted caller boundary. Only its
 * SHA-256 hash is persisted; public transport exposure is intentionally out of scope here.
 */
export class CollaborationSessionStore {
  public readonly workspace: string;
  public readonly projectKey: string;
  public readonly statePath: string;

  private readonly dataDir: string;
  private readonly projectDir: string;
  private readonly lockPath: string;
  private readonly now: () => Date;
  private readonly defaultTtlSeconds: number;
  private readonly resumeGraceSeconds: number;
  private readonly maxSessions: number;
  private readonly sharedState: SharedSessionState;

  public constructor(options: CollaborationSessionStoreOptions) {
    const selectedDataDir = options.dataDir || process.env.PI_DATA_DIR;
    if (!selectedDataDir) throw new Error("CollaborationSessionStore requires dataDir or PI_DATA_DIR");

    this.workspace = fs.realpathSync(options.workspace);
    this.dataDir = path.resolve(selectedDataDir);
    if (isWithin(this.workspace, this.dataDir)) {
      throw new Error("Collaboration session data must not be stored under the workspace");
    }

    this.now = options.now || (() => new Date());
    this.defaultTtlSeconds = validateTtlSeconds(
      options.defaultTtlSeconds ?? COLLABORATION_SESSION_DEFAULT_TTL_SECONDS,
      "defaultTtlSeconds",
    );
    this.resumeGraceSeconds = validateResumeGraceSeconds(
      options.resumeGraceSeconds ?? COLLABORATION_SESSION_DEFAULT_RESUME_GRACE_SECONDS,
    );
    const selectedMaxSessions = options.maxSessions ?? COLLABORATION_SESSION_LIMIT;
    if (!Number.isSafeInteger(selectedMaxSessions) || selectedMaxSessions < 1 || selectedMaxSessions > 10_000) {
      throw new Error("maxSessions must be an integer between 1 and 10000");
    }
    this.maxSessions = selectedMaxSessions;

    this.projectKey = createHash("sha256").update(this.workspace).digest("hex");
    this.projectDir = path.join(this.dataDir, "projects", this.projectKey);
    this.statePath = path.join(this.projectDir, "collaboration-sessions.json");
    this.lockPath = `${this.statePath}.lock`;
    this.sharedState = sharedStates.get(this.statePath) || { queue: Promise.resolve() };
    sharedStates.set(this.statePath, this.sharedState);
  }

  public async start(input: CollaborationSessionStartInput): Promise<CollaborationSessionCredential> {
    const identity = validateIdentity(input);
    const label = validateOptionalText(input.label, "label", COLLABORATION_SESSION_LABEL_MAX_BYTES);
    const requestedRoleId = validateOptionalIdentifier(
      input.requestedRoleId,
      "requestedRoleId",
      COLLABORATION_SESSION_ROLE_MAX_BYTES,
    );
    const ttlSeconds = input.ttlSeconds === undefined
      ? this.defaultTtlSeconds
      : validateTtlSeconds(input.ttlSeconds, "ttlSeconds");

    return this.enqueue(async () => {
      const now = this.nowDate();
      const state = await this.readAndExpire(now);
      const sessionId = generateSessionId();
      const secret = randomBytes(32).toString("base64url");
      const expiresAt = new Date(now.getTime() + ttlSeconds * 1_000);
      const session: StoredCollaborationSession = {
        collaborationSessionId: sessionId,
        projectKey: this.projectKey,
        agentId: identity.agentId,
        agentName: identity.agentName,
        label,
        requestedRoleId,
        status: "active",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        lastSeenAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
        resumeUntil: new Date(expiresAt.getTime() + this.resumeGraceSeconds * 1_000).toISOString(),
        revision: 1,
        credentialHash: hashSecret(secret),
      };
      const sessions = makeRoomForSession(state.sessions, this.maxSessions, now.getTime());
      const next = withSessions(this.projectKey, [...sessions, session]);
      await this.persistState(next);
      return { session: publicSession(session), collaborationSessionHandle: `${sessionId}.${secret}` };
    });
  }

  /** Validate an active handle for a collaboration mutation and update last_seen_at. */
  public async authenticate(input: CollaborationSessionHandleInput): Promise<CollaborationSession> {
    return (await this.withActiveSession(input, async () => undefined)).session;
  }

  /**
   * Run one coordination mutation while the actor-bound session remains locked
   * and active. Release, resume, or administrative revocation in another
   * process cannot interleave between authorization and the protected update.
   */
  public async withActiveSession<T>(
    input: CollaborationSessionHandleInput,
    operation: (session: CollaborationSession) => T | Promise<T>,
  ): Promise<{ session: CollaborationSession; result: T }> {
    const agentId = validateAgentId(input.agentId);
    const handle = parseHandle(input.collaborationSessionHandle);

    return this.enqueue(async () => {
      const now = this.nowDate();
      const state = await this.readAndExpire(now);
      const session = requireSession(state, handle.sessionId);
      requireHandleOwner(session, agentId, handle.secret);
      requireActiveSession(session);
      const result = await operation(publicSession(session));
      const updated: StoredCollaborationSession = {
        ...session,
        lastSeenAt: now.toISOString(),
        updatedAt: now.toISOString(),
        revision: session.revision + 1,
      };
      await this.persistState(replaceSession(state, updated));
      return { session: publicSession(updated), result };
    });
  }

  /** Read the status associated with a valid handle, including expired/released sessions. */
  public async inspect(input: CollaborationSessionHandleInput): Promise<CollaborationSession> {
    const agentId = validateAgentId(input.agentId);
    const handle = parseHandle(input.collaborationSessionHandle);

    return this.enqueue(async () => {
      const now = this.nowDate();
      const state = await this.readAndExpire(now);
      const session = requireSession(state, handle.sessionId);
      requireHandleOwner(session, agentId, handle.secret);
      return publicSession(session);
    });
  }

  /** Resume or rotate an active/expired session. The previous handle is invalidated. */
  public async resume(input: CollaborationSessionResumeInput): Promise<CollaborationSessionCredential> {
    const identity = validateIdentity(input);
    const handle = parseHandle(input.collaborationSessionHandle);
    const ttlSeconds = input.ttlSeconds === undefined
      ? this.defaultTtlSeconds
      : validateTtlSeconds(input.ttlSeconds, "ttlSeconds");

    return this.enqueue(async () => {
      const now = this.nowDate();
      const state = await this.readAndExpire(now);
      const session = requireSession(state, handle.sessionId);
      requireHandleOwner(session, identity.agentId, handle.secret);
      if (session.status === "released") {
        throw new Error("Collaboration session was released; start a new session and reassign its tasks");
      }
      if (session.status === "revoked") {
        throw new Error("Collaboration session was revoked; start a new session and reassign its tasks");
      }
      if (session.status === "expired" && now.getTime() > Date.parse(session.resumeUntil)) {
        throw new Error("Collaboration session expired beyond its resume window; start a new session and reassign its tasks");
      }

      const secret = randomBytes(32).toString("base64url");
      const expiresAt = new Date(now.getTime() + ttlSeconds * 1_000);
      const updated: StoredCollaborationSession = {
        ...session,
        agentName: identity.agentName,
        status: "active",
        lastSeenAt: now.toISOString(),
        updatedAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
        resumeUntil: new Date(expiresAt.getTime() + this.resumeGraceSeconds * 1_000).toISOString(),
        releasedAt: undefined,
        revokedAt: undefined,
        revision: session.revision + 1,
        credentialHash: hashSecret(secret),
      };
      await this.persistState(replaceSession(state, updated));
      return {
        session: publicSession(updated),
        collaborationSessionHandle: `${updated.collaborationSessionId}.${secret}`,
      };
    });
  }

  public async release(input: CollaborationSessionHandleInput): Promise<CollaborationSession> {
    const agentId = validateAgentId(input.agentId);
    const handle = parseHandle(input.collaborationSessionHandle);

    return this.enqueue(async () => {
      const now = this.nowDate();
      const state = await this.readAndExpire(now);
      const session = requireSession(state, handle.sessionId);
      requireHandleOwner(session, agentId, handle.secret);
      if (session.status === "revoked") throw new Error("Collaboration session is revoked");
      if (session.status === "released") return publicSession(session);
      const updated: StoredCollaborationSession = {
        ...session,
        status: "released",
        releasedAt: now.toISOString(),
        updatedAt: now.toISOString(),
        revision: session.revision + 1,
      };
      await this.persistState(replaceSession(state, updated));
      return publicSession(updated);
    });
  }

  /** Administrative revocation hook. No public tool should expose this without stronger authorization. */
  public async revoke(collaborationSessionId: string): Promise<CollaborationSession> {
    const sessionId = validateSessionId(collaborationSessionId);
    return this.enqueue(async () => {
      const now = this.nowDate();
      const state = await this.readAndExpire(now);
      const session = requireSession(state, sessionId);
      if (session.status === "revoked") return publicSession(session);
      const updated: StoredCollaborationSession = {
        ...session,
        status: "revoked",
        revokedAt: now.toISOString(),
        releasedAt: undefined,
        updatedAt: now.toISOString(),
        revision: session.revision + 1,
      };
      await this.persistState(replaceSession(state, updated));
      return publicSession(updated);
    });
  }

  public async listByActor(agentId: string): Promise<CollaborationSession[]> {
    const normalizedAgentId = validateAgentId(agentId);
    return this.enqueue(async () => {
      const now = this.nowDate();
      const state = await this.readAndExpire(now);
      return state.sessions
        .filter((session) => session.agentId === normalizedAgentId)
        .slice()
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.collaborationSessionId.localeCompare(left.collaborationSessionId))
        .map(publicSession);
    });
  }

  private async readAndExpire(now: Date): Promise<StoredCollaborationSessionState> {
    const state = await this.readStateFile();
    let changed = false;
    const sessions = state.sessions.map((session) => {
      if (session.status !== "active" || Date.parse(session.expiresAt) > now.getTime()) return session;
      changed = true;
      return {
        ...session,
        status: "expired" as const,
        updatedAt: now.toISOString(),
        revision: session.revision + 1,
      };
    });
    if (!changed) return state;
    const updated = withSessions(this.projectKey, sessions);
    await this.persistState(updated);
    return updated;
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.sharedState.queue.then(() => this.withLock(operation));
    this.sharedState.queue = queued.then(() => undefined, () => undefined);
    return queued;
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await this.ensureDirectories();
    const token = `${process.pid}:${randomBytes(16).toString("hex")}`;
    const deadline = Date.now() + SESSION_LOCK_TIMEOUT_MS;

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
        if (Date.now() >= deadline) throw new Error("Timed out waiting for the collaboration session store lock");
        await delay(SESSION_LOCK_RETRY_MS);
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
      if (Date.now() - lock.mtimeMs <= SESSION_STALE_LOCK_MS) return;
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

  private async readStateFile(): Promise<StoredCollaborationSessionState> {
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
      throw new Error("Malformed collaboration session state: invalid JSON");
    }
    return validateState(parsed, this.projectKey, this.maxSessions);
  }

  private async persistState(state: StoredCollaborationSessionState): Promise<void> {
    await this.ensureDirectories();
    const temporaryPath = path.join(
      this.projectDir,
      `.collaboration-sessions-${process.pid}-${randomBytes(12).toString("hex")}.tmp`,
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
      throw new Error("Collaboration session data must not be stored under the workspace");
    }
    await fs.promises.chmod(this.dataDir, 0o700);
    const projectsDir = path.join(this.dataDir, "projects");
    await fs.promises.mkdir(projectsDir, { recursive: true, mode: 0o700 });
    const canonicalProjectsDir = await fs.promises.realpath(projectsDir);
    if (!isWithin(canonicalDataDir, canonicalProjectsDir)) {
      throw new Error("Collaboration session projects directory escapes the configured data directory");
    }
    await fs.promises.chmod(projectsDir, 0o700);
    await fs.promises.mkdir(this.projectDir, { recursive: true, mode: 0o700 });
    const canonicalProjectDir = await fs.promises.realpath(this.projectDir);
    if (!isWithin(canonicalProjectsDir, canonicalProjectDir)) {
      throw new Error("Collaboration session project directory escapes the configured data directory");
    }
    await fs.promises.chmod(this.projectDir, 0o700);
  }

  private nowDate(): Date {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("now must return a valid Date");
    return value;
  }
}

function emptyState(projectKey: string): StoredCollaborationSessionState {
  return { version: 1, projectKey, sessions: [] };
}

function withSessions(projectKey: string, sessions: StoredCollaborationSession[]): StoredCollaborationSessionState {
  return { version: 1, projectKey, sessions };
}

function replaceSession(
  state: StoredCollaborationSessionState,
  updated: StoredCollaborationSession,
): StoredCollaborationSessionState {
  return withSessions(
    state.projectKey,
    state.sessions.map((session) => session.collaborationSessionId === updated.collaborationSessionId ? updated : session),
  );
}

function requireSession(state: StoredCollaborationSessionState, sessionId: string): StoredCollaborationSession {
  const session = state.sessions.find((candidate) => candidate.collaborationSessionId === sessionId);
  if (!session) throw new Error("Collaboration session not found");
  return session;
}

function requireHandleOwner(session: StoredCollaborationSession, agentId: string, secret: string): void {
  if (session.agentId !== agentId) throw new Error("Collaboration session belongs to a different OAuth actor");
  const expected = Buffer.from(session.credentialHash, "base64url");
  const actual = Buffer.from(hashSecret(secret), "base64url");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error("Invalid collaboration session handle");
  }
}

function requireActiveSession(session: StoredCollaborationSession): void {
  if (session.status === "active") return;
  if (session.status === "expired") {
    throw new Error("Collaboration session expired; resume it before mutating coordination state");
  }
  if (session.status === "released") {
    throw new Error("Collaboration session was released; start a new session and reassign its tasks");
  }
  throw new Error("Collaboration session was revoked; start a new session and reassign its tasks");
}

function publicSession(session: StoredCollaborationSession): CollaborationSession {
  const { credentialHash: _credentialHash, ...publicFields } = session;
  return { ...publicFields };
}

function parseHandle(value: unknown): { sessionId: string; secret: string } {
  if (typeof value !== "string") throw new Error("collaborationSessionHandle must be a string");
  const normalized = value.trim();
  const match = SESSION_HANDLE_PATTERN.exec(normalized);
  if (!match) throw new Error("Invalid collaboration session handle format");
  return { sessionId: match[1], secret: match[2] };
}

function generateSessionId(): string {
  return `cs_${randomBytes(18).toString("base64url")}`;
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("base64url");
}

function makeRoomForSession(
  sessions: StoredCollaborationSession[],
  maxSessions: number,
  nowMs: number,
): StoredCollaborationSession[] {
  if (sessions.length < maxSessions) return sessions;
  const removable = sessions
    .map((session, index) => ({ session, index }))
    .filter(({ session }) =>
      session.status === "released" ||
      session.status === "revoked" ||
      (session.status === "expired" && Date.parse(session.resumeUntil) < nowMs),
    )
    .sort((left, right) => left.session.updatedAt.localeCompare(right.session.updatedAt))[0];
  if (!removable) throw new Error(`Collaboration session limit of ${maxSessions} live or resumable sessions reached`);
  return sessions.filter((_, index) => index !== removable.index);
}

function validateState(
  value: unknown,
  expectedProjectKey: string,
  maxSessions: number,
): StoredCollaborationSessionState {
  if (!isRecord(value) || value.version !== 1 || value.projectKey !== expectedProjectKey || !Array.isArray(value.sessions)) {
    throw new Error("Malformed or mismatched collaboration session state");
  }
  if (value.sessions.length > maxSessions) {
    throw new Error("Malformed collaboration session state: session limit exceeded");
  }
  const ids = new Set<string>();
  const sessions = value.sessions.map((candidate) => validateStoredSession(candidate, expectedProjectKey, ids));
  return withSessions(expectedProjectKey, sessions);
}

function validateStoredSession(
  value: unknown,
  expectedProjectKey: string,
  ids: Set<string>,
): StoredCollaborationSession {
  if (!isRecord(value)) throw new Error("Malformed collaboration session state: invalid session");
  const collaborationSessionId = validateSessionId(value.collaborationSessionId);
  if (ids.has(collaborationSessionId)) throw new Error("Malformed collaboration session state: duplicate session ID");
  ids.add(collaborationSessionId);
  if (value.projectKey !== expectedProjectKey) throw new Error("Malformed collaboration session state: mismatched project key");
  const status = validateStatus(value.status);
  const session: StoredCollaborationSession = {
    collaborationSessionId,
    projectKey: expectedProjectKey,
    agentId: validateAgentId(value.agentId),
    agentName: validateRequiredText(value.agentName, "agentName", 100),
    label: validateOptionalText(value.label, "label", COLLABORATION_SESSION_LABEL_MAX_BYTES),
    requestedRoleId: validateOptionalIdentifier(
      value.requestedRoleId,
      "requestedRoleId",
      COLLABORATION_SESSION_ROLE_MAX_BYTES,
    ),
    status,
    createdAt: validateDate(value.createdAt, "createdAt"),
    updatedAt: validateDate(value.updatedAt, "updatedAt"),
    lastSeenAt: validateDate(value.lastSeenAt, "lastSeenAt"),
    expiresAt: validateDate(value.expiresAt, "expiresAt"),
    resumeUntil: validateDate(value.resumeUntil, "resumeUntil"),
    releasedAt: validateOptionalDate(value.releasedAt, "releasedAt"),
    revokedAt: validateOptionalDate(value.revokedAt, "revokedAt"),
    revision: validateRevision(value.revision),
    credentialHash: validateCredentialHash(value.credentialHash),
  };
  if (Date.parse(session.resumeUntil) < Date.parse(session.expiresAt)) {
    throw new Error("Malformed collaboration session state: resume window precedes expiry");
  }
  if (status === "released" && !session.releasedAt) {
    throw new Error("Malformed collaboration session state: released session lacks releasedAt");
  }
  if (status !== "released" && session.releasedAt) {
    throw new Error("Malformed collaboration session state: non-released session has releasedAt");
  }
  if (status === "revoked" && !session.revokedAt) {
    throw new Error("Malformed collaboration session state: revoked session lacks revokedAt");
  }
  if (status !== "revoked" && session.revokedAt) {
    throw new Error("Malformed collaboration session state: non-revoked session has revokedAt");
  }
  return session;
}

function validateIdentity(value: CollaborationSessionIdentity): CollaborationSessionIdentity {
  return {
    agentId: validateAgentId(value.agentId),
    agentName: validateRequiredText(value.agentName, "agentName", 100),
  };
}

function validateAgentId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("agentId must be non-empty");
  const normalized = value.trim();
  if (Buffer.byteLength(normalized, "utf8") > 256) throw new Error("agentId exceeds 256 UTF-8 bytes");
  return normalized;
}

function validateSessionId(value: unknown): string {
  if (typeof value !== "string" || !SESSION_ID_PATTERN.test(value)) {
    throw new Error("Invalid collaboration session ID");
  }
  return value;
}

function validateCredentialHash(value: unknown): string {
  if (typeof value !== "string" || !SESSION_HASH_PATTERN.test(value)) {
    throw new Error("Malformed collaboration session state: invalid credential hash");
  }
  return value;
}

function validateStatus(value: unknown): CollaborationSessionStatus {
  if (typeof value !== "string" || !COLLABORATION_SESSION_STATUSES.includes(value as CollaborationSessionStatus)) {
    throw new Error("Invalid collaboration session status");
  }
  return value as CollaborationSessionStatus;
}

function validateTtlSeconds(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > COLLABORATION_SESSION_MAX_TTL_SECONDS) {
    throw new Error(`${field} must be an integer between 1 and ${COLLABORATION_SESSION_MAX_TTL_SECONDS}`);
  }
  return value as number;
}

function validateResumeGraceSeconds(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > COLLABORATION_SESSION_MAX_RESUME_GRACE_SECONDS) {
    throw new Error(`resumeGraceSeconds must be an integer between 0 and ${COLLABORATION_SESSION_MAX_RESUME_GRACE_SECONDS}`);
  }
  return value as number;
}

function validateRequiredText(value: unknown, field: string, maximumBytes: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} must be non-empty`);
  if (Buffer.byteLength(normalized, "utf8") > maximumBytes) throw new Error(`${field} exceeds ${maximumBytes} UTF-8 bytes`);
  return normalized;
}

function validateOptionalText(value: unknown, field: string, maximumBytes: number): string | undefined {
  return value === undefined ? undefined : validateRequiredText(value, field, maximumBytes);
}

function validateOptionalIdentifier(value: unknown, field: string, maximumBytes: number): string | undefined {
  if (value === undefined) return undefined;
  const normalized = validateRequiredText(value, field, maximumBytes);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(normalized)) {
    throw new Error(`${field} must contain only letters, numbers, dot, underscore, colon, or hyphen`);
  }
  return normalized;
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

function parseLockOwnerPid(owner: string): number | undefined {
  const match = /^(\d+):[0-9a-f]{32}$/.exec(owner);
  if (!match) return undefined;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNodeError(error, "ESRCH")) return false;
    return true;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
