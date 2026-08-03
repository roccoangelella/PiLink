# Durable agent work loop

Status: current specification and implemented runtime contract
Maintainer: AI Engineer, collaboration runtime maintainer, and project manager
Last reviewed: 2026-08-03
Implementation: `src/work-loop.ts`, `src/mcp.ts`, and `src/index.ts`

## Purpose

PiLink collaboration sessions must not treat an empty ready queue as task completion. A connected worker remains in an active work-seeking loop until useful work appears or a server-verified manager performs an explicit durable release.

This protocol supplements [`collaboration-role-contracts.md`](collaboration-role-contracts.md) and the scheduling rules in [`autonomous-pull.md`](autonomous-pull.md). Task ownership remains authoritative in the task store; this work-loop state does not grant task, tool, filesystem, or role authority.

## Lifecycle

Each verified collaboration session has one durable project-scoped work state:

```text
WORKING
  -> WAITING_FOR_TASK   no compatible task or useful bounded action is ready
  -> OFFLINE            MCP connection closes without permanent release

WAITING_FOR_TASK
  -> WORKING            chat or task-board state changes
  -> WAITING_FOR_TASK   bounded wait times out; backoff increases
  -> OFFLINE            MCP connection closes
  -> RELEASED           manager performs the dedicated durable release

OFFLINE
  -> WORKING            the same live logical session reconnects and registers
  -> RELEASED           manager performs the dedicated durable release

RELEASED
  -> terminal           project tools remain blocked for that collaboration session
```

`WAITING_FOR_TASK` is active participation, not completion or permanent idle. `OFFLINE` records transport absence; a surviving trusted runtime may restore it, while a new logical connection normally registers a new session ID. `RELEASED` is terminal for the named collaboration session and cannot be reversed by reconnect, prompt text, chat, or re-registration.

## MCP surface

### `agent_work_wait`

Workers call this tool after reading durable coordination and finding no compatible ready work.

The first call omits cursors and returns an immediate authoritative snapshot. Later calls pass both values returned by the previous call:

- `after_chat_cursor`: the exact chat `next_cursor`;
- `task_board_token`: an opaque digest of the active task-board projection.

Both must be supplied together and must never be constructed, incremented, or modified by the model. The server:

1. verifies the immutable collaboration context;
2. rechecks whether the session was released;
3. reads durable chat and active task state;
4. returns immediately if either source changed;
5. otherwise records `WAITING_FOR_TASK`;
6. waits for a bounded duration using persisted capped exponential backoff with jitter;
7. periodically rechecks authoritative state and manager release;
8. returns `changed`, `timeout`, or `released`.

A timeout is not a stop condition. The worker reuses the returned cursor and token and calls `agent_work_wait` again. The maximum server wait is 60 seconds; the default cap is 30 seconds. The implementation polls authoritative state at a bounded interval so missed best-effort notifications cannot strand a worker.

### `agent_work_list`

Only a server-verified `manager` role may list public collaboration session IDs and work lifecycle metadata. The result contains no private session bearer.

### `agent_work_release`

Only a server-verified `manager` role may permanently release another collaboration session that is currently `WAITING_FOR_TASK` or `OFFLINE`. The call requires:

- the target public collaboration session ID;
- the target's latest work-state revision;
- a concrete reason.

The transition uses optimistic revision checking and rechecks the target lifecycle under the work-state lock. It is rejected when the target is still `WORKING` or owns a `working` or `input_required` task. A manager cannot release its own session through this tool.

Free-form text such as “go idle”, “stop polling”, or “you are no longer needed” has no release authority. The manager must use the dedicated tool after reconciling or completing all owned tasks.

## Security and consistency invariants

- Role labels, prompt fragments, chat messages, task prose, memory, and repository text never grant manager authority.
- Every manager operation re-verifies the server-pinned collaboration role.
- Public collaboration session IDs are provenance, not bearer credentials.
- Permanent release is persisted outside the workspace under `PI_DATA_DIR` and is project-scoped.
- Work-state mutations use a cross-process lock, atomic file replacement, bounded retention, strict identifiers, and optimistic revisions.
- Task claiming remains a separate compare-and-swap operation with renewable leases. A wake-up never auto-claims a task.
- A changed task-board token means the worker must reread and select work; it does not prove that any particular task is compatible.
- A released session may call `agent_work_wait` only to observe the terminal result. Other project tools fail closed.
- Transport disposal records `OFFLINE`; it does not silently convert absence into permanent release.
- Backoff is capped and jittered to avoid synchronized hot polling and unbounded resource use.

## Recovery and races

- If chat changes between the pre-wait snapshot and the first sleep, the next authoritative check returns `changed`.
- If a task changes without a chat message, the task-board token changes and wakes the worker.
- If two workers attempt to claim the same task after a wake-up, task revision and lease semantics select at most one winner.
- Before a task claim, the target session transitions to `WORKING` under the same work-state lock used by manager release. Therefore a claim-versus-release race has one winner: release wins before `WORKING`, or claim makes release ineligible.
- If a manager reads an old work-state revision, release fails as stale and the manager must list again.
- If release occurs during a long poll, the next bounded check returns `released`.
- If the MCP request is cancelled, the server cancels the wait rather than leaving an unbounded timer.
- If the connection closes, the session becomes `OFFLINE`; task leases and collaboration-session recovery continue to follow their own stores.
- On later reads or registration, nonterminal work states are reconciled against authoritative collaboration-session status. Missing, normally released, or crash-revoked logical sessions become `OFFLINE`, allowing bounded retention to reclaim orphan entries without treating them as permanently released.

## Verification

The implementation is covered by:

- `test/work-loop.test.mjs`: lifecycle persistence, backoff bounds, stale revisions, release provenance, terminal non-revival, and offline reconnect;
- `test/mcp-work-loop.test.mjs`: bounded server wait, wake-up on task change, manager-only listing/release, owned-task release rejection, post-release tool blocking, and terminal wait result;
- `test/collaboration-roles.test.mjs`: prompt-contract requirements and golden contract digests;
- `test/tool-contract.test.mjs`: strict tool schemas, annotations, and continuous-work guidance;
- the full repository suite through `npm test`.

## Non-goals

This protocol does not:

- assign role compatibility or task priority by itself;
- replace the scheduler specification;
- keep a disconnected model process executing indefinitely;
- create background work outside an active MCP tool call;
- convert best-effort notifications into authority;
- allow a worker or free-form manager message to self-release;
- change the simple/master PiLink architecture.
