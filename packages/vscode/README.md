# PiLink for VS Code

The PiLink VS Code extension is a graphical launcher and status panel for the
PiLink MCP bridge. The server, CLI, OAuth implementation, and MCP tools remain
in the core PiLink project.

Its job is intentionally narrow:

> choose the project, start PiLink safely, expose the MCP endpoint when needed,
> connect ChatGPT, and show whether the bridge is working.

It is not a second chat application, agent dashboard, or alternative PiLink
runtime.

```text
ChatGPT Work -> PiLink plugin -> HTTPS OAuth/MCP -> PiLink -> project folder
                                            ^
                                            |
                                  VS Code manages this side
```

## First run

1. Open the project folder in VS Code and trust it.
2. Open **PiLink** in the Secondary Side Bar.
3. Use one of the ordinary launch actions:
   - **Quick start for ChatGPT** — single-agent, project-folder access, temporary
     Cloudflare HTTPS endpoint;
   - **Local only** — the same safe bridge without a public endpoint.
4. When a public endpoint is ready, select **Connect ChatGPT**.
5. Complete OAuth once, then do the actual work in ChatGPT Work.

Quick start is deliberately the shortest safe path. Its public URL changes when
the Quick Tunnel is recreated. If you need a durable domain, use **Advanced
setup...** and review the additional hosting/workflow/access choices there.

## What the screen shows

The large card is state-driven and presents the next ordinary action rather
than every capability PiLink supports.

| State | Main action |
| --- | --- |
| Restricted workspace | **Manage Workspace Trust** |
| New project | **Quick start for ChatGPT** |
| Configured but stopped | **Start PiLink** |
| Local bridge only | **Advanced remote setup...** |
| Public endpoint ready | **Connect ChatGPT** |
| OAuth unfinished | **Continue connection** |
| OAuth ready | **Open ChatGPT Work** |
| Active MCP session | **Open ChatGPT Work** |

Three compact facts remain visible: **Server**, **Endpoint**, and **ChatGPT**.
This deliberately separates “the process is running,” “the endpoint is
reachable,” and “ChatGPT is authorized/connected.”

`OAuth ready` does not mean a network connection must remain open. ChatGPT can
create an MCP session when it actually invokes PiLink tools.

## Details & recovery

The collapsed **Details & recovery** section contains the operational controls
that are useful when something needs inspection or repair:

- restart or stop PiLink;
- enter **Advanced setup...**;
- copy the MCP URL;
- open the private PiLink configuration;
- show the PiLink terminal;
- open the guide.

Advanced setup is intentionally not the happy path. It retains the older native
setup flow for stable/legacy hosting and specialist workflow/access choices.

The extension also preserves compatibility code for older PiLink features, but
it no longer promotes local model-provider chat, native VS Code MCP integration,
manual OAuth registration, collaboration enablement, or Full-access launch as
parallel products in the main dashboard.

## Existing advanced configurations

The extension does not silently rewrite an existing installation.

If a project is already configured for **Public chat & orchestration**, PiLink
shows that as an advanced configuration and offers a clear return to the
single-agent workflow.

If **Full access** is already configured, PiLink shows a safety state instead of
an ordinary Start button. Quick start and Local only never request Full access.
Operators who deliberately need unrestricted machine access can continue to use
the PiLink CLI and its explicit security controls, or review the legacy advanced
setup path deliberately.

## Recent activity

When the current administrative projection supplies audit metadata, a small
activity list answers one useful question: “is the remote client actually
calling PiLink?” It shows only bounded operational metadata such as tool name,
outcome, and duration.

It intentionally does not display prompts, file paths, tool arguments, tool
results, ChatGPT transcript content, cookies, DOM data, or model reasoning.

## Install

Use the installer shipped with a VSPiLink/PiLink VS Code release. It verifies
release checksums, installs the VSIX, and provisions the supported Node.js
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
PiLink view is hidden.

For source builds, Remote SSH, and upgrade details, see
[Installation](../../docs/INSTALLATION.md).

## More documentation

- [VS Code extension guide](../../docs/VSCODE_EXTENSION.md)
- [Connect ChatGPT Work](../../docs/CONNECT_CHATGPT.md)
- [Architecture](../../docs/ARCHITECTURE.md)
- [Security model](../../docs/SECURITY_MODEL.md)
- [Troubleshooting](../../docs/TROUBLESHOOTING.md)

PiLink is an independent project and is not affiliated with, endorsed by, or
distributed by OpenAI, Microsoft, or Cloudflare.
