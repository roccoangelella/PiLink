# PiLink

<p align="center">
  <img src="docs/assets/logo.png" width="640" alt="PiLink logo">
</p>

PiLink is a self-hosted, OAuth-protected MCP bridge for the Pi coding-tool
harness. It gives authorized agents controlled access to a selected workspace
and supports three entry points: a single agent, collaborative public-chat
orchestration, and an optional VS Code interface.

The core server and CLI do not require VS Code. **VSPiLink** is the optional
extension that provides graphical setup, monitoring, and local Pi chat.

## Features

- Workspace-scoped read, search, edit, write, and safe Git inspection tools.
- OAuth with PKCE, refresh, revocation, client lifecycle controls, and bounded
  MCP sessions.
- Single-agent and collaborative runtime catalogs.
- Durable agent chat, tasks, work-loop state, governed memory, and supervised
  Pi agents in collaborative mode.
- Local-only, existing-domain, Cloudflare, and legacy direct HTTPS hosting.
- Explicit opt-ins for repository execution and unrestricted machine access.
- Streamable HTTP plus legacy SSE compatibility.
- Optional Textual monitor, VSPiLink extension, and local Codex plugin.

## Requirements

- Node.js **24.18.0 exactly** and npm **11.16.0 exactly** for source builds.
- A trusted project directory.
- Python with Textual 0.51.x only when using the optional terminal monitor.
- A public HTTPS endpoint only when connecting a remote client such as
  ChatGPT Work.
- VS Code 1.106 or newer only when using VSPiLink.

## Install from source

```bash
git clone https://github.com/roccoangelella/PiLink.git
cd PiLink
npm ci
npm run build
npm link
```

Verified PiLink 2.2.0 npm and VSIX artifacts are also available under
`release/`. The release installers and checksums are documented in the
[installation guide](docs/INSTALLATION.md).

## Start PiLink

Run the guided launcher:

```bash
pilink start
```

Or select an entry directly:

```bash
pilink start --mode single
pilink start --mode collaboration
pilink start --mode vscode
```

| Entry | Purpose |
| --- | --- |
| **Single agent** | Classic workspace tool harness without public orchestration; VSPiLink may run one loopback-controlled local Pi agent |
| **Collaborative public chat** | Adds verified chat, tasks, memory, work-loop coordination, and optional supervised agents |
| **VS Code graphical** | Opens the optional VSPiLink extension, where either core runtime can be selected |

Only `single` and `collaboration` are server runtime modes. `vscode` is a
launcher handoff and is never stored as `PI_RUNTIME_MODE`.

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
- **ChatGPT Work:** use a private/workspace PiLink plugin and complete OAuth.
  See [Connect ChatGPT Work](docs/CONNECT_CHATGPT.md).
- **VSPiLink:** install the optional VSIX for graphical setup, monitoring, and
  Pi Local chat. See [VS Code extension](docs/VSCODE_EXTENSION.md).
- **Codex:** the optional local plugin is under `plugins/pilink` and targets a
  loopback PiLink instance.

## Security

The default workspace mode confines filesystem access to the canonical project
root, rejects traversal and symlink escapes, and does not expose a general
shell. Build and test profiles execute repository code and require a separate
opt-in.

`--allow-unsafe-full-access` permits authorized clients to use unrestricted
filesystem and shell access as the PiLink operating-system user. It is remote
code execution by design and should be enabled only for explicitly trusted
clients and machines.

Keep `.env`, OAuth records, provider credentials, tunnel credentials, and
private coordination state outside the workspace. Read the
[security model](docs/SECURITY_MODEL.md) before exposing PiLink publicly.

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
npm run test:all
npm run release:check
```

PiLink is distributed under the [MIT License](LICENSE) and uses the Pi Agent
tool harness from
[`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent).
The repository history and [NOTICE](NOTICE.md) retain contributor attribution.
