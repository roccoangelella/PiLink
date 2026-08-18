# PiLink

<p align="center">
  <img src="docs/assets/logo.png" width="640" alt="PiLink logo">
</p>

PiLink is a self-hosted, OAuth-protected MCP bridge for the Pi coding-tool
harness. It gives authorized agents controlled access to a selected workspace
and supports single-agent, collaborative public-chat, and optional VS Code
entry points.

The core server and CLI do not require VS Code. **VSPiLink** is the optional
extension for graphical setup, monitoring, and local Pi chat.

## Features

- Workspace-scoped read, search, edit, write, safe Git inspection, and optional execution.
- OAuth with PKCE, refresh, revocation, client controls, and bounded MCP sessions.
- Single-agent and collaborative runtime catalogs with durable coordination services.
- Quick Tunnel, fixed Cloudflare domain, existing-domain, local-only, and legacy direct HTTPS hosting.
- Explicit opt-ins for repository execution and unrestricted machine access.
- Optional Textual monitor, VSPiLink extension, and local Codex plugin.

## Requirements

- Node.js **24.18.0 exactly** and npm **11.16.0 exactly** for source builds.
- A trusted project directory.
- Python with Textual 0.51.x only for the optional terminal monitor.
- A public HTTPS endpoint only for remote clients such as ChatGPT Work.
- VS Code 1.106 or newer only for VSPiLink.

## Install from source

```bash
git clone https://github.com/roccoangelella/PiLink.git
cd PiLink
npm ci
npm run build
```

`npm run build` compiles PiLink and safely exposes `pilink` through an existing
user-writable PATH directory inside your home. Linux/macOS gets a PiLink-marked
launcher that future builds can repair/repoint after a move or re-clone;
recognized old PiLink symlinks are migrated. Windows gets the equivalent
PiLink-marked `.cmd` shim. Builds never use `sudo`, edit shell startup files, or
replace an unrelated `pilink` command.

Set `PILINK_SKIP_CLI_LINK=1` to disable launcher creation. If no safe PATH
directory is available, use the checkout directly with `npm run cli -- start`.

### Where PiLink is installed and stores its files

There are three different locations to distinguish:

| Purpose | Linux | Windows |
| --- | --- | --- |
| Source checkout | Wherever you ran `git clone`, for example `~/Projects/PiLink` | Wherever you ran `git clone`, for example `C:\Users\Alice\Projects\PiLink` |
| `pilink` launcher | `npm run build` prefers an existing user PATH such as `~/.local/bin/pilink`; later builds can repair/repoint it | `npm run build` creates a PiLink-owned `pilink.cmd` in a safe writable user PATH location |
| PiLink private configuration and persistent data | `$XDG_CONFIG_HOME/pilink` when set, otherwise `~/.config/pilink` | `%USERPROFILE%\.config\pilink` by default |

The private PiLink directory contains generated configuration and runtime state
such as `.env`, OAuth client records, refresh/revocation state, audit data, and
hosting helper files. For example:

```text
Linux:   ~/.config/pilink/.env
Windows: C:\Users\Alice\.config\pilink\.env
```

This private directory is intentionally **outside the cloned repository and
outside the MCP workspace**. The workspace is accessible to authorized remote
agents, while `.env`, OAuth credentials, token state, and other PiLink control
files must remain private. Keeping them separate also means that deleting,
re-cloning, or updating the PiLink repository does not erase the machine's
PiLink configuration.

Set `XDG_CONFIG_HOME` or `PILINK_CONFIG` when you deliberately need a different
location. `PI_DATA_DIR` can separately override the persistent data directory.
Do not place these private files inside a directory exposed as `PI_WORK_DIR`.

Some short-lived coordination files are stored in the per-user runtime/temp
area instead of the persistent directory. On Linux this is normally under
`$XDG_RUNTIME_DIR` or `/run/user/<uid>`; these files are ephemeral and are not
part of the PiLink installation.

The optional VSPiLink release installer may additionally provision its pinned
Node.js runtime in a per-user application-data directory: on Linux/macOS this
is `$XDG_DATA_HOME/vspilink/node-v24.18.0` or
`~/.local/share/vspilink/node-v24.18.0`, and on Windows it is
`%LOCALAPPDATA%\VSPiLink\node-v24.18.0`. See the
[installation guide](docs/INSTALLATION.md) for that separate VS Code runtime.

Verified PiLink 2.2.0 npm and VSIX artifacts are also available under
`release/`; see the [installation guide](docs/INSTALLATION.md).

## Start PiLink

Run the guided launcher or choose an entry directly:

```bash
pilink start
pilink start --mode single
pilink start --mode collaboration
pilink start --mode vscode
```

The CLI hosting wizard offers Quick Tunnel, direct `nip.io`, or a Cloudflare fixed domain (Named Tunnel). For a fixed domain, the user supplies a hostname in a Cloudflare-managed DNS zone plus one scoped API token; PiLink creates the tunnel, ingress, DNS record, and private tunnel-token file automatically, then discards the account token. The `/sse` URL stays the same across restarts.

### Cloudflare fixed domain: create the provisioning token

Before choosing hosting option **3**, the domain must already be active on Cloudflare DNS. In Cloudflare, open **My Profile → API Tokens → Create Token → Create Custom Token**, then configure:

| Field | Value |
| --- | --- |
| Token name | `PiLink fixed-domain provisioning` |
| Permission 1 | **Account → Cloudflare Tunnel → Edit** |
| Permission 2 | **Zone → DNS → Edit** |
| Permission 3 | **Zone → Zone → Read** |
| Account Resources | **Include → your specific Cloudflare account** |
| Zone Resources | **Include → Specific zone → the domain PiLink will use**, for example `example.com` |
| Client IP Address Filtering | Leave blank unless you have a stable source IP/range for the machine doing provisioning |
| TTL | Optional; a short-lived token is preferred for one-time setup |

Do not select **All accounts**, **All zones**, broad **Account Edit**, broad **Zone Edit**, or the Global API Key. If you use IP filtering, enter the source address Cloudflare will see (normally the machine/network's public egress IP), not a private LAN address such as `192.168.x.x`. Cloudflare TTL dates are evaluated at `00:00 UTC`, so allow enough time for setup.

Select **Continue to summary**, verify that only the account, zone, and three permissions above are present, then select **Create Token**. Cloudflare shows the token secret only on the confirmation page: copy it and paste it into PiLink's hidden **Cloudflare API token** prompt (or the password field in VSPiLink). Treat it like a password.

After provisioning succeeds, PiLink does not save the account API token. It keeps only the tunnel-specific run token in a private local file for future restarts, so you may revoke/delete the provisioning API token afterward. If you later re-provision or change the fixed hostname, create another scoped token.

| Entry | Purpose |
| --- | --- |
| **Single agent** | Classic workspace tool harness without public orchestration |
| **Collaborative public chat** | Adds verified chat, tasks, memory, work-loop coordination, and supervised agents |
| **VS Code graphical** | Opens optional VSPiLink, where either core runtime can be selected |

Only `single` and `collaboration` are server runtime modes. `vscode` is a
launcher handoff and is never stored as `PI_RUNTIME_MODE`.

### Full machine access (unsafe)

For a general local coding-agent workflow with filesystem and shell access
outside the workspace, start PiLink explicitly with Full access:

```bash
pilink start --allow-unsafe-full-access
# or
pilink start --mode single --allow-unsafe-full-access
pilink start --mode collaboration --allow-unsafe-full-access
```

**Full access cannot be enabled on an already-running server.** Stop PiLink and
restart it with the flag. Without an explicit allowlist, the flag uses
`PI_FULL_ACCESS_CLIENT_IDS=*`; prefer restricting it to the OAuth client you
trust:

```bash
pilink clients list
PI_FULL_ACCESS_CLIENT_IDS=pi_your_client_id pilink start --allow-unsafe-full-access
```

For persistent configuration, set `PI_UNSAFE_FULL_ACCESS=true` and
`PI_FULL_ACCESS_CLIENT_IDS=pi_your_client_id`, then restart PiLink. Full access
removes the workspace boundary and enables process execution as the PiLink OS
user; see the [security model](docs/SECURITY_MODEL.md).

For a local server behind an existing reverse proxy:

```bash
pilink serve --mode single
pilink serve --mode collaboration
```

Useful commands:

```bash
pilink init
pilink start --setup
pilink chat
pilink clients list
pilink hosting --help
pilink agent-auth --help
pilink reset
```

## Client options

- **Remote MCP clients:** connect to the OAuth-protected `/sse` endpoint.
- **ChatGPT Work:** use a private/workspace PiLink plugin and complete OAuth; see [Connect ChatGPT Work](docs/CONNECT_CHATGPT.md).
- **VSPiLink:** optional graphical setup, monitoring, and Pi Local chat; see [VS Code extension](docs/VSCODE_EXTENSION.md).
- **Codex:** the optional local plugin under `plugins/pilink` targets a loopback PiLink instance.

## Security

The default workspace mode confines filesystem access to the canonical project
root, rejects traversal and symlink escapes, and does not expose a general
shell. Repository execution and Full access require separate explicit opt-ins.

`--allow-unsafe-full-access` permits authorized clients to use unrestricted
filesystem and shell access as the PiLink OS user. Keep `.env`, OAuth records,
provider credentials, tunnel credentials, and private coordination state
outside the workspace, and read the [security model](docs/SECURITY_MODEL.md)
before exposing PiLink publicly.

## Documentation

- [Getting started](docs/GETTING_STARTED.md)
- [Runtime mode selection](docs/operations/mode-selection.md)
- [Installation](docs/INSTALLATION.md)
- [Connect ChatGPT Work](docs/CONNECT_CHATGPT.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Security model](docs/SECURITY_MODEL.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Documentation index](docs/README.md)

## Development

```bash
npm ci
npm run dev          # compile/watch only; does not start PiLink
npm run dev:server   # explicitly run the raw development server
npm run test:all
npm run release:check
```

PiLink is distributed under the [MIT License](LICENSE) and uses the Pi Agent
tool harness from
[`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent).
The repository history and [NOTICE](NOTICE.md) retain contributor attribution.
