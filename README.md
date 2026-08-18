# PiLink

<p align="center">
  <img src="docs/assets/logo.png" width="640" alt="PiLink logo">
</p>

PiLink is a self-hosted, OAuth-protected MCP bridge for the Pi coding-tool
harness. It gives authorized clients controlled access to a selected project.

The core server and CLI do not require VS Code. **VSPiLink** is the optional
VS Code control surface for choosing the project, starting/stopping PiLink,
configuring hosting/OAuth, and checking bridge status. It is not a second chat
frontend.

## Features

- Workspace-scoped read, search, edit, write, safe Git inspection, and optional
  repository execution.
- OAuth with PKCE, refresh, revocation, client controls, and bounded MCP
  sessions.
- A default **Single-agent** tool catalog plus an optional collaboration catalog
  with durable chat/tasks, memory/work-loop coordination, and supervised-agent
  controls.
- Quick Tunnel, fixed Cloudflare domain, existing-domain, local-only, and legacy
  direct HTTPS hosting.
- Explicit opt-ins for repository execution and unrestricted machine access.
- Optional VSPiLink GUI, Textual collaboration monitor, and local Codex plugin.

## Requirements

- Node.js **24.18.0 exactly** and npm **11.16.0 exactly** for source builds.
- A project directory you are willing to trust.
- A public HTTPS endpoint only for remote clients such as ChatGPT Work.
- VS Code 1.106 or newer only for VSPiLink.
- Python/Textual only for the optional terminal collaboration monitor.

## Install from source

```bash
git clone https://github.com/roccoangelella/PiLink.git
cd PiLink
npm ci
npm run build
```

`npm run build` compiles PiLink and attempts to expose `pilink` through an
existing user-writable directory already on `PATH`. It never uses `sudo`, edits
shell startup files, or replaces an unrelated command.

If no safe `PATH` location exists, run the checkout directly:

```bash
npm run cli -- start
```

Set `PILINK_SKIP_CLI_LINK=1` when you explicitly want a build that does not
create/repair the generated launcher.

Private configuration and runtime state normally live outside the repository,
for example `~/.config/pilink/.env` on Linux/macOS. Do not place OAuth state,
tunnel credentials, provider credentials, or PiLink private data inside the
workspace exposed to MCP clients.

See [Installation](docs/INSTALLATION.md) for release installers, VSIX/source
installation, Remote SSH, managed Node, and upgrade details.

## Start PiLink from the CLI

```bash
pilink start
pilink start --mode single
pilink start --mode collaboration
pilink start --mode vscode
```

Only `single` and `collaboration` are server capability modes. `vscode` is a
handoff into the optional graphical control surface and is never stored as
`PI_RUNTIME_MODE=vscode`.

| Entry | Purpose |
| --- | --- |
| **Single agent** | Original project-tool bridge without public collaboration services |
| **Collaboration** | Adds verified chat/tasks, memory/work-loop coordination, and remote supervised-agent controls |
| **VS Code graphical** | Opens VSPiLink; fresh graphical setups use Single agent automatically |

For a local server behind an existing reverse proxy:

```bash
pilink serve --mode single
pilink serve --mode collaboration
```

Useful commands include:

```bash
pilink init
pilink start --setup
pilink clients list
pilink hosting --help
pilink agent-auth --help
pilink chat
pilink reset
```

See [Runtime mode selection](docs/operations/mode-selection.md) for the exact
capability split.

## Start PiLink from VS Code

VSPiLink's ordinary path is intentionally simpler than the CLI surface:

1. open the project and trust the VS Code window;
2. open **PiLink** in the Secondary Side Bar;
3. select **Quick start for ChatGPT**, **Local only**, or **Stable endpoint...**;
4. when the public endpoint is ready, select **Connect ChatGPT**;
5. do the coding task in ChatGPT Work or another MCP client.

The default graphical path uses:

- Single agent;
- Project-folder access;
- no unrestricted shell;
- no collaboration services unless explicitly enabled.

Advanced hosting, collaboration, Full access, manual OAuth registration, VS
Code's native MCP provider, and the optional provider-backed local Pi agent are
kept under **Advanced**.

See [VSPiLink](docs/VSCODE_EXTENSION.md) and
[Connect ChatGPT Work](docs/CONNECT_CHATGPT.md).

## Full machine access

Full access is intentionally unsafe and is not part of the normal first-run
flow. From the CLI it must be enabled explicitly:

```bash
pilink start --allow-unsafe-full-access
```

Prefer assigning it to one reviewed OAuth client rather than every client:

```bash
pilink clients list
PI_FULL_ACCESS_CLIENT_IDS=pi_your_client_id pilink start --allow-unsafe-full-access
```

Full access removes the project filesystem boundary and enables process
execution as the PiLink OS user. It does not grant root automatically, but it
is remote code execution with that user's authority.

VSPiLink keeps the capability under Advanced and visibly labels saved/active
Full-access configurations so they cannot look like an ordinary safe start.

Read [Security model](docs/SECURITY_MODEL.md) before enabling it.

## Hosting

PiLink supports temporary and stable HTTPS arrangements:

- Cloudflare Quick Tunnel for evaluation;
- Cloudflare fixed/Named Tunnel for a durable endpoint;
- an existing HTTPS reverse proxy/domain;
- local-only operation;
- legacy `nip.io` direct HTTPS.

A remote ChatGPT client needs a reachable HTTPS origin. Recreating a Quick
Tunnel changes that origin and therefore changes the MCP/OAuth URL clients use.

Hosting credentials must remain private. Automatic helper downloads are pinned
and integrity-checked; controlled mirrors must provide both the download URL
and independently verified SHA-256 digest.

See [Installation](docs/INSTALLATION.md) for provisioning details.

## Client options

- **ChatGPT Work / remote MCP clients:** connect to the OAuth-protected PiLink
  endpoint.
- **VSPiLink:** optional graphical launcher/control surface for the same server.
- **Optional local Pi agent:** provider-backed local supervised execution under
  VSPiLink Advanced; its provider credentials are separate from MCP OAuth.
- **Codex:** the optional local plugin under `plugins/pilink` targets a loopback
  PiLink instance.

## Security

Project-folder access is the baseline. It confines filesystem tools to the
canonical selected project, rejects traversal/symlink escapes, and does not
expose a general shell. Repository execution and Full access require separate
operator decisions.

Public MCP OAuth, local VSPiLink administration, and optional model-provider
authentication are independent trust boundaries. Keep all private PiLink state
outside the project.

Read [Security model](docs/SECURITY_MODEL.md) before exposing PiLink publicly or
broadening execution/access policy.

## Documentation

- [Getting started](docs/GETTING_STARTED.md)
- [Installation](docs/INSTALLATION.md)
- [VS Code extension](docs/VSCODE_EXTENSION.md)
- [Connect ChatGPT Work](docs/CONNECT_CHATGPT.md)
- [Runtime mode selection](docs/operations/mode-selection.md)
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
