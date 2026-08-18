# Illustrated setup walkthrough

These sanitized illustrations show the PiLink 2.2.0 connection concepts without
including a real username, filesystem path, domain, OAuth code, or credential.
Some screenshots predate the launcher-only dashboard, so use the current button
names in the text below when they differ from an illustration.

## 1. Install the extension

![Install the VSPiLink VSIX and reload VS Code](assets/guide/01-install.svg)

Open the Command Palette, run **Extensions: Install from VSIX...**, select the
versioned file, then run **Developer: Reload Window**.

## 2. Start PiLink for the project

![Open ChatGPT Work and connect PiLink through VSPiLink](assets/guide/02-connect-work.svg)

Open **View -> Appearance -> Secondary Side Bar**, select **PiLink**, and use the
main setup card.

For the shortest remote path select **Quick start for ChatGPT**. This uses the
single-agent workflow, Project-folder access, and a temporary HTTPS endpoint.
Use **Local only** when no remote client needs to reach PiLink.

For a durable hostname or another specialist deployment, choose **Advanced
setup...** deliberately. That retained compatibility flow can expose additional
hosting, workflow, and access choices; it is not the ordinary one-click path.

When PiLink reports that the public MCP endpoint is online, select **Connect
ChatGPT** and install/connect the private PiLink plugin for your deployment in
ChatGPT Work.

## 3. Approve OAuth once

![Review and approve the PiLink OAuth request](assets/guide/03-oauth.svg)

The extension performs a local-owner verification step before opening the
remote connection flow. Verify that you initiated the connection, then complete
OAuth for the intended PiLink plugin.

A successful authorization is durable. **OAuth ready** does not mean an MCP
transport must stay open continuously; ChatGPT can create one when it invokes
PiLink tools.

## 4. Work in ChatGPT; manage the bridge in VS Code

![Monitor agents, tasks, and audited activity in VS Code](assets/guide/04-monitor.svg)

Write the coding task in ChatGPT Work. The current PiLink dashboard shows the
local server state, endpoint state, ChatGPT authorization/connection state, and
— when the active admin projection supplies it — a short metadata-only list of
recent MCP calls.

It does not mirror the ChatGPT transcript or display prompts, file paths,
arguments, or tool results.

The older illustration may show agent/task controls. Those collaboration
surfaces are no longer part of the normal launcher UI. Collaboration remains a
PiLink operator capability available from its CLI/compatibility paths when
explicitly needed.

For the current end-to-end flow see [PiLink VS Code extension](VSCODE_EXTENSION.md)
and [Connect ChatGPT Work](CONNECT_CHATGPT.md).
