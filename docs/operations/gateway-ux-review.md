# PiLink gateway: reliability, latency, and API-like UX

## Recommendation

**Make delivery reliable before making the worker prompt more forceful.** PiLink already tells ChatGPT to keep polling, retries duplicate completions, and combines completion submission with the next wait. The biggest immediate opportunities are gaps underneath those mechanisms.

Implement in this order:

1. Remove the completion-notification delay.
2. Make an entire exchange replayable, not just its submitted completion.
3. Recover from transport replacement and cancelled requests without poisoning the worker loop.
4. Validate outputs before the local harness receives them.
5. Show real worker readiness and request progress instead of a generic “active.”
6. Reduce repeated context and idle overhead, guided by measurements.

**Boundary:** this can become a much better API-compatible adapter, but the current ChatGPT-conversation architecture cannot guarantee API-equivalent execution. PiLink does not control whether ChatGPT schedules another tool call, its generation settings, native instruction hierarchy, context retention, or actual token streaming. Keeping HTTP alive does not keep model execution alive.

## Scope and verification

- Reviewed local source starting at commit `d50746b`, especially `src/llm-gateway-{store,mcp,api,protocol,runtime,control,launch}.ts`, MCP transport lifecycle, gateway tests, documentation, and `/home/rocco/.local/bin/pilink-cli`.
- TypeScript check passed with `tsc --noEmit`.
- **42/42 gateway tests passed against source**, redirecting their `dist/` imports to `src/` through an in-memory Node resolution hook; no build was performed.
- Six additional isolated probes used temporary stores outside the repository and cleaned up afterward. No live ChatGPT requests, gateway restarts, dependency changes, or private transcript inspection.
- This document is the only intentional repository change from this review. Unrelated working-tree edits appeared during the review and were left untouched.
- Timing below is a local observation, not a ChatGPT end-to-end benchmark. External client behavior needs a controlled live test before release.

## What the current path actually does

```text
Local agent POST /v1/chat/completions
  -> availability check -> durable queue
  -> outstanding ChatGPT gateway_exchange returns request
  -> ChatGPT decides answer or local tool selection
  -> gateway_exchange / gateway_call_local_tool commits completion
  -> local HTTP response -> harness executes tools -> next POST
                       \-> same MCP call waits for next request
```

An outstanding poll already wakes on queue changes. **The 20-second MCP wait is not a mandatory 20-second delivery delay.** Shortening it indiscriminately creates more tool calls and more opportunities for ChatGPT to end its turn.

Current defaults: MCP poll 20 s; worker stale threshold 120 s; queue timeout 60 s; execution timeout 600 s; default claim lease 900 s, raised for longer execution timeouts. The gateway guide incorrectly lists a 600 s lease and omits the queue-timeout variable.

### Confirmed findings

| Finding | Evidence | User impact |
|---|---|---|
| Completion commit does not notify result waiters unless another queued job is claimed | `llm-gateway-store.ts`, `exchange()`: completion path persists but does not `emitChange()`; probe observed **800 ms** delay after submitting a completion | Up to approximately one extra second per answer/tool step under ordinary conditions |
| Completion idempotency does not make the returned next request replayable | Complete A, receive B, discard that reply, retry A: retry returns `idle`; B remains `claimed`. Enqueue C: same worker can claim C too | Lost work, out-of-order progress, long stalls after an ambiguous timeout |
| A non-overlapping reconnect invalidates outstanding work | `disconnectSession()` immediately requeues and removes tokens; submitting the old completion after reconnect produced “Gateway request is not currently claimed” | Reconnection can discard useful reasoning and lead to repeated tool errors |
| Tool validation has a no-tools bypass | `applyCompletion()` passes the contract only when `job.tools` exists; a request with no tools and `toolChoice: "none"` accepted a `bash` tool call in a probe | Unadvertised tool selections can reach the caller; execution still depends on the harness |
| `strict` schemas are not enforced | `llm-gateway-protocol.ts` checks names, JSON object shape, choice, and parallelism—not schema properties; a strict tool requiring `command` accepted `{ "wrong": 123 }` | Avoidable harness failures and repair turns |
| Idle polls rewrite the entire state | A two-second idle exchange called `persist()` three times; each write includes file and directory sync | Disk amplification and serialized queue contention |

Other source-level gaps:

- Worker identity is derived from **OAuth client ID**, not conversation identity. Two chats using the same connector are not distinguishable as separate workers by that identity alone.
- Existing reconnect tests cover overlapping transports; existing retry tests lose an idle response, not a response carrying newly claimed work.
- `active` means recent exchange or a valid claim lease—not necessarily a listener currently waiting for work. A stranded claim can keep this optimistic state alive.
- A cancelled/expired request's late completion becomes a plain MCP error. Recovery instructions classify transport timeouts, but not this common lifecycle case.
- API requests have no idempotency key. A caller retry can create a second job. Restart activation requeues old claims without knowing whether their original HTTP caller still exists.
- Streaming headers and chunks are emitted only after completion. `response_format`, `n`, generation limits, and tuning fields are accepted but not implemented; usage is always zero.
- Full caller history and tool definitions are sent again each request. They accumulate inside an already persistent ChatGPT conversation. Message count is capped at 256; blindly increasing it would aggravate context growth.
- Terminal prompts are stripped, but responses remain in snapshots. Just 32 near-limit responses can approach 128 MiB; pruning is not applied at every terminal transition.

## Proposed implementation

### 1. P0 — Immediate, race-safe completion delivery

**Files:** `llm-gateway-store.ts`; store/API tests.

- Notify waiters immediately after every successful durable terminal transition, including failure, cancellation, and release. Preserve commit-before-observation ordering.
- Avoid a lost wakeup between reading state and subscribing: use a monotonically increasing change revision, subscribe, then recheck revision/state.
- Keep a bounded timer for actual deadlines/recovery, not as the primary delivery mechanism. Check already-aborted signals when registering waits.
- Preserve the existing combined submit-and-wait fast path; a separate acknowledgement call on every turn would add latency.

**Acceptance:** deterministic notification tests plus a local benchmark with an already-listening waiter; target p95 under 100 ms from durable completion to local delivery on the reference machine, excluding model time. Report tails rather than promising every request is sub-100 ms.

### 2. P0 — Replayable delivery and single-flight ownership

**Files:** store, protocol, MCP tools, transport integration tests.

Introduce a versioned worker protocol with server-issued worker credentials, a worker epoch, exchange sequence/delivery IDs, and bounded replay records. Bind credentials to the authenticated OAuth principal; never infer conversation isolation from that principal alone.

Required invariants:

1. At most one uncompleted request per worker initially.
2. Repeating an exchange returns its same still-valid delivery; it does not silently claim another job.
3. A repeated completion with a different payload is a conflict, not a replacement.
4. Old worker epochs cannot complete reassigned work.
5. Completing a request acknowledges its delivery; resumption can acknowledge receipt without completing it. Piggyback acknowledgements where possible.
6. Concurrent polls from the same worker are serialized or receive a typed `worker_busy` response.

Persist the accepted completion and next delivery record atomically. Retain replay records and terminal tombstones for a defined retry window, with byte/TTL caps independent of the current 32-job pruning rule. For an expired/cancelled delivery, replay a typed terminal outcome rather than obsolete executable work.

A pragmatic first patch can replay the current outstanding claim for the supported single-worker configuration. Full cross-conversation ownership requires the versioned worker handshake; document that distinction rather than claiming the first patch solves it.

**Acceptance:** discard a reply containing B, retry A, and receive B with unchanged IDs; concurrent retries cannot claim C. Test lost initial claim, lost completion acknowledgement, reconnect, expiry, and restart—not only idle-response loss.

**Guarantee:** idempotent logical completion and at-least-once delivery. Exactly-once tool execution also requires caller-side deduplication using stable tool-call IDs; PiLink cannot guarantee it alone.

### 3. P0/P1 — Recovery that does not eject ChatGPT from the loop

**Files:** store, MCP, runtime, API.

- Separate logical worker ownership from transport lifetime. On an accidental disconnect, retain the claim for a short configurable reconnect grace, initially 15–30 s for testing. Resume with the worker credential; fence old epochs on reassignment. Explicit release/revocation must bypass grace.
- Return structured recovery codes and next actions: `request_cancelled -> poll`, `stale_claim -> resync`, `invalid_output -> repair`, `worker_busy -> bounded_wait`, `released -> stop`. Do not ask the model to infer all of this from English error strings.
- Bound retries and repair attempts. A persistent authentication/contract failure needs actionable operator guidance, not an endless immediate retry loop.
- Store an absolute request deadline across reclaims. Today queue/execution timers can reset on reclaim; repeated churn should not extend work indefinitely.
- Separate caller cancellation, transport loss, and operator release. Drop late results for cancelled work with a safe acknowledgement so the worker can continue.
- For restart recovery, fail orphaned non-resumable requests explicitly rather than blindly replaying every claim. Only resume jobs with a durable caller-resumption contract.

**Acceptance:** transport A closes before B opens while ChatGPT is processing; valid resumed work survives grace. A late result after Ctrl+C does not prevent the next request. Release, auth revocation, and hard deadlines always win.

### 4. P0/P1 — A real output contract, not just a persuasive prompt

**Files:** protocol, store, MCP, API.

- Always enforce the request's tool contract, including the absence of tools. Preserve exact duplicate-completion handling after terminal payload stripping, using retained completion digests/metadata.
- Validate arguments against advertised JSON Schema using a directly declared, bounded validator. No remote `$ref` fetching; no coercion, default insertion, or silently removed properties. Cache compiled schemas by digest with limits; reject unsupported schema features explicitly.
- Validate tool-call history linkage: outstanding call IDs, duplicate results, and function names. Define the supported ordering contract instead of accidentally accepting malformed histories.
- Implement `response_format` JSON/schema validation where supported. On failure, return compact validation paths and allow at most one or two repairs within the original deadline. Do not forward invalid output or turn commentary into a fabricated success.
- Publish a capability endpoint. Distinguish **enforced**, **advisory**, and **unsupported** fields. Offer compatibility mode with warnings and opt-in strict mode; reject `n != 1` and unknown models unless explicitly supported.
- Do not report zero tokens as measured usage. Advertise usage as unavailable; any optional estimate must be explicitly labelled and must not pretend to support accurate billing/context accounting.

**Acceptance:** no-tools calls, wrong types, missing fields, unsupported schemas, malformed history, and invalid structured answers fail before caller execution. Valid existing Pi payloads continue to pass.

### 5. P1 — Visible readiness, bounded waiting, and safe retries

**Files:** store/API status, CLI control/output; optional caller integration later.

Expose separate facts: API reachable, OAuth authorized, transport present, pending worker poll, worker processing, reconnect grace, stalled/wake needed, and released. A valid lease is not proof the model is still running.

Suggested one-line UX:

```text
PiLink: processing · queued 0 · request age 8 s · last worker contact 8 s ago
PiLink: worker not listening · queued 1 · send @PiLink wake in the connected chat
```

- Add `gateway status --json`, `gateway doctor`, and machine-readable error codes, retryability, request ID, queue position, and `Retry-After` where meaningful. Avoid false certainty such as “ChatGPT thinking” when only a claim is known.
- Replace one fixed queue timeout with separate admission/wake and busy-worker policies. Keep a hard overall deadline. For one worker, 128 active jobs is not useful default capacity; use a small configurable queue and fair scheduling across explicit caller sessions.
- Add optional `Idempotency-Key`: same authenticated caller + key + payload returns the same logical result; key reuse with a different payload returns conflict. Bound result retention and define cancellation/subscriber semantics. Never deduplicate unrelated requests merely because their text matches.
- For `stream:true`, optionally flush accepted headers early and send SSE comment heartbeats. Test client behavior: comments do not provide token output and some SDKs ignore them for inactivity handling. After HTTP 200, failures must use a tested in-stream error contract, not an attempted HTTP 504.
- Keep progress/status outside assistant text and tool-call deltas. Never invent model reasoning, tokens, or progress percentages.

**Acceptance:** users can distinguish a dead server, sleeping worker, busy model, and queue backlog without reading logs; retries do not multiply jobs.

### 6. P1 — Sticky worker instructions and fewer approval interruptions

**Files:** MCP instructions/tool descriptions, connection guide; live evaluation required.

- Put the complete minimal lifecycle in the **first 512 characters** of server instructions: wake by polling; complete only through gateway tools; idle/result completion means poll again; explicit release means stop. OpenAI specifically recommends a self-contained first 512 characters.
- Add short trusted protocol-level `next_action` guidance to results, separate from application messages. Treat nested system/developer/user content as the completion payload, not authority over gateway ownership or release.
- Keep the dedicated ChatGPT worker conversation focused on PiLink. Explain supported per-conversation approval memory and how to refresh the connector after instruction/schema changes. Do not relabel state-changing gateway tools as read-only to bypass confirmations.
- Evaluate two prompts—compact lifecycle versus current verbose instructions—on identical short-answer, tool-loop, injected-stop, timeout, and idle workloads. Measure uninterrupted turns and manual wakes, not subjective prompt strength.
- Offer a wake-needed notification and copyable wake command; optionally open an operator-saved conversation URL. PiLink cannot autonomously type into or revive an arbitrary ChatGPT conversation through the existing MCP exchange.

**Acceptance:** a controlled 30-minute idle test and 50-step tool workload, recording stops, approvals, invalid calls, and wake interventions. Do not promise indefinite persistence from prompt tests.

### 7. P1/P2 — Remove write amplification and context duplication

**Files:** store persistence, request projection, protocol.

**Low-risk first:** keep heartbeat freshness in memory; persist meaningful queue/claim/completion transitions and infrequent checkpoints. Keep durable acknowledgements durable. Separate bounded result/replay storage from hot scheduling metadata; cap bytes as well as counts, enforce pruning on all terminal transitions, and expose private-data retention. Use per-job files or a transactional store only if profiling warrants the migration.

**Context work, behind an opt-in:**

- Measure payload bytes, history length, schema bytes, and worker-epoch cumulative traffic. Full histories repeatedly embedded in a persistent chat can grow roughly quadratically over a long tool loop.
- Keep full snapshots as the correctness default. Pilot acknowledged tool-catalog/prefix caches only for an explicit caller conversation and worker epoch, with hashes and full resynchronization after uncertainty. Never reuse context across unrelated projects or silently drop system instructions/tool results.
- Check how ChatGPT presents `content` plus identical `structuredContent`; the server emits both today. Do not claim double model-token usage without measuring it, or remove compatibility text blindly.
- Warn before payload/context limits and offer deliberate worker rotation plus caller-supplied authoritative state. Prompt summaries and retained chat memory are not reliable substitutes for the caller's history.
- Prefer existing batching of independent tool selections when `parallel_tool_calls` allows it. Preserve caller execution/approval semantics; never batch dependent edits speculatively.

**Acceptance:** no full-state writes per idle second; bounded private-state size under large responses; cache eviction/reconnect restores exact context rather than guessing.

### 8. P1 — Harden the global launcher, including the previous auto-build change

**Location:** `/home/rocco/.local/bin/pilink-cli` today; move into versioned, tested project code.

The convenience update earlier in this conversation needs hardening:

- The unauthenticated `curl /models` check accepts HTTP 401 as shell success and can mistake an unrelated listener for PiLink. Use authenticated identity/status verification with a total deadline.
- Port 3210 is hardcoded despite gateway fallback. Discover the actual endpoint and synchronize the caller provider configuration without overwriting unrelated providers.
- Modification-time checks miss deletions and some checkout/timestamp cases. Use a fingerprint covering source file paths/content, manifests, lockfile, build config, and toolchain. Detect external builds as well as builds performed by the wrapper.
- Serialize dependency installation/build/startup. Stage immutable build output, launch only a successful build, and retain the last good build. Do not rewrite `dist/` or run `npm ci` underneath a running process that might lazily import dependencies.
- Drain in-flight requests before upgrading the shared gateway; block new admission and show progress. Do not silently kill another terminal's active session. Restarting may still require a ChatGPT wake.
- Replace broad `pgrep` termination with verified process ownership, graceful shutdown, and readiness checks. Reuse `runtime-owner.ts` identity concepts rather than trusting a reusable PID alone.
- Stop printing API keys into routine background logs; provide an explicit private credential-display/export action instead.

**Acceptance:** concurrent launches produce one owner; unrelated listeners survive; source deletion rebuilds; fallback ports work; failed builds preserve service; another agent's active work is not killed silently.

## Longer-term options: useful, but do not confuse them with quick fixes

| Option | Recommendation |
|---|---|
| Streamable HTTP resumable event storage | Investigate after application-level delivery replay. `index.ts` does not configure an event store. MCP defines resumability, but the real ChatGPT client must actually reconnect/replay; retain legacy SSE compatibility. |
| Adaptive long polls | Keep 20 s until measured. Longer safe waits reduce idle model/tool turns; shorter waits reduce individual timeout exposure. Neither wakes a stopped model. Use observed transport budgets and a safety margin, not a guessed unlimited timeout. |
| Incremental `gateway_emit` output | Experimental only. ChatGPT could submit explicit chunks, but each adds a tool decision/round trip. This is not access to native token streaming and may increase total latency. Never execute incomplete tool arguments. |
| MCP sampling | Only if the client negotiates it and the intended flow/approval model supports it. Protocol support does not establish ChatGPT availability or arbitrary background wake capability. |
| Official Workspace Agents trigger path | OpenAI's current developer portal advertises programmatic triggers for published workspace agents. Timebox an eligibility/capability spike; account access, cost, continuity, and applicability to this workflow were not established here. Do not present it as a way to resume any existing ChatGPT tab. |
| Optional direct API provider | Best architectural path when autonomous scheduling, native role handling, real streaming, and documented generation controls are requirements. Explicit opt-in with separate credentials/cost and caller consent; never silently switch providers or replay tool effects. |

Avoid browser scraping, cookie reuse, synthetic keep-awake traffic, fake progress, globally disabling confirmations, and simply multiplying timeout values. They add fragility or conceal failures rather than giving the gateway a reliable execution contract.

## Five-hour first implementation slice

This is a timebox, **not an estimate for the entire roadmap**.

| Time | Deliverable |
|---|---|
| 0:00–0:30 | Add failing regressions for lost next-job replies, notification delay, no-tools bypass, and cancellation recovery; capture timing baseline. |
| 0:30–1:15 | Fix completion notification and unconditional tool-contract enforcement. Keep duplicate-completion behavior intact. |
| 1:15–3:15 | Implement minimal single-worker outstanding-delivery replay and single-flight protection; test dropped replies and concurrent retries. Defer full multi-conversation handshake/migration. |
| 3:15–4:15 | Add typed late/cancelled-result recovery and explicit next actions; tighten the instruction prefix and correct timeout documentation. |
| 4:15–5:00 | Run gateway/type checks, real HTTP disconnect tests, and one operator-approved ChatGPT smoke test. Document remaining gaps and measured results. |

If delivery replay exceeds its timebox, ship the small verified fixes and regression coverage first. Do not rush schema-engine integration, persistence migration, caller adapters, or hot upgrades into the same slice.

### Measurement and release gate

Record monotonic timestamps for enqueue, claim, completion commit, local response, next poll, and disconnect/recovery. Export bounded metadata only—no prompts, tool arguments, credentials, or hidden reasoning.

Track p50/p95 queue-to-claim, claim-to-completion, commit-to-delivery, poll gaps, manual wakes per 100 turns, duplicate/reclaimed deliveries, validation repairs, and state-write bytes. Separate model time from bridge time.

Before calling the gateway reliable: test lost responses in both directions, overlapping and non-overlapping reconnects, two chats sharing OAuth credentials, slow harness tools, Ctrl+C, process crash, tunnel interruption, release/revocation, large histories, and 50+ consecutive tool steps. The current 42 passing tests are a useful baseline, not evidence those failure modes work.

## External references

- [OpenAI developer mode](https://developers.openai.com/api/docs/guides/developer-mode): supported transports, instruction-prefix guidance, tool selection, and conversation-specific confirmations.
- [MCP lifecycle/timeouts](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle): progress may reset some timers, but maximum timeouts still apply.
- [MCP transports](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports): disconnect is not automatically cancellation; resumability is optional.
- [MCP progress](https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/progress): requires an active request's progress token; not a general model wake mechanism.
- [MCP sampling](https://modelcontextprotocol.io/specification/2025-06-18/client/sampling): capability negotiation and client-controlled generation/approval.
- [OpenAI ChatGPT developer portal](https://developers.openai.com/chatgpt) and [Workspace Agents](https://developers.openai.com/workspace-agents): candidate supported trigger path, not verified here as a PiLink replacement.
