# PiLink UX Next-Iteration Implementation Proposal

## Executive decision

Ship a small P0 focused on truthful readiness, honest API capabilities, and reliable startup. These changes reduce misleading waits and compatibility assumptions without pretending PiLink can wake ChatGPT, stream native tokens, or guarantee third-party behavior.

Do **not** add browser automation, cookie reuse, fake progress, relaxed approvals, silent fallback, or data-boundary changes. A separately credentialed direct API backend remains an optional path for unattended scheduling, native streaming, roles, or model controls; it must never be a silent fallback.

This is a capped five-hour planning timebox, not guaranteed effort. `[Local]` refers to current source or tests. `[Live-dependent]` requires real-client or installed-SDK verification.

## Existing baseline

The working tree already includes replay, post-commit wakeups, durable queue/claim/completion/release transitions, bounded retries, compact worker guidance, in-memory worker heartbeats, copy-on-write persistence, and replacement retention when a new MCP transport connects before the old one closes. See [the existing implementation baseline](gateway-implementation.md); do not redo that work.

The combined submit-and-next-wait path already wakes on queue changes (`src/llm-gateway-store.ts:483-761`). Its 20-second poll is a maximum wait, not a mandatory handoff delay; shortening it blindly adds idle tool turns. PiLink does not execute caller-advertised local tools (`src/llm-gateway-mcp.ts:114-215`).

Intentional limitations include buffered streaming, ignored generation controls, unavailable usage, no idempotency key, no reconnect grace for non-overlapping disconnects, no full JSON-Schema engine, and no worker credential/epoch handshake. These are not claims of completed live behavior.

## Ranked changes

### 1. P0 — Separate observational readiness from lease activity

**Evidence — local:** `isAvailable()` treats recent exchanges or valid claims as active (`src/llm-gateway-store.ts:342-355,1565-1572`), while the API queues work (`src/llm-gateway-api.ts:167-218`). Normal between-poll network and model-scheduling gaps make an immediate “no poller = 503” rule unsafe.

Implement:

- Track an in-process `worker_polling` count around the exchange wait path.
- Expose `worker_contact`, `worker_polling`, `processing_claim`, `claim_age`, `lease_expires_at`, queue age, and `next_action`.
- A claim means processing is **unconfirmed**, not proof that the model is progressing.
- For admission, subscribe to the wake signal, then recheck poller/lease state to close the enqueue-versus-repoll race. Apply a short configurable admission/wake grace.
- Preserve the current admission default initially: if capacity and the request’s overall deadline allow it, queue even without a current poller. Bound queue size/bytes and enforce an overall deadline.
- Offer fail-fast only as an opt-in profile. After the grace period, it may return a typed 503 with `Retry-After` and wake guidance. Distinguish rejected-before-enqueue from ambiguous timeout: never encourage automatic retries that can duplicate jobs. Serialize admission checks with enqueue so release/capacity changes cannot invalidate the decision.
- Do not label every no-poller request doomed; test the enqueue/re-poll boundary and stale-claim cases.

### 2. P0 — Make the OpenAI-compatible contract explicit

**Evidence — local:** accepted fields are not necessarily forwarded (`src/llm-gateway-api.ts:43-70,258-279`); responses echo the requested model and report zero usage (`:308-325`); `stream=true` is buffered (`:328-390`).

Publish an authenticated `/v1/gateway/capabilities` contract and additive warning headers, with two documented profiles:

- **Compatibility (default):** retain currently accepted ignored fields so existing Pi clients do not break. Do not silently claim unsupported behavior. For `strict:true` or unsupported `response_format`, return an explicit capability warning.
- **Strict (opt-in):** reject unsupported fields and unsupported `strict`/`response_format` requests before enqueue. Keep type/range checks narrow enough for this slice; do not create an exhaustive tuning validator.

Always reject an unknown or contradictory model request and `n != 1`, returning a migration-oriented error. If real callers require aliases, support only explicitly configured aliases and document them; never echo an unknown model as accepted. Return `model: "pilink"` for accepted requests.

Usage is unavailable in the new contract. Compatibility zeroes should remain only for proven legacy consumers that require the fields; they must not be presented as measured accounting. Add a buffered-stream capability header and never emit fake token deltas or heartbeats.

### 3. P0 — Make launch readiness truthful

**Evidence — local:** `startGatewayApi()` logs after `listen()` but before asynchronous bind failure is necessarily observed (`src/llm-gateway-api.ts:223-245`); runtime readiness is tracked separately (`src/llm-gateway-runtime.ts:59-70`).

Return or await a server `listening` promise, require durable-store activation and local `/v1/models` reachability before reporting ready, and expose machine-readable readiness fields alongside existing human output. Never print a ready endpoint for an occupied port.

### 4. P1 — Add bounded contract recovery and clarify schema/batch scope

Current validation covers basic tool names, object arguments, tool choice, and `parallel_tool_calls` (`src/llm-gateway-protocol.ts:193-227,282-334`), but strict schema requirements are not enforced.

Roadmap the requested validator as a bounded, directly declared subset:

- no remote references;
- no coercion or mutation;
- bounded schema cache entries/bytes;
- explicit `strict` and `response_format` behavior;
- at most one or two repair attempts within the original request deadline.

Plain typed recovery must obey the same deadline and attempt bounds. Return typed `contract_error` details with a field path and `next_action`; do not silently complete a claim on failed validation. Validate history linkage, duplicate tool results, call IDs, and argument shape.

Batch calls already exist with deterministic IDs (`src/llm-gateway-mcp.ts:167-214`). New work is guidance and testing for independent read-only batches, reducing separate model/MCP turns without new execution authority. Do not automatically batch dependent edits. `parallel_tool_calls=false` must continue to reject multiple calls; the harness decides how permitted batches execute.

### 5. P1 — Add idempotency without promising effect deduplication

Each POST currently enqueues a new job (`src/llm-gateway-api.ts:157-218`). Add an `Idempotency-Key` scoped to the authenticated caller and namespace, persisting a request digest, request ID, final result, and bounded TTL/size.

Exact retries should coalesce; reuse with a different payload returns 409. Define subscriber, disconnect, cancellation, and expiry behavior. Idempotency reduces duplicate jobs, **not repeated local effects**: stable tool IDs and caller-side execution deduplication remain required.

### 6. P1 — Keep reconnect grace experimental and safely fenced

Disconnect currently fences or requeues work (`src/llm-gateway-mcp.ts:217-249`; `src/llm-gateway-store.ts:457-480`). Do not relax this default based only on OAuth identity or staleness: the same OAuth principal is not proof of the same ChatGPT conversation.

Any reconnect grace must be explicitly opt-in single-conversation mode, with a worker credential/epoch handshake, explicit release/revocation bypass, and expiry fencing. Run real HTTP transport tests before switching the default. Until then, retain safe fencing and requeue behavior.

### 7. P1 — Improve buffered SSE reliability

Keep buffered SSE documented as the default. Await `drain` for large responses and provide standard errors for malformed or oversized bodies. Do not send early headers, synthetic progress, or token-like deltas. True streaming requires a different backend.

### 8. P1 — Make collaboration waits and operations actionable

Replace the one-second-only `waitForAgentWorkChange()` loop (`src/mcp-core.ts:1846-1885`) with revision-keyed in-process signaling plus a safe cross-process signal where available; retain bounded polling as the correctness fallback.

Give asynchronous agent sends an `operation_id`, accepted timestamp, status revision, output cursor, and status/output URLs. Keep process-local retention explicit and do not imply durable execution. Preserve task-board tokens and persisted cursors as authoritative.

### 9. P1/P2 — Reduce repeated context and recover chat gaps

Each gateway request resends full history and tools; repeated growing histories can produce roughly quadratic cumulative traffic. The protocol caps messages at 256 and total message text at 1 MiB (`src/llm-gateway-protocol.ts:57-86`). Collaboration chat retains 20 messages and reports missing-cursor gaps (`src/chat.ts:127-160`).

First measure history/schema bytes and warn before limits. Add task-linked durable handoff records and an actionable `gap=true` recovery path. Do not simply increase limits, silently trim history, or assume duplicated MCP text/structured content doubles model tokens without measuring.

Later, trial opt-in prefix/tool-catalog reuse scoped to an explicit caller conversation and worker epoch, with hashes, bounded retention, and full snapshots after uncertainty. A hash acknowledgement does not prove ChatGPT still retains context; full authoritative history remains the correctness default. Preserve or explicitly reject currently discarded message fields (`src/llm-gateway-protocol.ts:164-191`).

### 10. P1 — Correct service status and evaluate real-client UX

`serviceActivitySnapshot()` currently reports a generic client as connected after initialization even with zero active sessions (`src/service-status.ts:26-43`; `src/index.ts:1388,1548`). Report current active-session state as `mcp_client_connected`; reserve ChatGPT-specific readiness for gateway state.

Evaluate with a dedicated worker chat and short `next_action` guidance—the existing worker prefix is already present—plus a wake-needed notification and copyable wake action. Per-conversation remembered approvals should exist only when the user opts in and trusts that conversation. Do not label capabilities with a misleading `readOnlyHint`.

A 30-minute idle / 50-step tool-loop A/B harness should measure manual wakes, poll gaps, repairs, and approval interruptions. Heartbeats can protect HTTP connections, not wake the model. Native streaming, roles, and model control require a different backend. Live smoke testing is separate work, not completed or included for free.

## Explicit five-hour implementation slice

1. **0:00–0:30 — Tests:** focused regression scaffolding and enqueue/re-poll boundary cases.
2. **0:30–1:45 — Observational readiness:** poller versus claim state and actionable status; retain existing queue limits/deadlines. Add grace and opt-in fast-fail only if race-safe and time permits; byte-budget changes are later work.
3. **1:45–3:15 — API guardrails:** compatibility/strict profiles, model and `n` rejection, narrow type/range checks, capability warnings, and truthful response metadata. This is not exhaustive tuning validation.
4. **3:15–4:00 — Startup:** await bind readiness and gate ready output on store/API readiness.
5. **4:00–5:00 — Tests and docs:** occupied-port, contract, deadline, and readiness tests; run typecheck and update operator/API documentation.

If time is tight, drop optional fast-fail—not tests. Reconnect grace, idempotency persistence, full schema validation, durable archival, true streaming, worker handshake, and direct-provider fallback remain outside this slice.

## Follow-on effort and acceptance gates

Rough engineering estimates beyond the five-hour slice; not commitments:

| Work | Effort | Required regression |
|---|---:|---|
| Typed repair and history linkage | 2–4 h | Invalid result keeps claim; repair budget/deadline enforced |
| Bounded schema/structured-output validation | 4–8 h | Required/type/additional-property failures never reach harness |
| Caller idempotency | 3–6 h | Concurrent/lost-response retry creates one logical job; conflicting key returns 409 |
| Worker handshake + reconnect grace | 1–2 days | Same-principal different threads remain isolated; stale epoch/revocation always fenced |
| SSE/backpressure and JSON errors | 1–2 h | Slow/disconnected consumers, malformed/oversized bodies |
| Event-driven collaboration wait | 6–12 h | Lost-wakeup, abort, release, and cross-process fallback |
| Agent operation IDs / service status | 4–8 h each | Delayed failure correlated; disconnect removes connected state |
| Durable context handoffs / cache pilot | 1–3 days | Cursor gap recovery and exact resync without cross-conversation reuse |

Run gateway regressions against current source, not stale `dist/`. Real ChatGPT tests remain a release gate for any claim of improved continuation; prompt strength alone is not evidence.

## Verification boundary

Three additional isolated probes confirmed:

- a generic client can report `chatgptConnected=true` with zero active sessions;
- a missing required strict-schema field is accepted;
- an unknown HTTP model is echoed, `n=2` still returns one choice, and JSON `response_format` is ignored.

Three GPT-5.6-Luna `xhigh` specialists reviewed lifecycle, API/latency, and collaboration; drafting was also delegated. The parent checked critical source paths and the three probes above. All 86 targeted tests passed against current source through a temporary import hook: gateway tests plus chat, progress, work-loop, and MCP work-loop tests. `tsc --noEmit` passed; no build was performed.

This proposal is the only intentional repository change. Existing uncommitted work was preserved. No live ChatGPT worker actions or end-to-end benchmarks were performed; third-party behavior remains explicitly unverified. Line references describe the reviewed working tree.

## External constraints and sources

- [OpenAI Developer Mode](https://developers.openai.com/api/docs/guides/developer-mode)
- [MCP transports](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
- [MCP progress](https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/progress)
- [MCP sampling](https://modelcontextprotocol.io/specification/2025-06-18/client/sampling)

## Shared measurement block

All features should use one metadata-only measurement block—never prompts, arguments, tokens, or reasoning:

- p50/p95 enqueue→claim;
- p50/p95 commit→HTTP delivery;
- poll-gap distribution;
- wakes per 100 turns;
- payload and schema bytes;
- storage writes;
- queue rejections, retryable outcomes, repairs, and approval interruptions.

Proposed targets are not measurements; for example, same-process event wake p95 `<100 ms` is a future benchmark target.
