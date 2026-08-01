# PiLink: complete first-time guide

PiLink lets a remote MCP client use coding tools on this machine. It can read, search, edit, write, and (when explicitly enabled) run shell commands. Treat it as remote code execution: connect only a ChatGPT profile and account you trust.

## 1. Prerequisites

You need:

- Node.js **22.19 or newer** (`node --version`) on Linux, macOS, or Windows
- a ChatGPT plan/UI that supports remote MCP servers and custom OAuth settings
- this repository cloned locally

On Linux, PiLink automatically downloads the official hosting binary (`cloudflared` for Quick Tunnel or `caddy` for `nip.io`) on the first `start`; no separate Cloudflare account or `sudo` is required. On macOS and Windows, install `cloudflared` or `caddy` yourself first.

## 2. Install and build

```bash
git clone https://github.com/roccoangelella/PiLink.git
cd PiLink
npm ci
npm run build
```

### Optional: make the local CLI available as `pilink`

Run a command from this checkout without a global installation:

```bash
npm exec -- pilink start --setup
```

To use `pilink` from any directory, configure npm's global prefix to a directory owned by your user before linking this checkout. Do not use `sudo`:

```bash
npm config set prefix "$HOME/.local"
printf '\nexport PATH="$HOME/.local/bin:$PATH"\n' >> ~/.bashrc
source ~/.bashrc
npm link
```

If `npm link` reports `EACCES` for `/usr/lib/node_modules`, the prefix has not been changed for your user. Run the commands above, open a new shell (or source `~/.bashrc`), then retry `npm link`.

Run the next command from the project you want the agent to access (not necessarily this PiLink repository). The first run saves that directory as the workspace.

```bash
cd /path/to/your/project
node /path/to/PiLink/dist/cli.js init
```

This creates `~/.config/pilink/.env` with random secrets and permissions `0600`. Do **not** commit, share, or paste that file into a chat.

## 3. Choose public hosting on first start

The first `pilink start` asks which mode to save in the private configuration:

1. **Cloudflare Quick Tunnel** is the default. It needs no account, router configuration, or extra installation. Its `trycloudflare.com` URL changes each restart, and ChatGPT treats each URL as a new connector. After every Quick Tunnel restart, create a new connector and use `pilink start --setup` to register an OAuth client for that connector's callback URL.
2. **Direct `nip.io` HTTPS hosting** uses a hostname containing your public IPv4 address. It stays the same while that IP address remains unchanged, allowing one ChatGPT connector to be reused. PiLink downloads Caddy automatically on Linux and runs it locally to obtain and renew a trusted HTTPS certificate.

After explicit confirmation, PiLink first attempts UPnP and NAT-PMP router mappings for public TCP `80 → 8080` and `443 → 8443`. The mappings are renewed while PiLink runs and released on shutdown. Caddy uses them to obtain and renew a trusted HTTPS certificate. This removes the normal router-configuration step on compatible home networks.

Automatic mapping cannot bypass CGNAT, ISP port blocking, routers with UPnP/NAT-PMP disabled, or a router that has already assigned ports `80` or `443`. PiLink detects a non-public router address and stops; for other mapping failures, it offers the manual fallback:

- Your ISP must assign a publicly reachable IPv4 address; CGNAT does not work.
- Reserve this computer's LAN address in your router so forwarding continues to reach it.
- In your router, forward public TCP `80` to this computer's TCP `8080`.
- In your router, forward public TCP `443` to this computer's TCP `8443`.

On Linux systems using firewalld, Caddy also needs its local forwarded ports opened:

```bash
sudo firewall-cmd --state
sudo firewall-cmd --list-all
sudo firewall-cmd --permanent --add-port=8080/tcp
sudo firewall-cmd --permanent --add-port=8443/tcp
sudo firewall-cmd --reload
```

Run the three change commands only when firewalld is running. PiLink detects the public IPv4 address automatically; set `PI_PUBLIC_IPV4` only as a fallback when that lookup cannot reach an IP service.

Choose direct hosting only if you understand that it exposes PiLink to the Internet. Keep generated secrets private, use strong OAuth credentials, and enable `--allow-unsafe-full-access` only for a fully trusted client. If your public IP changes, its `nip.io` URL changes and ChatGPT needs a new connector.

### Direct `nip.io` launch summary

This is the complete terminal flow. It starts in safe workspace mode; add `--allow-unsafe-full-access` only if you accept remote shell access from every authorized client.

```bash
git clone https://github.com/roccoangelella/PiLink.git
cd PiLink
export PILINK="$PWD"
npm ci
npm run build

cd /path/to/your/project
node "$PILINK/dist/cli.js" init
node "$PILINK/dist/cli.js" start
```

At the hosting prompt, select `2` and accept the automatic router-mapping request. PiLink downloads Caddy on Linux, obtains the public IPv4 address from the router, prints the resulting `https://pilink-<ip>.nip.io` address, then begins the ChatGPT OAuth guide below. When Caddy reports that it obtained a public TLS certificate, its ACME validation has confirmed that the hostname is externally reachable. Follow the manual fallback only if PiLink reports that your router cannot create the mappings.

## 4. Choose the access mode

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

## 5. Start the server

For the full coding-agent mode requested above:

```bash
node /path/to/PiLink/dist/cli.js start --allow-unsafe-full-access
```

With Cloudflare Quick Tunnel selected, the first Linux launch downloads `cloudflared` to `~/.config/pilink/bin/cloudflared`, starts a tunnel, then prints a line like:

```text
Paste this MCP server URL in ChatGPT: https://example.trycloudflare.com/sse
```

With direct `nip.io` hosting selected, PiLink instead downloads Caddy on Linux and prints its stable `https://…nip.io` address. Keep this terminal open. Stopping it stops the MCP server and its public hosting process.

The URL ending in **`/sse`** is the URL to paste in ChatGPT. The bare HTTPS URL is used internally for OAuth endpoints. A Quick Tunnel URL changes each time you restart PiLink; it requires a new ChatGPT connector and OAuth client. A direct `nip.io` URL remains stable only while your public IPv4 address remains unchanged.

## 6. Register the ChatGPT OAuth client

On the first start, PiLink prints an interactive guide and waits for the callback URL. In ChatGPT, open **Settings → Apps/Connectors** (or the MCP connections page), add a connection, paste the displayed `/sse` connection URL, select **OAuth**, then in **Advanced OAuth settings** choose **Registration method: User defined**. Copy the callback URL that ChatGPT shows and paste it into the waiting PiLink terminal.

PiLink creates and prints a `client_id` and a `client_secret` once. Copy them directly into the ChatGPT settings and treat the secret like a password. With direct `nip.io` hosting, this client is persisted privately in `~/.config/pilink/clients.json` and remains valid on ordinary restarts. Quick Tunnel restarts create a different ChatGPT connector with a different callback URL, so they require a new client registration.

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

## 7. Use the tools

After authorization, ask ChatGPT to inspect the workspace first, then make focused changes and run tests. Available tools (powered by **Pi Agent** `@earendil-works/pi-coding-agent`) are:

- `read`, `grep`, `find`, `ls` for inspection
- `edit`, `write` for file changes
- `bash` only in `--allow-unsafe-full-access` mode

The server limits request bodies, tool input sizes, bash timeout, OAuth rate, and access-token lifetime. `mcp:read` gives inspection-only access; `mcp:write` gives write access; `mcp:tools` gives all tool permissions subject to the selected server mode.

## 8. Stop, restart, and troubleshoot

- Press `Ctrl+C` in the launch terminal to stop the server and its public hosting process.
- Restarting a Quick Tunnel creates a new URL and requires a new ChatGPT connector. Run `pilink start --setup`, configure the new connector with user-defined OAuth, then paste its callback URL into PiLink to register the matching OAuth client.
- Restarting direct `nip.io` hosting keeps the connector and OAuth client valid while the configured public IPv4 address remains unchanged.
- When an existing configuration is found, starting with `--setup` first asks whether to create a new separate instance (with a new config directory and port) or completely overwrite/reset the existing instance. To skip the prompt and force a complete reset: `node /path/to/PiLink/dist/cli.js start --allow-unsafe-full-access --setup --yes`. It does not delete your repository or workspace.
- To erase only PiLink's generated configuration, OAuth clients, managed hosting binaries, and Caddy TLS state, then immediately run a fresh guided setup: `node /path/to/PiLink/dist/cli.js reset --yes --start --allow-unsafe-full-access`. It does not delete your repository or workspace.
- If a preferred hosting binary is not on `PATH`, start with `PI_CLOUDFLARED_PATH=/path/to/cloudflared` or `PI_CADDY_PATH=/path/to/caddy` before the command.
- If the server refuses to start, check that `JWT_SECRET` and `PI_BOOTSTRAP_SECRET` remain at least 32 characters and that `PI_WORK_DIR` exists.
- If ChatGPT gets a 401 during setup, confirm that its configured OAuth client ID/secret match the registration response and that the selected hosting process is still running.
