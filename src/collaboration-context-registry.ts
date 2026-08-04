import { createHmac } from "node:crypto";
import type { CollaborationBootstrap, VerifiedCollaborationContext } from "./collaboration-bootstrap.js";
import type { CollaborationSessionIdentity } from "./collaboration-sessions.js";

const BINDING_DOMAIN = "pilink/collaboration-context-binding/v1";
const MAX_BINDING_BYTES = 512;

export interface CollaborationContextRegistryOptions {
  bindingKeyMaterial: string | Buffer;
  detachGraceSeconds: number;
  createBootstrap(identity: Readonly<CollaborationSessionIdentity>): CollaborationBootstrap;
  onLogicalSessionDispose?: (context: Readonly<VerifiedCollaborationContext>) => void | Promise<void>;
  onDisposeError?: (error: unknown) => void;
}

export interface CollaborationContextAttachment {
  readonly initialized: boolean;
  readonly sharedLogicalSession: true;
  initialize: CollaborationBootstrap["initialize"];
  verify: CollaborationBootstrap["verify"];
  dispose(): Promise<void>;
}

interface RegistryEntry {
  readonly key: string;
  readonly actorId: string;
  readonly actorName: string;
  readonly clientVersion: number;
  readonly bootstrap: CollaborationBootstrap;
  references: number;
  lastSeenAtMs: number;
  disposeTimer?: NodeJS.Timeout;
  disposing?: Promise<void>;
}

/**
 * Process-local registry that preserves one private collaboration bearer across
 * short-lived MCP transports sharing a trusted, non-model-visible binding.
 *
 * The raw binding is never stored. It is reduced immediately to a keyed digest
 * scoped to the authenticated OAuth actor and client credential version.
 */
export class CollaborationContextRegistry {
  private readonly bindingKeyMaterial: Buffer;
  private readonly detachGraceMs: number;
  private readonly createBootstrap: CollaborationContextRegistryOptions["createBootstrap"];
  private readonly onLogicalSessionDispose?: CollaborationContextRegistryOptions["onLogicalSessionDispose"];
  private readonly onDisposeError: (error: unknown) => void;
  private readonly entries = new Map<string, RegistryEntry>();
  private disposed = false;

  public constructor(options: CollaborationContextRegistryOptions) {
    this.bindingKeyMaterial = normalizeKeyMaterial(options.bindingKeyMaterial);
    if (!Number.isSafeInteger(options.detachGraceSeconds) || options.detachGraceSeconds < 1) {
      throw new Error("detachGraceSeconds must be a positive integer");
    }
    this.detachGraceMs = options.detachGraceSeconds * 1_000;
    this.createBootstrap = options.createBootstrap;
    this.onLogicalSessionDispose = options.onLogicalSessionDispose;
    this.onDisposeError = options.onDisposeError || (() => undefined);
  }

  public attach(input: {
    identity: Readonly<CollaborationSessionIdentity>;
    clientVersion: number;
    logicalBinding: string;
  }): CollaborationContextAttachment {
    if (this.disposed) throw new Error("Collaboration context registry is disposed");
    const identity = normalizeIdentity(input.identity);
    const clientVersion = normalizeClientVersion(input.clientVersion);
    const logicalBinding = normalizeLogicalBinding(input.logicalBinding);
    const key = deriveBindingKey(this.bindingKeyMaterial, identity.agentId, clientVersion, logicalBinding);

    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        key,
        actorId: identity.agentId,
        actorName: identity.agentName,
        clientVersion,
        bootstrap: this.createBootstrap(identity),
        references: 0,
        lastSeenAtMs: Date.now(),
      };
      this.entries.set(key, entry);
    } else {
      assertEntryBinding(entry, identity, clientVersion);
    }

    if (entry.disposeTimer) {
      clearTimeout(entry.disposeTimer);
      entry.disposeTimer = undefined;
    }
    entry.references += 1;
    entry.lastSeenAtMs = Date.now();

    let detached = false;
    return {
      sharedLogicalSession: true,
      get initialized() {
        return entry!.bootstrap.initialized;
      },
      initialize: (requestedRoleLabel) => entry!.bootstrap.initialize(requestedRoleLabel),
      verify: () => entry!.bootstrap.verify(),
      dispose: async () => {
        if (detached) return;
        detached = true;
        this.detach(entry!);
      },
    };
  }

  public async disposeAll(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(entries.map(async (entry) => {
      if (entry.disposeTimer) clearTimeout(entry.disposeTimer);
      await this.disposeEntry(entry);
    }));
  }

  private detach(entry: RegistryEntry): void {
    if (entry.references > 0) entry.references -= 1;
    entry.lastSeenAtMs = Date.now();
    if (entry.references > 0 || entry.disposeTimer || entry.disposing || this.disposed) return;
    entry.disposeTimer = setTimeout(() => {
      entry.disposeTimer = undefined;
      if (entry.references > 0 || this.entries.get(entry.key) !== entry) return;
      this.entries.delete(entry.key);
      void this.disposeEntry(entry);
    }, this.detachGraceMs);
    entry.disposeTimer.unref();
  }

  private async disposeEntry(entry: RegistryEntry): Promise<void> {
    if (entry.disposing) return entry.disposing;
    entry.disposing = (async () => {
      if (entry.bootstrap.initialized && this.onLogicalSessionDispose) {
        try {
          const context = await entry.bootstrap.verify();
          await this.onLogicalSessionDispose(context);
        } catch (error) {
          this.onDisposeError(error);
        }
      }
      try {
        await entry.bootstrap.dispose();
      } catch (error) {
        this.onDisposeError(error);
      }
    })();
    await entry.disposing;
  }
}

function deriveBindingKey(
  keyMaterial: Buffer,
  actorId: string,
  clientVersion: number,
  logicalBinding: string,
): string {
  return createHmac("sha256", keyMaterial)
    .update(BINDING_DOMAIN, "utf8")
    .update("\0", "utf8")
    .update(actorId, "utf8")
    .update("\0", "utf8")
    .update(String(clientVersion), "utf8")
    .update("\0", "utf8")
    .update(logicalBinding, "utf8")
    .digest("base64url");
}

function normalizeKeyMaterial(value: string | Buffer): Buffer {
  const material = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value, "utf8");
  if (material.length < 32) throw new Error("bindingKeyMaterial must contain at least 32 bytes");
  return material;
}

function normalizeLogicalBinding(value: string): string {
  if (typeof value !== "string") throw new Error("logical collaboration binding must be a string");
  const normalized = value.trim();
  if (!normalized) throw new Error("logical collaboration binding must be non-empty");
  if (Buffer.byteLength(normalized, "utf8") > MAX_BINDING_BYTES) {
    throw new Error(`logical collaboration binding exceeds ${MAX_BINDING_BYTES} UTF-8 bytes`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error("logical collaboration binding contains control characters");
  }
  return normalized;
}

function normalizeIdentity(
  identity: Readonly<CollaborationSessionIdentity>,
): Readonly<CollaborationSessionIdentity> {
  const agentId = identity.agentId.trim();
  const agentName = identity.agentName.trim();
  if (!agentId || !agentName) throw new Error("authenticated collaboration identity must be non-empty");
  return Object.freeze({ agentId, agentName });
}

function normalizeClientVersion(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("clientVersion must be a positive integer");
  return value;
}

function assertEntryBinding(
  entry: RegistryEntry,
  identity: Readonly<CollaborationSessionIdentity>,
  clientVersion: number,
): void {
  if (entry.actorId !== identity.agentId ||
      entry.actorName !== identity.agentName ||
      entry.clientVersion !== clientVersion) {
    throw new Error("Trusted collaboration binding does not match the authenticated OAuth actor");
  }
}
