# Runtime modes and launch experiences

PiLink distinguishes between **server runtime capability modes** (the underlying tool catalog and coordination services configured via `PI_RUNTIME_MODE`) and **launch experiences** (how an operator or developer starts PiLink).

## Core server capability modes

PiLink has two core server capability modes:

| Mode | Core value | Use it when |
| --- | --- | --- |
| **Single agent** | `PI_RUNTIME_MODE=single` | You want the original PiLink workspace bridge: OAuth/MCP plus project tools without the shared collaboration layer. |
| **Collaborative public chat** | `PI_RUNTIME_MODE=collaboration` | Authenticated agents must coordinate through PiLink's durable chat, tasks, work loop, memory projections, or remote supervised-agent controls. |

Only `single` and `collaboration` are valid runtime capability modes. `cli` is a launch surface that pins the underlying runtime to `single`; VS Code is installed separately and is not a launch mode.

## Launch experiences and launcher order

When running `pilink start` interactively without flags, PiLink presents the launcher experiences in this order:

1. **Single agent** (`pilink start --mode single`)
   Classic single-agent PiLink bridge running runtime mode `single`.
2. **Agents chat** (`pilink start --mode collaboration`)
   Collaborative public-chat orchestration running runtime mode `collaboration` with shared chat, tasks, and coordination.
3. **CLI pilink-endpoint** (`pilink start --mode cli` or `pilink serve --mode cli`; dedicated `gateway` subcommands remain)
   Runs the ChatGPT LLM Gateway / loopback OpenAI-compatible endpoint. This pins the underlying runtime to least-privileged `single` mode and replaces the workspace tool catalog with the gateway protocol tools (`gateway_exchange`, `gateway_call_local_tool`).

PiLink for VS Code is installed or updated separately with `pilink install-vscode-plugin`. That command does not start PiLink or open a workspace.

## VS Code control-surface behavior

A fresh VSPiLink installation uses **Single agent**. More strongly, the current
graphical setup and endpoint-reconfiguration paths always write
`PI_RUNTIME_MODE=single` and Project-folder access.

The user therefore does not choose a runtime mode in the normal VS Code product.
The first-run choices are endpoint choices only:

- stable Cloudflare fixed domain;
- existing HTTPS domain;
- temporary Quick Tunnel;
- local only.

The launcher does not offer an **Enable collaboration** action. If it detects an
existing configuration already set to `collaboration`, it labels that as an
advanced existing state and offers **Switch to single-agent**. It does not
silently rewrite the old configuration merely by opening the dashboard.

The optional local Pi provider/runtime is separate from the core mode and is not
a parallel graphical product. Native VS Code MCP integration, provider-backed
chat/agents, and manual OAuth management are likewise outside the focused
launcher surface.

Neither core server mode by itself chooses hosting, authorizes an OAuth client,
or grants Full machine access.

## Choose from the CLI

For scripts, services, collaboration, and other operator-controlled launches,
use an explicit launch mode:

```bash
# 1. Original single-agent workspace bridge.
pilink start --mode single

# 2. Add durable public collaboration services (Agents chat).
pilink start --mode collaboration

# 3. CLI pilink-endpoint (ChatGPT LLM Gateway).
pilink start --mode cli

# Install/update the optional VS Code control surface separately.
pilink install-vscode-plugin
```

For a local server behind an existing reverse proxy:

```bash
pilink serve --mode single
pilink serve --mode collaboration
pilink serve --mode cli
```

The dedicated `gateway` subcommands remain available for managing the LLM Gateway:

```bash
pilink gateway start
pilink gateway serve
pilink gateway connect
pilink gateway status
pilink gateway release "done"
```

Do not write `PI_RUNTIME_MODE=vscode` or `PI_RUNTIME_MODE=cli`. The core server accepts only `single` and `collaboration` as runtime capability modes. `pilink start --mode vscode` is no longer accepted; use `pilink install-vscode-plugin`.

In an interactive terminal, `pilink start` without `--mode` presents the launcher
choices (1 Single agent, 2 Agents chat, 3 CLI pilink-endpoint). In headless or
automated operation, prefer an explicit mode or a reviewed `PI_RUNTIME_MODE` value
so the capability catalog does not depend on an interactive default.

## Capability and security boundaries

Runtime mode controls which server services are registered. It does not grant a
client access by itself:

| Control | Single agent | Collaborative public chat | Independent policy |
| --- | --- | --- | --- |
| Workspace `read`/`grep`/`find`/`ls`/`edit`/`write` | Yes, subject to OAuth scope | Yes, subject to OAuth scope | OAuth scope |
| Fixed `run` profiles | Yes | Yes | Repository execution policy/approval |
| General `bash` and outside-workspace files | Full access only | Full access only | `PI_UNSAFE_FULL_ACCESS`, client allowlist |
| Public collaboration chat/tasks | Not registered | Registered | OAuth scope and verified identity |
| Memory/work-loop coordination | Not registered | Registered | Private data placement and collaboration verification |
| Remote supervised-agent controls | Not registered | Available when configured | Provider credentials and permission policy |
| Hosting/OAuth/session quotas | Available | Available | Operator configuration |

The recommended baseline in either mode is a trusted project folder,
Project-folder access, narrowly scoped OAuth clients, and no repository
execution until the repository itself is trusted.

Collaboration is an additive capability choice. It is not the same as Full
access and does not make the filesystem/process boundary broader by itself.

## Why a mode change restarts PiLink

The mode changes the MCP tool catalog and server-side coordination services.
Changing that policy underneath already-initialized transports could give
simultaneous clients inconsistent capabilities, so a mode change requires a
restart.

OAuth client records and secrets are not recreated merely because the runtime
mode changes.

## Local provider-backed agents

The optional local Pi provider/runtime is separate from the core mode.

In Single agent mode, the loopback-protected administration layer can use a
configured provider for local supervised work without registering the public
collaboration toolset.

In Collaboration mode, the additional server-side coordination and remote
supervision services can be registered subject to their own authorization and
private-state checks.

Provider credentials never substitute for MCP OAuth, and MCP OAuth never signs
the user into a model provider. The focused VS Code launcher does not expose the
provider/agent product surface.

## Headless and SSH operation

Headless operation remains first-class:

```bash
PI_RUNTIME_MODE=single pilink serve
PI_RUNTIME_MODE=collaboration PI_CHAT_CLI=off pilink serve
```

Run the server/tunnel on the host that owns the workspace. In VS Code Remote
SSH, the extension host may also run on that remote machine, but the OAuth
state, private PiLink data, provider credentials, and public endpoint still
belong to the host that owns the PiLink process.

Do not run a CLI-owned and extension-owned PiLink process against the same
configuration/port at the same time.

The optional `pilink chat` Textual interface is a collaboration monitor, not a
second remote prompt box. It is useful only when the collaboration workflow is
enabled.

## Migration

When moving an existing deployment between modes:

1. stop the active PiLink process/tunnel;
2. back up the private `.env`, OAuth records, refresh/revocation state, and any
   collaboration data;
3. choose `single` for the original workspace bridge or `collaboration` for the
   additive coordination layer;
4. persist the selected `PI_RUNTIME_MODE` and restart;
5. re-check the OAuth scopes expected by clients whose tool catalog changed.

Existing collaboration data can remain in the private data directory while the
server runs in Single agent mode; those collaboration services are simply not
registered until Collaboration is enabled again.

For an existing VS Code project already in Collaboration mode, the launcher can
switch it back to Single agent. To enable Collaboration, use the PiLink CLI or
another explicit operator path; graphical endpoint setup intentionally resets
the project to Single agent.

## Troubleshooting

- `runtime_mode` in PiLink health/admin status is the effective core mode, not a
  hosting mode or UI tab.
- If collaboration tools are missing, check the runtime mode and restart after
  changing it. Do not enable Full access to repair a mode mismatch.
- A collaboration-disabled response is expected in Single agent mode.
- The main VS Code dashboard is a bridge launcher/status panel, not the
  collaboration console. Use the CLI/Textual operator paths when you need to
  inspect or operate collaboration-specific state.

See [PiLink VS Code extension](../VSCODE_EXTENSION.md) for the graphical flow and
[Security model](../SECURITY_MODEL.md) for the independent access boundaries.
