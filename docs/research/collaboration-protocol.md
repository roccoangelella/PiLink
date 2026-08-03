# Collaboration protocol research review

Status: research-only critique; no runtime implementation claimed

## Executive recommendation

PiLink should not implement persistent roles, governed long-term memory, enforced standups, collaboration permits, a new activity ledger, and a dashboard as one MVP. The drafts contain strong ideas, but the combined surface is too large to evaluate causally and too easy to make unusable through coordination friction.

Use an incremental program:

1. **Make current coordination durable and measurable.** Add a typed append-only activity feed derived from task transitions, plus task-scoped plans and verification evidence.
2. **Add selective review, not universal review.** Require a distinct reviewer only for work selected by explicit risk/dependency rules.
3. **Introduce enforcement gradually.** Start advisory, collect denial simulations, then gate only high-risk mutations and terminal declarations.
4. **Add persistent roles after the workflow is stable.** Roles should be versioned capability/responsibility bundles, not personas or authentication identities.
5. **Add governed memory last.** Prefer authoritative task/decision/event projections over manually authored shared memory; keep role memory advisory and provenance-bound.

The central design principle should be: **one accountable task owner, sparse risk-selected communication, executable evidence, and durable recovery state**.

## Ranked decision matrix

Scores are relative for PiLink’s current architecture: 5 is strongest. “Evidence” means direct support from standards or empirical agent research, not certainty that the option will work unchanged in PiLink.

| Decision | Recommended option | Utility | Safety / recoverability | Implementation fit | Evidence | Main failure mode to test |
|---|---|---:|---:|---:|---:|---|
| Role prompts | Compositional, versioned role contracts with five base workflow roles | 5 | 5 | 4 | 4 | Prompt fragments conflict or grant accidental authority |
| Communication history | Typed append-only activity ledger as canonical history; public chat remains a compatibility/note surface | 5 | 5 | 4 | 5 | Event spam, schema ossification, or non-atomic task/event updates |
| Long memory | Governed canonical decision/constraint projections plus advisory role-local memory | 5 | 5 | 3 | 4 | Stale or poisoned content is retrieved as authority |
| Standups | Event-driven task checkpoints; deterministic mutation budget; optional wall-clock reminder only | 5 | 5 | 5 | 4 | Checkpoint storms or unclear counter semantics |
| Topology | Manager-worker star for delegation plus sparse dependency/risk-selected reviewer edges | 5 | 5 | 4 | 5 | Manager bottleneck or hidden cross-task dependency |
| Evaluation | Scenario-based ablations with executable task outcomes and milestone/coordination metrics | 5 | 5 | 4 | 5 | Optimizing activity metrics while task quality falls |

### Decision 1 — compositional role contracts beat many fixed categories

**Rank 1: compositional role contracts.** Define a small schema for objective, authority, forbidden decisions, tools/path scope, required inputs, coordination obligations, escalation, evidence, memory policy, and prompt version. Build `manager`, `researcher`, `implementer`, `reviewer`, and `integrator` as tested base contracts; project-specific roles extend them.

**Rank 2: fixed role templates.** Useful only as user-facing presets generated from the same contract schema. They should not be independent hand-written system prompts.

**Rank 3: prompt-only self-declared categories.** Easy to use, but unauthenticated, inconsistent, and unable to enforce permissions.

This aligns with modern agent orchestration guidance: specialized agents are useful, but deterministic code should own routing and policy where predictability matters. The manager-as-tools and handoff patterns are workflow choices, not reasons to create dozens of persona prompts.

### Decision 2 — the event ledger should be canonical, not the chat transcript

**Rank 1: typed append-only ledger with task-threaded projections.** Task transitions emit events server-side with idempotency; agents query bounded pages, task threads, and attention views.

**Rank 2: compatibility chat over the ledger.** Preserve `agent_chat_post/read` for concise findings and questions, but map notes into the ledger and stop using free text for lifecycle transitions the server can derive.

**Rank 3: larger public-chat transcript.** Raising the ring limit only delays loss, preserves ambiguous semantics, and requires users/agents to reconstruct state manually.

MCP Tasks and A2A both separate durable task state from optional notifications/messages. Anthropic’s long-running-agent study similarly found that explicit progress artifacts and git history reduce repeated rediscovery.

### Decision 3 — use governed projections, not a manager-owned truth file

**Rank 1: canonical decision/constraint projections plus role-local memory.** Canonical entries require provenance and explicit acceptance; role-local entries are advisory continuity notes. Contradictions create disputes/supersession rather than overwrite.

**Rank 2: a manager-maintained project brief.** Valuable as a compact boot projection generated from authoritative state, but unsafe as the sole truth source or a manually rewritten history.

**Rank 3: one unrestricted shared long-memory document/store.** High risk of stale propagation, contradiction persistence, provenance loss, and prompt injection.

The current design should therefore rename “long memory” in the MVP to narrower concepts such as `accepted_decisions`, `active_constraints`, `unresolved_risks`, and `handoff_summary`. General semantic memory comes later.

### Decision 4 — checkpoints should be event-driven, not meeting-clock-driven

**Rank 1: event-driven triggers.** Trigger a checkpoint on task claim, material scope/risk change, detected overlap, blocker, failed verification, pre-completion, or deterministic successful-mutation budget exhaustion.

**Rank 2: hybrid event budget plus wall-clock reminder.** A timer may mark a checkpoint as due or notify connected clients, but should enforce only on the next relevant call.

**Rank 3: fixed timed standups for all agents.** Remote sessions cannot be forced to wake, idle time is not work, and global cadence produces noise and quorum deadlocks.

The first implementation should count successful task-attributed gated mutations. Active-time accounting should wait until retry, concurrency, and nested-call semantics are specified.

### Decision 5 — use centralized delegation with sparse review edges

**Rank 1: manager-worker star plus dependency/risk-selected review.** The manager owns decomposition and integration; workers operate asynchronously on isolated scopes; reviewers connect only where risk or dependencies justify them.

**Rank 2: fixed role pipeline.** Research → implementation → review → integration works for predictable tasks but is inefficient for small or exploratory work.

**Rank 3: all-to-all debate and universal peer approval.** Expensive, vulnerable to approval fatigue, and empirically unnecessary: sparse communication can match or exceed fully connected debate at lower cost.

Recent asynchronous SWE-agent evidence strongly favors centralized dependency-aware delegation, isolated workspaces, branch-and-merge, and executable integration tests. This also exposes a PiLink requirement beyond chat: agents need isolated worktrees or equivalent ownership boundaries.

### Decision 6 — evaluate with ablations and executable scenarios

**Rank 1: configuration ablations over a fixed scenario suite.** Compare baseline, ledger, plans/scopes, selective review, advisory policy, strict high-risk policy, roles, and memory while holding tasks/models as constant as possible.

**Rank 2: conventional unit/integration tests only.** Necessary for correctness and security, but insufficient to show that the collaboration design improves outcomes.

**Rank 3: transcript ratings or agent self-reports.** Useful diagnostically but easy to game and weakly connected to working code.

Primary success measures must include task correctness, regressions, conflicts, duplicate work, stale-revision attempts, recovery after offline gaps, reviewer wait time, policy false denials/allows, executable verification, and user intervention. Milestone-based coordination metrics are preferable to message volume.

## Repository observations

The current implementation already provides useful primitives:

- stable OAuth actor identity and a server-minted per-connection `agent_instance_id`;
- durable typed tasks with leases, explicit interrupted state (`input_required`), terminal states, and optimistic revisions;
- best-effort notifications with durable re-read as the source of truth;
- a lightweight public chat for unstructured coordination.

The current limitations are also clear:

- chat retains only 20 messages and older gaps cannot be recovered;
- task lifecycle and chat history are separate, so agents duplicate status manually;
- there is no typed plan, dependency, declared path scope, review, or verification record;
- identity is available, but durable project roles and role authorization are not;
- observed posts from one manager conversation received different `agent_instance_id` values, so connection identity is not a reliable conversation/run/collaboration-session identity;
- the current shared working tree allows concurrent agents to interfere even if the communication protocol is perfect.

The last limitation is important: collaboration semantics cannot compensate for workspace isolation. Recent asynchronous software-engineering-agent research reports strong gains from centralized dependency-aware delegation, isolated workspaces, branch-and-merge integration, and executable verification. PiLink should therefore treat workspace/branch isolation as a first-class coordination track, not merely a later implementation detail.

## What the existing drafts get right

### Separate identity concepts

Keeping OAuth actor, live instance, project role, and revocable assignment separate is correct. Natural-language text such as “you are the reviewer” must never authorize a role.

### Bind reviews to exact revisions

A critique or approval must target a specific plan revision. Any material plan change invalidates prior approval. This matches the optimistic-concurrency discipline already implemented for tasks.

### Keep notifications non-authoritative

MCP task notifications are optional and requestors must not depend on receiving them. The repository’s existing rule—notification prompts a durable re-read—is the right model.

### Preserve recovery tools

Read, task inspection, coordination, and status/diff operations must remain available even when mutations are blocked. Any enforcement design that blocks the tools needed to recover creates an unrecoverable policy deadlock.

### Govern memory promotion

The proposed candidate/active/disputed/superseded lifecycle is directionally strong. Recent shared-memory work identifies stale propagation, contradiction persistence, unauthorized leakage, and provenance collapse as distinct systems failures; simple “one project memory file” designs do not solve them.

## Main design risks and corrections

### 1. Universal standups will create coordination tax and quorum deadlocks

Do not require every active role to submit a plan, critique another agent, and checkpoint on a global cadence. Multi-agent research does not support all-to-all communication as a default: sparse topologies can achieve comparable or better quality at lower cost, and benchmark results vary by scenario and topology.

**Correction:** make coordination task-scoped and participant-scoped.

- Every substantial task has one accountable owner.
- Only agents with a dependency, overlapping scope, integration responsibility, or selected review duty participate.
- Observers may post advisory findings but do not block the task.
- A manager sees the whole dependency graph but need not approve every low-risk plan.

### 2. The MVP is too broad to evaluate

If roles, memory, review, permits, checkpoints, and activity views land together, any improvement or regression will be uninterpretable.

**Correction:** run staged ablations:

- baseline current tasks/chat;
- typed activity ledger only;
- task plan + verification fields;
- selective independent review;
- advisory policy simulation;
- strict enforcement for selected operations;
- role continuity;
- governed memory.

Each stage must preserve the same scenario suite and metrics.

### 3. “Distinct role” is not sufficient reviewer independence

Two role labels held by the same OAuth actor and the same live model context are not independent review. More importantly, the current `agent_instance_id` is a transport connection identity and has already changed across posts from one manager conversation; a different value does not prove context separation.

**Correction:** introduce an explicit, stable, server-minted `collaboration_session_id` that a client rejoins/reuses across calls. Bind it to the OAuth actor, use an unguessable handle, define expiry/rejoin/revocation, and reject cross-actor reuse. Record the achieved independence level explicitly:

- `same_collaboration_session_self_review`;
- `different_collaboration_session_same_actor`;
- `different_actor`;
- `human_owner`.

Policy can accept weaker levels for low-risk work, but the UI and audit trail must not call them equivalent. Transport connection IDs remain useful for delivery diagnostics, not collaboration identity or reviewer independence.

### 4. Role design should be compositional, not a large catalog of personas

A fixed prompt for every imagined category will become inconsistent and difficult to version.

**Correction:** define a small role contract schema and compose prompts from it:

- objective and deliverable;
- authority and forbidden decisions;
- allowed tool classes and path scope;
- required inputs to read before acting;
- coordination obligations;
- escalation conditions;
- evidence/definition of done;
- memory read/write policy;
- prompt version.

Start with five workflow roles: `manager`, `researcher`, `implementer`, `reviewer`, and `integrator`. Project-specific roles should extend these contracts rather than duplicate whole prompts.

### 5. Long-term memory should not become a second source of truth

The repository, tests, task state, accepted decision records, and user instructions are authoritative. Free-form shared memory is not.

**Correction:** before implementing general memory, add narrower durable projections:

- accepted decisions;
- active constraints;
- unresolved risks/questions;
- task handoff summaries;
- verified procedures.

Every projection should reference source event IDs, task revisions, paths, commits, or audit calls. Retrieval must label stale/disputed content and never inject memory as policy text. Memory-poisoning research shows that policy-formatted content can be laundered into trusted context when provenance is lost.

### 6. Collaboration permits are useful but should not be phase one

A permit layer adds a new authorization object, invalidation rules, counters, path matching, recovery errors, and compatibility risk. Gating every `edit` and `write` immediately will block trivial fixes and single-agent work.

**Correction:** first implement a policy evaluator in shadow/advisory mode. Record whether a call would have been allowed or denied, why, and which recovery action would be required. Only enable strict enforcement after the false-positive rate and deadlock scenarios are understood.

Initial strict scope should be limited to:

- unrestricted `bash`;
- execution of workspace code;
- writes outside declared task paths;
- task completion when required verification/review is missing;
- promotion of shared canonical decisions/memory.

Routine reads and in-scope edits should remain available under balanced policy unless a user selects strict mode.

### 7. Checkpoint budgets need precise semantics

“Thirty active minutes or fifteen mutating calls” is not implementable until active time, nested calls, retries, failed calls, and concurrent sessions are defined.

**Correction:** prefer deterministic event budgets first.

- Count successful gated mutations attributed to one task/plan revision.
- Do not count reads, coordination calls, validation failures, or idempotent retries.
- Make the budget atomic in the same store as the permit/task revision.
- Add active-time expiry later if user research shows value.

### 8. PiLink coordination tasks must remain distinct from MCP Tasks

MCP Tasks are experimental, requestor-driven wrappers around long-running requests. They begin in `working`, have TTL/result polling semantics, and are not a general team task board. PiLink’s `open -> working -> input_required -> terminal` project tasks serve a different purpose.

**Correction:** retain PiLink-namespaced coordination tools and avoid implying MCP Tasks compliance. Reuse compatible ideas—durable IDs, interrupted states, polling, pagination, optional notifications, TTL/resource controls—without conflating the protocols.

### 9. State-machine complexity should be minimized

A separate global standup state machine duplicates parts of task state and creates synchronization questions between task, plan, review, permit, and round revisions.

**Correction:** for the first implementation, attach coordination records to the task:

- current `plan_revision`;
- declared paths/tool classes;
- dependencies;
- verification criteria;
- reviews for that revision;
- current policy decision;
- checkpoint counter;
- unresolved blockers.

A “standup” can initially be a user-facing projection over these records rather than an independently mutable global entity. Add explicit rounds only if multiple-task planning needs them later.

## Recommended minimum semantics

### Task risk classification

Use deterministic signals first, with explicit manager/user override:

- **low:** documentation-only, tests-only, or isolated in-scope change with no dependency;
- **medium:** multiple files/components, shared API/configuration, or integration dependency;
- **high:** security/auth, destructive operations, dependency/supply-chain changes, public API/schema changes, migrations, unrestricted execution, or overlapping ownership.

The classifier must return reasons, not only a label.

### Review policy

- low: self-review plus verification evidence is sufficient;
- medium: different instance or different actor review, depending on availability;
- high: different actor or human-owner approval;
- no timeout autoapproval;
- explicit downgrade/override with reason, expiry, and visible independence level.

### Minimal plan

Keep required fields small enough that agents actually use them:

- goal;
- declared paths/components;
- dependencies/owners affected;
- main risk;
- verification commands or observable checks;
- expected artifact.

Long natural-language step lists should be optional.

### Minimal checkpoint

- completed artifact/evidence;
- deviation from plan;
- new blocker/dependency;
- next action;
- whether scope/risk changed.

No mandatory memory write.

### Completion gate

Completion should require evidence appropriate to the task, not merely a peer’s prose approval:

- clean diff or isolated commit/worktree state;
- focused tests/checks;
- integration/full suite when relevant;
- unresolved blocking reviews = zero;
- artifact/commit/path reference;
- declared deviations resolved or accepted.

## Activity and communication model

The typed activity-ledger proposal should be the first major feature because it improves recovery and observability without restricting agents.

Recommended communication topology:

- manager receives task lifecycle, blockers, dependency changes, and completion events;
- task owner and assigned reviewer share the task thread;
- agents with overlapping declared paths receive conflict notifications;
- routine progress remains queryable but is not broadcast globally;
- `requires_user` events remain in an attention projection until explicitly resolved.

Task mutations should emit activity events server-side exactly once. Agents should not manually repeat claims, pauses, completion, or lease changes in chat. Free-form chat remains for findings and questions that are not derivable from state.

## Evaluation program

### Compare configurations

Run the same workload under:

1. current baseline;
2. durable typed activity only;
3. plans and declared scopes;
4. selective review;
5. advisory policy simulation;
6. strict high-risk enforcement;
7. role continuity;
8. governed memory.

### Outcome metrics

Measure both task output and coordination quality:

- task success and regression rate;
- focused/full-test pass rate;
- duplicate work incidents;
- overlapping-edit conflicts and reverted work;
- stale-revision mutation attempts;
- blocker resolution rate;
- recovery success after offline gaps or new sessions;
- time from task creation to first useful mutation;
- time spent waiting for review/input;
- number of coordination messages/tool calls;
- token/cost overhead where observable;
- policy false denials and unsafe false allows;
- user interventions and overrides;
- provenance completeness for decisions/memory.

Do not optimize message count alone: recent coordination benchmarks show that communication is important, but topology and milestone achievement matter more than raw volume.

### Required scenario suite

- one low-risk one-line fix with only one agent available;
- two disjoint tasks in parallel;
- two agents declaring overlapping files;
- stale plan approval after a revision;
- reviewer disconnects or lease expires;
- manager disappears while implementers continue;
- blocked task receives late input;
- urgent revert/hotfix;
- same OAuth actor across multiple instances;
- different OAuth actors;
- offline agent resumes after more than 20 events;
- malicious chat/memory entry formatted as policy;
- contradictory decision/memory entries;
- high-risk auth/configuration change;
- failed test evidence followed by a corrected revision;
- task completion claimed without executable evidence.

### Decision gates

Before moving from advisory to strict enforcement, require evidence that:

- recovery paths work without administrator file surgery;
- no scenario silently autoapproves;
- single-agent low-risk work remains possible;
- review unavailability is visible and recoverable;
- strict mode materially reduces unsafe/conflicting work rather than only adding delay;
- every denial returns a precise next action and relevant identifiers.

## Prioritized backlog

### P0 — implement/evaluate first

1. Durable typed activity ledger with pagination and attention view.
2. Server-derived task lifecycle events with idempotency.
3. Minimal task plan, declared scope, dependencies, and verification evidence.
4. Overlap/dependency detection and task-scoped notifications.
5. Baseline scenario harness and metrics.
6. Workspace isolation/branch-and-merge design spike.

### P1 — after baseline metrics

1. Deterministic risk classifier with reasons.
2. Selective review records bound to exact plan revisions.
3. Advisory policy evaluator and denial simulation.
4. Completion evidence gate.
5. Minimal compositional role contracts and secure assignment.

### P2 — only after workflow stability

1. Strict collaboration permits for high-risk operations.
2. Event-budget checkpoints.
3. Governed decision/constraint memory.
4. Role-local advisory memory.
5. Expanded authenticated dashboard.

## Primary research and standards grounding

- MCP Tasks, 2025-11-25: durable request state, capability negotiation, optional notifications, polling, interrupted `input_required`, TTL/resource management. https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks
- MCP Elicitation, 2025-11-25: explicit client-mediated user interaction with accept/decline/cancel and mode capability negotiation. https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation
- A2A 1.0 specification and task lifecycle: opaque agents, capability discovery, authenticated authorization, contextual messages, interrupted versus terminal task states. https://a2a-protocol.org/latest/specification/ and https://a2a-protocol.org/latest/topics/life-of-a-task/
- Anthropic, “Effective harnesses for long-running agents” (2025): clean incremental commits, progress artifacts, and end-to-end verification improve continuity. https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
- Geng and Neubig, “Effective Strategies for Asynchronous Software Engineering Agents” (2026): centralized dependency-aware delegation, isolated workspaces, branch-and-merge, and executable verification. https://arxiv.org/abs/2603.21489
- Li et al., “Improving Multi-Agent Debate with Sparse Communication Topology” (EMNLP 2024 Findings): sparse communication can match or exceed fully connected debate with lower cost. https://aclanthology.org/2024.findings-emnlp.427/
- Zhu et al., “MultiAgentBench” (ACL 2025): milestone-based collaboration metrics and topology-dependent results. https://aclanthology.org/2025.acl-long.421/
- Margalit et al., “Governed Shared Memory for Multi-Agent LLM Systems” (2026): scoped retrieval, supersession, provenance, and policy-governed propagation address stale/contradictory memory. https://arxiv.org/abs/2606.24535
- Ahad et al., “The Misattribution Gap” (2026): provenance loss can launder poisoned memory into apparently trusted policy context. https://arxiv.org/abs/2605.22842
- OpenAI Agents SDK orchestration, sessions, and sandbox memory docs: manager versus handoff patterns, code-orchestrated determinism, session/memory separation, and separate memory layouts. https://openai.github.io/openai-agents-python/multi_agent/ and https://openai.github.io/openai-agents-python/sandbox/memory/
