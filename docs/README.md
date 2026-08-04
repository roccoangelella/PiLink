# PiLink documentation authority map

Status: current documentation index and precedence guide
Maintainer: project manager, with the relevant domain maintainer or reviewer
Last reviewed: 2026-08-03

This file explains what each PiLink document is for, how much authority it has, and which documents should be read for a given role. It is a navigation and governance index, not a second project memory store.

## Source-of-truth order

When documents disagree, use this precedence order:

1. System and user instructions, authenticated project policy, and security boundaries.
2. Current executable repository state, tests, schemas, and durable task/session/activity state.
3. Explicit current manager or owner decisions recorded in an accepted decision document or durable task revision.
4. Current normative specifications listed below.
5. Acceptance reviews bound to the exact artifact or commit they reviewed.
6. Research and design basis documents.
7. Drafts and proposals.
8. Generated views and summaries.

A document, role name, memory entry, chat message, task description, or repository comment never grants authorization. Historical approval does not apply automatically to a later revision. Security invariants in [`security/threat-model.md`](security/threat-model.md) outrank convenience guidance in collaboration documents.

## Classification vocabulary

- **Current specification** — normative intended behavior for the named subsystem. Implementation may still be incomplete.
- **Accepted architecture/decision** — manager-accepted direction and sequencing. It governs design choices but does not by itself prove runtime implementation.
- **Research basis** — evidence, comparison, or recommendation used to inform decisions. Non-authoritative where an accepted decision differs.
- **Acceptance review** — revision-bound verification and findings. It is authoritative only for the exact reviewed artifact and stated acceptance boundary.
- **Draft** — collaborative proposal that must not be implemented or treated as policy unless promoted explicitly.
- **Operations** — instructions for operating, releasing, or maintaining the product.
- **Generated view** — derived navigation or summary output. It is never the underlying source of truth.

## Purpose-based layout

Substantive documentation is grouped by lifecycle and authority rather than kept as a flat pile:

| Folder | Contents |
|---|---|
| `architecture/` | Accepted system and component designs |
| `protocols/` | Normative state machines and behavioral contracts |
| `decisions/` | Accepted manager or product decisions |
| `security/` | Threat models and security specifications |
| `evaluation/` | Scenario suites, metrics, and rollout evidence |
| `reviews/` | Exact-revision acceptance reviews |
| `research/` | Non-authoritative evidence and alternatives |
| `operations/` | Setup, release, recovery, and maintenance |
| `reference/` | Stable registries, schemas, and terminology |
| `archive/` | Superseded historical material |

Only this authority index may live directly in `docs/`. The test `test/docs-structure.test.mjs` enforces the hierarchy, complete indexing, and valid local Markdown links. Generated projections remain ignored under `docs/generated/`.

## Document inventory

| Document | Classification | Authority and lifecycle | Maintainer | Revision / relation notes |
|---|---|---|---|---|
| [`../README.md`](../README.md) | Operations / product overview | Public entry point and supported-product usage. Current code and security policy win if prose is stale. | Product maintainer | Read before using PiLink; not a collaboration-memory source. |
| [`security/threat-model.md`](security/threat-model.md) | Current specification | Normative security objectives, trust boundaries, capability modes, invariants, and accepted residual risks. | Security maintainer and manager | Introduced in commit `63d09b9`; collaboration designs must conform to it. |
| [`operations/releasing.md`](operations/releasing.md) | Operations | Normative release procedure for maintainers, subject to current package scripts and repository protections. | Release maintainer | Related supply-chain hardening landed in commit `83868ac`. |
| [`operations/getting-started.md`](operations/getting-started.md) | Operations | Setup and first-use guidance for supported PiLink hosting, OAuth, connector, and workspace flows. | Product/release maintainer | Keep synchronized with current CLI behavior and root `README.md`. |
| [`decisions/collaboration-program.md`](decisions/collaboration-program.md) | Accepted architecture/decision | Primary collaboration-program decision baseline: continuous work, topology, identity, task/activity layers, roles, memory sequencing, and rollout gates. | Project manager | Program baseline was established around commits `5113337` and `500107c`; later explicit manager decisions and accepted subsystem documents may refine it. |
| [`archive/collaboration-memory-architecture.md`](archive/collaboration-memory-architecture.md) | Archived research and architecture history | Historical accepted target for governed memory. It remains useful rationale, but `architecture/agent-memory.md` is the current implementation contract where they differ. | Manager and memory architecture maintainer | Accepted in commit `8337a8f`; superseded for implementation guidance by `architecture/agent-memory.md`. |
| [`architecture/agent-memory.md`](architecture/agent-memory.md) | Current specification / implementation contract | Current governed-memory and documentation contract: canonical private store, memory tiers, authorization-first retrieval, projections, document taxonomy, migration phases, tests, and KPIs. Phase 1 read exposure is the branch release scope. | AI Engineer and manager | Accepted on 2026-08-03 under task `bb590309`; Phase 1 reads are implemented in `7ee1e25`; this contract refines and supersedes conflicting implementation guidance in the older memory architecture. |
| [`protocols/collaboration-role-contracts.md`](protocols/collaboration-role-contracts.md) | Current specification | Normative behavioral prompt-contract specification for manager, researcher, implementer, reviewer, and integration overlay. It is not authentication or runtime authorization. | Manager and prompt/runtime maintainer | Implements the accepted compositional-role direction. Current authenticated assignment and task state remain authoritative. |
| [`protocols/agent-work-loop.md`](protocols/agent-work-loop.md) | Current specification / implemented runtime contract | Normative `WORKING` / `WAITING_FOR_TASK` / `OFFLINE` / `RELEASED` lifecycle, bounded long polling, opaque cursor/token reuse, manager-only durable release, race handling, and verification. | AI Engineer, collaboration runtime maintainer, and manager | Implemented in `src/work-loop.ts`, `src/mcp.ts`, and `src/index.ts` under task `f761ca81`; it supplements role contracts and autonomous scheduling without granting task authority. |
| [`protocols/agent-work-loop-transport-continuity.md`](protocols/agent-work-loop-transport-continuity.md) | Current specification / implemented optional adapter | Defines protocol-native `Mcp-Session-Id` reuse, the implemented process-shared adapter for a trusted hidden per-conversation binding, fail-closed behavior, lifecycle, and isolation tests. | AI Engineer, collaboration runtime maintainer, and manager | Designed under tasks `6726165d` and `5006cd07`; the optional server adapter is implemented in `src/collaboration-context-registry.ts` and real-HTTP tests. The observed ChatGPT connector still supplies neither supported continuity mechanism, so end-to-end connector compatibility is not claimed. |
| [`protocols/chat-author-provenance.md`](protocols/chat-author-provenance.md) | Current specification / implemented runtime and UI contract | Server-authored immutable collaboration-role provenance for public-chat messages, truthful legacy migration, non-spoofable badges, and structured role filtering in the supported Textual monitor. | AI Engineer, chat runtime/UI maintainers, and manager | Designed under task `9b455954` and implemented under task `08116c81`; the full Node and Textual suites cover the contract. The external stale `/tmp/pilink-chat-web` viewer is unsupported and excluded from the fix claim. |
| [`reference/role-bootstrap-registry.md`](reference/role-bootstrap-registry.md) | Current reference / implementation design | Canonical role IDs, conservative aliases, occupancy labels, prompt composition, custom collaborator fallback, and integration boundaries. | AI Engineer and prompt/runtime maintainer | Implemented by the role registry and focused tests; authenticated session assignment remains authoritative. |
| [`evaluation/role-bootstrap-behavior.md`](evaluation/role-bootstrap-behavior.md) | Acceptance evaluation | Scenario matrix and exact-tree evidence for role bootstrap, session ownership, lifecycle, crash recovery, read-only compatibility, and prompt behavior. | AI Engineer / evaluator and manager | Applies to the feature branch runtime candidate and must be updated when material behavior changes. |
| [`protocols/autonomous-pull.md`](protocols/autonomous-pull.md) | Current specification | Normative backend-neutral scheduling and atomic-pull semantics, including trusted context, readiness, dependencies, scopes, ranking, no-work diagnostics, and migration. | Task/scheduler maintainer and manager | Corrected specification committed as `234ab52`. Runtime exposure remains gated by implementation review and credential/session acceptance. |
| [`evaluation/collaboration-plan.md`](evaluation/collaboration-plan.md) | Current specification and research basis | Normative evaluation configurations, scenario suites, metrics, failure injection, and rollout gates. It evaluates designs; it does not authorize them. | Research/evaluation maintainer and manager | Must be extended with memory-specific scenarios before governed-memory runtime work is accepted. |
| [`architecture/project-workspaces.md`](architecture/project-workspaces.md) | Accepted design basis | Design for durable project identity, registered workspaces, isolated worktrees, integration ownership, cleanup, and migration. No runtime implementation is claimed. | Manager and integration/workspace maintainer | Supports the manager decision that project identity must be separate from workspace paths. Treat implementation details as design targets until code and tests land. |
| [`research/collaboration-protocol.md`](research/collaboration-protocol.md) | Research basis | Ranked critique and evidence behind staged collaboration rollout, sparse communication, governed memory, and executable evaluation. | Researcher | Non-authoritative when superseded by manager decisions or accepted subsystem specifications. |
| [`reviews/credential-hardening.md`](reviews/credential-hardening.md) | Acceptance review | Exact security review of credential storage, verification, rotation, redaction, and recovery behavior for its named artifact revision. | Independent security reviewer | Historical outside its exact revision; later session/runtime commits require their own review. |
| [`reviews/session-activity.md`](reviews/session-activity.md) | Acceptance review | Exact review of activity commit `82f016d` and session/task commit `d544cd3`. Activity core was accepted for internal integration; session/task core was conditional and public model-visible credential wiring was rejected. | Independent reviewer / security reviewer | Review document committed as `0e65701`. Some task-authority findings were repaired by `3847741`; remaining session credential and transaction findings must be checked against later commits/tasks. |
| [`reviews/scheduler-ownership.md`](reviews/scheduler-ownership.md) | Acceptance review | Exact review of task-authority commit `3847741` and scheduler commit `9883ca1`. Task authority is accepted; scheduler acceptance is conditional pending the listed repair and rereview. | Independent reviewer | Do not treat its proposed repairs as implemented until a new exact commit verdict exists. |
| [`README.md`](README.md) | Generated view / authority index | This navigation and governance map. It describes authority but does not create it. | Project manager | Update whenever a document is added, promoted, superseded, archived, renamed, or removed. |

## Supersession and relationship summary

- `decisions/collaboration-program.md` is the collaboration-program baseline.
- `protocols/collaboration-role-contracts.md` makes the role/prompt portions of that baseline precise.
- `protocols/agent-work-loop.md` defines the implemented durable waiting and manager-release lifecycle that enforces the empty-queue portion of those role contracts.
- `protocols/autonomous-pull.md` makes the ready-queue and scheduling portions precise.
- `architecture/agent-memory.md` is the current memory/documentation implementation contract and supersedes conflicting implementation guidance in `archive/collaboration-memory-architecture.md`; the older document remains historical rationale.
- `architecture/project-workspaces.md` makes the project/workspace isolation direction precise, but remains a design artifact until implemented.
- `evaluation/collaboration-plan.md` defines how proposed and implemented layers are measured.
- `research/collaboration-protocol.md` explains evidence and alternatives; accepted decisions outrank it.
- Acceptance reviews never supersede specifications. They state whether an exact artifact conforms, identify defects, and become historical once a later revision receives a new review.

## Recommended reading order

### Manager

1. [`../README.md`](../README.md)
2. [`security/threat-model.md`](security/threat-model.md)
3. [`decisions/collaboration-program.md`](decisions/collaboration-program.md)
4. The accepted subsystem document relevant to the current decision:
   - [`architecture/agent-memory.md`](architecture/agent-memory.md)
   - [`archive/collaboration-memory-architecture.md`](archive/collaboration-memory-architecture.md) for historical rationale
   - [`protocols/collaboration-role-contracts.md`](protocols/collaboration-role-contracts.md)
   - [`protocols/agent-work-loop.md`](protocols/agent-work-loop.md)
   - [`protocols/autonomous-pull.md`](protocols/autonomous-pull.md)
   - [`architecture/project-workspaces.md`](architecture/project-workspaces.md)
5. [`evaluation/collaboration-plan.md`](evaluation/collaboration-plan.md)
6. Relevant acceptance reviews and durable task state
7. Research basis and drafts only when revisiting an unresolved design choice

### Researcher

1. This authority map and [`decisions/collaboration-program.md`](decisions/collaboration-program.md)
2. The precise current subsystem specification for the research question
3. [`research/collaboration-protocol.md`](research/collaboration-protocol.md) and the research sections of accepted architecture documents
4. [`evaluation/collaboration-plan.md`](evaluation/collaboration-plan.md)
5. Relevant acceptance reviews and repository evidence
6. Drafts only as explicitly labeled historical proposals

Research findings remain candidates until accepted; they do not directly modify runtime policy or canonical memory.

### Implementer

1. [`../README.md`](../README.md) and [`security/threat-model.md`](security/threat-model.md)
2. Current durable task brief, allowed paths, dependencies, and exact acceptance criteria
3. The relevant current specification or accepted architecture document
4. The latest acceptance review for the base commit or component, if any
5. Current code, tests, and schemas
6. Drafts only when the task explicitly asks to implement or revise them

Implementation must follow current code/test constraints and authenticated task scope rather than copying prose blindly.

### Reviewer

1. This authority map and [`security/threat-model.md`](security/threat-model.md)
2. Current manager decision and exact subsystem specification
3. Exact task revision, commit, diff, tests, and claimed evidence
4. [`evaluation/collaboration-plan.md`](evaluation/collaboration-plan.md) for required scenarios and metrics
5. Previous acceptance reviews only as historical context
6. Research basis and drafts for additional failure hypotheses, not as acceptance authority

Every verdict must name the exact reviewed revision and achieved independence level. A material revision requires rereview.

## Documentation maintenance rule

Every new or materially changed document must be added or updated in this index in the same commit that makes it an accepted repository artifact. Record:

- one classification from the vocabulary above;
- an explicit status near the top of the document;
- owner or maintainer role;
- whether runtime implementation is claimed;
- exact artifact/commit binding for reviews;
- `supersedes` and `superseded by` relationships where applicable;
- security and authorization limitations;
- the date or commit of the latest authority review when practical.

Do not silently rewrite historical acceptance reviews or research documents to match later decisions. Add a new revision, decision, or review and link the relationship. Generated summaries must be reproducible from authoritative records and clearly labeled non-authoritative.
