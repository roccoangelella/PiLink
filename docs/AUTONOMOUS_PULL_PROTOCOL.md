# PiLink autonomous ready-queue and atomic pull protocol

Status: backend-neutral scheduling specification; no runtime implementation claimed
Protocol version: `1.0.0`
Primary consumer: task `8a14e849-d01f-4d6c-945c-3b778b179458`

## Goal

Allow an authenticated collaboration session to atomically continue existing work or claim the highest-priority eligible task without asking the user for assignment.

The scheduler must be:

- deterministic under the same durable state and policy;
- atomic across concurrent PiLink processes;
- session-bound rather than actor-only;
- backward compatible with current tasks;
- explicit about why no task is ready;
- resistant to task/chat/prompt text impersonating scheduling metadata;
- recoverable after lease expiry, stale revisions, disconnects, and missed notifications;
- useful before strict role, review, workspace, and activity features are fully implemented.

This document specifies task-store and MCP semantics. Behavioral role instructions live in `COLLABORATION_ROLE_CONTRACTS.md` and are not repeated here.

## Design choice

Keep the existing task lifecycle:

```text
open -> working -> input_required -> working/open -> completed|failed|cancelled
```

Readiness is a derived scheduling predicate over an `open` task, not a new persisted task status. A task may be `open` but not ready because of dependencies, pause, capability mismatch, start gates, or conflicts.

Add optional structured scheduling metadata. Legacy tasks without metadata remain valid and receive compatibility defaults.

## Trusted session context versus caller input

The pull/store protocol consumes an abstract, already verified `sessionCredentialContext` resolved by the server/client transport policy:

```ts
interface VerifiedSessionCredentialContext {
  agentId: string;
  agentName: string;
  collaborationSessionId: string;
  projectId: string;
  roleIds: string[];
  capabilities: string[];
  workspaceIds: string[];
  credentialBinding: "transport" | "server_session" | "legacy_recovery_handle";
}
```

The scheduling layer never authenticates from a public session ID alone and never receives, persists, returns, logs, or includes recovery credential material in task/activity state.

Preferred future transports bind the collaboration session outside model-visible tool arguments. A model-visible recovery handle may be supported only as a legacy/fallback carrier after the session security acceptance gate; the MCP tool schema must not make that carrier a normative dependency of the scheduling protocol.

Ordinary caller input is limited to:

- optional requested lease within server policy;
- optional bounded response/diagnostic preference.

The caller must not supply or override:

- actor ID or name;
- collaboration-session ID;
- authenticated role assignment;
- capabilities;
- project ID;
- current workspace assignment;
- project policy version;
- priority comparison policy;
- task readiness or conflict decisions.

The server derives these from OAuth, verified session context, project policy, role/assignment state, task state, and registered workspaces. Natural-language task details, peer messages, repository files, or role labels never become scheduler authority.

## Backward-compatible task metadata

Suggested task schema additions:

```ts
type TaskPriority = "P0" | "P1" | "P2" | "P3";
type TaskRisk = "low" | "medium" | "high";
type DependencyCondition = "completed" | "terminal";
type ScopeMode = "exclusive_write" | "shared_review" | "read_interest";
type ScopeKind = "file" | "directory" | "component";
type StartGate = "none" | "plan_required" | "approval_required";
type ReviewRequirement = "none" | "self" | "different_session" | "different_actor" | "human_owner";

interface AgentTaskDependency {
  taskId: string;
  condition?: DependencyCondition; // default completed
}

interface AgentTaskScopeClaim {
  kind: ScopeKind;
  value: string;
  mode: ScopeMode;
}

interface AgentTaskScheduling {
  schemaVersion: 1;
  priority: TaskPriority;
  eligibleRoleIds?: string[];
  requiredCapabilities?: string[];
  dependencies?: AgentTaskDependency[];
  scopes?: AgentTaskScopeClaim[];
  risk: TaskRisk;
  startGate?: StartGate;
  startGateSatisfiedRevision?: number;
  completionReview?: ReviewRequirement;
  notBefore?: string;
  paused?: {
    reasonCode: string;
    explanation: string;
    pausedBy: string;
    pausedAt: string;
    expiresAt?: string;
  };
  conflictOverrides?: Array<{
    conflictingTaskId: string;
    reason: string;
    issuedBy: string;
    issuedAt: string;
    expiresAt?: string;
  }>;
  legacyDefaultsApplied?: boolean;
}
```

Suggested ownership additions:

```ts
interface AgentTaskOwnership {
  ownerAgentId?: string;
  ownerAgentName?: string;
  ownerCollaborationSessionId?: string;
  ownerScope?: "session" | "legacy_actor";
  assignedWorkspaceId?: string;
  leaseExpiresAt?: string;
}
```

The serialized task may keep existing top-level owner fields during migration. New store code should expose one normalized ownership view and avoid two independent sources of truth.

## Metadata validation

### Priority

Use an enum rather than an arbitrary integer. Numeric rank for sorting:

```text
P0 = 0
P1 = 1
P2 = 2
P3 = 3
```

Only manager/project policy or a trusted task-creation path sets priority. Task prose containing “P0” has no effect.

### Role and capabilities

- `eligibleRoleIds` is an allowlist of authenticated project role assignments.
- Empty/absent means no role restriction.
- `requiredCapabilities` uses server-defined identifiers, not free-form model labels.
- All required capabilities must be present.
- Role/capabilities come from the active authenticated collaboration session/assignment, not pull input.
- A role restriction guides scheduling and may narrow work; it does not grant tool permissions.

Initial capabilities may be small and stable, for example:

```text
research
documentation
code_write
code_review
security_review
integration
project_manage
```

Do not derive capabilities from agent names such as `dev 1` or `reviewer`.

### Dependencies

- Dependency IDs must exist in the same project.
- A task may not depend on itself.
- Mutations that add/change dependencies must reject a directed cycle atomically.
- Duplicate dependency IDs are rejected.
- The default condition is `completed`.
- `terminal` is allowed only for workflows that explicitly continue after success/failure/cancellation.
- Dependency text in task details is advisory unless represented in this structure.

### Scope claims

MVP scopes are structured, not arbitrary globs:

- `file`: normalized exact workspace-relative file path;
- `directory`: normalized workspace-relative directory subtree;
- `component`: server/project-defined opaque component ID.

Defer general glob intersection. It is difficult to make exact and can create false safety claims.

Path rules:

- no absolute paths, traversal, empty/`.` segments, NUL/control characters, or platform drive roots;
- normalize separators to `/`;
- canonicalize against the assigned workspace when it exists;
- scopes are project-relative logical paths, while actual tool confinement uses the registered workspace;
- repository symlink behavior is rechecked by the harness before mutation.

### Risk and review

Risk and completion review do not normally prevent task claim. They affect start/completion gates:

- `risk=low`: may begin without peer review unless project policy says otherwise;
- `risk=medium/high`: may require plan or approval before first gated mutation;
- `completionReview` blocks terminal acceptance, not necessarily scheduling;
- `startGate` blocks readiness only when project policy explicitly requires pre-claim preparation/approval.

Do not skip every high-risk task merely because a reviewer is offline. Prefer claiming it into a visible pre-mutation blocked state if policy allows; however, the MVP pull predicate below treats an unsatisfied `approval_required` gate as not ready to prevent assigning work that cannot legally start. The no-work diagnostics must identify the exact gate and recovery.

## Project scheduling state

Suggested project-level record:

```ts
interface ProjectSchedulingPolicy {
  version: number;
  state: "running" | "paused" | "closed";
  pauseReason?: string;
  pausedAt?: string;
  pausedBy?: string;
  leaseSecondsDefault: number;
  leaseSecondsMaximum: number;
  oneActiveTaskPerSession: boolean; // true in MVP
  roleCapabilityMap: Record<string, string[]>;
  starvationAttentionSeconds: number;
  optionalAging?: {
    enabled: boolean;
    intervalSeconds: number;
    maximumPriorityBoost: number;
  };
}
```

`closed` means no new work may be pulled. `paused` blocks new claims but does not prevent reads, status, release, safe checkpointing, or user/manager recovery operations. A manager may separately pause one task through task metadata.

## Ready predicate

A candidate task is ready for one authenticated collaboration session only when all conditions pass.

```ts
function evaluateReady(task, context, state, now): ReadyEvaluation {
  if (task.status !== "open") return skip("not_open");
  if (state.projectPolicy.state === "closed") return skip("project_closed");
  if (state.projectPolicy.state === "paused") return skip("project_paused");
  if (task.scheduling.paused && !isExpired(task.scheduling.paused.expiresAt, now)) {
    return skip("task_paused");
  }
  if (task.scheduling.notBefore && now < task.scheduling.notBefore) {
    return skip("not_before");
  }
  if (!roleMatches(task, context.roleAssignments)) return skip("role_mismatch");
  if (!capabilitiesMatch(task, context.capabilities)) return skip("capability_mismatch");

  const dependency = evaluateDependencies(task, state.tasks);
  if (!dependency.ready) return dependency;

  if (!startGateSatisfied(task, state)) return skip("start_gate_unsatisfied");

  const conflict = findBlockingScopeConflict(task, context, state.tasks, now);
  if (conflict) return skip("scope_conflict", conflict);

  if (!workspaceCanBeAssigned(task, context, state)) return skip("workspace_unavailable");
  return ready();
}
```

Readiness is evaluated from a fresh authoritative state inside the same cross-process lock used to claim.

## Dependency semantics

For each dependency:

### `condition=completed`

- dependency `completed`: satisfied;
- dependency `open`, `working`, `input_required`: unmet;
- dependency `failed`: blocked with `dependency_failed`;
- dependency `cancelled`: blocked with `dependency_cancelled`;
- missing dependency: corrupted state or invalid migration; fail closed with `dependency_missing`.

A failed/cancelled dependency does not silently make the task ready. Manager recovery options:

- repair/retry dependency through a new task and update dependency ID;
- remove dependency with explicit expected revision and reason;
- cancel/fail downstream task;
- use a separate `terminal` dependency where continuation after failure was intended.

### `condition=terminal`

- completed/failed/cancelled: satisfied;
- other statuses: unmet.

### Cycles

Reject cycles when tasks/dependencies are created or updated. On loading legacy/corrupt state containing a cycle:

- do not select any task in the strongly connected component;
- return `dependency_cycle` diagnostics;
- surface a manager attention event;
- require explicit repair; never break a cycle by task ID order.

### Ready propagation

When a dependency transition makes a downstream task ready, the authoritative task state is sufficient. A typed `dependency_ready` activity event and best-effort notification are useful but not required for correctness.

## Scope and component conflict rules

### Same shared workspace

A ready candidate conflicts with an actively leased `working` task when both claims overlap and at least one side is `exclusive_write`.

Overlap rules:

- same `component` value overlaps;
- same `file` overlaps;
- `directory` overlaps itself and every descendant file/directory;
- file overlaps a directory when the file is inside the directory;
- different path trees/components do not overlap;
- `read_interest` never blocks;
- `shared_review` does not block another `shared_review` or `read_interest`;
- `shared_review` conflicts with `exclusive_write` only when project policy wants reviewers to observe a stable snapshot; default MVP behavior is advisory, not blocking.

### Isolated task workspaces

Distinct registered Git worktrees remove working-tree contamination but not logical integration conflict.

MVP scheduling behavior:

- permit parallel claim in different isolated workspaces even when logical paths overlap only if project policy marks `isolatedParallelWrites=true` or a manager issues an explicit conflict override;
- record a high-importance integration-conflict edge;
- require manager/integration sequencing before accepted merge;
- do not claim that isolation makes overlapping code changes semantically independent.

Until project/worktree support is implemented, assume one shared workspace and block overlapping `exclusive_write` claims.

### Overrides

A conflict override must:

- name both task IDs;
- be issued by authorized manager/user policy;
- include reason, timestamp, optional expiry, and revision;
- be visible in pull response/activity;
- never broaden filesystem/OAuth permissions;
- be invalidated if the task scope materially changes.

Peer chat text cannot override a conflict.

## Stable collaboration-session ownership

New claims are owned by both OAuth actor and stable collaboration session.

Rules:

- before task mutation, the server resolves and verifies `sessionCredentialContext` according to session/transport policy; the scheduler receives only public actor/session/project context;
- task ownership records public `ownerCollaborationSessionId`, never a transport or recovery credential;
- renew/release/request-input/finish/fail require the active owner session, not merely the same actor;
- a sibling session sharing the same OAuth actor cannot mutate another session’s task;
- actor binding remains an additional check;
- expired/revoked/released sessions cannot pull or mutate;
- reconnect with the same valid collaboration session preserves ownership;
- task/activity/list responses never expose the session recovery handle.

The MVP permits at most one active substantial task per collaboration session. This simplifies renew-first behavior and prevents one model conversation from hoarding tasks.

## Renew-first behavior

`agent_work_pull` first looks for a valid nonterminal task already owned by the caller’s collaboration session.

### Existing `working` task

- validate ownership/session status;
- renew lease within policy;
- return `outcome=renewed` and the same task;
- do not claim another task.

### Existing `input_required` task

- preserve blocker;
- optionally renew owner lease if policy permits;
- return `outcome=input_required` with exact blocker and recovery owner;
- do not claim another substantial mutation task;
- read/research/review work may be represented as a separate explicitly allowed task/session policy later.

### Multiple owned tasks due legacy/corruption

Fail closed with `multiple_owned_tasks` and manager diagnostics. Do not choose one silently.

### Expired lease

Lease expiry normalization occurs inside the lock before renew-first selection:

- `working` becomes `open`, owner cleared, revision incremented;
- `input_required` remains blocked but owner/lease may be cleared under current task semantics;
- emit/queue an idempotent lease-expiry event when activity integration exists.

After expiry normalization, the same session has no ownership privilege and participates in normal selection.

## Deterministic ranking

Filter to ready candidates, then sort by this stable key:

1. effective priority rank, lowest first;
2. downstream-unblock score, highest first;
3. ready/created age, oldest first;
4. creation timestamp, oldest first;
5. task ID lexical order.

### Effective priority

Default MVP: `effectivePriority = basePriority`.

Optional deterministic aging may be enabled by project policy:

```ts
ageSteps = floor(readyAgeSeconds / intervalSeconds)
boost = min(ageSteps, maximumPriorityBoost)
effectiveRank = max(0, basePriorityRank - boost)
```

Requirements:

- policy/version is persisted;
- same state/time gives same result;
- boost never exceeds configured maximum;
- P0 remains P0;
- the response explains base/effective priority and aging.

If `readySince` is not yet stored reliably, do not enable cross-priority aging. Use created/updated time only for within-priority order and surface starvation attention instead.

### Downstream-unblock score

Count nonterminal tasks that directly depend on the candidate and would have no other unmet dependency after its successful completion. This is a tie-break only, not a reason to overtake a higher priority class unless aging policy does so.

To avoid expensive graph scans at scale, the store may maintain a validated reverse dependency index. The result must remain deterministic and rebuildable from tasks.

### Fairness controls

MVP fairness:

- one active task per collaboration session;
- oldest ready task wins within otherwise equal ranking;
- deterministic task ID tie-break;
- manager attention when a ready task exceeds `starvationAttentionSeconds`;
- diagnostics show tasks repeatedly skipped by role/capability/conflict;
- no hidden random selection.

Do not force a mismatched role/session to take old work merely for fairness. Manager should reclassify, reassign, or spawn/authorize an appropriate role.

## Atomic pull transaction

Conceptual trusted store API:

```ts
interface PullContext {
  agentId: string;
  agentName: string;
  collaborationSessionId: string;
  roleIds: string[];
  capabilities: string[];
  projectId: string;
  workspaceIds: string[];
  requestedLeaseSeconds?: number;
  diagnosticsLimit?: number;
}

type PullOutcome =
  | { outcome: "renewed"; task: AgentTask; selection: SelectionInfo }
  | { outcome: "claimed"; task: AgentTask; selection: SelectionInfo }
  | { outcome: "input_required"; task: AgentTask; recovery: RecoveryAction[] }
  | { outcome: "no_ready_work"; reasons: NoReadySummary; skipped: SkippedCandidate[] };
```

Pseudocode:

```ts
async function pullNext(context): Promise<PullOutcome> {
  validateTrustedContext(context);
  return withProjectCrossProcessLock(async () => {
    let state = await readFreshAuthoritativeState();
    state = expireLeasesAndTimedPauses(state, now());
    validateSessionStillActiveAndActorBound(context, state);

    const owned = findTasksOwnedBySession(state, context.collaborationSessionId);
    if (owned.length > 1) return noWork("multiple_owned_tasks", bounded(owned));
    if (owned.length === 1) {
      const task = owned[0];
      if (task.status === "working") {
        const renewed = renewTask(task, context, now());
        await persistAtomically(state.replace(renewed));
        return { outcome: "renewed", task: renewed, selection: renewInfo() };
      }
      if (task.status === "input_required") {
        const preserved = maybeRenewBlockedOwner(task, context, now());
        await persistIfChanged(state.replace(preserved));
        return inputRequired(preserved);
      }
      failCorruptOwnership(task);
    }

    if (state.projectPolicy.state !== "running") {
      return noWork(state.projectPolicy.state === "paused" ? "project_paused" : "project_closed");
    }

    const evaluations = state.tasks
      .filter(task => task.status === "open")
      .map(task => evaluateReady(task, context, state, now()));
    const readyTasks = evaluations.filter(e => e.ready).map(e => e.task);

    if (readyTasks.length === 0) return buildNoReadyResult(evaluations, state, context);

    const selected = stableSort(readyTasks, selectionKey(state, now()))[0];
    const claimed = claimForSession(selected, context, now());
    const nextState = state.replace(claimed);

    // When task/activity integration exists, task mutation and lifecycle event
    // must commit in one transaction or use an idempotent reconciliation record.
    await persistAtomically(nextState);
    return { outcome: "claimed", task: claimed, selection: explainSelection(selected, evaluations) };
  });
}
```

The cross-process lock must use the hardened live-PID stale-lock rule already accepted for the task store, or a transactional backend. Age alone never permits stealing a live lock.

## Simultaneous pulls

### Different sessions, one task

- both validate outside/inside as appropriate;
- first lock holder reads task open and claims it;
- second lock holder rereads fresh state, sees it working, and selects the next ready task or returns no work;
- exactly one session owns the task;
- no stale cached selection is written.

### Same session, simultaneous pulls

- first claims or renews task;
- second rereads and returns `renewed` for the same task;
- the session never receives two tasks.

### Two processes and dependency completion

All terminal transition and next-pull operations reread under lock. A task becoming ready must not require a notification to be selected.

## Finish-and-pull

Atomic finish-and-pull is the preferred terminal workflow only after task mutation and typed-activity delivery share a real transaction or durable outbox/reconciliation guarantee. Before that prerequisite exists, keep terminal mutation and subsequent pull as two explicit operations rather than claiming atomic lifecycle history while events can be lost.

Once task+activity atomicity/outbox semantics are implemented, add one atomic composition rather than relying only on prompt compliance.

Preferred mature API:

```ts
agent_task_finish({
  task_id,
  expected_revision,
  outcome,
  status_message?,
  artifact?,
  verification?,
  pull_next?: true
})
```

For authenticated session-owned calls, `pull_next=true` should be the recommended/default client behavior. A separate `agent_work_finish_and_pull` wrapper is also acceptable if backward compatibility makes modifying the existing tool undesirable.

Transaction semantics:

1. authenticate active owner collaboration session;
2. acquire project task lock/transaction;
3. fresh-read and validate expected revision/ownership;
4. validate terminal evidence/review policy;
5. transition current task terminal and release ownership;
6. evaluate dependencies and update ready projections;
7. run the same renew-first/selection algorithm for the now-unowned session;
8. persist terminal transition plus next claim atomically;
9. emit exactly-once lifecycle/activity events or a reconciliation journal;
10. return both completed task and `next_work` outcome.

If no next task exists, return structured diagnostics. Terminal completion still succeeds; no-work is not an error.

After the atomicity prerequisite is met, this prevents a race window where a worker reports completion and waits while ready work exists. Legacy clients—and all clients before the prerequisite—finish and call `agent_work_pull` separately; the system prompt still requires the immediate follow-up.

## Lease expiry and reclaim

- lease time is server-authoritative;
- pull/renew clamps requested duration to policy;
- lease is tied to task + owner session + revision;
- any task read/pull/mutation may normalize expired leases under lock;
- expired `working` task returns to `open` and may be claimed by any eligible session;
- old owner loses special rights after expiry;
- stale owner completion receives revision/ownership error and must reread;
- task status/history records that expiry occurred;
- best-effort notifications may tell manager/eligible agents, but pull correctness uses durable state.

A session expiration and task lease expiration are separate. If session expires before task lease, mutations fail until valid resume; policy may preserve the task lease during a bounded session resume window or release it explicitly. The choice must be deterministic and documented. Recommended MVP:

- session becomes expired: task remains owned until task lease ends;
- successful session resume with same public session ID restores access;
- session revoked/released: manager/release operation clears or reassigns owned tasks immediately;
- task lease end: normal reclaim regardless of session resume window.

## Manager pause, override, and reprioritization

Manager/user operations require expected revisions and durable reason fields.

### Project pause

- blocks new claims;
- does not invalidate current ownership automatically;
- manager may choose `allow_current_to_checkpoint` or `freeze_mutations` policy;
- pull returns `project_paused` with reason and recovery owner;
- no silent expiry resumes project; timed pause expiration is normalized under lock and recorded.

### Task pause

- open task becomes non-ready;
- working task pause policy must specify whether owner may checkpoint/release;
- pause includes reason, issuer, revision, optional expiry.

### Reprioritization

- updates structured priority only;
- does not preempt an active task automatically;
- affects next fresh pull;
- records manager/user decision.

### Dependency/conflict override

- explicit, bounded, revisioned, audited;
- names affected tasks/rule;
- cannot override OAuth, filesystem confinement, session ownership, user/system policy, or mandatory safety approval;
- task scope change invalidates conflict override unless explicitly renewed.

## Structured no-ready-work response

No-ready-work is a successful scheduling result, not a generic error.

Suggested response:

```ts
interface NoReadyWorkResult {
  outcome: "no_ready_work";
  primaryReason: NoReadyReasonCode;
  counts: Partial<Record<NoReadyReasonCode, number>>;
  skipped: Array<{
    taskId: string;
    title?: string;
    priority?: TaskPriority;
    reasonCodes: NoReadyReasonCode[];
    blockingTaskIds?: string[];
    conflictingTaskIds?: string[];
    requiredRoleIds?: string[];
    missingCapabilities?: string[];
    notBefore?: string;
    recovery?: RecoveryAction[];
  }>;
  nextRelevantAt?: string;
  recovery: RecoveryAction[];
  stateRevision: number;
}
```

Bound `skipped` to a server maximum such as 20. Counts include all authorized visible candidates. Do not leak titles/details or existence of tasks outside the caller’s project visibility.

### Reason codes

Session/project:

- `session_invalid`
- `session_expired`
- `session_released`
- `session_revoked`
- `project_paused`
- `project_closed`
- `multiple_owned_tasks`

Queue/lifecycle:

- `no_open_tasks`
- `all_open_tasks_unready`
- `task_paused`
- `not_before`
- `already_claimed`
- `input_required`

Dependency:

- `dependencies_unmet`
- `dependency_failed`
- `dependency_cancelled`
- `dependency_missing`
- `dependency_cycle`

Eligibility:

- `role_mismatch`
- `capability_mismatch`
- `authorization_denied`
- `workspace_unavailable`

Coordination/policy:

- `scope_conflict`
- `start_gate_unsatisfied`
- `manager_decision_required`
- `policy_mismatch`

Use stable machine codes plus bounded human explanation. Do not require agents to parse free-form messages.

### Primary reason selection

Choose deterministically:

1. session invalid/terminal;
2. project paused/closed;
3. owned input-required/multiple-owned corruption;
4. no open tasks;
5. dependency cycle/missing/failed/cancelled;
6. start gate/manager decision;
7. scope conflict;
8. role/capability/workspace mismatch;
9. dependency unmet/not-before/task pause;
10. generic `all_open_tasks_unready`.

The counts/skipped diagnostics preserve nuance.

### Recovery actions

Stable recovery codes may include:

- `resume_collaboration_session`
- `start_new_collaboration_session`
- `provide_task_input`
- `wait_for_dependency`
- `repair_or_replace_dependency`
- `request_manager_scope_resolution`
- `request_manager_role_assignment`
- `request_manager_capability_assignment`
- `satisfy_plan_or_approval_gate`
- `register_or_repair_workspace`
- `review_available_tasks`
- `create_bounded_work_proposal`
- `manager_resume_project`
- `manager_repair_task_graph`

Recovery instructions must never suggest bypassing confinement, stealing another session’s task, or asking the user for routine task assignment.

## Notification versus durable reads

Notifications are optimization only.

Notify eligible connected sessions when:

- a dependency completion makes a task ready;
- a task lease expires and returns to open;
- input is provided;
- a task/project pause expires or is lifted;
- a conflict is resolved;
- required review/manager decision becomes assigned;
- project priority changes materially.

Notification payload should carry only project/resource revision or task ID/attention kind, not sensitive task details when unnecessary.

On notification, the agent calls durable read/pull. Missed, duplicated, reordered, or delayed notifications do not change correctness. `agent_work_pull` always fresh-reads and is authoritative.

A no-work response may include `nextRelevantAt` for a known `notBefore`, pause expiry, or lease expiry. It is advisory; state may change sooner. PiLink cannot force a disconnected remote model to wake.

## Legacy task migration

Current tasks have no scheduling metadata and ownership is actor-scoped.

### In-memory compatibility defaults

For missing scheduling metadata:

```text
priority = P2
eligibleRoleIds = absent (any)
requiredCapabilities = absent
no dependencies
no scopes
risk = medium
startGate = none
completionReview = none
legacyDefaultsApplied = true
```

These defaults preserve existing claimability. They do not imply the task is truly low risk or conflict-free; UI/activity should mark metadata as legacy/unspecified.

### Open legacy tasks

- eligible for session-bound `agent_work_pull`;
- on claim, persist normalized scheduling metadata and `ownerScope=session`;
- manager may enrich priority/dependencies/scopes later with expected revision.

### Working/input-required legacy tasks

- retain `ownerScope=legacy_actor` until release/terminal transition or explicit migration;
- same-actor sibling-session ambiguity remains visible;
- do not silently bind to the first session that reads it;
- offer explicit owner migration requiring actor match, fresh expected revision, and manager/current-owner decision;
- input-required ownerless tasks remain blocked and are not pull candidates.

### Terminal legacy tasks

- remain readable and dependency-addressable;
- `completed` satisfies default dependency;
- failed/cancelled follow explicit dependency semantics;
- no scheduling rewrite is required until state migration/export.

### State schema migration

- load v1 and normalize to v2 in memory;
- persist v2 only under the hardened cross-process lock and atomic replacement;
- preserve all existing IDs/timestamps/revisions/status/artifacts;
- increment revision only for a real semantic migration policy, not merely read;
- migration must be idempotent and tested across multiple processes;
- do not migrate task, activity, session, and project IDs independently when project-ID migration lands.

## State transitions

```text
OPEN + ready + pull
  -> WORKING(session owner, lease, revision+1)

WORKING + same-session pull
  -> WORKING(renewed lease, revision+1 only when lease materially changes)

WORKING + lease expires
  -> OPEN(owner cleared, expiry message/event, revision+1)

WORKING + request input
  -> INPUT_REQUIRED(owner/lease preserved according to policy, revision+1)

INPUT_REQUIRED + input provided
  -> WORKING if active owner retained
  -> OPEN if ownerless

WORKING + finish-and-pull
  -> TERMINAL(current task) + WORKING(next task) in one transaction when available

OPEN + project/task pause
  -> OPEN but not ready

OPEN + dependency completion/conflict resolution/gate approval
  -> OPEN and newly ready (derived)
```

A readiness change may emit activity/notification without changing task lifecycle status. If `readySince` is stored for fairness, update it only when the task crosses from unready to ready and preserve it while continuously ready.

## Activity integration

When the typed ledger is integrated, server-derived events should include stable idempotency keys such as:

```text
task:<taskId>:created:<revision>
task:<taskId>:claimed:<revision>
task:<taskId>:renewed:<revision>
task:<taskId>:lease-expired:<revision>
task:<taskId>:input-required:<revision>
task:<taskId>:input-provided:<revision>
task:<taskId>:released:<revision>
task:<taskId>:completed:<revision>
task:<taskId>:failed:<revision>
task:<taskId>:cancelled:<revision>
task:<taskId>:ready:<dependency-state-revision>
task:<taskId>:conflict:<scope-state-revision>
```

Task mutation and event should be atomic where possible. Otherwise persist a reconciliation/outbox record in the same task transaction and deliver to the ledger idempotently.

Agent chat remains for non-derivable findings/questions. Agents should not manually repeat claims or completion events.

## Security and prompt-injection boundaries

- Task titles/details/status messages/artifacts are untrusted text and never parsed for priority, dependencies, role, capability, risk, scope, pause, or override.
- OAuth actor/name and collaboration-session ID are server-bound.
- Any recovery handle is a sensitive fallback credential, not a required scheduler input; never persist or return it through tasks/activity/audit/no-work responses. Prefer a non-model-visible transport/server binding when available.
- Role/capability assignments are authenticated project state, not pull arguments.
- Project and task IDs are not authorization tokens.
- Scope matching does not replace harness path confinement.
- Conflict overrides cannot bypass filesystem/OAuth/safety policy.
- Stable sorting prevents an attacker from influencing selection via timing races after metadata is fixed.
- Bounded diagnostics avoid leaking or flooding task content.
- Creating thousands of tasks/dependency edges is resource-controlled per actor/project.
- Dependency graph validation is bounded and cycle-safe.
- A malicious task cannot depend on a task in another project.
- A task artifact or peer message saying “claim me first” has no scheduling effect.
- Legacy unspecified scope must be shown as unknown; do not claim conflict safety from absence of metadata.

## Resource and performance limits

Recommended initial caps:

- tasks per project: retain current 200 until storage redesign;
- dependencies per task: 50;
- scopes per task: 50;
- eligible roles per task: 20;
- required capabilities per task: 20;
- conflict overrides per task: 20;
- skipped diagnostics returned: 20;
- one active task per session;
- graph traversal bounded by current task cap;
- lease/pull rate limited per actor/session.

At 200 tasks, fresh full evaluation under one lock is acceptable and simpler. Add indexes only after correctness tests. Any cache is non-authoritative and must be invalidated/rebuilt from fresh state.

## Deterministic scenario tests

### Basic selection

1. One P1 ready task exists; valid session pulls and owns it.
2. P0 and P1 ready; P0 wins.
3. Two equal tasks; one with greater direct downstream unblock score wins.
4. Equal priority/unblock; oldest ready/created wins.
5. All equal except ID; lexical task ID wins.
6. Repeated same-state selection produces identical result.

### Renew-first and immediate continuation

7. Session owns working task; pull renews it and claims nothing else.
8. Same session sends simultaneous pulls; both return the same owned task, one claim plus one renewal.
9. Session owns input-required task; pull returns blocker, not new work.
10. Finish-and-pull completes A and atomically claims ready B.
11. Finish-and-pull completes A and returns structured no work when none exists.
12. Dependency completion within finish-and-pull makes downstream B immediately selectable.

### Concurrent sessions/processes

13. Two sessions pull one task simultaneously; exactly one owns it.
14. Two sessions pull two tasks simultaneously; each receives at most one task with deterministic fresh-state selection.
15. Two PiLink processes race after stale cached reads; lock/fresh read prevents overwrite.
16. Live old store lock is never stolen; dead old lock is recoverable.
17. Same OAuth actor, different sessions; sibling cannot renew/release/finish other task.
18. Transport reconnect with same collaboration session preserves ownership.

### Dependencies

19. Open dependency blocks downstream with `dependencies_unmet`.
20. Input-required dependency blocks downstream and identifies exact dependency.
21. Completed dependency satisfies default condition.
22. Failed dependency produces `dependency_failed`, not readiness.
23. Cancelled dependency produces `dependency_cancelled`.
24. `terminal` dependency is satisfied by failed/cancelled.
25. Missing dependency fails closed.
26. Self-dependency mutation rejected.
27. Multi-task cycle mutation rejected atomically.
28. Persisted cycle is quarantined and surfaces manager repair, never auto-broken.
29. Cross-project dependency rejected.

### Role/capability/risk

30. Eligible role matches authenticated assignment; task may be selected.
31. Caller writes role name in pull input/task text without assignment; no effect.
32. Missing one required capability produces `capability_mismatch`.
33. Capability exists but OAuth lacks needed write scope; authorization still fails at tool layer.
34. Unsatisfied approval-required start gate prevents readiness and returns recovery.
35. Completion review requirement does not block claim when start gate is none.

### Conflicts/workspaces

36. Same file exclusive-write claim blocks second task in shared workspace.
37. Directory claim blocks descendant file claim.
38. Disjoint directories do not conflict.
39. Same component exclusive-write conflicts even with different paths.
40. Read-interest never blocks.
41. Textual mention of same file without structured scope does not create authoritative conflict metadata.
42. Explicit valid override permits claim and is visible.
43. Expired override no longer permits claim.
44. Scope revision invalidates old override.
45. Isolated worktree policy permits parallel overlap but creates integration-conflict edge.
46. Missing/quarantined assigned workspace produces `workspace_unavailable`.

### Leases/session lifecycle

47. Working lease expires; task returns open and another session claims it.
48. Old owner attempts completion after reclaim; revision/ownership rejects it.
49. Collaboration session expires but task lease remains; mutation requires session resume.
50. Session resumes with same public ID and continues before task lease expiry.
51. Session revoked/released; owned task is cleared/reassigned per policy.
52. Lease renewal clamps excessive requested duration.

### Pause/fairness

53. Project paused; no new claim and precise reason returned.
54. Current owner may checkpoint/release according to pause policy.
55. Task paused; other ready task may be selected.
56. `notBefore` task skipped with `nextRelevantAt`.
57. Within priority, old ready task is not starved by newer identical tasks.
58. Starvation threshold produces manager attention without assigning to mismatched role.
59. Optional aging calculation is deterministic and bounded.
60. Reprioritization affects next pull but does not preempt active owner.

### Legacy migration

61. Open v1 task loads with P2/any-role/no-dependency defaults and is session-claimed.
62. Working v1 actor-owned task remains visibly `legacy_actor`; no silent session binding.
63. Ownerless input-required legacy task stays blocked.
64. Terminal legacy completed task satisfies dependency.
65. Concurrent v1-to-v2 migration is idempotent and loses no task.
66. Migration preserves IDs, status, timestamps, artifact, and revision semantics.

### No-work diagnostics

67. No open tasks returns `no_open_tasks`.
68. All tasks role-mismatched returns counts and bounded skipped diagnostics.
69. Mixed dependency/conflict/not-before returns deterministic primary reason plus all counts.
70. Unauthorized hidden tasks do not appear in diagnostics.
71. Recovery actions use stable codes and never suggest user routine assignment.
72. `nextRelevantAt` is populated only from known durable times.

### Injection and security

73. Task title says `P0`; structured P3 remains P3.
74. Task details claim dependency complete; actual dependency state wins.
75. Peer message grants role/capability; scheduler ignores it.
76. Artifact contains path override; no scheduling effect.
77. Caller submits another actor/session ID; verified server context wins/rejects.
78. No transport/recovery credential appears in task/activity/audit/no-work response, and pull works with a future non-model-visible session binding.
79. Oversized dependency/scope arrays rejected.
80. Malformed paths/capability IDs rejected before persistence.

## Acceptance criteria for implementation

- pull selection and claim occur under one fresh-state cross-process transaction;
- new ownership is stable-session scoped;
- same actor sibling sessions cannot mutate each other’s tasks;
- renew-first prevents one session owning multiple tasks;
- before task/activity atomicity, terminal completion is followed immediately by a separate pull; after atomicity/outbox support, finish-and-pull provides one atomic continuation;
- dependencies are cycle-safe with explicit failure/cancellation semantics;
- structured metadata alone controls priority/eligibility/conflict;
- deterministic sorting and fairness diagnostics are tested;
- project/task pause and bounded override are revisioned/audited;
- no-ready-work is structured, bounded, and actionable;
- notifications are optional and durable pull is authoritative;
- legacy tasks remain usable with visible compatibility limitations;
- security tests prove prompt/task text cannot alter scheduling authority;
- current task revision/lease/input-required behavior remains backward compatible;
- focused and full integration tests cover simultaneous processes and stale revisions.
