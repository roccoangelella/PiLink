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
pilink gateway start        # set up and start the gateway; uses ~/.config/pilink/.env by default
# Existing reverse proxy: pilink gateway serve
# For a separate gateway instance, set PILINK_CONFIG to its own private .env.
```
When ready, the CLI displays connection details. If the gateway is already running, use `pilink gateway status` instead of starting a second copy. Run **`pilink-cli` from any project directory** to launch Pi Agent there with the PiLink gateway as its model. If a previously configured fixed-domain gateway is stopped, `pilink-cli` starts one detached gateway and waits for its authenticated MCP and model API; it refuses occupied or impersonated ports instead of moving the Cloudflare origin. The launcher maintains only Pi's own `pilink` model entry. The gateway supplies model responses, while Pi Agent's file and shell tools execute locally as your user; `--allow-unsafe-full-access` is not applicable to gateway mode. If ChatGPT's worker is disconnected, send the exact wake message shown below; the browser extension can send it after its one-time approval.
```text
Connection details
  ChatGPT MCP   https://<domain>/sse
  Local API     http://127.0.0.1:3210/v1
  API key       plg_...
  OAuth setup   pilink gateway connect
  Wake          @PiLink Gateway wake up
```

### 2. Connect ChatGPT
1. In ChatGPT, add a custom MCP connection using the printed **ChatGPT MCP** URL, with the exact display name **PiLink Gateway** (distinct from any full-access PiLink Desktop connector). The browser wake message targets that exact name.
2. Select **OAuth** and **Dynamic Client Registration (DCR)**.
3. Approve the connection in the terminal within the 5-minute DCR window (run `pilink gateway connect` to reopen DCR if expired; a headless service needs the printed one-time owner pairing URL and local verification code).

### 3. Wake Worker Loop
In the connected ChatGPT conversation, send:
```text
@PiLink Gateway wake up
```
ChatGPT invokes `gateway_exchange` to poll for jobs. When `state=idle` (`continue=true`), it immediately re-polls without user output; when `state=request`, it processes the prompt. Exactly one active ChatGPT conversation acts as the worker at a time. Use `pilink gateway release` to exit the loop cleanly.

### Experimental Chrome/Brave browser wake (CLI endpoint)

`npm run build` compiles the gateway and builds a small Manifest V3 extension in `dist/browser-extension`. It does **not** silently install browser code or alter the logged-in browser profile. Interactive `pilink gateway start` now automatically offers the one-time extension setup; the first `pilink-cli` auto-start also prepares its files. Run `pilink gateway browser-extension` to revisit those instructions: PiLink copies the extension to a stable private user-data directory and opens Chrome/Brave's Extensions page. Enable **Developer mode**, select **Load unpacked**, and choose the printed directory. Return to the terminal and type `yes` after the browser shows the extension as enabled. The same one-time setup writes `PI_LLM_GATEWAY_AUTO_WAKE=true` in the private PiLink configuration; a running gateway enables wake within a few seconds without a restart. In non-interactive sessions, run `pilink gateway browser-extension --enable` only after verifying the browser extension yourself. The one-time browser approval cannot be replaced by npm build on an ordinary Chrome/Brave profile. Subsequent `npm run build` invocations from this same, approved checkout refresh the stable unpacked files automatically; reload the extension in the browser (or restart the browser) to activate a changed content script. A different test clone cannot silently overwrite the installed extension.

The extension requests no network or extra browser permissions beyond its declared ChatGPT content-script host match. It is injected only on `https://chatgpt.com/*` and does nothing unless the page is `/` with exactly `q=@PiLink Gateway wake up` and a new 128-bit PiLink wake nonce. After ChatGPT consumes `q` to pre-fill, it also accepts the same root URL with only the original nonce remaining; other navigation or query changes fail closed. It captures the authorized URL at `document_start` (before ChatGPT can consume `?q=`), then waits up to 15 seconds for one composer containing exactly that phrase, focuses it and clicks one uniquely identified enabled send button, preferably in the editor form. It recognizes the current `composer-submit-button` ID/test ID as well as the older send selectors, with a same-form-only, send-labelled submit fallback. Other labelled submit controls fail closed. If the UI is ambiguous or changes, or a document-level send button belongs to another form, it does not click. It never reads cookies, chat history, unrelated messages or credentials; the only DOM text inspected is the pre-filled composer. On a nonce-tagged wake page it also displays a small diagnostic badge with fixed labels (for example: editor not found, phrase not ready, button not found or clicked). It never displays prompt contents or the nonce. If no badge appears after opening a new nonce-tagged URL, verify that the extension is enabled in this browser profile and reload it on the Extensions page after a source update. It does not bypass login, CAPTCHA, Cloudflare or the ChatGPT connector's permissions. A content script can run without sending global keys or stealing window focus on Wayland/X11; background submission should be rechecked after browser or ChatGPT UI updates.

When gateway status reports `next_action="wake_worker"` for queued work, or after a previously active worker disconnects, PiLink opens a new chat using the **existing default browser profile**. Brave uses a new window in the existing profile; other browsers use `xdg-open`. The extension attempts the one-time submit, while the gateway confirms success only when ChatGPT contacts `gateway_exchange`. It makes at most one attempt per persistent wake condition. Browser DOM changes, an unavailable extension or a detached ChatGPT connector still require manual wake. The old un-targeted `ydotool` Enter path is removed.

**Live smoke test passed in Brave (2026-09-26):** With the gateway running, a fresh nonce-tagged `?q=` URL in the existing profile displayed the extension's one-click badge, showed the wake message sent once, and changed `pilink gateway status` from `waiting_for_chatgpt` to `active` with a new exchange. This verifies that the browser-side click can reach the connector in this setup; it does not guarantee future ChatGPT UI changes will work. After rebuilding, reload the installed extension on `brave://extensions` and repeat the check with `https://chatgpt.com/?q=%40PiLink%20Gateway%20wake%20up&pilink_wake=<32-new-lowercase-hex-digits>`. A badge reporting a click alone is **not** proof of connector delivery; confirm worker contact in `pilink gateway status` or gateway logs. If verification fails, disable auto-wake (`PI_LLM_GATEWAY_AUTO_WAKE=false`) and send the wake message manually; do not substitute global keystrokes.

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
| `PI_LLM_GATEWAY_AUTO_WAKE` | `false` until browser approval | Interactive gateway setup offers browser loading automatically. Set to `true` only after loading the extension in Chrome/Brave (or use `pilink gateway browser-extension --enable` after confirming it). A running gateway applies the confirmed change within a few seconds; an auto-started gateway that prompts before starting applies it immediately. |
| `PILINK_TERMINAL_LOGS` | `compact` | Set to `verbose` to display raw tunnel, HTTP, and MCP traffic. |

| Error / Command | Cause & Resolution |
|---|---|
| **HTTP 401 `invalid_api_key`** | Missing or incorrect bearer token. Set `Authorization: Bearer $PI_LLM_GATEWAY_API_KEY`. |
| **HTTP 400/413 `invalid_request_error`** | Malformed JSON or a request body over the 2 MiB limit. Correct the request; no job was enqueued. |
| **HTTP 503 `pilink_chat_inactive`** | Worker loop inactive. Send `@PiLink Gateway wake up` in the connected ChatGPT conversation. |
| **HTTP 504 `gateway_timeout`** | The absolute request or queue deadline elapsed. In Linux CLI mode, check whether the Chrome/Brave wake extension is enabled and whether the ChatGPT connector actually contacted the gateway. |
| **MCP `worker_busy` / persistent transport timeout** | Discard the wrong or stale completion, use the finite no-completion recovery polls, then inspect `pilink gateway status` and reconnect/wake the single worker if needed. Do not run an unbounded retry loop. |
| **OAuth DCR Expired** | 5-minute registration window closed. Run `pilink gateway connect` to reopen it. |
| **Port Conflicts** | Gateway launch preflights a free MCP/API pair when no explicit API port is pinned. The API readiness promise still rejects `EADDRINUSE`; it never prints a ready endpoint for an occupied port. |
| **`pilink gateway status`** | Inspect queue length, worker state, and active session lease. |
| **`pilink gateway release`** | Instructs ChatGPT to exit the `gateway_exchange` loop cleanly (`state=released`). |
