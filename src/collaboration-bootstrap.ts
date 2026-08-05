import { randomUUID } from "node:crypto";
import {
  createNewCollaborationRoleAssignment,
  resolveCollaborationRoleRequest,
  validatePersistedCollaborationRoleAssignment,
  type CollaborationRoleRequestKind,
  type VerifiedCollaborationRoleAssignment,
} from "./collaboration-roles.js";
import {
  COLLABORATION_SESSION_LABEL_MAX_BYTES,
  type CollaborationSession,
  type CollaborationSessionCredential,
  type CollaborationSessionIdentity,
  type CollaborationSessionStore,
} from "./collaboration-sessions.js";

export interface CollaborationRoleRequestProvenance {
  requestKind: Exclude<CollaborationRoleRequestKind, "none">;
  requestedRoleFingerprint: string;
}

/**
 * Public connection-scoped context. It deliberately excludes the raw or
 * normalized role request and the private collaboration-session bearer.
 */
export interface VerifiedCollaborationContext extends CollaborationSessionIdentity {
  collaborationSessionId: string;
  requestKind: Exclude<CollaborationRoleRequestKind, "none">;
  requestedRoleFingerprint: string;
  roleAssignment: VerifiedCollaborationRoleAssignment;
}

export interface CollaborationBootstrapOptions {
  sessionStore: CollaborationSessionStore;
  identity: Readonly<CollaborationSessionIdentity>;
  sessionLabel?: string;
  ttlSeconds?: number;
}

/**
 * Trusted state owned by one MCP server connection.
 *
 * Raw role text enters only initialize(), is resolved by the canonical registry,
 * and is immediately reduced to bounded provenance plus a pinned assignment.
 * The session bearer remains private to this instance for its entire lifecycle.
 */
export class CollaborationBootstrap {
  private readonly sessionStore: CollaborationSessionStore;
  private readonly identity: Readonly<CollaborationSessionIdentity>;
  private readonly sessionLabel?: string;
  private readonly ttlSeconds?: number;
  private queue: Promise<void> = Promise.resolve();
  private credential?: CollaborationSessionCredential;
  private expectedProvenance?: Readonly<CollaborationRoleRequestProvenance>;
  private expectedAssignment?: Readonly<VerifiedCollaborationRoleAssignment>;
  private context?: Readonly<VerifiedCollaborationContext>;
  private pendingResumeRequestId?: string;
  private disposeRequested = false;
  private disposePromise?: Promise<void>;

  public constructor(options: CollaborationBootstrapOptions) {
    this.sessionStore = options.sessionStore;
    this.identity = Object.freeze({
      agentId: normalizeRequiredText(options.identity.agentId, "identity.agentId", 256),
      agentName: normalizeRequiredText(options.identity.agentName, "identity.agentName", 100),
    });
    this.sessionLabel = normalizeOptionalText(
      options.sessionLabel,
      "sessionLabel",
      COLLABORATION_SESSION_LABEL_MAX_BYTES,
    );
    if (options.ttlSeconds !== undefined && (!Number.isSafeInteger(options.ttlSeconds) || options.ttlSeconds < 1)) {
      throw new Error("ttlSeconds must be a positive integer when provided");
    }
    this.ttlSeconds = options.ttlSeconds;
  }

  public get initialized(): boolean {
    return this.credential !== undefined;
  }

  /**
   * Resolve and pin one role request for this MCP connection.
   * Repeating the same normalized request is idempotent; a conflicting request
   * fails closed and cannot mutate the established assignment.
   */
  public async initialize(requestedRoleLabel: unknown): Promise<Readonly<VerifiedCollaborationContext>> {
    if (this.disposeRequested) throw new Error("collaboration bootstrap connection is disposed");
    const resolved = resolveCollaborationRoleRequest(requestedRoleLabel);
    if (resolved.kind === "none" || !resolved.requestedRoleFingerprint ||
        !resolved.canonicalRoleId || !resolved.occupancyLabel) {
      throw new Error("collaboration bootstrap requires a non-empty role label");
    }
    const provenance = Object.freeze({
      requestKind: resolved.kind,
      requestedRoleFingerprint: resolved.requestedRoleFingerprint,
    } satisfies CollaborationRoleRequestProvenance);
    const assignment = createNewCollaborationRoleAssignment({
      assignmentSource: "server_session_policy",
      canonicalRoleId: resolved.canonicalRoleId,
      occupancyLabel: resolved.occupancyLabel,
    });

    return this.enqueue(async () => {
      if (this.disposeRequested) throw new Error("collaboration bootstrap connection is disposed");
      if (this.credential) {
        if (!sameProvenance(this.requireExpectedProvenance(), provenance) ||
            !sameAssignment(this.requireExpectedAssignment(), assignment)) {
          throw new Error("collaboration bootstrap already initialized with a different role request");
        }
        return this.ensureActiveUnlocked();
      }

      const credential = await this.sessionStore.start({
        ...this.identity,
        label: this.sessionLabel,
        roleBinding: {
          requestKind: provenance.requestKind,
          requestedRoleFingerprint: provenance.requestedRoleFingerprint,
          roleAssignment: assignment,
        },
        ttlSeconds: this.ttlSeconds,
      });
      this.expectedProvenance = provenance;
      this.expectedAssignment = assignment;
      this.credential = credential;
      this.context = this.contextFromSession(credential.session);
      if (this.disposeRequested) {
        await this.releaseUnlocked();
        throw new Error("collaboration bootstrap connection was disposed during initialization");
      }
      return this.context;
    });
  }

  /** Verify liveness and transparently resume while this trusted instance survives. */
  public async verify(): Promise<Readonly<VerifiedCollaborationContext>> {
    if (this.disposeRequested) throw new Error("collaboration bootstrap connection is disposed");
    return this.enqueue(() => this.ensureActiveUnlocked());
  }

  /** Explicitly release the initialized logical session. */
  public async release(): Promise<CollaborationSession> {
    return this.enqueue(() => this.releaseUnlocked());
  }

  /**
   * Best-effort final MCP-handle cleanup. The request is marked synchronously,
   * then serialized behind any in-flight initialization before checking for and
   * releasing a credential. Repeated calls return the same completion promise.
   */
  public dispose(): Promise<void> {
    this.disposeRequested = true;
    if (!this.disposePromise) {
      this.disposePromise = this.enqueue(async () => {
        if (!this.credential) return;
        try {
          await this.releaseUnlocked();
        } catch {
          // Final cleanup must not mask transport disposal. Quota and task
          // recovery still have bounded expiry paths if release cannot complete.
        }
      });
    }
    return this.disposePromise;
  }

  private async releaseUnlocked(): Promise<CollaborationSession> {
    const credential = this.requireCredential();
    const inspected = await this.sessionStore.inspect({
      agentId: this.identity.agentId,
      collaborationSessionHandle: credential.collaborationSessionHandle,
    });
    this.assertSessionBinding(inspected);
    if (inspected.status === "released") return inspected;
    if (inspected.status === "revoked") {
      throw new Error("collaboration session was revoked and cannot be released");
    }
    const released = await this.sessionStore.release({
      agentId: this.identity.agentId,
      collaborationSessionHandle: credential.collaborationSessionHandle,
    });
    this.assertSessionBinding(released);
    return released;
  }

  private async ensureActiveUnlocked(): Promise<Readonly<VerifiedCollaborationContext>> {
    const credential = this.requireCredential();

    if (this.pendingResumeRequestId) {
      const resumed = await this.resumeUnlocked(credential, this.pendingResumeRequestId);
      this.pendingResumeRequestId = undefined;
      return this.updateCredential(resumed);
    }

    const inspected = await this.sessionStore.inspect({
      agentId: this.identity.agentId,
      collaborationSessionHandle: credential.collaborationSessionHandle,
    });
    this.assertSessionBinding(inspected);
    this.validatePinnedBinding(inspected);

    if (inspected.status === "expired") {
      const requestId = randomUUID();
      this.pendingResumeRequestId = requestId;
      const resumed = await this.resumeUnlocked(credential, requestId);
      this.pendingResumeRequestId = undefined;
      return this.updateCredential(resumed);
    }
    if (inspected.status === "released") {
      throw new Error("collaboration session was released; create a new MCP connection");
    }
    if (inspected.status === "revoked") {
      throw new Error("collaboration session was revoked; create a new MCP connection");
    }

    const active = await this.sessionStore.authenticate({
      agentId: this.identity.agentId,
      collaborationSessionHandle: credential.collaborationSessionHandle,
    });
    this.assertSessionBinding(active);
    this.context = this.contextFromSession(active);
    return this.context;
  }

  private resumeUnlocked(
    credential: CollaborationSessionCredential,
    resumeRequestId: string,
  ): Promise<CollaborationSessionCredential> {
    return this.sessionStore.resume({
      ...this.identity,
      collaborationSessionHandle: credential.collaborationSessionHandle,
      resumeRequestId,
      ttlSeconds: this.ttlSeconds,
    });
  }

  private updateCredential(credential: CollaborationSessionCredential): Readonly<VerifiedCollaborationContext> {
    this.assertSessionBinding(credential.session);
    this.credential = credential;
    this.context = this.contextFromSession(credential.session);
    return this.context;
  }

  private contextFromSession(session: CollaborationSession): Readonly<VerifiedCollaborationContext> {
    this.assertSessionBinding(session);
    const roleAssignment = this.validatePinnedBinding(session);
    if (!session.requestKind || !session.requestedRoleFingerprint) {
      throw new Error("collaboration session lacks verified role-request provenance");
    }
    return Object.freeze({
      agentId: session.agentId,
      agentName: session.agentName,
      collaborationSessionId: session.collaborationSessionId,
      requestKind: session.requestKind,
      requestedRoleFingerprint: session.requestedRoleFingerprint,
      roleAssignment,
    });
  }

  private validatePinnedBinding(session: CollaborationSession): VerifiedCollaborationRoleAssignment {
    if (!session.requestKind || !session.requestedRoleFingerprint) {
      throw new Error("collaboration session lacks verified role-request provenance");
    }
    if (!session.assignedRoleId || !session.occupancyLabel ||
        !session.roleContractId || !session.roleContractVersion) {
      throw new Error("collaboration session lacks a complete pinned role assignment");
    }
    const persisted = validatePersistedCollaborationRoleAssignment({
      assignmentSource: "server_session_policy",
      canonicalRoleId: session.assignedRoleId,
      occupancyLabel: session.occupancyLabel,
      contractId: session.roleContractId,
      contractVersion: session.roleContractVersion,
    });
    if (!sameProvenance(this.requireExpectedProvenance(), {
      requestKind: session.requestKind,
      requestedRoleFingerprint: session.requestedRoleFingerprint,
    }) || !sameAssignment(this.requireExpectedAssignment(), persisted)) {
      throw new Error("persisted collaboration role binding does not match the verified connection bootstrap");
    }
    return persisted;
  }

  private assertSessionBinding(session: CollaborationSession): void {
    if (session.agentId !== this.identity.agentId || session.agentName !== this.identity.agentName) {
      throw new Error("collaboration session identity does not match the authenticated OAuth actor");
    }
    if (this.credential && session.collaborationSessionId !== this.credential.session.collaborationSessionId) {
      throw new Error("collaboration session changed during the connection lifecycle");
    }
  }

  private requireCredential(): CollaborationSessionCredential {
    if (!this.credential) throw new Error("collaboration bootstrap has not been initialized");
    return this.credential;
  }

  private requireExpectedProvenance(): Readonly<CollaborationRoleRequestProvenance> {
    if (!this.expectedProvenance) throw new Error("collaboration bootstrap role provenance is unavailable");
    return this.expectedProvenance;
  }

  private requireExpectedAssignment(): Readonly<VerifiedCollaborationRoleAssignment> {
    if (!this.expectedAssignment) throw new Error("collaboration bootstrap role assignment is unavailable");
    return this.expectedAssignment;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.queue.then(operation);
    this.queue = queued.then(() => undefined, () => undefined);
    return queued;
  }
}

function sameProvenance(
  left: Readonly<CollaborationRoleRequestProvenance>,
  right: Readonly<CollaborationRoleRequestProvenance>,
): boolean {
  return left.requestKind === right.requestKind &&
    left.requestedRoleFingerprint === right.requestedRoleFingerprint;
}

function sameAssignment(
  left: Readonly<VerifiedCollaborationRoleAssignment>,
  right: Readonly<VerifiedCollaborationRoleAssignment>,
): boolean {
  return left.assignmentSource === right.assignmentSource &&
    left.canonicalRoleId === right.canonicalRoleId &&
    left.occupancyLabel === right.occupancyLabel &&
    left.contractId === right.contractId &&
    left.contractVersion === right.contractVersion;
}

function normalizeRequiredText(value: unknown, field: string, maximumBytes: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} must be non-empty`);
  if (Buffer.byteLength(normalized, "utf8") > maximumBytes) {
    throw new Error(`${field} exceeds ${maximumBytes} UTF-8 bytes`);
  }
  return normalized;
}

function normalizeOptionalText(value: unknown, field: string, maximumBytes: number): string | undefined {
  return value === undefined ? undefined : normalizeRequiredText(value, field, maximumBytes);
}
