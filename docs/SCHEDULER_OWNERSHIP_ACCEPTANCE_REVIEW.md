# Acceptance review: task authority and autonomous scheduler cores

Review task: `b5289930-137e-424e-af58-b33d8aab5ace`
Reviewed commits:

- task authority scopes: `3847741`
- pure autonomous scheduler: `9883ca1`

Reviewer independence: same project OAuth actor, separate reviewer task/session context; not claimed as different-actor review.

## Verification

- `3847741` exact scope: `src/tasks.ts`, `test/tasks.test.mjs`.
- `9883ca1` exact scope: `src/scheduling.ts`, `test/scheduling.test.mjs`.
- both commit diff checks are clean.
- independent task suite: 14/14 pass.
- independent scheduler suite: 18/18 pass.
- moving combined scheduler/task suite previously passed 29/29.
- manager reported full shared suite 120/120 for task-authority commit and 123/123 for scheduler commit.
- exact runtime probes were added outside the repository to test review cases omitted by the committed scheduler suite.

## Verdict matrix

| Surface | Verdict | Notes |
|---|---|---|
| Task authority repair `3847741` | **ACCEPT** | Correct v1/v2→v3 migration and actor/session authority separation |
| Scheduler dependency graph, deterministic ordering, role/capability/gate checks | **ACCEPT** | Pure, bounded, deterministic, and injection-resistant for structured scheduling fields |
| Scheduler owner-scope and active input-required conflict handling | **ACCEPT** | Explicit `ownerScope`; actor- and session-scoped active leases reserve scope |
| Scheduler aging | **ACCEPT** | Cross-priority boost requires authoritative `readySince` |
| Scheduler workspace eligibility | **REQUEST CHANGES** | Unassigned workspace-free tasks are incorrectly impossible |
| Isolated-worktree overlapping writes | **REQUEST CHANGES** | Selection erases integration-conflict evidence |
| Conflict override validity | **REQUEST CHANGES** | Unversioned and future-issued overrides can authorize work |
| User-visible skipped-title safety | **REQUEST CHANGES** | Newline/tab/CR and Unicode bidi formatting controls remain accepted |
| Readiness for task-store/MCP autonomous pull integration | **CONDITIONAL / BLOCKED ON REPAIR** | Core may be developed against, but affected semantics must not be exposed as final before task `88b186d3` is fixed and rereviewed |

## Accepted task-authority properties

Commit `3847741` correctly:

- separates creator provenance from authorization;
- stores `createdByCollaborationSessionId` for provenance but fixes `createdByScope` to actor authority;
- lets a replacement session for the same actor provide creator input or cancel under existing creator policy;
- binds active session-owned task mutation to the exact collaboration session;
- preserves actor-scoped legacy ownership during ordinary `claim`/renew instead of silently narrowing it to one sibling session;
- migrates version 1 actor-owned tasks to explicit actor scope;
- migrates version 2 owner session IDs to explicit collaboration-session scope;
- requires scope fields in version 3 state;
- rejects inconsistent owner actor/session/scope/lease shapes;
- clears owner session/scope during release, terminal transition, and lease expiry;
- preserves optimistic revisions and cross-process task locking.

Integration requirements:

- task/MCP projections should expose public authority-scope labels where useful;
- scope labels and session IDs are provenance/authorization context, never credentials;
- task-store scheduling integration must consume `ownerScope` explicitly rather than infer authority from presence of a session ID;
- session release/revoke reconciliation remains a separate cross-store task.

## Accepted scheduler properties

Commit `9883ca1` correctly provides:

- pure, integration-neutral scheduling functions;
- strict structured context that rejects injected credential fields;
- legacy scheduling defaults clearly marked as defaults;
- bounded tasks, dependencies, scopes, roles, capabilities, workspaces, diagnostics, and overrides;
- same-project validation;
- Tarjan strongly connected component cycle detection;
- explicit completed versus terminal dependency semantics;
- deterministic failure reasons for missing, failed, cancelled, unmet, and cyclic dependencies;
- authenticated role/capability matching from trusted context;
- revision-bound start-gate evaluation;
- project/task pause and not-before handling;
- exact file, directory, and component scope overlap without general globs;
- read-interest and shared-review modes;
- explicit actor versus collaboration-session owner scope validation;
- active unexpired `working` and owned `input_required` tasks reserving scopes;
- deterministic ranking by effective priority, direct downstream unblock score, readiness age, creation time, and task ID;
- no cross-priority aging when `readySince` is absent;
- bounded deterministic no-ready diagnostics and stable recovery codes;
- defensive copies and rejection of scheduling authority hidden in task prose.

## Blocking scheduler defects

### 1. High: workspace-free project work cannot be scheduled

Current behavior adds `workspace_unavailable` when `context.workspaceIds` is empty even if the task has no assigned workspace and no explicit workspace requirement.

Confirmed runtime result:

```json
{"case":"workspace-free research","outcome":"no_ready_work","primaryReason":"workspace_unavailable","counts":{"workspace_unavailable":1}}
```

This prevents a valid collaboration session from pulling:

- research;
- design review;
- task triage;
- memory review;
- user-decision preparation;
- other coordination tasks that need project state but no execution checkout.

Required repair:

- add explicit workspace requirement semantics, or require a workspace only when `assignedWorkspaceId`/structured task policy demands one;
- unassigned workspace-free tasks must remain eligible;
- assigned/code tasks must still fail when the required workspace is unavailable;
- do not infer requirement from task title/details.

### 2. High: isolated parallel writes lose integration-conflict evidence

When two exclusive-write tasks overlap but use distinct workspaces and `isolatedParallelWrites=true`, the scheduler immediately treats the pair as non-conflicting and returns an empty `conflictingTaskIds` array.

Confirmed runtime result:

```json
{"case":"isolated overlapping writes","outcome":"selected","evaluation":{"taskId":"candidate","ready":true,"reasonCodes":[],"blockingTaskIds":[],"conflictingTaskIds":[],"requiredRoleIds":[],"missingCapabilities":[],"recovery":[]}}
```

Worktree isolation prevents working-directory contamination, not semantic merge conflict. Losing this edge prevents the manager/activity/standup projection from scheduling integration review.

Required repair:

- distinguish blocking conflicts from advisory/integration conflicts;
- permit selection under isolated parallel policy while returning sorted `integrationConflictTaskIds` or equivalent;
- carry that field through selection/diagnostics and future activity integration;
- task-store integration emits an attention/integration-conflict edge rather than pretending scopes are disjoint.

### 3. High: conflict overrides are not necessarily revision- or time-bound

`scopeRevision` and `conflictingScopeRevision` are optional, and `hasValidConflictOverride()` does not require `issuedAt <= now`. An override with no revision fields and a future issue time authorizes current selection.

Confirmed runtime result:

```json
{"case":"future unversioned override","outcome":"selected"}
```

This violates the stated invariant that material scope change invalidates an override.

Required repair:

- require both candidate and conflicting scope revisions;
- exact-match both current scope revisions;
- reject self-overrides;
- validate `issuedAt <= expiresAt` when expiry exists;
- treat future-issued overrides as inactive;
- task-store integration must accept override issuer/reason only from authenticated manager/user policy, not arbitrary task input;
- add missing, stale, future, self, expired, and valid tests.

### 4. Medium/security: diagnostic titles permit formatting/bidi injection

`validateUntrustedDisplayText()` rejects many controls but still permits tab, line feed, carriage return, and Unicode bidirectional override/isolate characters. Skipped task titles are returned in no-ready diagnostics and may be rendered in a terminal, dashboard, or model context.

Required repair:

- reject all C0/DEL controls for single-line fields, including tab/LF/CR;
- reject or escape Unicode bidi formatting controls used to reorder visible text;
- keep details multiline only if they are not included in bounded scheduling diagnostics, or apply a safe renderer;
- add title injection tests.

## Non-blocking integration observations

1. `completionReview` and `risk` are intentionally metadata for task-store completion/start policy; pure selection need not enforce them directly.
2. `readySince` must be reset whenever readiness is lost; task-store integration owns this transition and must test it.
3. Conflict override issuer authorization cannot be proven by the pure scheduler; the task store/MCP mutation must bind it to authenticated manager/user policy.
4. `nextRelevantAt` may later include blocking lease expiry, but its absence is not a blocker for the pure core.
5. Project `closed` may deserve a distinct non-resume recovery code; current manager-resume behavior should be reviewed when project policy is implemented.
6. Exact scope matching does not replace workspace path/symlink confinement.

## Repair task

Created P0 task `88b186d3-d59f-431c-9673-6a1ba1b36311` with isolated scope:

- `src/scheduling.ts`;
- `test/scheduling.test.mjs`.

The active task-store integration may continue developing unrelated transaction/ownership plumbing, but must not expose or declare final these affected scheduler semantics until the repair commit is reviewed.

## Final verdict

**Task-authority commit `3847741`: ACCEPT.**

**Scheduler commit `9883ca1`: superseded by repair commit `5aee091`.** The original dependency, ranking, ownership, and bounded-diagnostic foundation remains sound.

## Repair rereview: commit `5aee091`

Exact verification performed:

- commit scope is only `src/scheduling.ts` and `test/scheduling.test.mjs`;
- diff check passed;
- TypeScript build passed;
- independent focused scheduler suite passed 20/20;
- manager/implementer reported full shared suite 130/130;
- the original four runtime probes were rerun against the committed build.

### Original blockers resolved

1. **Workspace-free tasks:** an explicit `workspaceRequirement="none"` research task is selected with no execution workspace, while `workspaceRequirement="authorized"` still returns `workspace_unavailable`.
2. **Isolated overlap visibility:** overlapping exclusive writes in distinct isolated workspaces may be selected but return the active task in `advisoryConflictTaskIds`.
3. **Override validity:** both scope revisions are mandatory; incomplete overrides fail validation; future-issued overrides remain inactive and produce `scope_conflict`; self/invalid-time cases are tested.
4. **Diagnostic-title safety:** task titles containing newline/control/bidirectional formatting are rejected.

Exact probe summary:

```text
workspace-free research: selected
workspace-required without workspace: no_ready_work/workspace_unavailable
isolated overlapping writes: selected, advisoryConflictTaskIds=[active]
future override: no_ready_work/scope_conflict
missing override revisions: rejected
newline title: rejected
```

### New compatibility blocker introduced by `5aee091`

The single-line title validator was also applied to `tasks[].details`. PiLink task details are allowed to be multiline and may contain structured briefs. Exact committed-build probe:

```text
details = "line one\nline two"
result = tasks[0].details contains unsupported control or bidirectional formatting characters
```

This causes the whole scheduler snapshot to fail before readiness evaluation, even though details are not scheduling authority.

Required bounded repair, tracked as task `e610f884-dfe1-454f-8a34-984a4d8df53a`:

- split title and details validation;
- keep title single-line and control/bidi-safe;
- preserve normal multiline/tab details while rejecting unsafe controls such as NUL/ESC/DEL and bidi formatting, or omit details from the scheduling projection if compatible;
- add multiline-details success plus unsafe-control/bidi failure tests;
- touch only scheduler source/tests.

### Current scheduler verdict

**`5aee091`: superseded by bounded compatibility follow-up `3ed27a6`.**

## Final compatibility rereview: commit `3ed27a6`

Exact verification performed:

- commit scope is only `src/scheduling.ts` and `test/scheduling.test.mjs`;
- diff check passed;
- TypeScript build passed in a clean detached worktree;
- independent focused scheduler suite passed 21/21;
- the safe multiline-details and unsafe-control cases were rerun against the exact commit.

The follow-up splits display validation by surface:

- task titles remain single-line and reject every C0/DEL control plus Unicode bidi formatting controls;
- task details preserve ordinary tab, LF, and CR content used by structured task briefs;
- details still reject NUL, ESC, DEL, C1 controls, and bidi formatting;
- details remain untrusted display data and never become scheduling authority.

No regression was found in workspace requirements, advisory isolated-worktree conflicts, conflict-override revision/time binding, deterministic ranking, ownership-scope validation, or bounded diagnostics.

### Final scheduler verdict

**ACCEPT the scheduler chain `9883ca1` + `5aee091` + `3ed27a6` as the backend-neutral autonomous scheduling core.** It is ready for store-level integration under these unchanged boundaries:

- authenticated roles, capabilities, workspace assignments, project policy, and conflict-override issuer authority must be supplied by trusted server context;
- `readySince` lifecycle maintenance belongs to the task store;
- advisory conflict IDs must be preserved into activity/attention and integration planning;
- exact scope matching does not replace filesystem/worktree confinement;
- no model-visible credential or natural-language task content grants authorization.
