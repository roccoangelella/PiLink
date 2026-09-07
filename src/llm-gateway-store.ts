import { createHash, randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";

export const GATEWAY_MODEL = "pilink";
export const GATEWAY_MAX_WAIT_SECONDS = 55;
export const GATEWAY_DEFAULT_WAIT_SECONDS = 50;
export const GATEWAY_DEFAULT_STALE_SECONDS = 120;
export const GATEWAY_DEFAULT_CLAIM_LEASE_SECONDS = 10 * 60;
export const GATEWAY_DEFAULT_REQUEST_TIMEOUT_SECONDS = 10 * 60;

export const GATEWAY_ROLES = ["system", "developer", "user", "assistant", "tool"] as const;
export type GatewayRole = typeof GATEWAY_ROLES[number];

export interface GatewayMessage {
  role: GatewayRole;
  content: string;
  name?: string;
  tool_call_id?: string;
}

export interface GatewayRequestPayload {
  model: string;
  messages: GatewayMessage[];
}

export type GatewayJobStatus = "queued" | "claimed" | "completed" | "failed" | "cancelled";

export interface GatewayJobSnapshot {
  requestId: string;
  model: string;
  messages: GatewayMessage[];
  status: GatewayJobStatus;
  createdAt: string;
  claimedAt?: string;
  leaseExpiresAt?: string;
  completedAt?: string;
  response?: string;
  error?: string;
}

export interface GatewayCompletionInput {
  requestId: string;
  claimToken: string;
  response?: string;
  error?: string;
}

export type GatewayExchangeResult =
  | {
      state: "request";
      continue: true;
      request: {
        request_id: string;
        claim_token: string;
        model: string;
        messages: GatewayMessage[];
      };
    }
  | {
      state: "idle";
      continue: true;
      waited_seconds: number;
    }
  | {
      state: "released";
      continue: false;
      reason: string;
    };

export interface GatewayStatusSnapshot {
  state: "waiting_for_chatgpt" | "active" | "released";
  active_session_id?: string;
  last_exchange_at?: string;
  queued: number;
  claimed: number;
  completed: number;
  failed: number;
  cancelled: number;
  release_reason?: string;
}

interface StoredGatewayJob {
  requestId: string;
  model: string;
  messages: GatewayMessage[];
  status: GatewayJobStatus;
  createdAt: string;
  claimedAt?: string;
  claimedBy?: string;
  claimToken?: string;
  leaseExpiresAt?: string;
  completedAt?: string;
  response?: string;
  error?: string;
}

interface StoredGatewayState {
  version: 1;
  released: boolean;
  releaseReason?: string;
  activeSessionId?: string;
  lastExchangeAt?: string;
  jobs: StoredGatewayJob[];
}

export interface LlmGatewayStoreOptions {
  workspace: string;
  dataDir: string;
  staleAfterSeconds?: number;
  claimLeaseSeconds?: number;
  now?: () => Date;
}

const MAX_RETAINED_JOBS = 256;
const MAX_ACTIVE_JOBS = 128;
const MAX_MODEL_BYTES = 128;
const MAX_MESSAGES = 256;
const MAX_MESSAGE_BYTES = 256 * 1024;
const MAX_TOTAL_MESSAGE_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;
const REQUEST_ID_PATTERN = /^req_[0-9a-f-]{36}$/u;
const CLAIM_TOKEN_PATTERN = /^claim_[A-Za-z0-9_-]{32,128}$/u;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:@-]{1,256}$/u;

export class GatewayRequestTimeoutError extends Error {
  constructor() {
    super("Gateway request timed out before ChatGPT returned a completion");
    this.name = "GatewayRequestTimeoutError";
  }
}

export class LlmGatewayJobStore {
  readonly workspace: string;
  readonly rootDir: string;
  readonly statePath: string;

  private readonly now: () => Date;
  private readonly staleAfterMs: number;
  private readonly claimLeaseMs: number;
  private mutationQueue: Promise<void> = Promise.resolve();
  private cachedState?: StoredGatewayState;
  private readonly changes = new EventEmitter();

  constructor(options: LlmGatewayStoreOptions) {
    this.workspace = path.resolve(options.workspace);
    const dataDir = path.resolve(options.dataDir);
    if (isWithin(this.workspace, dataDir)) {
      throw new Error("LLM gateway private data must not be stored under the workspace");
    }
    const projectKey = createHash("sha256").update(this.workspace, "utf8").digest("hex");
    this.rootDir = path.join(dataDir, "llm-gateway", projectKey);
    this.statePath = path.join(this.rootDir, "state.json");
    this.now = options.now ?? (() => new Date());
    this.staleAfterMs = positiveSeconds(options.staleAfterSeconds ?? GATEWAY_DEFAULT_STALE_SECONDS, "staleAfterSeconds") * 1_000;
    this.claimLeaseMs = positiveSeconds(options.claimLeaseSeconds ?? GATEWAY_DEFAULT_CLAIM_LEASE_SECONDS, "claimLeaseSeconds") * 1_000;
    this.changes.setMaxListeners(0);
  }

  async activate(): Promise<void> {
    await this.mutate(async (state) => {
      const now = this.now().toISOString();
      for (const job of state.jobs) {
        if (job.status !== "claimed") continue;
        job.status = "queued";
        delete job.claimedAt;
        delete job.claimedBy;
        delete job.claimToken;
        delete job.leaseExpiresAt;
      }
      state.released = false;
      delete state.releaseReason;
      delete state.activeSessionId;
      delete state.lastExchangeAt;
      pruneJobs(state);
      await this.persist(state);
      this.emitChange();
      void now;
    });
  }

  async release(reason = "Gateway released by the local operator"): Promise<void> {
    const selectedReason = validateText(reason, "release reason", MAX_ERROR_BYTES);
    await this.mutate(async (state) => {
      const completedAt = this.now().toISOString();
      state.released = true;
      state.releaseReason = selectedReason;
      delete state.activeSessionId;
      for (const job of state.jobs) {
        if (job.status !== "queued" && job.status !== "claimed") continue;
        job.status = "failed";
        job.completedAt = completedAt;
        job.error = `Gateway released: ${selectedReason}`;
        delete job.claimedAt;
        delete job.claimedBy;
        delete job.leaseExpiresAt;
      }
      pruneJobs(state);
      await this.persist(state);
      this.emitChange();
    });
  }

  async status(): Promise<GatewayStatusSnapshot> {
    return this.mutate(async (state) => {
      const changed = reclaimExpiredClaims(state, this.now().getTime());
      if (changed) await this.persist(state);
      const counts = countStatuses(state.jobs);
      const active = !state.released && isSessionFresh(state, this.now().getTime(), this.staleAfterMs);
      return {
        state: state.released ? "released" : active ? "active" : "waiting_for_chatgpt",
        ...(state.activeSessionId ? { active_session_id: state.activeSessionId } : {}),
        ...(state.lastExchangeAt ? { last_exchange_at: state.lastExchangeAt } : {}),
        ...counts,
        ...(state.releaseReason ? { release_reason: state.releaseReason } : {}),
      };
    });
  }

  async isAvailable(): Promise<boolean> {
    const snapshot = await this.status();
    return snapshot.state === "active";
  }

  async enqueueRequest(input: GatewayRequestPayload): Promise<GatewayJobSnapshot> {
    const normalized = validateRequestPayload(input);
    return this.mutate(async (state) => {
      reclaimExpiredClaims(state, this.now().getTime());
      if (state.released) throw new Error("Gateway is released");
      const activeJobs = state.jobs.filter((job) => job.status === "queued" || job.status === "claimed").length;
      if (activeJobs >= MAX_ACTIVE_JOBS) throw new Error("Gateway request queue is full");
      const job: StoredGatewayJob = {
        requestId: `req_${randomUUID()}`,
        model: normalized.model,
        messages: normalized.messages,
        status: "queued",
        createdAt: this.now().toISOString(),
      };
      state.jobs.push(job);
      pruneJobs(state);
      await this.persist(state);
      this.emitChange();
      return publicJob(job);
    });
  }

  async cancelRequest(requestId: string, reason = "Request cancelled by the local client"): Promise<GatewayJobSnapshot> {
    const validatedId = validateRequestId(requestId);
    const selectedReason = validateText(reason, "cancellation reason", MAX_ERROR_BYTES);
    return this.mutate(async (state) => {
      const job = findJob(state, validatedId);
      if (job.status === "queued" || job.status === "claimed") {
        job.status = "cancelled";
        job.completedAt = this.now().toISOString();
        job.error = selectedReason;
        delete job.claimedAt;
        delete job.claimedBy;
        delete job.leaseExpiresAt;
        await this.persist(state);
        this.emitChange();
      }
      return publicJob(job);
    });
  }

  async waitForResult(requestId: string, timeoutSeconds: number, signal?: AbortSignal): Promise<GatewayJobSnapshot> {
    const validatedId = validateRequestId(requestId);
    const timeoutMs = positiveSeconds(timeoutSeconds, "timeoutSeconds") * 1_000;
    const deadline = Date.now() + timeoutMs;
    while (true) {
      if (signal?.aborted) throw new Error("Gateway request wait was cancelled");
      const snapshot = await this.job(validatedId);
      if (["completed", "failed", "cancelled"].includes(snapshot.status)) return snapshot;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new GatewayRequestTimeoutError();
      await this.waitForChange(Math.min(remaining, 1_000), signal);
    }
  }

  async job(requestId: string): Promise<GatewayJobSnapshot> {
    const validatedId = validateRequestId(requestId);
    return this.mutate(async (state) => {
      const changed = reclaimExpiredClaims(state, this.now().getTime());
      if (changed) await this.persist(state);
      return publicJob(findJob(state, validatedId));
    });
  }

  async disconnectSession(sessionId: string): Promise<void> {
    const selectedSessionId = validateSessionId(sessionId);
    await this.mutate(async (state) => {
      if (state.activeSessionId !== selectedSessionId) return;
      state.lastExchangeAt = new Date(0).toISOString();
      await this.persist(state);
      this.emitChange();
    });
  }

  async exchange(
    sessionId: string,
    completion?: GatewayCompletionInput,
    maximumWaitSeconds = GATEWAY_DEFAULT_WAIT_SECONDS,
    signal?: AbortSignal,
  ): Promise<GatewayExchangeResult> {
    const selectedSessionId = validateSessionId(sessionId);
    const selectedCompletion = completion ? validateCompletion(completion) : undefined;
    if (!Number.isSafeInteger(maximumWaitSeconds) || maximumWaitSeconds < 1 || maximumWaitSeconds > GATEWAY_MAX_WAIT_SECONDS) {
      throw new Error(`maximumWaitSeconds must be an integer from 1 through ${GATEWAY_MAX_WAIT_SECONDS}`);
    }
    const startedAt = Date.now();
    const deadline = startedAt + maximumWaitSeconds * 1_000;
    let completionApplied = false;

    while (true) {
      if (signal?.aborted) throw new Error("Gateway exchange was cancelled");
      const selected = await this.mutate(async (state): Promise<GatewayExchangeResult | undefined> => {
        const nowMs = this.now().getTime();
        let changed = reclaimExpiredClaims(state, nowMs);
        changed = bindSession(state, selectedSessionId, nowMs, this.staleAfterMs) || changed;
        state.lastExchangeAt = new Date(nowMs).toISOString();
        changed = true;

        if (state.released) {
          if (changed) await this.persist(state);
          return {
            state: "released",
            continue: false,
            reason: state.releaseReason || "Gateway released",
          };
        }

        if (selectedCompletion && !completionApplied) {
          applyCompletion(state, selectedSessionId, selectedCompletion, new Date(nowMs).toISOString());
          completionApplied = true;
          changed = true;
        }

        const queued = state.jobs.find((job) => job.status === "queued");
        if (queued) {
          queued.status = "claimed";
          queued.claimedAt = new Date(nowMs).toISOString();
          queued.claimedBy = selectedSessionId;
          queued.claimToken = `claim_${randomBytes(32).toString("base64url")}`;
          queued.leaseExpiresAt = new Date(nowMs + this.claimLeaseMs).toISOString();
          await this.persist(state);
          this.emitChange();
          return {
            state: "request",
            continue: true,
            request: {
              request_id: queued.requestId,
              claim_token: queued.claimToken,
              model: queued.model,
              messages: queued.messages.map(copyMessage),
            },
          };
        }

        if (changed) await this.persist(state);
        return undefined;
      });
      if (selected) return selected;

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return {
          state: "idle",
          continue: true,
          waited_seconds: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
        };
      }
      await this.waitForChange(Math.min(remaining, 1_000), signal);
    }
  }

  private async mutate<T>(operation: (state: StoredGatewayState) => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(async () => operation(await this.loadState()));
    this.mutationQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async loadState(): Promise<StoredGatewayState> {
    if (this.cachedState) return this.cachedState;
    await this.ensureRoot();
    let serialized: string;
    try {
      serialized = await fs.readFile(this.statePath, "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        this.cachedState = emptyState();
        return this.cachedState;
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized);
    } catch {
      throw new Error("Malformed LLM gateway state: invalid JSON");
    }
    this.cachedState = validateState(parsed);
    return this.cachedState;
  }

  private async persist(state: StoredGatewayState): Promise<void> {
    await this.ensureRoot();
    const temporaryPath = path.join(this.rootDir, `.state-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
    const file = await fs.open(temporaryPath, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(state)}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await fs.rename(temporaryPath, this.statePath);
      await syncDirectory(this.rootDir);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
    this.cachedState = state;
  }

  private async ensureRoot(): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    await fs.chmod(this.rootDir, 0o700).catch(() => undefined);
  }

  private emitChange(): void {
    queueMicrotask(() => this.changes.emit("change"));
  }

  private waitForChange(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.changes.off("change", onChange);
        signal?.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve();
      };
      const onChange = () => finish();
      const onAbort = () => finish(new Error("Gateway wait was cancelled"));
      const timer = setTimeout(() => finish(), Math.max(1, timeoutMs));
      timer.unref();
      this.changes.once("change", onChange);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

function emptyState(): StoredGatewayState {
  return { version: 1, released: false, jobs: [] };
}

function validateState(value: unknown): StoredGatewayState {
  if (!isRecord(value) || value.version !== 1 || typeof value.released !== "boolean" || !Array.isArray(value.jobs)) {
    throw new Error("Malformed LLM gateway state");
  }
  const state: StoredGatewayState = {
    version: 1,
    released: value.released,
    jobs: value.jobs.map(validateStoredJob),
  };
  if (typeof value.releaseReason === "string") state.releaseReason = validateText(value.releaseReason, "release reason", MAX_ERROR_BYTES);
  if (typeof value.activeSessionId === "string") state.activeSessionId = validateSessionId(value.activeSessionId);
  if (typeof value.lastExchangeAt === "string" && isIsoTimestamp(value.lastExchangeAt)) state.lastExchangeAt = value.lastExchangeAt;
  return state;
}

function validateStoredJob(value: unknown): StoredGatewayJob {
  if (!isRecord(value)) throw new Error("Malformed LLM gateway job");
  const status = value.status;
  if (!["queued", "claimed", "completed", "failed", "cancelled"].includes(String(status))) {
    throw new Error("Malformed LLM gateway job status");
  }
  const request = validateRequestPayload({ model: value.model, messages: value.messages });
  const job: StoredGatewayJob = {
    requestId: validateRequestId(value.requestId),
    model: request.model,
    messages: request.messages,
    status: status as GatewayJobStatus,
    createdAt: validateTimestamp(value.createdAt, "createdAt"),
  };
  if (typeof value.claimedAt === "string") job.claimedAt = validateTimestamp(value.claimedAt, "claimedAt");
  if (typeof value.claimedBy === "string") job.claimedBy = validateSessionId(value.claimedBy);
  if (typeof value.claimToken === "string") job.claimToken = validateClaimToken(value.claimToken);
  if (typeof value.leaseExpiresAt === "string") job.leaseExpiresAt = validateTimestamp(value.leaseExpiresAt, "leaseExpiresAt");
  if (typeof value.completedAt === "string") job.completedAt = validateTimestamp(value.completedAt, "completedAt");
  if (typeof value.response === "string") job.response = validateText(value.response, "response", MAX_RESPONSE_BYTES, true);
  if (typeof value.error === "string") job.error = validateText(value.error, "error", MAX_ERROR_BYTES);
  return job;
}

function validateRequestPayload(input: { model: unknown; messages: unknown }): GatewayRequestPayload {
  if (typeof input.model !== "string") throw new Error("model must be a string");
  const model = validateText(input.model, "model", MAX_MODEL_BYTES);
  if (!Array.isArray(input.messages) || input.messages.length < 1 || input.messages.length > MAX_MESSAGES) {
    throw new Error(`messages must contain from 1 through ${MAX_MESSAGES} entries`);
  }
  let totalBytes = 0;
  const messages = input.messages.map((message) => {
    if (!isRecord(message) || typeof message.role !== "string" || !GATEWAY_ROLES.includes(message.role as GatewayRole)) {
      throw new Error("message role is invalid");
    }
    if (typeof message.content !== "string") throw new Error("message content must be a string");
    const content = validateText(message.content, "message content", MAX_MESSAGE_BYTES, true);
    totalBytes += Buffer.byteLength(content, "utf8");
    const normalized: GatewayMessage = { role: message.role as GatewayRole, content };
    if (message.name !== undefined) normalized.name = validateSingleLine(message.name, "message name", 256);
    if (message.tool_call_id !== undefined) normalized.tool_call_id = validateSingleLine(message.tool_call_id, "tool_call_id", 512);
    return normalized;
  });
  if (totalBytes > MAX_TOTAL_MESSAGE_BYTES) throw new Error(`messages exceed ${MAX_TOTAL_MESSAGE_BYTES} UTF-8 bytes`);
  return { model, messages };
}

function validateCompletion(input: GatewayCompletionInput): GatewayCompletionInput {
  const requestId = validateRequestId(input.requestId);
  const claimToken = validateClaimToken(input.claimToken);
  const hasResponse = input.response !== undefined;
  const hasError = input.error !== undefined;
  if (hasResponse === hasError) throw new Error("Exactly one of response or error must be supplied with a completed request");
  return {
    requestId,
    claimToken,
    ...(hasResponse ? { response: validateText(input.response, "response", MAX_RESPONSE_BYTES, true) } : {}),
    ...(hasError ? { error: validateText(input.error, "error", MAX_ERROR_BYTES) } : {}),
  };
}

function applyCompletion(
  state: StoredGatewayState,
  sessionId: string,
  completion: GatewayCompletionInput,
  completedAt: string,
): void {
  const job = findJob(state, completion.requestId);
  if (job.status === "completed" && completion.response !== undefined && job.response === completion.response && job.claimToken === completion.claimToken) {
    return;
  }
  if (job.status === "failed" && completion.error !== undefined && job.error === completion.error && job.claimToken === completion.claimToken) {
    return;
  }
  if (job.status !== "claimed") throw new Error("Gateway request is not currently claimed");
  if (job.claimedBy !== sessionId) throw new Error("Gateway request is claimed by another MCP session");
  if (job.claimToken !== completion.claimToken) throw new Error("Gateway claim token does not match the active request");
  job.status = completion.response !== undefined ? "completed" : "failed";
  job.completedAt = completedAt;
  if (completion.response !== undefined) job.response = completion.response;
  if (completion.error !== undefined) job.error = completion.error;
  delete job.claimedAt;
  delete job.claimedBy;
  delete job.leaseExpiresAt;
}

function bindSession(state: StoredGatewayState, sessionId: string, nowMs: number, staleAfterMs: number): boolean {
  if (!state.activeSessionId || state.activeSessionId === sessionId) {
    const changed = state.activeSessionId !== sessionId;
    state.activeSessionId = sessionId;
    return changed;
  }
  if (isSessionFresh(state, nowMs, staleAfterMs)) {
    throw new Error("Another ChatGPT gateway MCP session is already active");
  }
  for (const job of state.jobs) {
    if (job.status !== "claimed" || job.claimedBy !== state.activeSessionId) continue;
    job.status = "queued";
    delete job.claimedAt;
    delete job.claimedBy;
    delete job.claimToken;
    delete job.leaseExpiresAt;
  }
  state.activeSessionId = sessionId;
  return true;
}

function isSessionFresh(state: StoredGatewayState, nowMs: number, staleAfterMs: number): boolean {
  if (!state.activeSessionId || !state.lastExchangeAt) return false;
  const lastExchangeMs = Date.parse(state.lastExchangeAt);
  if (Number.isFinite(lastExchangeMs) && nowMs - lastExchangeMs <= staleAfterMs) return true;
  return state.jobs.some((job) =>
    job.status === "claimed" && job.claimedBy === state.activeSessionId &&
    job.leaseExpiresAt !== undefined && Date.parse(job.leaseExpiresAt) > nowMs,
  );
}

function reclaimExpiredClaims(state: StoredGatewayState, nowMs: number): boolean {
  let changed = false;
  for (const job of state.jobs) {
    if (job.status !== "claimed") continue;
    const leaseExpiresAt = job.leaseExpiresAt ? Date.parse(job.leaseExpiresAt) : 0;
    if (leaseExpiresAt > nowMs) continue;
    job.status = "queued";
    delete job.claimedAt;
    delete job.claimedBy;
    delete job.claimToken;
    delete job.leaseExpiresAt;
    changed = true;
  }
  return changed;
}

function countStatuses(jobs: StoredGatewayJob[]): Omit<GatewayStatusSnapshot, "state" | "active_session_id" | "last_exchange_at" | "release_reason"> {
  return {
    queued: jobs.filter((job) => job.status === "queued").length,
    claimed: jobs.filter((job) => job.status === "claimed").length,
    completed: jobs.filter((job) => job.status === "completed").length,
    failed: jobs.filter((job) => job.status === "failed").length,
    cancelled: jobs.filter((job) => job.status === "cancelled").length,
  };
}

function pruneJobs(state: StoredGatewayState): void {
  if (state.jobs.length <= MAX_RETAINED_JOBS) return;
  const terminal = new Set<GatewayJobStatus>(["completed", "failed", "cancelled"]);
  const removable = state.jobs
    .filter((job) => terminal.has(job.status))
    .sort((left, right) => Date.parse(left.completedAt || left.createdAt) - Date.parse(right.completedAt || right.createdAt));
  const removeCount = Math.min(removable.length, state.jobs.length - MAX_RETAINED_JOBS);
  const selected = new Set(removable.slice(0, removeCount).map((job) => job.requestId));
  state.jobs = state.jobs.filter((job) => !selected.has(job.requestId));
}

function publicJob(job: StoredGatewayJob): GatewayJobSnapshot {
  return {
    requestId: job.requestId,
    model: job.model,
    messages: job.messages.map(copyMessage),
    status: job.status,
    createdAt: job.createdAt,
    ...(job.claimedAt ? { claimedAt: job.claimedAt } : {}),
    ...(job.leaseExpiresAt ? { leaseExpiresAt: job.leaseExpiresAt } : {}),
    ...(job.completedAt ? { completedAt: job.completedAt } : {}),
    ...(job.response !== undefined ? { response: job.response } : {}),
    ...(job.error !== undefined ? { error: job.error } : {}),
  };
}

function copyMessage(message: GatewayMessage): GatewayMessage {
  return { ...message };
}

function findJob(state: StoredGatewayState, requestId: string): StoredGatewayJob {
  const job = state.jobs.find((candidate) => candidate.requestId === requestId);
  if (!job) throw new Error("Gateway request not found");
  return job;
}

function validateRequestId(value: unknown): string {
  if (typeof value !== "string" || !REQUEST_ID_PATTERN.test(value)) throw new Error("Gateway request id is invalid");
  return value;
}

function validateClaimToken(value: unknown): string {
  if (typeof value !== "string" || !CLAIM_TOKEN_PATTERN.test(value)) throw new Error("Gateway claim token is invalid");
  return value;
}

function validateSessionId(value: unknown): string {
  if (typeof value !== "string" || !SESSION_ID_PATTERN.test(value)) throw new Error("Gateway MCP session id is invalid");
  return value;
}

function validateText(value: unknown, field: string, maximumBytes: number, allowEmpty = false): string {
  if (typeof value !== "string" || value.includes("\0")) throw new Error(`${field} must be a string without NUL bytes`);
  if (!allowEmpty && !value.trim()) throw new Error(`${field} must not be empty`);
  if (Buffer.byteLength(value, "utf8") > maximumBytes) throw new Error(`${field} exceeds ${maximumBytes} UTF-8 bytes`);
  return value;
}

function validateSingleLine(value: unknown, field: string, maximumBytes: number): string {
  const selected = validateText(value, field, maximumBytes);
  if (/[\r\n]/u.test(selected)) throw new Error(`${field} must be one line`);
  return selected;
}

function validateTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || !isIsoTimestamp(value)) throw new Error(`${field} must be an ISO timestamp`);
  return value;
}

function isIsoTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function positiveSeconds(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 24 * 60 * 60) throw new Error(`${field} must be a positive integer number of seconds`);
  return value;
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (!isNodeError(error, "EINVAL") && !isNodeError(error, "ENOTSUP") && !isNodeError(error, "EISDIR")) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
