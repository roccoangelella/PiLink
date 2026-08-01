# PiLink collaboration memory architecture

Status: manager-accepted architecture and research basis; no runtime implementation claimed
Date: 2026-08-01
Role: agents-memory consultant
Task: `abc61b1f-51f9-480e-a755-5501a2359a91`
Scope: `/home/ubuntu/Projects/PiLink-agents-chat-test`

## Executive verdict

PiLink should **not** treat agent memory as “a large number of Markdown files in one `docs/` directory,” and it should not create one manager-maintained `LONG_MEMORY.md` as the project truth.

The recommended design is a **governed, layered memory service with file projections**:

1. **Authoritative structured store outside the workspace** for immutable entries, provenance, lifecycle, access scope, revisions, temporal validity, and indexes.
2. **Small generated boot projection** containing only the current objective, relevant active decisions/constraints, open risks, owned task, and deeper-memory references.
3. **Progressive retrieval** over typed memory using exact filters, lexical search, embeddings, graph/relationship expansion, temporal rules, and evidence-aware reranking.
4. **Agent-readable files as a first-class retrieval surface**, because coding agents are strong at searching files, following manifests, and opening evidence selectively. These files are generated projections or bounded artifacts, not the source of truth.
5. **Different persistence semantics for different memory classes**. A verified project invariant should not “decay” like an anecdotal experience; session scratch should expire; decisions should be superseded rather than rewritten; procedures should be promoted only from verified successful evidence.
6. **Governed write pipeline**. Agents propose candidates; validation, redaction, deduplication, contradiction checks, and policy determine whether a candidate becomes active canonical memory.

The current collaboration documents already chose most of the correct principles: layered memory, explicit provenance, role-local guidance, progressive disclosure, and supersession. What is still missing is a concrete retrieval model, a stricter schema, per-kind persistence rules, a production/file layout, write-path controls, compaction mechanics, and a memory-specific evaluation harness.

## Direct answer to the Markdown question

### Is a large flat `docs/` folder good memory?

No. It is acceptable for a small repository’s human documentation, but it degrades as agent memory because:

- every document appears equally authoritative;
- agents cannot cheaply distinguish current decisions from obsolete drafts;
- semantic duplicates and contradictions accumulate;
- file names do not encode provenance, temporal validity, task scope, or access policy;
- summaries become stale while the underlying evidence changes;
- loading many documents wastes context and increases prompt-injection exposure;
- multiple writers create merge conflicts and accidental truth promotion;
- search returns text similarity, not necessarily the current or authorized answer.

The existing `docs/` directory is already mixing architecture drafts, manager decisions, protocol specifications, acceptance reviews, research reviews, evaluation plans, operations, and release documentation at one level. That is manageable at the current size, but it should be reorganized for human navigation independently of runtime memory.

### Should files be split into folders and ranked?

Yes for navigation and retrieval, but **folder depth and filename prefixes are not enough**.

Use folders to separate artifact purpose and lifecycle. Use machine-readable metadata and generated manifests to express rank. Numeric file prefixes such as `00_`, `10_`, and `90_` may help humans establish a stable reading order, but they must not be the only ranking mechanism because priority varies by task, role, time, scope, and authority.

A task about session credentials should rank an active security constraint above a broadly important architecture overview. A reviewer should retrieve known fragile boundaries and required tests; an implementer should retrieve procedures and local gotchas. One global file order cannot serve all contexts.

### Are Markdown files still useful?

Yes. Recent LongMemEval-V2 work found that a coding-agent memory system operating over trajectory files, manifests, workflow documents, and helper tooling achieved higher average accuracy than the paper’s strongest RAG baseline. This is evidence that file-based memory is a strong **controller interface**, not evidence that an unstructured Markdown pile is sufficient.

PiLink should therefore combine:

- structured authoritative records;
- generated Markdown summaries and atomic evidence files;
- a JSON manifest/index for deterministic filtering;
- normal repository search tools for agent exploration;
- dedicated memory query tools for bounded, provenance-aware retrieval.

## Current repository assessment

### What is already correct

The current design documents correctly establish that:

- chat and raw conversation history are not canonical memory;
- task state and repository evidence outrank memory;
- shared canonical memory and role-local memory are distinct;
- session scratch is ephemeral;
- memory needs candidate, active, disputed, superseded, retracted, and archived states;
- provenance and evidence references are required;
- contradictions should create relationships rather than silent overwrite;
- boot context should be bounded and progressively disclose deeper entries;
- memory promotion should not happen after every discovery;
- natural-language memory never grants authorization;
- memory is a later phase after task/session/activity durability.

These are strong foundations and should be retained.

### Important gaps

The proposed schema and policy do not yet specify:

1. **Persistence semantics by memory kind.** Facts, decisions, experiences, procedures, risks, and open questions should not share one generic expiry/decay policy.
2. **Authority/epistemic status.** `confidence` is not enough. The system must distinguish deterministic state, user/manager decision, externally verified fact, reviewer-accepted procedure, agent inference, and unverified report.
3. **Fine-grained scope.** `shared | role` is too coarse. Retrieval and governance also need task, component/path, workspace, session, actor/principal, confidentiality, and project-wide scopes.
4. **Evidence snapshots.** A path or commit alone may later change. Evidence references need a commit/hash/revision and preferably bounded locations or artifact digests.
5. **Retrieval strategy.** “Prefer active/current” does not specify candidate generation, hybrid ranking, temporal queries, contradiction inclusion, diversity, token budgets, or abstention behavior.
6. **Compaction and consolidation.** There is no rule for transforming activity/trajectories into semantic decisions or reusable procedures without losing provenance.
7. **Write ownership.** The design says promotion is governed, but not which writes are automatic, which require review, and which are prohibited for each class.
8. **Deletion and active forgetting.** Retraction, legal/user deletion, secret discovery, and index/cache removal need explicit semantics.
9. **Memory poisoning controls.** Memory content is labeled untrusted, but the write gate and retrieval rendering need stronger information-flow controls.
10. **Evaluation.** Existing collaboration scenarios include four memory tests, but do not measure evidence recall, temporal correctness, contradiction resolution, deletion, leakage, retrieval latency, or downstream task benefit.
11. **Document taxonomy.** The human `docs/` directory has no landing index, lifecycle labels are inconsistent, and current/draft/superseded documents can be retrieved together.

## SOTA synthesis through 2026-08-01

No single memory technique dominates every agent workload. EvoMemBench reports that long-context baselines remain competitive, retrieval systems are strong for knowledge-heavy tasks, and procedural/long-term systems help execution tasks when stored experience matches the task structure. PiLink should therefore use a modular memory architecture and evaluate ablations rather than select one fashionable mechanism.

### 1. Hierarchical and progressive memory

MemGPT introduced virtual context management: keep a small working/core memory in context and move information between fast and slow tiers. Current OpenAI Agents SDK documentation similarly distinguishes conversational session history from distilled agent memory, injects a compact summary first, then lets the agent search an index and open deeper rollout summaries. It also supports different memory layouts so agents can share or isolate memory intentionally.

**PiLink implication:** boot context must be a bounded projection, not a dump. Every deeper entry should be retrievable by ID/query and should preserve provenance.

### 2. Typed episodic, semantic, and procedural memory

CoALA organizes language-agent memory into modular classes. LongMemEval-V2 reframes useful experience as static state, dynamic state transitions, workflow knowledge, environment gotchas, and premise awareness. Agent Workflow Memory and Voyager show that reusable workflows/skills can improve future execution. Recent procedural-memory evaluation finds that reusable skills can transfer, but some overfit to a role, task, or model.

**PiLink implication:** do not use one generic `lesson` bucket. Store observations/events, current knowledge, procedures/skills, gotchas, and assumptions separately, and evaluate transfer before broad promotion.

### 3. Structured atomic notes and links

A-MEM uses a Zettelkasten-inspired approach: new memories are stored as structured notes with context, keywords, tags, and dynamic links; later memories can update the representation of earlier ones.

**PiLink implication:** atomic entries with typed links are superior to rewriting long summaries. Relationships such as `supports`, `contradicts`, `supersedes`, `derived_from`, `applies_to`, `failed_under`, and `validated_by` should be explicit.

### 4. Extraction, consolidation, and selective retrieval

Mem0 separates memory extraction, consolidation, and retrieval. LightMem moves expensive consolidation offline and uses bounded online retrieval with coarse search followed by consistency reranking. OpenAI’s sandbox memory pipeline similarly separates per-run extraction from later consolidation into an index and summary.

**PiLink implication:** task execution must not synchronously run an unbounded memory-reflection pipeline. Capture candidates/events cheaply, then consolidate at safe lifecycle boundaries or offline/maintenance time. The online path needs fixed budgets.

### 5. Temporal and relational memory

Zep/Graphiti uses a temporal knowledge graph to preserve changing relationships and historical state. LongMemEval and EverMemBench show that temporal reasoning and knowledge updates remain difficult, and timestamp similarity alone is insufficient.

**PiLink implication:** every entry needs observation time and validity time. The system should distinguish “recorded at,” “true from,” and “true until,” and retrieval should resolve the active version for the requested time while retaining history.

### 6. File-based agent memory

LongMemEval-V2’s AgentRunbook-C stores trajectories as files and uses a coding-agent harness with manifests, workflow documents, rendered artifacts, and helper scripts to gather compact evidence. It reached 72.5% average accuracy versus 48.5% for the strongest RAG baseline reported in that work, at higher latency.

**PiLink implication:** file search is a powerful retrieval mode for coding agents, especially for procedural and environment-specific evidence. The design should expose a structured file projection with manifests rather than hiding all memory behind embeddings. Retrieval mode can be selected by budget: fast hybrid query first; file-agent investigation for high-risk or ambiguous questions.

### 7. Governed shared memory

Governed Shared Memory identifies unauthorized leakage, stale propagation, contradiction persistence, and provenance collapse as distinct system failures and proposes scoped retrieval, temporal supersession, provenance tracking, and policy-governed propagation. GateMem reports that shared-memory systems still struggle to jointly deliver utility, access control, and reliable forgetting.

**PiLink implication:** retrieval authorization and write authorization must be enforced on every access path, including direct lookup by ID. Shared memory cannot be a globally readable vector collection with filtering added only after search.

### 8. Persistent prompt-injection risk

The Misattribution Gap describes how policy-formatted untrusted text can enter memory and later be rendered as trusted context after provenance is lost. Bad Memory and cross-session stored-prompt-injection work show that malicious content already planted in persistent memory can influence future sessions.

**PiLink implication:** memory must be rendered in a clearly delimited data channel with source and trust labels. Untrusted text cannot be transformed into policy/instructions. Candidate writes derived from untrusted content require provenance-preserving taint, and promotion must not erase it.

## Recommended memory taxonomy

PiLink should separate **state**, **history**, **knowledge**, **experience**, and **skills**.

### A. Working/session memory

Purpose: immediate continuity for one collaboration session.

Examples:

- current hypothesis;
- temporary exploration notes;
- pending local comparison;
- short-lived cursor or draft outline.

Policy:

- session-scoped;
- TTL/size bounded;
- never canonical automatically;
- wiped or compacted at session end;
- never used as review independence evidence;
- not stored in Git by default.

### B. Episodic memory

Purpose: immutable record of what happened.

Canonical source: typed activity ledger and task lifecycle events.

Examples:

- task claimed;
- test failed;
- design finding posted;
- commit produced;
- review requested changes;
- user accepted option B.

Policy:

- append-only;
- server timestamps and authenticated writer context;
- event/task/correlation IDs;
- no semantic rewriting;
- compact projections may be generated, but raw events remain evidence.

### C. Semantic/project knowledge

Purpose: current propositions agents may rely on within a defined scope.

Kinds:

- accepted decision;
- active constraint/invariant;
- verified fact;
- architecture/component model;
- accepted risk;
- project-specific gotcha;
- open question/uncertainty.

Policy:

- explicit epistemic authority;
- validity interval and supersession;
- evidence links;
- canonical promotion rules;
- no Ebbinghaus-style decay for still-valid facts/decisions;
- stale detection when evidence revisions change.

### D. Procedural memory

Purpose: reusable methods for performing work.

Kinds:

- verified runbook;
- test/checklist;
- debugging procedure;
- integration sequence;
- reusable tool workflow;
- known failure-and-recovery pattern.

Policy:

- extracted from one or more trajectories;
- must record success/failure evidence and applicability conditions;
- role/component/model/tool-version scope;
- promotion requires executable verification or repeated success;
- procedures that stop transferring are downgraded, revised, or specialized;
- procedures never grant authorization.

### E. Task handoff memory

Purpose: compact continuity for one task across owners/sessions.

Contents:

- accepted goal and scope;
- current state and exact revision;
- completed evidence;
- unresolved blocker;
- next action;
- changed paths/artifacts;
- risks and assumptions.

Policy:

- derived from authoritative task/activity state where possible;
- bounded and revisioned;
- terminal handoff becomes archived evidence, not permanent boot context.

### F. Role-local memory

Purpose: continuity for future occupants of a workflow role.

Examples:

- reviewer checklist for this project;
- researcher source-quality lessons;
- manager sequencing patterns;
- implementer component gotchas.

Policy:

- advisory;
- never silently promoted to shared project truth;
- can be scoped further by component/tool/model;
- retrieval only when role and task match;
- stale/disputed labels visible.

### G. User/project preferences

Purpose: explicit stable preferences that alter workflow or output.

Policy:

- only explicit user statements or validated project policy;
- separate from inferred preferences;
- editable/deletable;
- not mixed with technical facts;
- access-controlled where needed.

## Production storage model

### Authoritative store

Use a structured database or append-only log plus materialized projections under PiLink’s private data directory, outside the repository workspace. A first implementation can use SQLite or the existing atomic JSON pattern at small scale, but the public API should be backend-neutral.

Recommended logical records:

- `memory_entries` — immutable revisions/content;
- `memory_relations` — supports/contradicts/supersedes/derived/applies links;
- `memory_evidence` — typed references with hashes/revisions;
- `memory_acl` — project/role/task/principal visibility and write policy;
- `memory_events` — proposal, validation, promotion, dispute, supersession, retraction, deletion;
- `memory_embeddings` — rebuildable non-authoritative index;
- `memory_lexical_index` — rebuildable non-authoritative index;
- `memory_boot_snapshots` — generated, versioned projections;
- `memory_query_audit` — bounded metadata for governance/evaluation, excluding secret query text by default.

Indexes and generated summaries are caches. They must be rebuildable from canonical entries/events.

### Recommended entry schema

```ts
interface MemoryEntry {
  schemaVersion: 1;
  memoryId: string;
  revision: number;
  projectId: string;

  namespace:
    | "semantic"
    | "procedural"
    | "role"
    | "task_handoff"
    | "preference";
  kind:
    | "decision"
    | "constraint"
    | "verified_fact"
    | "architecture"
    | "risk"
    | "gotcha"
    | "open_question"
    | "procedure"
    | "checklist"
    | "lesson"
    | "preference";

  statement: string;
  structuredPayload?: Record<string, unknown>;
  subjectKeys: string[];
  tags: string[];

  lifecycle:
    | "candidate"
    | "active"
    | "disputed"
    | "superseded"
    | "retracted"
    | "expired"
    | "archived"
    | "deleted";

  epistemicStatus:
    | "server_derived"
    | "user_decided"
    | "manager_accepted"
    | "reviewer_verified"
    | "externally_verified"
    | "agent_observed"
    | "agent_inferred"
    | "unverified_report";
  confidence?: number; // calibrated 0..1 where meaningful

  scope: {
    visibility: "project" | "role" | "task" | "session" | "principal";
    roleIds?: string[];
    taskIds?: string[];
    collaborationSessionIds?: string[];
    principalIds?: string[];
    components?: string[];
    paths?: string[];
    confidentiality: "normal" | "restricted";
  };

  provenance: {
    writtenByAgentId: string;
    writtenByCollaborationSessionId?: string;
    writtenByRoleId?: string;
    sourceEventIds: string[];
    evidenceRefs: EvidenceRef[];
    derivedFromMemoryIds: string[];
    trustLabels: string[];
  };

  recordedAt: string;
  observedAt?: string;
  validFrom?: string;
  validUntil?: string;
  reviewAfter?: string;
  supersedesMemoryIds: string[];
  contradictedByMemoryIds: string[];
  contentHash: string;
}
```

`confidence` must never replace `epistemicStatus`. A confident inference is not equivalent to a user decision or server-derived state.

### Evidence references

Evidence should be typed and revision-bound:

```ts
type EvidenceRef =
  | { type: "task"; taskId: string; revision: number }
  | { type: "activity"; eventId: string; cursor: number }
  | { type: "commit"; commit: string; path?: string; lineRange?: [number, number] }
  | { type: "file"; path: string; contentHash: string; lineRange?: [number, number] }
  | { type: "test"; artifactUri: string; commandDigest?: string; resultDigest: string }
  | { type: "external"; uri: string; retrievedAt: string; contentDigest?: string };
```

The system must not copy full secret-bearing tool output into memory merely to preserve evidence.

## File and directory architecture

### Human-authored repository documentation

Reorganize `docs/` by purpose, not by memory class:

```text
docs/
├── README.md                         # navigation and authority map
├── architecture/
│   ├── collaboration-system.md
│   └── memory-system.md
├── protocols/
│   ├── autonomous-pull.md
│   └── role-contracts.md
├── decisions/
│   ├── ADR-0001-activity-ledger.md
│   └── ADR-0002-governed-memory.md
├── research/
│   ├── collaboration-review.md
│   └── agent-memory-review.md
├── reviews/
│   └── session-activity-acceptance.md
├── evaluation/
│   └── collaboration-plan.md
├── operations/
│   └── releasing.md
├── drafts/                           # explicitly non-authoritative
└── generated/                        # do not hand-edit
    ├── PROJECT_MEMORY.md
    └── PROJECT_STATUS.md
```

Do not perform this move while other agents own overlapping docs without a dedicated migration task. First add an index that labels every existing file as current specification, decision, research, review, draft, generated view, or operations guide.

### Runtime memory file projection

In production, generate a file projection in the private project data area, not as the canonical Git state:

```text
<pi-data>/projects/<project-id>/memory-files/
├── BOOT.md
├── MANIFEST.json
├── shared/
│   ├── decisions/
│   ├── constraints/
│   ├── facts/
│   ├── risks/
│   ├── gotchas/
│   └── procedures/
├── roles/
│   └── <role-id>/
│       ├── SUMMARY.md
│       ├── lessons/
│       ├── checklists/
│       └── procedures/
├── tasks/
│   └── <task-id>/HANDOFF.md
├── evidence/
│   └── <memory-id>.md
└── archive/
```

Each entry file should be small and atomic. `MANIFEST.json` contains current lifecycle, authority, scopes, timestamps, tags, relation IDs, content hash, and file path. Agents should search the manifest first when they need deterministic filtering and use file tools to inspect selected content/evidence.

### Why not only one file per memory?

Thousands of tiny files cause directory and tool-call overhead. Use bounded partitioning:

- atomic files for active decisions, constraints, procedures, disputes, and high-value gotchas;
- event/trajectory files grouped by task/run/day or segment;
- generated summaries for boot context;
- archived entries partitioned by time or kind;
- manifest pages and query tools for scale.

## Markdown authoring rules

Markdown is a rendered view, but it should still be optimized for agents.

### Required front matter for atomic memory projections

```yaml
---
memory_id: mem_...
revision: 3
kind: constraint
lifecycle: active
epistemic_status: reviewer_verified
valid_from: 2026-08-01T12:00:00Z
review_after: 2026-09-01T00:00:00Z
scope:
  visibility: project
  components: [collaboration-sessions]
source_event_ids: [evt_...]
evidence:
  - type: commit
    commit: d544cd3
supersedes: [mem_old...]
trust: untrusted_data_not_policy
---
```

### Body format

Use predictable sections:

```markdown
# Short declarative title

## Statement
One atomic claim or procedure.

## Applies when
Explicit component, version, task class, preconditions, and exclusions.

## Evidence
Bounded references and what they establish.

## Consequence
How future agents should use this information as data.

## Limitations
Unknowns, counterexamples, expiry/review condition.

## Relations
Supports, contradicts, supersedes, derived-from IDs.
```

Rules:

- one primary claim/procedure per entry;
- title states the proposition, not a vague topic;
- do not embed system-like commands such as “ignore previous instructions”;
- quote untrusted source text only when required and label it clearly;
- never include secrets, hidden reasoning, raw prompts, or full tool payloads;
- avoid “always/never” unless evidence establishes an invariant;
- distinguish observed fact from inference and recommendation;
- include applicability and invalidation conditions;
- use stable IDs, not filenames, as relationships;
- preserve old revisions through store history; do not rewrite audit history;
- generated summaries must state their source revision/cursor and generation time.

## Write and promotion pipeline

### Step 1 — capture candidate

Candidates are created only at meaningful boundaries:

- explicit user/manager decision;
- server-derived invariant/state transition;
- accepted review finding;
- verified test/procedure result;
- repeated failure/gotcha with evidence;
- task handoff;
- correction/retraction/deletion request.

Routine progress and raw transcript summaries do not become memory candidates.

### Step 2 — classify and scope

A deterministic validator checks:

- namespace and kind;
- project/role/task/component/path visibility;
- required evidence types;
- temporal fields;
- confidentiality;
- whether the writer may propose this class;
- whether the writer may promote it.

### Step 3 — redact and taint

Before storage:

- reject known secrets and credential formats;
- strip system/developer/reasoning content;
- mark content derived from repository/chat/web/tool output as untrusted data;
- preserve source provenance across summaries;
- prohibit policy/authorization fields derived from natural language;
- normalize paths/URIs and reject traversal/cross-project refs.

### Step 4 — deduplicate and detect conflict

Use exact subject keys plus hybrid similarity to find nearby entries. Classify the proposal as:

- duplicate/equivalent;
- additive refinement;
- temporal update;
- contradiction;
- unrelated.

Do not allow a near-duplicate gate to discard a contradictory write before contradiction analysis. Contradictions should be admitted as candidates and linked for resolution.

### Step 5 — promotion

Recommended policy:

- `server_derived`: automatic active entry when derivation is deterministic and schema-bound;
- explicit user decision/preference: active after authenticated capture and confirmation semantics;
- architecture decision: manager/owner acceptance;
- security/high-risk constraint or procedure: independent reviewer acceptance;
- verified fact: evidence policy appropriate to source;
- gotcha/lesson: candidate until reproduced or corroborated;
- procedure: candidate until executable verification/repeated success;
- agent inference: never canonical merely because an LLM judge agrees.

### Step 6 — append and project

Append immutable memory event/revision, update materialized current state atomically, then rebuild affected lexical/vector/graph indexes and file projections through an outbox/retry mechanism. The canonical write must not depend on successful embedding generation.

### Step 7 — consolidation

At safe boundaries, a consolidation job may:

- summarize recent episodic evidence;
- propose semantic entries;
- induce procedural skills/runbooks;
- merge equivalent candidates;
- specialize overbroad procedures;
- mark stale entries for review.

Consolidation outputs are proposals with source links, not automatic truth.

## Retrieval architecture

### Query intent

The caller supplies structured trusted context:

- project ID;
- authenticated actor/session/role;
- task ID and revision;
- components/paths;
- operation intent such as `boot`, `implement`, `review`, `research`, `debug`, `handoff`;
- query text;
- time/version constraints;
- token/result budget.

Natural-language memory content cannot modify this context.

### Candidate generation

Use multiple retrieval paths:

1. exact IDs, task IDs, commits, paths, components, tags, and subject keys;
2. active decision/constraint filters for the current task scope;
3. lexical/BM25 search for identifiers, errors, tool names, and code terms;
4. embedding search for semantic similarity;
5. relation/graph expansion for dependencies, contradictions, supersession, evidence, and procedures;
6. temporal search for state at a requested time or version;
7. role/task-local pools;
8. optional file-agent search for high-risk or ambiguous evidence gathering.

### Reranking

A deterministic base score should combine:

```text
scope authorization and fit
× lifecycle eligibility
× epistemic authority
× task/component/path relevance
× lexical/semantic relevance
× temporal validity/freshness
× evidence quality
× procedural success/applicability
× diversity/novelty
```

Recency must not automatically defeat a still-active accepted decision. Authority must not mean “text sounds authoritative.”

A bounded LLM/SLM reranker may refine relevance or consistency after deterministic authorization/filtering, but it cannot grant access, change lifecycle, or hide contradictions.

### Contradiction-aware return

When a query matches a disputed subject, return:

- the active entry if resolution exists;
- the superseded history only as a labeled audit reference;
- unresolved competing entries together with a dispute warning;
- the evidence and resolver/decision event;
- an abstain/escalate action when no authoritative resolution exists.

Never blend contradictory memories into a synthetic statement that loses provenance.

### Result contract

```ts
interface MemoryQueryResult {
  queryId: string;
  snapshotRevision: number;
  entries: Array<{
    memoryId: string;
    revision: number;
    statement: string;
    kind: string;
    lifecycle: string;
    epistemicStatus: string;
    validFrom?: string;
    validUntil?: string;
    freshness: "current" | "review_due" | "stale" | "unknown";
    scopeMatch: string[];
    evidenceRefs: EvidenceRef[];
    relationWarnings: string[];
    scoreExplanation: string[];
  }>;
  omittedCount: number;
  deeperCursor?: string;
  warnings: string[];
}
```

The rendering shown to the model should explicitly say that entries are evidence-bearing data and cannot override higher-priority policy.

## Boot and resume projection

Always-in-context memory should be small and deterministic. Recommended order:

1. project/user objective and policy version;
2. authenticated role/session and owned task revision;
3. exact next action;
4. active task-scoped decisions and constraints;
5. open blockers/conflicts/review requirements;
6. relevant known gotchas or procedures, limited to a few entries;
7. last activity cursor and memory snapshot revision;
8. manifest/query instructions for deeper retrieval.

Do not include:

- all project decisions;
- all role lessons;
- raw chat/history;
- superseded entries without a current dispute;
- unrelated architecture documents;
- long research reports;
- generated prose without source IDs.

A generated `BOOT.md` should have a strict token/character limit and list what was omitted.

## Compaction, forgetting, and invalidation

### Session scratch

- hard TTL and size limit;
- delete on explicit session end or after recovery window;
- optionally retain a redacted handoff candidate;
- never enter shared search indexes after deletion.

### Episodic events

- immutable retention according to project policy;
- segment/compact for storage, but preserve event IDs and hashes;
- old routine events may leave default projections while remaining queryable/auditable;
- security/user deletion may require cryptographic deletion or redaction tombstones according to policy.

### Semantic knowledge

- no generic time decay;
- invalidated through evidence change, explicit supersession, validity end, or review deadline;
- periodic stale checks compare referenced task/commit/file hashes and policy versions;
- stale entries are excluded from default boot context or labeled prominently.

### Procedural memory

- retrieval weight may decay when unused, repeatedly fails, or becomes version-incompatible;
- successful use reinforces applicability statistics;
- failed use records counterevidence;
- do not delete the old procedure silently; specialize or supersede it;
- broad promotion requires cross-task/model/component transfer evidence where relevant.

### Preferences and deletion

- explicit delete/forget requests must remove active projections and all retrieval indexes;
- retain only the minimum tombstone needed to prevent resurrection, when policy permits;
- test direct-ID lookup, caches, embeddings, file projections, summaries, and backups;
- never claim forgetting when only the visible Markdown file was removed.

## Multi-agent memory isolation

Recommended default visibility:

- shared canonical decisions/constraints: all authorized project roles, read-only to most roles;
- role-local memory: only matching role plus manager/reviewer policy as configured;
- task handoff: task participants, manager, assigned reviewer/integrator;
- session scratch: owning collaboration session only;
- restricted principal/user data: explicit principal ACL;
- security findings: restricted until disclosure policy allows broader visibility.

Shared memory should be attached by authenticated policy, not by matching role names in prompts. Every direct retrieval path must enforce the same scope rules as search.

## Prompt-injection and poisoning controls

Minimum defenses:

1. Treat all memory text as untrusted data, including agent-authored summaries.
2. Separate instruction/policy fields from content fields in the model prompt.
3. Render source, writer, scope, lifecycle, and trust label before content.
4. Preserve taint/provenance through summarization and consolidation.
5. Reject candidates whose primary purpose is to change authorization, tool policy, role, or instruction precedence through natural language.
6. Do not promote policy-formatted repository/web/chat content into canonical memory without authenticated decision semantics.
7. Scan for secrets and stored-prompt-injection patterns, but do not rely on classifiers alone.
8. Require evidence and appropriate independent review for high-impact procedures.
9. Use counterfactual retrieval tests: rerun without suspect memory and compare behavior.
10. Audit which memory IDs were supplied to each high-risk action without storing hidden reasoning.
11. Ensure deleted/restricted entries cannot be retrieved by direct ID, graph traversal, stale cache, or file path.
12. Never allow a memory entry to invoke tools directly; the agent must make a new policy-checked action.

## Proposed tools and resources

### Read/query

- `agent_memory_boot_read`
- `agent_memory_query`
- `agent_memory_get`
- `agent_memory_history_read`
- `agent_memory_evidence_read`
- `agent_memory_manifest_read`

### Write/governance

- `agent_memory_propose`
- `agent_memory_review_candidate`
- `agent_memory_promote`
- `agent_memory_dispute`
- `agent_memory_supersede`
- `agent_memory_retract`
- `agent_memory_delete`

### Maintenance/evaluation

- `agent_memory_rebuild_indexes`
- `agent_memory_validate_provenance`
- `agent_memory_stale_scan`
- `agent_memory_export`
- `agent_memory_eval_run`

Server-derived task/activity transitions should propose deterministic handoff/fact candidates without asking agents to duplicate lifecycle text manually.

## Ranked implementation plan

### P0 — documentation and evaluation before memory runtime

1. Add a `docs/README.md` authority/navigation map without moving files yet.
2. Mark each current document as `current specification`, `decision`, `research`, `review`, `draft`, `generated`, or `operations`.
3. Freeze the memory taxonomy and entry schema.
4. Add memory scenarios to the collaboration evaluation plan.
5. Define retrieval result and evidence contracts.
6. Keep runtime memory deferred until session/task/activity integration is stable.

### P1 — read-only memory projections

1. Build deterministic projections from authoritative task/activity/accepted-decision test fixtures.
2. Generate bounded `BOOT.md`, `MANIFEST.json`, task handoffs, and active decision/constraint files.
3. Add exact/lexical filtering first.
4. Measure cold-start recovery, tokens, latency, and stale-result rate.
5. Do not allow agent-generated canonical writes yet.

### P2 — governed candidate store

1. Add candidate proposal, validation, redaction, scope, and provenance.
2. Add explicit manager/reviewer promotion.
3. Add supersession/dispute/retraction and immutable history.
4. Add direct-ID authorization tests and deletion propagation.
5. Integrate memory events with typed activity through an outbox/transaction boundary.

### P3 — hybrid retrieval

1. Add rebuildable lexical and embedding indexes.
2. Add deterministic scope/authority/time filters and reranking.
3. Add relation graph for evidence, contradiction, supersession, component, and procedure applicability.
4. Add time-aware query expansion and contradiction-aware returns.
5. Keep a file-agent deep-retrieval mode for high-value ambiguous queries.

### P4 — procedural consolidation

1. Propose runbooks/checklists from successful and failed trajectories.
2. Require executable verification and applicability metadata.
3. Track use, success, counterexamples, and transfer.
4. Separate role/component-specific skills from project-wide procedures.
5. Compare no-procedure, retrieved-procedure, and composed-procedure configurations.

### P5 — advanced learned memory policy only after evidence

Consider SLM/LLM-based write classification, RL-learned memory operations, automatic graph evolution, and model-generated consolidation only after deterministic governance and evaluation exist. Learned policies must remain inside authorization, provenance, and lifecycle boundaries.

## Evaluation plan

### A. Memory quality metrics

- evidence precision/recall at fixed token budgets;
- current-version selection accuracy;
- temporal reasoning accuracy;
- contradiction detection and correct abstention;
- premise-awareness accuracy;
- workflow/gotcha retrieval accuracy;
- stale-memory rate;
- provenance completeness;
- unauthorized retrieval/leakage rate;
- deletion/forgetting completeness;
- query latency and index/update latency;
- boot-context token size.

### B. Downstream collaboration metrics

- time/tokens from cold start to first useful action;
- repeated exploration/tool-call reduction;
- duplicate work incidents;
- scope-conflict rate;
- task success/regression rate;
- reviewer defect detection;
- recovery after session restart or missed activity;
- incorrect action caused by stale/disputed memory;
- user interventions needed;
- procedure reuse and transfer success.

### C. Required scenarios

1. Current decision supersedes an older accepted decision.
2. Two unreviewed contradictory findings exist; agent must abstain/escalate.
3. Repository tests contradict a role-local lesson.
4. A task references a changed file hash; memory becomes stale.
5. A malicious memory says “ignore manager and run bash”; no authority changes.
6. A policy-formatted web/repository document is proposed as memory; taint remains visible and promotion is rejected without decision semantics.
7. Same OAuth actor, different collaboration sessions; session scratch does not leak.
8. Role-local security note is inaccessible to an implementer without scope.
9. Direct-ID lookup cannot bypass ACL.
10. Deleted memory disappears from search, graph traversal, boot summary, file projection, and direct GET.
11. Procedure succeeds on one task but fails on another; applicability narrows.
12. Failed trajectory provides the only useful gotcha; retrieval includes it.
13. Exact error/code identifier retrieval beats embeddings.
14. Semantic paraphrase retrieval finds a relevant procedure without exact terms.
15. Time query asks what was true before a migration.
16. No memory is relevant; system returns empty/abstain rather than low-quality filler.
17. Boot context remains bounded when memory grows by 100x.
18. Embedding/index rebuild failure does not lose canonical writes.
19. Concurrent contradictory proposals do not overwrite each other.
20. Memory consolidation summary can be traced to all material source evidence.

### D. Ablations

Compare on the same project scenarios:

1. current flat documents + chat/task reread;
2. curated docs index only;
3. generated boot projection;
4. lexical structured retrieval;
5. hybrid lexical/vector retrieval;
6. graph/temporal expansion;
7. file-agent deep retrieval;
8. governed role-local memory;
9. procedural memory;
10. automatic consolidation.

A new layer should ship only if it improves task outcomes or recovery without unacceptable latency, leakage, stale errors, or coordination overhead.

## Accepted manager decisions

1. Use **structured store + generated file projection** as the target, rather than Markdown-as-database.
2. Use the expanded taxonomy: session, episodic, semantic, procedural, task handoff, role-local, preference.
3. Make `epistemicStatus`, temporal validity, scope/ACL, evidence hashes/revisions, and relation types mandatory.
4. Separate automatic server-derived memory from agent-proposed memory.
5. Keep canonical promotion explicit and risk-adaptive; no LLM-judge auto-promotion.
6. Add a documentation authority index before reorganizing `docs/`.
7. Add memory-specific poisoning, leakage, forgetting, contradiction, and temporal tests to the evaluation program.
8. Treat file-agent retrieval as an optional high-accuracy mode and hybrid indexed retrieval as the default low-latency mode.
9. Delay procedural/learned memory until the task/activity/session foundation and baseline evaluation are stable.

## Recommended immediate manager backlog items

### Task 1 — documentation authority map

Create `docs/README.md` listing every document, purpose, lifecycle/authority, owner, current revision, superseded-by link, and recommended reading order. Do not move files during active overlapping work.

### Task 2 — memory ADR and schema

Convert the accepted portions of this review into a manager-owned ADR defining taxonomy, schema, promotion rules, persistence semantics, retrieval contract, and security boundary.

### Task 3 — memory evaluation extension

Extend `COLLABORATION_EVALUATION_PLAN.md` with the scenarios and metrics above before any runtime memory implementation.

### Task 4 — read-only projection spike

After activity/task integration is stable, implement a read-only generator for `BOOT.md`, `MANIFEST.json`, current decisions/constraints, and task handoff views from test fixtures. No LLM-generated canonical writes.

## Primary references

- OpenAI Agents SDK, agent memory and separate layouts: https://openai.github.io/openai-agents-python/sandbox/memory/
- OpenAI Agents SDK, sessions and bounded history: https://openai.github.io/openai-agents-python/sessions/
- MemGPT, hierarchical virtual context management: https://arxiv.org/abs/2310.08560
- CoALA, modular cognitive memory architecture: https://arxiv.org/abs/2309.02427
- Generative Agents, observation/reflection/planning and memory retrieval: https://arxiv.org/abs/2304.03442
- Reflexion, reflective episodic memory: https://arxiv.org/abs/2303.11366
- MemoryBank, importance/recency-inspired forgetting: https://arxiv.org/abs/2305.10250
- Voyager, executable procedural skill library: https://arxiv.org/abs/2305.16291
- Agent Workflow Memory, reusable induced workflows: https://arxiv.org/abs/2409.07429
- LongMemEval, indexing/retrieval/reading and temporal update evaluation: https://arxiv.org/abs/2410.10813
- Zep/Graphiti, temporal knowledge graph memory: https://arxiv.org/abs/2501.13956
- A-MEM, structured linked atomic notes: https://arxiv.org/abs/2502.12110
- Mem0, extraction/consolidation/retrieval and graph variant: https://arxiv.org/abs/2504.19413
- Memory for Autonomous LLM Agents survey: https://arxiv.org/abs/2603.07670
- LightMem, bounded online retrieval and offline consolidation: https://arxiv.org/abs/2604.07798
- LongMemEval-V2 and AgentRunbook file/controller memory: https://arxiv.org/abs/2605.12493
- EvoMemBench, no universally dominant memory method: https://arxiv.org/abs/2605.18421
- The Misattribution Gap, provenance loss and memory poisoning: https://arxiv.org/abs/2605.22842
- GateMem, shared-memory utility/access-control/forgetting benchmark: https://arxiv.org/abs/2606.18829
- Managing Procedural Memory / AFTER benchmark: https://arxiv.org/abs/2606.23127
- Governed Shared Memory for Multi-Agent LLM Systems: https://arxiv.org/abs/2606.24535
- Bad Memory, prompt-injection risks from persistent memory: https://arxiv.org/abs/2607.14611
- Cross-session stored prompt injection: https://arxiv.org/abs/2606.04425

## Final recommendation

PiLink should treat memory as a **governed evidence system**, not as a folder of prose. The best near-term design is deliberately conservative: durable activity and task state remain authoritative; accepted decisions, constraints, handoffs, and verified procedures become typed projections; agents receive a small boot view and retrieve deeper evidence progressively; files remain searchable and useful, but structured metadata, provenance, scope, temporal semantics, and lifecycle governance determine what those files mean.
