# PI-MCP

An OAuth-protected MCP server that exposes the Pi coding-agent tools over Streamable HTTP (and legacy SSE). It is designed for a **single trusted owner** connecting a remote MCP client such as ChatGPT to a local development machine.

## Quick start

Prerequisite: Node.js 22.19+. On Linux, the first `start` automatically downloads the official Cloudflare `cloudflared` binary to the private PI-MCP configuration directory. On macOS and Windows, install [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) first.

```bash
npx pi-mcp start --allow-unsafe-full-access
```

The first run creates `~/.config/pi-mcp/.env` with mode `0600`, starts a Cloudflare Quick Tunnel, and prints the HTTPS URL to add to ChatGPT. `pi-mcp init` creates the private configuration without starting the server. `pi-mcp serve` starts without a tunnel for reverse-proxy or local use.

Set `PI_CLOUDFLARED_PATH` when your preferred `cloudflared` binary is outside `PATH`.

## Security model

The default mode is deliberately restrictive: file tools are jailed to `PI_WORK_DIR` (including symlink-escape checks) and `bash` is unavailable. This is appropriate for a public tunnel.

`--allow-unsafe-full-access` enables unrestricted shell and filesystem access for every authorized MCP client. It is remote code execution by design; only use it with a private configuration, a trusted ChatGPT profile, and a machine/account you are willing to expose. PI-MCP cannot make arbitrary shell commands safe without an OS-level sandbox.

Client registration requires the generated `PI_BOOTSTRAP_SECRET` as an RFC 7591 registration access token:

```bash
curl -X POST "$SERVER_URL/oauth/register" \
  -H "Authorization: Bearer $PI_BOOTSTRAP_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"client_name":"trusted-client","grant_types":["client_credentials"],"scope":"mcp:tools"}'
```

Keep that secret out of ChatGPT prompts, logs, source control, and public configuration. A client must support registration access tokens (or be pre-registered) to use the protected dynamic-registration endpoint.

## Configuration

`pi-mcp init` documents the generated values. See `.env.example` for manual or deployment configuration. The server rejects startup if `JWT_SECRET` or `PI_BOOTSTRAP_SECRET` is missing or shorter than 32 characters. `SERVER_URL` must be the externally visible HTTPS URL when using a reverse proxy or tunnel.

OAuth tokens are audience/issuer-bound, expire after `TOKEN_EXPIRY` seconds (default 3600), and preserve their scopes for the lifetime of an MCP session. `mcp:read` permits only read/search tools, `mcp:write` permits mutation (and bash when unsafe mode is explicitly enabled), and `mcp:tools` permits all tools subject to the harness mode.

## Development and publishing

```bash
npm ci
npm test
```

Before publishing, replace the `REPLACE-ME` repository URLs in `package.json`, then run `npm publish`. The package contains only `dist`, this README, and the MIT license.
