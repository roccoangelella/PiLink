import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { validateAgentRoleAssignment } from "./roles.js";
import { redactAgentError } from "./redaction.js";
import {
  AGENT_PERMISSIONS,
  type AgentManagerEvent,
  type AgentManagerListener,
  type AgentOutputEntry,
  type AgentOutputReadResult,
  type AgentPermission,
  type AgentRuntimeAdapter,
  type AgentRuntimeEvent,
  type AgentRuntimeHandle,
  type AgentSnapshot,
  type AgentSpawnRequest,
  type AgentStatus,
} from "./types.js";

const RUNTIME_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const AGENT_ID_PATTERN = /^agent_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const LABEL_MAX_BYTES = 100;
const TASK_ID_MAX_BYTES = 256;
const CONTROLLER_ID_MAX_BYTES = 256;
const ERROR_MAX_BYTES = 2 * 1024;
const DEFAULT_MESSAGE_MAX_BYTES = 64 * 1024;
const DEFAULT_OUTPUT_MAX_BYTES = 64 * 1024;
const DEFAULT_MAX_RETAINED_AGENTS = 500;
const DEFAULT_MAX_RETAINED_OUTPUT_ENTRIES = 200;
const DEFAULT_MAX_RETAINED_OUTPUT_BYTES = 256 * 1024;
const TERMINAL_STATUSES = new Set<AgentStatus>(["completed", "failed", "stopped"]);
const ACTIVE_STATUSES = new Set<AgentStatus>([
  "starting",
  "running",
  "waiting",
  "cancelling",
  "stopping",
  "stop_failed",
]);
const ALL_PERMISSIONS = new Set<string>(AGENT_PERMISSIONS);

export interface AgentManagerOptions {
  adapters: readonly AgentRuntimeAdapter[];
  allowedWorkspaceRoots: readonly string[];
  allowedPermissions: readonly AgentPermission[];
  maxConcurrentAgents: number;
  maxRetainedAgents?: number;
  maxMessageBytes?: number;
  maxOutputBytes?: number;
  maxRetainedOutputEntries?: number;
  maxRetainedOutputBytes?: number;
  now?: () => Date;
  idFactory?: () => string;
}

interface ManagedAgent {
  /** Private ownership boundary; deliberately absent from AgentSnapshot. */
  controllerId: string;
  snapshot: AgentSnapshot;
  handle?: AgentRuntimeHandle;
  runtimeReleased: boolean;
  nextOutputCursor: number;
  outputBytes: number;
  output: AgentOutputEntry[];
  handleReady: Promise<void>;
  resolveHandleReady: () => void;
  lifetime: AbortController;
  operationQueue: Promise<void>;
  controlQueue: Promise<void>;
  cancellationRevision: number;
}

interface ValidatedSpawn {
  controllerId: string;
  runtimeId: string;
  role: AgentSnapshot["role"];
  workspace: string;
  permissions: readonly AgentPermission[];
  initialMessage: string;
  taskId?: string;
  label?: string;
}

/**
 * Provider-neutral, fail-closed supervisor for local agent runtimes.
 *
 * It deliberately has no default adapter.  A caller must install a concrete
 * runtime and explicitly authorize workspace roots and every permission that
 * spawned agents may receive.
 */
export class AgentManager {
  private readonly adapters = new Map<string, AgentRuntimeAdapter>();
  private readonly allowedWorkspaceRoots: readonly string[];
  private readonly allowedPermissions: ReadonlySet<AgentPermission>;
  private readonly maxConcurrentAgents: number;
  private readonly maxRetainedAgents: number;
  private readonly maxMessageBytes: number;
  private readonly maxOutputBytes: number;
  private readonly maxRetainedOutputEntries: number;
  private readonly maxRetainedOutputBytes: number;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly agents = new Map<string, ManagedAgent>();
  private readonly listeners = new Set<AgentManagerListener>();
  private disposed = false;

  public constructor(options: AgentManagerOptions) {
    if (!options || typeof options !== "object") throw new Error("AgentManager options are required");
    if (!Array.isArray(options.adapters) || options.adapters.length === 0) {
      throw new Error("At least one explicit agent runtime adapter is required");
    }
    for (const adapter of options.adapters) {
      validateAdapter(adapter);
      if (this.adapters.has(adapter.id)) throw new Error(`Duplicate agent runtime adapter '${adapter.id}'`);
      this.adapters.set(adapter.id, adapter);
    }

    if (!Array.isArray(options.allowedWorkspaceRoots) || options.allowedWorkspaceRoots.length === 0) {
      throw new Error("At least one allowed workspace root is required");
    }
    this.allowedWorkspaceRoots = Object.freeze(options.allowedWorkspaceRoots.map(canonicalDirectory));
    this.allowedPermissions = new Set(validatePermissionList(options.allowedPermissions, "allowedPermissions"));
    this.maxConcurrentAgents = boundedInteger(options.maxConcurrentAgents, "maxConcurrentAgents", 1, 64);
    this.maxRetainedAgents = boundedInteger(
      options.maxRetainedAgents ?? DEFAULT_MAX_RETAINED_AGENTS,
      "maxRetainedAgents",
      this.maxConcurrentAgents,
      10_000,
    );
    this.maxMessageBytes = boundedInteger(
      options.maxMessageBytes ?? DEFAULT_MESSAGE_MAX_BYTES,
      "maxMessageBytes",
      1,
      1024 * 1024,
    );
    this.maxOutputBytes = boundedInteger(
      options.maxOutputBytes ?? DEFAULT_OUTPUT_MAX_BYTES,
      "maxOutputBytes",
      1,
      1024 * 1024,
    );
    this.maxRetainedOutputEntries = boundedInteger(
      options.maxRetainedOutputEntries ?? DEFAULT_MAX_RETAINED_OUTPUT_ENTRIES,
      "maxRetainedOutputEntries",
      1,
      10_000,
    );
    this.maxRetainedOutputBytes = boundedInteger(
      options.maxRetainedOutputBytes ?? DEFAULT_MAX_RETAINED_OUTPUT_BYTES,
      "maxRetainedOutputBytes",
      1,
      16 * 1024 * 1024,
    );
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? (() => `agent_${randomUUID()}`);
    this.nowIso();
  }

  public subscribe(listener: AgentManagerListener): () => void {
    if (typeof listener !== "function") throw new Error("listener must be a function");
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async spawn(request: AgentSpawnRequest): Promise<AgentSnapshot> {
    this.requireOpen();
    const input = this.validateSpawn(request);
    if (this.activeCount() >= this.maxConcurrentAgents) {
      throw new Error(`Agent concurrency limit of ${this.maxConcurrentAgents} reached`);
    }
    this.pruneRetainedAgents();
    if (this.agents.size >= this.maxRetainedAgents) {
      throw new Error(`Agent history limit of ${this.maxRetainedAgents} reached`);
    }

    const agentId = validateAgentId(this.idFactory());
    if (this.agents.has(agentId)) throw new Error(`Duplicate generated agent ID '${agentId}'`);
    const createdAt = this.nowIso();
    let resolveHandleReady!: () => void;
    const handleReady = new Promise<void>((resolve) => { resolveHandleReady = resolve; });
    const managed: ManagedAgent = {
      controllerId: input.controllerId,
      snapshot: Object.freeze({
        agentId,
        runtimeId: input.runtimeId,
        role: input.role,
        workspace: input.workspace,
        permissions: input.permissions,
        taskId: input.taskId,
        label: input.label,
        status: "starting",
        createdAt,
        updatedAt: createdAt,
        revision: 1,
      }),
      runtimeReleased: false,
      nextOutputCursor: 1,
      outputBytes: 0,
      output: [],
      handleReady,
      resolveHandleReady,
      lifetime: new AbortController(),
      operationQueue: Promise.resolve(),
      controlQueue: Promise.resolve(),
      cancellationRevision: 0,
    };
    this.agents.set(agentId, managed);
    this.emit({ type: "agent-added", agent: copySnapshot(managed.snapshot) });
    this.appendOutput(managed, "user", input.initialMessage);

    const adapter = this.adapters.get(input.runtimeId)!;
    try {
      const handle = await adapter.spawn({
        agentId,
        role: input.role,
        workspace: input.workspace,
        permissions: input.permissions,
        initialMessage: input.initialMessage,
        taskId: input.taskId,
        label: input.label,
        signal: managed.lifetime.signal,
        report: (event) => this.reportRuntimeEvent(agentId, event),
      });
      validateHandle(handle);
      managed.handle = handle;
      if (managed.snapshot.status === "starting") {
        this.updateSnapshot(managed, {
          runtimeAgentId: validateOptionalRuntimeAgentId(handle.runtimeAgentId),
          status: "running",
          startedAt: this.nowIso(),
          lastError: undefined,
        });
      } else if (!TERMINAL_STATUSES.has(managed.snapshot.status) && managed.snapshot.status !== "stopping") {
        this.updateSnapshot(managed, {
          runtimeAgentId: validateOptionalRuntimeAgentId(handle.runtimeAgentId),
          startedAt: managed.snapshot.startedAt ?? this.nowIso(),
        });
      } else if (TERMINAL_STATUSES.has(managed.snapshot.status)) {
        this.updateSnapshot(managed, {
          runtimeAgentId: validateOptionalRuntimeAgentId(handle.runtimeAgentId),
          startedAt: managed.snapshot.startedAt ?? this.nowIso(),
        });
      }
    } catch (error) {
      const stoppedDuringStartup = managed.snapshot.status === "stopping" || managed.lifetime.signal.aborted;
      managed.runtimeReleased = true;
      this.updateSnapshot(managed, stoppedDuringStartup
        ? { status: "stopped", finishedAt: this.nowIso() }
        : {
            status: "failed",
            lastError: safeError(error, "Agent runtime failed to start"),
            finishedAt: this.nowIso(),
          });
    } finally {
      managed.resolveHandleReady();
    }
    if (managed.snapshot.status === "stopping") await managed.controlQueue;
    return copySnapshot(managed.snapshot);
  }

  public list(statuses?: readonly AgentStatus[]): AgentSnapshot[] {
    const selected = statuses === undefined ? undefined : validateStatusFilter(statuses);
    return [...this.agents.values()]
      .map((managed) => managed.snapshot)
      .filter((snapshot) => !selected || selected.has(snapshot.status))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.agentId.localeCompare(right.agentId))
      .map(copySnapshot);
  }

  /** Tenant-scoped view used by authenticated remote controllers. */
  public listForController(controllerId: string, statuses?: readonly AgentStatus[]): AgentSnapshot[] {
    const normalizedControllerId = requiredText(controllerId, "controllerId", CONTROLLER_ID_MAX_BYTES);
    const selected = statuses === undefined ? undefined : validateStatusFilter(statuses);
    return [...this.agents.values()]
      .filter((managed) => managed.controllerId === normalizedControllerId)
      .map((managed) => managed.snapshot)
      .filter((snapshot) => !selected || selected.has(snapshot.status))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.agentId.localeCompare(right.agentId))
      .map(copySnapshot);
  }

  public status(agentId: string): AgentSnapshot {
    return copySnapshot(this.requireAgent(agentId).snapshot);
  }

  public statusForController(controllerId: string, agentId: string): AgentSnapshot {
    return copySnapshot(this.requireControlledAgent(controllerId, agentId).snapshot);
  }

  public outputRead(agentId: string, input: { after?: number; limit?: number } = {}): AgentOutputReadResult {
    const managed = this.requireAgent(agentId);
    return this.outputFromManaged(managed, input);
  }

  public outputReadForController(
    controllerId: string,
    agentId: string,
    input: { after?: number; limit?: number } = {},
  ): AgentOutputReadResult {
    return this.outputFromManaged(this.requireControlledAgent(controllerId, agentId), input);
  }

  private outputFromManaged(managed: ManagedAgent, input: { after?: number; limit?: number }): AgentOutputReadResult {
    const after = input.after === undefined ? undefined : boundedInteger(input.after, "after", 0, Number.MAX_SAFE_INTEGER);
    const limit = boundedInteger(input.limit ?? 50, "limit", 1, 100);
    const oldestCursor = managed.output[0]?.cursor ?? 0;
    const latestCursor = managed.output.at(-1)?.cursor ?? 0;
    if (after !== undefined && after > latestCursor) throw new Error("Agent output cursor is ahead of the latest cursor");
    const gap = after !== undefined && managed.output.length > 0 && after < oldestCursor - 1;
    const entries = after === undefined
      ? managed.output.slice(-limit)
      : managed.output.filter((entry) => entry.cursor > after).slice(0, limit);
    return {
      entries: entries.map(copyOutputEntry),
      oldestCursor,
      latestCursor,
      nextCursor: entries.at(-1)?.cursor ?? after ?? latestCursor,
      gap,
    };
  }

  public send(agentId: string, message: string): Promise<AgentSnapshot> {
    const normalizedMessage = requiredText(message, "message", this.maxMessageBytes);
    return this.enqueue(agentId, async (managed) => {
      this.requireOpen();
      requireStatus(managed.snapshot, ["running", "waiting"], "send a message");
      const handle = requireHandle(managed);
      // Preserve the user's accepted input even when the provider later fails.
      this.appendOutput(managed, "user", normalizedMessage);
      const previousStatus = managed.snapshot.status;
      const cancellationRevision = managed.cancellationRevision;
      this.updateSnapshot(managed, { status: "running", lastError: undefined });
      try {
        await handle.send({ message: normalizedMessage, signal: managed.lifetime.signal });
      } catch (error) {
        if (!TERMINAL_STATUSES.has(managed.snapshot.status) &&
            managed.cancellationRevision === cancellationRevision) {
          this.updateSnapshot(managed, {
            status: previousStatus,
            lastError: safeError(error, "Agent runtime rejected the message"),
          });
        }
        throw error;
      }
      return copySnapshot(managed.snapshot);
    });
  }

  public sendForController(controllerId: string, agentId: string, message: string): Promise<AgentSnapshot> {
    this.requireControlledAgent(controllerId, agentId);
    return this.send(agentId, message);
  }

  /** Cancel only the active turn; the runtime remains available for another message. */
  public cancel(agentId: string, reason?: string): Promise<AgentSnapshot> {
    const normalizedReason = optionalText(reason, "reason", this.maxMessageBytes);
    const managed = this.requireAgent(agentId);
    const result = managed.controlQueue.then(async () => {
      this.requireOpen();
      requireStatus(managed.snapshot, ["running", "waiting"], "cancel the active turn");
      const handle = requireHandle(managed);
      const previousStatus = managed.snapshot.status;
      managed.cancellationRevision += 1;
      this.updateSnapshot(managed, { status: "cancelling", lastError: undefined });
      try {
        await handle.cancel({ reason: normalizedReason, signal: managed.lifetime.signal });
      } catch (error) {
        if (!TERMINAL_STATUSES.has(managed.snapshot.status)) {
          this.updateSnapshot(managed, {
            status: previousStatus,
            lastError: safeError(error, "Agent runtime cancellation failed"),
          });
        }
        throw error;
      }
      if (managed.snapshot.status === "cancelling") {
        this.updateSnapshot(managed, { status: "waiting" });
      }
      return copySnapshot(managed.snapshot);
    });
    managed.controlQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  public cancelForController(controllerId: string, agentId: string, reason?: string): Promise<AgentSnapshot> {
    this.requireControlledAgent(controllerId, agentId);
    return this.cancel(agentId, reason);
  }

  /** Permanently stop one runtime. A failed stop remains active and can be retried. */
  public stop(agentId: string, reason?: string): Promise<AgentSnapshot> {
    const normalizedReason = optionalText(reason, "reason", this.maxMessageBytes);
    const managed = this.requireAgent(agentId);
    const result = managed.controlQueue.then(async () => {
      const preserveTerminalStatus = TERMINAL_STATUSES.has(managed.snapshot.status);
      const cancelActiveTurn = managed.snapshot.status === "running" || managed.snapshot.status === "cancelling";
      const stopReason = normalizedReason ||
        (preserveTerminalStatus ? "Terminal agent runtime cleanup" : "Agent stopped");
      if (!preserveTerminalStatus && managed.snapshot.status !== "stopping") {
        this.updateSnapshot(managed, { status: "stopping", lastError: undefined });
      }
      // Stop is a control-plane operation: it must not wait behind a provider
      // turn in operationQueue. Invalidate that turn's error restoration and
      // signal the lifetime immediately, then explicitly cancel it before the
      // permanent provider release.
      managed.cancellationRevision += 1;
      managed.lifetime.abort(stopReason);
      await managed.handleReady;
      if (managed.runtimeReleased) return copySnapshot(managed.snapshot);
      if (cancelActiveTurn) {
        try {
          await requireHandle(managed).cancel({ reason: stopReason, signal: new AbortController().signal });
        } catch {
          // Permanent stop remains authoritative even if turn cancellation is
          // unsupported or races with a provider-completed turn.
        }
      }
      return this.releaseRuntime(managed, stopReason, preserveTerminalStatus);
    });
    managed.controlQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  public stopForController(controllerId: string, agentId: string, reason?: string): Promise<AgentSnapshot> {
    this.requireControlledAgent(controllerId, agentId);
    return this.stop(agentId, reason);
  }

  public async dispose(reason = "Agent manager disposed"): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const activeIds = [...this.agents.values()]
      .filter((managed) => !managed.runtimeReleased)
      .map((managed) => managed.snapshot.agentId);
    const results = await Promise.allSettled(activeIds.map((agentId) => this.stop(agentId, reason)));
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length > 0) throw new AggregateError(failures, "One or more agent runtimes could not be stopped");
  }

  private validateSpawn(value: AgentSpawnRequest): ValidatedSpawn {
    if (!value || typeof value !== "object") throw new Error("spawn request must be an object");
    const runtimeId = validateRuntimeId(value.runtimeId);
    if (!this.adapters.has(runtimeId)) throw new Error(`Unknown agent runtime adapter '${runtimeId}'`);
    const workspace = canonicalDirectory(value.workspace);
    if (!this.allowedWorkspaceRoots.some((root) => isWithin(root, workspace))) {
      throw new Error("Agent workspace is outside the configured workspace roots");
    }
    const permissions = validatePermissionList(value.permissions, "permissions");
    for (const permission of permissions) {
      if (!this.allowedPermissions.has(permission)) {
        throw new Error(`Agent permission '${permission}' is not authorized by this manager`);
      }
    }
    return {
      controllerId: requiredText(value.controllerId, "controllerId", CONTROLLER_ID_MAX_BYTES),
      runtimeId,
      role: validateAgentRoleAssignment(value.role),
      workspace,
      permissions,
      initialMessage: requiredText(value.initialMessage, "initialMessage", this.maxMessageBytes),
      taskId: optionalText(value.taskId, "taskId", TASK_ID_MAX_BYTES),
      label: optionalText(value.label, "label", LABEL_MAX_BYTES),
    };
  }

  private reportRuntimeEvent(agentId: string, event: AgentRuntimeEvent): void {
    const managed = this.agents.get(agentId);
    if (!managed || !event || typeof event !== "object") return;
    if (event.type === "output") {
      if (!(["assistant", "status", "stderr"] as const).includes(event.channel)) return;
      this.appendOutput(managed, event.channel, event.text);
      return;
    }
    if (TERMINAL_STATUSES.has(managed.snapshot.status)) return;
    // Provider completion/failure can race an explicit stop after cancellation.
    // The user's permanent stop owns that transition and must finish as stopped.
    if (managed.snapshot.status === "stopping") return;
    if (event.type === "status" && (event.status === "running" || event.status === "waiting")) {
      this.updateSnapshot(managed, { status: event.status, lastError: undefined });
      return;
    }
    if (event.type === "completed") {
      this.updateSnapshot(managed, { status: "completed", finishedAt: this.nowIso(), lastError: undefined });
      this.scheduleTerminalCleanup(agentId, "Completed agent runtime cleanup");
      return;
    }
    if (event.type === "failed") {
      this.updateSnapshot(managed, {
        status: "failed",
        finishedAt: this.nowIso(),
        lastError: safeError(event.error, "Agent runtime failed"),
      });
      this.scheduleTerminalCleanup(agentId, "Failed agent runtime cleanup");
    }
  }

  private appendOutput(managed: ManagedAgent, channel: AgentOutputEntry["channel"], value: unknown): void {
    const text = redactAgentError(
      value,
      "",
      Math.min(this.maxOutputBytes, this.maxRetainedOutputBytes),
    );
    if (!text) return;
    const entry: AgentOutputEntry = Object.freeze({
      cursor: managed.nextOutputCursor,
      channel,
      text,
      createdAt: this.nowIso(),
    });
    managed.nextOutputCursor += 1;
    managed.output.push(entry);
    managed.outputBytes += Buffer.byteLength(text, "utf8");
    while (
      managed.output.length > this.maxRetainedOutputEntries ||
      managed.outputBytes > this.maxRetainedOutputBytes
    ) {
      const removed = managed.output.shift();
      if (!removed) break;
      managed.outputBytes -= Buffer.byteLength(removed.text, "utf8");
    }
    this.emit({
      type: "agent-output",
      agent: copySnapshot(managed.snapshot),
      channel,
      text,
    });
  }

  private scheduleTerminalCleanup(agentId: string, reason: string): void {
    void this.enqueue(agentId, async (managed) => {
      if (!TERMINAL_STATUSES.has(managed.snapshot.status) || managed.runtimeReleased) {
        return copySnapshot(managed.snapshot);
      }
      return this.releaseRuntime(managed, reason, true);
    }).catch(() => undefined);
  }

  private async releaseRuntime(
    managed: ManagedAgent,
    reason: string,
    preserveTerminalStatus: boolean,
  ): Promise<AgentSnapshot> {
    managed.lifetime.abort(reason);
    await managed.handleReady;
    if (managed.runtimeReleased) return copySnapshot(managed.snapshot);
    const handle = requireHandle(managed);
    try {
      await handle.stop({ reason, signal: new AbortController().signal });
    } catch (error) {
      this.updateSnapshot(managed, {
        status: "stop_failed",
        lastError: safeError(error, "Agent runtime stop failed"),
      });
      throw error;
    }
    managed.runtimeReleased = true;
    if (!preserveTerminalStatus && !TERMINAL_STATUSES.has(managed.snapshot.status)) {
      this.updateSnapshot(managed, { status: "stopped", finishedAt: this.nowIso() });
    }
    return copySnapshot(managed.snapshot);
  }

  private updateSnapshot(
    managed: ManagedAgent,
    changes: Partial<Omit<AgentSnapshot, "agentId" | "runtimeId" | "role" | "workspace" | "permissions" | "createdAt" | "revision">>,
  ): void {
    const previousStatus = managed.snapshot.status;
    managed.snapshot = Object.freeze({
      ...managed.snapshot,
      ...changes,
      role: Object.freeze({ ...managed.snapshot.role }),
      permissions: Object.freeze([...managed.snapshot.permissions]),
      updatedAt: this.nowIso(),
      revision: managed.snapshot.revision + 1,
    });
    this.emit({ type: "agent-updated", agent: copySnapshot(managed.snapshot), previousStatus });
  }

  private enqueue(agentId: string, operation: (managed: ManagedAgent) => Promise<AgentSnapshot>): Promise<AgentSnapshot> {
    const managed = this.requireAgent(agentId);
    const result = managed.operationQueue.then(() => operation(managed));
    managed.operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private requireAgent(agentId: string): ManagedAgent {
    const normalized = validateAgentId(agentId);
    const managed = this.agents.get(normalized);
    if (!managed) throw new Error(`Unknown agent '${normalized}'`);
    return managed;
  }

  private requireControlledAgent(controllerId: string, agentId: string): ManagedAgent {
    const normalizedControllerId = requiredText(controllerId, "controllerId", CONTROLLER_ID_MAX_BYTES);
    const managed = this.requireAgent(agentId);
    // Use the same failure as an unknown ID so another OAuth client cannot use
    // this boundary as an agent-existence oracle.
    if (managed.controllerId !== normalizedControllerId) throw new Error(`Unknown agent '${agentId}'`);
    return managed;
  }

  private activeCount(): number {
    return [...this.agents.values()].filter((managed) => ACTIVE_STATUSES.has(managed.snapshot.status)).length;
  }

  private pruneRetainedAgents(): void {
    if (this.agents.size < this.maxRetainedAgents) return;
    const terminal = [...this.agents.values()]
      .filter((managed) => TERMINAL_STATUSES.has(managed.snapshot.status))
      .sort((left, right) => left.snapshot.updatedAt.localeCompare(right.snapshot.updatedAt));
    while (this.agents.size >= this.maxRetainedAgents && terminal.length > 0) {
      this.agents.delete(terminal.shift()!.snapshot.agentId);
    }
  }

  private emit(event: AgentManagerEvent): void {
    for (const listener of [...this.listeners]) {
      queueMicrotask(() => Promise.resolve(listener(event)).catch(() => undefined));
    }
  }

  private requireOpen(): void {
    if (this.disposed) throw new Error("AgentManager is disposed");
  }

  private nowIso(): string {
    const value = this.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error("now must return a valid Date");
    return value.toISOString();
  }
}

function copyOutputEntry(entry: AgentOutputEntry): AgentOutputEntry {
  return { ...entry };
}

function validateAdapter(value: AgentRuntimeAdapter): void {
  if (!value || typeof value !== "object") throw new Error("Agent runtime adapter must be an object");
  validateRuntimeId(value.id);
  if (typeof value.spawn !== "function") throw new Error(`Agent runtime adapter '${value.id}' has no spawn function`);
}

function validateHandle(value: AgentRuntimeHandle): void {
  if (!value || typeof value !== "object") throw new Error("Agent runtime adapter returned an invalid handle");
  for (const method of ["send", "cancel", "stop"] as const) {
    if (typeof value[method] !== "function") throw new Error(`Agent runtime handle has no ${method} function`);
  }
  validateOptionalRuntimeAgentId(value.runtimeAgentId);
}

function requireHandle(managed: ManagedAgent): AgentRuntimeHandle {
  if (!managed.handle) throw new Error("Agent runtime handle is unavailable");
  return managed.handle;
}

function validateRuntimeId(value: unknown): string {
  if (typeof value !== "string" || !RUNTIME_ID_PATTERN.test(value)) {
    throw new Error("runtimeId must be a lowercase adapter ID of at most 64 characters");
  }
  return value;
}

function validateAgentId(value: unknown): string {
  if (typeof value !== "string" || !AGENT_ID_PATTERN.test(value)) throw new Error("Invalid agent ID");
  return value;
}

function validateOptionalRuntimeAgentId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return requiredText(value, "runtimeAgentId", 256);
}

function validatePermissionList(value: unknown, field: string): readonly AgentPermission[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${field} must be a non-empty array`);
  const permissions: AgentPermission[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== "string" || !ALL_PERMISSIONS.has(candidate)) {
      throw new Error(`${field} contains an unsupported agent permission`);
    }
    if (seen.has(candidate)) throw new Error(`${field} contains duplicate permission '${candidate}'`);
    seen.add(candidate);
    permissions.push(candidate as AgentPermission);
  }
  return Object.freeze(permissions);
}

function validateStatusFilter(value: readonly AgentStatus[]): ReadonlySet<AgentStatus> {
  if (!Array.isArray(value) || value.length === 0) throw new Error("statuses must be a non-empty array");
  const statuses = new Set<AgentStatus>();
  for (const candidate of value) {
    if (!(ACTIVE_STATUSES.has(candidate) || TERMINAL_STATUSES.has(candidate))) {
      throw new Error(`Unsupported agent status '${String(candidate)}'`);
    }
    statuses.add(candidate);
  }
  return statuses;
}

function canonicalDirectory(value: unknown): string {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error("Workspace paths must be absolute");
  let canonical: string;
  try {
    canonical = fs.realpathSync(value);
  } catch {
    throw new Error(`Workspace directory does not exist: ${value}`);
  }
  if (!fs.statSync(canonical).isDirectory()) throw new Error(`Workspace path is not a directory: ${value}`);
  return canonical;
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function requiredText(value: unknown, field: string, maximumBytes: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} must be non-empty`);
  if (Buffer.byteLength(normalized, "utf8") > maximumBytes) {
    throw new Error(`${field} exceeds ${maximumBytes} UTF-8 bytes`);
  }
  return normalized;
}

function optionalText(value: unknown, field: string, maximumBytes: number): string | undefined {
  return value === undefined ? undefined : requiredText(value, field, maximumBytes);
}

function boundedOutput(value: unknown, maximumBytes: number): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  let end = Math.min(value.length, maximumBytes);
  while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > maximumBytes) end -= 1;
  return `${value.slice(0, end)}\n[output truncated]`;
}

function safeError(value: unknown, fallback: string): string {
  return redactAgentError(value, fallback, ERROR_MAX_BYTES);
}

function requireStatus(snapshot: AgentSnapshot, allowed: readonly AgentStatus[], operation: string): void {
  if (!allowed.includes(snapshot.status)) {
    throw new Error(`Cannot ${operation} while agent '${snapshot.agentId}' is ${snapshot.status}`);
  }
}

function boundedInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function copySnapshot(snapshot: AgentSnapshot): AgentSnapshot {
  return {
    ...snapshot,
    role: { ...snapshot.role },
    permissions: [...snapshot.permissions],
  };
}
