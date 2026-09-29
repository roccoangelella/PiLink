# Connect ChatGPT Work

PiLink exposes the selected project through an OAuth-protected MCP endpoint.

```text
ChatGPT Work -> private PiLink plugin -> HTTPS + OAuth/MCP -> PiLink -> selected project
```

## Requirements

Before connecting, verify all of these:

- VS Code and the PiLink sidecar/runtime are installed through a supported path.
- The intended project is open and trusted in VS Code.
- A public HTTPS endpoint exists for remote ChatGPT Work use.
- Your ChatGPT account/workspace is entitled to create, import, or install the private PiLink plugin. PiLink cannot enable that ChatGPT capability for you.

The generic PiLink release does not include a plugin identity for your ChatGPT account. Your deployment owner must make the private PiLink plugin available through the workspace's permitted source, or configure it with the MCP URL PiLink displays. If the plugin or creation controls are missing, ask your workspace administrator or plugin publisher. Do not install an unrelated public result just because its description says “MCP.” The repository's `plugins/pilink` directory is a separate local Codex integration, not the private ChatGPT plugin.

For a durable endpoint, choose **Set up stable endpoint** in the PiLink Activity Bar view. Use either a Cloudflare fixed domain you control with the required scoped token, or an existing HTTPS domain/reverse proxy you operate.

For evaluation, **Temporary quick start** creates a Quick Tunnel. Its public hostname is temporary and normally changes when the tunnel is recreated.

**Local only** is intentionally not public. It can serve same-machine clients, but remote ChatGPT Work cannot reach it.

## Connect

1. Open the trusted project in VS Code.
2. Open **PiLink** from the Activity Bar.
3. Configure the endpoint with **Set up stable endpoint**, **Temporary quick start**, or **Local only** as appropriate.
4. Confirm the launcher reports the local server and endpoint as ready.
5. For a public endpoint, select **Connect ChatGPT**.
6. Complete the local owner-verification step. This proves that the browser flow was initiated by someone with access to the PiLink host/session.
7. Continue into OAuth and authorize the intended private PiLink plugin.
8. Return to ChatGPT Work and use that plugin connection.

If OAuth setup was started but not finished, the launcher can show **Continue connection**. When durable authorization is stored, it can show **OAuth ready** or make **Open ChatGPT Work** the next action.

## OAuth ready is not an active MCP session

The launcher separates authorization from live transport state:

| State | Meaning |
| --- | --- |
| Not connected | No usable ChatGPT authorization is prepared yet. |
| Authorization pending | The connection flow exists but OAuth has not completed. |
| **OAuth ready** | Authorization is stored and can be reused. No live MCP transport is implied. |
| Connected / active sessions | ChatGPT Work currently has one or more MCP transports open to PiLink. |

It is normal to see **OAuth ready** with no active session. ChatGPT Work can open a transport only when a task actually needs PiLink tools.

Do not repeat OAuth registration just because no transport is active. Prefer Dynamic Client Registration when the plugin supports it. If a legacy builder explicitly requires user-defined OAuth client values, use PiLink's [CLI operator guidance](operations/getting-started.md) rather than looking for a manual-registration button in the VS Code launcher. Never paste an OAuth client secret into a chat, repository, screenshot, or issue.

## First task: read only

Start by verifying that ChatGPT Work is reaching the project you intended:

```text
Use PiLink to inspect the configured project. Report the project root, Git
status, package scripts, and the tests you would run. Do not modify files.
```

Confirm the reported project and scope before asking for writes, package changes, repository execution, collaboration, or broader operator capabilities.

## What the VS Code dashboard shows

The normal dashboard shows bridge state only:

- **Server** — whether the local PiLink process is running.
- **Endpoint** — whether the endpoint is local-only or publicly reachable over HTTPS.
- **ChatGPT** — whether authorization is unconfigured, pending, ready, or currently connected.

The dashboard does **not** provide an activity feed, task list, agent console, or ChatGPT transcript. It also does not mirror prompts, tool arguments, tool results, or file contents.

## Returning later

With a stable HTTPS origin, start PiLink if needed and return to ChatGPT Work. Stored OAuth authorization can normally be reused.

A Quick Tunnel is different: recreating it changes the public origin, so a private plugin connection tied to the old URL may need to be updated.

For launcher behavior and recovery see [PiLink for VS Code](VSCODE_EXTENSION.md). For the shortest onboarding path see [Getting started](GETTING_STARTED.md). For trust boundaries see [Security model](SECURITY_MODEL.md).
