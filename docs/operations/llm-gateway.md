# ChatGPT LLM Gateway

PiLink can run a ChatGPT conversation as a local OpenAI-compatible completion worker without scraping or browser automation. The ChatGPT conversation communicates only through the ordinary OAuth-protected PiLink MCP connection.

This is an explicit operator mode. It does not add a third `PI_RUNTIME_MODE`; `pilink gateway start` pins the underlying core runtime to the least-privileged `single` mode and replaces the ordinary MCP catalog with one tool: `gateway_exchange`. The normal `pilink start` Single/Collaboration/VS Code chooser is therefore skipped for gateway launches.

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

Gateway launches use compact terminal output. Raw cloudflared diagnostics, the ordinary PiLink server box, routine HTTP request logs, and routine MCP session chatter are hidden. Actionable process errors and the local `Allow this ChatGPT connection? [y/N]` approval prompt remain visible. Once startup is ready, PiLink leaves one stable footer at the bottom of the CLI containing the ChatGPT MCP URL, local OpenAI-compatible API URL, API key, `pilink gateway connect`, and the wake command.

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

Choose OAuth and Dynamic Client Registration (DCR). PiLink accepts the secretless ChatGPT registration only while the short owner-opened DCR window is active. When ChatGPT reaches the authorization step, the terminal running PiLink displays the exact client/callback/scope and asks:

```text
Allow this ChatGPT connection? [y/N]:
```

Approve only a connection you just initiated yourself. Stopping another PiLink process does not open this registration window, and an already stored OAuth client does not automatically authorize a new ChatGPT app. Use `pilink gateway connect` whenever a fresh DCR window is needed.

In a non-interactive launch where terminal approval is unavailable, PiLink prints the one-use owner pairing URL and local verification code in the compact footer; complete that pairing in the same browser used for ChatGPT before OAuth authorization.

## Wake the ChatGPT conversation

After connecting the PiLink MCP endpoint to the intended ChatGPT conversation, send a short explicit wake message such as:

```text
@PiLink wake
```

The MCP server instructions define the lifecycle. The conversation must immediately call `gateway_exchange` and then stay inside that protocol until PiLink returns `state=released`.

A completion request finishing is **not** gateway completion. `gateway_exchange` atomically submits the previous response and enters the next bounded long poll. If it returns `state=idle` with `continue=true`, the conversation calls it again immediately instead of reporting completion or waiting to the ChatGPT user.

Only a server-side release ends the loop:

```bash
pilink gateway release "operator finished"
```

Status is available locally with:

```bash
pilink gateway status
```

## OpenAI-compatible endpoint

The inference surface is deliberately minimal:

```http
POST /v1/chat/completions
Authorization: Bearer <gateway-api-key>
Content-Type: application/json
```

Supported request fields:

- `model` — required for OpenAI client compatibility; it does **not** select the ChatGPT model;
- `messages` — required array of string-content messages using `system`, `developer`, `user`, `assistant`, or `tool` roles;
- `stream` — optional and currently must be `false`.

Example:

```bash
curl http://127.0.0.1:3210/v1/chat/completions \
  -H "Authorization: Bearer $PILINK_GATEWAY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "pilink",
    "messages": [{"role":"user","content":"Explain this in one paragraph."}]
  }'
```

Use the endpoint printed at startup if PiLink selected a fallback port. The selected ChatGPT conversation decides the actual model. PiLink echoes the supplied `model` field in the OpenAI-compatible response and does not attempt to control ChatGPT model selection, temperature, reasoning effort, sampling parameters, or token streaming.

Unsupported Chat Completions fields are rejected instead of silently pretending that PiLink can enforce them.

## Lifecycle and failure behavior

The durable private queue uses these request states:

```text
queued -> claimed -> completed
                 -> failed
queued/claimed -> cancelled
```

Each claimed request has an opaque claim token and lease. The ChatGPT MCP session must return both the exact request ID and claim token when submitting a completion. This makes retries idempotent and prevents another concurrent MCP session from completing a request it did not claim.

Only one ChatGPT gateway session is authoritative at a time. A fresh second session is rejected while the active one is healthy. A stale session can be replaced; its unfinished claimed work returns to the queue.

If the MCP connection owning the foreground exchange disconnects, PiLink invalidates the already-running exchange immediately and returns any request claimed by that session to the queue. A later exchange can then activate normally without waiting for the old claim lease to expire.

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
```

`PI_LLM_GATEWAY_ENABLED=true` is an internal launch flag set by `pilink gateway start`/`serve`; normal PiLink launches do not expose the gateway tool or local completion endpoint.

## Security boundary

The public side remains the existing PiLink OAuth/MCP boundary. The OpenAI-compatible side listens only on loopback and requires a separate bearer key. Completion payloads are explicitly treated as untrusted data: they can influence the content of the requested completion, but cannot release the gateway lifecycle, change claim ownership, or authorize additional PiLink capabilities.
