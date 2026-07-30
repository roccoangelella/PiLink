# PiLink

<p align="center">
  <img src="docs/assets/logo.png" width="400" alt="PiLink Logo">
</p>

An OAuth-protected MCP server that exposes the Pi Agent coding-tool harness over Streamable HTTP (and legacy SSE). It is designed for a **single trusted owner** connecting a remote MCP client such as ChatGPT to a local development machine.

See [the complete getting-started guide](docs/GETTING_STARTED.md) for first-time setup and ChatGPT OAuth configuration.

## Quick start

Prerequisite: Node.js 22.19+. On Linux, the first `start` automatically downloads the official Cloudflare `cloudflared` binary to the private PiLink configuration directory. On macOS and Windows, install [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) first.

```bash
npx pilink start --allow-unsafe-full-access
```

The first run creates `~/.config/pilink/.env` with mode `0600`, starts a Cloudflare Quick Tunnel, then guides you through ChatGPT's user-defined OAuth setup and waits for its callback URL. `pilink init` creates the private configuration without starting the server. `pilink serve` starts without a tunnel for reverse-proxy or local use.

Set `PI_CLOUDFLARED_PATH` when your preferred `cloudflared` binary is outside `PATH`.

## Security model

The default mode is deliberately restrictive: file tools are jailed to `PI_WORK_DIR` (including symlink-escape checks) and `bash` is unavailable. This is appropriate for a public tunnel.

`--allow-unsafe-full-access` enables unrestricted shell and filesystem access for every authorized MCP client. It is remote code execution by design; only use it with a private configuration, a trusted ChatGPT profile, and a machine/account you are willing to expose. PiLink cannot make arbitrary shell commands safe without an OS-level sandbox.

Client registration requires the generated `PI_BOOTSTRAP_SECRET` as an RFC 7591 registration access token:

```bash
curl -X POST "$SERVER_URL/oauth/register" \
  -H "Authorization: Bearer $PI_BOOTSTRAP_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"client_name":"trusted-client","grant_types":["client_credentials"],"scope":"mcp:tools"}'
```

Keep that secret out of ChatGPT prompts, logs, source control, and public configuration. A client must support registration access tokens (or be pre-registered) to use the protected dynamic-registration endpoint.

## Configuration

`pilink init` documents the generated values. See `.env.example` for manual or deployment configuration. The server rejects startup if `JWT_SECRET` or `PI_BOOTSTRAP_SECRET` is missing or shorter than 32 characters. `SERVER_URL` must be the externally visible HTTPS URL when using a reverse proxy or tunnel.

OAuth tokens are audience/issuer-bound, expire after `TOKEN_EXPIRY` seconds (default 3600), and preserve their scopes for the lifetime of an MCP session. `mcp:read` permits only read/search tools, `mcp:write` permits mutation (and bash when unsafe mode is explicitly enabled), and `mcp:tools` permits all tools subject to the harness mode.

## Development and publishing

```bash
npm ci
npm test
```

The package contains only `dist`, this README, and the MIT license.

## Credits & Acknowledgments

PiLink builds upon the excellent **Pi Agent** ecosystem:
- **[Pi Agent (`@earendil-works/pi-coding-agent`)](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)**: The powerful underlying coding-agent tool harness providing structured file operations, grep search, symbol analysis, and command execution capability.
