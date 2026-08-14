# VSPiLink for VS Code

VSPiLink connects ChatGPT Work to the Pi workspace tool harness through an
OAuth-protected MCP server:

```text
ChatGPT Work -> VSPiLink plugin -> HTTPS OAuth/MCP -> VSPiLink -> selected folder
```

ChatGPT Work remains the agent surface and coordinator. In the **Public chat &
orchestration** workflow, its selected model uses VSPiLink's file, Git, bounded
execution, collaboration, and supervised-agent tools, while its VS Code view
reports connection status and deliberately published activity. The view does
not read ChatGPT cookies, page content, private transcripts, or reasoning.

## Install a release

Use the installer shipped beside the VSIX. It verifies `SHA256SUMS`, installs
the extension, and provisions an isolated Node.js **24.18.0** runtime when an
exact compatible runtime is not already available.

Linux or macOS, from the unpacked release directory:

```bash
./install.sh
```

Windows PowerShell, from the unpacked release directory:

```powershell
.\install.ps1
```

After installation:

1. Return to VS Code.
2. Open the Command Palette with `Ctrl+Shift+P` (`Cmd+Shift+P` on macOS).
3. Run **Developer: Reload Window**.
4. Select **View -> Appearance -> Secondary Side Bar** if the right sidebar is
   hidden.
5. Select the **VSPiLink** view in the Secondary Side Bar.

On first launch, choose one runtime workflow in the dashboard:

- **Single-agent** is the safe local default. One supervised Pi agent works in
  the selected folder and shared public orchestration is disabled.
- **Public chat & orchestration** enables the collaboration tools used by
  authenticated ChatGPT MCP clients (shared chat, tasks, and agent
  supervision). It does not publish an endpoint or grant Full access; hosting
  and OAuth are separate, explicit steps.

The **ChatGPT MCP** and **Pi Local** buttons are execution surfaces, not runtime
workflow choices. Switching the runtime workflow while a service is active
asks before restarting it and keeps OAuth credentials unchanged.

For manual VSIX, Remote SSH, source-build, and upgrade instructions, read the
[complete installation guide](https://github.com/0xfunboy/VSPiLink/blob/master/docs/INSTALLATION.md).

## Connect ChatGPT Work

Current ChatGPT web support exposes remote MCP-backed tools through installed
plugins in **ChatGPT Work**. Normal Chat does not currently support plugins,
including on a Pro plan.

1. Open and trust the specific project folder VSPiLink should access.
2. Keep **ChatGPT MCP** selected in VSPiLink.
3. Use the Command Palette command **VSPiLink: Connect ChatGPT via MCP**, or
   select **Start setup** in the VSPiLink view.
4. Choose **Open folder** for normal confined access. Use **Full access** only
   after reviewing its remote-code-execution warning.
5. Configure a stable public HTTPS endpoint and wait for the local service and
   public endpoint to become healthy.
6. Open ChatGPT Work, open **Plugins**, and install the private VSPiLink plugin
   supplied by your personal or workspace plugin source. VSPiLink is not a
   public catalog result named "MCP server."
7. Complete OAuth once. Prefer **Dynamic Client Registration (DCR)** when it is
   available; DCR does not require you to copy a callback URL, client ID, or
   client secret.
8. Start a bounded read-only Work task, verify the reported workspace, and
   authorize writes only when the scope is correct.

The VSIX cannot embed or provision a private, per-account ChatGPT Work plugin
ID. ChatGPT assigns that ID only after the deployment owner registers the MCP
endpoint inside their account or workspace. The owner must create or import
the VSPiLink plugin once in Work, map it to that assigned ID, and make the
resulting entry available through the permitted personal or workspace plugin
source. Other authorized users install that owner-provided entry.

The plugin source and the VS Code extension are separate installation layers.
If your VSPiLink plugin is not visible in ChatGPT Work, ask its publisher or
workspace administrator to make it available. Do not install an unrelated
public plugin.

The optional repository bundle at `plugins/vspilink` is a separate Codex-only
loopback plugin for local development. It does not install, replace, or
configure the private ChatGPT Work plugin.

See the canonical
[ChatGPT Work connection guide](https://github.com/0xfunboy/VSPiLink/blob/master/docs/CONNECT_CHATGPT.md)
for DCR, the manual OAuth compatibility fallback, and troubleshooting.

## What appears in the VS Code view

The dashboard shows MCP/OAuth connection counts, metadata-only tool activity,
messages deliberately posted through `agent_chat_post`, shared tasks, and
supervised Pi agents. It does not mirror the ChatGPT conversation. An empty
collaboration feed is normal until an agent publishes a message or task.

Write task instructions in ChatGPT Work. The VSPiLink monitor is not a second
remote prompt box.

## Fixed `run` profiles

The MCP `run` tool accepts exactly six shell-free profiles:

- `git_status`, `git_diff`, `git_diff_staged`, and `git_log` inspect Git;
- `npm_build` and `npm_test` execute repository code and therefore require a
  trusted workspace plus `PI_ALLOW_WORKSPACE_EXECUTION=true`, or explicit Full
  access;
- `paths` is optional only for the Git profiles;
- `maxCount` applies only to `git_log` and must be from 1 through 100.

`run` requires the `mcp:write` or `mcp:tools` OAuth scope. Reconnect with write
access if a read-only client reports that the command is unavailable.

## Pi Local

Select **Pi Local** only when you deliberately want the Pi runtime to call a
separately configured model provider. Existing credentials, browser OAuth,
device-code login, API keys, provider/model selection, local chat, spawn,
output, follow-up, cancel, and stop remain available. Pi Local credentials and
provider usage are independent from ChatGPT MCP OAuth and OpenAI Work usage.

## Security

**Open folder** confines workspace tools to the selected canonical folder and
does not expose a general-purpose shell. Repository build/test profiles still
execute repository-controlled code and require a separate opt-in.

**Full access is remote code execution by design.** It permits an authorized
OAuth client to access files outside the selected folder and run commands with
the VSPiLink operating-system user's permissions. It does not grant root
privileges. Enable it only for a reviewed client on a machine you are prepared
to expose.

Secrets and coordination data must remain outside the workspace. Read the
[security model](https://github.com/0xfunboy/VSPiLink/blob/master/docs/SECURITY_MODEL.md)
before exposing a public endpoint.

VSPiLink is an independent project and is not affiliated with, endorsed by,
or distributed by OpenAI, Microsoft, or Cloudflare.
