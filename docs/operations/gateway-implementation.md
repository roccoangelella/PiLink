# LLM gateway first-release implementation

## Implemented

This release is the bounded reliability slice described by the gateway UX review:

- Durable queue, claim, completion, cancellation, release, and replay transitions now notify waiters immediately after the state-file commit. A monotonic in-process revision and post-subscription recheck prevent read/subscribe lost wakeups; aborted waits are checked both before and during listener registration.
- The supported single-worker path has one outstanding claimed delivery. A lost initial poll response replays the same request. A lost completion response that carried the next request replays that request, rather than claiming the following job. Concurrent polls and exact duplicate completions cannot skip work. Replays are bounded to eight records, four MiB, and a 15-minute retry window; accepted replay metadata survives activation/restart and repairs a requeued next claim with a fresh token.
- Late results for locally cancelled, expired, or transport-invalidated claims return structured recovery (`request_cancelled`, `stale_claim`, or `worker_busy`) with a `next_action`. `poll` and `resync` mean `gateway_exchange` with no completion fields; `bounded_wait` means a no-completion poll with a short maximum wait, capped at three recovery polls (5/10/20 seconds). Ownership and opaque claim-token checks remain mandatory, and wrong tokens are rejected rather than acknowledged as recovery. Queue and request waits use absolute local deadlines rather than resetting a deadline after reclaim.
- Tool contracts are always enforced, including requests with no `tools` field and explicit `tool_choice: "none"`. Duplicate function definitions, unavailable calls, conflicting choices, and disallowed parallel calls remain rejected before local execution.
- The first instruction prefix is self-contained and under 512 UTF-8 bytes. It covers polling, completion, idle, release, and structured recovery guidance.
- Idle worker heartbeats remain fresh in memory; meaningful transitions and acknowledgements still use durable file and directory sync. This reduces idle full-state fsync churn without weakening completion durability.
- State mutations use a shallow copy-on-write transaction: read-only status/job/idle polling does not serialize retained state, and only reached objects are copied. A pre-rename write failure keeps the last committed cache; after rename, a directory-sync failure is treated as an ambiguous commit and the cache is invalidated/reloaded from disk rather than restoring contradictory state. A connected replacement MCP transport is retained before its first tool call, so closing the old transport does not fence an already-connected replacement.
- Documentation now distinguishes the 60-second queue timeout, 600-second absolute API request timeout, and 900-second default claim lease. Status `active` is documented as recent contact/live lease, not model-generation proof.

## Invariants

1. A worker cannot own more than one active claim.
2. A request is not returned to a worker until its claim is durably committed.
3. Completion is durably committed before a result waiter is notified.
4. An exact duplicate completion is idempotent only for the same worker, request, claim token, and completion digest. A conflicting payload is rejected.
5. Terminal jobs strip prompt/tool request data, while bounded replay records and claim tombstones retain only what is needed for safe retry and lifecycle recovery.
6. A late result never completes a cancelled, expired, released, or replaced claim.
7. The OAuth client-derived worker identity is not a ChatGPT conversation identity; cross-thread isolation is not promised.

## Deferred scope and known limitations

Transport reconnect grace is deliberately deferred for a replacement that has not connected before the old transport disappears: disconnect fences the old claim and requeues it, rather than guessing whether a replacement transport is the same ChatGPT execution. A full worker handshake/epoch protocol, cross-conversation identity isolation, multi-worker scheduling, API-provider fallback, native token streaming, prefix caching, schema validation beyond the existing bounded shape checks, response-format enforcement, idempotency keys, and launcher changes are not part of this release. Restart replay covers durable worker delivery metadata only; it does not resume an orphaned local HTTP caller. Transport-timeout retries are finite (at most three exact-call attempts); persistent failure requires operator reconnect/wake assistance, because the adapter cannot keep ChatGPT generating or wake it itself.

Streaming remains buffered. Generation controls are accepted for client compatibility but ignored, and usage is unavailable (the compatibility response still contains zero counts). Keeping HTTP/MCP alive does not keep ChatGPT generating or wake an asleep conversation.

## Verification

- `npm run build:core` — passed.
- `node --test test/llm-gateway*.test.mjs` — 63/63 gateway tests passed (60 existing tests plus three deterministic audit regressions), including HTTP disconnect and MCP replacement boundary tests.
- `./node_modules/.bin/tsc --noEmit` — passed. (`tsc` is not on the shell PATH in this copy.)
- Added audit regressions cover replay repair after expiry/restart/cancellation, replay count/UTF-8 byte bounds, terminal conflict checks, wrong-token rejection, structured worker-busy recovery, notification latency, abort registration, HTTP disconnect cancellation, MCP replacement retention, cancellation/expiry recovery, no-tools validation, concurrent exchange safety, frozen-clock deadlines, idle write behavior, and both pre-rename and post-rename persistence failures.
- Independent integration verification reran the build, typecheck, and all 63 gateway tests successfully. A broader-suite run did not complete and reported `first start guides callback registration and persists a ChatGPT OAuth client` as failing. The same test also failed in a separate unmodified-baseline copy; both targeted runs hung during cleanup and were terminated at their deadlines. This is a reproduced baseline failure, not a clean full-suite pass. No live gateway was restarted.

## Live-smoke requirements before release

Run an operator-approved smoke test with the real ChatGPT connector: wake the worker, submit a normal completion and a multi-step tool loop, deliberately drop the initial and completion HTTP/MCP responses, reconnect a transport, cancel a caller while ChatGPT is processing, and verify a subsequent request is served. Record queue-to-claim, commit-to-delivery, duplicate/reclaim, manual-wake, and intervention metrics without logging prompts, tool arguments, tokens, or hidden reasoning.

## Compatibility notes

The public OpenAI-compatible endpoints and existing MCP tool names remain unchanged. `state=recovery` is an additive MCP exchange result; existing clients that treat unknown structured states as tool errors should still be able to retry, while the supplied worker instructions define executable `poll`, `resync`, and finite `bounded_wait` calls. The local tool bridge continues to return buffered OpenAI tool calls and never executes caller functions itself.
