# ChatGPT LLM Gateway

PiLink can run a ChatGPT conversation as a local OpenAI-compatible model provider without scraping or browser automation. The ChatGPT conversation communicates only through the ordinary OAuth-protected PiLink MCP connection.

This is an explicit operator mode. It does not add a third `PI_RUNTIME_MODE`; `pilink gateway start` pins the underlying core runtime to the least-privileged `single` mode and replaces the ordinary MCP catalog with two gateway protocol tools: `gateway_exchange` and `gateway_call_local_tool`. The normal `pilink start` Single/Collaboration/VS Code chooser is therefore skipped for gateway launches.

The gateway itself never exposes filesystem, shell, edit, or workspace tools to ChatGPT. Function tools supplied by an OpenAI-compatible caller belong to that caller's local agent harness. ChatGPT selects those functions through the real MCP dispatcher `gateway_call_local_tool`; PiLink converts that structured MCP call into a normal OpenAI `assistant.tool_calls` response, and the local harness executes it under its own permissions.

## Start

```bash
pilink gateway start
```

This reuses the normal PiLink hosting and OAuth configuration. A gateway launch is also an explicit local owner action, so it opens a short five-minute ChatGPT Dynamic Client Registration (DCR) window even when another OAuth client is already stored. Existing clients are not deleted, replaced, or weakened. The registration window only permits the bounded ChatGPT DCR shape and the subsequent authorization still requires local owner approval.

If the DCR window expires before a new ChatGPT app is created, reopen it without restarting PiLink:

```bash
pilink gateway connect
```

For an operator-managed HTTPS reverse proxy, use:

```bash
pilink gateway serve
```

Gateway launches use compact terminal output by default. Raw cloudflared diagnostics, the ordinary PiLink server box, per-request HTTP logs, routine MCP session chatter, routine OAuth lifecycle messages, and duplicate gateway startup lines are hidden. Actionable failures remain visible with their technical prefix removed so they read as normal CLI errors. The ChatGPT authorization request is rendered as one compact block with client, access scope, callback, and a single `y/N` prompt.

Once startup is ready, PiLink leaves one stable `Connection details` block at the bottom of the CLI. The ChatGPT MCP URL, local OpenAI-compatible API URL, API key, OAuth reopen command, wake command, and verbose-debug command are always kept together there instead of being scattered through startup logs.

For troubleshooting, restore the complete raw runtime stream for that launch with:

```bash
PILINK_TERMINAL_LOGS=verbose pilink gateway start
```

The OpenAI-compatible API is always bound to loopback. Its default port is the PiLink MCP port plus 10, so the normal `PORT=3200` configuration produces:

```text
http://127.0.0.1:3210/v1
```

Before a gateway launch, PiLink probes both the configured MCP port and its local API port. If the pair is unavailable, it selects the next free pair. For example, if MCP port `3200` is already occupied, the normal fallback is:

```text
MCP:        127.0.0.1:3201
OpenAI API: 127.0.0.1:3211
```

The selected MCP fallback is saved as `PORT` in the active PiLink private configuration so subsequent launches and managed hosting stay consistent. PiLink continues scanning upward if `3201` or `3211` is also occupied. An explicitly configured `PI_LLM_GATEWAY_PORT` is never silently changed; startup fails if that exact API port is unavailable.

For a Cloudflare fixed domain, the public tunnel configuration must target the same local MCP port. When a fallback changes the MCP port, PiLink safely repoints only the already configured PiLink tunnel and exact hostname to the new loopback origin. This requires the same scoped Cloudflare API token used for provisioning. In an interactive terminal PiLink requests it with hidden input; in non-interactive launches set `CLOUDFLARE_API_TOKEN` for that launch. The account token is not persisted. PiLink refuses to create a replacement tunnel or overwrite unrelated ingress rules during this fallback.

PiLink prints the derived gateway API key in the compact startup footer. The key is derived from PiLink private secret material with a domain-separated HMAC; it is not the OAuth bootstrap secret and does not grant MCP/admin authority. `PI_LLM_GATEWAY_API_KEY` may be set in the private PiLink environment when an explicit independent key is preferred.

## Connect ChatGPT

Create a custom ChatGPT MCP app/connection using the MCP URL printed in the gateway footer, for example:

```text
https://mcp.example.com/sse
```

Choose OAuth and Dynamic Client Registration (DCR). PiLink accepts the secretless ChatGPT registration only while the short owner-opened DCR window is active. When ChatGPT reaches the authorization step, compact gateway output shows:

```text
ChatGPT connection request
  Client   ChatGPT
  Access   mcp:tools offline_access
  Callback https://chatgpt.com/connector/oauth/...
Approve this ChatGPT connection? [y/N]:
```

Approve only a connection you just initiated yourself. Stopping another PiLink process does not open this registration window, and an already stored OAuth client does not automatically authorize a new ChatGPT app. Use `pilink gateway connect` whenever a fresh DCR window is needed.

In a non-interactive launch where terminal approval is unavailable, PiLink prints the one-use owner pairing URL and local verification code in the compact footer; complete that pairing in the same browser used for ChatGPT before OAuth authorization.

## Wake the ChatGPT conversation

After connecting the PiLink MCP endpoint to the intended ChatGPT conversation, send a short explicit wake message such as:

```text
@PiLink wake
```

The MCP server instructions define the lifecycle. The conversation must immediately call `gateway_exchange` and then stay inside the gateway protocol until PiLink returns `state=released`. Normal assistant completions go back through `gateway_exchange`; local harness function selections go through `gateway_call_local_tool`.

A completion request finishing is **not** gateway completion. Both gateway tools atomically submit the previous assistant result and enter the next bounded long poll. If either returns `state=idle` with `continue=true`, the conversation calls `gateway_exchange` again immediately instead of reporting completion or waiting to the ChatGPT user.

Only a server-side release ends the loop:

```bash
pilink gateway release "operator finished"
```

Status is available locally with:

```bash
pilink gateway status
```

## OpenAI-compatible provider

The local provider exposes:

```text
POST /v1/chat/completions
GET  /v1/models
GET  /v1/models/pilink
```

Every route requires the gateway bearer key printed at startup. The model id `pilink` is a compatibility identifier; the actual model is the model selected in the connected ChatGPT conversation.

`POST /v1/chat/completions` supports these request fields:

- `model` — required compatibility model id;
- `messages` — `system`, `developer`, `user`, `assistant`, and `tool` messages;
- `tools` — OpenAI function tools (`type: "function"`) advertised by the local harness;
- `tool_choice` — `none`, `auto`, `required`, or one named function choice;
- `parallel_tool_calls` — when `false`, ChatGPT may return at most one function call;
- `stream` — `true` or `false`;
- `stream_options.include_usage` — accepted with `stream:true`.

Assistant history may contain `content:null` together with `tool_calls`. Tool-result messages use `role:"tool"`, `tool_call_id`, and string content. Function-call `arguments` are standard OpenAI JSON object strings.

Unsupported completion fields are rejected instead of silently pretending PiLink can enforce settings that the ChatGPT web conversation does not expose.

### Tool loop

A local agent harness can use PiLink exactly as an OpenAI-compatible function-calling model. For example, Pi Agent may send:

```json
{
  "model": "pilink",
  "messages": [
    {"role":"user","content":"List /home/ubuntu/Projects"}
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "bash",
        "description": "Execute a shell command in the local agent harness",
        "parameters": {
          "type": "object",
          "properties": {"command":{"type":"string"}},
          "required": ["command"]
        }
      }
    }
  ],
  "tool_choice": "auto",
  "stream": true
}
```

PiLink forwards the messages and tool definitions to the active ChatGPT worker as request data. The advertised `bash` function is **not** added to ChatGPT's own MCP catalog and ChatGPT must not try to execute `bash` directly. Instead, when the model decides that `bash` is needed, it makes the real MCP call:

```text
gateway_call_local_tool(
  request_id = <current request>,
  claim_token = <current claim>,
  calls = [{
    name: "bash",
    arguments: { command: "ls /home/ubuntu/Projects" }
  }]
)
```

This is a structured MCP tool invocation, not JSON emitted in assistant prose. PiLink validates the selected function against the current request, generates the OpenAI tool-call id, and returns the equivalent provider response:

```json
{
  "role": "assistant",
  "content": null,
  "tool_calls": [
    {
      "id": "call_...",
      "type": "function",
      "function": {
        "name": "bash",
        "arguments": "{\"command\":\"ls /home/ubuntu/Projects\"}"
      }
    }
  ]
}
```

The HTTP response uses `finish_reason:"tool_calls"`. The local harness then executes `bash` with its own permissions, appends the assistant tool-call message and a corresponding `role:"tool"` result, and calls `/v1/chat/completions` again. ChatGPT receives the already-executed tool output and can produce the final answer.

PiLink validates that ChatGPT can call only functions actually advertised by the current request. It also enforces named/required/none tool choices and `parallel_tool_calls:false`. The dispatcher itself does not execute any caller function. Tool descriptions, schemas, arguments, and results remain untrusted application data and cannot change the gateway lifecycle or grant PiLink capabilities.

`gateway_exchange.tool_calls` remains accepted for protocol compatibility, but the ChatGPT worker is instructed to use `gateway_call_local_tool` because it is an actual MCP action and does not require the model to synthesize an OpenAI tool-call envelope inside another tool call.

`--allow-unsafe-full-access` is intentionally not available in gateway mode. A coding agent's own harness decides whether tools such as `bash`, `read`, `write`, or `edit` exist and what they may access.

### Streaming

`stream:false` returns a normal OpenAI Chat Completion object.

`stream:true` returns OpenAI-compatible Server-Sent Events, including structured `delta.tool_calls` and a final `finish_reason`. Because a normal ChatGPT web conversation does not expose token-by-token generation through MCP, PiLink uses **buffered streaming**: it waits for the complete ChatGPT result and then serializes that result as valid OpenAI SSE chunks. This preserves compatibility with clients such as Pi Agent without pretending the web backend provides real-time token deltas.

When `stream_options.include_usage:true` is requested, the compatibility usage chunk currently reports zero token counts because ChatGPT web does not expose provider token accounting through this MCP bridge.

Simple non-stream example:

```bash
curl http://127.0.0.1:3210/v1/chat/completions \
  -H "Authorization: Bearer $PILINK_GATEWAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "pilink",
    "messages": [{"role":"user","content":"Explain this in one paragraph."}]
  }'
```

Use the endpoint printed at startup if PiLink selected a fallback port.

## Lifecycle and failure behavior

The durable private queue uses these request states:

```text
queued -> claimed -> completed
                 -> failed
queued/claimed -> cancelled
```

Each claimed request has an opaque claim token and lease. The ChatGPT MCP worker must return both the exact request ID and claim token when submitting a completion. This makes retries idempotent and prevents another OAuth worker from completing a request it did not claim.

Only one ChatGPT gateway worker is authoritative at a time. The worker identity is derived opaquely from the authenticated OAuth client rather than from an individual HTTP transport, so reconnects or transport replacement by the same ChatGPT connector do not create false competing sessions. A different fresh OAuth client is rejected while the active worker is healthy. A stale worker can be replaced; its unfinished claimed work returns to the queue.

When the final transport for the active OAuth worker disconnects, PiLink invalidates the already-running exchange and returns requests claimed by that worker to the queue. A later exchange can then activate normally without waiting for the old claim lease to expire.

The local `/v1/chat/completions` endpoint accepts new requests only while the ChatGPT gateway loop is active. If the conversation has left the loop or has never entered it, PiLink returns HTTP 503 with error type `pilink_chat_inactive` instead of leaving callers blocked indefinitely.

The gateway queue and lifecycle state are stored under PiLink private data, outside the selected workspace. They are not exposed to workspace tools.

## Local control endpoints

These loopback-only endpoints use the same gateway API key:

```text
GET  /v1/gateway/status
POST /v1/gateway/release
```

They are operational controls, not part of the OpenAI compatibility contract. `pilink gateway connect` uses the separate existing PiLink loopback admin boundary and bootstrap credential only to open the short owner registration window; it does not expose an additional public control endpoint.

## Configuration

Optional private environment settings:

```text
PI_LLM_GATEWAY_PORT=3210
PI_LLM_GATEWAY_API_KEY=<independent-local-key>
PI_LLM_GATEWAY_STALE_SECONDS=120
PI_LLM_GATEWAY_CLAIM_LEASE_SECONDS=600
PI_LLM_GATEWAY_REQUEST_TIMEOUT_SECONDS=600
PILINK_TERMINAL_LOGS=verbose
```

`PI_LLM_GATEWAY_ENABLED=true` is an internal launch flag set by `pilink gateway start`/`serve`; normal PiLink launches do not expose the gateway protocol tools or local completion endpoint.

## Security boundary

The public side remains the existing PiLink OAuth/MCP boundary. The OpenAI-compatible side listens only on loopback and requires a separate bearer key. Completion payloads, function schemas, function arguments, and tool results are explicitly treated as untrusted data: they can influence the model's answer or tool decision, but cannot release the gateway lifecycle, change claim ownership, authorize additional PiLink capabilities, or cause PiLink itself to execute a caller-advertised tool.
