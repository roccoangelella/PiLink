# Independent acceptance review: collaboration sessions, session-owned tasks, and activity

Review task: `f2ff7664-5924-4655-b293-e230842bc709`
Reviewer role: research/review, same project actor; not claimed as independent OAuth-actor review
Reviewed revisions:

- activity core: `82f016d`
- collaboration-session and session-owned-task core: `d544cd3`
- public MCP session/recovery-handle wiring: explicitly excluded; no `agent_session_*`, `collaboration_session_handle`, or `CollaborationSessionStore` references remain in committed `src/mcp.ts`

## Verification performed

- inspected exact commit scopes and diffs;
- `git diff <commit>^ <commit> --check` passed for both reviewed commits;
- independently ran `node --test test/activity.test.mjs`: 10/10 pass;
- independently ran `node --test test/collaboration-sessions.test.mjs test/tasks.test.mjs`: 21/21 pass;
- manager reported full shared suite 104/104 for the isolated session/task core;
- inspected storage, lock, validation, session rotation, task migration, ownership, pagination, idempotency, and focused tests.

## Verdict

| Surface | Verdict | Boundary |
|---|---|---|
| Typed activity backend core `82f016d` | **ACCEPT** | Ready for server-bound internal integration; task→event atomicity/outbox remains downstream work |
| Stable public session ID and persisted session metadata in `d544cd3` | **CONDITIONAL ACCEPT** | May remain as an internal experimental core with no public recovery-handle tools |
| Session-bound task-owner fields and sibling-session rejection | **CONDITIONAL ACCEPT / REPAIR REQUIRED** | Useful foundation, but two migration/liveness bugs below must be repaired before autonomous pull depends on it |
| Model-visible bearer recovery handle and current resume protocol | **REJECT FOR MCP EXPOSURE** | Do not wire to public MCP tools until credential, idempotency, redaction, and same-actor risks are resolved |
| `withActiveSession()` wrapping arbitrary task/store mutation | **REJECT FOR CROSS-STORE USE** | It does not provide atomic authorization+mutation and creates lock-order/partial-success hazards |
| Overall readiness for public MCP session wiring | **REQUEST CHANGES** | Keep public wiring removed; complete the blocking repairs and rereview exact commit |

## Accepted activity-core properties

The activity core resolves the earlier blocking review findings:

- trusted append context (`source`, actor, collaboration session, idempotency key) is separate from the untrusted event payload;
- `recordedAt` is server-authoritative;
- cursor/event order is durable and validated as contiguous;
- server-derived events require idempotency keys and synchronized processes deduplicate one semantic event;
- project-scoped opaque cursors reject mismatched projects;
- path and artifact references are bounded;
- artifact references allow only `pilink:`, `urn:`, or validated workspace-relative forms and reject credentials, query parameters, and fragments;
- cross-process mutation uses a PID-liveness-safe lock; old live, permission-ambiguous, and malformed owners fail safe;
- state/event growth has explicit caps and migration errors;
- file replacement and directory synchronization provide crash-safe old-or-new state;
- malformed and non-contiguous state fails closed and can be repaired.

### Activity residuals, non-blocking for the core

1. **Task plus activity is not atomic yet.** A downstream task transition can commit while its event fails, or vice versa, unless task integration uses a shared transaction or durable outbox/reconciliation record. This blocks atomic `finish-and-pull`, not the standalone activity store.
2. **The JSON backend rewrites the whole bounded state.** The API is backend-neutral and caps make this explicit, but performance must be measured before using the 100,000-event/64 MiB defaults as operational targets.
3. **Project identity remains path-derived.** Migrate all stores together to server-generated project IDs; do not change activity alone.
4. **MCP integration must preserve trusted context separation.** Model/tool input must never populate server actor/session/source fields.

## Blocking session/task findings

### S1 — High: public recovery handle remains a model-visible bearer capability

**Evidence**

- `CollaborationSessionCredential` returns `collaborationSessionHandle`.
- The handle is sufficient when paired with the same OAuth actor.
- The session store protects only against a different actor; another connection using the same OAuth client and a leaked handle can impersonate the logical session.
- Hash-at-rest does not prevent exposure through MCP tool results, client conversation/tool traces, screenshots, model output, or copied error context.
- Public MCP wiring has correctly been removed from `d544cd3`.

**Required action**

- keep scheduler/task APIs dependent on abstract verified session context, not a required model-visible handle argument;
- prefer a non-model-visible transport/server credential binding;
- if a recovery handle remains as fallback, label it sensitive, return it only through an explicitly accepted recovery surface, never list it, and document same-OAuth sibling residual risk;
- bind every verification to actor and project; possession alone never crosses actors/projects;
- add end-to-end tests proving no credential appears in MCP task/activity/chat/audit/errors/logs.

**Missing tests**

- same OAuth actor, different logical session, leaked handle;
- credential redaction from every public/error/audit surface;
- future transport-bound context with no model-visible credential argument.

### S2 — High: resume rotation is not retry-safe and can strand the session

**Evidence**

- `resume()` generates a new secret, persists its hash, invalidates the old handle, then returns the new handle.
- If persistence succeeds and the response is lost, the caller has only the now-invalid old handle and cannot recover the new one.
- Two concurrent resumes serialize; the first rotates, and the second fails with the old handle. There is no idempotency/generation protocol or documented winner recovery.
- Focused tests verify normal rotation but not response-loss or concurrent-resume recovery.

**Required action**

Choose and test an explicit protocol, for example:

- idempotency key plus bounded encrypted/one-time recovery response replay;
- two-phase generation where old credential remains valid only for a bounded confirmation window;
- a non-model-visible transport credential that can rebind without returning a bearer to the model;
- local/admin recovery that rotates and explicitly reassigns session-owned tasks.

The chosen design must guarantee that network response loss does not permanently strand the logical session.

**Missing tests**

- persisted rotation followed by simulated lost response;
- synchronized concurrent resumes with one defined winner and recoverable loser;
- retry with same idempotency key;
- old generation rejection after successful confirmation;
- no duplicate active transport/session lease if exclusivity is required.

### S3 — High: `withActiveSession()` creates cross-store lock-order and partial-success hazards

**Evidence**

`withActiveSession()`:

1. acquires the collaboration-session store lock;
2. validates the handle/session;
3. invokes an arbitrary asynchronous operation while the session lock is held;
4. only after that operation succeeds, rewrites session `lastSeenAt`/revision.

If the callback acquires the task-store lock, every caller now participates in a session→task lock order. A future path taking task→session can deadlock. More importantly, the task callback may commit, then session persistence may fail. The caller receives an error and may retry a task mutation that already succeeded.

The method comment says release/resume/revocation cannot interleave with the protected update, but it cannot make another store transaction atomic.

**Required action**

- do not use this wrapper for task/activity/project mutations;
- replace it with a short session verification/touch that returns a bounded `VerifiedSessionCredentialContext`, releases the session lock, then performs the task mutation using expected revisions/idempotency;
- or implement one actual transaction/outbox and documented global lock order across stores;
- throttle liveness touches so every task call does not require a session state rewrite.

**Missing tests**

- task callback commits, session persist fails;
- reversed lock acquisition between two processes;
- session revoked between verified-context issue and task mutation, with documented bounded semantics;
- idempotent retry after partial failure.

### S4 — High: a legacy actor-owned task can be silently narrowed by `claim()`

**Evidence**

- v1 tasks migrate with `ownerCollaborationSessionId === undefined`, correctly preserving actor-scoped ownership.
- `requireTaskOwner()` accepts the same actor when no owner session is stored.
- `claim()` on a non-open same-actor task then unconditionally sets `ownerCollaborationSessionId` to the caller session.
- The migration test exercises `renew()`, which preserves undefined, but not `claim()`.

A sibling session can therefore turn a legacy actor-owned task into its own session-owned task without an explicit migration decision.

**Required action**

- for an already owned legacy task, preserve undefined in ordinary claim/renew; or
- add an explicit `migrate_owner_to_session` operation requiring expected revision, actor match, reason, and manager/current-owner policy;
- expose `ownerScope: legacy_actor | session` or equivalent derived field so clients/autonomous pull cannot mistake unspecified session ownership for exact ownership.

**Missing tests**

- same-actor session calls `claim()` on legacy working task and ownership remains actor-scoped;
- explicit migration has one winner under concurrent sibling attempts;
- UI/response identifies legacy scope.

### S5 — High: creator provenance is conflated with live session authorization

**Evidence**

- new tasks store `createdByCollaborationSessionId`, useful provenance.
- `isTaskCreator()` requires both actor and the original creator session when that field exists.
- `provideInput()` and `cancel()` rely on `isTaskCreator()` or current owner.
- if the creator session is released, revoked, lost after resume-response failure, or deleted by retention, an ownerless `input_required` task can become impossible to resolve under the core store API.

The requirement was to distinguish active task ownership across sibling sessions. It did not require all creator authority to disappear with the original session.

**Required action**

- keep creator session as provenance;
- decide authorization separately: creator actor, authenticated manager/project role, current owner, or explicit admin recovery;
- ensure an ownerless input-required task always has a durable authorized recovery path;
- keep active owner mutations session-bound.

**Missing tests**

- creator session released/revoked, manager or creator actor resolves input;
- original creator session unavailable, authorized manager cancels/reassigns;
- unauthorized sibling cannot impersonate current owner.

### S6 — Medium, policy-blocking before exposure: credential hash lacks keyed/versioned domain separation

**Evidence**

- `hashSecret()` stores plain SHA-256 of a high-entropy random secret.
- verification is constant-time and the random secret makes ordinary dictionary attack impractical.
- however there is no server key, project/session domain separation, hash/MAC version, or rotation path.

**Required action**

- store a versioned keyed HMAC/KDF result using server-held key material;
- include protocol version, project ID, session ID, and credential generation in the MAC domain;
- support key-version migration/rotation;
- keep constant-time verification.

**Missing tests**

- same secret in different project/session yields different stored verifier;
- old/new key version migration;
- malformed/unknown verifier version fails closed.

### S7 — Medium: session record pruning can erase provenance referenced by durable tasks/activity/reviews

**Evidence**

- `makeRoomForSession()` deletes released/revoked/old-expired records when the session limit is reached.
- tasks and activity store public collaboration session IDs for ownership/provenance.
- deleting the session record removes label/actor/status/lifecycle metadata needed to explain historical independence, revocation, or ownership.

**Required action**

- keep a bounded tombstone/archive containing public provenance and terminal status while removing the credential verifier;
- or prove all durable references contain sufficient immutable metadata and define retention consistently;
- never delete a session record still required for a live task or unresolved review.

**Missing tests**

- pruning with historical task/activity references preserves explainable provenance;
- active/unresolved references are never removed;
- credential verifier is erased on archival where policy requires it.

### S8 — Medium: project-total quota and per-call touch behavior permit contention/resource abuse

**Evidence**

- only a project-wide `maxSessions` exists; one OAuth actor can consume the complete limit.
- `authenticate()` calls `withActiveSession()`, acquiring the global session-store lock, rewriting the full session state, and incrementing logical revision on every use.
- this makes session validation a serialized write path and conflates liveness touch with logical state revision.

**Required action**

- add per-actor active/resumable limits and start/resume rate limits;
- throttle `lastSeenAt` persistence to a configured interval or separate volatile/lease liveness from logical revision;
- measure contention under parallel tool calls;
- return bounded, non-sensitive quota errors.

**Missing tests**

- one actor cannot exhaust all project sessions;
- high-frequency validation does not rewrite/revise every call;
- parallel sessions remain responsive under the configured cap.

### S9 — Medium: session terminal transitions and owned tasks lack atomic reconciliation

**Evidence**

- release/revoke occurs in the session store only.
- session-owned task records are a separate store.
- no transaction/outbox clears/releases/flags tasks when a session is revoked or released.
- until lease expiry, tasks may remain owned by a session that can no longer mutate them.

**Required action**

- define durable policy for release/revoke/expiry:
  - immediate task release/reassignment through outbox/reconciliation; or
  - preserve ownership until lease expiry with explicit manager attention and reason;
- make retries idempotent;
- avoid cross-store nested locks.

**Missing tests**

- revoke/release with multiple owned/input-required tasks;
- crash between session terminal transition and task reconciliation;
- repeated reconciliation is exactly-once/idempotent.

### S10 — Medium/deferred: path-derived project identity prevents worktree-shared sessions

**Evidence**

- session, task, and activity stores still derive project key from canonical workspace path.
- linked worktrees have different canonical paths.

**Required action**

Migrate all stores together to server-generated project ID according to `architecture/project-workspaces.md`. This is not a reason to reject the isolated core, but public autonomous multi-workspace collaboration must not launch with path identity.

## Properties accepted in the session/task commit

Subject to the boundaries above, `d544cd3` correctly provides:

- random stable public collaboration session IDs;
- actor and path-project binding;
- bounded TTL/resume windows;
- active/expired/released/revoked states;
- atomic private state replacement;
- synchronized multi-process session creation;
- PID-liveness-safe stale-lock recovery with old-live/malformed fail-safe tests;
- no plaintext bearer persisted in the session file;
- constant-time verifier comparison;
- `requestedRoleId` explicitly treated as a request rather than assignment;
- task schema v1→v2 compatibility;
- session-bound active owner mutation checks;
- sibling sessions sharing one actor rejected for session-owned tasks;
- legacy actor-owned task loading/renewal compatibility;
- optimistic task revisions and cross-process task locking retained.

These are valuable backend foundations and should not be reverted merely because the public credential protocol is not yet acceptable.

## Required repair order

1. Remove/deprecate cross-store use of `withActiveSession()`; define verified context and lock/partial-failure semantics.
2. Repair legacy `claim()` narrowing and creator-session orphan behavior.
3. Design retry-safe resume/concurrent generation protocol and non-model-visible binding path.
4. Add keyed/versioned credential verifier and full redaction tests.
5. Add per-actor quota/touch throttling and session tombstone/reconciliation policy.
6. Rerun focused, two-process failure-injection, and full integration tests.
7. Re-review exact repair commit before any public MCP session tool or autonomous-pull integration consumes it.

## Final acceptance boundary

Allowed now:

- retain and build on activity core `82f016d`;
- retain stable public session IDs/session metadata internally;
- retain session-owned task fields and exact-session checks while repairing migration/liveness cases;
- use session IDs as public provenance in internal tests/data, never as authentication alone;
- develop scheduler core against abstract verified session context.

Not allowed yet:

- public `agent_session_start/resume/read/release` MCP tools returning/accepting the current bearer handle;
- requiring a model-visible recovery handle in every task/pull call;
- invoking task/activity mutations inside `withActiveSession()` and claiming atomicity;
- shipping autonomous pull as secure session-bound ownership before S3–S5 are repaired;
- claiming reviewer independence solely from transport or unverified session IDs;
- claiming worktree-shared project identity before project-ID migration.

**Final review verdict: REQUEST CHANGES / NOT READY FOR PUBLIC MCP WIRING.** Activity is accepted. Session/task core is retained as a useful internal foundation, but the blocking credential, cross-store, migration, and liveness repairs above require an exact-commit rereview.
