# PiLink

<p align="center">
  <img src="docs/assets/logo.png" width="640" alt="PiLink logo">
</p>

PiLink is a self-hosted, OAuth-protected MCP bridge for the Pi coding-tool
harness. It gives authorized clients controlled access to a selected project.

The core server and CLI do not require VS Code. The optional **PiLink VS Code
extension** is a graphical launcher/status panel for choosing the project,
starting/stopping PiLink, configuring the endpoint, connecting ChatGPT, and
checking bridge status. It is not a second chat frontend.

## Features

- Workspace-scoped read, search, edit, write, safe Git inspection, and optional
  repository execution.
- OAuth with PKCE, refresh, revocation, client controls, and bounded MCP
  sessions.
- A default **Single-agent** tool catalog plus an optional collaboration catalog
  in the core server/CLI.
- Stable Cloudflare fixed-domain hosting, existing HTTPS domains, Quick Tunnel,
  local-only operation, and legacy CLI hosting paths.
- Explicit opt-ins for repository execution and unrestricted machine access.
- Optional VS Code launcher, Textual collaboration monitor, and local Codex
  plugin.

## Requirements

- Node.js **24.18.0 exactly** and npm **11.16.0 exactly** for source builds.
- A project directory you are willing to trust.
- A public HTTPS endpoint only for remote clients such as ChatGPT Work.
- VS Code 1.106 or newer only for the optional extension.
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
| **VS Code graphical** | Opens the focused PiLink launcher; graphical setup always writes Single agent |

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

The graphical path intentionally fixes the security/workflow policy and asks
only for the endpoint choice:

1. open the project and trust the VS Code window;
2. open **PiLink** in the Secondary Side Bar;
3. choose **Set up stable endpoint** (recommended), **Temporary quick start**,
   or **Local only**;
4. every choice writes Single agent + Project-folder access;
5. when a public endpoint is ready, select **Connect ChatGPT**;
6. do the coding task in ChatGPT Work or another MCP client.

**Set up stable endpoint** supports a Cloudflare fixed domain or an existing
HTTPS reverse proxy. The Quick Tunnel option is intentionally secondary because
its URL changes when recreated.

The extension no longer exposes collaboration enablement, Full-access launch,
provider-backed chat/agents, native VS Code MCP integration, or manual OAuth
client registration as graphical products. Those specialist capabilities remain
in the core CLI/backend where appropriate.

See [PiLink VS Code extension](docs/VSCODE_EXTENSION.md) and
[Connect ChatGPT Work](docs/CONNECT_CHATGPT.md).

## Full machine access

Full access is intentionally unsafe and is not part of the VS Code workflow.
From the CLI it must be enabled explicitly:

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

If the VS Code launcher detects an existing Full-access configuration, it shows
a safety state and refuses to start/restart/connect it. **Reconfigure safely...**
resets it to the fixed graphical policy. Deliberate unrestricted operation
belongs to the CLI/operator workflow.

Read [Security model](docs/SECURITY_MODEL.md) before enabling it.

## Hosting

PiLink supports temporary and stable HTTPS arrangements. In the VS Code
launcher:

- **Cloudflare fixed domain** — stable, PiLink provisions tunnel/DNS from a
  scoped one-use API token;
- **Existing HTTPS domain** — stable, operator-managed reverse proxy;
- **Cloudflare Quick Tunnel** — temporary evaluation URL;
- **Local only** — same-machine clients.

The core CLI retains additional legacy hosting paths. A remote ChatGPT client
needs a reachable HTTPS origin. Recreating a Quick Tunnel changes that origin
and therefore changes the MCP/OAuth URL clients use.

Hosting credentials must remain private. Automatic helper downloads are pinned
and integrity-checked; controlled mirrors must provide both the download URL
and independently verified SHA-256 digest.

See [Installation](docs/INSTALLATION.md) for provisioning details.

## Client and operator options

- **ChatGPT Work / remote MCP clients:** connect to the OAuth-protected PiLink
  endpoint.
- **PiLink VS Code extension:** optional graphical launcher/status panel for the
  same server, with a fixed safe policy.
- **Collaboration / provider-backed agents / unrestricted access:** explicit
  core PiLink CLI/operator capabilities, not VS Code product modes.
- **Codex:** the optional local plugin under `plugins/pilink` targets a loopback
  PiLink instance.

## Security

Project-folder access is the baseline. It confines filesystem tools to the
canonical selected project, rejects traversal/symlink escapes, and does not
expose a general shell. Repository execution and Full access require separate
operator decisions.

Public MCP OAuth, local VS Code administration, and optional model-provider
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
