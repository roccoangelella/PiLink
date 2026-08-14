# Connect ChatGPT Work

This is the canonical connection guide. Current official OpenAI documentation
places plugins and their remote MCP-backed tools in **ChatGPT Work** on the web.
Normal Chat does not currently expose those plugin tools. PiLink cannot
change an OpenAI product entitlement or workspace policy.

The supported flow is:

```text
ChatGPT Work -> installed/private plugin -> OAuth -> PiLink MCP endpoint
             -> Pi tool harness -> selected VS Code workspace
```

## Before you begin

Confirm all four layers:

1. PiLink is installed and Node.js 24.18.0 is available. If you want graphical
   control, install the optional VSPiLink extension too.
2. The selected workspace is trusted and the sidecar is healthy on loopback.
3. The public PiLink origin is stable, HTTPS, and reachable from the
   Internet.
4. Your ChatGPT plan and workspace policy allow ChatGPT Work and the PiLink
   plugin or personal/workspace plugin source.

OpenAI documents plugin use on the web as: switch to **Work**, then open
**Plugins**. The public directory, personal marketplace, workspace marketplace,
and creation controls visible to you depend on product rollout and administrator
policy. PiLink is not an unrelated public catalog result that can be found by
searching for "MCP server".

## 1. Prepare the local bridge

1. In VS Code, open the project folder.
2. If the right sidebar is hidden, select **View -> Appearance -> Secondary
   Side Bar**, then select the **VSPiLink** view.
3. Keep **ChatGPT MCP** selected.
4. Select the guided connect/setup action.
5. Choose **Open folder** access for the normal safe mode.
6. Choose a stable HTTPS origin:
   - **Cloudflare Named Tunnel** for a persistent managed tunnel;
   - **Existing domain** when you already operate DNS and a reverse proxy;
   - **Quick Tunnel** only for a temporary evaluation.
7. Wait until the runtime and public endpoint are both healthy.
8. Copy the MCP URL ending in `/sse` when PiLink (or the VSPiLink extension)
   presents it.

The `/sse` URL is a protocol endpoint, not a website. Opening it in a browser
may show an authentication response or no useful page. Use PiLink health and
OAuth discovery checks to validate it.

## 2. Make PiLink available as a plugin

This is the one owner-only provisioning step that a generic PiLink release
cannot perform. ChatGPT creates a private `plugin_asdk_app...` identifier in
the owner's account or workspace only after that owner registers the MCP
server connection. A release cannot safely embed, predict, or provision that
per-account identifier.

The deployment owner must create or import PiLink once in **Work**, map the
plugin manifest to the identifier ChatGPT assigned, and publish or share it
through the personal or workspace plugin source permitted by policy. Other
authorized users then install that owner-provided entry. They do not search
the public catalog and do not create another local bridge.

In ChatGPT web:

1. Switch the surface selector from **Chat** to **Work**.
2. Open **Plugins** in the left sidebar.
3. Open the PiLink plugin supplied through your personal or workspace plugin
   source, then install it.
4. If you are the plugin owner, use the personal/workspace creation or import
   controls exposed to your account to configure the remote PiLink MCP
   endpoint. Those controls are not available to every member.
5. If no personal/workspace PiLink entry or creation control exists, stop and
   ask the workspace administrator or plugin publisher to make it available.

Do not install Workable, Alpic, or another public result merely because its
description contains "MCP". It will connect to that vendor's server, not your
PiLink instance.

The repository directory `plugins/pilink` is an optional **Codex local
plugin** whose MCP URL is loopback-only. It is intentionally separate from the
private ChatGPT Work plugin and cannot provision or substitute for the
owner-specific ChatGPT identifier above.

Official references:

- [Plugins](https://learn.chatgpt.com/docs/plugins)
- [MCP in ChatGPT and Codex](https://learn.chatgpt.com/docs/extend/mcp)
- [Build an MCP-backed plugin](https://developers.openai.com/plugins/build/mcp-server)

## 3. Complete OAuth

PiLink publishes protected-resource and authorization-server metadata. A
compatible OpenAI host discovers its authorization URL, token URL, scopes, and
client-registration methods.

### Dynamic Client Registration

Use DCR when the plugin builder offers it:

1. Select **OAuth** for the PiLink connection.
2. Select **Dynamic Client Registration (DCR)** if a registration method is
   requested.
3. Create or save the connection.
4. Select **Connect**, **Authenticate**, or **Sign in with PiLink**.
5. On the PiLink consent page, verify the client name, endpoint, workspace,
   and requested scopes.
6. Select **Approve** once and wait for the redirect back to ChatGPT.

DCR registers the callback and client automatically. Do **not** search for a
callback/fallback URL, invent a client ID, or paste a secret when DCR succeeds.
PiLink uses Authorization Code with PKCE for the public DCR client.

### User-defined compatibility fallback

Use this only when the active builder explicitly supports a user-defined OAuth
client but cannot use DCR:

1. Copy the exact Callback/Redirect URL displayed by that builder.
2. Open the VSPiLink extension's manual OAuth fallback.
3. Register that exact callback.
4. Copy the generated Client ID, one-time Client secret, Authorization URL, and
   Token URL into the matching fields.
5. Use `client_secret_post` when the builder asks for the token endpoint
   authentication method.
6. Request only the scopes required for the intended tools.

Never paste the client secret into ChatGPT conversation text, a repository,
issue, screenshot, or log. If the builder does not expose these controls, the
manual fallback is not available on that surface.

### Legacy Developer Mode

Older ChatGPT interfaces exposed a Developer Mode/custom-connector workflow.
PiLink retains compatibility with that flow when the account still shows it,
but it is not the current primary documentation path. Labels, locations, and
availability may differ or disappear. Do not weaken DCR, OAuth, or callback
validation to compensate for a missing legacy control.

## 4. Run the first task

1. Start a new **Work** task.
2. Enable or invoke the installed PiLink plugin.
3. Begin with a bounded read-only request, for example:

   ```text
   Use PiLink to inspect the configured workspace. Report its root, Git
   status, package scripts, and the tests you would run. Do not modify files.
   ```

4. Confirm the VSPiLink sidebar reports an authenticated PiLink MCP session.
5. Review the reported workspace before authorizing writes or execution.
6. Continue with a narrowly scoped implementation request.

ChatGPT decides when to invoke tools. A connected session does not mean every
message will call PiLink.

## What the monitor shows

- MCP connection and durable OAuth identity counts;
- metadata-only tool activity;
- messages explicitly posted through `agent_chat_post`;
- tasks created or updated through `agent_task_*`;
- supervised Pi agent status when that optional runtime is configured.

It does not read the ChatGPT DOM, cookies, reasoning, private transcript, or
composer. An empty collaboration feed can be healthy if no agent has posted to
the shared chat or task board.

## Returning after a restart

With a stable origin, PiLink should reuse the saved server configuration and
OAuth client. A new transport session may appear without repeating setup.

Quick Tunnel is different: its hostname changes, so the previous plugin
connection points to an obsolete origin. Create a new connection for the new
origin or migrate to a Named Tunnel/existing domain.

## Normal Chat, Work, and Codex

| Surface | PiLink use |
| --- | --- |
| Normal Chat | Conversation only; current official plugin/MCP tools are not available there |
| ChatGPT Work | Supported web workflow for installed plugins and remote MCP tools |
| Codex desktop/CLI/IDE | Can connect to MCP through Codex's own MCP configuration; this is separate from the ChatGPT Work plugin connection |
| Pi Local | Uses a provider configured in PiLink and separate credentials/usage |

Work and Codex share OpenAI usage/credits under current official pricing. A Pro
plan can increase included usage, but it does not make PiLink MCP available
inside normal Chat. See [Usage, models, and costs](USAGE_AND_COSTS.md).
