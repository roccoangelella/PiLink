# Connect ChatGPT Work

PiLink exposes the selected project through an OAuth-protected MCP endpoint.

```text
ChatGPT Work -> private PiLink plugin -> HTTPS + OAuth/MCP -> PiLink -> selected project
```

## Requirements

Before connecting, verify all of these:

- PiLink for VS Code and its supported sidecar/runtime are installed on the workspace host through a [supported installation path](INSTALLATION.md). In Remote SSH, that means the remote SSH host.
- The intended project is open and trusted in VS Code.
- You can configure a public HTTPS endpoint for PiLink.
- Your ChatGPT account/workspace either already provides the intended private PiLink plugin or gives you permitted controls to create/import it. PiLink cannot grant those ChatGPT workspace controls.

For a durable endpoint, choose **Set up stable endpoint**. Use either a Cloudflare fixed domain you control or an existing HTTPS domain/reverse proxy you operate. Cloudflare provisioning requires a scoped API token with **Account -> Cloudflare Tunnel -> Edit**, **Zone -> DNS -> Edit**, and **Zone -> Zone -> Read**; see [Cloudflare fixed-domain token permissions](INSTALLATION.md#cloudflare-fixed-domain-token-permissions).

For evaluation, **Temporary quick start** creates a Quick Tunnel. Its public hostname is temporary and normally changes when the tunnel is recreated.

**Local only is not part of this remote connection flow.** It serves same-machine MCP clients and cannot be reached by remote ChatGPT Work.

## Prepare the private plugin before OAuth

The generic PiLink release does not contain a private ChatGPT plugin identity for your account/workspace. Use the branch that matches your ChatGPT permissions:

- **Private plugin already provisioned:** use the approved private PiLink plugin supplied by your workspace owner or publisher.
- **You can create/import private plugins:** after PiLink has a public HTTPS endpoint, create or import your private PiLink plugin using the MCP URL displayed by PiLink. Use OAuth and Dynamic Client Registration when the ChatGPT plugin workflow supports them.
- **You cannot create/import and no private plugin is provisioned:** stop here and ask the workspace administrator or plugin publisher to make the private plugin available. PiLink cannot enable those ChatGPT controls.

Do not install an unrelated public result just because its description says “MCP.” The repository's `plugins/pilink` directory is a separate local Codex integration, not the private ChatGPT plugin.

## Connect

1. Open the trusted project in VS Code and open **PiLink** from the Activity Bar.
2. Configure a public endpoint with **Set up stable endpoint** or **Temporary quick start**.
3. Confirm the launcher reports the local server and public HTTPS endpoint as ready.
4. If you must create/import the private plugin yourself, use the MCP URL PiLink displays and finish that ChatGPT-side setup before OAuth.
5. Select **Connect ChatGPT**.
6. Complete the local owner-verification step. This proves that the authorization flow was initiated by someone with access to the PiLink host/session.
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
