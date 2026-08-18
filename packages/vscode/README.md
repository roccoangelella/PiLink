# VSPiLink for VS Code

VSPiLink is the optional graphical control surface for **PiLink**. The core
server, CLI, OAuth implementation, and MCP tools remain in PiLink itself.

The extension has one primary job:

> start and manage the PiLink MCP bridge for the project open in VS Code.

It is intentionally **not** a second ChatGPT interface. Normal work happens in
ChatGPT Work (or another MCP client); VSPiLink shows the bridge status and the
few controls needed to manage it.

```text
ChatGPT Work -> PiLink plugin -> HTTPS OAuth/MCP -> PiLink -> project folder
                                            ^
                                            |
                                  VSPiLink manages this side
```

## The new default

A fresh VSPiLink installation now uses **single-agent** automatically. You no
longer have to choose between server workflows before understanding what those
workflows mean.

The normal safety boundary is also fixed on first run:

- project-folder access only;
- no unrestricted shell;
- Full access is never a first-run option;
- collaboration/orchestration is an advanced opt-in.

## First run

1. Open the project folder in VS Code and trust it.
2. Open **VSPiLink** in the Secondary Side Bar.
3. Choose one of the three setup actions:
   - **Quick start for ChatGPT** — starts single-agent PiLink with project-folder
     access and a temporary Cloudflare HTTPS endpoint;
   - **Local only** — starts the same safe PiLink server without exposing a
     public endpoint;
   - **Stable endpoint...** — opens the advanced hosting setup for a persistent
     hostname or existing reverse proxy.
4. When the public MCP endpoint is ready, select **Connect ChatGPT**.
5. Finish OAuth in ChatGPT Work.
6. Do the actual coding task in ChatGPT Work.

The Quick Tunnel hostname changes when it is recreated. Use a stable endpoint
for a connection you want to keep across restarts.

## What the main card means

The dashboard follows the lifecycle rather than exposing every subsystem at
once:

| State | Main action |
| --- | --- |
| Restricted workspace | **Manage Workspace Trust** |
| Not configured | **Quick start for ChatGPT** |
| Configured but stopped | **Start PiLink** |
| Public MCP online, no client | **Connect ChatGPT** |
| OAuth registered but unfinished | **Continue connection** |
| OAuth ready | **Open ChatGPT Work** |
| Active MCP transport | **Open ChatGPT Work** |

Three small status fields stay visible:

- **Server** — whether PiLink is running;
- **Remote** — local-only, not connected, OAuth ready, or active;
- **Access** — project folder or Full machine.

`OAuth ready` and `Connected` are deliberately different. OAuth can remain
valid while no MCP transport is open; ChatGPT creates one when it actually
uses PiLink tools.

## Advanced

Everything that is useful but not part of the ordinary start/connect loop is
under one **Advanced** disclosure:

- server restart, hosting changes, config, terminal, and MCP URL;
- switching from single-agent to **Public chat & orchestration**;
- explicit Full access for an eligible, already-authorized OAuth client;
- VS Code's optional native MCP provider;
- manual OAuth client registration;
- the optional local Pi provider/agent runtime.

This keeps compatibility with the existing PiLink features without requiring a
new user to understand all of them on first launch.

### Collaboration

**Public chat & orchestration** remains supported, but it is no longer presented
as a peer of the basic start button. Enable it only when you actually need
shared PiLink chat, tasks, work-loop coordination, memory projections, or
remote supervised-agent controls.

Changing workflow restarts the server because it changes the MCP tool catalog.
It does not create hosting, grant Full access, or authorize ChatGPT by itself.

### Optional local Pi agent

The provider/model and supervised local-agent controls are retained under
Advanced. They are separate from ChatGPT MCP and use their own provider
credentials. The previous full local-chat surface is no longer the conceptual
center of the dashboard.

## Activity

When PiLink reports MCP activity, the dashboard shows a small recent-activity
list containing only operational metadata such as tool name, outcome, duration,
and access mode.

It intentionally does **not** display prompts, file paths, arguments, tool
results, ChatGPT transcript content, cookies, DOM data, or reasoning.

For the collaboration task/chat monitor, enable the collaboration workflow and
open **Agent & Task Monitor** from Advanced.

## Full access

The default **Project folder** mode confines workspace file tools to the
selected canonical project and does not expose a general shell.

**Full access** is remote code execution by design. It can read and modify files
outside the workspace and run commands with the PiLink operating-system user's
permissions. VSPiLink keeps it behind Advanced and only enables its control
after a suitable ChatGPT OAuth client exists.

Re-running the normal hosting/setup flow with project-folder access resets the
configuration back to the safe boundary.

## Install

Use the installer shipped with a VSPiLink release. It verifies the release
checksums, installs the VSIX, and provisions an isolated Node.js **24.18.0**
runtime when needed.

Linux/macOS:

```bash
./install.sh
```

Windows PowerShell:

```powershell
.\install.ps1
```

Then reload VS Code and open **View -> Appearance -> Secondary Side Bar** if the
VSPiLink view is hidden.

For source builds, Remote SSH, and upgrade details, see
[Installation](../../docs/INSTALLATION.md).

## More documentation

- [VSPiLink UX and operation guide](../../docs/VSCODE_EXTENSION.md)
- [Connect ChatGPT Work](../../docs/CONNECT_CHATGPT.md)
- [Architecture](../../docs/ARCHITECTURE.md)
- [Security model](../../docs/SECURITY_MODEL.md)
- [Troubleshooting](../../docs/TROUBLESHOOTING.md)

PiLink is an independent project and is not affiliated with, endorsed by, or
distributed by OpenAI, Microsoft, or Cloudflare.
