# UX next-iteration P0 implementation

This document records the authorized five-hour slice from
[`ux-next-iteration-proposal.md`](ux-next-iteration-proposal.md). The existing
replay, notification, durable transition, cancellation, bounded recovery, and
MCP replacement behavior described in
[`gateway-implementation.md`](gateway-implementation.md) is baseline and was
not reimplemented here.

## Delivered

### Contract and admission

- `GET /v1/gateway/capabilities` is authenticated with the same loopback bearer
  key as the other gateway endpoints. It reports the fixed `pilink` model,
  compatibility/strict profiles, buffered streaming, unavailable usage, and the
  fact that strict schema enforcement is not implemented.
- Compatibility remains the default and preserves the previously accepted Pi
  payload controls. Responses add bounded, metadata-only
  `X-PiLink-Gateway-Warnings` tokens for ignored controls, `strict:true`,
  `response_format`, and unavailable usage. No warning contains a prompt,
  argument, model value, API key, or other request value.
- Strict is opt-in with `PI_LLM_GATEWAY_PROFILE=strict` or the authenticated
  request header `X-PiLink-Gateway-Profile: strict`. A compatibility server can
  opt an individual request into strict; a strict server cannot be downgraded.
  Unsupported generation controls, `stream_options`, `response_format`, and
  function `strict:true` fail with OpenAI-style parameter errors before
  availability checks or enqueue. This is narrow validation, not a JSON-Schema
  engine.
- Unknown models fail before enqueue, `n` is accepted only as `1`, and accepted
  responses always return `model: "pilink"`. Compatibility retains zero-valued
  `usage` fields solely for existing client compatibility and labels usage as
  unavailable; strict responses omit usage. No usage is fabricated or suitable
  for accounting.
- `stream=true` remains buffered. `X-PiLink-Gateway-Stream: buffered` is
  additive metadata; no native token stream, token-like heartbeat, or fake
  progress is claimed.
- Authentication runs before JSON parsing. The HTTP body is capped at 2 MiB;
  malformed and oversized authenticated bodies return bounded JSON errors and
  never enqueue work. Existing normalized message/tool limits remain in force.

The default admission path remains unchanged: there is no new no-poller
fail-fast rule. Queue deadlines, cancellation, claim tokens, replay, and
caller-side tool execution boundaries remain owned by the existing store/MCP
protocol.

### Readiness and startup

`StartedGatewayApi.ready` now resolves only after the API has successfully
listened. Its `port` and `baseUrl` are updated from the actual bound address,
including port `0`; endpoint logs are emitted only after the `listening` event.
A bind error, including `EADDRINUSE`, rejects readiness and does not publish a
ready endpoint. Close handles partially bound/failed servers without killing
unrelated listeners.

Gateway runtime readiness now awaits durable store activation, API readiness,
and an authenticated local `/v1/models` probe. That probe has a 3-second,
unref'd deadline covering response-body consumption and aborts on expiry; it
does not retry or switch hosts. The main server's launcher-ready event is gated
on that promise. A store, bind, or local-probe failure therefore prevents the
MCP parent from reporting ready and closes the gateway API rather than becoming
an stderr-only warning. No live listener is auto-killed or restarted.

`StartedGatewayApi.close()` is lifecycle-coordinated: it cancels a pending
listen/DNS bind instead of treating `server.listening === false` as already
closed, rejects pre-ready `ready` with `ERR_GATEWAY_CLOSED`, and returns one
idempotent promise to concurrent callers. Endpoint logs remain after a normal
successful bind only. These close and readiness guarantees are covered by the
startup regressions below.

The concurrent store-owned observational projection is now surfaced by the
existing authenticated `GET /v1/gateway/status` endpoint: `worker_polling` and
`pending_worker_polls` describe in-process exchange waits;
`worker_contact` is `recent`, `stale`, or `never`; `processing_claim` means a
claim exists but does not prove model progress; `claim_age_ms` and
`lease_expires_at` describe the current claim; `oldest_queue_age_ms` describes
queued work; and `next_action` gives bounded guidance such as `wake_worker`,
`wait_for_worker`, `poll`, `inspect_claim`, or `none`. These are observational
only and do not change default admission or claim ownership.

## Files in this slice

- `src/llm-gateway-api.ts`: capabilities, profiles, validation, warning/usage/
  streaming metadata, fixed model responses, bounded JSON/body errors, and
  awaitable bind readiness.
- `src/llm-gateway-runtime.ts`: profile configuration, prompt-safe startup
  promise handling, and bounded store/API/model probe readiness.
- `src/llm-gateway-store.ts`: durable gateway activation and the observational
  status projection surfaced by the API.
- `src/index.ts`: launcher-ready gating and suppression of the startup banner
  until gateway startup succeeds.
- `test/llm-gateway-api.test.mjs`: contract, pre-enqueue, authentication, and
  body-limit regressions, preserving the existing first-release tests.
- `test/llm-gateway-startup.test.mjs`: port-0 readiness/close cancellation,
  concurrent and occupied-failure close safety, bounded body-probe abort,
  actual base URL, local model reachability, store failure, and the real index
  startup gate.
- `test/llm-gateway-store.test.mjs` and
  `test/llm-gateway-observability.test.mjs`: durable transition and
  observational readiness/status coverage.
- `docs/operations/llm-gateway.md` and `.env.example`: operator contract.

## Verification and boundary

The following ran against a fresh `npm run build:core` output (tests import the
freshly built `dist`, not stale output):

- `npm run build:core` — passed.
- `./node_modules/.bin/tsc --noEmit` — passed.
- `node --test test/llm-gateway*.test.mjs test/chat.test.mjs
  test/progress.test.mjs test/work-loop.test.mjs test/mcp-work-loop.test.mjs`
  — **103/103 passed** (the prior 100-test baseline plus three corrective
  startup/probe regressions).
- Relevant CLI/runtime run — **60/60 passed**:
  `node --test test/llm-gateway-connect.test.mjs
  test/llm-gateway-output.test.mjs test/llm-gateway-ports.test.mjs
  test/cli-guided-setup.test.mjs test/chat-cli.test.mjs
  test/terminal-output.test.mjs test/package-scripts.test.mjs
  test/runtime-mode-selection.test.mjs test/runtime-version.test.mjs`.
- Focused API/startup subset — **20/20 passed**:
  `node --test test/llm-gateway-api.test.mjs
  test/llm-gateway-startup.test.mjs`.
- `git diff --check` — passed.

No full `npm test` run is claimed; the known full-suite cleanup behavior is
recorded in `gateway-implementation.md`. No live ChatGPT/MCP continuation or
third-party behavior was tested. The local index-process regression verifies
that an asynchronous occupied API bind emits no launcher-ready event, no
startup banner, and no unhandled Node bind stack. A companion process test
covers malformed durable-store activation failure through the same gate.

Deferred from this slice: optional admission fast-fail/grace, idempotency,
reconnect grace/worker epochs, schema validation or repair, native streaming,
backpressure, caching, provider fallback, durable context handoffs, process
crash recovery, and live smoke/benchmark work. No dependency, provider, SDK,
OAuth, loopback, or tool execution boundary changes were made.
