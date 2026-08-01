export const SCHEDULING_TASK_PRIORITIES = ["P0", "P1", "P2", "P3"] as const;
export const SCHEDULING_TASK_RISKS = ["low", "medium", "high"] as const;
export const SCHEDULING_DEPENDENCY_CONDITIONS = ["completed", "terminal"] as const;
export const SCHEDULING_SCOPE_MODES = ["exclusive_write", "shared_review", "read_interest"] as const;
export const SCHEDULING_SCOPE_KINDS = ["file", "directory", "component"] as const;
export const SCHEDULING_START_GATES = ["none", "plan_required", "approval_required"] as const;
export const SCHEDULING_WORKSPACE_REQUIREMENTS = ["none", "authorized"] as const;
export const SCHEDULING_REVIEW_REQUIREMENTS = [
  "none",
  "self",
  "different_session",
  "different_actor",
  "human_owner",
] as const;
export const SCHEDULING_TASK_STATUSES = [
  "open",
  "working",
  "input_required",
  "completed",
  "failed",
  "cancelled",
] as const;

export const SCHEDULING_MAX_TASKS = 200;
export const SCHEDULING_MAX_DEPENDENCIES = 50;
export const SCHEDULING_MAX_SCOPES = 50;
export const SCHEDULING_MAX_ROLES = 20;
export const SCHEDULING_MAX_CAPABILITIES = 20;
export const SCHEDULING_MAX_WORKSPACES = 20;
export const SCHEDULING_MAX_CONFLICT_OVERRIDES = 20;
export const SCHEDULING_MAX_DIAGNOSTICS = 20;

export type SchedulingTaskPriority = typeof SCHEDULING_TASK_PRIORITIES[number];
export type SchedulingTaskRisk = typeof SCHEDULING_TASK_RISKS[number];
export type SchedulingDependencyCondition = typeof SCHEDULING_DEPENDENCY_CONDITIONS[number];
export type SchedulingScopeMode = typeof SCHEDULING_SCOPE_MODES[number];
export type SchedulingScopeKind = typeof SCHEDULING_SCOPE_KINDS[number];
export type SchedulingStartGate = typeof SCHEDULING_START_GATES[number];
export type SchedulingWorkspaceRequirement = typeof SCHEDULING_WORKSPACE_REQUIREMENTS[number];
export type SchedulingReviewRequirement = typeof SCHEDULING_REVIEW_REQUIREMENTS[number];
export type SchedulingTaskStatus = typeof SCHEDULING_TASK_STATUSES[number];
export type SchedulingProjectState = "running" | "paused" | "closed";
export type SchedulingOwnerScope = "actor" | "collaboration_session";

export type SchedulingReasonCode =
  | "not_open"
  | "project_paused"
  | "project_closed"
  | "task_paused"
  | "not_before"
  | "dependencies_unmet"
  | "dependency_failed"
  | "dependency_cancelled"
  | "dependency_missing"
  | "dependency_cycle"
  | "role_mismatch"
  | "capability_mismatch"
  | "start_gate_unsatisfied"
  | "scope_conflict"
  | "workspace_unavailable"
  | "all_open_tasks_unready"
  | "no_open_tasks"
  | "policy_mismatch";

export type SchedulingRecoveryCode =
  | "wait_for_dependency"
  | "repair_or_replace_dependency"
  | "request_manager_scope_resolution"
  | "request_manager_role_assignment"
  | "request_manager_capability_assignment"
  | "satisfy_plan_or_approval_gate"
  | "register_or_repair_workspace"
  | "review_available_tasks"
  | "create_bounded_work_proposal"
  | "manager_resume_project"
  | "manager_repair_task_graph"
  | "wait_until_relevant_time";

export interface SchedulingDependency {
  taskId: string;
  condition: SchedulingDependencyCondition;
}

export interface SchedulingScopeClaim {
  kind: SchedulingScopeKind;
  value: string;
  mode: SchedulingScopeMode;
}

export interface SchedulingPause {
  reasonCode: string;
  explanation: string;
  pausedBy: string;
  pausedAt: string;
  expiresAt?: string;
}

export interface SchedulingConflictOverride {
  conflictingTaskId: string;
  reason: string;
  issuedBy: string;
  issuedAt: string;
  expiresAt?: string;
  scopeRevision: number;
  conflictingScopeRevision: number;
}

export interface NormalizedTaskScheduling {
  schemaVersion: 1;
  priority: SchedulingTaskPriority;
  eligibleRoleIds: string[];
  requiredCapabilities: string[];
  dependencies: SchedulingDependency[];
  scopes: SchedulingScopeClaim[];
  risk: SchedulingTaskRisk;
  startGate: SchedulingStartGate;
  startGateSatisfiedRevision?: number;
  completionReview: SchedulingReviewRequirement;
  workspaceRequirement: SchedulingWorkspaceRequirement;
  notBefore?: string;
  paused?: SchedulingPause;
  conflictOverrides: SchedulingConflictOverride[];
  scopeRevision: number;
  legacyDefaultsApplied: boolean;
}

export interface SchedulingTask {
  taskId: string;
  projectId: string;
  status: SchedulingTaskStatus;
  revision: number;
  createdAt: string;
  updatedAt?: string;
  /** Reset or clear whenever the task transitions from ready to unready; stale values must not drive aging. */
  readySince?: string;
  title?: string;
  details?: string;
  scheduling?: unknown;
  ownerAgentId?: string;
  ownerCollaborationSessionId?: string;
  ownerScope?: SchedulingOwnerScope;
  assignedWorkspaceId?: string;
  leaseExpiresAt?: string;
}

export interface VerifiedSchedulingContext {
  agentId: string;
  agentName: string;
  collaborationSessionId: string;
  projectId: string;
  roleIds: string[];
  capabilities: string[];
  workspaceIds: string[];
  credentialBinding: "transport" | "server_session" | "legacy_recovery_handle";
}

export interface SchedulingAgingPolicy {
  enabled: boolean;
  intervalSeconds: number;
  maximumPriorityBoost: number;
}

export interface SchedulingProjectPolicy {
  version: number;
  state: SchedulingProjectState;
  pauseReason?: string;
  blockSharedReviewWithExclusiveWrite?: boolean;
  isolatedParallelWrites?: boolean;
  optionalAging?: SchedulingAgingPolicy;
}

export interface SchedulingSnapshot {
  projectId: string;
  revision: number;
  projectPolicy: SchedulingProjectPolicy;
  tasks: SchedulingTask[];
}

export interface DependencyGraphAnalysis {
  cycleTaskIds: Set<string>;
  cycles: string[][];
  missingByTask: Map<string, string[]>;
}

export interface SchedulingReadyEvaluation {
  taskId: string;
  ready: boolean;
  reasonCodes: SchedulingReasonCode[];
  blockingTaskIds: string[];
  conflictingTaskIds: string[];
  advisoryConflictTaskIds: string[];
  requiredRoleIds: string[];
  missingCapabilities: string[];
  notBefore?: string;
  nextRelevantAt?: string;
  recovery: SchedulingRecoveryCode[];
}

export interface SchedulingRankInfo {
  taskId: string;
  basePriority: SchedulingTaskPriority;
  effectivePriority: SchedulingTaskPriority;
  effectivePriorityRank: number;
  priorityBoost: number;
  downstreamUnblockScore: number;
  ageTimestamp: string;
  createdAt: string;
}

export interface SchedulingSelection {
  outcome: "selected";
  task: SchedulingTask;
  scheduling: NormalizedTaskScheduling;
  evaluation: SchedulingReadyEvaluation;
  rank: SchedulingRankInfo;
  consideredReadyTaskIds: string[];
}

export interface SchedulingSkippedCandidate {
  taskId: string;
  title?: string;
  priority: SchedulingTaskPriority;
  reasonCodes: SchedulingReasonCode[];
  blockingTaskIds?: string[];
  conflictingTaskIds?: string[];
  advisoryConflictTaskIds?: string[];
  requiredRoleIds?: string[];
  missingCapabilities?: string[];
  notBefore?: string;
  recovery: SchedulingRecoveryCode[];
}

export interface SchedulingNoReadyWork {
  outcome: "no_ready_work";
  primaryReason: SchedulingReasonCode;
  counts: Partial<Record<SchedulingReasonCode, number>>;
  skipped: SchedulingSkippedCandidate[];
  nextRelevantAt?: string;
  recovery: SchedulingRecoveryCode[];
  stateRevision: number;
  truncated: boolean;
}

export type SchedulingDecision = SchedulingSelection | SchedulingNoReadyWork;

export interface SchedulingDecisionOptions {
  now?: Date | string;
  diagnosticsLimit?: number;
}

interface NormalizedSnapshot {
  projectId: string;
  revision: number;
  projectPolicy: SchedulingProjectPolicy;
  tasks: NormalizedTask[];
  tasksById: Map<string, NormalizedTask>;
  graph: DependencyGraphAnalysis;
}

interface NormalizedTask extends Omit<SchedulingTask, "scheduling"> {
  scheduling: NormalizedTaskScheduling;
  createdAt: string;
  updatedAt?: string;
  readySince?: string;
  leaseExpiresAt?: string;
}

const PRIORITY_RANK: Record<SchedulingTaskPriority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
const RANK_PRIORITY: SchedulingTaskPriority[] = ["P0", "P1", "P2", "P3"];
const TERMINAL_STATUSES = new Set<SchedulingTaskStatus>(["completed", "failed", "cancelled"]);
const REASON_ORDER: SchedulingReasonCode[] = [
  "project_paused",
  "project_closed",
  "dependency_cycle",
  "dependency_missing",
  "dependency_failed",
  "dependency_cancelled",
  "start_gate_unsatisfied",
  "scope_conflict",
  "role_mismatch",
  "capability_mismatch",
  "workspace_unavailable",
  "dependencies_unmet",
  "not_before",
  "task_paused",
  "no_open_tasks",
  "all_open_tasks_unready",
  "policy_mismatch",
  "not_open",
];

const contextKeys = new Set([
  "agentId",
  "agentName",
  "collaborationSessionId",
  "projectId",
  "roleIds",
  "capabilities",
  "workspaceIds",
  "credentialBinding",
]);
const schedulingKeys = new Set([
  "schemaVersion",
  "priority",
  "eligibleRoleIds",
  "requiredCapabilities",
  "dependencies",
  "scopes",
  "risk",
  "startGate",
  "startGateSatisfiedRevision",
  "completionReview",
  "workspaceRequirement",
  "notBefore",
  "paused",
  "conflictOverrides",
  "scopeRevision",
  "legacyDefaultsApplied",
]);
const dependencyKeys = new Set(["taskId", "condition"]);
const scopeKeys = new Set(["kind", "value", "mode"]);
const pauseKeys = new Set(["reasonCode", "explanation", "pausedBy", "pausedAt", "expiresAt"]);
const overrideKeys = new Set([
  "conflictingTaskId",
  "reason",
  "issuedBy",
  "issuedAt",
  "expiresAt",
  "scopeRevision",
  "conflictingScopeRevision",
]);
const policyKeys = new Set([
  "version",
  "state",
  "pauseReason",
  "blockSharedReviewWithExclusiveWrite",
  "isolatedParallelWrites",
  "optionalAging",
]);
const agingKeys = new Set(["enabled", "intervalSeconds", "maximumPriorityBoost"]);

/** Normalize optional scheduling metadata. Missing metadata receives visible legacy defaults. */
export function normalizeTaskScheduling(value: unknown): NormalizedTaskScheduling {
  if (value === undefined) {
    return {
      schemaVersion: 1,
      priority: "P2",
      eligibleRoleIds: [],
      requiredCapabilities: [],
      dependencies: [],
      scopes: [],
      risk: "medium",
      startGate: "none",
      completionReview: "none",
      workspaceRequirement: "authorized",
      conflictOverrides: [],
      scopeRevision: 1,
      legacyDefaultsApplied: true,
    };
  }
  if (!isRecord(value)) throw new Error("scheduling must be an object");
  assertOnlyKeys(value, schedulingKeys, "scheduling");
  if (value.schemaVersion !== 1) throw new Error("scheduling.schemaVersion must be 1");

  const normalized: NormalizedTaskScheduling = {
    schemaVersion: 1,
    priority: validateEnum(value.priority, SCHEDULING_TASK_PRIORITIES, "scheduling.priority"),
    eligibleRoleIds: validateIdentifierArray(value.eligibleRoleIds, "scheduling.eligibleRoleIds", SCHEDULING_MAX_ROLES),
    requiredCapabilities: validateIdentifierArray(
      value.requiredCapabilities,
      "scheduling.requiredCapabilities",
      SCHEDULING_MAX_CAPABILITIES,
    ),
    dependencies: validateDependencies(value.dependencies),
    scopes: validateScopes(value.scopes),
    risk: validateEnum(value.risk, SCHEDULING_TASK_RISKS, "scheduling.risk"),
    startGate: value.startGate === undefined
      ? "none"
      : validateEnum(value.startGate, SCHEDULING_START_GATES, "scheduling.startGate"),
    completionReview: value.completionReview === undefined
      ? "none"
      : validateEnum(
          value.completionReview,
          SCHEDULING_REVIEW_REQUIREMENTS,
          "scheduling.completionReview",
        ),
    workspaceRequirement: value.workspaceRequirement === undefined
      ? "authorized"
      : validateEnum(
          value.workspaceRequirement,
          SCHEDULING_WORKSPACE_REQUIREMENTS,
          "scheduling.workspaceRequirement",
        ),
    conflictOverrides: validateConflictOverrides(value.conflictOverrides),
    scopeRevision: value.scopeRevision === undefined
      ? 1
      : validatePositiveInteger(value.scopeRevision, "scheduling.scopeRevision"),
    legacyDefaultsApplied: value.legacyDefaultsApplied === undefined
      ? false
      : validateBoolean(value.legacyDefaultsApplied, "scheduling.legacyDefaultsApplied"),
  };

  if (value.startGateSatisfiedRevision !== undefined) {
    normalized.startGateSatisfiedRevision = validatePositiveInteger(
      value.startGateSatisfiedRevision,
      "scheduling.startGateSatisfiedRevision",
    );
  }
  if (value.notBefore !== undefined) {
    normalized.notBefore = validateTimestamp(value.notBefore, "scheduling.notBefore");
  }
  if (value.paused !== undefined) normalized.paused = validatePause(value.paused);
  if (normalized.workspaceRequirement === "none" &&
      normalized.scopes.some((scope) => scope.mode === "exclusive_write")) {
    throw new Error("scheduling.workspaceRequirement must be authorized for exclusive_write scopes");
  }
  return normalized;
}

/** Analyze dependencies without repairing corrupt state or silently breaking cycles. */
export function analyzeDependencyGraph(tasks: readonly SchedulingTask[]): DependencyGraphAnalysis {
  const normalized = normalizeTasks(tasks);
  assertSingleProject(normalized);
  return analyzeNormalizedGraph(normalized);
}

/** Strict mutation/import gate: all dependencies must exist and the graph must be acyclic. */
export function assertValidDependencyGraph(tasks: readonly SchedulingTask[]): void {
  const normalized = normalizeTasks(tasks);
  assertSingleProject(normalized);
  const graph = analyzeNormalizedGraph(normalized);
  if (graph.missingByTask.size > 0) {
    const [taskId, missing] = [...graph.missingByTask.entries()].sort(([left], [right]) => left.localeCompare(right))[0];
    throw new Error(`Task ${taskId} references missing dependencies: ${missing.join(", ")}`);
  }
  if (graph.cycles.length > 0) {
    throw new Error(`Dependency cycle detected: ${graph.cycles[0].join(" -> ")}`);
  }
}

/** Exact, glob-free scope overlap. This does not replace filesystem confinement. */
export function schedulingScopesOverlap(left: SchedulingScopeClaim, right: SchedulingScopeClaim): boolean {
  const normalizedLeft = validateScope(left, "left scope");
  const normalizedRight = validateScope(right, "right scope");
  if (normalizedLeft.kind === "component" || normalizedRight.kind === "component") {
    return normalizedLeft.kind === "component" &&
      normalizedRight.kind === "component" &&
      normalizedLeft.value === normalizedRight.value;
  }
  if (normalizedLeft.kind === "file" && normalizedRight.kind === "file") {
    return normalizedLeft.value === normalizedRight.value;
  }
  if (normalizedLeft.kind === "directory" && normalizedRight.kind === "directory") {
    return pathContains(normalizedLeft.value, normalizedRight.value) ||
      pathContains(normalizedRight.value, normalizedLeft.value);
  }
  const file = normalizedLeft.kind === "file" ? normalizedLeft : normalizedRight;
  const directory = normalizedLeft.kind === "directory" ? normalizedLeft : normalizedRight;
  return pathContains(directory.value, file.value);
}

/** Evaluate one task against a fresh immutable scheduling snapshot. */
export function evaluateTaskReadiness(
  taskId: string,
  snapshot: SchedulingSnapshot,
  context: VerifiedSchedulingContext,
  options: SchedulingDecisionOptions = {},
): SchedulingReadyEvaluation {
  const normalizedContext = normalizeContext(context);
  const state = normalizeSnapshot(snapshot, normalizedContext);
  const task = state.tasksById.get(validateIdentifier(taskId, "taskId"));
  if (!task) throw new Error("Scheduling task not found");
  return evaluateNormalizedTask(task, state, normalizedContext, normalizeNow(options.now));
}

/**
 * Pure deterministic scheduler decision. The task store may call this while
 * holding its authoritative cross-process transaction and then persist the claim.
 */
export function selectNextReadyTask(
  snapshot: SchedulingSnapshot,
  context: VerifiedSchedulingContext,
  options: SchedulingDecisionOptions = {},
): SchedulingDecision {
  const normalizedContext = normalizeContext(context);
  const state = normalizeSnapshot(snapshot, normalizedContext);
  const now = normalizeNow(options.now);
  const diagnosticsLimit = options.diagnosticsLimit === undefined
    ? SCHEDULING_MAX_DIAGNOSTICS
    : validateBoundedInteger(options.diagnosticsLimit, "diagnosticsLimit", 1, SCHEDULING_MAX_DIAGNOSTICS);

  const openTasks = state.tasks.filter((task) => task.status === "open");
  if (openTasks.length === 0) {
    return {
      outcome: "no_ready_work",
      primaryReason: "no_open_tasks",
      counts: { no_open_tasks: 1 },
      skipped: [],
      recovery: recoveryForReasons(["no_open_tasks"]),
      stateRevision: state.revision,
      truncated: false,
    };
  }

  const evaluated = openTasks.map((task) => ({
    task,
    evaluation: evaluateNormalizedTask(task, state, normalizedContext, now),
  }));
  const ready = evaluated.filter((candidate) => candidate.evaluation.ready);
  if (ready.length > 0) {
    const ranked = ready.map((candidate) => ({
      ...candidate,
      rank: rankInfo(candidate.task, state, now),
    })).sort(compareRankedCandidates);
    const selected = ranked[0];
    return {
      outcome: "selected",
      task: copyTask(selected.task),
      scheduling: copyScheduling(selected.task.scheduling),
      evaluation: copyEvaluation(selected.evaluation),
      rank: { ...selected.rank },
      consideredReadyTaskIds: ranked.map((candidate) => candidate.task.taskId),
    };
  }

  return buildNoReadyWork(evaluated, state, diagnosticsLimit);
}

function normalizeSnapshot(snapshot: SchedulingSnapshot, context: VerifiedSchedulingContext): NormalizedSnapshot {
  if (!isRecord(snapshot)) throw new Error("scheduling snapshot must be an object");
  const projectId = validateIdentifier(snapshot.projectId, "snapshot.projectId");
  if (projectId !== context.projectId) throw new Error("Scheduling context project does not match snapshot project");
  const revision = validateNonNegativeInteger(snapshot.revision, "snapshot.revision");
  const projectPolicy = normalizeProjectPolicy(snapshot.projectPolicy);
  const tasks = normalizeTasks(snapshot.tasks);
  for (const task of tasks) {
    if (task.projectId !== projectId) throw new Error(`Task ${task.taskId} belongs to another project`);
  }
  const graph = analyzeNormalizedGraph(tasks);
  return {
    projectId,
    revision,
    projectPolicy,
    tasks,
    tasksById: new Map(tasks.map((task) => [task.taskId, task])),
    graph,
  };
}

function normalizeTasks(value: readonly SchedulingTask[] | unknown): NormalizedTask[] {
  if (!Array.isArray(value)) throw new Error("tasks must be an array");
  if (value.length > SCHEDULING_MAX_TASKS) throw new Error(`tasks exceeds limit of ${SCHEDULING_MAX_TASKS}`);
  const ids = new Set<string>();
  return value.map((candidate, index) => {
    if (!isRecord(candidate)) throw new Error(`tasks[${index}] must be an object`);
    const taskId = validateIdentifier(candidate.taskId, `tasks[${index}].taskId`);
    if (ids.has(taskId)) throw new Error(`Duplicate task ID: ${taskId}`);
    ids.add(taskId);
    const task: NormalizedTask = {
      taskId,
      projectId: validateIdentifier(candidate.projectId, `tasks[${index}].projectId`),
      status: validateEnum(candidate.status, SCHEDULING_TASK_STATUSES, `tasks[${index}].status`),
      revision: validatePositiveInteger(candidate.revision, `tasks[${index}].revision`),
      createdAt: validateTimestamp(candidate.createdAt, `tasks[${index}].createdAt`),
      scheduling: normalizeTaskScheduling(candidate.scheduling),
    };
    if (candidate.updatedAt !== undefined) {
      task.updatedAt = validateTimestamp(candidate.updatedAt, `tasks[${index}].updatedAt`);
    }
    if (candidate.readySince !== undefined) {
      task.readySince = validateTimestamp(candidate.readySince, `tasks[${index}].readySince`);
    }
    if (candidate.title !== undefined) task.title = validateUntrustedDisplayText(candidate.title, `tasks[${index}].title`, 256);
    if (candidate.details !== undefined) task.details = validateUntrustedDisplayText(candidate.details, `tasks[${index}].details`, 8192);
    if (candidate.ownerAgentId !== undefined) {
      task.ownerAgentId = validateIdentifier(candidate.ownerAgentId, `tasks[${index}].ownerAgentId`);
    }
    if (candidate.ownerCollaborationSessionId !== undefined) {
      task.ownerCollaborationSessionId = validateIdentifier(
        candidate.ownerCollaborationSessionId,
        `tasks[${index}].ownerCollaborationSessionId`,
      );
    }
    if (candidate.ownerScope !== undefined) {
      if (candidate.ownerScope !== "actor" && candidate.ownerScope !== "collaboration_session") {
        throw new Error(`tasks[${index}].ownerScope is invalid`);
      }
      task.ownerScope = candidate.ownerScope;
    }
    if (candidate.assignedWorkspaceId !== undefined) {
      task.assignedWorkspaceId = validateIdentifier(
        candidate.assignedWorkspaceId,
        `tasks[${index}].assignedWorkspaceId`,
      );
    }
    if (candidate.leaseExpiresAt !== undefined) {
      task.leaseExpiresAt = validateTimestamp(candidate.leaseExpiresAt, `tasks[${index}].leaseExpiresAt`);
    }
    if (task.scheduling.conflictOverrides.some((override) => override.conflictingTaskId === task.taskId)) {
      throw new Error(`tasks[${index}] contains a self conflict override`);
    }
    validateOwnershipShape(task, `tasks[${index}]`);
    return task;
  });
}

function assertSingleProject(tasks: NormalizedTask[]): void {
  if (tasks.length === 0) return;
  const projectId = tasks[0].projectId;
  const mismatched = tasks.find((task) => task.projectId !== projectId);
  if (mismatched) {
    throw new Error(`Dependency graph contains tasks from multiple projects: ${projectId}, ${mismatched.projectId}`);
  }
}

function validateOwnershipShape(task: NormalizedTask, field: string): void {
  const hasActor = task.ownerAgentId !== undefined;
  const hasSession = task.ownerCollaborationSessionId !== undefined;
  const hasScope = task.ownerScope !== undefined;
  const hasLease = task.leaseExpiresAt !== undefined;
  const hasAnyOwnership = hasActor || hasSession || hasScope || hasLease;
  const mayOwn = task.status === "working" || task.status === "input_required";

  if (!mayOwn && hasAnyOwnership) throw new Error(`${field} has ownership outside a leased status`);
  if (!hasAnyOwnership) {
    if (task.status === "working") throw new Error(`${field} working task lacks complete ownership`);
    return;
  }
  if (!hasActor || !hasScope || !hasLease) throw new Error(`${field} has incomplete ownership`);
  if (task.ownerScope === "collaboration_session" && !hasSession) {
    throw new Error(`${field} session-scoped ownership lacks collaboration session`);
  }
  if (task.ownerScope === "actor" && hasSession) {
    throw new Error(`${field} actor-scoped ownership must not include collaboration session authority`);
  }
}

function normalizeContext(value: VerifiedSchedulingContext): VerifiedSchedulingContext {
  if (!isRecord(value)) throw new Error("scheduling context must be an object");
  assertOnlyKeys(value, contextKeys, "scheduling context");
  const credentialBinding = value.credentialBinding;
  if (credentialBinding !== "transport" &&
      credentialBinding !== "server_session" &&
      credentialBinding !== "legacy_recovery_handle") {
    throw new Error("scheduling context credentialBinding is invalid");
  }
  return {
    agentId: validateIdentifier(value.agentId, "context.agentId"),
    agentName: validateText(value.agentName, "context.agentName", 100),
    collaborationSessionId: validateIdentifier(
      value.collaborationSessionId,
      "context.collaborationSessionId",
    ),
    projectId: validateIdentifier(value.projectId, "context.projectId"),
    roleIds: validateIdentifierArray(value.roleIds, "context.roleIds", SCHEDULING_MAX_ROLES),
    capabilities: validateIdentifierArray(
      value.capabilities,
      "context.capabilities",
      SCHEDULING_MAX_CAPABILITIES,
    ),
    workspaceIds: validateIdentifierArray(value.workspaceIds, "context.workspaceIds", SCHEDULING_MAX_WORKSPACES),
    credentialBinding,
  };
}

function normalizeProjectPolicy(value: unknown): SchedulingProjectPolicy {
  if (!isRecord(value)) throw new Error("projectPolicy must be an object");
  assertOnlyKeys(value, policyKeys, "projectPolicy");
  const state = value.state;
  if (state !== "running" && state !== "paused" && state !== "closed") {
    throw new Error("projectPolicy.state is invalid");
  }
  const policy: SchedulingProjectPolicy = {
    version: validatePositiveInteger(value.version, "projectPolicy.version"),
    state,
  };
  if (value.pauseReason !== undefined) {
    policy.pauseReason = validateText(value.pauseReason, "projectPolicy.pauseReason", 512);
  }
  if (value.blockSharedReviewWithExclusiveWrite !== undefined) {
    policy.blockSharedReviewWithExclusiveWrite = validateBoolean(
      value.blockSharedReviewWithExclusiveWrite,
      "projectPolicy.blockSharedReviewWithExclusiveWrite",
    );
  }
  if (value.isolatedParallelWrites !== undefined) {
    policy.isolatedParallelWrites = validateBoolean(
      value.isolatedParallelWrites,
      "projectPolicy.isolatedParallelWrites",
    );
  }
  if (value.optionalAging !== undefined) {
    if (!isRecord(value.optionalAging)) throw new Error("projectPolicy.optionalAging must be an object");
    assertOnlyKeys(value.optionalAging, agingKeys, "projectPolicy.optionalAging");
    policy.optionalAging = {
      enabled: validateBoolean(value.optionalAging.enabled, "projectPolicy.optionalAging.enabled"),
      intervalSeconds: validatePositiveInteger(
        value.optionalAging.intervalSeconds,
        "projectPolicy.optionalAging.intervalSeconds",
      ),
      maximumPriorityBoost: validateBoundedInteger(
        value.optionalAging.maximumPriorityBoost,
        "projectPolicy.optionalAging.maximumPriorityBoost",
        0,
        3,
      ),
    };
  }
  return policy;
}

function evaluateNormalizedTask(
  task: NormalizedTask,
  state: NormalizedSnapshot,
  context: VerifiedSchedulingContext,
  now: string,
): SchedulingReadyEvaluation {
  const reasons: SchedulingReasonCode[] = [];
  const blockingTaskIds = new Set<string>();
  const conflictingTaskIds = new Set<string>();
  const advisoryConflictTaskIds = new Set<string>();
  const missingCapabilities: string[] = [];
  let nextRelevantAt: string | undefined;

  if (task.status !== "open") reasons.push("not_open");
  if (state.projectPolicy.state === "paused") reasons.push("project_paused");
  if (state.projectPolicy.state === "closed") reasons.push("project_closed");

  const pause = task.scheduling.paused;
  if (pause && (!pause.expiresAt || pause.expiresAt > now)) {
    reasons.push("task_paused");
    if (pause.expiresAt) nextRelevantAt = pause.expiresAt;
  }
  if (task.scheduling.notBefore && task.scheduling.notBefore > now) {
    reasons.push("not_before");
    nextRelevantAt = earlierTimestamp(nextRelevantAt, task.scheduling.notBefore);
  }

  if (task.scheduling.eligibleRoleIds.length > 0 &&
      !task.scheduling.eligibleRoleIds.some((role) => context.roleIds.includes(role))) {
    reasons.push("role_mismatch");
  }
  for (const capability of task.scheduling.requiredCapabilities) {
    if (!context.capabilities.includes(capability)) missingCapabilities.push(capability);
  }
  if (missingCapabilities.length > 0) reasons.push("capability_mismatch");

  if (state.graph.cycleTaskIds.has(task.taskId)) reasons.push("dependency_cycle");
  const missing = state.graph.missingByTask.get(task.taskId) || [];
  if (missing.length > 0) {
    reasons.push("dependency_missing");
    for (const taskId of missing) blockingTaskIds.add(taskId);
  }

  if (!state.graph.cycleTaskIds.has(task.taskId)) {
    for (const dependency of task.scheduling.dependencies) {
      const dependencyTask = state.tasksById.get(dependency.taskId);
      if (!dependencyTask) continue;
      if (dependency.condition === "terminal") {
        if (!TERMINAL_STATUSES.has(dependencyTask.status)) {
          reasons.push("dependencies_unmet");
          blockingTaskIds.add(dependencyTask.taskId);
        }
        continue;
      }
      if (dependencyTask.status === "completed") continue;
      if (dependencyTask.status === "failed") reasons.push("dependency_failed");
      else if (dependencyTask.status === "cancelled") reasons.push("dependency_cancelled");
      else reasons.push("dependencies_unmet");
      blockingTaskIds.add(dependencyTask.taskId);
    }
  }

  if (task.scheduling.startGate !== "none" &&
      task.scheduling.startGateSatisfiedRevision !== task.revision) {
    reasons.push("start_gate_unsatisfied");
  }

  if (task.assignedWorkspaceId !== undefined && !context.workspaceIds.includes(task.assignedWorkspaceId)) {
    reasons.push("workspace_unavailable");
  } else if (task.scheduling.workspaceRequirement === "authorized" && context.workspaceIds.length === 0) {
    reasons.push("workspace_unavailable");
  }

  for (const active of state.tasks) {
    if (active.taskId === task.taskId || !isConflictActive(active, now)) continue;
    const disposition = scopeConflictDisposition(task, active, state.projectPolicy, now);
    if (disposition === "blocking") conflictingTaskIds.add(active.taskId);
    else if (disposition === "advisory") advisoryConflictTaskIds.add(active.taskId);
  }
  if (conflictingTaskIds.size > 0) reasons.push("scope_conflict");

  const reasonCodes = sortReasonCodes(reasons);
  return {
    taskId: task.taskId,
    ready: reasonCodes.length === 0,
    reasonCodes,
    blockingTaskIds: [...blockingTaskIds].sort(),
    conflictingTaskIds: [...conflictingTaskIds].sort(),
    advisoryConflictTaskIds: [...advisoryConflictTaskIds].sort(),
    requiredRoleIds: [...task.scheduling.eligibleRoleIds],
    missingCapabilities: missingCapabilities.sort(),
    ...(task.scheduling.notBefore ? { notBefore: task.scheduling.notBefore } : {}),
    ...(nextRelevantAt ? { nextRelevantAt } : {}),
    recovery: recoveryForReasons(reasonCodes),
  };
}

function isConflictActive(task: NormalizedTask, now: string): boolean {
  if (task.status !== "working" && task.status !== "input_required") return false;
  return task.ownerAgentId !== undefined &&
    task.ownerScope !== undefined &&
    task.leaseExpiresAt !== undefined &&
    task.leaseExpiresAt > now;
}

type ConflictDisposition = "none" | "blocking" | "advisory";

function scopeConflictDisposition(
  candidate: NormalizedTask,
  active: NormalizedTask,
  policy: SchedulingProjectPolicy,
  now: string,
): ConflictDisposition {
  if (candidate.scheduling.scopes.length === 0 || active.scheduling.scopes.length === 0) return "none";
  if (hasValidConflictOverride(candidate, active, now)) return "none";

  let hasBlockingOverlap = false;
  for (const left of candidate.scheduling.scopes) {
    for (const right of active.scheduling.scopes) {
      if (!schedulingScopesOverlap(left, right)) continue;
      if (left.mode === "read_interest" || right.mode === "read_interest") continue;
      if (left.mode === "shared_review" && right.mode === "shared_review") continue;
      if ((left.mode === "shared_review" || right.mode === "shared_review") &&
          policy.blockSharedReviewWithExclusiveWrite !== true) continue;
      if (left.mode === "exclusive_write" || right.mode === "exclusive_write") {
        hasBlockingOverlap = true;
      }
    }
  }
  if (!hasBlockingOverlap) return "none";

  const distinctWorkspaces = candidate.assignedWorkspaceId !== undefined &&
    active.assignedWorkspaceId !== undefined &&
    candidate.assignedWorkspaceId !== active.assignedWorkspaceId;
  if (distinctWorkspaces && policy.isolatedParallelWrites === true) return "advisory";
  return "blocking";
}

function hasValidConflictOverride(candidate: NormalizedTask, active: NormalizedTask, now: string): boolean {
  return candidate.scheduling.conflictOverrides.some((override) =>
    override.conflictingTaskId === active.taskId &&
    override.issuedAt <= now &&
    (!override.expiresAt || override.expiresAt > now) &&
    override.scopeRevision === candidate.scheduling.scopeRevision &&
    override.conflictingScopeRevision === active.scheduling.scopeRevision);
}

function rankInfo(task: NormalizedTask, state: NormalizedSnapshot, now: string): SchedulingRankInfo {
  const baseRank = PRIORITY_RANK[task.scheduling.priority];
  let boost = 0;
  const aging = state.projectPolicy.optionalAging;
  if (aging?.enabled && task.readySince) {
    const readyAgeSeconds = Math.max(0, (Date.parse(now) - Date.parse(task.readySince)) / 1000);
    boost = Math.min(Math.floor(readyAgeSeconds / aging.intervalSeconds), aging.maximumPriorityBoost);
  }
  const effectiveRank = Math.max(0, baseRank - boost);
  return {
    taskId: task.taskId,
    basePriority: task.scheduling.priority,
    effectivePriority: RANK_PRIORITY[effectiveRank],
    effectivePriorityRank: effectiveRank,
    priorityBoost: boost,
    downstreamUnblockScore: downstreamUnblockScore(task, state),
    ageTimestamp: task.readySince || task.createdAt,
    createdAt: task.createdAt,
  };
}

function downstreamUnblockScore(candidate: NormalizedTask, state: NormalizedSnapshot): number {
  let score = 0;
  for (const dependent of state.tasks) {
    if (TERMINAL_STATUSES.has(dependent.status) || dependent.taskId === candidate.taskId) continue;
    const direct = dependent.scheduling.dependencies.find((dependency) => dependency.taskId === candidate.taskId);
    if (!direct) continue;
    const allOthersSatisfied = dependent.scheduling.dependencies.every((dependency) => {
      if (dependency.taskId === candidate.taskId) return true;
      const task = state.tasksById.get(dependency.taskId);
      if (!task) return false;
      return dependency.condition === "terminal"
        ? TERMINAL_STATUSES.has(task.status)
        : task.status === "completed";
    });
    if (allOthersSatisfied) score += 1;
  }
  return score;
}

function compareRankedCandidates(
  left: { task: NormalizedTask; rank: SchedulingRankInfo },
  right: { task: NormalizedTask; rank: SchedulingRankInfo },
): number {
  return left.rank.effectivePriorityRank - right.rank.effectivePriorityRank ||
    right.rank.downstreamUnblockScore - left.rank.downstreamUnblockScore ||
    left.rank.ageTimestamp.localeCompare(right.rank.ageTimestamp) ||
    left.rank.createdAt.localeCompare(right.rank.createdAt) ||
    left.task.taskId.localeCompare(right.task.taskId);
}

function buildNoReadyWork(
  evaluated: Array<{ task: NormalizedTask; evaluation: SchedulingReadyEvaluation }>,
  state: NormalizedSnapshot,
  diagnosticsLimit: number,
): SchedulingNoReadyWork {
  const unorderedCounts: Partial<Record<SchedulingReasonCode, number>> = {};
  for (const { evaluation } of evaluated) {
    for (const reason of evaluation.reasonCodes) {
      unorderedCounts[reason] = (unorderedCounts[reason] || 0) + 1;
    }
  }
  const counts: Partial<Record<SchedulingReasonCode, number>> = {};
  for (const reason of REASON_ORDER) {
    if (unorderedCounts[reason]) counts[reason] = unorderedCounts[reason];
  }
  const primaryReason = REASON_ORDER.find((reason) => (counts[reason] || 0) > 0) || "all_open_tasks_unready";
  const ordered = [...evaluated].sort((left, right) =>
    PRIORITY_RANK[left.task.scheduling.priority] - PRIORITY_RANK[right.task.scheduling.priority] ||
    left.task.createdAt.localeCompare(right.task.createdAt) ||
    left.task.taskId.localeCompare(right.task.taskId));
  const skipped = ordered.slice(0, diagnosticsLimit).map(({ task, evaluation }): SchedulingSkippedCandidate => ({
    taskId: task.taskId,
    ...(task.title ? { title: task.title } : {}),
    priority: task.scheduling.priority,
    reasonCodes: [...evaluation.reasonCodes],
    ...(evaluation.blockingTaskIds.length ? { blockingTaskIds: [...evaluation.blockingTaskIds] } : {}),
    ...(evaluation.conflictingTaskIds.length ? { conflictingTaskIds: [...evaluation.conflictingTaskIds] } : {}),
    ...(evaluation.advisoryConflictTaskIds.length
      ? { advisoryConflictTaskIds: [...evaluation.advisoryConflictTaskIds] }
      : {}),
    ...(evaluation.requiredRoleIds.length ? { requiredRoleIds: [...evaluation.requiredRoleIds] } : {}),
    ...(evaluation.missingCapabilities.length ? { missingCapabilities: [...evaluation.missingCapabilities] } : {}),
    ...(evaluation.notBefore ? { notBefore: evaluation.notBefore } : {}),
    recovery: [...evaluation.recovery],
  }));
  const nextRelevantAt = evaluated.reduce<string | undefined>((earliest, candidate) =>
    earlierTimestamp(earliest, candidate.evaluation.nextRelevantAt), undefined);
  const allReasons = sortReasonCodes(Object.keys(counts) as SchedulingReasonCode[]);
  return {
    outcome: "no_ready_work",
    primaryReason,
    counts,
    skipped,
    ...(nextRelevantAt ? { nextRelevantAt } : {}),
    recovery: recoveryForReasons(allReasons.length ? allReasons : ["all_open_tasks_unready"]),
    stateRevision: state.revision,
    truncated: ordered.length > diagnosticsLimit,
  };
}

function analyzeNormalizedGraph(tasks: NormalizedTask[]): DependencyGraphAnalysis {
  const tasksById = new Map(tasks.map((task) => [task.taskId, task]));
  const missingByTask = new Map<string, string[]>();
  for (const task of tasks) {
    const missing = task.scheduling.dependencies
      .map((dependency) => dependency.taskId)
      .filter((dependencyId) => !tasksById.has(dependencyId))
      .sort();
    if (missing.length > 0) missingByTask.set(task.taskId, missing);
  }

  let index = 0;
  const indexes = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cycles: string[][] = [];

  const visit = (taskId: string): void => {
    indexes.set(taskId, index);
    lowLinks.set(taskId, index);
    index += 1;
    stack.push(taskId);
    onStack.add(taskId);

    const task = tasksById.get(taskId)!;
    for (const dependency of task.scheduling.dependencies) {
      if (!tasksById.has(dependency.taskId)) continue;
      if (!indexes.has(dependency.taskId)) {
        visit(dependency.taskId);
        lowLinks.set(taskId, Math.min(lowLinks.get(taskId)!, lowLinks.get(dependency.taskId)!));
      } else if (onStack.has(dependency.taskId)) {
        lowLinks.set(taskId, Math.min(lowLinks.get(taskId)!, indexes.get(dependency.taskId)!));
      }
    }

    if (lowLinks.get(taskId) !== indexes.get(taskId)) return;
    const component: string[] = [];
    while (stack.length > 0) {
      const current = stack.pop()!;
      onStack.delete(current);
      component.push(current);
      if (current === taskId) break;
    }
    const selfCycle = component.length === 1 &&
      tasksById.get(component[0])!.scheduling.dependencies.some((dependency) => dependency.taskId === component[0]);
    if (component.length > 1 || selfCycle) cycles.push(component.sort());
  };

  for (const taskId of [...tasksById.keys()].sort()) {
    if (!indexes.has(taskId)) visit(taskId);
  }
  cycles.sort((left, right) => left[0].localeCompare(right[0]));
  return {
    cycleTaskIds: new Set(cycles.flat()),
    cycles,
    missingByTask,
  };
}

function validateDependencies(value: unknown): SchedulingDependency[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("scheduling.dependencies must be an array");
  if (value.length > SCHEDULING_MAX_DEPENDENCIES) {
    throw new Error(`scheduling.dependencies exceeds limit of ${SCHEDULING_MAX_DEPENDENCIES}`);
  }
  const seen = new Set<string>();
  return value.map((candidate, index) => {
    if (!isRecord(candidate)) throw new Error(`scheduling.dependencies[${index}] must be an object`);
    assertOnlyKeys(candidate, dependencyKeys, `scheduling.dependencies[${index}]`);
    const taskId = validateIdentifier(candidate.taskId, `scheduling.dependencies[${index}].taskId`);
    if (seen.has(taskId)) throw new Error(`Duplicate dependency: ${taskId}`);
    seen.add(taskId);
    return {
      taskId,
      condition: candidate.condition === undefined
        ? "completed"
        : validateEnum(
            candidate.condition,
            SCHEDULING_DEPENDENCY_CONDITIONS,
            `scheduling.dependencies[${index}].condition`,
          ),
    };
  });
}

function validateScopes(value: unknown): SchedulingScopeClaim[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("scheduling.scopes must be an array");
  if (value.length > SCHEDULING_MAX_SCOPES) {
    throw new Error(`scheduling.scopes exceeds limit of ${SCHEDULING_MAX_SCOPES}`);
  }
  const seen = new Set<string>();
  return value.map((candidate, index) => {
    const scope = validateScope(candidate, `scheduling.scopes[${index}]`);
    const key = `${scope.kind}:${scope.value}:${scope.mode}`;
    if (seen.has(key)) throw new Error(`Duplicate scope claim: ${key}`);
    seen.add(key);
    return scope;
  });
}

function validateScope(value: unknown, field: string): SchedulingScopeClaim {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  assertOnlyKeys(value, scopeKeys, field);
  const kind = validateEnum(value.kind, SCHEDULING_SCOPE_KINDS, `${field}.kind`);
  const mode = validateEnum(value.mode, SCHEDULING_SCOPE_MODES, `${field}.mode`);
  const scopeValue = kind === "component"
    ? validateIdentifier(value.value, `${field}.value`)
    : validateScopePath(value.value, `${field}.value`, kind);
  return { kind, value: scopeValue, mode };
}

function validatePause(value: unknown): SchedulingPause {
  if (!isRecord(value)) throw new Error("scheduling.paused must be an object");
  assertOnlyKeys(value, pauseKeys, "scheduling.paused");
  const pause: SchedulingPause = {
    reasonCode: validateIdentifier(value.reasonCode, "scheduling.paused.reasonCode"),
    explanation: validateText(value.explanation, "scheduling.paused.explanation", 1024),
    pausedBy: validateIdentifier(value.pausedBy, "scheduling.paused.pausedBy"),
    pausedAt: validateTimestamp(value.pausedAt, "scheduling.paused.pausedAt"),
  };
  if (value.expiresAt !== undefined) {
    pause.expiresAt = validateTimestamp(value.expiresAt, "scheduling.paused.expiresAt");
  }
  return pause;
}

function validateConflictOverrides(value: unknown): SchedulingConflictOverride[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("scheduling.conflictOverrides must be an array");
  if (value.length > SCHEDULING_MAX_CONFLICT_OVERRIDES) {
    throw new Error(`scheduling.conflictOverrides exceeds limit of ${SCHEDULING_MAX_CONFLICT_OVERRIDES}`);
  }
  const seen = new Set<string>();
  return value.map((candidate, index) => {
    if (!isRecord(candidate)) throw new Error(`scheduling.conflictOverrides[${index}] must be an object`);
    assertOnlyKeys(candidate, overrideKeys, `scheduling.conflictOverrides[${index}]`);
    const override: SchedulingConflictOverride = {
      conflictingTaskId: validateIdentifier(
        candidate.conflictingTaskId,
        `scheduling.conflictOverrides[${index}].conflictingTaskId`,
      ),
      reason: validateText(candidate.reason, `scheduling.conflictOverrides[${index}].reason`, 1024),
      issuedBy: validateIdentifier(candidate.issuedBy, `scheduling.conflictOverrides[${index}].issuedBy`),
      issuedAt: validateTimestamp(candidate.issuedAt, `scheduling.conflictOverrides[${index}].issuedAt`),
      scopeRevision: validatePositiveInteger(
        candidate.scopeRevision,
        `scheduling.conflictOverrides[${index}].scopeRevision`,
      ),
      conflictingScopeRevision: validatePositiveInteger(
        candidate.conflictingScopeRevision,
        `scheduling.conflictOverrides[${index}].conflictingScopeRevision`,
      ),
    };
    if (seen.has(override.conflictingTaskId)) {
      throw new Error(`Duplicate conflict override: ${override.conflictingTaskId}`);
    }
    seen.add(override.conflictingTaskId);
    if (candidate.expiresAt !== undefined) {
      override.expiresAt = validateTimestamp(
        candidate.expiresAt,
        `scheduling.conflictOverrides[${index}].expiresAt`,
      );
    }
    if (override.expiresAt !== undefined && override.issuedAt > override.expiresAt) {
      throw new Error(`scheduling.conflictOverrides[${index}] expires before it is issued`);
    }
    return override;
  });
}

function recoveryForReasons(reasons: SchedulingReasonCode[]): SchedulingRecoveryCode[] {
  const recovery = new Set<SchedulingRecoveryCode>();
  for (const reason of reasons) {
    switch (reason) {
      case "project_paused":
      case "project_closed":
        recovery.add("manager_resume_project");
        break;
      case "dependency_cycle":
      case "dependency_missing":
        recovery.add("manager_repair_task_graph");
        break;
      case "dependency_failed":
      case "dependency_cancelled":
        recovery.add("repair_or_replace_dependency");
        break;
      case "dependencies_unmet":
        recovery.add("wait_for_dependency");
        break;
      case "scope_conflict":
        recovery.add("request_manager_scope_resolution");
        break;
      case "role_mismatch":
        recovery.add("request_manager_role_assignment");
        break;
      case "capability_mismatch":
        recovery.add("request_manager_capability_assignment");
        break;
      case "start_gate_unsatisfied":
        recovery.add("satisfy_plan_or_approval_gate");
        break;
      case "workspace_unavailable":
        recovery.add("register_or_repair_workspace");
        break;
      case "not_before":
      case "task_paused":
        recovery.add("wait_until_relevant_time");
        recovery.add("review_available_tasks");
        break;
      case "no_open_tasks":
        recovery.add("review_available_tasks");
        recovery.add("create_bounded_work_proposal");
        break;
      case "all_open_tasks_unready":
      case "policy_mismatch":
      case "not_open":
        recovery.add("review_available_tasks");
        break;
    }
  }
  const order: SchedulingRecoveryCode[] = [
    "manager_resume_project",
    "manager_repair_task_graph",
    "repair_or_replace_dependency",
    "wait_for_dependency",
    "request_manager_scope_resolution",
    "request_manager_role_assignment",
    "request_manager_capability_assignment",
    "satisfy_plan_or_approval_gate",
    "register_or_repair_workspace",
    "wait_until_relevant_time",
    "review_available_tasks",
    "create_bounded_work_proposal",
  ];
  return order.filter((code) => recovery.has(code));
}

function sortReasonCodes(reasons: SchedulingReasonCode[]): SchedulingReasonCode[] {
  const unique = new Set(reasons);
  return REASON_ORDER.filter((reason) => unique.has(reason));
}

function copyTask(task: NormalizedTask): SchedulingTask {
  return {
    ...task,
    scheduling: copyScheduling(task.scheduling),
  };
}

function copyScheduling(value: NormalizedTaskScheduling): NormalizedTaskScheduling {
  return {
    ...value,
    eligibleRoleIds: [...value.eligibleRoleIds],
    requiredCapabilities: [...value.requiredCapabilities],
    dependencies: value.dependencies.map((dependency) => ({ ...dependency })),
    scopes: value.scopes.map((scope) => ({ ...scope })),
    conflictOverrides: value.conflictOverrides.map((override) => ({ ...override })),
    ...(value.paused ? { paused: { ...value.paused } } : {}),
  };
}

function copyEvaluation(value: SchedulingReadyEvaluation): SchedulingReadyEvaluation {
  return {
    ...value,
    reasonCodes: [...value.reasonCodes],
    blockingTaskIds: [...value.blockingTaskIds],
    conflictingTaskIds: [...value.conflictingTaskIds],
    advisoryConflictTaskIds: [...value.advisoryConflictTaskIds],
    requiredRoleIds: [...value.requiredRoleIds],
    missingCapabilities: [...value.missingCapabilities],
    recovery: [...value.recovery],
  };
}

function validateIdentifierArray(value: unknown, field: string, maximum: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  if (value.length > maximum) throw new Error(`${field} exceeds limit of ${maximum}`);
  const seen = new Set<string>();
  return value.map((candidate, index) => {
    const identifier = validateIdentifier(candidate, `${field}[${index}]`);
    if (seen.has(identifier)) throw new Error(`${field} contains duplicate '${identifier}'`);
    seen.add(identifier);
    return identifier;
  }).sort();
}

function validateScopePath(value: unknown, field: string, kind: "file" | "directory"): string {
  const candidate = validateText(value, field, 1024).replaceAll("\\", "/").replace(/\/+$/, "");
  if (!candidate || candidate.startsWith("/") || /^[A-Za-z]:\//.test(candidate)) {
    throw new Error(`${field} must be a workspace-relative ${kind} path`);
  }
  const segments = candidate.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`${field} contains an unsafe path segment`);
  }
  if (/[*?\[\]{}]/.test(candidate)) throw new Error(`${field} must not contain glob metacharacters`);
  if (/[\u0000-\u001f\u007f]/.test(candidate)) throw new Error(`${field} contains control characters`);
  return candidate;
}

function pathContains(directory: string, candidate: string): boolean {
  return candidate === directory || candidate.startsWith(`${directory}/`);
}

function validateIdentifier(value: unknown, field: string): string {
  const text = validateText(value, field, 256);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(text) || text.includes("..")) {
    throw new Error(`${field} must be a stable identifier`);
  }
  return text;
}

function validateUntrustedDisplayText(value: unknown, field: string, maximumBytes: number): string {
  const text = validateText(value, field, maximumBytes);
  if (/[\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(text)) {
    throw new Error(`${field} contains unsupported control or bidirectional formatting characters`);
  }
  return text;
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

function validateTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${field} must be an ISO-8601 timestamp`);
  }
  return new Date(value).toISOString();
}

function normalizeNow(value: Date | string | undefined): string {
  if (value === undefined) return new Date().toISOString();
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error("now must be a valid Date");
    return value.toISOString();
  }
  return validateTimestamp(value, "now");
}

function validatePositiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${field} must be a positive integer`);
  return value as number;
}

function validateNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value as number;
}

function validateBoundedInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function validateBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

function validateEnum<T extends string>(value: unknown, values: readonly T[], field: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) throw new Error(`${field} is invalid`);
  return value as T;
}

function assertOnlyKeys(value: object, allowed: Set<string>, field: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${field} contains unsupported field '${key}'`);
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function earlierTimestamp(left: string | undefined, right: string | undefined): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return left < right ? left : right;
}
