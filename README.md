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
- Local-only, existing-domain, Cloudflare, and legacy direct HTTPS hosting.
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
npm link
```

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
npm run test:all
npm run release:check
```

PiLink is distributed under the [MIT License](LICENSE) and uses the Pi Agent
tool harness from
[`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent).
The repository history and [NOTICE](NOTICE.md) retain contributor attribution.
