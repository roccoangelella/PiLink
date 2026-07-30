# PiLink: complete first-time guide

PiLink lets a remote MCP client use coding tools on this machine. It can read, search, edit, write, and—when explicitly enabled—run shell commands. Treat it as remote code execution: connect only a ChatGPT profile and account you trust.

## 1. Prerequisites

You need:

- Linux with Node.js **22.19 or newer** (`node --version`)
- a ChatGPT plan/UI that supports remote MCP servers and custom OAuth settings
- this repository cloned locally

On Linux, PiLink downloads the official `cloudflared` binary on the first `start`; no separate Cloudflare account or `sudo` is required for a Quick Tunnel. On macOS and Windows, install `cloudflared` yourself first.

## 2. Install and build

```bash
git clone https://github.com/roccoangelella/PiLink.git
cd PiLink
npm ci
npm run build
```

Run the next command from the project you want the agent to access—not necessarily this PiLink repository. The first run saves that directory as the workspace.

```bash
cd /path/to/your/project
node /path/to/PiLink/dist/cli.js init
```

This creates `~/.config/pilink/.env` with random secrets and permissions `0600`. Do **not** commit, share, or paste that file into a chat.

## 3. Choose the access mode

Open the private configuration only when you need to change its workspace or limits:

```bash
nano ~/.config/pilink/.env
```

`PI_WORK_DIR` is the directory exposed to file tools.

| Mode | Command | Capabilities |
| --- | --- | --- |
| Safe workspace mode | `node /path/to/PiLink/dist/cli.js start` | File tools are restricted to `PI_WORK_DIR`; `bash` is disabled. |
| Full coding-agent mode | `node /path/to/PiLink/dist/cli.js start --allow-unsafe-full-access` | Authorized clients can run shell commands and access files outside the workspace. |

Use full mode only with a private, trusted client. Anyone able to obtain an authorized OAuth token can execute commands as your local user.

## 4. Start the server

For the full coding-agent mode requested above:

```bash
node /path/to/PiLink/dist/cli.js start --allow-unsafe-full-access
```

The first Linux launch downloads `cloudflared` to `~/.config/pilink/bin/cloudflared`, starts a Cloudflare Quick Tunnel, then prints a line like:

```text
Paste this MCP server URL in ChatGPT: https://example.trycloudflare.com/sse
```

Keep this terminal open. Stopping it stops the MCP server and tunnel.

The URL ending in **`/sse`** is the URL to paste in ChatGPT. The bare `https://example.trycloudflare.com` URL is only used internally for OAuth endpoints. A Quick Tunnel URL changes each time you restart PiLink; update the ChatGPT connection and OAuth endpoint URLs after every restart. Use a named Cloudflare tunnel and your own domain if you need a stable URL.

## 5. Register the ChatGPT OAuth client

On the first start, PiLink prints an interactive guide and waits for the callback URL. In ChatGPT, open **Settings → Apps/Connectors** (or the MCP connections page), add a connection, paste the displayed `/sse` connection URL, select **OAuth**, then in **Advanced OAuth settings** choose **Registration method: User defined**. Copy the callback URL that ChatGPT shows and paste it into the waiting PiLink terminal.

PiLink creates and prints a `client_id` and a `client_secret` once. Copy them directly into the ChatGPT settings and treat the secret like a password. This client is persisted privately in `~/.config/pilink/clients.json`, so you do **not** repeat registration on ordinary restarts.

Configure the OAuth settings as follows, replacing the example host:

| ChatGPT field | Value |
| --- | --- |
| MCP server / connection URL | `https://example.trycloudflare.com/sse` |
| Authorization URL | `https://example.trycloudflare.com/oauth/authorize` |
| Token URL | `https://example.trycloudflare.com/oauth/token` |
| Client ID | `client_id` returned by registration |
| Client secret | `client_secret` returned by registration |
| Token endpoint auth method | `client_secret_post` |
| Scope | `mcp:tools` |

Save the connection, then use ChatGPT's **Connect/Authorize** action. PiLink shows a local consent page in the browser; approve only after checking that the client name and requested scope are correct.

### Important compatibility note

This server requires a registration access token (`PI_BOOTSTRAP_SECRET`) for web-based dynamic client registration. The guided local setup uses the same private client store directly, so it never exposes that bootstrap secret. If the ChatGPT UI does not let you supply a user-defined client ID, client secret, and redirect URL, it cannot connect to this protected configuration as-is. Use a ChatGPT connection flow that supports custom OAuth credentials rather than weakening the registration protection.

## 6. Use the tools

After authorization, ask ChatGPT to inspect the workspace first, then make focused changes and run tests. Available tools (powered by **Pi Agent** `@earendil-works/pi-coding-agent`) are:

- `read`, `grep`, `find`, `ls` for inspection
- `edit`, `write` for file changes
- `bash` only in `--allow-unsafe-full-access` mode

The server limits request bodies, tool input sizes, bash timeout, OAuth rate, and access-token lifetime. `mcp:read` gives inspection-only access; `mcp:write` gives write access; `mcp:tools` gives all tool permissions subject to the selected server mode.

## 7. Stop, restart, and troubleshoot

- Press `Ctrl+C` in the launch terminal to stop the server and tunnel.
- Restarting a Quick Tunnel creates a new URL. Update the MCP connection URL plus authorization/token URLs in ChatGPT. The ChatGPT callback URL, client ID, and client secret stay valid, so do not register again.
- To register another OAuth client or retry skipped first-time setup, start with `--setup`: `node /path/to/PiLink/dist/cli.js start --allow-unsafe-full-access --setup`.
- To erase only PiLink's generated configuration, OAuth clients, and managed Cloudflared binary, then immediately run a fresh guided setup: `node /path/to/PiLink/dist/cli.js reset --yes --start --allow-unsafe-full-access`. It does not delete your repository or workspace.
- If a preferred Cloudflare binary is not on `PATH`, start with `PI_CLOUDFLARED_PATH=/path/to/cloudflared` before the command.
- If the server refuses to start, check that `JWT_SECRET` and `PI_BOOTSTRAP_SECRET` remain at least 32 characters and that `PI_WORK_DIR` exists.
- If ChatGPT gets a 401 during setup, confirm that its configured OAuth client ID/secret match the registration response and that the tunnel process is still running.
