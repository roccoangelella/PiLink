# Connect ChatGPT Work

PiLink exposes an OAuth-protected MCP endpoint that a compatible ChatGPT plugin
can use to reach the selected project.

```text
ChatGPT Work -> installed/private PiLink plugin -> OAuth -> PiLink MCP endpoint
                                                   |
                                                   v
                                            selected project
```

The PiLink VS Code extension is optional. When installed, it replaces most of
the ordinary CLI startup with a small launcher/status surface. It does not
embed ChatGPT or read its page, cookies, transcript, composer, or reasoning.

## Fast path with the VS Code launcher

For a first connection where a temporary HTTPS hostname is acceptable:

1. Open the project folder in VS Code and trust it.
2. Open **PiLink** in the Secondary Side Bar.
3. Select **Quick start for ChatGPT**.
4. Wait until the dashboard reports that PiLink is online.
5. Select **Connect ChatGPT**.
6. In ChatGPT Work, install or connect the private PiLink plugin supplied by
   your personal/workspace plugin source.
7. Complete the PiLink owner-verification and OAuth flow.
8. Start with a bounded read-only task and verify that PiLink reports the
   project you expected.

Quick start deliberately uses:

- the **single-agent** PiLink workflow;
- **Project folder** access;
- no unrestricted shell;
- a Cloudflare Quick Tunnel for the public HTTPS origin.

A Quick Tunnel is temporary. Its public hostname changes when it is recreated.

## Stable deployment

For a durable public origin, deliberately enter **Advanced setup...** from the
PiLink launcher. The retained advanced setup supports stable Cloudflare
fixed/Named-Tunnel deployments and an existing HTTPS domain/reverse proxy, as
well as legacy hosting paths.

Because this is the compatibility/operator flow, it can expose extra workflow
and access choices. Review them explicitly. Keep **Single agent** and **Project
folder only** unless you actually intend to enable collaboration or broader
machine authority.

After the server and public endpoint are healthy, return to the main card and
select **Connect ChatGPT**.

The MCP URL ends in `/sse`. It is a protocol endpoint, not a human website.
Opening it in a browser is not a useful connection test; use PiLink health and
OAuth status instead.

## Make PiLink available as a ChatGPT plugin

The generic PiLink release cannot contain the private plugin identity assigned
inside a particular ChatGPT account or workspace. The deployment owner must
create/import or otherwise publish the PiLink plugin entry through the
personal/workspace plugin source allowed by that account, then make that entry
available to the intended users.

In ChatGPT Work:

1. Open the available **Plugins** controls.
2. Install or connect the PiLink entry supplied for your deployment.
3. If you are the deployment owner and creation/import controls are available,
   configure that entry with the PiLink MCP URL shown by the launcher.
4. If no PiLink entry or permitted creation/import control exists, ask the
   workspace administrator or plugin publisher to make it available.

Do not install an unrelated public result merely because its description says
"MCP". That connects to the other provider's server, not to your PiLink
instance.

The repository directory `plugins/pilink` is a separate local Codex plugin used
for local development. It does not provision or replace the private ChatGPT
plugin entry for a remote PiLink deployment.

## OAuth with the VS Code launcher

The extension keeps the public endpoint and local machine authorization
separate. Knowing the public MCP URL is not enough to take control of the
machine.

When the extension begins owner pairing it:

1. asks the local PiLink server for a short-lived, one-use pairing page;
2. shows a separate local verification code in VS Code;
3. copies that code only after the local user explicitly chooses to continue;
4. opens the pairing page and then the ChatGPT destination in the browser.

The pairing URL alone cannot complete local owner verification. Approve only a
connection you just initiated yourself.

### Dynamic Client Registration

When the active ChatGPT plugin flow supports Dynamic Client Registration (DCR),
prefer it. PiLink exposes OAuth discovery/registration metadata and validates
the pending client, redirect URI, scope, OAuth state, and S256 PKCE challenge
before authorization completes.

The intended flow does not require manually creating another OAuth client just
because no MCP transport is currently open.

### Manual compatibility fallback

Keep the manual path only for a builder that explicitly requires user-defined
OAuth client values and cannot use the automatic registration flow. This path
is an operator/compatibility feature; it is not a normal dashboard action.

1. copy the exact Callback/Redirect URL displayed by that builder;
2. use PiLink's manual OAuth-client registration path;
3. register that exact callback;
4. copy the generated client ID, one-time client secret, authorization URL, and
   token URL into the corresponding builder fields;
5. request only the scopes needed for the intended tools.

Never paste the client secret into a ChatGPT conversation, repository, issue,
screenshot, or log. Treat it as a password.

## Understand the connection states

The simplified dashboard separates durable OAuth from a live MCP transport:

| Dashboard state | Meaning |
| --- | --- |
| **Not connected** | No ChatGPT OAuth client has been prepared yet. |
| **Authorize** / authorization pending | The client exists, but OAuth has not finished. Continue the existing flow. |
| **OAuth ready** | Authorization is stored and can survive a server restart. |
| **Connected** / **N active** | At least one MCP transport is active right now. |

`OAuth ready` without `Connected` is normal. ChatGPT does not need to keep a
transport open continuously; it can create one when it invokes PiLink tools.

## Run the first task

Begin with a read-only request such as:

```text
Use PiLink to inspect the configured project. Report the project root, Git
status, package scripts, and the tests you would run. Do not modify files.
```

Confirm the reported project before authorizing writes or repository execution.
A connected plugin does not mean every ChatGPT message will invoke PiLink.

## What the VS Code launcher monitors

The main dashboard always shows the bridge lifecycle: local server state,
endpoint state, and ChatGPT authorization/connection state.

When the current administrative projection supplies MCP audit metadata, it can
also show a small bounded recent-activity list with fields such as tool name,
outcome, duration, and time. In server modes where that projection is not
available, the activity section remains absent.

The dashboard does not display prompts, file paths, tool arguments, tool
results, or the ChatGPT transcript.

PiLink's collaboration services remain available to operators through the CLI
and compatibility paths when explicitly enabled. They are not a second chat or
task product inside the normal VS Code launcher.

## Returning after a restart

With a stable HTTPS origin, the saved PiLink configuration and OAuth identity
can normally be reused. Start PiLink, open ChatGPT Work, and continue using the
existing plugin connection.

Do not repeat OAuth client registration merely because the dashboard currently
shows no active transport.

Quick Tunnel is different: recreating it gives PiLink a different public
origin, so a client configured with the previous URL must be updated or replaced
with a connection to the new origin.

## Other PiLink clients and compatibility paths

The same core MCP server can be used by other supported clients. The extension
backend also retains native VS Code MCP and local provider-backed agent support
for compatibility/operator workflows, but those are intentionally not promoted
as parallel products in the normal launcher.

For the extension workflow see [PiLink VS Code extension](VSCODE_EXTENSION.md).
For trust and execution boundaries see [Security model](SECURITY_MODEL.md). For
the complete server model see [Architecture](ARCHITECTURE.md).
