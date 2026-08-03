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

A document, role name, memory entry, chat message, task description, or repository comment never grants authorization. Historical approval does not apply automatically to a later revision. Security invariants in [`THREAT_MODEL.md`](THREAT_MODEL.md) outrank convenience guidance in collaboration documents.

## Classification vocabulary

- **Current specification** — normative intended behavior for the named subsystem. Implementation may still be incomplete.
- **Accepted architecture/decision** — manager-accepted direction and sequencing. It governs design choices but does not by itself prove runtime implementation.
- **Research basis** — evidence, comparison, or recommendation used to inform decisions. Non-authoritative where an accepted decision differs.
- **Acceptance review** — revision-bound verification and findings. It is authoritative only for the exact reviewed artifact and stated acceptance boundary.
- **Draft** — collaborative proposal that must not be implemented or treated as policy unless promoted explicitly.
- **Operations** — instructions for operating, releasing, or maintaining the product.
- **Generated view** — derived navigation or summary output. It is never the underlying source of truth.

## Document inventory

| Document | Classification | Authority and lifecycle | Maintainer | Revision / relation notes |
|---|---|---|---|---|
| [`../README.md`](../README.md) | Operations / product overview | Public entry point and supported-product usage. Current code and security policy win if prose is stale. | Product maintainer | Read before using PiLink; not a collaboration-memory source. |
| [`THREAT_MODEL.md`](THREAT_MODEL.md) | Current specification | Normative security objectives, trust boundaries, capability modes, invariants, and accepted residual risks. | Security maintainer and manager | Introduced in commit `63d09b9`; collaboration designs must conform to it. |
| [`RELEASING.md`](RELEASING.md) | Operations | Normative release procedure for maintainers, subject to current package scripts and repository protections. | Release maintainer | Related supply-chain hardening landed in commit `83868ac`. |
| [`GETTING_STARTED.md`](GETTING_STARTED.md) | Operations | Setup and first-use guidance for supported PiLink hosting, OAuth, connector, and workspace flows. | Product/release maintainer | Keep synchronized with current CLI behavior and root `README.md`. |
| [`COLLABORATION_MANAGER_DECISIONS.md`](COLLABORATION_MANAGER_DECISIONS.md) | Accepted architecture/decision | Primary collaboration-program decision baseline: continuous work, topology, identity, task/activity layers, roles, memory sequencing, and rollout gates. | Project manager | Program baseline was established around commits `5113337` and `500107c`; later explicit manager decisions and accepted subsystem documents may refine it. |
| [`COLLABORATION_MEMORY_ARCHITECTURE.md`](COLLABORATION_MEMORY_ARCHITECTURE.md) | Accepted architecture/decision and research basis | Historical accepted target for governed memory. It remains useful rationale, but `AGENT_MEMORY_ARCHITECTURE.md` is the current implementation contract where they differ. | Manager and memory architecture maintainer | Accepted in commit `8337a8f`; superseded for implementation guidance by `AGENT_MEMORY_ARCHITECTURE.md`. |
| [`AGENT_MEMORY_ARCHITECTURE.md`](AGENT_MEMORY_ARCHITECTURE.md) | Current specification / implementation contract | Current governed-memory and documentation contract: canonical private store, memory tiers, authorization-first retrieval, projections, document taxonomy, migration phases, tests, and KPIs. Phase 1 read exposure is the branch release scope. | AI Engineer and manager | Accepted on 2026-08-03 under task `bb590309`; Phase 1 reads are implemented in `7ee1e25`; this contract refines and supersedes conflicting implementation guidance in the older memory architecture. |
| [`COLLABORATION_ROLE_CONTRACTS.md`](COLLABORATION_ROLE_CONTRACTS.md) | Current specification | Normative behavioral prompt-contract specification for manager, researcher, implementer, reviewer, and integration overlay. It is not authentication or runtime authorization. | Manager and prompt/runtime maintainer | Implements the accepted compositional-role direction. Current authenticated assignment and task state remain authoritative. |
| [`ROLE_BOOTSTRAP_REGISTRY.md`](ROLE_BOOTSTRAP_REGISTRY.md) | Current reference / implementation design | Canonical role IDs, conservative aliases, occupancy labels, prompt composition, custom collaborator fallback, and integration boundaries. | AI Engineer and prompt/runtime maintainer | Implemented by the role registry and focused tests; authenticated session assignment remains authoritative. |
| [`ROLE_BOOTSTRAP_BEHAVIOR_EVALUATION.md`](ROLE_BOOTSTRAP_BEHAVIOR_EVALUATION.md) | Acceptance evaluation | Scenario matrix and exact-tree evidence for role bootstrap, session ownership, lifecycle, crash recovery, read-only compatibility, and prompt behavior. | AI Engineer / evaluator and manager | Applies to the feature branch runtime candidate and must be updated when material behavior changes. |
| [`AUTONOMOUS_PULL_PROTOCOL.md`](AUTONOMOUS_PULL_PROTOCOL.md) | Current specification | Normative backend-neutral scheduling and atomic-pull semantics, including trusted context, readiness, dependencies, scopes, ranking, no-work diagnostics, and migration. | Task/scheduler maintainer and manager | Corrected specification committed as `234ab52`. Runtime exposure remains gated by implementation review and credential/session acceptance. |
| [`COLLABORATION_EVALUATION_PLAN.md`](COLLABORATION_EVALUATION_PLAN.md) | Current specification and research basis | Normative evaluation configurations, scenario suites, metrics, failure injection, and rollout gates. It evaluates designs; it does not authorize them. | Research/evaluation maintainer and manager | Must be extended with memory-specific scenarios before governed-memory runtime work is accepted. |
| [`COLLABORATION_PROJECT_WORKTREES.md`](COLLABORATION_PROJECT_WORKTREES.md) | Accepted design basis | Design for durable project identity, registered workspaces, isolated worktrees, integration ownership, cleanup, and migration. No runtime implementation is claimed. | Manager and integration/workspace maintainer | Supports the manager decision that project identity must be separate from workspace paths. Treat implementation details as design targets until code and tests land. |
| [`COLLABORATION_PROTOCOL_RESEARCH_REVIEW.md`](COLLABORATION_PROTOCOL_RESEARCH_REVIEW.md) | Research basis | Ranked critique and evidence behind staged collaboration rollout, sparse communication, governed memory, and executable evaluation. | Researcher | Non-authoritative when superseded by manager decisions or accepted subsystem specifications. |
| [`CREDENTIAL_HARDENING_ACCEPTANCE_REVIEW.md`](CREDENTIAL_HARDENING_ACCEPTANCE_REVIEW.md) | Acceptance review | Exact security review of credential storage, verification, rotation, redaction, and recovery behavior for its named artifact revision. | Independent security reviewer | Historical outside its exact revision; later session/runtime commits require their own review. |
| [`SESSION_ACTIVITY_ACCEPTANCE_REVIEW.md`](SESSION_ACTIVITY_ACCEPTANCE_REVIEW.md) | Acceptance review | Exact review of activity commit `82f016d` and session/task commit `d544cd3`. Activity core was accepted for internal integration; session/task core was conditional and public model-visible credential wiring was rejected. | Independent reviewer / security reviewer | Review document committed as `0e65701`. Some task-authority findings were repaired by `3847741`; remaining session credential and transaction findings must be checked against later commits/tasks. |
| [`SCHEDULER_OWNERSHIP_ACCEPTANCE_REVIEW.md`](SCHEDULER_OWNERSHIP_ACCEPTANCE_REVIEW.md) | Acceptance review | Exact review of task-authority commit `3847741` and scheduler commit `9883ca1`. Task authority is accepted; scheduler acceptance is conditional pending the listed repair and rereview. | Independent reviewer | Do not treat its proposed repairs as implemented until a new exact commit verdict exists. |
| [`README.md`](README.md) | Generated view / authority index | This navigation and governance map. It describes authority but does not create it. | Project manager | Update whenever a document is added, promoted, superseded, archived, renamed, or removed. |

## Supersession and relationship summary

- `COLLABORATION_MANAGER_DECISIONS.md` is the collaboration-program baseline.
- `COLLABORATION_ROLE_CONTRACTS.md` makes the role/prompt portions of that baseline precise.
- `AUTONOMOUS_PULL_PROTOCOL.md` makes the ready-queue and scheduling portions precise.
- `AGENT_MEMORY_ARCHITECTURE.md` is the current memory/documentation implementation contract and supersedes conflicting implementation guidance in `COLLABORATION_MEMORY_ARCHITECTURE.md`; the older document remains historical rationale.
- `COLLABORATION_PROJECT_WORKTREES.md` makes the project/workspace isolation direction precise, but remains a design artifact until implemented.
- `COLLABORATION_EVALUATION_PLAN.md` defines how proposed and implemented layers are measured.
- `COLLABORATION_PROTOCOL_RESEARCH_REVIEW.md` explains evidence and alternatives; accepted decisions outrank it.
- Acceptance reviews never supersede specifications. They state whether an exact artifact conforms, identify defects, and become historical once a later revision receives a new review.
- `AGENT_ACTIVITY_DESIGN.md` and `ENFORCED_COLLABORATION_DESIGN.md` remain drafts and must not be used to override accepted documents.

## Recommended reading order

### Manager

1. [`../README.md`](../README.md)
2. [`THREAT_MODEL.md`](THREAT_MODEL.md)
3. [`COLLABORATION_MANAGER_DECISIONS.md`](COLLABORATION_MANAGER_DECISIONS.md)
4. The accepted subsystem document relevant to the current decision:
   - [`AGENT_MEMORY_ARCHITECTURE.md`](AGENT_MEMORY_ARCHITECTURE.md)
   - [`COLLABORATION_MEMORY_ARCHITECTURE.md`](COLLABORATION_MEMORY_ARCHITECTURE.md) for historical rationale
   - [`COLLABORATION_ROLE_CONTRACTS.md`](COLLABORATION_ROLE_CONTRACTS.md)
   - [`AUTONOMOUS_PULL_PROTOCOL.md`](AUTONOMOUS_PULL_PROTOCOL.md)
   - [`COLLABORATION_PROJECT_WORKTREES.md`](COLLABORATION_PROJECT_WORKTREES.md)
5. [`COLLABORATION_EVALUATION_PLAN.md`](COLLABORATION_EVALUATION_PLAN.md)
6. Relevant acceptance reviews and durable task state
7. Research basis and drafts only when revisiting an unresolved design choice

### Researcher

1. This authority map and [`COLLABORATION_MANAGER_DECISIONS.md`](COLLABORATION_MANAGER_DECISIONS.md)
2. The precise current subsystem specification for the research question
3. [`COLLABORATION_PROTOCOL_RESEARCH_REVIEW.md`](COLLABORATION_PROTOCOL_RESEARCH_REVIEW.md) and the research sections of accepted architecture documents
4. [`COLLABORATION_EVALUATION_PLAN.md`](COLLABORATION_EVALUATION_PLAN.md)
5. Relevant acceptance reviews and repository evidence
6. Drafts only as explicitly labeled historical proposals

Research findings remain candidates until accepted; they do not directly modify runtime policy or canonical memory.

### Implementer

1. [`../README.md`](../README.md) and [`THREAT_MODEL.md`](THREAT_MODEL.md)
2. Current durable task brief, allowed paths, dependencies, and exact acceptance criteria
3. The relevant current specification or accepted architecture document
4. The latest acceptance review for the base commit or component, if any
5. Current code, tests, and schemas
6. Drafts only when the task explicitly asks to implement or revise them

Implementation must follow current code/test constraints and authenticated task scope rather than copying prose blindly.

### Reviewer

1. This authority map and [`THREAT_MODEL.md`](THREAT_MODEL.md)
2. Current manager decision and exact subsystem specification
3. Exact task revision, commit, diff, tests, and claimed evidence
4. [`COLLABORATION_EVALUATION_PLAN.md`](COLLABORATION_EVALUATION_PLAN.md) for required scenarios and metrics
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
