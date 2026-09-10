# PiLink Review

**Baseline:** `61485f2ac1f3aca34c8ac53d3d9d7f3a758398ca`
**Completed:** 2026-09-10, approximately 13:52 UTC+02:00; inspection began approximately 09:25, within the requested five-hour wall-clock limit.
**Scope:** Read-only review of the three launch experiences, shared runtime/configuration, gateway, collaboration, CLI, VS Code companion, release packaging, and validation evidence.
**Evidence:** specialist reports, QA probes, and test results under `/tmp/pilink-inspection`. This report is the only project-file addition; no product code was changed.
**Sizing:** S = localized change; M = cross-module change; L = architectural work. These are relative sizes, not delivery commitments.

## Executive decision

PiLink has a credible security and product foundation, but it is **not release-ready for an unqualified new deployment or artifact publication**. No P0 was established. The release-blocking issues are concentrated in launch/configuration boundaries and truthful readiness, not in the basic workspace, OAuth, collaboration, or gateway architecture.

Before release, address the six P1 items below: prevent workspace files from broadening privileged launch policy; fail closed on an explicitly invalid workspace; make argument parsing and help side-effect-free; make `gateway connect` prove that a gateway API actually exists; regenerate/verify the checked-in VSIX; and prevent concurrent gateway processes from overwriting the same durable store. The existing three experiences should remain: **Project bridge** (current Single agent), **Agent team** (current collaboration mode), and **ChatGPT gateway** (current `pilink-endpoint`/gateway). Do not introduce a fourth VS Code product or replace the core persistence architecture speculatively.

The recommended direction is a staged contract: pure parse, inspect effective private configuration and provenance, explain the security/workspace/hosting plan, require an explicit commit, then prove readiness. Reconfiguration must not be confused with destructive reset. The safe defaults, caller-owned gateway tool execution, collaboration identity protections, and narrow VS Code launcher boundary are assets to preserve.

## Feature coverage and disposition

| Experience or shared surface | Covered capability | Review result and release posture |
|---|---|---|
| **Project bridge / Single agent** | Workspace selection and confinement, MCP catalog, read/write/search tools, Git and fixed execution profiles, durable jobs, OAuth/PKCE/scopes, HTTP MCP sessions | Path confinement, client scope enforcement, fixed profiles, durable lifecycle, and OAuth protections are strong. Configuration provenance, invalid-root handling, private-store placement, cancellation propagation, and job byte quotas need work. |
| **Agent team / collaboration** | Chat history, roles and provenance, tasks, leases/locks/dependencies, memory, work loops, supervised local agents, Textual monitor | Server-side identity, leases, task locking, cancellation, and memory governance are strong. The monitor can report healthy while one data source is stale. Local supervised coordination is deliberately separate from canonical collaboration and needs an explicit operator bridge or clearly separated views. |
| **ChatGPT gateway** | CLI start/serve/connect/status, loopback API, OAuth pairing, durable queue, worker polling, replay/recovery, reverse MCP, tool-call boundary, buffered SSE | Queue, claims, recovery, authentication, and caller-owned execution are substantially sound. `connect` can falsely report readiness against an ordinary server; CLI status hides existing worker-state detail; caller idempotency and byte bounds remain design work. |
| **Shared launch/configuration** | `init`, mode selection, `.env` generation, hosting selection, reset, signals, aliases, status/readiness | Compact terminal output, ownership safeguards, explicit unsafe controls, and helper-download protections are good. Workspace dotenv sourcing, invalid-root fallback, mutation-before-help, headless prompts, and reset argument validation are release concerns. |
| **VS Code companion** | Stable-first setup, local health, OAuth pairing, endpoint/start/stop supervision, ownership checks, dashboard | Correctly acts as a launcher/status surface rather than a fourth agent. Source tests and security challenge checks are good. The configured public URL can be presented as healthy after reachability changes, and process failures collapse into “Stopped.” Live extension-host/platform behavior was not tested. |
| **Hosting, installers, release** | Quick/fixed hosting, Caddy/nip.io path, systemd ownership, pinned helper downloads, installers, VSIX | Supply-chain and ownership controls should remain. The checked-in `release/vspilink-2.2.0.vsix` fails the current verifier and is a P1 publication blocker. |
| **Documentation and validation** | Architecture/operations guides, test gates, security scan, build/typecheck/plugin verification | Several delivered features are documented in code but stale labels and prerequisites remain. Validation has real test-contract/tooling failures; the parallel startup timeouts are not six confirmed product outages. |

## What to preserve

1. **Least privilege and explicit boundaries.** Workspace mode canonicalizes existing ancestors and rejects traversal/symlink escapes. Full Access is explicit and client-selectable; it must not become the universal recovery recommendation. Repository execution and Full Access are distinct policies.
2. **Execution safety and lifecycle.** Fixed profiles use bounded output, `shell: false` where intended, Git-hook/diff controls, timeouts, and process-tree cancellation. Durable jobs persist metadata/output, enforce ownership, and support cancellation across process boundaries. Add quotas rather than removing these controls.
3. **OAuth and session protections.** PKCE, owner pairing, short-lived one-use codes, client disable/rotation invalidation, refresh replay handling, session quotas, reconnect handling, and safe error redaction are substantial strengths.
4. **Collaboration authorization.** HMAC-backed session credentials, generation-bound resume, canonical role provenance, optimistic task revisions, leases, deterministic scheduling, and manager-only release semantics should remain release gates.
5. **Gateway execution boundary.** Gateway mode must continue to avoid executing caller-advertised functions. The local harness retains execution authority; strict/capability profiles and the documented OAuth-client-versus-conversation identity distinction must remain explicit.
6. **Gateway durability and observability foundations.** Completion persistence before notification, replay/recovery, claim conflict handling, cancellation, and existing API worker-state projections are valuable. The next step is surfacing them truthfully, not replacing storage without measurements.
7. **VS Code’s narrow role and operational safeguards.** Stable-first setup, authenticated local health, refusal to control externally owned processes, secret redaction, pinned helper downloads, and explicit hosting ownership are the right model.

## Prioritized actionable findings

### P1 — release blockers

#### P1.1 Project-local `.env` files can influence privileged launch policy

**Evidence class:** Manager reproduced. **Severity:** P1 security/configuration integrity. **Effort:** M/L.
**Anchors:** `src/config.ts:65-71`; generated config in `src/cli-core.ts:430-459`; `src/harness.ts:20-32`.

Startup first loads dotenv data from the current working directory, then private configuration, and restores explicitly inherited environment. Generated security controls are commented rather than explicit false values. In the manager fixture, workspace `.env` values for `PI_UNSAFE_FULL_ACCESS`, `PI_FULL_ACCESS_CLIENT_IDS=*`, and `PI_ALLOW_WORKSPACE_EXECUTION` were loaded into effective runtime policy when private values were absent. The manager probe confirmed all three enabled. The workspace is not treated as a denied source for these settings.

This is not an elevation of an already-running process and is not a proven unauthenticated exploit. It is a next-launch integrity risk: a project writable through authorized tools can influence a later privileged launch from that project. **Recommendation:** source privileged PiLink settings only from one explicit private configuration plus deliberate inherited operator variables; reject config/state located within an exposed workspace; display value provenance and effective policy; add a regression proving workspace files cannot broaden next-launch policy. Preserve intentional inherited operator overrides.

#### P1.2 An explicitly selected missing workspace silently becomes another root

**Evidence class:** Manager reproduced. **Severity:** P1 safety/correctness. **Effort:** S/M.
**Anchor:** `src/config.ts:116-124`.

With `PI_WORK_DIR` set to a missing path, `loadRuntimeConfig` returned the current repository directory. This is deterministic wrong-root selection, not traversal escape. A moved or deleted project can therefore expose or modify a different valid current directory under existing authorization.

**Recommendation:** only use the current directory as an onboarding default when `PI_WORK_DIR` is absent. If it is explicitly present but invalid, fail closed, print the selected path, and require deliberate rebind through a named project/instance or `--project` control. Add tests for deleted, malformed, non-directory, and inaccessible roots.

#### P1.3 Parsing, help, and validation can occur after mutation or prompting

**Evidence class:** Manager reproduced plus code-supported CLI findings. **Severity:** P1 safety/automation. **Effort:** M.
**Anchors:** `src/cli.ts:28-48`; `src/llm-gateway-launch.ts:13-39`; `src/cli-core.ts:466-485,1088-1124`.

Gateway dispatch prepares configuration and selects/writes a fallback port before `parseLaunchOptions` handles help. In a fixture with an occupied configured MCP port, `gateway serve --help` exited 1, printed help, and changed the configured port. The same phase-order problem matters for owner pairing, binding, provisioning, and startup. Separately, `reset --yes --typo` is accepted by direct argument handling and can delete state, and non-TTY startup can enter the hosting wizard.

**Recommendation:** implement a pure parse/validate phase before any file write, port selection, bind, remote provisioning, owner pairing, or prompt. `--help`/`-h`/`help` and `--version` must return 0 and be side-effect-free. Unknown reset options must fail before deletion. Non-TTY mode must require explicit hosting or a valid private configuration and return a stable machine-readable error rather than selecting a public default on EOF. Add side-effect assertions around every help/version/invalid-argument path.

#### P1.4 `gateway connect` can claim readiness against an ordinary server

**Evidence class:** Manager reproduced. **Severity:** P1 truthfulness/operability. **Effort:** S/M.
**Anchors:** `src/llm-gateway-connect.ts:16-51,61-88`; `src/cli.ts:68-76`.

Against a real temporary loopback ordinary Single server with `PI_LLM_GATEWAY_ENABLED=false`, paired OAuth, and public DCR disabled, `gateway connect` returned 0, printed “ready,” and gave a local API URL that did not exist. It performed no public authentication, browser, provider, or tunnel action; all fixture values were synthetic.

**Recommendation:** authenticate gateway identity and mode, discover the actual gateway endpoint, verify `/v1/models`, and check DCR eligibility before success. Report worker state separately: pairing must not require an already-polling worker. An ordinary server must return a typed “gateway is not running” error. `connect` should reopen or verify a gateway setup, not infer API readiness from an ordinary pairing route.

#### P1.5 The checked-in release VSIX fails the release verifier

**Evidence class:** Manager reproduced. **Severity:** P1 release integrity. **Effort:** S/M.
**Anchors:** `scripts/verify-release.mjs`; `release/vspilink-2.2.0.vsix`; `scripts/stage-release.mjs:60-67`.

`node scripts/verify-release.mjs` failed because the checked-in VSIX is missing `extension/media/app.js`. It contains legacy `main.js`/`styles.css` and superseded dashboard/readme content, while the current verifier requires the new assets. This proves checkout artifact drift; it does **not** prove that a currently published GitHub/npm release was inspected.

**Recommendation:** generate, stage, and verify the artifact in one release pipeline; regenerate checksums; assert current labels and absence of superseded controls. Either keep only generated verified artifacts or make publication consume the CI artifact rather than a manually copied archive.

#### P1.6 Concurrent gateway processes can overwrite accepted durable jobs

**Evidence class:** Manager reproduced with two independent OS processes; launcher interaction is code-supported. **Severity:** P1 data integrity/recovery. **Effort:** M.
**Anchors:** `src/llm-gateway-store.ts:250-307,820-856,874-895`; `src/llm-gateway-runtime.ts:57-64`; `src/llm-gateway-launch.ts:13-39`.

Both processes activated a store for the same temporary workspace/data directory. Process A successfully enqueued job A, then process B successfully enqueued job B. The resulting durable state contained only B. Each process uses its own cached state and mutation queue; atomic file replacement does not prevent stale snapshots from overwriting each other. The gateway launcher can select another port while retaining the same workspace/data directory, so port fallback is not instance isolation.

**Recommendation:** acquire an exclusive, identity-verified gateway owner before activation or any state mutation; reject or reuse an already-running matching instance. Explicit new instances need separate state. If multi-writer support is truly required, implement transactional reload/update semantics, not merely a write lock around cached snapshots. Regression: simultaneous starts, an already-running instance, crash/restart, and failed binds must preserve all accepted jobs. The reproduction tested the store in two processes, not two live ChatGPT conversations.

### P2 — short wins and product investments

#### P2.1 Generated dotenv values are not round-tripped safely

**Evidence class:** Manager reproduced. **Severity:** P2 configuration correctness. **Effort:** S.
**Anchor:** `src/cli-core.ts:430-441`.

A workspace named `project#feature` was written into dotenv without quoting, and dotenv parsed it as `project`. This can redirect project selection. Use one serializer for all generated path/config values and test spaces, `#`, quotes, `=`, control characters, and Windows backslashes.

#### P2.2 Private stores need a configuration-wide workspace preflight

**Evidence class:** Static/code-supported, reviewed by manager. **Severity:** P2 confidentiality. **Effort:** M.
**Anchors:** `src/config.ts:116-150`; `src/auth.ts:62-99`; `src/harness.ts:71-92`.

`dataDir` and coordination storage are computed without a universal check that they are outside the exposed workspace. OAuth state below `dataDir` could then be reachable through normal workspace reads if an unsafe path is configured. Fail closed when private config/state is inside the workspace, show the conflicting canonical paths, and add an end-to-end denial test. This is separate from dotenv sourcing: it protects the resulting storage layout.

#### P2.3 Effective privileged policy and mode defaults need explicit provenance

**Evidence class:** Manager static reconciliation/design. **Severity:** P2 operator safety. **Effort:** S/M.
**Anchors:** `src/cli-core.ts:2056,2091`; `src/config.ts:74`; `src/harness.ts`.

The confirmation text says full access is for explicitly selected OAuth IDs, while an unsafe flag with no list falls back to `*`; the broad opt-in is documented, so this is not an undocumented bypass. Require concrete IDs or a separate `--all-clients` confirmation with an unmistakable banner. Also retain compatibility with the explicitly tested legacy collaboration default, but show a versioned migration/warning and effective mode instead of claiming every raw launch defaults to Single.

#### P2.4 Gateway status should expose existing readiness facts without printing credentials by default

**Evidence class:** Manager/static specialist reconciliation. **Severity:** P2 operability. **Effort:** S.
**Anchors:** `src/llm-gateway-store.ts:350-382`; `src/llm-gateway-control.ts:49-60`; `src/llm-gateway-connect.ts:61-90`.

The API already knows worker polling, worker contact, processing claims, queue age, and next action, but CLI status hides most of it. The normal connection block also prints the API key. Separate API-ready, worker-listening, processing, and caller-visible readiness; expose `status --json`; make credential export/show explicit and redact by default. A useful state should say, for example, “API ready; worker not listening; next: wake connected ChatGPT conversation,” not simply “ready.”

#### P2.5 The collaboration monitor can report “Live” with stale task data

**Evidence class:** Manager reproduced data-layer failure; static UI consequence. **Severity:** P2 operational correctness. **Effort:** S.
**Anchors:** `chat-cli/pilink_chat_cli/data.py:95-126`; `chat-cli/pilink_chat_cli/app.py:300-337`.

A fixture first loaded valid chat and task data, then corrupted the task file. The store retained stale tasks, set a private task error, but exposed `connected=True` and `last_error=None`; the displayed Live state is a supported consequence. Preserve per-file snapshots, but expose `Chat live / Tasks stale`, last-success timestamps, and partial health. This was not a live Textual screen test.

#### P2.6 Local supervised operations need correlation, while coordination planes need an explicit bridge

**Evidence class:** Static/design, with manager correction. **Severity:** P2 control-plane usability. **Effort:** M for operation IDs; L for coordination bridge.
**Anchors:** `src/index.ts:490-517`; `src/agents/manager.ts:323-348`; `src/agents/pi-coordination-tools.ts`; `src/mcp-core.ts:2334-2350`.

Asynchronous send returns 202 without an operation ID, accepted timestamp, output cursor, or status URL. Provider rejection is recorded in the agent snapshot, so this is not a claim that all errors are silently lost. Separately, supervised local assignments and canonical collaboration tasks intentionally use different stores; that is not a security defect. Return operation identity and completion states first. Then either bridge child sessions into the canonical board or expose two clearly named monitor workspaces with a task/handoff link, preserving identity and permission boundaries.

#### P2.7 Gateway callers need idempotency and bounded resource admission

**Evidence class:** Static/design, documented limitation. **Severity:** P2 reliability/efficiency. **Effort:** M.
**Anchors:** `src/llm-gateway-api.ts:212-287`; `src/llm-gateway-store.ts:187,389-408,874-895`; gateway operations documentation.

Worker replay protection does not deduplicate a caller retry after a lost HTTP response. Add an `Idempotency-Key` scoped to API key and request digest, bounded result retention, and 409 on conflicting reuse. Add total queued-byte and per-result/output limits rather than only count limits. Benchmark before a cache/database rewrite. Do not represent buffered SSE as token streaming, and do not silently fall back to a direct API backend; that is an optional separate-cost architecture requiring consent.

#### P2.8 Execution profiles need honest side-effect labels and resource controls

**Evidence class:** Static/code-supported. **Severity:** P2 safety/DX. **Effort:** M.
**Anchors:** `src/mcp-core.ts:670-706`; `src/run.ts:195-207`; `src/ensure-cli-link.ts`; `src/execution-jobs.ts`; `src/mcp-core.ts:330-357`.

`npm_build` can run the repository-defined build and, in PiLink’s own build, reach CLI-link maintenance. This is not an OS sandbox bypass and a general `npm_build` profile must not be changed to `build:core` for every user repository. Instead label it as trusted repository code execution, disclose possible installation side effects, optionally skip self-linking, and test the annotation. Also forward abort/progress context to native tools, cap retained stdout/stderr by bytes, prune by bytes, and add identity-safe cancellation checks.

#### P2.9 Cross-mode status, companion state, and documentation need one truthful projection

**Evidence class:** Static/design; live platform behavior untested. **Severity:** P2 UX/supportability. **Effort:** M.
**Anchors:** `packages/vscode/src/extension.ts:176-231`; `packages/vscode/media/app.js:223-251,415-424`; `packages/vscode/src/process-supervisor.ts:188-218`; `docs/ARCHITECTURE.md`; `docs/operations/getting-started.md`.

The VS Code dashboard can label a configured origin “Public HTTPS” without periodic reachability proof, and child startup errors can collapse into “Stopped.” Add local health, public reachability, OAuth readiness, and transport state separately, retaining a redacted failure reason and retry/show-output action. Correct stale “Advanced setup”/old product labels and the conflicting Node prerequisite, while not re-reporting already-delivered readiness, replay, capability, or strict-admission features as absent. Add common read-only `status`/`doctor` projections with human and JSON formats.

### Additional feature-specific backlog

These are meaningful follow-on items, not additional confirmed release blockers.

| Feature / evidence class | Improvement and acceptance criterion | Source / size |
|---|---|---|
| Fresh gateway port selection — static | Existing-config fallback does not run when configuration is absent. Exercise first launch with occupied MCP/API ports; distinguish an unrelated listener from an existing PiLink owner before choosing another port. | `src/llm-gateway-launch.ts:13-28`; M |
| Gateway pairing — static | Hosted start has ordinary first-time setup plus gateway connector setup. Give one component ownership; assert one pairing flow and one connection block per start. | `src/cli.ts:42-59`, `src/cli-core.ts:1391-1453`; S/M |
| API compatibility — documented limits/design | Publish text-only input, unsupported generation/usage/schema behavior; warn or reject discarded message fields. Add bounded tool-schema and history-linkage validation when supported, plus real caller-SDK tests. Do not call buffered SSE native streaming. | `src/llm-gateway-protocol.ts`, `src/llm-gateway-api.ts`; M/L |
| Task gates, review, memory handoffs — static/design | Gates/reviews exist internally but public scheduling pins them to `none`; memory MCP is read-only. Either expose authorized approval/review and candidate-handoff operations or explicitly mark these workflows unsupported. Preserve governed promotion/ACLs. | `src/scheduling.ts:774-775`, `src/mcp-core.ts:554-630,1666-1719`; M/L |
| Monitor retention — static | Incremental rendering appends cards while server history rolls through a bounded window. Reconcile removed cursors or explicitly provide a separately bounded local history; after thousands of posts, widget count must stay bounded and history semantics visible. | `chat-cli/pilink_chat_cli/chat_view.py:276-383`, `src/chat.ts`; S |
| MCP permissions and long inspection — static/design | Make catalog/consent explain effective capabilities; distinguish read-only Git from repository-code execution. Add a deadline/progress to `repo_snapshot`. Keep server-side authorization even if discovery is filtered. | `src/mcp-core.ts:636-773`, `src/harness.ts`, `src/oauth.ts`; M |
| OAuth malformed inputs — specialist reproduced | A typed-invalid scope produced a safe but misleading HTTP 500. Validate request-field types and return protocol-appropriate 4xx errors without exposing internals. | `src/oauth.ts:333-364,723-770`; S/M |
| Legacy TLS readiness — static | Caddy certificate readiness needs an overall failure deadline and actionable DNS/ACME/firewall diagnostics; a live child process is not public readiness. | `src/cli-core.ts:1841-1915`; M |
| Accessibility, installation, platforms — static/design | Preserve webview focus and announce meaningful state changes; test a real extension host. Publish a hosting/platform matrix and one authoritative runtime requirement. Measure VSIX contents before trimming dependencies. | `packages/vscode/media/app.js`, `src/hosting/cloudflared-release.ts`, `docs/INSTALLATION.md`; M/L |

## Interaction redesign — proposed, NOT IMPLEMENTED

These mockups and commands are recommendations only; they are **NOT IMPLEMENTED** and must not be documented as current behavior.

### One operator CLI, not multiple unrelated wizards — proposed

- Bare `pilink` in a TTY shows the selected project/instance, three workflow choices, and a next action without provisioning anything. In non-TTY use, show help or a clear missing-configuration error; never prompt or choose a public tunnel on EOF.
- `pilink setup` owns explicit configuration changes; `start` starts a reviewed instance. Display an apply plan before persistent changes. Prefer per-launch overrides unless the user asks to save them; preserve old commands/aliases during migration.
- Common `status`, `doctor`, `logs`, `connect`, and ownership-checked `stop` work across modes. `doctor` is read-only unless a specific repair is confirmed. `reset` previews exact targets and remains separate from repair/reconfiguration.
- Add named instances and explicit project selection so another terminal cannot silently repoint the first instance's configuration, port, or state. Preserve the original `single`, `collaboration`, and `cli` values as compatibility aliases if friendlier names are introduced.
- Offer consistent `--json`, `--no-input`, and `--plain`/`NO_COLOR` behavior: machine results on stdout, diagnostics on stderr, stable error codes, focused help, and explicit unsupported-flag errors. Keep concise progress visible, with verbose details opt-in.

### Project bridge / Single agent — proposed

```text
Project bridge · Single agent
Workspace: /work/acme/app                 source: private config
Mode: Single · safe workspace              Full Access: off
Capabilities: read/search · Git inspect · execution: approval required
OAuth: paired · private state: outside workspace
[Start] [Status] [Doctor] [Rebind project]
Next: run `pilink status --json` for automation
```

Proposed command contract: `pilink start --mode single --project PATH --hosting local`, `pilink status [--json]`, and `pilink doctor [--json]`. Before commit, show the effective path, mode, access clients, execution policy, config/state paths, and provenance. A denied operation should explain the missing capability and recovery, not recommend universal Full Access.

### Agent team / collaboration — proposed

```text
Agent team · Control room
Health: Chat live | Tasks live | Memory ready | Runtime 2 running
Needs input (2)   Blocked (1)   Leases expiring (1)
Task A  owner local-child/agent-3  running  op_1234
Task B  waiting for approval       next: manager approve gate
Local supervised work: separate view · linked task: T-42
```

Proposed commands: `pilink team status --json`, `pilink team tasks`, `pilink team needs-input`, `pilink team cancel OPERATION_ID`, and `pilink team retry OPERATION_ID`. These are **NOT IMPLEMENTED**. The monitor should say whether it is showing external peers, supervised local agents, or both; show stale-source health; preserve keyboard navigation; and avoid requiring a new terminal stack just to diagnose a blocked task.

### ChatGPT gateway — proposed

```text
ChatGPT gateway · API ready
Worker: not listening · queued: 1 · oldest: 18s
Processing: none confirmed
Next: wake the connected ChatGPT conversation
API: http://127.0.0.1:<actual>/v1
Credential: stored privately; use --show-credential explicitly
```

Proposed commands: `pilink gateway status --json`, `pilink gateway connect --json`, and `pilink gateway doctor --json`. These are **NOT IMPLEMENTED**. `start` should bind/probe, establish one setup flow, print one connection block, and prove readiness. `connect` should reopen or verify that flow. A direct API backend is **NOT IMPLEMENTED** and must never be a silent fallback.

## Efficiency plan and metrics

No performance improvement is claimed by this review. Establish a baseline after the safety fixes, then compare on the same isolated hardware and fixture sizes:

- launch p50/p95 from parse to bound, authenticated API, and worker-ready states;
- number of filesystem/config mutations for `--help`, `--version`, invalid flags, and dry-run planning (target zero);
- workspace-resolution correctness across valid, missing, quoted, symlink, and moved paths;
- gateway queue bytes, state rewrite size, enqueue/claim/complete p95, and maximum retained output;
- monitor refresh duration, stale-source detection latency, and mounted-widget count after 25/100/1,000 posts while the authoritative retention window stays fixed;
- authentication filesystem reads and work-wait snapshot reads per request/idle agent, preserving immediate revocation and cross-process correctness before adding caches;
- supervised operation acceptance-to-terminal-result latency and percentage with a correlated operation ID;
- VS Code package file count/size and release-verifier pass rate.

Use revision-keyed wake signals for local waiters with bounded polling as cross-process fallback. Add byte-based admission/retention before considering a persistence rewrite. Keep benchmarks in CI as trend data, not as unreviewed claims of production throughput.

## Staged roadmap and acceptance criteria

**Stage 0 — release gate.** Fix P1.1–P1.6 and restore the validation gates. Acceptance: workspace dotenv cannot broaden policy; explicit invalid roots fail closed; every help/version/unknown-flag path is mutation-free; ordinary servers are rejected by gateway connect; freshly generated VSIX passes verifier and current-asset assertions; a second gateway cannot mutate a live owner's state. Repair the docs index, stale readiness-event assertion, and scanner fixture classification without weakening their checks.

**Stage 1 — configuration and operator truth.** Add shared dotenv serialization, private-store preflight, effective-value provenance, concrete full-access confirmation, legacy-mode migration warning, gateway status JSON, truthful readiness ladder, and companion failure/public-health states. Acceptance: a new operator can identify mode, workspace, authority, config source, endpoint, and next action without inspecting raw files; no credential is printed by default.

**Stage 2 — reliability and control.** Add native cancellation/progress forwarding, durable output byte caps, safe process identity checks, gateway caller idempotency, bounded queue/result storage, agent operation IDs, partial monitor health, and gate/review diagnostics. Acceptance: cancellation is observable, storage stays within configured limits, retry with one idempotency key creates one logical request, and stale chat/tasks are visibly distinct.

**Stage 3 — coordinated product investment.** Decide and implement either a canonical child-session bridge or explicitly separated control-room views; add named project/instance lifecycle, common status/doctor/logs/stop commands, governed memory proposal/handoff path, and optional richer TUI only where native commands are insufficient. Acceptance: every local or external task has an explainable owner, lease, provenance, blocker, and next action; destructive reset remains distinct from reconfiguration.

## Validation results and limits

| Check | Observed result |
|---|---|
| Initial parallel `npm run test:all` | Core stage: 468 total, 461 pass, 7 fail, 0 skip, 88.97 seconds. It stopped before VS Code checks, which were run separately. Startup/health failures occurred under concurrent audit load; they are not confirmed production outages. |
| Full sequential core run | `node --test --test-concurrency=1 test/*.test.mjs`: **466/468 passed**, 2 failed, 0 skipped; 350.23 seconds. Remaining failures: missing documentation-index link and the stale `mcp-connected`-only expectation when startup now emits `ready` first. |
| `npm run build:core` | Passed. |
| VS Code typecheck/tests | Typecheck passed; 79/79 tests passed. These are largely static/contract checks, not a live extension-host journey. |
| Plugin verification | Passed. |
| Gateway focused specialist run | 80/80 focused tests passed against the then-available build; no live ChatGPT worker, browser OAuth, public tunnel, or external model was used. |
| Release verification | Failed: checked-out VSIX missing `extension/media/app.js`. |
| Security scan | Failed on four deterministic gateway test fixtures, not evidence of real leaked keys; standardize or narrowly exempt placeholders. |
| Python Textual UI tests | Blocked because `textual` was unavailable. A pure stdlib data-layer fixture reproduced partial-health behavior. |
| Manager reproductions | Confirmed M1 workspace-sourced policy, M2 invalid-root fallback, M3 dotenv `#` corruption, M4 help-time mutation, M5 false gateway-connect success, M6 monitor partial-data false health, and M7 two-process gateway state overwrite. |

An earlier selected-suite rerun also failed while reading an OAuth fixture's refresh-token file. **That failure did not recur in the complete sequential run; it is not adjudicated as a confirmed OAuth regression.** Fixed test ports and concurrent suite runs warrant isolation tests. The final repeatable test failures are the two listed above.

Reproduction artifacts: `manager-probes.mjs` / `.json`, `manager-extra-probes.mjs` / `.json`, `manager-monitor-probe.json`, `manager-multiwriter-probe.mjs`, `manager-gateway-multiwriter.json`, `core-serial.log`, and `manager-release-verify.log`, all under `/tmp/pilink-inspection`. These contain synthetic fixture data or verification results, not an external-service benchmark.

No actual Windows/macOS, VS Code extension-host, ChatGPT, browser, Cloudflare/public tunnel, systemd, remote SSH, provider, or cloud smoke test was performed. The report does not claim hidden reasoning, token usage, or published-release inspection. Dist is generated/ignored output; specialist results using it are not individually treated as fresh-source proof unless covered by the manager’s fresh build/validation context.

## QA adjudication exclusions and method

Manager adjudication controls specialist labels. Existing replay, notification, capability, strict-admission, startup-readiness, no-tools, and delivery behaviors are not reclassified as missing without current evidence. Separate supervised and canonical coordination stores are deliberate design boundaries, not P1 isolation failures. Provider rejection is recorded in the supervised agent snapshot, so operation correlation is a P2 design gap rather than a claim of wholly silent errors. Malformed scalar chat records are not claimed to crash the renderer. The legacy collaboration default is compatibility behavior, not an accidental regression. `npm_build` is trusted repository-defined execution, not an OS sandbox bypass. Child-environment token exposure is lower priority than workspace-sourced policy. No P0 is claimed.

Six specialist inspections completed 514 tool calls, followed by report-only continuations, using GPT-5.6 Luna with xhigh. A further Luna/xhigh pass drafted this report from the manager's adjudication; the manager performed final evidence checks and corrections. Invocation records confirm requested effort and returned model metadata confirms Luna. Specialists explicitly read 158 repository files; manager coverage checks included the remaining core modules. This is feature-level inspection, not a claim of exhaustive path coverage or a formal security certification.

`codex-status` was checked at task-stage boundaries. The first allowance exhausted during report wrap-up; final manager QA continued after the user's continuation. The command exposes quota percentages, not an exact remaining-token count. Final QA checkpoint: **50% of the refreshed five-hour allowance remained**, with reset shown at 18:39; weekly allowance was 14%. No product source, private operator configuration, or tracked release artifact was changed.
