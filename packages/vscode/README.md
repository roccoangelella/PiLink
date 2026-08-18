# PiLink for VS Code

The PiLink VS Code extension is a graphical launcher and status panel for the
PiLink MCP bridge. The server, CLI, OAuth implementation, and MCP tools remain
in the core PiLink project.

Its job is intentionally narrow:

> choose the project, start PiLink safely, expose the MCP endpoint, connect
> ChatGPT, and show whether the bridge is working.

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
3. Choose the endpoint you actually want:
   - **Set up stable endpoint** — recommended for ChatGPT; use a Cloudflare
     fixed domain or an existing HTTPS reverse proxy;
   - **Temporary quick start** — use a Cloudflare Quick Tunnel for evaluation;
   - **Local only** — keep the bridge on this machine.
4. Every graphical setup forces **Single agent** and **Project-folder** access.
5. When a public endpoint is ready, select **Connect ChatGPT**.
6. Complete OAuth once, then do the actual work in ChatGPT Work.

The stable endpoint is primary because a Quick Tunnel receives a new URL when it
is recreated. Reconfiguration uses the same safe graphical policy; it does not
surface collaboration or Full-access choices.

## What the screen shows

The large card is state-driven and presents the next ordinary action rather
than every capability PiLink supports.

| State | Main action |
| --- | --- |
| Restricted workspace | **Manage Workspace Trust** |
| New project | **Set up stable endpoint** |
| Configured but stopped | **Start PiLink** |
| Local bridge only | **Configure remote endpoint** |
| Public endpoint ready | **Connect ChatGPT** |
| OAuth unfinished | **Continue connection** |
| OAuth ready | **Open ChatGPT Work** |
| Active MCP session | **Open ChatGPT Work** |

Three compact facts remain visible: **Server**, **Endpoint**, and **ChatGPT**.
This separates “the process is running,” “the endpoint is reachable,” and
“ChatGPT is authorized/connected.”

`OAuth ready` does not mean a network connection must remain open. ChatGPT can
create an MCP session when it actually invokes PiLink tools.

## Details & recovery

The collapsed **Details & recovery** section contains bridge operations useful
for inspection or repair:

- restart or stop PiLink;
- **Reconfigure endpoint...**;
- copy the MCP URL;
- open the private PiLink configuration;
- show the PiLink terminal;
- open the guide.

The reconfiguration flow supports the safe graphical hosting options — stable
Cloudflare fixed domain, existing HTTPS domain, Quick Tunnel, or local-only —
and always writes the Single-agent/Project-folder policy.

Local model-provider chat, native VS Code MCP, manual OAuth clients,
collaboration enablement, legacy managed Named-Tunnel services, and Full-access
launch are intentionally outside the ordinary graphical product. Use the core
PiLink CLI/operator paths when those specialist capabilities are actually
needed.

## Existing advanced configurations

The extension does not silently reinterpret an old configuration.

If a project is already configured for **Collaboration**, the dashboard labels
that advanced state and offers **Switch to single-agent**.

If **Full access** is already configured, the dashboard shows a safety state
instead of an ordinary Start button. It will not start or restart that saved
configuration from the normal graphical workflow. **Reconfigure safely...**
returns it to Single-agent, Project-folder access. Deliberate unrestricted
operation belongs to the PiLink CLI/operator workflow.

Legacy managed Named-Tunnel services are also not started by the simplified
launcher; reconfigure them into one of the supported graphical endpoint types or
manage them from the CLI/service manager.

## Recent activity

When the current administrative projection supplies audit metadata, a small
activity list answers one useful question: “is the remote client actually
calling PiLink?” It shows only bounded operational metadata such as tool name,
outcome, and duration.

It intentionally does not display prompts, file paths, tool arguments, tool
results, ChatGPT transcript content, cookies, DOM data, or model reasoning.

## Install

Use the installer shipped with a PiLink VS Code release. It verifies release
checksums, installs the VSIX, and provisions the supported Node.js runtime when
needed.

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
