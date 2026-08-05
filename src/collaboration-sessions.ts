import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  validatePersistedCollaborationRoleAssignment,
  type CollaborationRoleRequestKind,
  type VerifiedCollaborationRoleAssignment,
} from "./collaboration-roles.js";
import {
  LINUX_BOOT_ID_PATTERN,
  LOCAL_RUNTIME_OWNER,
  PROCESS_START_MARKER_PATTERN,
  RUNTIME_INSTANCE_ID_PATTERN,
  classifyPersistedRuntimeOwner,
  requireLocalRuntimeOwner,
  sameRuntimeOwner,
  type RuntimeOwner as StoredRuntimeOwner,
} from "./runtime-owner.js";

export const COLLABORATION_SESSION_STATUSES = ["active", "expired", "released", "revoked"] as const;
export type CollaborationSessionStatus = typeof COLLABORATION_SESSION_STATUSES[number];

export const COLLABORATION_SESSION_LABEL_MAX_BYTES = 256;
export const COLLABORATION_SESSION_ROLE_MAX_BYTES = 128;
export const COLLABORATION_SESSION_DEFAULT_TTL_SECONDS = 24 * 60 * 60;
export const COLLABORATION_SESSION_MAX_TTL_SECONDS = 30 * 24 * 60 * 60;
export const COLLABORATION_SESSION_DEFAULT_RESUME_GRACE_SECONDS = 7 * 24 * 60 * 60;
export const COLLABORATION_SESSION_MAX_RESUME_GRACE_SECONDS = 90 * 24 * 60 * 60;
export const COLLABORATION_SESSION_LIMIT = 200;
export const COLLABORATION_SESSION_DEFAULT_MAX_LIVE_PER_ACTOR = 8;
export const COLLABORATION_SESSION_MAX_LIVE_PER_ACTOR = 100;
export const COLLABORATION_SESSION_DEFAULT_RECOVERY_SECONDS = 5 * 60;
export const COLLABORATION_SESSION_MAX_RECOVERY_SECONDS = 60 * 60;
export const COLLABORATION_SESSION_DEFAULT_TOUCH_INTERVAL_SECONDS = 60;
export const COLLABORATION_SESSION_MAX_TOUCH_INTERVAL_SECONDS = 60 * 60;
export const COLLABORATION_SESSION_RESUME_REQUEST_ID_MAX_BYTES = 128;
export const COLLABORATION_SESSION_CREDENTIAL_VERSION = 1;

const SESSION_LOCK_TIMEOUT_MS = 5_000;
const SESSION_STALE_LOCK_MS = 30_000;
const SESSION_LOCK_RETRY_MS = 25;
const SESSION_ID_PATTERN = /^cs_[A-Za-z0-9_-]{24}$/;
const SESSION_HANDLE_PATTERN = /^(cs_[A-Za-z0-9_-]{24})\.([A-Za-z0-9_-]{43})$/;
const SESSION_MAC_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SESSION_KEY_ID_MAX_BYTES = 64;
const SESSION_KEY_MATERIAL_PATTERN = /^[A-Za-z0-9_-]+$/;
const CREDENTIAL_MAC_DOMAIN = "pilink/collaboration-session/credential-mac/v1";
const RESUME_REQUEST_MAC_DOMAIN = "pilink/collaboration-session/resume-request-mac/v1";
const RESUME_SECRET_DOMAIN = "pilink/collaboration-session/resume-secret/v1";
const LEGACY_TOMBSTONE_DOMAIN = "pilink/collaboration-session/legacy-tombstone/v1";
const STATE_KEY_BINDING_DOMAIN = "pilink/collaboration-session/state-key-binding/v1";

type StoredRevocationReason = "runtime_lost";

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
  requestKind?: Exclude<CollaborationRoleRequestKind, "none">;
  requestedRoleFingerprint?: string;
  assignedRoleId?: string;
  occupancyLabel?: string;
  roleContractId?: string;
  roleContractVersion?: string;
  status: CollaborationSessionStatus;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
  expiresAt: string;
  resumeUntil: string;
  credentialGeneration: number;
  lastCredentialRotatedAt?: string;
  releasedAt?: string;
  revokedAt?: string;
  revision: number;
}

export interface CollaborationSessionCredential {
  session: CollaborationSession;
  collaborationSessionHandle: string;
}

export interface CollaborationSessionCredentialKey {
  keyId: string;
  keyMaterial: string;
}

export interface CollaborationSessionRoleBinding {
  requestKind: Exclude<CollaborationRoleRequestKind, "none">;
  requestedRoleFingerprint: string;
  roleAssignment: VerifiedCollaborationRoleAssignment;
}

export interface CollaborationSessionStoreOptions {
  workspace: string;
  dataDir?: string;
  now?: () => Date;
  defaultTtlSeconds?: number;
  resumeGraceSeconds?: number;
  resumeRecoverySeconds?: number;
  touchIntervalSeconds?: number;
  maxSessions?: number;
  maxLiveSessionsPerActor?: number;
  credentialKey: CollaborationSessionCredentialKey;
}

export interface CollaborationSessionStartInput extends CollaborationSessionIdentity {
  label?: string;
  roleBinding?: CollaborationSessionRoleBinding;
  ttlSeconds?: number;
}

export interface CollaborationSessionHandleInput {
  agentId: string;
  collaborationSessionHandle: string;
}

export interface CollaborationSessionResumeInput extends CollaborationSessionHandleInput {
  agentName: string;
  resumeRequestId: string;
  ttlSeconds?: number;
}

interface StoredCredentialVerifier {
  version: 1;
  keyId: string;
  generation: number;
  mac: string;
}

interface StoredResumeRecovery {
  sourceGeneration: number;
  targetGeneration: number;
  previousCredentialVerifier: StoredCredentialVerifier;
  requestIdMac: string;
  ttlSeconds: number;
  recoveryUntil: string;
  rotatedAt: string;
}

interface StoredCollaborationSession extends CollaborationSession {
  /** Deprecated v1/v2 provenance. Never returned publicly or written by new starts. */
  requestedRoleId?: string;
  /** Private process ownership used only to reclaim unreachable crash orphans. */
  runtimeOwner?: StoredRuntimeOwner;
  revocationReason?: StoredRevocationReason;
  credentialVerifier: StoredCredentialVerifier;
  resumeRecovery?: StoredResumeRecovery;
}

interface StoredCredentialKeyBinding {
  version: 1;
  keyId: string;
  mac: string;
}

interface StoredCollaborationSessionState {
  version: 3;
  projectKey: string;
  credentialKeyBinding: StoredCredentialKeyBinding;
  sessions: StoredCollaborationSession[];
}

interface VersionTwoStoredCollaborationSessionState {
  version: 2;
  projectKey: string;
  credentialKeyBinding: StoredCredentialKeyBinding;
  sessions: StoredCollaborationSession[];
}

interface LegacyStoredCollaborationSession {
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
  credentialHash: string;
}

interface LegacyStoredCollaborationSessionState {
  version: 1;
  projectKey: string;
  sessions: LegacyStoredCollaborationSession[];
}

interface SharedSessionState {
  queue: Promise<void>;
}

interface ValidatedCredentialKey {
  keyId: string;
  keyMaterial: Buffer;
}

const sharedStates = new Map<string, SharedSessionState>();

/**
 * Durable project-scoped logical agent sessions.
 *
 * The public collaborationSessionId is safe to expose in task/activity views.
 * The collaborationSessionHandle is a separate bearer capability whose safe
 * delivery is the responsibility of a trusted caller boundary. Only a
 * versioned, domain-separated HMAC verifier is persisted; public/model-visible
 * transport exposure remains intentionally blocked because same-OAuth sibling
 * sessions would otherwise share the bearer-recovery risk.
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
  private readonly resumeRecoverySeconds: number;
  private readonly touchIntervalSeconds: number;
  private readonly maxSessions: number;
  private readonly maxLiveSessionsPerActor: number;
  private readonly credentialKey: ValidatedCredentialKey;
  private readonly sharedState: SharedSessionState;

  public constructor(options: CollaborationSessionStoreOptions) {
    // Validate the module-shared local owner before this store can inspect or
    // reclaim durable state. Linux must never operate with an incomplete tuple.
    requireLocalRuntimeOwner();
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
    this.resumeRecoverySeconds = validateBoundedSeconds(
      options.resumeRecoverySeconds ?? COLLABORATION_SESSION_DEFAULT_RECOVERY_SECONDS,
      "resumeRecoverySeconds",
      COLLABORATION_SESSION_MAX_RECOVERY_SECONDS,
    );
    this.touchIntervalSeconds = validateBoundedSeconds(
      options.touchIntervalSeconds ?? COLLABORATION_SESSION_DEFAULT_TOUCH_INTERVAL_SECONDS,
      "touchIntervalSeconds",
      COLLABORATION_SESSION_MAX_TOUCH_INTERVAL_SECONDS,
    );
    const selectedMaxSessions = options.maxSessions ?? COLLABORATION_SESSION_LIMIT;
    if (!Number.isSafeInteger(selectedMaxSessions) || selectedMaxSessions < 1 || selectedMaxSessions > 10_000) {
      throw new Error("maxSessions must be an integer between 1 and 10000");
    }
    this.maxSessions = selectedMaxSessions;
    const selectedActorLimit = options.maxLiveSessionsPerActor ?? COLLABORATION_SESSION_DEFAULT_MAX_LIVE_PER_ACTOR;
    if (!Number.isSafeInteger(selectedActorLimit) || selectedActorLimit < 1 ||
        selectedActorLimit > COLLABORATION_SESSION_MAX_LIVE_PER_ACTOR) {
      throw new Error(
        `maxLiveSessionsPerActor must be an integer between 1 and ${COLLABORATION_SESSION_MAX_LIVE_PER_ACTOR}`,
      );
    }
    this.maxLiveSessionsPerActor = selectedActorLimit;
    this.credentialKey = validateCredentialKey(options.credentialKey);

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
    const roleBinding = validateRoleBinding(input.roleBinding);
    const ttlSeconds = input.ttlSeconds === undefined
      ? this.defaultTtlSeconds
      : validateTtlSeconds(input.ttlSeconds, "ttlSeconds");

    return this.enqueue(async () => {
      const now = this.nowDate();
      const state = await this.readAndExpire(now);
      requireActorSessionCapacity(
        state.sessions,
        identity.agentId,
        this.maxLiveSessionsPerActor,
        now.getTime(),
      );
      const sessionId = generateSessionId();
      const secret = randomBytes(32).toString("base64url");
      const expiresAt = new Date(now.getTime() + ttlSeconds * 1_000);
      const credentialGeneration = 1;
      const session: StoredCollaborationSession = {
        collaborationSessionId: sessionId,
        projectKey: this.projectKey,
        agentId: identity.agentId,
        agentName: identity.agentName,
        label,
        ...roleBinding,
        runtimeOwner: requireLocalRuntimeOwner(),
        status: "active",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        lastSeenAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
        resumeUntil: new Date(expiresAt.getTime() + this.resumeGraceSeconds * 1_000).toISOString(),
        credentialGeneration,
        revision: 1,
        credentialVerifier: createCredentialVerifier(
          this.credentialKey,
          this.projectKey,
          sessionId,
          identity.agentId,
          credentialGeneration,
          secret,
        ),
      };
      const sessions = makeRoomForSession(state.sessions, this.maxSessions, now.getTime());
      const next = withSessions(state, [...sessions, session]);
      await this.persistState(next);
      return { session: publicSession(session), collaborationSessionHandle: `${sessionId}.${secret}` };
    });
  }

  /** Validate an active handle and return a short-lived verified snapshot. */
  public async authenticate(input: CollaborationSessionHandleInput): Promise<CollaborationSession> {
    const agentId = validateAgentId(input.agentId);
    const handle = parseHandle(input.collaborationSessionHandle);

    return this.enqueue(async () => {
      const now = this.nowDate();
      const state = await this.readAndExpire(now);
      const session = requireSession(state, handle.sessionId);
      requireCurrentHandleOwner(session, agentId, handle.secret, this.credentialKey);
      requireCurrentRuntimeOwner(session);
      requireActiveSession(session);
      if (now.getTime() - Date.parse(session.lastSeenAt) < this.touchIntervalSeconds * 1_000) {
        return publicSession(session);
      }
      const updated: StoredCollaborationSession = {
        ...session,
        lastSeenAt: now.toISOString(),
        updatedAt: now.toISOString(),
        revision: session.revision + 1,
      };
      await this.persistState(replaceSession(state, updated));
      return publicSession(updated);
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
      requireCurrentHandleOwner(session, agentId, handle.secret, this.credentialKey);
      requireCurrentRuntimeOwner(session);
      return publicSession(session);
    });
  }

  /**
   * Rotate an active/expired session credential exactly once per generation.
   * Repeating the same request with the previous handle during the short
   * recovery window deterministically re-derives the already-issued handle.
   */
  public async resume(input: CollaborationSessionResumeInput): Promise<CollaborationSessionCredential> {
    const identity = validateIdentity(input);
    const handle = parseHandle(input.collaborationSessionHandle);
    const resumeRequestId = validateResumeRequestId(input.resumeRequestId);
    const requestedTtlSeconds = input.ttlSeconds === undefined
      ? undefined
      : validateTtlSeconds(input.ttlSeconds, "ttlSeconds");
    const ttlSeconds = requestedTtlSeconds ?? this.defaultTtlSeconds;

    return this.enqueue(async () => {
      const now = this.nowDate();
      const state = await this.readAndExpire(now);
      const session = requireSession(state, handle.sessionId);
      if (session.agentId !== identity.agentId) {
        throw new Error("Collaboration session belongs to a different OAuth actor");
      }

      const currentMatches = credentialVerifierMatches(
        session,
        session.credentialVerifier,
        handle.secret,
        this.credentialKey,
      );
      if (!currentMatches) {
        const recovery = session.resumeRecovery;
        const previousMatches = recovery !== undefined &&
          Date.parse(recovery.recoveryUntil) >= now.getTime() &&
          credentialVerifierMatches(
            session,
            recovery.previousCredentialVerifier,
            handle.secret,
            this.credentialKey,
          );
        if (!previousMatches) {
          throw new Error("Invalid collaboration session handle or resume request");
        }
        // A valid previous-generation bearer is still runtime-bound. Gate before
        // deterministic recovery can derive or return the rotated credential.
        requireCurrentRuntimeOwner(session);
        const recovered = recoverCompletedResume(
          session,
          handle.secret,
          resumeRequestId,
          requestedTtlSeconds,
          now,
          this.credentialKey,
        );
        if (recovered) return recovered;
        throw new Error("Invalid collaboration session handle or resume request");
      }

      if (session.status === "released") {
        throw new Error("Collaboration session was released; start a new session and reassign its tasks");
      }
      if (session.status === "revoked") {
        throw new Error("Collaboration session was revoked; start a new session and reassign its tasks");
      }
      requireCurrentRuntimeOwner(session);

      if (session.resumeRecovery && resumeRequestMatches(
        session,
        session.resumeRecovery,
        resumeRequestId,
        this.credentialKey,
      )) {
        throw new Error("Resume request already completed; retry with the previous handle during recovery or use a new request ID");
      }
      if (session.status === "expired" && now.getTime() > Date.parse(session.resumeUntil)) {
        throw new Error("Collaboration session expired beyond its resume window; start a new session and reassign its tasks");
      }

      const sourceGeneration = session.credentialGeneration;
      const targetGeneration = sourceGeneration + 1;
      const secret = deriveResumeSecret(
        this.credentialKey,
        session,
        sourceGeneration,
        targetGeneration,
        resumeRequestId,
        ttlSeconds,
      );
      const expiresAt = new Date(now.getTime() + ttlSeconds * 1_000);
      const rotatedAt = now.toISOString();
      const updated: StoredCollaborationSession = {
        ...session,
        agentName: identity.agentName,
        status: "active",
        runtimeOwner: requireLocalRuntimeOwner(),
        revocationReason: undefined,
        lastSeenAt: rotatedAt,
        updatedAt: rotatedAt,
        expiresAt: expiresAt.toISOString(),
        resumeUntil: new Date(expiresAt.getTime() + this.resumeGraceSeconds * 1_000).toISOString(),
        credentialGeneration: targetGeneration,
        lastCredentialRotatedAt: rotatedAt,
        releasedAt: undefined,
        revokedAt: undefined,
        revision: session.revision + 1,
        credentialVerifier: createCredentialVerifier(
          this.credentialKey,
          this.projectKey,
          session.collaborationSessionId,
          session.agentId,
          targetGeneration,
          secret,
        ),
        resumeRecovery: {
          sourceGeneration,
          targetGeneration,
          previousCredentialVerifier: session.credentialVerifier,
          requestIdMac: createResumeRequestMac(
            this.credentialKey,
            session,
            sourceGeneration,
            resumeRequestId,
          ),
          ttlSeconds,
          recoveryUntil: new Date(now.getTime() + this.resumeRecoverySeconds * 1_000).toISOString(),
          rotatedAt,
        },
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
      requireCurrentHandleOwner(session, agentId, handle.secret, this.credentialKey);
      requireCurrentRuntimeOwner(session);
      if (session.status === "revoked") throw new Error("Collaboration session is revoked");
      if (session.status === "released") return publicSession(session);
      const updated: StoredCollaborationSession = {
        ...session,
        status: "released",
        runtimeOwner: undefined,
        revocationReason: undefined,
        releasedAt: now.toISOString(),
        updatedAt: now.toISOString(),
        resumeRecovery: undefined,
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
        runtimeOwner: undefined,
        revocationReason: undefined,
        revokedAt: now.toISOString(),
        releasedAt: undefined,
        updatedAt: now.toISOString(),
        resumeRecovery: undefined,
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

  private async readAndExpire(
    now: Date,
    reclaimOrphans = true,
  ): Promise<StoredCollaborationSessionState> {
    const state = await this.readStateFile(now);
    let changed = false;
    const sessions = state.sessions.map((session) => {
      const shouldRevokeOrphan = reclaimOrphans &&
        (session.status === "active" || session.status === "expired") &&
        (!session.runtimeOwner || classifyPersistedRuntimeOwner(session.runtimeOwner) === "dead");
      const shouldExpire = !shouldRevokeOrphan &&
        session.status === "active" && Date.parse(session.expiresAt) <= now.getTime();
      const shouldClearRecovery = session.resumeRecovery !== undefined &&
        Date.parse(session.resumeRecovery.recoveryUntil) < now.getTime();
      if (!shouldRevokeOrphan && !shouldExpire && !shouldClearRecovery) return session;
      changed = true;
      return {
        ...session,
        status: shouldRevokeOrphan ? "revoked" as const : shouldExpire ? "expired" as const : session.status,
        runtimeOwner: shouldRevokeOrphan ? undefined : session.runtimeOwner,
        revocationReason: shouldRevokeOrphan ? "runtime_lost" as const : session.revocationReason,
        releasedAt: shouldRevokeOrphan ? undefined : session.releasedAt,
        revokedAt: shouldRevokeOrphan ? now.toISOString() : session.revokedAt,
        resumeRecovery: shouldRevokeOrphan || shouldClearRecovery ? undefined : session.resumeRecovery,
        updatedAt: now.toISOString(),
        revision: session.revision + 1,
      };
    });
    if (!changed) return state;
    const updated = withSessions(state, sessions);
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

  private async readStateFile(now: Date): Promise<StoredCollaborationSessionState> {
    await this.ensureDirectories();
    let serialized: string;
    try {
      serialized = await fs.promises.readFile(this.statePath, "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return emptyState(this.projectKey, this.credentialKey);
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized);
    } catch {
      throw new Error("Malformed collaboration session state: invalid JSON");
    }
    if (isRecord(parsed) && parsed.version === 1) {
      const legacy = validateLegacyState(parsed, this.projectKey, this.maxSessions);
      const migrated = migrateLegacyState(legacy, this.credentialKey, now);
      await this.persistState(migrated);
      return migrated;
    }
    if (isRecord(parsed) && parsed.version === 2) {
      const versionTwo = validateVersionTwoState(parsed, this.projectKey, this.maxSessions, this.credentialKey);
      const migrated = migrateVersionTwoState(versionTwo, this.credentialKey, now);
      await this.persistState(migrated);
      return migrated;
    }
    return validateState(parsed, this.projectKey, this.maxSessions, this.credentialKey);
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

function emptyState(
  projectKey: string,
  credentialKey: ValidatedCredentialKey,
): StoredCollaborationSessionState {
  return {
    version: 3,
    projectKey,
    credentialKeyBinding: createCredentialKeyBinding(credentialKey, projectKey, 3),
    sessions: [],
  };
}

function withSessions(
  state: StoredCollaborationSessionState,
  sessions: StoredCollaborationSession[],
): StoredCollaborationSessionState {
  return { ...state, sessions };
}

function replaceSession(
  state: StoredCollaborationSessionState,
  updated: StoredCollaborationSession,
): StoredCollaborationSessionState {
  return withSessions(
    state,
    state.sessions.map((session) => session.collaborationSessionId === updated.collaborationSessionId ? updated : session),
  );
}

function requireSession(state: StoredCollaborationSessionState, sessionId: string): StoredCollaborationSession {
  const session = state.sessions.find((candidate) => candidate.collaborationSessionId === sessionId);
  if (!session) throw new Error("Collaboration session not found");
  return session;
}

function requireCurrentHandleOwner(
  session: StoredCollaborationSession,
  agentId: string,
  secret: string,
  credentialKey: ValidatedCredentialKey,
): void {
  if (session.agentId !== agentId) throw new Error("Collaboration session belongs to a different OAuth actor");
  if (!credentialVerifierMatches(session, session.credentialVerifier, secret, credentialKey)) {
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
  const {
    requestedRoleId: _legacyRequestedRoleId,
    runtimeOwner: _runtimeOwner,
    revocationReason: _revocationReason,
    credentialVerifier: _credentialVerifier,
    resumeRecovery: _resumeRecovery,
    ...publicFields
  } = session;
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

function createCredentialKeyBinding(
  credentialKey: ValidatedCredentialKey,
  projectKey: string,
  stateVersion: 2 | 3,
): StoredCredentialKeyBinding {
  return {
    version: COLLABORATION_SESSION_CREDENTIAL_VERSION,
    keyId: credentialKey.keyId,
    mac: keyedDigest(credentialKey, STATE_KEY_BINDING_DOMAIN, [
      projectKey,
      `state-version:${stateVersion}`,
    ]),
  };
}

function validateCredentialKeyBinding(
  value: unknown,
  credentialKey: ValidatedCredentialKey,
  projectKey: string,
  stateVersion: 2 | 3,
): StoredCredentialKeyBinding {
  if (!isRecord(value)) {
    throw new Error("Malformed collaboration session state: missing credential key binding");
  }
  assertOnlyKeys(value, ["version", "keyId", "mac"], "credential key binding");
  if (value.version !== COLLABORATION_SESSION_CREDENTIAL_VERSION) {
    throw new Error("Malformed collaboration session state: unsupported credential key binding version");
  }
  const keyId = validateOptionalIdentifier(value.keyId, "credentialKeyBinding.keyId", SESSION_KEY_ID_MAX_BYTES);
  if (keyId !== credentialKey.keyId) {
    throw new Error("Collaboration session credential key ID does not match the configured server key");
  }
  const mac = validateMac(value.mac, "credential key binding MAC");
  const expected = createCredentialKeyBinding(credentialKey, projectKey, stateVersion);
  if (!constantTimeMacEqual(mac, expected.mac)) {
    throw new Error("Collaboration session credential key material does not match persisted state");
  }
  return { version: COLLABORATION_SESSION_CREDENTIAL_VERSION, keyId, mac };
}

function createCredentialVerifier(
  credentialKey: ValidatedCredentialKey,
  projectKey: string,
  collaborationSessionId: string,
  agentId: string,
  generation: number,
  secret: string,
): StoredCredentialVerifier {
  return {
    version: COLLABORATION_SESSION_CREDENTIAL_VERSION,
    keyId: credentialKey.keyId,
    generation,
    mac: keyedDigest(credentialKey, CREDENTIAL_MAC_DOMAIN, [
      projectKey,
      collaborationSessionId,
      agentId,
      String(generation),
      secret,
    ]),
  };
}

function credentialVerifierMatches(
  session: StoredCollaborationSession,
  verifier: StoredCredentialVerifier,
  secret: string,
  credentialKey: ValidatedCredentialKey,
): boolean {
  if (verifier.version !== COLLABORATION_SESSION_CREDENTIAL_VERSION ||
      verifier.keyId !== credentialKey.keyId) return false;
  const actual = createCredentialVerifier(
    credentialKey,
    session.projectKey,
    session.collaborationSessionId,
    session.agentId,
    verifier.generation,
    secret,
  );
  return constantTimeMacEqual(verifier.mac, actual.mac);
}

function createResumeRequestMac(
  credentialKey: ValidatedCredentialKey,
  session: StoredCollaborationSession,
  sourceGeneration: number,
  resumeRequestId: string,
): string {
  return keyedDigest(credentialKey, RESUME_REQUEST_MAC_DOMAIN, [
    session.projectKey,
    session.collaborationSessionId,
    session.agentId,
    String(sourceGeneration),
    resumeRequestId,
  ]);
}

function resumeRequestMatches(
  session: StoredCollaborationSession,
  recovery: StoredResumeRecovery,
  resumeRequestId: string,
  credentialKey: ValidatedCredentialKey,
): boolean {
  const actual = createResumeRequestMac(
    credentialKey,
    session,
    recovery.sourceGeneration,
    resumeRequestId,
  );
  return constantTimeMacEqual(recovery.requestIdMac, actual);
}

function deriveResumeSecret(
  credentialKey: ValidatedCredentialKey,
  session: StoredCollaborationSession,
  sourceGeneration: number,
  targetGeneration: number,
  resumeRequestId: string,
  ttlSeconds: number,
): string {
  return keyedDigest(credentialKey, RESUME_SECRET_DOMAIN, [
    session.projectKey,
    session.collaborationSessionId,
    session.agentId,
    String(sourceGeneration),
    String(targetGeneration),
    resumeRequestId,
    String(ttlSeconds),
  ]);
}

function recoverCompletedResume(
  session: StoredCollaborationSession,
  previousSecret: string,
  resumeRequestId: string,
  requestedTtlSeconds: number | undefined,
  now: Date,
  credentialKey: ValidatedCredentialKey,
): CollaborationSessionCredential | undefined {
  const recovery = session.resumeRecovery;
  if (!recovery || Date.parse(recovery.recoveryUntil) < now.getTime()) return undefined;
  if (!credentialVerifierMatches(
    session,
    recovery.previousCredentialVerifier,
    previousSecret,
    credentialKey,
  )) return undefined;
  if (!resumeRequestMatches(session, recovery, resumeRequestId, credentialKey)) {
    throw new Error("Resume request conflicts with a completed credential rotation");
  }
  if (requestedTtlSeconds !== undefined && recovery.ttlSeconds !== requestedTtlSeconds) {
    throw new Error("Resume request parameters conflict with a completed credential rotation");
  }
  if (recovery.targetGeneration !== session.credentialGeneration ||
      recovery.sourceGeneration + 1 !== recovery.targetGeneration) {
    throw new Error("Malformed collaboration session state: inconsistent resume recovery generation");
  }
  const secret = deriveResumeSecret(
    credentialKey,
    session,
    recovery.sourceGeneration,
    recovery.targetGeneration,
    resumeRequestId,
    recovery.ttlSeconds,
  );
  if (!credentialVerifierMatches(session, session.credentialVerifier, secret, credentialKey)) {
    throw new Error("Malformed collaboration session state: resume recovery verifier mismatch");
  }
  return {
    session: publicSession(session),
    collaborationSessionHandle: `${session.collaborationSessionId}.${secret}`,
  };
}

function keyedDigest(
  credentialKey: ValidatedCredentialKey,
  domain: string,
  fields: string[],
): string {
  return createHmac("sha256", credentialKey.keyMaterial)
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(JSON.stringify([credentialKey.keyId, ...fields]), "utf8")
    .digest("base64url");
}

function constantTimeMacEqual(expected: string, actual: string): boolean {
  if (!SESSION_MAC_PATTERN.test(expected) || !SESSION_MAC_PATTERN.test(actual)) return false;
  const expectedBytes = Buffer.from(expected, "base64url");
  const actualBytes = Buffer.from(actual, "base64url");
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

function requireActorSessionCapacity(
  sessions: StoredCollaborationSession[],
  agentId: string,
  maximum: number,
  nowMs: number,
): void {
  const liveOrResumable = sessions.filter((session) =>
    session.agentId === agentId &&
    (session.status === "active" ||
      (session.status === "expired" && Date.parse(session.resumeUntil) >= nowMs)),
  ).length;
  if (liveOrResumable >= maximum) {
    throw new Error(`Collaboration session live/resumable limit of ${maximum} reached for this OAuth actor`);
  }
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
  credentialKey: ValidatedCredentialKey,
): StoredCollaborationSessionState {
  if (!isRecord(value) || value.version !== 3 || value.projectKey !== expectedProjectKey || !Array.isArray(value.sessions)) {
    throw new Error("Malformed or mismatched collaboration session state");
  }
  assertOnlyKeys(
    value,
    ["version", "projectKey", "credentialKeyBinding", "sessions"],
    "collaboration session state",
  );
  if (value.sessions.length > maxSessions) {
    throw new Error("Malformed collaboration session state: session limit exceeded");
  }
  const credentialKeyBinding = validateCredentialKeyBinding(
    value.credentialKeyBinding,
    credentialKey,
    expectedProjectKey,
    3,
  );
  const ids = new Set<string>();
  const sessions = value.sessions.map((candidate) =>
    validateStoredSession(candidate, expectedProjectKey, credentialKey.keyId, ids, "required-for-live"));
  return { version: 3, projectKey: expectedProjectKey, credentialKeyBinding, sessions };
}

function validateVersionTwoState(
  value: unknown,
  expectedProjectKey: string,
  maxSessions: number,
  credentialKey: ValidatedCredentialKey,
): VersionTwoStoredCollaborationSessionState {
  if (!isRecord(value) || value.version !== 2 || value.projectKey !== expectedProjectKey || !Array.isArray(value.sessions)) {
    throw new Error("Malformed or mismatched version 2 collaboration session state");
  }
  assertOnlyKeys(
    value,
    ["version", "projectKey", "credentialKeyBinding", "sessions"],
    "version 2 collaboration session state",
  );
  if (value.sessions.length > maxSessions) {
    throw new Error("Malformed collaboration session state: session limit exceeded");
  }
  const credentialKeyBinding = validateCredentialKeyBinding(
    value.credentialKeyBinding,
    credentialKey,
    expectedProjectKey,
    2,
  );
  const ids = new Set<string>();
  const sessions = value.sessions.map((candidate) =>
    validateStoredSession(candidate, expectedProjectKey, credentialKey.keyId, ids, "forbidden"));
  return { version: 2, projectKey: expectedProjectKey, credentialKeyBinding, sessions };
}

function validateStoredSession(
  value: unknown,
  expectedProjectKey: string,
  expectedKeyId: string,
  ids: Set<string>,
  runtimeOwnerMode: "forbidden" | "required-for-live",
): StoredCollaborationSession {
  if (!isRecord(value)) throw new Error("Malformed collaboration session state: invalid session");
  assertOnlyKeys(value, [
    "collaborationSessionId",
    "projectKey",
    "agentId",
    "agentName",
    "label",
    "requestedRoleId",
    ...(runtimeOwnerMode === "required-for-live" ? ["runtimeOwner", "revocationReason"] : []),
    "requestKind",
    "requestedRoleFingerprint",
    "assignedRoleId",
    "occupancyLabel",
    "roleContractId",
    "roleContractVersion",
    "status",
    "createdAt",
    "updatedAt",
    "lastSeenAt",
    "expiresAt",
    "resumeUntil",
    "credentialGeneration",
    "lastCredentialRotatedAt",
    "releasedAt",
    "revokedAt",
    "revision",
    "credentialVerifier",
    "resumeRecovery",
  ], "collaboration session");
  const collaborationSessionId = validateSessionId(value.collaborationSessionId);
  if (ids.has(collaborationSessionId)) throw new Error("Malformed collaboration session state: duplicate session ID");
  ids.add(collaborationSessionId);
  if (value.projectKey !== expectedProjectKey) throw new Error("Malformed collaboration session state: mismatched project key");
  const status = validateStatus(value.status);
  const roleBinding = validateStoredRoleBinding(value);
  const runtimeOwner = runtimeOwnerMode === "required-for-live"
    ? validateOptionalRuntimeOwner(value.runtimeOwner)
    : undefined;
  const revocationReason = runtimeOwnerMode === "required-for-live"
    ? validateOptionalRevocationReason(value.revocationReason)
    : undefined;
  validateOptionalIdentifier(value.requestedRoleId, "requestedRoleId", COLLABORATION_SESSION_ROLE_MAX_BYTES);
  const credentialGeneration = validateGeneration(value.credentialGeneration, "credentialGeneration");
  const credentialVerifier = validateCredentialVerifier(value.credentialVerifier, expectedKeyId);
  const resumeRecovery = value.resumeRecovery === undefined
    ? undefined
    : validateResumeRecovery(value.resumeRecovery, expectedKeyId);
  const session: StoredCollaborationSession = {
    collaborationSessionId,
    projectKey: expectedProjectKey,
    agentId: validateAgentId(value.agentId),
    agentName: validateRequiredText(value.agentName, "agentName", 100),
    label: validateOptionalText(value.label, "label", COLLABORATION_SESSION_LABEL_MAX_BYTES),
    ...roleBinding,
    runtimeOwner,
    revocationReason,
    status,
    createdAt: validateDate(value.createdAt, "createdAt"),
    updatedAt: validateDate(value.updatedAt, "updatedAt"),
    lastSeenAt: validateDate(value.lastSeenAt, "lastSeenAt"),
    expiresAt: validateDate(value.expiresAt, "expiresAt"),
    resumeUntil: validateDate(value.resumeUntil, "resumeUntil"),
    credentialGeneration,
    lastCredentialRotatedAt: validateOptionalDate(value.lastCredentialRotatedAt, "lastCredentialRotatedAt"),
    releasedAt: validateOptionalDate(value.releasedAt, "releasedAt"),
    revokedAt: validateOptionalDate(value.revokedAt, "revokedAt"),
    revision: validateRevision(value.revision),
    credentialVerifier,
    resumeRecovery,
  };
  if (Date.parse(session.resumeUntil) < Date.parse(session.expiresAt)) {
    throw new Error("Malformed collaboration session state: resume window precedes expiry");
  }
  if (session.credentialVerifier.generation !== session.credentialGeneration) {
    throw new Error("Malformed collaboration session state: credential generation mismatch");
  }
  if (session.credentialGeneration > 1 && !session.lastCredentialRotatedAt) {
    throw new Error("Malformed collaboration session state: rotated credential lacks rotation timestamp");
  }
  if (session.resumeRecovery) {
    if (session.resumeRecovery.targetGeneration !== session.credentialGeneration ||
        session.resumeRecovery.sourceGeneration + 1 !== session.resumeRecovery.targetGeneration ||
        session.resumeRecovery.previousCredentialVerifier.generation !== session.resumeRecovery.sourceGeneration) {
      throw new Error("Malformed collaboration session state: inconsistent resume recovery generation");
    }
    if (Date.parse(session.resumeRecovery.recoveryUntil) < Date.parse(session.resumeRecovery.rotatedAt)) {
      throw new Error("Malformed collaboration session state: recovery window precedes rotation");
    }
    if (session.lastCredentialRotatedAt !== session.resumeRecovery.rotatedAt) {
      throw new Error("Malformed collaboration session state: recovery rotation timestamp mismatch");
    }
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
  if ((status === "released" || status === "revoked") && session.resumeRecovery) {
    throw new Error("Malformed collaboration session state: terminal session retains resume recovery");
  }
  if (runtimeOwnerMode === "required-for-live" &&
      (status === "active" || status === "expired") && !session.runtimeOwner) {
    throw new Error("Malformed collaboration session state: live or resumable session lacks runtime owner");
  }
  if (runtimeOwnerMode === "required-for-live" && process.platform === "linux" &&
      (status === "active" || status === "expired") &&
      (!session.runtimeOwner?.bootId || !session.runtimeOwner.processStartMarker)) {
    throw new Error("Malformed collaboration session state: Linux live owner tuple is incomplete");
  }
  if ((status === "released" || status === "revoked") && session.runtimeOwner) {
    throw new Error("Malformed collaboration session state: terminal session retains runtime owner");
  }
  if (session.revocationReason && status !== "revoked") {
    throw new Error("Malformed collaboration session state: non-revoked session has revocation reason");
  }
  return session;
}

function validateLegacyState(
  value: unknown,
  expectedProjectKey: string,
  maxSessions: number,
): LegacyStoredCollaborationSessionState {
  if (!isRecord(value) || value.version !== 1 || value.projectKey !== expectedProjectKey || !Array.isArray(value.sessions)) {
    throw new Error("Malformed or mismatched legacy collaboration session state");
  }
  assertOnlyKeys(value, ["version", "projectKey", "sessions"], "legacy collaboration session state");
  if (value.sessions.length > maxSessions) {
    throw new Error("Malformed legacy collaboration session state: session limit exceeded");
  }
  const ids = new Set<string>();
  const sessions = value.sessions.map((candidate) => validateLegacyStoredSession(candidate, expectedProjectKey, ids));
  return { version: 1, projectKey: expectedProjectKey, sessions };
}

function validateLegacyStoredSession(
  value: unknown,
  expectedProjectKey: string,
  ids: Set<string>,
): LegacyStoredCollaborationSession {
  if (!isRecord(value)) throw new Error("Malformed legacy collaboration session state: invalid session");
  assertOnlyKeys(value, [
    "collaborationSessionId",
    "projectKey",
    "agentId",
    "agentName",
    "label",
    "requestedRoleId",
    "status",
    "createdAt",
    "updatedAt",
    "lastSeenAt",
    "expiresAt",
    "resumeUntil",
    "releasedAt",
    "revokedAt",
    "revision",
    "credentialHash",
  ], "legacy collaboration session");
  const collaborationSessionId = validateSessionId(value.collaborationSessionId);
  if (ids.has(collaborationSessionId)) throw new Error("Malformed legacy collaboration session state: duplicate session ID");
  ids.add(collaborationSessionId);
  if (value.projectKey !== expectedProjectKey) {
    throw new Error("Malformed legacy collaboration session state: mismatched project key");
  }
  const status = validateStatus(value.status);
  const session: LegacyStoredCollaborationSession = {
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
    credentialHash: validateMac(value.credentialHash, "legacy credential hash"),
  };
  if (Date.parse(session.resumeUntil) < Date.parse(session.expiresAt)) {
    throw new Error("Malformed legacy collaboration session state: resume window precedes expiry");
  }
  if (status === "released" && !session.releasedAt) {
    throw new Error("Malformed legacy collaboration session state: released session lacks releasedAt");
  }
  if (status !== "released" && session.releasedAt) {
    throw new Error("Malformed legacy collaboration session state: non-released session has releasedAt");
  }
  if (status === "revoked" && !session.revokedAt) {
    throw new Error("Malformed legacy collaboration session state: revoked session lacks revokedAt");
  }
  if (status !== "revoked" && session.revokedAt) {
    throw new Error("Malformed legacy collaboration session state: non-revoked session has revokedAt");
  }
  return session;
}

function migrateLegacyState(
  legacy: LegacyStoredCollaborationSessionState,
  credentialKey: ValidatedCredentialKey,
  now: Date,
): StoredCollaborationSessionState {
  const migratedAt = now.toISOString();
  const state = emptyState(legacy.projectKey, credentialKey);
  return withSessions(state, legacy.sessions.map((session) => {
    const { credentialHash, ...publicFields } = session;
    const credentialGeneration = 1;
    return {
      ...publicFields,
      status: "revoked" as const,
      updatedAt: migratedAt,
      releasedAt: undefined,
      revokedAt: session.revokedAt ?? migratedAt,
      credentialGeneration,
      revision: session.revision + 1,
      credentialVerifier: {
        version: COLLABORATION_SESSION_CREDENTIAL_VERSION,
        keyId: credentialKey.keyId,
        generation: credentialGeneration,
        mac: keyedDigest(credentialKey, LEGACY_TOMBSTONE_DOMAIN, [
          session.projectKey,
          session.collaborationSessionId,
          session.agentId,
          credentialHash,
          String(session.revision),
        ]),
      },
    };
  }));
}

function migrateVersionTwoState(
  versionTwo: VersionTwoStoredCollaborationSessionState,
  credentialKey: ValidatedCredentialKey,
  now: Date,
): StoredCollaborationSessionState {
  const migratedAt = now.toISOString();
  const state = emptyState(versionTwo.projectKey, credentialKey);
  return withSessions(state, versionTwo.sessions.map((session) => {
    if (session.status === "released" || session.status === "revoked") return session;
    return {
      ...session,
      status: "revoked" as const,
      runtimeOwner: undefined,
      revocationReason: "runtime_lost" as const,
      updatedAt: migratedAt,
      releasedAt: undefined,
      revokedAt: migratedAt,
      resumeRecovery: undefined,
      revision: session.revision + 1,
    };
  }));
}

type StoredRoleBindingFields = Pick<
  CollaborationSession,
  | "requestKind"
  | "requestedRoleFingerprint"
  | "assignedRoleId"
  | "occupancyLabel"
  | "roleContractId"
  | "roleContractVersion"
>;

function validateRoleBinding(value: unknown): Partial<StoredRoleBindingFields> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error("roleBinding must be an object");
  assertOnlyKeys(
    value,
    ["requestKind", "requestedRoleFingerprint", "roleAssignment"],
    "collaboration session role binding",
  );
  const requestKind = validateRoleRequestKind(value.requestKind);
  const requestedRoleFingerprint = validateRoleFingerprint(value.requestedRoleFingerprint);
  if (!isRecord(value.roleAssignment)) throw new Error("roleBinding.roleAssignment must be an object");
  assertOnlyKeys(
    value.roleAssignment,
    ["assignmentSource", "canonicalRoleId", "occupancyLabel", "contractId", "contractVersion"],
    "collaboration session role assignment",
  );
  const roleAssignment = validatePersistedCollaborationRoleAssignment({
    assignmentSource: value.roleAssignment.assignmentSource as "server_session_policy",
    canonicalRoleId: value.roleAssignment.canonicalRoleId,
    occupancyLabel: value.roleAssignment.occupancyLabel,
    contractId: value.roleAssignment.contractId,
    contractVersion: value.roleAssignment.contractVersion,
  });
  if (requestKind === "custom") {
    const expectedOccupancy = `custom-${requestedRoleFingerprint}`;
    if (roleAssignment.canonicalRoleId !== "collaborator" || roleAssignment.occupancyLabel !== expectedOccupancy) {
      throw new Error("custom role binding must use the non-privileged collaborator assignment and fingerprint occupancy");
    }
  }
  return {
    requestKind,
    requestedRoleFingerprint,
    assignedRoleId: roleAssignment.canonicalRoleId,
    occupancyLabel: roleAssignment.occupancyLabel,
    roleContractId: roleAssignment.contractId,
    roleContractVersion: roleAssignment.contractVersion,
  };
}

function validateStoredRoleBinding(
  value: Record<string, unknown>,
): Partial<StoredRoleBindingFields> {
  const fields = [
    "requestKind",
    "requestedRoleFingerprint",
    "assignedRoleId",
    "occupancyLabel",
    "roleContractId",
    "roleContractVersion",
  ] as const;
  const present = fields.filter((field) => value[field] !== undefined);
  if (present.length === 0) return {};
  if (present.length !== fields.length) {
    throw new Error("Malformed collaboration session state: role binding must include all provenance and assignment fields");
  }
  return validateRoleBinding({
    requestKind: value.requestKind,
    requestedRoleFingerprint: value.requestedRoleFingerprint,
    roleAssignment: {
      assignmentSource: "server_session_policy",
      canonicalRoleId: value.assignedRoleId,
      occupancyLabel: value.occupancyLabel,
      contractId: value.roleContractId,
      contractVersion: value.roleContractVersion,
    },
  });
}

function validateRoleRequestKind(value: unknown): Exclude<CollaborationRoleRequestKind, "none"> {
  if (value !== "recognized" && value !== "custom") {
    throw new Error("roleBinding.requestKind must be recognized or custom");
  }
  return value;
}

function validateRoleFingerprint(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{16}$/.test(value)) {
    throw new Error("roleBinding.requestedRoleFingerprint must be a 16-character lowercase hexadecimal value");
  }
  return value;
}

function validateOptionalRevocationReason(value: unknown): StoredRevocationReason | undefined {
  if (value === undefined) return undefined;
  if (value !== "runtime_lost") {
    throw new Error("Malformed collaboration session state: invalid revocation reason");
  }
  return value;
}

function validateOptionalRuntimeOwner(value: unknown): StoredRuntimeOwner | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error("Malformed collaboration session state: invalid runtime owner");
  }
  assertOnlyKeys(
    value,
    ["version", "runtimeInstanceId", "pid", "bootId", "processStartMarker"],
    "collaboration session runtime owner",
  );
  if (value.version !== 1 ||
      typeof value.runtimeInstanceId !== "string" ||
      !RUNTIME_INSTANCE_ID_PATTERN.test(value.runtimeInstanceId) ||
      !Number.isSafeInteger(value.pid) || (value.pid as number) < 1) {
    throw new Error("Malformed collaboration session state: invalid runtime owner identity");
  }
  if (value.bootId !== undefined &&
      (typeof value.bootId !== "string" || !LINUX_BOOT_ID_PATTERN.test(value.bootId))) {
    throw new Error("Malformed collaboration session state: invalid Linux boot ID");
  }
  if (value.processStartMarker !== undefined &&
      (typeof value.processStartMarker !== "string" ||
       !PROCESS_START_MARKER_PATTERN.test(value.processStartMarker))) {
    throw new Error("Malformed collaboration session state: invalid process start marker");
  }
  return {
    version: 1,
    runtimeInstanceId: value.runtimeInstanceId,
    pid: value.pid as number,
    bootId: value.bootId as string | undefined,
    processStartMarker: value.processStartMarker as string | undefined,
  };
}

function requireCurrentRuntimeOwner(session: StoredCollaborationSession): void {
  // Terminal tombstones intentionally clear their runtime owner. A valid bearer
  // may still inspect the terminal status or receive its precise terminal error,
  // but no released/revoked session can be resumed or mutated. Active and
  // expired-resumable sessions remain pinned to the complete runtime tuple.
  if (session.status === "released" || session.status === "revoked") return;
  if (!session.runtimeOwner || !sameRuntimeOwner(session.runtimeOwner, LOCAL_RUNTIME_OWNER)) {
    throw new Error("Collaboration session belongs to a different PiLink runtime");
  }
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

function validateCredentialKey(value: unknown): ValidatedCredentialKey {
  if (!isRecord(value)) throw new Error("credentialKey must be provided explicitly");
  assertOnlyKeys(value, ["keyId", "keyMaterial"], "credentialKey");
  const keyId = validateOptionalIdentifier(value.keyId, "credentialKey.keyId", SESSION_KEY_ID_MAX_BYTES);
  if (!keyId) throw new Error("credentialKey.keyId is required");
  if (typeof value.keyMaterial !== "string" ||
      !SESSION_KEY_MATERIAL_PATTERN.test(value.keyMaterial) ||
      value.keyMaterial.includes("=")) {
    throw new Error("credentialKey.keyMaterial must be unpadded base64url");
  }
  const keyMaterial = Buffer.from(value.keyMaterial, "base64url");
  if (keyMaterial.length < 32 || keyMaterial.length > 64 || keyMaterial.toString("base64url") !== value.keyMaterial) {
    throw new Error("credentialKey.keyMaterial must encode between 32 and 64 bytes");
  }
  return { keyId, keyMaterial: Buffer.from(keyMaterial) };
}

function validateCredentialVerifier(value: unknown, expectedKeyId: string): StoredCredentialVerifier {
  if (!isRecord(value)) throw new Error("Malformed collaboration session state: invalid credential verifier");
  assertOnlyKeys(value, ["version", "keyId", "generation", "mac"], "credential verifier");
  if (value.version !== COLLABORATION_SESSION_CREDENTIAL_VERSION) {
    throw new Error("Malformed collaboration session state: unsupported credential verifier version");
  }
  const keyId = validateOptionalIdentifier(value.keyId, "credentialVerifier.keyId", SESSION_KEY_ID_MAX_BYTES);
  if (keyId !== expectedKeyId) {
    throw new Error("Collaboration session credential key ID does not match the configured server key");
  }
  return {
    version: COLLABORATION_SESSION_CREDENTIAL_VERSION,
    keyId,
    generation: validateGeneration(value.generation, "credentialVerifier.generation"),
    mac: validateMac(value.mac, "credential verifier MAC"),
  };
}

function validateResumeRecovery(value: unknown, expectedKeyId: string): StoredResumeRecovery {
  if (!isRecord(value)) throw new Error("Malformed collaboration session state: invalid resume recovery");
  assertOnlyKeys(value, [
    "sourceGeneration",
    "targetGeneration",
    "previousCredentialVerifier",
    "requestIdMac",
    "ttlSeconds",
    "recoveryUntil",
    "rotatedAt",
  ], "resume recovery");
  return {
    sourceGeneration: validateGeneration(value.sourceGeneration, "resumeRecovery.sourceGeneration"),
    targetGeneration: validateGeneration(value.targetGeneration, "resumeRecovery.targetGeneration"),
    previousCredentialVerifier: validateCredentialVerifier(value.previousCredentialVerifier, expectedKeyId),
    requestIdMac: validateMac(value.requestIdMac, "resume request MAC"),
    ttlSeconds: validateTtlSeconds(value.ttlSeconds, "resumeRecovery.ttlSeconds"),
    recoveryUntil: validateDate(value.recoveryUntil, "resumeRecovery.recoveryUntil"),
    rotatedAt: validateDate(value.rotatedAt, "resumeRecovery.rotatedAt"),
  };
}

function validateMac(value: unknown, field: string): string {
  if (typeof value !== "string" || !SESSION_MAC_PATTERN.test(value)) {
    throw new Error(`Malformed collaboration session state: invalid ${field}`);
  }
  return value;
}

function validateGeneration(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value as number;
}

function validateResumeRequestId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._~-]{16,128}$/.test(value) ||
      Buffer.byteLength(value, "utf8") > COLLABORATION_SESSION_RESUME_REQUEST_ID_MAX_BYTES) {
    throw new Error("resumeRequestId must be 16-128 URL-safe opaque characters");
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

function validateBoundedSeconds(value: unknown, field: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new Error(`${field} must be an integer between 1 and ${maximum}`);
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

function assertOnlyKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknown.length > 0) throw new Error(`Malformed ${label}: unknown field`);
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
