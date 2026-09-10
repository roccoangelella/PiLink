# ChatGPT LLM Gateway

PiLink bridges an interactive ChatGPT web conversation as a local, private OpenAI-compatible model provider (`http://127.0.0.1:3210/v1`) via reverse-RPC over an OAuth/SSE MCP transport, requiring no browser automation or scraping.

## Launcher modes

PiLink provides three CLI launcher workflows:
1. **Single agent** (`pilink start --mode single`): Dedicated single-agent workspace MCP bridge.
2. **Agents chat** (`pilink start --mode collaboration`): Shared multi-agent chat, task coordination, and memory.
3. **CLI pilink-endpoint** (`pilink start --mode cli` / `pilink serve --mode cli`, or the equivalent `pilink gateway start` / `serve`): Pins runtime to least-privileged `single` mode, replaces workspace tools with gateway protocol tools (`gateway_exchange`, `gateway_call_local_tool`), and exposes the OpenAI-compatible loopback API.

PiLink for VS Code is installed separately with `pilink install-vscode-plugin`; it is not a gateway or runtime launch mode.

## Setup & Connection

### 1. Launch the Gateway
```bash
pilink start --mode cli       # equivalent: pilink gateway start
# Existing reverse proxy: pilink serve --mode cli (or: pilink gateway serve)
```
When ready, the CLI displays connection details:
```text
Connection details
  ChatGPT MCP   https://<domain>/sse
  Local API     http://127.0.0.1:3210/v1
  API key       plg_...
  OAuth setup   pilink gateway connect
  Wake          @PiLink wake
```

### 2. Connect ChatGPT
1. In ChatGPT, add a custom MCP connection using the printed **ChatGPT MCP** URL.
2. Select **OAuth** and **Dynamic Client Registration (DCR)**.
3. Approve the connection in the terminal within the 5-minute DCR window (run `pilink gateway connect` to reopen DCR if expired; headless setups can use the printed one-time pairing URL).

### 3. Wake Worker Loop
In the connected ChatGPT conversation, send:
```text
@PiLink wake
```
ChatGPT invokes `gateway_exchange` to poll for jobs. When `state=idle` (`continue=true`), it immediately re-polls without user output; when `state=request`, it processes the prompt. Exactly one active ChatGPT conversation acts as the worker at a time. Use `pilink gateway release` to exit the loop cleanly.

## OpenAI API & Tool Calling

### Test Completion Request
Set `export PI_LLM_GATEWAY_API_KEY` to the key printed at startup:
```bash
export PI_LLM_GATEWAY_API_KEY="plg_..."
curl http://127.0.0.1:3210/v1/chat/completions \
  -H "Authorization: Bearer $PI_LLM_GATEWAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "pilink",
    "messages": [{"role": "user", "content": "Explain async/await in Rust in one sentence."}]
  }'
```

### Tool Calling Bridge & Permissions
Callers can supply standard OpenAI function definitions in `tools`:
```json
{
  "model": "pilink",
  "messages": [{"role": "user", "content": "Check git status"}],
  "tools": [{
    "type": "function",
    "function": {
      "name": "bash",
      "description": "Execute shell command locally",
      "parameters": {
        "type": "object",
        "properties": {
          "command": {"type": "string"}
        },
        "required": ["command"]
      }
    }
  }],
  "tool_choice": "auto"
}
```
ChatGPT calls `gateway_call_local_tool`, and PiLink returns an OpenAI envelope with `finish_reason: "tool_calls"`.
- **Local execution permissions caveat**: Functions are never executed by PiLink or exposed directly to ChatGPT. Your local agent harness (e.g., Pi Agent) executes them locally under its own system permissions, then submits the output with `role: "tool"`. High-risk server flags like `--allow-unsafe-full-access` are disallowed.

### Protocol Behaviors & Limitations
- **Authenticated capabilities**: `GET /v1/gateway/capabilities` reports the active profile and this contract without exposing prompts, arguments, or credentials. Compatibility is the default. Send `X-PiLink-Gateway-Profile: strict` for a stricter request, or set `PI_LLM_GATEWAY_PROFILE=strict` to make strict the server default; a strict server cannot be downgraded by a request header.
- **Compatibility profile**: Existing Pi clients may continue sending ignored controls such as `temperature`, `top_p`, `max_completion_tokens`, and `store`. Accepted requests add bounded `X-PiLink-Gateway-Warnings` tokens naming ignored controls, unavailable usage, `strict:true`, or `response_format`; warning values never contain request data. `n` is supported only as `1`, and accepted responses always say `model: "pilink"`.
- **Strict profile**: Unsupported/ignored generation controls, `stream_options` (usage is unavailable), `response_format`, and function `strict:true` are rejected before enqueue with OpenAI-style parameter errors. This slice performs narrow request/type/size checks and does not implement a JSON-Schema engine or structured-output validation.
- **Buffered Streaming**: When `stream: true`, PiLink buffers ChatGPT's complete response before emitting standard OpenAI Server-Sent Events (`text/event-stream`), as ChatGPT web does not stream tokens over MCP. `X-PiLink-Gateway-Stream: buffered` makes this explicit; native token streaming is not claimed.
- **Usage**: Usage is unavailable. New strict responses omit `usage`; compatibility responses retain zero-valued usage fields solely for proven legacy client compatibility and include `X-PiLink-Gateway-Usage: unavailable`. These values are not measured accounting and must not be used for billing.
- **Request limits and errors**: Bearer authentication runs before JSON parsing. The HTTP body is capped at 2 MiB; normalized protocol limits also cap messages and tools. Authenticated malformed or oversized bodies return JSON `400`/`413` errors without enqueueing work.
- **Delivery and retries**: A worker has one outstanding claimed delivery. The claim and accepted completion are durable; an ambiguous poll or completion response can be retried, but transport-timeout retries are limited to three exact MCP calls. A retry of a completion that originally returned the next request replays that same request instead of claiming another job. Replay metadata survives gateway activation/restart and repairs a requeued next claim with a fresh token, but a restarted API process does not resume an orphaned local HTTP caller. The worker identity is derived from the OAuth client, not the ChatGPT thread, so separate conversations using one connector are not isolated.
- **Recovery calls**: `request_cancelled`/`poll` and `stale_claim`/`resync` both mean `gateway_exchange` with only a bounded `maximum_wait_seconds`; discard any old completion envelope first. For `worker_busy`/`bounded_wait`, do not retry the wrong completion: poll with waits of 5, then 10, then 20 seconds at most. If it persists, stop and have an operator inspect the status and reconnect/wake the worker. PiLink cannot wake ChatGPT or keep it generating by itself.
- **Readiness and observation**: `active` means recent gateway contact or a live claim lease, not that ChatGPT is currently generating or that a model is listening. A queued request can still time out if the worker conversation is asleep. The authenticated status projection also exposes `worker_polling`, `pending_worker_polls`, `worker_contact` (`recent`, `stale`, or `never`), `processing_claim`, optional `claim_age_ms`/`lease_expires_at`, `oldest_queue_age_ms`, and bounded `next_action` guidance. A claim is unconfirmed model progress; these fields do not enable fail-fast admission by default.
- **Endpoints**: `POST /v1/chat/completions`, `GET /v1/models`, `GET /v1/models/pilink`, `GET /v1/gateway/capabilities`, `GET /v1/gateway/status`, `POST /v1/gateway/release`. All gateway endpoints require the loopback bearer key.

## Security & Operational Caveats
- **Loopback Isolation**: The local API binds strictly to `127.0.0.1` and authenticates callers via `PI_LLM_GATEWAY_API_KEY`.
- **Untrusted Payloads & Prompt Injection**: Workspace tools are removed in gateway mode, preventing direct server filesystem or shell access. While PiLink isolates gateway transport tokens, avoid absolute guarantees that untrusted messages cannot access caller tokens: prompt injection remains a risk in the caller harness if model outputs or tool arguments are evaluated without caller-side validation.

## Troubleshooting & Environment Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PI_LLM_GATEWAY_PORT` | `PORT + 10` | Fixed local API port (default `3210`; auto-falls back to next free pair). |
| `PI_LLM_GATEWAY_API_KEY` | Derived HMAC | Static bearer token. Defaults to an HMAC derived from `JWT_SECRET`. |
| `PI_LLM_GATEWAY_REQUEST_TIMEOUT_SECONDS` | `600` | Absolute local API wait deadline, including queue time, before returning HTTP 504. |
| `PI_LLM_GATEWAY_PROFILE` | `compatibility` | Contract profile. `strict` is an explicit opt-in that rejects unsupported controls before enqueue. |
| `PI_LLM_GATEWAY_QUEUE_TIMEOUT_SECONDS` | `60` | Absolute admission/wake deadline while a request remains queued; the effective value is bounded by the request timeout. |
| `PI_LLM_GATEWAY_CLAIM_LEASE_SECONDS` | `900` | Durable claim lease before an uncompleted request returns to the queue. Runtime uses at least this default and does not make a lease a model-progress signal. |
| `PI_LLM_GATEWAY_STALE_SECONDS` | `120` | Worker inactivity threshold before session is marked stale. |
| `PILINK_TERMINAL_LOGS` | `compact` | Set to `verbose` to display raw tunnel, HTTP, and MCP traffic. |

| Error / Command | Cause & Resolution |
|---|---|
| **HTTP 401 `invalid_api_key`** | Missing or incorrect bearer token. Set `Authorization: Bearer $PI_LLM_GATEWAY_API_KEY`. |
| **HTTP 400/413 `invalid_request_error`** | Malformed JSON or a request body over the 2 MiB limit. Correct the request; no job was enqueued. |
| **HTTP 503 `pilink_chat_inactive`** | Worker loop inactive. Send `@PiLink wake` in the connected ChatGPT conversation. |
| **HTTP 504 `gateway_timeout`** | The absolute request or queue deadline elapsed. Check ChatGPT conversation; increasing timeouts does not wake a stopped worker. |
| **MCP `worker_busy` / persistent transport timeout** | Discard the wrong or stale completion, use the finite no-completion recovery polls, then inspect `pilink gateway status` and reconnect/wake the single worker if needed. Do not run an unbounded retry loop. |
| **OAuth DCR Expired** | 5-minute registration window closed. Run `pilink gateway connect` to reopen it. |
| **Port Conflicts** | Gateway launch preflights a free MCP/API pair when no explicit API port is pinned. The API readiness promise still rejects `EADDRINUSE`; it never prints a ready endpoint for an occupied port. |
| **`pilink gateway status`** | Inspect queue length, worker state, and active session lease. |
| **`pilink gateway release`** | Instructs ChatGPT to exit the `gateway_exchange` loop cleanly (`state=released`). |
