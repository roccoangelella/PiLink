# Connect ChatGPT Work

PiLink exposes an OAuth-protected MCP endpoint that a compatible ChatGPT plugin
can use to reach the selected project.

```text
ChatGPT Work -> installed/private PiLink plugin -> OAuth -> PiLink MCP endpoint
                                                   |
                                                   v
                                            selected project
```

The PiLink VS Code extension is optional. When installed, it replaces ordinary
CLI startup with a small launcher/status surface. It does not embed ChatGPT or
read its page, cookies, transcript, composer, or reasoning.

## Recommended path with the VS Code launcher

1. Open the project folder in VS Code and trust it.
2. Open **PiLink** from the Activity Bar.
3. Select **Set up stable endpoint**.
4. Choose either:
   - **Cloudflare fixed domain** — PiLink provisions a stable tunnel/DNS entry
     from a scoped Cloudflare API token; or
   - **Existing HTTPS domain** — use a reverse proxy/HTTPS origin you already
     operate.
5. Wait until the dashboard reports that PiLink is online.
6. Select **Connect ChatGPT**.
7. In ChatGPT Work, install or connect the private PiLink plugin supplied by
   your personal/workspace plugin source.
8. Complete the PiLink owner-verification and OAuth flow.
9. Start with a bounded read-only task and verify that PiLink reports the
   project you expected.

Every graphical setup forces **Single agent** and **Project-folder** access. The
VS Code connection flow does not offer collaboration, Full access, provider
setup, native VS Code MCP, or manual OAuth registration as product choices.

## Temporary quick start

Use **Temporary quick start** when you want to evaluate the connection without
setting up a durable domain. It creates a Cloudflare Quick Tunnel using the same
Single-agent / Project-folder policy.

A Quick Tunnel is temporary. Its public hostname changes when it is recreated,
so an OAuth/plugin connection tied to the previous origin may need to be updated.

## Local-only use

**Local only** starts the same safe PiLink bridge without a public endpoint. A
remote ChatGPT Work client cannot reach a loopback-only server; use **Configure
remote endpoint** from the main card when you later need a public origin.

## Reconfigure the endpoint

Use **Details & recovery -> Reconfigure endpoint...** or **PiLink: Reconfigure
PiLink**. The graphical reconfiguration flow supports:

- Cloudflare fixed domain;
- existing HTTPS domain;
- Quick Tunnel;
- local only.

Reconfiguration always reapplies Single agent and Project-folder access. It is
also the safe migration path for an old Full-access configuration.

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

1. verifies the local PiLink server identity;
2. asks it for a short-lived, one-use pairing page;
3. shows a separate local verification code in a modal VS Code confirmation;
4. copies that code only after the local user explicitly chooses to continue;
5. opens the PiLink pairing page and then the ChatGPT destination.

The pairing URL alone cannot complete local owner verification. Approve only a
connection you just initiated yourself.

The extension also requires persistent VS Code integrated-browser storage for
this flow. If browser storage is ephemeral, it refuses the connection and
points to the relevant setting instead of attempting a non-durable pairing.

### Dynamic Client Registration

When the active ChatGPT plugin flow supports Dynamic Client Registration (DCR),
prefer it. PiLink exposes OAuth discovery/registration metadata and validates
the pending client, redirect URI, scope, OAuth state, and S256 PKCE challenge
before authorization completes.

The intended flow does not require manually creating another OAuth client just
because no MCP transport is currently open.

### Manual compatibility fallback

Keep the manual path only for a builder that explicitly requires user-defined
OAuth client values and cannot use the automatic registration flow. This is a
core PiLink operator/compatibility path, not a normal VS Code dashboard action.

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
outcome, duration, and time. In Single-agent mode the collaboration-specific
audit projection may be unavailable, so the activity section can legitimately
be absent.

The dashboard does not display prompts, file paths, tool arguments, tool
results, or the ChatGPT transcript.

## Existing advanced PiLink configurations

The VS Code launcher is intentionally conservative with configurations created
through more powerful core/operator paths:

- **Collaboration** is displayed as an advanced existing state; the launcher can
  switch it back to Single agent but does not enable it.
- **Full access** blocks graphical start/restart/connect; **Reconfigure safely...**
  resets the configuration to the fixed graphical policy.
- the legacy managed Named-Tunnel service is not owned by the simplified
  launcher; reconfigure the endpoint or manage that service from the CLI.

## Returning after a restart

With a stable HTTPS origin, the saved PiLink configuration and OAuth identity
can normally be reused. Start PiLink, open ChatGPT Work, and continue using the
existing plugin connection.

Do not repeat OAuth client registration merely because the dashboard currently
shows no active transport.

Quick Tunnel is different: recreating it gives PiLink a different public
origin, so a client configured with the previous URL must be updated or replaced
with a connection to the new origin.

## Other PiLink clients and operator paths

The same core MCP server can be used by other supported clients. Collaboration,
provider-backed agents, native/client-specific integrations, manual OAuth
management, Full access, and legacy service hosting remain core PiLink
operator capabilities where appropriate. They are not parallel products in the
current VS Code launcher.

For the extension workflow see [PiLink VS Code extension](VSCODE_EXTENSION.md).
For trust and execution boundaries see [Security model](SECURITY_MODEL.md). For
the complete server model see [Architecture](ARCHITECTURE.md).
