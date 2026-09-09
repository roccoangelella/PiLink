# ChatGPT LLM Gateway

PiLink bridges an interactive ChatGPT web conversation as a local, private OpenAI-compatible model provider (`http://127.0.0.1:3210/v1`) via reverse-RPC over an OAuth/SSE MCP transport, requiring no browser automation or scraping.

## Launcher Modes

PiLink provides four launcher workflows:
1. **Single agent** (`pilink start --mode single`): Dedicated single-agent workspace MCP bridge.
2. **VS Code** (`pilink start --mode vscode`): Graphical launcher and extension controls.
3. **Agents chat** (`pilink start --mode collaboration`): Shared multi-agent chat, task coordination, and memory.
4. **CLI pilink-endpoint** (`pilink start --mode cli` / `pilink serve --mode cli`, or the equivalent `pilink gateway start` / `serve`): Pins runtime to least-privileged `single` mode, replaces workspace tools with gateway protocol tools (`gateway_exchange`, `gateway_call_local_tool`), and exposes the OpenAI-compatible loopback API.

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
- **Accepted Tuning Parameters**: Parameters like `temperature`, `top_p`, `max_tokens`, `seed`, `stop`, and `presence_penalty` are accepted by schema validation to prevent client errors, but they are not guaranteed or forwarded; ChatGPT manages its own generation parameters.
- **Buffered Streaming**: When `stream: true`, PiLink buffers ChatGPT's complete response before emitting standard OpenAI Server-Sent Events (`text/event-stream`), as ChatGPT web does not stream tokens over MCP. Token usage counts return zeros (`0`).
- **Endpoints**: `POST /v1/chat/completions`, `GET /v1/models`, `GET /v1/models/pilink`, `GET /v1/gateway/status`, `POST /v1/gateway/release`.

## Security & Operational Caveats
- **Loopback Isolation**: The local API binds strictly to `127.0.0.1` and authenticates callers via `PI_LLM_GATEWAY_API_KEY`.
- **Untrusted Payloads & Prompt Injection**: Workspace tools are removed in gateway mode, preventing direct server filesystem or shell access. While PiLink isolates gateway transport tokens, avoid absolute guarantees that untrusted messages cannot access caller tokens: prompt injection remains a risk in the caller harness if model outputs or tool arguments are evaluated without caller-side validation.

## Troubleshooting & Environment Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PI_LLM_GATEWAY_PORT` | `PORT + 10` | Fixed local API port (default `3210`; auto-falls back to next free pair). |
| `PI_LLM_GATEWAY_API_KEY` | Derived HMAC | Static bearer token. Defaults to an HMAC derived from `JWT_SECRET`. |
| `PI_LLM_GATEWAY_REQUEST_TIMEOUT_SECONDS` | `600` | Client request wait time before returning HTTP 504. |
| `PI_LLM_GATEWAY_CLAIM_LEASE_SECONDS` | `600` | Lease duration for a claimed request before returning to queue. |
| `PI_LLM_GATEWAY_STALE_SECONDS` | `120` | Worker inactivity threshold before session is marked stale. |
| `PILINK_TERMINAL_LOGS` | `compact` | Set to `verbose` to display raw tunnel, HTTP, and MCP traffic. |

| Error / Command | Cause & Resolution |
|---|---|
| **HTTP 401 `invalid_api_key`** | Missing or incorrect bearer token. Set `Authorization: Bearer $PI_LLM_GATEWAY_API_KEY`. |
| **HTTP 503 `pilink_chat_inactive`** | Worker loop inactive. Send `@PiLink wake` in the connected ChatGPT conversation. |
| **HTTP 504 `gateway_timeout`** | Worker did not finish within timeout. Check ChatGPT conversation or increase timeout. |
| **OAuth DCR Expired** | 5-minute registration window closed. Run `pilink gateway connect` to reopen it. |
| **Port Conflicts** | Default port `3210` in use. Auto-allocates next free pair, or pin with `PI_LLM_GATEWAY_PORT`. |
| **`pilink gateway status`** | Inspect queue length, worker state, and active session lease. |
| **`pilink gateway release`** | Instructs ChatGPT to exit the `gateway_exchange` loop cleanly (`state=released`). |
