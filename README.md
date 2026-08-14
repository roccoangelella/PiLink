# PiLink

> **From chat to code, on your machine.**

<p align="center">
  <img src="docs/assets/logo.png" width="640" alt="PiLink logo">
</p>

PiLink is a self-hosted, OAuth-protected MCP bridge between ChatGPT and the Pi
Agent coding-tool harness. It exposes controlled file, Git, execution,
collaboration, and supervised-agent capabilities on the machine where PiLink
runs.

PiLink can be used directly from its CLI, with its public-chat orchestration
surface, or through the optional **VSPiLink** VS Code extension. VSPiLink is an
extra graphical control surface for PiLink; it is not the project name and is
not required for CLI or headless operation.

PiLink is independent software. It is not affiliated with, endorsed by, or
distributed by OpenAI, Microsoft, or Cloudflare.

## What it does

- Connects **ChatGPT Work** to a development machine through remote MCP and
  OAuth. Under the current official ChatGPT product model, plugins and their
  remote MCP tools run in Work, not in normal Chat.
- Keeps the default tool boundary inside the selected workspace, with explicit
  opt-ins for repository execution and unrestricted machine access.
- Shows MCP connections, durable agent messages, shared tasks, and supervised
  Pi agents in VS Code without copying the private ChatGPT transcript.
- Preserves PiLink CLI, Streamable HTTP, legacy SSE, OAuth client lifecycle,
  hosting modes, collaboration tools, and the original Pi provider login
  choices.
- Supports an optional **Pi Local** mode. Pi Local uses the selected provider
  and that provider's credentials, limits, and billing; it does not provide
  free inference.

```mermaid
flowchart LR
    User[Developer] --> Work[ChatGPT Work]
    Work -->|OAuth + remote MCP| Public[Public HTTPS endpoint]
    Public -->|tunnel or reverse proxy| Core[PiLink on loopback]
    Core --> Harness[Pi tool harness]
    Core --> Agents[Supervised Pi agents]
    Core --> Collab[Agent chat and task board]
    Harness --> Workspace[Selected VS Code workspace]
    Agents --> Workspace
    VSCode[VSPiLink extension] -->|local protected admin API| Core
```

See [Architecture](docs/ARCHITECTURE.md) for the runtime, trust, and identity
models.

## Choose a mode

Choose the **runtime catalog** first, then choose the client surface. The
runtime choice is persisted in private configuration as `PI_RUNTIME_MODE` and
is enforced by the server; it cannot be changed by a prompt or chat message.

| Runtime entry | CLI/config value | Capability boundary |
| --- | --- | --- |
| **Single agent** | `pilink start --mode single` / `PI_RUNTIME_MODE=single` | Classic remote workspace harness with no public orchestration; the loopback-only VS Code Pi Local surface may run one provider-backed agent |
| **Collaborative public chat** | `pilink start --mode collaboration` / `PI_RUNTIME_MODE=collaboration` | Adds verified public chat, tasks, memory, work-loop, and optional supervised Pi agents |
| **VS Code graphical** | `pilink start --mode vscode` | Handoff to the optional VSPiLink extension, which contains both server catalogs and the ChatGPT MCP/Pi Local surface selector; not a third core mode |

The graphical **ChatGPT MCP** versus **Pi Local** selector below is a separate
execution-surface choice. Read the [runtime mode guide](docs/operations/mode-selection.md)
before using headless operation or migrating a legacy configuration.

| Mode | Model/client | Best for |
| --- | --- | --- |
| **ChatGPT Work + MCP** | ChatGPT Work uses PiLink as a plugin-backed remote MCP server | The primary remote workflow |
| **Pi Local** | A provider and model selected in the VSPiLink extension | Direct local chat and supervised child agents |
| **CLI/headless** | PiLink server plus optional Textual monitor | SSH, tmux, automation, and existing PiLink deployments |

Normal Chat is useful for ordinary conversation, but current official ChatGPT
documentation places plugins and remote MCP-backed tools in **Work**. Legacy
Developer Mode/custom-connector interfaces may still appear on some accounts;
PiLink keeps them as compatibility paths, not as the supported primary flow.
Read [Usage, models, and costs](docs/USAGE_AND_COSTS.md) before choosing a
surface or model.

## Requirements

- VS Code 1.106 or newer;
- a PiLink-managed or existing **Node.js 24.18.0 exactly** on the machine
  that runs the PiLink sidecar;
- a trusted local or Remote SSH workspace;
- a public HTTPS endpoint for ChatGPT Work, normally a Cloudflare Named Tunnel
  or an existing reverse proxy/domain;
- a ChatGPT plan and workspace policy that allow Work and the required plugin.

Feature availability, labels, plans, credits, and limits are controlled by
OpenAI and may change independently of PiLink.

## Install

The recommended release bundle installs and verifies the bundled VSIX and, if
necessary, provisions a private per-user Node.js 24.18.0 runtime from the
official Node.js distribution using pinned SHA-256 values. It does not require
`sudo` and does not replace the user's system Node.

Linux or macOS, from the unpacked release directory:

```bash
./install.sh
```

Windows PowerShell, from the unpacked release directory:

```powershell
.\install.ps1
```

The release scripts use the `vspilink-2.2.0.vsix` beside them. They refuse an
unverified installation when `SHA256SUMS` is missing or does not match. When
the installer finishes, return to VS Code, open the Command Palette with
`Ctrl+Shift+P` (`Cmd+Shift+P` on macOS), run **Developer: Reload Window**, then
select **View -> Appearance -> Secondary Side Bar** if necessary and open the
**VSPiLink** view.

Developers building from source must provide Node.js 24.18.0 and npm 11.16.0
exactly:

```bash
git clone https://github.com/roccoangelella/PiLink.git
cd PiLink
node --version                    # must print v24.18.0
npm --version                     # must print 11.16.0
npm ci
npm run vscode:install
```

In a source checkout, the installer sources live under `install/`, but the
normal developer command is `npm run vscode:install`. Do not use the
release-root commands above until `npm run release:stage` has produced the
complete checksummed bundle.

For VSIX and Remote SSH instructions, see
[Installation](docs/INSTALLATION.md). For a visual version of the complete
first-run flow, use the sanitized [illustrated walkthrough](docs/ILLUSTRATED_GUIDE.md).

## Connect ChatGPT Work

1. Open the project folder in VS Code and trust it only if you know its
   contents.
2. Open the optional **VSPiLink** sidebar and keep **ChatGPT MCP** selected.
3. Start the guided connection, select **Open folder** access, and configure a
   stable public HTTPS endpoint.
4. In ChatGPT, switch to **Work**, open **Plugins**, and install or connect the
   private PiLink plugin made available to your personal or workspace
   catalog.
5. Complete OAuth once. When Dynamic Client Registration is available, no
   callback URL, client ID, or client secret needs to be copied manually.
6. Start a new Work task with PiLink enabled and review tool approvals and
   file changes in VS Code.

The downloadable release cannot embed or provision a private ChatGPT Work
plugin ID. ChatGPT assigns that ID inside the owner's account or workspace
after the MCP endpoint is registered. The deployment owner must therefore
create or import the PiLink plugin once in Work, map it to that assigned ID,
and make the resulting entry available through the appropriate personal or
workspace plugin source. Other authorized users install that owner-provided
entry; they do not create a second PiLink server.

The optional plugin under `plugins/pilink` is a separate **Codex-only local
plugin** that targets PiLink on loopback. It does not install, replace, or
configure the private ChatGPT Work plugin or the VSPiLink extension.

The exact plugin-sharing control depends on account and workspace policy. If
the plugin is not available, do not install an unrelated catalog result named
"MCP server". Follow the canonical
[Connect ChatGPT guide](docs/CONNECT_CHATGPT.md).

## Security first

The default **Open folder** mode confines filesystem paths to the canonical
workspace root, rejects traversal and symlink escape, and does not expose a
general-purpose shell. Repository build and test profiles require a separate
trust decision because repository code is still arbitrary code.

**Full access is remote code execution by design.** It removes the filesystem
boundary and can launch processes with the permissions of the PiLink user.
Enable it only for a specific trusted OAuth client on a machine and account you
are willing to expose.

Secrets stay outside the workspace and webview. Public MCP/OAuth routes are
separate from loopback-only administration. Read the complete
[Security model](docs/SECURITY_MODEL.md) before exposing a server.

## Shipped capabilities

- workspace file read, search, edit, and write tools;
- constrained Git inspection and opt-in npm build/test profiles;
- explicit unrestricted shell/full-filesystem mode;
- OAuth Authorization Code with PKCE, refresh, revocation, DCR, and manual
  client compatibility;
- Streamable HTTP and legacy SSE on `/sse`;
- durable `agent_chat_*`, `agent_task_*`, `agent_work_*`, and read-only
  `agent_memory_*` collaboration surfaces;
- metadata-only tool audit and progress reporting;
- supervised Pi agent spawn, status, output, follow-up, cancel, and stop;
- existing HTTPS domain, Cloudflare Named/Quick Tunnel, local-only, and legacy
  `nip.io` hosting;
- optional Pi Local provider OAuth, device-code, existing-credential, and API
  key login paths;
- VS Code sidebar, wide dashboard, Integrated Browser launch, and protected
  local administration.

The detailed preservation contract is in
[Functional parity](docs/FUNCTIONAL_PARITY.md). Shipping behavior and future
plans are deliberately separated in [Product strategy](docs/PRODUCT_STRATEGY.md).

## CLI compatibility

```bash
pilink init
pilink start
pilink start --mode single
pilink start --mode collaboration
pilink start --mode vscode
pilink serve --mode single
pilink serve --mode collaboration
pilink start --setup
pilink start --allow-unsafe-full-access
pilink serve
pilink chat
pilink reset
pilink hosting --help
pilink agent-auth --help
```

Do not let the CLI and extension own the same configuration simultaneously.
The Textual monitor requires its documented Python dependency; the normal VS
Code dashboard does not.

## Documentation

- [Documentation map](docs/README.md)
- [Installation](docs/INSTALLATION.md)
- [Illustrated setup walkthrough](docs/ILLUSTRATED_GUIDE.md)
- [Connect ChatGPT Work](docs/CONNECT_CHATGPT.md)
- [Usage, models, and costs](docs/USAGE_AND_COSTS.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Security model](docs/SECURITY_MODEL.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Upstream lineage](docs/UPSTREAM_LINEAGE.md)

## Development

```bash
npm ci
npm run test:all
npm run vscode:package
```

All project packages intentionally require Node.js 24.18.0 and npm 11.16.0
exactly for source/developer builds. Release users may use the isolated managed
Node runtime provisioned by the installer.

## License and acknowledgements

PiLink is distributed under the [MIT License](LICENSE). Preserve the license
and copyright notice when redistributing substantial portions.

PiLink uses the Pi Agent tool harness from
[`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent).
See [Upstream lineage](docs/UPSTREAM_LINEAGE.md) for branch and commit-level
history and attribution.
