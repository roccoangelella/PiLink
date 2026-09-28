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
When ready, the CLI displays connection details. If the gateway is already running, use `pilink gateway status` instead of starting a second copy. Run **`pilink-cli` from any project directory** to launch Pi Agent there with the PiLink gateway as its model. If a previously configured fixed-domain gateway is stopped, `pilink-cli` starts one detached gateway and waits for its authenticated MCP and model API; it refuses occupied or impersonated ports instead of moving the Cloudflare origin. Concurrent launches share one startup lock; a later run recovers a lock left by a dead launcher without interrupting a live one. The launcher maintains only Pi's own `pilink` model entry. The gateway supplies model responses, while Pi Agent's file and shell tools execute locally as your user; `--allow-unsafe-full-access` is not applicable to gateway mode. If ChatGPT's worker is disconnected, send the exact wake message shown below; the browser extension can send it after its one-time approval.
```text
PiLink Gateway — Step 1: connect ChatGPT
Connection details
  Name          PiLink Gateway
  ChatGPT MCP   https://<domain>/sse
  Local API     http://127.0.0.1:3210/v1
  API key       plg_...
  Retry OAuth   pilink gateway connect (if the 5-minute window expires)
  Next          Browser wake setup appears only after ChatGPT finishes connecting.
```

### 2. Connect ChatGPT
1. At the interactive gateway prompt, enter the exact display name you will give this ChatGPT MCP connection (default: **PiLink Gateway**, distinct from any full-access PiLink Desktop connector). In ChatGPT, add a custom MCP connection with that name and the printed **ChatGPT MCP** URL. Headless setup uses the default unless `PI_LLM_GATEWAY_CONNECTOR_NAME` is set before start.
2. Select **OAuth** and **Dynamic Client Registration (DCR)**.
3. Watch the gateway terminal for the **ChatGPT OAuth approval** prompt and reply `y` within **90 seconds**, only if you initiated the connection. The registration window lasts 5 minutes; run `pilink gateway connect` to reopen it if expired. A headless service instead needs the printed one-time owner pairing URL and verification code. Browser extension setup does not prompt until ChatGPT has received an OAuth token.
4. If ChatGPT shows `access_denied`, the new OAuth client may have been disabled after a declined/expired approval. Remove that failed connection in ChatGPT, run `pilink gateway connect`, and add the connection again. Do not confuse the OAuth `y` prompt with browser auto-wake: the latter needs no `yes`.

### 3. Wake Worker Loop
In the connected ChatGPT conversation, send the **Wake** message printed by your gateway (for the default name):
```text
@PiLink Gateway wake up
```
ChatGPT invokes `gateway_exchange` to poll for jobs. When `state=idle` (`continue=true`), it immediately re-polls without user output; when `state=request`, it processes the prompt. Exactly one active ChatGPT conversation acts as the worker at a time. Use `pilink gateway release` to exit the loop cleanly.

### Experimental Chrome/Brave browser wake (CLI endpoint)

`npm run build` compiles the gateway and builds a small Manifest V3 extension in `dist/browser-extension`. It does **not** silently install browser code or alter the logged-in browser profile. Interactive `pilink gateway start` offers browser setup **only after ChatGPT completes OAuth and receives a token**; if the connection takes longer than 5 minutes, finish it and run `pilink gateway browser-extension` later. PiLink stages the extension in a stable private user-data directory and opens the Extensions page. In `brave://extensions` or `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, select the printed **directory** (not `manifest.json`), and keep PiLink Wake enabled. Press Enter in the setup terminal to check it. When PiLink detects the enabled extension in the default browser profile, it turns on auto-wake automatically, without asking for `yes`. Browser approval cannot be bypassed by npm. If connection name or extension files change, PiLink pauses wake until you click Reload on its browser card and press Enter. For non-default profiles that PiLink cannot detect, verify it is enabled yourself before explicitly using `pilink gateway browser-extension --enable`. After you press Enter, PiLink waits up to five seconds for Brave/Chrome to save the extension's enabled state; if it still cannot detect the extension, press Enter again after checking the Extensions page. The setup writes `PI_LLM_GATEWAY_AUTO_WAKE=true` in the private PiLink configuration. During interactive `pilink gateway start`, the gateway was started for this setup and picks up the setting within a few seconds; from a separate `pilink gateway browser-extension` command it may not be running. To start it again later, run `pilink gateway start`, and use `pilink gateway status` to check it. After rebuilding, reload the browser extension to activate updated content scripts. A different test clone cannot silently overwrite the installed extension.

The extension requests no network or extra browser permissions beyond its declared ChatGPT content-script host match. It is injected only on `https://chatgpt.com/*` and does nothing unless the page is `/` with exactly `q=@<configured connection name> wake up` and a new 128-bit PiLink wake nonce; the staged content script pins that exact phrase. After ChatGPT consumes `q` to pre-fill, it also accepts the same root URL with only the original nonce remaining; other navigation or query changes fail closed. It captures the authorized URL at `document_start` (before ChatGPT can consume `?q=`), then waits up to 15 seconds for one composer containing exactly that phrase, focuses it and clicks one uniquely identified enabled send button, preferably in the editor form. It recognizes the current `composer-submit-button` ID/test ID as well as the older send selectors, with a same-form-only, send-labelled submit fallback. Other labelled submit controls fail closed. If the UI is ambiguous or changes, or a document-level send button belongs to another form, it does not click. It never reads cookies, chat history, unrelated messages or credentials; the only DOM text inspected is the pre-filled composer. On a nonce-tagged wake page it also displays a small diagnostic badge with fixed labels (for example: editor not found, phrase not ready, button not found or clicked). It never displays prompt contents or the nonce. If no badge appears after opening a new nonce-tagged URL, verify that the extension is enabled in this browser profile and reload it on the Extensions page after a source update. It does not bypass login, CAPTCHA, Cloudflare or the ChatGPT connector's permissions. A content script can run without sending global keys or stealing window focus on Wayland/X11; background submission should be rechecked after browser or ChatGPT UI updates.

When gateway status reports `next_action="wake_worker"` for queued work, or after a previously active worker disconnects, PiLink opens a new chat using the **existing default browser profile**. A queued request also triggers wake after five seconds without a worker poll **and** five seconds without a gateway exchange, even if the last contact still counts as `recent`: the default 60-second queue deadline is shorter than the 120-second contact-staleness threshold. Live worker polls and active claims suppress this early wake. Brave uses a new window in the existing profile; on KDE/Wayland, PiLink tries to restore the previously focused window after Brave appears, without sending keyboard input. A brief focus flash is possible; disable this experiment with `PI_LLM_GATEWAY_RESTORE_FOCUS=false` if necessary. Other browsers use `xdg-open`. The extension attempts the one-time submit, while the gateway confirms success only after **new** ChatGPT contact at `gateway_exchange`, not merely because status still reports an earlier recent contact. It makes at most one bounded attempt while a wake condition stays unchanged; fresh gateway contact or a new queued episode can rearm it, and a failed idle reconnect does not suppress a later request. Browser DOM changes, an unavailable extension or a detached ChatGPT connector still require manual wake. The old un-targeted `ydotool` Enter path is removed.

**Experimental background wake trial (KDE/Wayland, 2026-09-27):** Before PiLink Wake was installed in Brave, the URL prefilled the editor but did not submit; prefill alone does not show that the extension ran. After installation, an operator confirmed that a real Brave wake stayed behind the previous app and the wake message was visibly sent; the gateway recorded `worker_contact=recent` and `state=active` after ~16s. The separate API completion was aborted after ~68s without a response: do not claim end-to-end completion success. This real browser result remains distinct from the synthetic fixtures in `test/background-wake-lab/`, which run in isolated temporary profiles against local intercepted pages.

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
| `PI_LLM_GATEWAY_AUTO_WAKE` | `false` until browser approval | Gateway setup stages the extension and detects it once loaded in the default Chrome/Brave profile. The detected installation enables wake without another confirmation; manual `--enable` is the fallback when detection is unavailable. A running gateway applies the change within a few seconds. |
| `PI_LLM_GATEWAY_RESTORE_FOCUS` | `true` on KDE/Wayland | Controls experimental KWin focus restoration leaving Brave behind the prior application. Set to `false` to disable. |
| `PILINK_TERMINAL_LOGS` | `compact` | Set to `verbose` to display raw tunnel, HTTP, and MCP traffic. |

| Error / Command | Cause & Resolution |
|---|---|
| **HTTP 401 `invalid_api_key`** | Missing or incorrect bearer token. Set `Authorization: Bearer $PI_LLM_GATEWAY_API_KEY`. |
| **HTTP 400/413 `invalid_request_error`** | Malformed JSON or a request body over the 2 MiB limit. Correct the request; no job was enqueued. |
| **HTTP 503 `pilink_chat_inactive`** | Worker loop inactive. Send the gateway's printed `@<connection name> wake up` message in the connected ChatGPT conversation. |
| **HTTP 504 `gateway_timeout`** | The absolute request or queue deadline elapsed. In Linux CLI mode, check whether the Chrome/Brave wake extension is enabled and whether the ChatGPT connector actually contacted the gateway. |
| **MCP `worker_busy` / persistent transport timeout** | Discard the wrong or stale completion, use the finite no-completion recovery polls, then inspect `pilink gateway status` and reconnect/wake the single worker if needed. Do not run an unbounded retry loop. |
| **OAuth DCR Expired** | 5-minute registration window closed. Run `pilink gateway connect` to reopen it. |
| **Port Conflicts** | Gateway launch preflights a free MCP/API pair when no explicit API port is pinned. The API readiness promise still rejects `EADDRINUSE`; it never prints a ready endpoint for an occupied port. |
| **`pilink gateway status`** | Inspect queue length, worker state, and active session lease. |
| **`pilink gateway release`** | Instructs ChatGPT to exit the `gateway_exchange` loop cleanly (`state=released`). |
