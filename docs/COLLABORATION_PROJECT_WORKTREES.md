# Durable project identity and isolated Git worktrees

Status: research/design artifact; no runtime implementation claimed

## Decision

Introduce a server-generated durable `project_id` that is independent of every workspace path. A project owns shared coordination state and registers one or more execution workspaces. Each substantial implementation task may be assigned a managed Git worktree and branch, while the manager integrates commit-addressable artifacts in a dedicated integration workspace.

Do not derive project identity from:

- canonical workspace path;
- Git remote URL;
- branch name;
- repository display name;
- a value asserted by repository content or an agent prompt.

Those values are mutable, non-unique, or untrusted. Project creation/registration is an authenticated local-owner operation. PiLink generates the ID and stores the authoritative registry outside the repository.

## Why this is P0

The current code derives `projectKey = sha256(realpath(workspace))` independently in the task, chat, activity, audit, and collaboration-session stores. The harness and fixed run profiles also use one `RuntimeConfig.workspace` selected at server startup.

A linked Git worktree has a different canonical path from the main worktree. Under the current design it would therefore:

- receive a different task/chat/activity/session project key;
- be invisible to the manager’s shared task board;
- require a separate PiLink server/configuration to run tools there;
- lose reliable project-level conflict and integration state.

The result is a false choice between shared coordination and isolated execution. The new design must separate them.

Recent asynchronous software-engineering-agent research reports that centralized dependency-aware delegation, isolated workspaces, branch-and-merge, and executable integration are central to reliable parallel work. Communication protocols alone cannot prevent one agent’s uncommitted edits or tests from contaminating another agent in the same checkout.

## Identity layers

Keep these identifiers separate:

### `project_id`

Stable random server-generated ID for shared coordination, decisions, tasks, activity, roles, and memory. It survives workspace moves and the addition/removal of worktrees.

### `repository_id`

Optional internal record describing the Git repository currently attached to a project. It is not an authorization token. Recommended metadata:

- canonical Git common directory from `git rev-parse --path-format=absolute --git-common-dir`;
- object format;
- whether repository is bare;
- initial main-worktree path where present;
- optional sanitized remote names/URLs for diagnostics only;
- created/verified timestamps and revision.

A project may initially support exactly one repository. Multi-repository projects are a later extension.

### `workspace_id`

Stable random ID for one registered execution workspace. It maps to a canonical path and Git worktree metadata. Tools use the workspace selected by the server through session/task assignment; callers do not pass arbitrary filesystem roots.

### `collaboration_session_id`

Stable logical agent conversation/run identity bound to an OAuth actor. A session may be assigned one current workspace at a time for mutating work.

### `task_id`

Shared project task. A claimed implementation task records an assigned workspace, base commit, branch, owner session, and integration state.

## Registry model

Suggested project registry record:

```ts
interface ProjectRecord {
  schemaVersion: 1;
  projectId: string;
  displayName: string;
  status: "active" | "archived";
  repositoryId?: string;
  integrationWorkspaceId?: string;
  createdAt: string;
  createdBy: string; // local owner/admin identity
  revision: number;
}
```

Suggested repository record:

```ts
interface RepositoryRecord {
  repositoryId: string;
  projectId: string;
  gitCommonDir: string;
  objectFormat: string;
  bare: boolean;
  initialHead?: string;
  status: "active" | "moved" | "unavailable" | "detached";
  createdAt: string;
  lastVerifiedAt: string;
  revision: number;
}
```

Suggested workspace record:

```ts
interface ProjectWorkspace {
  workspaceId: string;
  projectId: string;
  repositoryId: string;
  kind: "main" | "managed_task" | "integration" | "registered_external";
  canonicalPath: string;
  gitDir: string;
  gitCommonDir: string;
  branchRef?: string;
  headCommit: string;
  baseCommit?: string;
  taskId?: string;
  ownerCollaborationSessionId?: string;
  status:
    | "creating"
    | "ready"
    | "assigned"
    | "integration_ready"
    | "integrated"
    | "cleanup_pending"
    | "quarantined"
    | "missing"
    | "removed";
  lockReason?: string;
  createdAt: string;
  lastVerifiedAt: string;
  revision: number;
}
```

The registry stores paths for local execution, but the stable relationship is by IDs. A path can move; the record is revised after explicit repair/re-registration.

## Project creation and migration

### New project

1. Local owner runs a project-create/register command from an existing workspace.
2. PiLink canonicalizes the workspace and verifies it is a Git working tree using fixed-argv Git commands.
3. PiLink obtains top-level path, Git directory, Git common directory, object format, current commit, and worktree list.
4. PiLink generates `project_id`, `repository_id`, and initial `workspace_id`.
5. Registry and empty project state are written atomically under the private data directory.
6. The server configuration stores or selects `PI_PROJECT_ID`; the workspace path remains only the initial execution workspace.

### Existing path-hash project

Migrate explicitly, never by silently generating a different ID on startup.

1. Acquire a global project-registry migration lock.
2. Resolve current canonical workspace and legacy path hash.
3. Verify the legacy project directory and embedded `projectKey` values.
4. Generate a new project ID and registry entry.
5. Move or copy state through an atomic staged migration; bump store schema to reference `projectId`.
6. Retain a read-only legacy-key alias for rollback/diagnostics.
7. Start the server only after all stores agree on the same project ID.

Do not let individual stores migrate independently. Partial migration would split tasks, chat, activity, audit, and sessions.

## Workspace registration rules

Registration is owner/admin-controlled and must:

- canonicalize the path with `realpath`;
- prove it is a Git worktree using Git commands rather than parsing `.git` manually;
- compare canonical `--git-common-dir` with the project repository record;
- parse `git worktree list --porcelain -z`, whose format is intended for scripts;
- reject a workspace already actively registered to a different project;
- reject symlink aliases that resolve to another registered path;
- record exact branch and commit IDs;
- reject ambiguous/mismatched repository state rather than auto-associating by remote URL;
- verify ownership/safety through the normal operating-system user and Git `safe.directory` behavior; never add broad `safe.directory=*` exceptions.

Remote URL is only diagnostic because forks, local clones, URL rewrites, and credential-bearing variants make it unsuitable as identity.

## Managed worktree root

Use an explicit `PI_WORKTREE_ROOT` outside the configured repository and outside resettable PiLink configuration/state directories.

Recommended default shape:

```text
<managed-root>/<project-id>/<workspace-id>/
```

Use opaque generated workspace IDs for filesystem names. Do not use task titles or unvalidated agent content as paths.

Important safety rule: the ordinary `pilink reset` operation must never recursively delete the managed-worktree root. Worktrees may contain valuable uncommitted changes. Cleanup is a separate project operation with dirty-state checks and explicit user visibility.

## Create flow

Only a manager/project-owner capability should create managed implementation workspaces in the MVP.

1. Read the current task and project revisions.
2. Require the integration workspace to be clean for the selected base.
3. Resolve the requested base ref to an immutable commit OID.
4. Generate a branch such as `pilink/<project-short>/<task-short>/<nonce>`; validate with `git check-ref-format --branch`.
5. Reserve `workspace_id`, path, branch, task, base OID, and owner session in registry state with status `creating`.
6. Execute fixed argv equivalent to:

   ```text
   git -c core.hooksPath=<disabled> worktree add --lock --reason <bounded reason> -b <generated branch> <generated path> <base oid>
   ```

7. Re-query `git worktree list --porcelain -z` and `git rev-parse` from the new path.
8. Verify path, common directory, branch, and base commit exactly match the reservation.
9. Mark workspace `ready`/`assigned` atomically and bind it to the task/session.
10. Emit a typed workspace-created/assigned activity event.

Never use `--force` or `-B` in normal creation. Git intentionally refuses branches already checked out or stale locked paths; bypassing those safeguards can hide corruption or ownership conflicts.

### Git execution caveat

`git worktree add` normally performs checkout and invokes `post-checkout`; repository configuration may also define filters. Git merge can invoke hooks and custom merge drivers. Therefore worktree creation and integration are not purely read-only filesystem operations.

PiLink should:

- disable hooks with an argv/config override where supported;
- use a minimal environment and no interactive prompts;
- treat repository-local filters/merge drivers as trusted-repository execution risk;
- require the same trusted-workspace/approval posture used for repository-code execution;
- never construct shell commands from branch/path/title strings.

The MVP should document that isolation prevents agents interfering with each other; it is not an OS sandbox against malicious repository code.

## Task and session assignment

A task claim for code work should bind:

- owner actor and collaboration session;
- project ID;
- workspace ID;
- immutable base commit;
- generated branch ref;
- integration target workspace/ref;
- declared path/component scope;
- task/plan revision.

A collaboration session supplies its handle; the server resolves the assigned workspace and builds a request-specific harness policy. The tool call does not accept an arbitrary workspace path.

Mutating tools require an active session/task/workspace binding. Read-only project coordination remains available even when the task workspace is missing or quarantined.

One session should have at most one active mutating workspace in the MVP. A session can release and switch explicitly after its current task reaches a safe boundary.

## Harness changes required later

The current harness is constructed from one startup `RuntimeConfig.workspace`. Multi-workspace operation requires:

1. project-level stores initialized by `project_id`, not workspace path;
2. request-level resolution of collaboration session and task assignment;
3. a server-selected workspace record;
4. a per-request `HarnessPolicy.workspace` built from the registered canonical path;
5. canonical path re-verification before each mutating call or at a bounded freshness interval;
6. tool audit records containing project ID, workspace ID, task ID, and collaboration session ID.

Do not add a general `workspace_path` argument to read/edit/write/run tools. That would turn the registry into advisory metadata and reopen arbitrary path selection.

In explicit unsafe-full-access mode, project/workspace attribution may still be recorded, but PiLink cannot claim that mutations are confined to the assigned worktree. The UI/audit should state that limitation.

## Worker completion flow

Before a task becomes `integration_ready`, require:

- branch HEAD differs from or intentionally equals the recorded base;
- worktree status is clean, unless the artifact is explicitly a patch/diff handoff;
- all intended changes are commit-addressable;
- focused verification evidence is attached to the task revision;
- commit OID is reachable from the recorded task branch;
- unresolved blockers and blocking reviews are zero;
- deviations from declared scope are accepted or corrected.

The worker does not merge directly into the integration branch by default. It hands off commit OID, branch, base OID, changed paths, verification, and known risks.

## Integration ownership and flow

Integration is initially a manager responsibility, optionally delegated through a specific integration task. It is not a mandatory fifth long-lived agent role.

1. Integration owner reads all upstream task revisions/artifacts.
2. Verify integration workspace is clean; Git warns that aborting a merge from a dirty state may not reconstruct the original state safely.
3. Verify worker commit and branch belong to a registered workspace/project.
4. Check whether recorded base is an ancestor of the current integration head.
5. If upstream moved, create an explicit rebase/update or integration-conflict task; do not silently rewrite worker history.
6. Merge/cherry-pick according to project policy in the integration workspace using fixed argv and disabled hooks where possible.
7. On conflict, preserve the merge state and create a durable conflict event/task. Do not choose `ours`/`theirs` automatically.
8. Run focused compatibility checks and the required integration/full suite.
9. Record the resulting integration commit OID and evidence.
10. Only then mark worker task/workspace `integrated` and eligible for cleanup.

Prefer true merges when preserving parallel history is useful; projects may explicitly choose squash/cherry-pick policy. The policy must be stored per project and visible before workers begin.

## Cleanup flow

Never clean managed workspaces with generic recursive deletion.

Normal cleanup:

1. Task is terminal and workspace is `integrated` or explicitly abandoned.
2. Verify Git worktree exists in `git worktree list --porcelain -z`.
3. Verify worktree status is clean and no merge/rebase/cherry-pick is in progress.
4. Verify worker commit is reachable from the accepted integration commit, or preserve it through an explicit archive ref.
5. Unlock the worktree.
6. Run normal `git worktree remove <path>` without `--force`.
7. Re-query Git worktree state.
8. Delete the task branch only after reachability and policy checks.
9. Mark registry record `removed`; retain metadata/activity for audit.

Dirty, missing, locked, or divergent workspaces become `quarantined`/`missing`. They require inspection or an explicit owner-approved recovery. `--force`, double-force, and direct directory deletion are not automatic recovery tools.

`git worktree prune --dry-run` may be used diagnostically. Automatic prune should not remove a worktree associated with an active/nonterminal task. PiLink should prefer `git worktree repair` when paths or administrative links have moved.

## Crash and reconciliation model

Every multi-step Git operation needs a reservation plus reconciliation; filesystem/Git and PiLink registry cannot be one transaction.

On startup and before workspace mutation:

1. load registry under lock;
2. query Git worktrees using porcelain output;
3. compare registry entries by canonical path, Git common directory, branch, and head;
4. detect half-created, missing, externally moved, or unexpectedly reassigned worktrees;
5. emit reconciliation events;
6. fail closed for mutation until ambiguous records are repaired.

Examples:

- Registry `creating`, Git worktree exists and matches: finish registration.
- Registry `creating`, path/branch absent: release reservation after confirming no partial path.
- Registry `assigned`, path missing but Git marks prunable: mark `missing`; do not prune while task is active.
- Path exists but common directory differs: quarantine as possible path replacement/attack.
- Branch/head changed outside PiLink: update only through an explicit manager reconciliation decision.
- Main repository moved: use owner-directed `git worktree repair`, then re-register canonical paths.

## Concurrency

Serialize project registry and Git-worktree mutations across processes with the hardened cross-process lock semantics already required for task/activity stores.

Also use optimistic revisions on project, workspace, task, and integration records. The lock prevents simultaneous local mutation; expected revisions prevent stale logical decisions after rereads.

Required races:

- two managers create a workspace for the same task;
- two tasks reserve the same branch/path;
- cleanup races with reassignment;
- integration races with base-branch advancement;
- server restart occurs between Git operation and registry update;
- same worktree is registered from two canonical aliases.

Exactly one operation may win; the loser rereads authoritative state.

## Security boundaries

### Authorization

- local owner/admin creates projects and registers repositories/workspaces;
- manager capability may create task worktrees within one approved repository/root;
- worker session may operate only in its assigned workspace;
- integration mutation requires explicit integration ownership;
- cleanup of dirty/quarantined workspaces requires owner approval.

A project ID, workspace ID, task ID, branch name, or path is not sufficient authorization.

### Path safety

- canonicalize existing paths and nearest existing ancestors;
- managed paths are generated under one configured root;
- reject traversal, symlink escapes, path replacement, and duplicate canonical registrations;
- recheck the canonical workspace and Git common directory before mutation;
- keep coordination data outside all registered workspaces;
- never place managed worktrees under a directory deleted by ordinary reset.

### Git safety

- use fixed argv, `--` delimiters where applicable, and generated names;
- validate refs with Git itself;
- do not use `--force`, `-B`, broad safe-directory overrides, automatic `ours/theirs`, or unchecked custom commands;
- disable hooks for managed operations where possible;
- document remaining repository-local filter/merge-driver execution risk;
- store only sanitized remote diagnostics and never credential-bearing URLs.

### Secrets and artifacts

Worktree records and activity contain paths, commits, branches, task/session IDs, and bounded evidence references. They must not store repository credentials, environment values, or raw command output.

## MVP constraints

For the first release:

- one Git repository per project;
- non-bare repository with one registered integration workspace;
- no automatic submodule initialization/update;
- no worktree move operation exposed to agents;
- one active mutating workspace per collaboration session;
- manager-created generated branches only;
- no automatic force cleanup;
- no remote fetch/push orchestration;
- no arbitrary branch supplied by an agent;
- project/worktree administration remains local-owner or strongly authorized manager functionality.

Repositories with active submodule complexity should be rejected or handled manually until cleanup, confinement, and nested-repository semantics are tested.

## Incremental implementation plan

### Phase P1 — project registry

- generate project/repository/workspace IDs;
- local create/register/list/status commands;
- schema and migration from path-hash stores;
- all shared stores accept project ID explicitly;
- path-hash alias retained for migration only.

Acceptance:

- moving the configured workspace does not create a new coordination project after explicit re-registration;
- two unrelated clones/remotes are never auto-merged into one project;
- every task/chat/activity/session/audit store resolves the same project ID.

### Phase P2 — worktree discovery and records

- fixed Git discovery helpers;
- `git worktree list --porcelain -z` parser;
- register main/integration workspace;
- read-only linked-worktree inventory and reconciliation states;
- no automated creation yet.

Acceptance:

- aliases/symlinks cannot create duplicate workspace identities;
- missing/moved/mismatched worktrees are detected safely.

### Phase P3 — managed creation and assignment

- configured managed root;
- generated branch/path reservation;
- owner/manager create and task/session assignment;
- request-level harness workspace selection;
- crash reconciliation and cross-process locking.

Acceptance:

- parallel tasks receive distinct worktrees but share tasks/activity;
- sibling sessions cannot mutate each other’s workspace through normal tools;
- crash at every create boundary is recoverable.

### Phase P4 — commit handoff and integration

- integration-ready evidence schema;
- commit/branch/base verification;
- integration owner/task;
- conflict state and full-suite gate;
- integration activity events.

Acceptance:

- no worker can declare integrated state directly;
- base drift/conflict is visible and recoverable;
- final integration commit is executable and traceable to worker artifacts.

### Phase P5 — safe cleanup

- normal unlock/remove/branch-delete workflow;
- reachability checks and archive refs;
- quarantine/missing recovery;
- owner-approved exceptional cleanup.

Acceptance:

- dirty or unmerged work is never deleted automatically;
- reset does not delete managed worktrees;
- stale administrative metadata is repaired or explicitly pruned only when safe.

## Required evaluation scenarios

1. Main workspace plus two linked task worktrees share one project/task/activity state.
2. Same repository at a different path is re-registered without forking project identity.
3. Different clone with same remote URL is rejected from automatic association.
4. Two processes race to create one task workspace.
5. Worktree creation crashes after Git succeeds but before registry commit.
6. Path is replaced by a symlink or different repository after registration.
7. Agent transport reconnects while session keeps the same assigned workspace.
8. Sibling session sharing one OAuth actor cannot mutate the other workspace.
9. Worker branch base becomes stale before integration.
10. Merge conflict creates an explicit integration task/state.
11. Worker has dirty/untracked files during cleanup.
12. Commit is not reachable from accepted integration branch.
13. Main repository/worktree is moved and repaired.
14. Ordinary PiLink reset leaves all managed worktrees intact.
15. Repository contains checkout hook/custom filter; managed operation follows documented execution-approval policy.
16. Active submodule repository is refused or explicitly routed to unsupported/manual mode.

## Primary sources

- Git worktree manual: linked worktrees, branch safeguards, locks, porcelain `-z`, remove/prune/repair, force semantics: https://git-scm.com/docs/git-worktree
- Git rev-parse manual: top-level, Git directory, Git common directory, canonical path output: https://git-scm.com/docs/git-rev-parse
- Git repository layout: per-worktree versus common administrative data: https://git-scm.com/docs/gitrepository-layout
- Git check-ref-format: authoritative branch/ref validation: https://git-scm.com/docs/git-check-ref-format
- Git hooks: `git worktree add` can invoke `post-checkout`; hooks execute programs from configured hook paths: https://git-scm.com/docs/githooks
- Git merge: dirty-worktree abort limitations, conflict lifecycle, hooks, and custom merge-driver configuration: https://git-scm.com/docs/git-merge
- Git config: `safe.directory` is protected configuration and should not be broadly bypassed: https://git-scm.com/docs/git-config
- Geng and Neubig, Effective Strategies for Asynchronous Software Engineering Agents (CAID): centralized delegation, isolated workspaces, branch-and-merge, executable integration: https://arxiv.org/abs/2603.21489
