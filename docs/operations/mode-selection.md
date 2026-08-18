# Runtime mode selection

PiLink has two core server capability modes:

| Mode | Core value | Use it when |
| --- | --- | --- |
| **Single agent** | `PI_RUNTIME_MODE=single` | You want the original PiLink workspace bridge: OAuth/MCP plus project tools without the shared collaboration layer. |
| **Collaborative public chat** | `PI_RUNTIME_MODE=collaboration` | Authenticated agents must coordinate through PiLink's durable chat, tasks, work loop, memory projections, or remote supervised-agent controls. |

`pilink start --mode vscode` is not a third server capability mode. It is only a
handoff into the optional PiLink VS Code graphical control surface.

## VS Code launcher behavior

A fresh VSPiLink installation uses **Single agent** for the ordinary graphical
setup. The user does not have to understand the collaboration architecture
before starting the MCP bridge.

The main launcher no longer offers collaboration as a peer of the safe start
buttons. **Quick start for ChatGPT** and **Local only** both use the single-agent
workflow and Project-folder access.

The retained **Advanced setup...** compatibility flow can still expose a
workflow selector for operators who deliberately enter that path. An existing
project already configured for collaboration is also detected rather than
silently rewritten; the dashboard offers a clear switch back to Single agent.

The graphical dashboard no longer has a top-level ChatGPT-MCP-versus-Pi-Local
mode selector. ChatGPT is treated as an ordinary remote MCP client of the
server. The optional local Pi provider/runtime is separate from the core mode
and is not promoted as a parallel graphical product.

Neither server mode chooses hosting, authorizes an OAuth client, or grants Full
machine access.

## Choose from the CLI

For scripts, services, and other automated launches, use an explicit core mode:

```bash
# Original single-agent workspace bridge.
pilink start --mode single

# Add durable public collaboration services.
pilink start --mode collaboration
```

For a local server behind an existing reverse proxy:

```bash
pilink serve --mode single
pilink serve --mode collaboration
```

The graphical handoff remains available:

```bash
pilink start --mode vscode
```

Do not write `PI_RUNTIME_MODE=vscode`. The core server accepts only `single` and
`collaboration`.

In an interactive terminal, `pilink start` without `--mode` may present the CLI
entry choices. In headless or automated operation, prefer an explicit mode or a
reviewed `PI_RUNTIME_MODE` value so the capability catalog does not depend on an
interactive default.

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

In Single agent mode, the loopback-protected administration path can use a
configured provider for local supervised work without registering the public
collaboration toolset.

In Collaboration mode, the additional server-side coordination and remote
supervision services can be registered subject to their own authorization and
private-state checks.

Provider credentials never substitute for MCP OAuth, and MCP OAuth never signs
the user into a model provider. The normal VS Code launcher does not ask users
to configure this provider path.

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

For an existing VS Code project already in Collaboration mode, the launcher
shows that as an advanced configuration and can switch it back to Single agent.
To enable Collaboration from a fresh setup, use the CLI or deliberately enter
the retained Advanced setup compatibility flow rather than expecting a normal
main-screen toggle.

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
