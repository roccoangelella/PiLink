import { createHash, randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import {
  GATEWAY_MODEL,
  copyGatewayAssistantCompletion,
  copyGatewayMessage,
  copyGatewayTool,
  copyGatewayToolChoice,
  validateGatewayAssistantCompletion,
  validateGatewayRequestPayload,
  type GatewayAssistantCompletion,
  type GatewayFunctionTool,
  type GatewayMessage,
  type GatewayRequestPayload,
  type GatewayToolChoice,
} from "./llm-gateway-protocol.js";

export { GATEWAY_MODEL } from "./llm-gateway-protocol.js";
export type {
  GatewayAssistantCompletion,
  GatewayFunctionTool,
  GatewayJsonObject,
  GatewayJsonValue,
  GatewayMessage,
  GatewayRequestPayload,
  GatewayRole,
  GatewayToolCall,
  GatewayToolChoice,
} from "./llm-gateway-protocol.js";

export const GATEWAY_MAX_WAIT_SECONDS = 55;
export const GATEWAY_DEFAULT_WAIT_SECONDS = 50;
export const GATEWAY_DEFAULT_STALE_SECONDS = 120;
export const GATEWAY_DEFAULT_CLAIM_LEASE_SECONDS = 15 * 60;
export const GATEWAY_DEFAULT_REQUEST_TIMEOUT_SECONDS = 10 * 60;
export const GATEWAY_DEFAULT_QUEUE_TIMEOUT_SECONDS = 60;

export type GatewayJobStatus = "queued" | "claimed" | "completed" | "failed" | "cancelled";

export interface GatewayJobSnapshot extends GatewayRequestPayload {
  requestId: string;
  status: GatewayJobStatus;
  createdAt: string;
  claimedAt?: string;
  leaseExpiresAt?: string;
  completedAt?: string;
  response?: GatewayAssistantCompletion;
  error?: string;
}

export interface GatewayCompletionInput {
  requestId: string;
  claimToken: string;
  response?: GatewayAssistantCompletion | string;
  error?: string;
}

export interface GatewayExchangeRequest {
  request_id: string;
  claim_token: string;
  model: string;
  messages: GatewayMessage[];
  tools?: GatewayFunctionTool[];
  tool_choice?: GatewayToolChoice;
  parallel_tool_calls?: boolean;
}

export type GatewayRecoveryCode = "request_cancelled" | "stale_claim" | "worker_busy";
export type GatewayRecoveryAction = "poll" | "resync" | "bounded_wait";

export type GatewayExchangeResult =
  | {
      state: "request";
      continue: true;
      request: GatewayExchangeRequest;
    }
  | {
      state: "idle";
      continue: true;
      waited_seconds: number;
    }
  | {
      state: "recovery";
      continue: true;
      code: GatewayRecoveryCode;
      next_action: GatewayRecoveryAction;
      message: string;
      request_id?: string;
    }
  | {
      state: "released";
      continue: false;
      reason: string;
    };

export type GatewayWorkerContact = "recent" | "stale" | "never";
export type GatewayStatusNextAction = "wake_worker" | "wait_for_worker" | "poll" | "inspect_claim" | "none";

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
  /** True only while one or more in-process exchange calls are awaiting a result. */
  worker_polling: boolean;
  pending_worker_polls: number;
  worker_contact: GatewayWorkerContact;
  /** A durable claim exists; this does not confirm that ChatGPT is generating. */
  processing_claim: boolean;
  claim_age_ms?: number;
  lease_expires_at?: string;
  oldest_queue_age_ms: number;
  next_action: GatewayStatusNextAction;
}

interface StoredGatewayJob {
  requestId: string;
  model: string;
  messages: GatewayMessage[];
  tools?: GatewayFunctionTool[];
  toolChoice?: GatewayToolChoice;
  parallelToolCalls?: boolean;
  status: GatewayJobStatus;
  createdAt: string;
  claimedAt?: string;
  claimedBy?: string;
  claimToken?: string;
  leaseExpiresAt?: string;
  lastClaimedBy?: string;
  lastClaimToken?: string;
  lastClaimEndedAt?: string;
  lastClaimEndedReason?: "cancelled" | "stale_claim" | "completed" | "released";
  completedAt?: string;
  response?: GatewayAssistantCompletion;
  completionDigest?: string;
  error?: string;
}

interface StoredExchangeReplay {
  sessionId: string;
  requestId: string;
  claimToken: string;
  completionDigest: string;
  createdAt: string;
  result: GatewayExchangeResult;
}

interface StoredPendingCompletion {
  sessionId: string;
  requestId: string;
  claimToken: string;
  completionDigest: string;
}

interface StoredGatewayState {
  version: 1;
  released: boolean;
  releaseReason?: string;
  activeSessionId?: string;
  lastExchangeAt?: string;
  outstandingDelivery?: {
    sessionId: string;
    requestId: string;
    claimToken: string;
  };
  pendingCompletion?: StoredPendingCompletion;
  exchangeReplays?: StoredExchangeReplay[];
  jobs: StoredGatewayJob[];
}

export interface LlmGatewayStoreOptions {
  workspace: string;
  dataDir: string;
  staleAfterSeconds?: number;
  claimLeaseSeconds?: number;
  now?: () => Date;
}

const MAX_RETAINED_JOBS = 32;
const MAX_ACTIVE_JOBS = 128;
const MAX_EXCHANGE_REPLAYS = 8;
const MAX_EXCHANGE_REPLAY_BYTES = 4 * 1024 * 1024;
const MAX_EXCHANGE_REPLAY_AGE_MS = 15 * 60 * 1_000;
const MAX_ERROR_BYTES = 64 * 1024;
const REQUEST_ID_PATTERN = /^req_[0-9a-f-]{36}$/u;
const CLAIM_TOKEN_PATTERN = /^claim_[A-Za-z0-9_-]{32,128}$/u;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:@-]{1,256}$/u;

export class GatewayLifecycleError extends Error {
  readonly code: GatewayRecoveryCode;
  readonly nextAction: GatewayRecoveryAction;
  readonly requestId?: string;

  constructor(
    code: GatewayRecoveryCode,
    nextAction: GatewayRecoveryAction,
    message: string,
    requestId?: string,
  ) {
    super(message);
    this.name = "GatewayLifecycleError";
    this.code = code;
    this.nextAction = nextAction;
    this.requestId = requestId;
  }
}

export class GatewayRequestTimeoutError extends Error {
  constructor(message = "Gateway request timed out before ChatGPT returned a completion") {
    super(message);
    this.name = "GatewayRequestTimeoutError";
  }
}

export class GatewayRequestQueueTimeoutError extends GatewayRequestTimeoutError {
  readonly timeoutSeconds: number;

  constructor(timeoutSeconds = GATEWAY_DEFAULT_QUEUE_TIMEOUT_SECONDS) {
    super(
      `Gateway request timed out in queue after ${timeoutSeconds}s before being claimed by ChatGPT. Ensure your ChatGPT conversation is awake with '@PiLink wake'.`,
    );
    this.name = "GatewayRequestQueueTimeoutError";
    this.timeoutSeconds = timeoutSeconds;
  }
}

class GatewayPersistenceError extends Error {
  readonly renamed: boolean;

  constructor(cause: unknown, renamed: boolean) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "GatewayPersistenceError";
    this.renamed = renamed;
    if (cause instanceof Error && cause.stack) this.stack = cause.stack;
  }
}

interface GatewayMutationContext {
  committedState: StoredGatewayState;
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
  private changeRevision = 0;
  private readonly sessionGenerations = new Map<string, number>();
  private nextWorkerPollId = 0;
  private readonly pendingWorkerPolls = new Set<number>();
  private mutationContext?: GatewayMutationContext;

  constructor(options: LlmGatewayStoreOptions) {
    this.workspace = path.resolve(options.workspace);
    const dataDir = path.resolve(options.dataDir);
    if (isWithin(this.workspace, dataDir)) throw new Error("LLM gateway private data must not be stored under the workspace");
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
      const activatedAt = this.now().getTime();
      for (const job of state.jobs) {
        if (job.status !== "claimed") continue;
        rememberEndedClaim(job, "stale_claim", activatedAt);
        job.status = "queued";
        delete job.claimedAt;
        delete job.claimedBy;
        delete job.claimToken;
        delete job.leaseExpiresAt;
      }
      state.released = false;
      delete state.releaseReason;
      if (state.activeSessionId) {
        this.sessionGenerations.set(
          state.activeSessionId,
          (this.sessionGenerations.get(state.activeSessionId) ?? 0) + 1,
        );
      }
      delete state.activeSessionId;
      delete state.lastExchangeAt;
      delete state.outstandingDelivery;
      // Accepted completions remain replayable across a process restart. Any
      // claim referenced by a replay is repaired to a fresh claim below.
      trimExchangeReplays(state, activatedAt);
      pruneJobs(state);
      await this.persist(state);
      this.emitChange();
    });
  }

  async release(reason = "Gateway released by the local operator"): Promise<void> {
    const selectedReason = validateText(reason, "release reason", MAX_ERROR_BYTES);
    await this.mutate(async (state) => {
      const completedAt = this.now().toISOString();
      state.released = true;
      state.releaseReason = selectedReason;
      if (state.activeSessionId) {
        this.sessionGenerations.set(
          state.activeSessionId,
          (this.sessionGenerations.get(state.activeSessionId) ?? 0) + 1,
        );
      }
      delete state.activeSessionId;
      delete state.lastExchangeAt;
      for (const job of state.jobs) {
        if (job.status !== "queued" && job.status !== "claimed") continue;
        if (job.status === "claimed") rememberEndedClaim(job, "released", Date.parse(completedAt));
        job.status = "failed";
        job.completedAt = completedAt;
        job.error = `Gateway released: ${selectedReason}`;
        job.messages = [{ role: "user", content: "" }];
        delete job.tools;
        delete job.toolChoice;
        delete job.parallelToolCalls;
        delete job.claimedAt;
        delete job.claimedBy;
        delete job.claimToken;
        delete job.leaseExpiresAt;
      }
      delete state.outstandingDelivery;
      delete state.pendingCompletion;
      delete state.exchangeReplays;
      pruneJobs(state);
      await this.persist(state);
      this.emitChange();
    });
  }

  async status(): Promise<GatewayStatusSnapshot> {
    return this.mutate(async (state) => {
      const nowMs = this.now().getTime();
      const changed = reclaimExpiredClaims(state, nowMs);
      if (changed) {
        await this.persist(state);
        this.emitChange();
      }
      const counts = countStatuses(state.jobs);
      const active = !state.released && isSessionFresh(state, nowMs, this.staleAfterMs);
      const currentClaim = currentGatewayClaim(state);
      const workerContact = classifyWorkerContact(state, nowMs, this.staleAfterMs);
      const pendingWorkerPolls = this.pendingWorkerPolls.size;
      return {
        state: state.released ? "released" : active ? "active" : "waiting_for_chatgpt",
        ...(state.activeSessionId ? { active_session_id: state.activeSessionId } : {}),
        ...(state.lastExchangeAt ? { last_exchange_at: state.lastExchangeAt } : {}),
        ...counts,
        ...(state.releaseReason ? { release_reason: state.releaseReason } : {}),
        worker_polling: pendingWorkerPolls > 0,
        pending_worker_polls: pendingWorkerPolls,
        worker_contact: workerContact,
        processing_claim: currentClaim !== undefined,
        ...(currentClaim?.claimedAt ? { claim_age_ms: claimAgeMs(currentClaim, nowMs) } : {}),
        ...(currentClaim?.leaseExpiresAt ? { lease_expires_at: currentClaim.leaseExpiresAt } : {}),
        oldest_queue_age_ms: oldestQueueAgeMs(state.jobs, nowMs),
        next_action: nextStatusAction(
          state.released,
          workerContact,
          currentClaim !== undefined,
          pendingWorkerPolls,
        ),
      };
    });
  }

  async isAvailable(): Promise<boolean> {
    return (await this.status()).state === "active";
  }

  async enqueueRequest(input: GatewayRequestPayload): Promise<GatewayJobSnapshot> {
    const normalized = validateGatewayRequestPayload(input);
    return this.mutate(async (state) => {
      reclaimExpiredClaims(state, this.now().getTime());
      if (state.released) throw new Error("Gateway is released");
      const activeJobs = state.jobs.filter((job) => job.status === "queued" || job.status === "claimed").length;
      if (activeJobs >= MAX_ACTIVE_JOBS) throw new Error("Gateway request queue is full");
      const job: StoredGatewayJob = {
        requestId: `req_${randomUUID()}`,
        ...copyRequest(normalized),
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
        if (job.status === "claimed") rememberEndedClaim(job, "cancelled", this.now().getTime());
        job.status = "cancelled";
        job.completedAt = this.now().toISOString();
        job.error = selectedReason;
        job.messages = [{ role: "user", content: "" }];
        delete job.tools;
        delete job.toolChoice;
        delete job.parallelToolCalls;
        delete job.claimedAt;
        delete job.claimedBy;
        delete job.claimToken;
        delete job.leaseExpiresAt;
        if (state.outstandingDelivery?.requestId === job.requestId) delete state.outstandingDelivery;
        await this.persist(state);
        this.emitChange();
      }
      return publicJob(job);
    });
  }

  async waitForResult(
    requestId: string,
    timeoutSeconds: number,
    signal?: AbortSignal,
    queueTimeoutSeconds = GATEWAY_DEFAULT_QUEUE_TIMEOUT_SECONDS,
  ): Promise<GatewayJobSnapshot> {
    const validatedId = validateRequestId(requestId);
    const executionTimeoutMs = positiveSeconds(timeoutSeconds, "timeoutSeconds") * 1_000;
    const queueTimeoutMs = positiveSeconds(queueTimeoutSeconds, "queueTimeoutSeconds") * 1_000;
    const effectiveQueueTimeoutMs = Math.min(queueTimeoutMs, executionTimeoutMs);
    // Request deadlines are local wall-clock deadlines. The injectable state
    // clock may be deliberately frozen in tests or advanced independently for
    // lease recovery and must not be able to make an API wait unbounded.
    const startedAt = Date.now();
    const queueDeadline = startedAt + effectiveQueueTimeoutMs;
    const executionDeadline = startedAt + executionTimeoutMs;

    while (true) {
      if (signal?.aborted) throw new Error("Gateway request wait was cancelled");
      const observedRevision = this.changeRevision;
      const snapshot = await this.job(validatedId);
      if (["completed", "failed", "cancelled"].includes(snapshot.status)) return snapshot;

      const now = Date.now();
      if (snapshot.status === "queued") {
        if (now >= queueDeadline) {
          throw new GatewayRequestQueueTimeoutError(Math.ceil(effectiveQueueTimeoutMs / 1_000));
        }
        const remainingQueue = Math.min(queueDeadline - now, executionDeadline - now);
        await this.waitForChange(Math.min(remainingQueue, 1_000), signal, observedRevision);
      } else if (snapshot.status === "claimed") {
        if (now >= executionDeadline) {
          throw new GatewayRequestTimeoutError();
        }
        await this.waitForChange(Math.min(executionDeadline - now, 1_000), signal, observedRevision);
      } else {
        await this.waitForChange(1_000, signal, observedRevision);
      }
    }
  }

  async job(requestId: string): Promise<GatewayJobSnapshot> {
    const validatedId = validateRequestId(requestId);
    return this.mutate(async (state) => {
      const changed = reclaimExpiredClaims(state, this.now().getTime());
      if (changed) {
        await this.persist(state);
        this.emitChange();
      }
      return publicJob(findJob(state, validatedId));
    });
  }

  async disconnectSession(sessionId: string): Promise<void> {
    const selectedSessionId = validateSessionId(sessionId);
    this.sessionGenerations.set(selectedSessionId, (this.sessionGenerations.get(selectedSessionId) ?? 0) + 1);
    await this.mutate(async (state) => {
      if (state.activeSessionId !== selectedSessionId) {
        this.emitChange();
        return;
      }
      const disconnectedAt = this.now().getTime();
      for (const job of state.jobs) {
        if (job.status !== "claimed" || job.claimedBy !== selectedSessionId) continue;
        rememberEndedClaim(job, "stale_claim", disconnectedAt);
        job.status = "queued";
        delete job.claimedAt;
        delete job.claimedBy;
        delete job.claimToken;
        delete job.leaseExpiresAt;
      }
      delete state.outstandingDelivery;
      delete state.activeSessionId;
      delete state.lastExchangeAt;
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
    const sessionGeneration = this.sessionGenerations.get(selectedSessionId) ?? 0;
    const selectedCompletion = completion ? validateCompletion(completion) : undefined;
    if (!Number.isSafeInteger(maximumWaitSeconds) || maximumWaitSeconds < 1 || maximumWaitSeconds > GATEWAY_MAX_WAIT_SECONDS) {
      throw new Error(`maximumWaitSeconds must be an integer from 1 through ${GATEWAY_MAX_WAIT_SECONDS}`);
    }
    const startedAt = Date.now();
    const deadline = startedAt + maximumWaitSeconds * 1_000;
    let completionApplied = false;
    const pollId = this.beginWorkerPoll();

    try {
    while (true) {
      if (signal?.aborted) throw new Error("Gateway exchange was cancelled");
      if ((this.sessionGenerations.get(selectedSessionId) ?? 0) !== sessionGeneration) {
        const released = await this.releasedExchangeResult();
        if (released) return released;
        if (selectedCompletion) {
          return recoveryResult(new GatewayLifecycleError(
            "stale_claim",
            "resync",
            "This gateway claim belongs to a replaced transport; discard the late result and poll for the current delivery.",
            selectedCompletion.requestId,
          ));
        }
        return idleResult(startedAt);
      }
      const observedRevision = this.changeRevision;
      const selected = await this.mutate(async (state): Promise<GatewayExchangeResult | undefined> => {
        if ((this.sessionGenerations.get(selectedSessionId) ?? 0) !== sessionGeneration) return undefined;
        const nowMs = this.now().getTime();
        let changed = reclaimExpiredClaims(state, nowMs);
        if (state.released) {
          if (changed) {
            await this.persist(state);
            this.emitChange();
          }
          return { state: "released", continue: false, reason: state.releaseReason || "Gateway released" };
        }

        changed = bindSession(state, selectedSessionId, nowMs, this.staleAfterMs) || changed;
        // lastExchangeAt is a hot in-memory heartbeat. Queue/claim/completion
        // transitions below remain durable, but idle polls do not fsync it.
        state.lastExchangeAt = new Date(nowMs).toISOString();

        if (selectedCompletion && !completionApplied) {
          const replay = findExchangeReplay(state, selectedSessionId, selectedCompletion, nowMs);
          if (replay) {
            const resolved = resolveExchangeReplay(state, selectedSessionId, replay, nowMs, this.claimLeaseMs);
            if (resolved.changed || changed) {
              await this.persist(state);
              this.emitChange();
            }
            return cloneExchangeResult(resolved.result);
          }
          const digest = completionDigest(selectedCompletion);
          const pending = state.pendingCompletion;
          let acceptedDuplicate = false;
          if (pending && pending.sessionId === selectedSessionId && pending.requestId === selectedCompletion.requestId && pending.claimToken === selectedCompletion.claimToken) {
            if (pending.completionDigest !== digest) {
              throw new Error("Gateway completion conflicts with the already accepted completion for this request");
            }
            acceptedDuplicate = true;
            completionApplied = true;
          } else {
            const completionJob = findJob(state, selectedCompletion.requestId);
            if (completionJob.status === "claimed" &&
                completionJob.claimedBy === selectedSessionId &&
                completionJob.claimToken !== selectedCompletion.claimToken) {
              throw new Error("Gateway claim token does not match the active request");
            }
            if (completionJob.status !== "claimed" &&
                completionJob.lastClaimedBy === selectedSessionId &&
                completionJob.lastClaimToken !== undefined &&
                completionJob.lastClaimToken !== selectedCompletion.claimToken) {
              throw new Error("Gateway claim token does not match the ended request");
            }
            const terminalDuplicate = isAcceptedTerminalCompletion(
              completionJob,
              selectedSessionId,
              selectedCompletion,
            );
            if (isTerminalCompletionClaim(completionJob, selectedSessionId, selectedCompletion) && !terminalDuplicate) {
              throw new Error("Gateway completion conflicts with the already accepted completion for this request");
            }
            acceptedDuplicate = terminalDuplicate;
            if (!terminalDuplicate) {
              const lifecycle = endedClaimRecovery(completionJob, selectedSessionId, selectedCompletion);
              if (lifecycle) {
                if (changed) {
                  await this.persist(state);
                  this.emitChange();
                }
                return recoveryResult(lifecycle);
              }
              const outstanding = state.outstandingDelivery;
              if (outstanding && (
                outstanding.sessionId !== selectedSessionId ||
                outstanding.requestId !== selectedCompletion.requestId ||
                outstanding.claimToken !== selectedCompletion.claimToken
              )) {
                if (selectedCompletion.claimToken !== outstanding.claimToken) {
                  throw new Error("Gateway claim token does not match the current worker delivery");
                }
                const busy = new GatewayLifecycleError(
                  "worker_busy",
                  "bounded_wait",
                  "A different gateway request is still outstanding for this worker; retry the exact current delivery after it is resolved.",
                  outstanding.requestId,
                );
                if (changed) {
                  await this.persist(state);
                  this.emitChange();
                }
                return recoveryResult(busy);
              }
              const anotherClaimed = state.jobs.find((job) =>
                job.status === "claimed" &&
                job.claimedBy === selectedSessionId &&
                job.requestId !== selectedCompletion.requestId,
              );
              if (anotherClaimed) {
                if (selectedCompletion.claimToken !== anotherClaimed.claimToken) {
                  throw new Error("Gateway claim token does not match the current worker delivery");
                }
                const busy = new GatewayLifecycleError(
                  "worker_busy",
                  "bounded_wait",
                  "A different gateway request is still outstanding for this worker; retry the exact current delivery after it is resolved.",
                  anotherClaimed.requestId,
                );
                if (changed) {
                  await this.persist(state);
                  this.emitChange();
                }
                return recoveryResult(busy);
              }
            }
            try {
              if (!terminalDuplicate) {
                applyCompletion(state, selectedSessionId, selectedCompletion, new Date(nowMs).toISOString());
              }
            } catch (error) {
              if (error instanceof GatewayLifecycleError) {
                if (changed) {
                  await this.persist(state);
                  this.emitChange();
                }
                return recoveryResult(error);
              }
              throw error;
            }
            completionApplied = true;
            if (acceptedDuplicate) {
              const outstanding = state.outstandingDelivery;
              if (outstanding) {
                const current = state.jobs.find((job) =>
                  job.requestId === outstanding.requestId &&
                  job.status === "claimed" &&
                  job.claimedBy === outstanding.sessionId &&
                  job.claimToken === outstanding.claimToken,
                );
                if (current) {
                  if (outstanding.sessionId !== selectedSessionId) return replayWorkerBusy(current.requestId);
                  return requestResult(current);
                }
                delete state.outstandingDelivery;
                changed = true;
              }
            }
            if (state.outstandingDelivery?.requestId === selectedCompletion.requestId) delete state.outstandingDelivery;
            const result = claimNextOrIdle(state, selectedSessionId, nowMs, this.claimLeaseMs, startedAt);
            if (result.state === "request") {
              delete state.pendingCompletion;
              rememberExchangeReplay(state, selectedSessionId, selectedCompletion, result, new Date(nowMs).toISOString(), nowMs);
              await this.persist(state);
              this.emitChange();
              return result;
            }
            state.pendingCompletion = {
              sessionId: selectedSessionId,
              requestId: selectedCompletion.requestId,
              claimToken: selectedCompletion.claimToken,
              completionDigest: digest,
            };
            await this.persist(state);
            this.emitChange();
            return undefined;
          }
        }

        const outstanding = state.outstandingDelivery;
        if (outstanding && outstanding.sessionId === selectedSessionId) {
          const job = state.jobs.find((candidate) =>
            candidate.requestId === outstanding.requestId &&
            candidate.status === "claimed" &&
            candidate.claimedBy === selectedSessionId &&
            candidate.claimToken === outstanding.claimToken,
          );
          if (job) return requestResult(job);
          delete state.outstandingDelivery;
          changed = true;
        }

        // Compatibility with state written before delivery replay was added:
        // never claim a second job while this worker already owns one.
        const alreadyClaimed = state.jobs.find((job) => job.status === "claimed" && job.claimedBy === selectedSessionId);
        if (alreadyClaimed) {
          state.outstandingDelivery = {
            sessionId: selectedSessionId,
            requestId: alreadyClaimed.requestId,
            claimToken: alreadyClaimed.claimToken || "",
          };
          if (changed) {
            await this.persist(state);
            this.emitChange();
          }
          return requestResult(alreadyClaimed);
        }

        const queued = state.jobs.find((job) => job.status === "queued");
        if (queued) {
          const result = claimJob(queued, selectedSessionId, nowMs, this.claimLeaseMs);
          state.outstandingDelivery = {
            sessionId: selectedSessionId,
            requestId: queued.requestId,
            claimToken: queued.claimToken!,
          };
          if (state.pendingCompletion?.sessionId === selectedSessionId) {
            const pending = state.pendingCompletion;
            delete state.pendingCompletion;
            rememberExchangeReplayDigest(state, pending, result, new Date(nowMs).toISOString(), nowMs);
          }
          await this.persist(state);
          this.emitChange();
          return result;
        }

        if (changed) {
          await this.persist(state);
          this.emitChange();
        }
        return undefined;
      });
      if (selected) return selected;
      if ((this.sessionGenerations.get(selectedSessionId) ?? 0) !== sessionGeneration) {
        const released = await this.releasedExchangeResult();
        if (released) return released;
        if (selectedCompletion) {
          return recoveryResult(new GatewayLifecycleError(
            "stale_claim",
            "resync",
            "This gateway claim belongs to a replaced transport; discard the late result and poll for the current delivery.",
            selectedCompletion.requestId,
          ));
        }
        return idleResult(startedAt);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        const idle = idleResult(startedAt);
        if (completionApplied && selectedCompletion) {
          await this.mutate(async (state) => {
            const pending = state.pendingCompletion;
            if (!pending || pending.sessionId !== selectedSessionId || pending.requestId !== selectedCompletion.requestId || pending.claimToken !== selectedCompletion.claimToken) return;
            delete state.pendingCompletion;
            const replayedAt = this.now().getTime();
            rememberExchangeReplayDigest(state, pending, idle, new Date(replayedAt).toISOString(), replayedAt);
            await this.persist(state);
            this.emitChange();
          });
        }
        return idle;
      }
      await this.waitForChange(Math.min(remaining, 1_000), signal, observedRevision);
    }
    } finally {
      // The count describes this call's actual lifetime, including delivery,
      // idle waiting, cancellation, replacement, release, and failures.
      this.endWorkerPoll(pollId);
    }
  }

  private beginWorkerPoll(): number {
    const pollId = ++this.nextWorkerPollId;
    this.pendingWorkerPolls.add(pollId);
    return pollId;
  }

  private endWorkerPoll(pollId: number): void {
    this.pendingWorkerPolls.delete(pollId);
  }

  private async releasedExchangeResult(): Promise<GatewayExchangeResult | undefined> {
    return this.mutate(async (state) => state.released
      ? { state: "released", continue: false, reason: state.releaseReason || "Gateway released" }
      : undefined);
  }

  private async mutate<T>(operation: (state: StoredGatewayState) => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(async () => {
      const committedState = await this.loadState();
      const context: GatewayMutationContext = { committedState };
      this.mutationContext = context;
      // Work on a shallow, copy-on-write view. Only objects reached and
      // changed by this operation are copied; large retained messages/results
      // are never JSON-cloned merely to support rollback.
      const state = createLazyState(committedState);
      try {
        const result = await operation(state);
        this.cachedState = materializeState(state);
        return result;
      } catch (error) {
        // A rename followed by directory-sync failure is ambiguous: the new
        // state may already be visible, so reload it rather than restoring an
        // older cached object. Pre-rename failures retain the last committed
        // in-memory state, which also works if the state path is temporarily
        // inaccessible (for example, EISDIR during a failed test write).
        this.cachedState = error instanceof GatewayPersistenceError && error.renamed
          ? undefined
          : context.committedState;
        throw error;
      } finally {
        if (this.mutationContext === context) this.mutationContext = undefined;
      }
    });
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
    const durableState = materializeState(state);
    const serialized = `${JSON.stringify(durableState)}\n`;
    const temporaryPath = path.join(this.rootDir, `.state-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
    let file: Awaited<ReturnType<typeof fs.open>> | undefined;
    let renamed = false;
    try {
      file = await fs.open(temporaryPath, "wx", 0o600);
      await file.writeFile(serialized, "utf8");
      await file.sync();
      await file.close();
      file = undefined;
      await fs.rename(temporaryPath, this.statePath);
      renamed = true;
      await syncDirectory(this.rootDir);
    } catch (error) {
      await file?.close().catch(() => undefined);
      if (!renamed) await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw new GatewayPersistenceError(error, renamed);
    }
    this.cachedState = durableState;
    if (this.mutationContext) this.mutationContext.committedState = durableState;
  }

  private async ensureRoot(): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    await fs.chmod(this.rootDir, 0o700).catch(() => undefined);
  }

  private emitChange(): void {
    // The revision is advanced only after the durable rename/fsync completes.
    // Synchronous emission plus the revision check in waitForChange closes the
    // read-then-subscribe lost-wakeup window.
    this.changeRevision += 1;
    this.changes.emit("change");
  }

  private waitForChange(timeoutMs: number, signal?: AbortSignal, observedRevision = this.changeRevision): Promise<void> {
    if (signal?.aborted) return Promise.reject(new Error("Gateway wait was cancelled"));
    if (this.changeRevision !== observedRevision) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.changes.off("change", onChange);
        signal?.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve();
      };
      const onChange = () => finish();
      const onAbort = () => finish(new Error("Gateway wait was cancelled"));
      timer = setTimeout(() => finish(), Math.max(1, timeoutMs));
      timer.unref();
      this.changes.once("change", onChange);
      signal?.addEventListener("abort", onAbort, { once: true });
      // Either event may have happened between the initial check and listener
      // registration. Recheck after registration, and check abort as well.
      if (signal?.aborted) onAbort();
      else if (this.changeRevision !== observedRevision) onChange();
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
  if (value.outstandingDelivery !== undefined) {
    if (!isRecord(value.outstandingDelivery)) throw new Error("Malformed gateway outstanding delivery");
    state.outstandingDelivery = {
      sessionId: validateSessionId(value.outstandingDelivery.sessionId),
      requestId: validateRequestId(value.outstandingDelivery.requestId),
      claimToken: validateClaimToken(value.outstandingDelivery.claimToken),
    };
  }
  if (value.pendingCompletion !== undefined) {
    if (!isRecord(value.pendingCompletion) || typeof value.pendingCompletion.completionDigest !== "string" ||
        !/^[0-9a-f]{64}$/u.test(value.pendingCompletion.completionDigest)) {
      throw new Error("Malformed gateway pending completion");
    }
    state.pendingCompletion = {
      sessionId: validateSessionId(value.pendingCompletion.sessionId),
      requestId: validateRequestId(value.pendingCompletion.requestId),
      claimToken: validateClaimToken(value.pendingCompletion.claimToken),
      completionDigest: value.pendingCompletion.completionDigest,
    };
  }
  if (value.exchangeReplays !== undefined) {
    if (!Array.isArray(value.exchangeReplays)) throw new Error("Malformed gateway exchange replay list");
    state.exchangeReplays = value.exchangeReplays.map(validateStoredExchangeReplay);
  }
  return state;
}

function validateStoredExchangeReplay(value: unknown): StoredExchangeReplay {
  if (!isRecord(value)) throw new Error("Malformed gateway exchange replay");
  const completionDigest = value.completionDigest;
  if (typeof completionDigest !== "string" || !/^[0-9a-f]{64}$/u.test(completionDigest)) {
    throw new Error("Malformed gateway exchange replay digest");
  }
  return {
    sessionId: validateSessionId(value.sessionId),
    requestId: validateRequestId(value.requestId),
    claimToken: validateClaimToken(value.claimToken),
    completionDigest,
    createdAt: validateTimestamp(value.createdAt, "replay createdAt"),
    result: validateStoredExchangeResult(value.result),
  };
}

function validateStoredExchangeResult(value: unknown): GatewayExchangeResult {
  if (!isRecord(value) || typeof value.state !== "string" || typeof value.continue !== "boolean") {
    throw new Error("Malformed gateway exchange replay result");
  }
  const waitedSeconds = value.waited_seconds;
  if (value.state === "idle" && value.continue === true && typeof waitedSeconds === "number" && Number.isSafeInteger(waitedSeconds) && waitedSeconds >= 0) {
    return { state: "idle", continue: true, waited_seconds: waitedSeconds };
  }
  if (value.state === "request" && value.continue === true && isRecord(value.request)) {
    const request = validateGatewayRequestPayload({
      model: value.request.model,
      messages: value.request.messages,
      ...(value.request.tools === undefined ? {} : { tools: value.request.tools }),
      ...(value.request.tool_choice === undefined ? {} : { toolChoice: value.request.tool_choice }),
      ...(value.request.parallel_tool_calls === undefined ? {} : { parallelToolCalls: value.request.parallel_tool_calls }),
    });
    return {
      state: "request",
      continue: true,
      request: {
        request_id: validateRequestId(value.request.request_id),
        claim_token: validateClaimToken(value.request.claim_token),
        model: request.model,
        messages: request.messages,
        ...(request.tools === undefined ? {} : { tools: request.tools }),
        ...(request.toolChoice === undefined ? {} : { tool_choice: request.toolChoice }),
        ...(request.parallelToolCalls === undefined ? {} : { parallel_tool_calls: request.parallelToolCalls }),
      },
    };
  }
  if (value.state === "recovery" && value.continue === true &&
      (value.code === "request_cancelled" || value.code === "stale_claim" || value.code === "worker_busy") &&
      (value.next_action === "poll" || value.next_action === "resync" || value.next_action === "bounded_wait") &&
      typeof value.message === "string") {
    return {
      state: "recovery",
      continue: true,
      code: value.code,
      next_action: value.next_action,
      message: value.message,
      ...(value.request_id === undefined ? {} : { request_id: validateRequestId(value.request_id) }),
    };
  }
  throw new Error("Malformed gateway exchange replay result");
}

function validateStoredJob(value: unknown): StoredGatewayJob {
  if (!isRecord(value)) throw new Error("Malformed LLM gateway job");
  const status = value.status;
  if (!["queued", "claimed", "completed", "failed", "cancelled"].includes(String(status))) {
    throw new Error("Malformed LLM gateway job status");
  }
  const isTerminal = ["completed", "failed", "cancelled"].includes(String(status));
  let request: GatewayRequestPayload;
  if (isTerminal) {
    request = {
      model: typeof value.model === "string" && value.model.trim() ? value.model : GATEWAY_MODEL,
      messages: [{ role: "user", content: "" }],
    };
  } else {
    request = validateGatewayRequestPayload({
      model: value.model,
      messages: value.messages,
      ...(value.tools === undefined ? {} : { tools: value.tools }),
      ...(value.toolChoice === undefined ? {} : { toolChoice: value.toolChoice }),
      ...(value.parallelToolCalls === undefined ? {} : { parallelToolCalls: value.parallelToolCalls }),
    });
  }
  const job: StoredGatewayJob = {
    requestId: validateRequestId(value.requestId),
    ...copyRequest(request),
    status: status as GatewayJobStatus,
    createdAt: validateTimestamp(value.createdAt, "createdAt"),
  };
  if (typeof value.claimedAt === "string") job.claimedAt = validateTimestamp(value.claimedAt, "claimedAt");
  if (typeof value.claimedBy === "string") job.claimedBy = validateSessionId(value.claimedBy);
  if (typeof value.claimToken === "string") job.claimToken = validateClaimToken(value.claimToken);
  if (typeof value.leaseExpiresAt === "string") job.leaseExpiresAt = validateTimestamp(value.leaseExpiresAt, "leaseExpiresAt");
  if (typeof value.lastClaimedBy === "string") job.lastClaimedBy = validateSessionId(value.lastClaimedBy);
  if (typeof value.lastClaimToken === "string") job.lastClaimToken = validateClaimToken(value.lastClaimToken);
  if (typeof value.lastClaimEndedAt === "string") job.lastClaimEndedAt = validateTimestamp(value.lastClaimEndedAt, "lastClaimEndedAt");
  if (value.lastClaimEndedReason !== undefined &&
      !["cancelled", "stale_claim", "completed", "released"].includes(String(value.lastClaimEndedReason))) {
    throw new Error("Malformed last claim ending reason");
  }
  if (value.lastClaimEndedReason !== undefined) job.lastClaimEndedReason = value.lastClaimEndedReason as StoredGatewayJob["lastClaimEndedReason"];
  if (typeof value.completedAt === "string") job.completedAt = validateTimestamp(value.completedAt, "completedAt");
  if (value.response !== undefined) {
    job.response = isTerminal
      ? validateGatewayAssistantCompletion(value.response)
      : validateGatewayAssistantCompletion(value.response, request);
  }
  if (typeof value.completionDigest === "string") {
    if (!/^[0-9a-f]{64}$/u.test(value.completionDigest)) throw new Error("Malformed gateway completion digest");
    job.completionDigest = value.completionDigest;
  }
  if (typeof value.error === "string") job.error = validateText(value.error, "error", MAX_ERROR_BYTES);
  return job;
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
    ...(hasResponse ? { response: input.response } : {}),
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
  const digest = completionDigest(completion);
  if (job.status !== "claimed") {
    if (job.lastClaimToken === completion.claimToken && job.lastClaimedBy === sessionId) {
      if (job.lastClaimEndedReason === "cancelled") {
        throw new GatewayLifecycleError(
          "request_cancelled",
          "poll",
          "The caller cancelled this gateway request before the worker result arrived; discard the late result and poll for the next request.",
          job.requestId,
        );
      }
      if (job.lastClaimEndedReason === "stale_claim") {
        throw new GatewayLifecycleError(
          "stale_claim",
          "resync",
          "This gateway claim expired or its transport was replaced; discard the late result and poll for the current delivery.",
          job.requestId,
        );
      }
      if (job.lastClaimEndedReason === "completed") {
        if (job.completionDigest !== digest) {
          throw new Error("Gateway completion conflicts with the already accepted completion for this request");
        }
        return;
      }
    }
    throw new Error("Gateway request is not currently claimed");
  }
  if (job.claimedBy !== sessionId) throw new Error("Gateway request is claimed by another MCP session");
  if (job.claimToken !== completion.claimToken) {
    if (job.lastClaimToken === completion.claimToken && job.lastClaimedBy === sessionId && job.lastClaimEndedReason === "stale_claim") {
      throw new GatewayLifecycleError(
        "stale_claim",
        "resync",
        "This gateway claim expired or its transport was replaced; discard the late result and poll for the current delivery.",
        job.requestId,
      );
    }
    throw new Error("Gateway claim token does not match the active request");
  }
  const normalizedResponse = completion.response === undefined
    ? undefined
    : validateGatewayAssistantCompletion(completion.response, job);
  rememberEndedClaim(job, "completed", Date.parse(completedAt));
  job.status = normalizedResponse !== undefined ? "completed" : "failed";
  job.completedAt = completedAt;
  if (normalizedResponse !== undefined) job.response = normalizedResponse;
  if (completion.error !== undefined) job.error = completion.error;
  job.completionDigest = digest;
  job.messages = [{ role: "user", content: "" }];
  delete job.tools;
  delete job.toolChoice;
  delete job.parallelToolCalls;
  delete job.claimedAt;
  delete job.claimedBy;
  delete job.claimToken;
  delete job.leaseExpiresAt;
}

function requestResult(job: StoredGatewayJob): GatewayExchangeResult {
  if (!job.claimToken) throw new Error("Malformed claimed gateway request");
  return {
    state: "request",
    continue: true,
    request: {
      request_id: job.requestId,
      claim_token: job.claimToken,
      model: job.model,
      messages: job.messages.map(copyGatewayMessage),
      ...(job.tools === undefined ? {} : { tools: job.tools.map(copyGatewayTool) }),
      ...(job.toolChoice === undefined ? {} : { tool_choice: copyGatewayToolChoice(job.toolChoice) }),
      ...(job.parallelToolCalls === undefined ? {} : { parallel_tool_calls: job.parallelToolCalls }),
    },
  };
}

function claimJob(
  job: StoredGatewayJob,
  sessionId: string,
  nowMs: number,
  claimLeaseMs: number,
): GatewayExchangeResult {
  job.status = "claimed";
  job.claimedAt = new Date(nowMs).toISOString();
  job.claimedBy = sessionId;
  job.claimToken = `claim_${randomBytes(32).toString("base64url")}`;
  job.leaseExpiresAt = new Date(nowMs + claimLeaseMs).toISOString();
  return requestResult(job);
}

function claimNextOrIdle(
  state: StoredGatewayState,
  sessionId: string,
  nowMs: number,
  claimLeaseMs: number,
  startedAt: number,
): GatewayExchangeResult {
  const queued = state.jobs.find((job) => job.status === "queued");
  if (!queued) return idleResult(startedAt);
  const result = claimJob(queued, sessionId, nowMs, claimLeaseMs);
  state.outstandingDelivery = {
    sessionId,
    requestId: queued.requestId,
    claimToken: queued.claimToken!,
  };
  return result;
}

function recoveryResult(error: GatewayLifecycleError): GatewayExchangeResult {
  return {
    state: "recovery",
    continue: true,
    code: error.code,
    next_action: error.nextAction,
    message: error.message,
    ...(error.requestId ? { request_id: error.requestId } : {}),
  };
}

function completionDigest(completion: GatewayCompletionInput): string {
  const value = completion.response === undefined
    ? { error: completion.error }
    : { response: completion.response };
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function findExchangeReplay(
  state: StoredGatewayState,
  sessionId: string,
  completion: GatewayCompletionInput,
  nowMs: number,
): StoredExchangeReplay | undefined {
  const digest = completionDigest(completion);
  const matching = state.exchangeReplays?.find((replay) =>
    replay.sessionId === sessionId &&
    replay.requestId === completion.requestId &&
    replay.claimToken === completion.claimToken &&
    nowMs - Date.parse(replay.createdAt) <= MAX_EXCHANGE_REPLAY_AGE_MS,
  );
  if (!matching) return undefined;
  if (matching.completionDigest !== digest) {
    throw new Error("Gateway completion conflicts with the already accepted completion for this request");
  }
  return matching;
}

function rememberExchangeReplay(
  state: StoredGatewayState,
  sessionId: string,
  completion: GatewayCompletionInput,
  result: GatewayExchangeResult,
  createdAt: string,
  nowMs: number,
): void {
  rememberExchangeReplayDigest(state, {
    sessionId,
    requestId: completion.requestId,
    claimToken: completion.claimToken,
    completionDigest: completionDigest(completion),
  }, result, createdAt, nowMs);
}

function rememberExchangeReplayDigest(
  state: StoredGatewayState,
  pending: StoredPendingCompletion,
  result: GatewayExchangeResult,
  createdAt: string,
  nowMs: number,
): void {
  const replays = (state.exchangeReplays ?? []).filter((replay) =>
    replay.sessionId !== pending.sessionId ||
    replay.requestId !== pending.requestId ||
    replay.claimToken !== pending.claimToken,
  );
  replays.unshift({ ...pending, createdAt, result: cloneExchangeResult(result) });
  state.exchangeReplays = replays.slice(0, MAX_EXCHANGE_REPLAYS);
  trimExchangeReplays(state, nowMs);
}

function resolveExchangeReplay(
  state: StoredGatewayState,
  sessionId: string,
  replay: StoredExchangeReplay,
  nowMs: number,
  claimLeaseMs: number,
): { result: GatewayExchangeResult; changed: boolean } {
  let changed = false;
  if (replay.result.state === "recovery") return { result: replay.result, changed };

  // A replayed next delivery may have been cancelled or completed while the
  // original response was in flight. Resolve that terminal fact before
  // looking at the worker's newer outstanding delivery; otherwise a stream of
  // newer jobs could make the old retry return worker_busy forever.
  const initialReplayResult = replay.result;
  if (initialReplayResult.state === "request") {
    const replayJob = state.jobs.find((job) => job.requestId === initialReplayResult.request.request_id);
    if (!replayJob) {
      const result = replayStaleDelivery(initialReplayResult.request.request_id);
      replay.result = result;
      return { result, changed: true };
    }
    if (replayJob.status === "completed" || replayJob.status === "failed" || replayJob.status === "cancelled") {
      const result = replayTerminalOutcome(replayJob);
      replay.result = result;
      return { result, changed: true };
    }
  }

  const outstanding = state.outstandingDelivery;
  if (outstanding) {
    const current = state.jobs.find((job) =>
      job.requestId === outstanding.requestId &&
      job.status === "claimed" &&
      job.claimedBy === outstanding.sessionId &&
      job.claimToken === outstanding.claimToken,
    );
    if (!current) {
      delete state.outstandingDelivery;
      changed = true;
    } else if (outstanding.sessionId !== sessionId) {
      return { result: replayWorkerBusy(outstanding.requestId), changed };
    } else {
      const currentReplayResult = replay.result;
      const replayRequestId = currentReplayResult.state === "request" ? currentReplayResult.request.request_id : undefined;
      if (replayRequestId === undefined || replayRequestId === current.requestId) {
        return { result: requestResult(current), changed };
      }
      return { result: replayWorkerBusy(current.requestId), changed };
    }
  }

  const currentReplayResult = replay.result;
  if (currentReplayResult.state === "idle") {
    const queued = state.jobs.find((job) => job.status === "queued");
    if (!queued) return { result: currentReplayResult, changed };
    const result = claimJob(queued, sessionId, nowMs, claimLeaseMs);
    state.outstandingDelivery = {
      sessionId,
      requestId: queued.requestId,
      claimToken: queued.claimToken!,
    };
    replay.result = cloneExchangeResult(result);
    return { result, changed: true };
  }
  if (currentReplayResult.state !== "request") return { result: currentReplayResult, changed };

  const replayRequestId = currentReplayResult.request.request_id;
  const job = state.jobs.find((candidate) => candidate.requestId === replayRequestId);
  if (!job) {
    const result = replayStaleDelivery(replayRequestId);
    replay.result = result;
    return { result, changed: true };
  }
  if (job.status === "claimed") {
    if (job.claimedBy !== sessionId) return { result: replayWorkerBusy(job.requestId), changed };
    const result = requestResult(job);
    state.outstandingDelivery = {
      sessionId,
      requestId: job.requestId,
      claimToken: job.claimToken!,
    };
    if (JSON.stringify(replay.result) !== JSON.stringify(result)) {
      replay.result = cloneExchangeResult(result);
    }
    return { result, changed: true };
  }
  if (job.status === "queued") {
    const result = claimJob(job, sessionId, nowMs, claimLeaseMs);
    state.outstandingDelivery = {
      sessionId,
      requestId: job.requestId,
      claimToken: job.claimToken!,
    };
    replay.result = cloneExchangeResult(result);
    return { result, changed: true };
  }

  const result = replayTerminalOutcome(job);
  replay.result = result;
  return { result, changed: true };
}

function replayWorkerBusy(requestId: string): GatewayExchangeResult {
  return recoveryResult(new GatewayLifecycleError(
    "worker_busy",
    "bounded_wait",
    "A different gateway request is still outstanding for this worker; retry the exact current delivery after it is resolved.",
    requestId,
  ));
}

function replayStaleDelivery(requestId: string): GatewayExchangeResult {
  return recoveryResult(new GatewayLifecycleError(
    "stale_claim",
    "resync",
    "The replayed gateway delivery is no longer available; discard it and poll for the current delivery.",
    requestId,
  ));
}

function replayTerminalOutcome(job: StoredGatewayJob): GatewayExchangeResult {
  if (job.status === "cancelled") {
    return recoveryResult(new GatewayLifecycleError(
      "request_cancelled",
      "poll",
      "The next gateway delivery was cancelled before it was received; discard it and poll for the next request.",
      job.requestId,
    ));
  }
  return replayStaleDelivery(job.requestId);
}

function isTerminalCompletionClaim(
  job: StoredGatewayJob,
  sessionId: string,
  completion: GatewayCompletionInput,
): boolean {
  return (job.status === "completed" || job.status === "failed") &&
    job.lastClaimEndedReason === "completed" &&
    job.lastClaimedBy === sessionId &&
    job.lastClaimToken === completion.claimToken;
}

function endedClaimRecovery(
  job: StoredGatewayJob,
  sessionId: string,
  completion: GatewayCompletionInput,
): GatewayLifecycleError | undefined {
  if (job.status === "claimed" || job.lastClaimedBy !== sessionId || job.lastClaimToken !== completion.claimToken) {
    return undefined;
  }
  if (job.lastClaimEndedReason === "cancelled") {
    return new GatewayLifecycleError(
      "request_cancelled",
      "poll",
      "The caller cancelled this gateway request before the worker result arrived; discard the late result and poll for the next request.",
      job.requestId,
    );
  }
  if (job.lastClaimEndedReason === "stale_claim") {
    return new GatewayLifecycleError(
      "stale_claim",
      "resync",
      "This gateway claim expired or its transport was replaced; discard the late result and poll for the current delivery.",
      job.requestId,
    );
  }
  return undefined;
}

function isAcceptedTerminalCompletion(
  job: StoredGatewayJob,
  sessionId: string,
  completion: GatewayCompletionInput,
): boolean {
  return isTerminalCompletionClaim(job, sessionId, completion) &&
    job.completionDigest === completionDigest(completion);
}

function cloneExchangeResult(result: GatewayExchangeResult): GatewayExchangeResult {
  return JSON.parse(JSON.stringify(result)) as GatewayExchangeResult;
}

interface LazyStateNode {
  target: Record<PropertyKey, unknown> | unknown[];
  proxy: object;
}

interface LazyStateContext {
  nodes: WeakMap<object, LazyStateNode>;
  targets: WeakMap<object, LazyStateNode>;
}

const lazyStateProxies = new WeakMap<object, LazyStateNode>();

function createLazyState(state: StoredGatewayState): StoredGatewayState {
  const context: LazyStateContext = {
    nodes: new WeakMap(),
    targets: new WeakMap(),
  };
  return createLazyStateNode(context, state, undefined, undefined, false).proxy as StoredGatewayState;
}

function createLazyStateNode(
  context: LazyStateContext,
  source: object,
  parent?: LazyStateNode,
  property?: PropertyKey,
  reuseExisting = true,
): LazyStateNode {
  if (reuseExisting) {
    const existingProxy = context.nodes.get(source);
    if (existingProxy) {
      if (parent !== undefined && property !== undefined) Reflect.set(parent.target, property, existingProxy.target);
      return existingProxy;
    }
    const existingTarget = context.targets.get(source);
    if (existingTarget) {
      if (parent !== undefined && property !== undefined) Reflect.set(parent.target, property, existingTarget.target);
      return existingTarget;
    }
  }
  const target = Array.isArray(source)
    ? source.slice()
    : { ...source };
  const node: LazyStateNode = { target, proxy: undefined as never };
  node.proxy = new Proxy(target, {
    get(_target, key, receiver) {
      const value = Reflect.get(node.target, key, receiver);
      return isObjectLike(value)
        ? createLazyStateNode(context, value, node, key).proxy
        : value;
    },
    set(_target, key, value) {
      Reflect.set(node.target, key, unwrapLazyStateValue(value));
      return true;
    },
    deleteProperty(_target, key) {
      return Reflect.deleteProperty(node.target, key);
    },
  });
  context.nodes.set(source, node);
  context.targets.set(target, node);
  lazyStateProxies.set(node.proxy, node);
  if (parent !== undefined && property !== undefined) Reflect.set(parent.target, property, target);
  return node;
}

function materializeState(state: StoredGatewayState): StoredGatewayState {
  const node = lazyStateProxies.get(state);
  const target = node?.target ?? state;
  for (const key of Reflect.ownKeys(target)) {
    Reflect.set(target, key, unwrapLazyStateValue(Reflect.get(target, key)));
  }
  return target as unknown as StoredGatewayState;
}

function unwrapLazyStateValue(value: unknown): unknown {
  if (isObjectLike(value)) {
    const node = lazyStateProxies.get(value);
    if (node) return node.target;
    if (Array.isArray(value)) return value.map(unwrapLazyStateValue);
  }
  return value;
}

function isObjectLike(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function trimExchangeReplays(state: StoredGatewayState, nowMs: number): void {
  const replays = (state.exchangeReplays ?? []).filter((replay) =>
    nowMs - Date.parse(replay.createdAt) <= MAX_EXCHANGE_REPLAY_AGE_MS,
  ).slice(0, MAX_EXCHANGE_REPLAYS);
  while (replays.length > 0 &&
    Buffer.byteLength(JSON.stringify(replays), "utf8") > MAX_EXCHANGE_REPLAY_BYTES) {
    replays.pop();
  }
  if (replays.length === 0) delete state.exchangeReplays;
  else state.exchangeReplays = replays;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function bindSession(state: StoredGatewayState, sessionId: string, nowMs: number, staleAfterMs: number): boolean {
  if (!state.activeSessionId || state.activeSessionId === sessionId) {
    const changed = state.activeSessionId !== sessionId;
    state.activeSessionId = sessionId;
    return changed;
  }
  if (isSessionFresh(state, nowMs, staleAfterMs)) throw new Error("Another ChatGPT gateway MCP session is already active");
  for (const job of state.jobs) {
    if (job.status !== "claimed" || job.claimedBy !== state.activeSessionId) continue;
    rememberEndedClaim(job, "stale_claim", nowMs);
    job.status = "queued";
    delete job.claimedAt;
    delete job.claimedBy;
    delete job.claimToken;
    delete job.leaseExpiresAt;
  }
  delete state.outstandingDelivery;
  delete state.pendingCompletion;
  delete state.exchangeReplays;
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

function currentGatewayClaim(state: StoredGatewayState): StoredGatewayJob | undefined {
  const claimed = state.jobs.filter((job) => job.status === "claimed");
  if (claimed.length === 0) return undefined;
  if (state.activeSessionId) {
    return claimed.find((job) => job.claimedBy === state.activeSessionId) ?? claimed[0];
  }
  return claimed[0];
}

function classifyWorkerContact(
  state: StoredGatewayState,
  nowMs: number,
  staleAfterMs: number,
): GatewayWorkerContact {
  if (!state.activeSessionId || !state.lastExchangeAt) return "never";
  const lastExchangeMs = Date.parse(state.lastExchangeAt);
  if (!Number.isFinite(lastExchangeMs)) return "never";
  return nowMs - lastExchangeMs <= staleAfterMs ? "recent" : "stale";
}

function claimAgeMs(job: StoredGatewayJob, nowMs: number): number {
  const claimedAtMs = job.claimedAt ? Date.parse(job.claimedAt) : nowMs;
  return Math.max(0, Number.isFinite(claimedAtMs) ? nowMs - claimedAtMs : 0);
}

function oldestQueueAgeMs(jobs: StoredGatewayJob[], nowMs: number): number {
  let oldestCreatedAtMs: number | undefined;
  for (const job of jobs) {
    if (job.status !== "queued") continue;
    const createdAtMs = Date.parse(job.createdAt);
    if (!Number.isFinite(createdAtMs)) continue;
    if (oldestCreatedAtMs === undefined || createdAtMs < oldestCreatedAtMs) oldestCreatedAtMs = createdAtMs;
  }
  return oldestCreatedAtMs === undefined ? 0 : Math.max(0, nowMs - oldestCreatedAtMs);
}

function nextStatusAction(
  released: boolean,
  workerContact: GatewayWorkerContact,
  hasClaim: boolean,
  pendingWorkerPolls: number,
): GatewayStatusNextAction {
  if (released) return "none";
  if (hasClaim) return workerContact === "recent" ? "wait_for_worker" : "inspect_claim";
  if (pendingWorkerPolls > 0) return "wait_for_worker";
  if (workerContact === "recent") return "poll";
  return "wake_worker";
}

function reclaimExpiredClaims(state: StoredGatewayState, nowMs: number): boolean {
  let changed = false;
  for (const job of state.jobs) {
    if (job.status !== "claimed") continue;
    const leaseExpiresAt = job.leaseExpiresAt ? Date.parse(job.leaseExpiresAt) : 0;
    if (leaseExpiresAt > nowMs) continue;
    rememberEndedClaim(job, "stale_claim", nowMs);
    job.status = "queued";
    delete job.claimedAt;
    delete job.claimedBy;
    delete job.claimToken;
    delete job.leaseExpiresAt;
    changed = true;
  }
  if (state.outstandingDelivery) {
    const delivery = state.outstandingDelivery;
    const job = state.jobs.find((candidate) => candidate.requestId === delivery.requestId);
    if (!job || job.status !== "claimed" || job.claimToken !== delivery.claimToken) {
      delete state.outstandingDelivery;
      changed = true;
    }
  }
  return changed;
}

function rememberEndedClaim(
  job: StoredGatewayJob,
  reason: StoredGatewayJob["lastClaimEndedReason"],
  endedAtMs: number,
): void {
  if (!job.claimedBy || !job.claimToken) return;
  job.lastClaimedBy = job.claimedBy;
  job.lastClaimToken = job.claimToken;
  job.lastClaimEndedAt = new Date(endedAtMs).toISOString();
  job.lastClaimEndedReason = reason;
}

function countStatuses(jobs: StoredGatewayJob[]): Omit<
  GatewayStatusSnapshot,
  "state" | "active_session_id" | "last_exchange_at" | "release_reason" |
  "worker_polling" | "pending_worker_polls" | "worker_contact" | "processing_claim" |
  "claim_age_ms" | "lease_expires_at" | "oldest_queue_age_ms" | "next_action"
> {
  return {
    queued: jobs.filter((job) => job.status === "queued").length,
    claimed: jobs.filter((job) => job.status === "claimed").length,
    completed: jobs.filter((job) => job.status === "completed").length,
    failed: jobs.filter((job) => job.status === "failed").length,
    cancelled: jobs.filter((job) => job.status === "cancelled").length,
  };
}

function pruneJobs(state: StoredGatewayState): void {
  const terminal = new Set<GatewayJobStatus>(["completed", "failed", "cancelled"]);
  for (const job of state.jobs) {
    if (terminal.has(job.status)) {
      if (job.messages.length !== 1 || job.messages[0]?.content !== "") {
        job.messages = [{ role: "user", content: "" }];
      }
      delete job.tools;
      delete job.toolChoice;
      delete job.parallelToolCalls;
      delete job.claimedAt;
      delete job.claimedBy;
      delete job.leaseExpiresAt;
    }
  }
  if (state.jobs.length <= MAX_RETAINED_JOBS) return;
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
    ...copyRequest(job),
    status: job.status,
    createdAt: job.createdAt,
    ...(job.claimedAt ? { claimedAt: job.claimedAt } : {}),
    ...(job.leaseExpiresAt ? { leaseExpiresAt: job.leaseExpiresAt } : {}),
    ...(job.completedAt ? { completedAt: job.completedAt } : {}),
    ...(job.response === undefined ? {} : { response: copyGatewayAssistantCompletion(job.response) }),
    ...(job.error !== undefined ? { error: job.error } : {}),
  };
}

function copyRequest(request: Pick<GatewayRequestPayload, "model" | "messages" | "tools" | "toolChoice" | "parallelToolCalls">): GatewayRequestPayload {
  return {
    model: request.model,
    messages: request.messages.map(copyGatewayMessage),
    ...(request.tools === undefined ? {} : { tools: request.tools.map(copyGatewayTool) }),
    ...(request.toolChoice === undefined ? {} : { toolChoice: copyGatewayToolChoice(request.toolChoice) }),
    ...(request.parallelToolCalls === undefined ? {} : { parallelToolCalls: request.parallelToolCalls }),
  };
}

function idleResult(startedAt: number): GatewayExchangeResult {
  return {
    state: "idle",
    continue: true,
    waited_seconds: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
  };
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
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (!isNodeError(error, "EINVAL") && !isNodeError(error, "ENOTSUP") && !isNodeError(error, "EISDIR")) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
