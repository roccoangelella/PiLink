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
- Three CLI launch experiences: **Single agent**, **Agents chat** collaboration,
  and **CLI pilink-endpoint**; PiLink for VS Code installs separately.
- **ChatGPT LLM Gateway:** run a connected ChatGPT conversation as a local
  OpenAI-compatible model provider with native tool-calling for coding agents.
- Stable Cloudflare fixed-domain hosting, existing HTTPS domains, Quick Tunnel,
  local-only operation, and legacy CLI hosting paths.
- Explicit opt-ins for repository execution and unrestricted machine access.
- Optional VS Code launcher and Textual collaboration monitor.

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

## Launch modes

`pilink start` prompts for three experiences in this order:

| Mode | Command | Purpose |
| --- | --- | --- |
| **Single agent** | `pilink start --mode single` | Original project-tool bridge for a single MCP client without public collaboration services. Confined to project-folder access. |
| **Agents chat** | `pilink start --mode collaboration` | Collaborative orchestration adding verified multi-agent chat (`pilink chat`), shared tasks, memory, and supervised agents. |
| **CLI pilink-endpoint** | `pilink start --mode cli` | Launches the ChatGPT gateway provider as a local OpenAI-compatible endpoint with native tool calling; existing `pilink gateway` subcommands remain. |

PiLink for VS Code is separate from launch-mode selection: `pilink install-vscode-plugin`.

For a local server behind an existing reverse proxy:

```bash
pilink serve --mode single
pilink serve --mode collaboration
```

See [Runtime mode selection](docs/operations/mode-selection.md) and the [ChatGPT LLM Gateway guide](docs/operations/llm-gateway.md) for details.

## ChatGPT LLM Gateway

PiLink can run a persistent ChatGPT conversation as a local OpenAI-compatible
model provider for coding agent harnesses (such as [Pi Agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)):

```bash
pilink start --mode cli       # or: pilink gateway start
```

- **OpenAI-compatible endpoint:** Loopback API at `http://127.0.0.1:3210/v1`
  (with automatic port fallback to `3211/v1` if `3210` is occupied).
- **Tool-calling bridge:** Forwards caller-advertised function tools (`bash`,
  `read`, `edit`, `write`) to ChatGPT. ChatGPT selects tools via the structured
  MCP dispatcher `gateway_call_local_tool`, PiLink returns standard OpenAI
  `assistant.tool_calls`, and the caller executes them locally with its own
  permissions.
- **Harness execution boundary:** Tool execution remains strictly with the
  caller harness. PiLink never executes caller tools and requires no
  `--allow-unsafe-full-access` flag.
- **Client compatibility:** Supports streaming (`stream: true`) with buffered SSE
  chunks, multi-part text messages, and standard client parameters (`store`,
  `max_completion_tokens`, `temperature`, `top_p`, etc.).

See [ChatGPT LLM Gateway](docs/operations/llm-gateway.md) for protocol and setup details.

## Start PiLink from VS Code

The graphical path intentionally fixes the security/workflow policy and asks
only for the endpoint choice:

1. install/update the extension once with `pilink install-vscode-plugin`, then open and trust the project;
2. open **PiLink** from the Activity Bar;
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
- **Agents chat / collaboration:** verified multi-agent chat, task coordination,
  memory, and supervised agent controls via `--mode collaboration` and `pilink chat`.
- **ChatGPT LLM Gateway:** run ChatGPT as a local OpenAI-compatible model
  provider with native tool-calling via `--mode cli` or `pilink gateway` subcommands.
- **Full machine access:** explicit CLI-only opt-in (`--allow-unsafe-full-access`)
  for reviewed OAuth clients.

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
- [ChatGPT LLM Gateway](docs/operations/llm-gateway.md)
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

PiLink uses the [MIT License](LICENSE) and the [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) harness.
The repository history and [NOTICE](NOTICE.md) retain attribution.
