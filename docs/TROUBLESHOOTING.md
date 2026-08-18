# Troubleshooting

Diagnose PiLink one layer at a time. A green tunnel does not prove OAuth is
valid, and an OAuth client does not prove an MCP transport is active.

## Connection layers

| Layer | Healthy evidence | Common failure |
| --- | --- | --- |
| Workspace | Correct canonical root, trusted window | Wrong parent folder, Restricted Mode |
| Sidecar | Local health and authenticated admin status | Node mismatch, port conflict, duplicate owner |
| Hosting | Public HTTPS origin reaches the sidecar | Tunnel stopped, DNS/proxy mismatch, stale Quick Tunnel URL |
| OAuth | Metadata is discoverable and one client is authorized | Wrong callback, expired consent, stale origin |
| Plugin | PiLink is installed and enabled in ChatGPT Work | Looking in the wrong client/catalog surface |
| MCP | Authenticated session and tool list | Stale token/session, scope mismatch |
| Collaboration | Explicit agent messages/tasks appear | Collaboration disabled or no collaboration tool calls yet |

## The VS Code launcher looks much simpler than older screenshots

That is intentional. The current PiLink VS Code extension is a bridge launcher
and status panel, not a second chat/agent product.

The ordinary first-run UI contains **Quick start for ChatGPT**, **Local only**,
and a secondary **Advanced setup...** compatibility entry. Local provider chat,
native VS Code MCP controls, manual OAuth registration, collaboration
management, and Full-access launch are no longer promoted as parallel dashboard
features.

Older screenshots or documentation may show those controls. Use the current
button names and [VS Code extension guide](VSCODE_EXTENSION.md).

## Plugins or MCP are missing in normal Chat

Use the Work/plugin surface that is available to your account/workspace for the
PiLink plugin. Changing PiLink provider credentials or its local access mode
cannot make a missing remote plugin entitlement appear.

Do not weaken OAuth registration, accept arbitrary callbacks, or expose the
bootstrap secret because a remote UI control is absent.

## PiLink is not in the plugin catalog

PiLink may be a private/personal or workspace plugin rather than a public
catalog entry. Do not search for "MCP server" and install an unrelated vendor.

Check the plugin sources and creation/import controls available to your account
or workspace. If the deployment's PiLink entry is absent, ask the plugin
publisher or workspace administrator to make it available.

## Developer Mode or an old custom-connector control is missing

Older ChatGPT interfaces exposed different connector/developer controls. PiLink
keeps compatibility code for builders that still require a manual client, but
the normal VS Code path is **Connect ChatGPT** from the PiLink dashboard.

Do not weaken OAuth registration, accept arbitrary callbacks, or expose the
bootstrap secret because an old UI control is absent.

## I cannot find the callback or manual OAuth fallback

With Dynamic Client Registration, there is no callback for the user to copy.
The client registers its redirect URI directly with PiLink.

The current launcher intentionally does not promote manual OAuth registration.
Use the compatibility path only when the active plugin builder explicitly
displays a Callback/Redirect URL and supports a user-defined client. In that
case:

1. copy the complete HTTPS callback exactly;
2. use PiLink's manual OAuth-client registration compatibility command/path;
3. copy the resulting Client ID, one-time secret, Authorization URL, and Token
   URL into the matching fields;
4. request only the scopes needed by the client.

If those fields are not present, that surface does not support the fallback.
Never paste the client secret into a conversation, repository, issue, screenshot,
or log.

## The endpoint link opens a blank/error page

An MCP URL ending in `/sse` is a protocol endpoint, not a landing page. A
normal browser does not send the bearer token or MCP handshake, so a 401,
method error, stream, or blank-looking page can be correct.

Validate instead:

- local PiLink status in the VS Code launcher;
- the public health endpoint;
- OAuth protected-resource/authorization-server metadata;
- a real plugin OAuth/MCP connection.

Temporary `trycloudflare.com` or `nip.io` addresses shown by old setup/test
flows may already be dead. Use the endpoint currently shown by the active
configuration. Quick start is intentionally temporary; use **Advanced setup...**
for a durable Named Tunnel/fixed domain or existing HTTPS origin.

## VS Code warns before opening several external links

Read the entire target before approving it. Normal PiLink setup should open
only the configured PiLink origin and the intended remote client/documentation
pages. Do not approve an unfamiliar `nip.io`, Quick Tunnel, callback, or
test-fixture hostname merely because it appeared during development.

If the target does not match the active configured origin or the destination
you deliberately initiated, cancel it and inspect the PiLink configuration
before continuing. External-link approval is not required to keep the local
runtime alive.

## Approve works once, then reports missing, expired, or already used

OAuth consent requests and authorization codes are single-use and short-lived.
The second click correctly fails after the first request was consumed.

1. Do not click **Approve** again.
2. Return to the remote plugin tab that initiated OAuth.
3. Wait for its redirect or completion state.
4. If the client reports setup failure, start a fresh Connect/Authenticate
   action so PiLink creates a new consent request.
5. Capture the first redirect/error and PiLink server log before retrying.

Repeatedly refreshing `/oauth/authorize` without its original query parameters
cannot recreate the request.

## OAuth returns to the client but setup still fails

Check, in order:

1. the public origin in `SERVER_URL` exactly matches the origin used by the
   plugin;
2. the redirect URI is the one registered by DCR or copied in the manual flow;
3. the authorization code was exchanged once and before expiry;
4. the token request includes the expected resource/audience and PKCE verifier;
5. the tunnel did not restart or change hostname during authorization;
6. the client is enabled and its generation/secret was not rotated;
7. the requested scopes are supported.

Do not paste tokens or secrets into a bug report. Redact query parameters from
screenshots when they contain a code, state, or pairing value.

## The dashboard says OAuth ready but not Connected

This is normal. **OAuth ready** means the durable authorization exists.
**Connected** means an MCP transport is open right now. The remote client may
create a transport only when it actually invokes a PiLink tool.

Do not register another OAuth client just to turn the status from OAuth ready
to Connected.

## ChatGPT is working but Recent activity is empty

The launcher is deliberately not a transcript viewer. The activity section is
shown only when the current administrative projection supplies bounded MCP audit
metadata.

In Single-agent mode the collaboration-specific admin projection is disabled,
so the activity section may legitimately be absent even while ordinary MCP
operations work. Use the server/endpoint/ChatGPT state as the primary health
signals and verify a simple read-only MCP call from the client.

## Collaboration tools are missing

Check the effective server mode before changing scopes or Full access. Read
`runtime_mode` from PiLink health/admin status:

- `single` intentionally registers the original workspace harness without
  `agent_chat_*`, `agent_task_*`, `agent_memory_*`, `agent_work_*`, or remote
  supervised-agent controls;
- `collaboration` registers those services subject to OAuth scope, verified
  collaboration identity, private data placement, and any provider/model
  requirements.

The normal VS Code launcher no longer offers an **Enable collaboration** button.
Use the CLI explicitly:

```bash
pilink start --mode collaboration
```

or deliberately enter the retained **Advanced setup...** compatibility flow and
review its workflow choice. A mode change takes effect after restart and
existing MCP sessions must reconnect to obtain the new tool catalog. Do not
enable Full access to repair a mode mismatch. See
[Runtime mode selection](operations/mode-selection.md).

## I expected the old Agent & Task Monitor

The main VS Code product no longer exposes the collaboration monitor as a peer
surface. The older monitor/backend compatibility code may still exist, but the
launcher is intentionally focused on the MCP bridge.

For collaboration-specific operator work use the CLI/Textual path (`pilink
chat`) or the other explicit compatibility tooling for the deployment. An empty
or absent collaboration monitor does not imply the basic MCP bridge is broken.

## Administrative endpoint returns HTTP 500

Check private data placement. `PI_DATA_DIR` and any coordination data directory
must be outside `PI_WORK_DIR`. For example, configuring both the workspace and
private data under the same broad home-directory workspace can make private
state reachable by workspace tools, so the service fails closed.

Use a specific project as the safe workspace or place private state outside the
authorized tree. Restart after correcting the configuration. Do not move
private state into the repository.

## PiLink uses the wrong folder

1. In VS Code select **File -> Open Folder...** and open the intended project.
2. In a multi-root window, use the Explorer context action **Use This Folder for
   PiLink** on the exact project, or run **PiLink: Use This Folder for PiLink**
   from the Command Palette when available.
3. Review the project shown in the PiLink header before authorizing remote use.
4. Restart/reconfigure PiLink if the saved workspace changed.

Using a broad parent directory as a workspace intentionally authorizes every
descendant in Project-folder mode. It can also conflict with the required
separation of PiLink's private state. Use Full access only when machine-level
authority is actually intended and a specific OAuth client has been reviewed.

## Full machine access is configured

The launcher does not provide a normal graphical Full-access start path.

If a saved configuration already contains Full access, the main card switches
to an explicit **Full machine access is saved/running** safety state instead of
showing the ordinary Start PiLink action.

- Prefer **Reconfigure safely...** to return to Project-folder access.
- If Full access is currently running, **Stop PiLink** is the primary action.
- Deliberate unrestricted operation should use the PiLink CLI and its explicit
  Full-access controls, or the retained Advanced setup compatibility flow after
  reviewing its warning.

Quick start and Local only never request Full access.

## Node version mismatch

PiLink requires Node.js **24.18.0 exactly**.

1. Open **File -> Preferences -> Settings**.
2. Search for **PiLink: Node Executable**.
3. Enter the absolute path to the Node 24.18.0 binary.
4. Run **Developer: Reload Window**.

The VS Code extension-host Node version is independent from the sidecar version
unless it happens to match exactly.

## The `run` tool reports an error

`run` is not an arbitrary shell. Its `profile` field must be exactly one of:

| Profile | Purpose | Accepted optional fields |
| --- | --- | --- |
| `git_status` | Branch and complete porcelain status | `paths`, `timeout` |
| `git_diff` | Unstaged Git diff | `paths`, `timeout` |
| `git_diff_staged` | Staged Git diff | `paths`, `timeout` |
| `git_log` | Bounded one-line Git history | `paths`, `maxCount` from 1 through 100, `timeout` |
| `npm_build` | Repository `npm run build --if-present` | `timeout` only |
| `npm_test` | Repository `npm test` | `timeout` only |

Common failures have deliberate fixes:

- **requires the `mcp:write` or `mcp:tools` scope** — the current OAuth client
  is read-only. Reconnect PiLink with write access; changing the arguments
  cannot expand an existing token.
- **executes code from the workspace and is disabled by default** — for a
  repository you trust, set `PI_ALLOW_WORKSPACE_EXECUTION=true` in PiLink's
  private configuration and restart. Alternatively, explicitly authorize Full
  access after reviewing its risk.
- **paths cannot be used with `npm_build`/`npm_test`** — remove `paths`; npm
  profiles always run the configured workspace's package script.
- **approval unavailable or declined** — when
  `PI_REQUIRE_EXECUTION_APPROVAL=true`, the active MCP client must support the
  fresh approval form and the user must approve that individual npm run.
- **exit code is nonzero** — the profile ran successfully as a mechanism, but
  Git/npm reported a real repository failure. Read the bounded `stderr` and
  `stdout`; do not retry blindly.
- **timed out**, **cancelled**, or **truncated** — narrow the request or raise
  only the configured timeout within the server limit. Truncation preserves
  the tail of output rather than silently claiming success.

Example valid inputs:

```json
{ "profile": "git_status" }
```

```json
{ "profile": "git_log", "maxCount": 10, "paths": ["src"] }
```

```json
{ "profile": "npm_test", "timeout": 120 }
```

## Runtime is stopped or a port is occupied

Only one owner may run a given configuration.

- Stop any `pilink start`, `pilink serve`, old extension window, or systemd
  service using the same port/configuration.
- Use the PiLink restart action after the previous owner has exited.
- Do not delete lock/owner state until process liveness has been checked.
- If another application owns the port, select a different configured port.

## Named Tunnel is offline

Treat server and tunnel as separate services:

1. verify the loopback sidecar health;
2. verify the `cloudflared` process or managed unit;
3. verify the tunnel credential reference exists and remains private;
4. verify DNS targets the expected named tunnel;
5. verify the public hostname reaches the same origin configured in
   `SERVER_URL`.

Restarting only the sidecar will not repair a stopped tunnel, and restarting
only the tunnel will not repair an invalid local server.

## Automatic `cloudflared` or Caddy installation fails

PiLink intentionally refuses an unverifiable hosting binary. Read the exact
error before changing configuration:

- **overrides require both the download URL and its SHA-256 digest** — define
  both `PI_CLOUDFLARED_URL` and `PI_CLOUDFLARED_SHA256`, or both
  `PI_CADDY_URL` and `PI_CADDY_SHA256`. Remove both variables to return to the
  pinned official source.
- **must be exactly 64 hexadecimal characters** — replace the malformed digest
  with the independently verified SHA-256 of that exact mirror artifact.
- **binary downloads must use HTTPS** — remote plain HTTP is not supported.
  Move the artifact to HTTPS; the HTTP exception is limited to loopback tests.
- **download redirect attempted to leave the verified HTTPS boundary** — fix
  the mirror so every redirect stays on HTTPS.
- **failed SHA-256 verification** — stop. The bytes do not match the configured
  digest. Investigate the mirror or supply-chain change instead of bypassing
  verification.
- **unsupported platform/architecture** — install the vendor binary manually
  and configure `PI_CLOUDFLARED_PATH` or `PI_CADDY_PATH`.
- **configured path is not executable** — correct the path and file permission,
  then verify the binary with `--version` before restarting PiLink.

The URL and SHA-256 variables are not credentials and should remain visible in
configuration diagnostics. Redact actual Cloudflare tokens, certificates, API
tokens, tunnel credential files, and private OAuth material. An internal mirror
hostname may still be sensitive organizational topology.

## Remote SSH path or browser confusion

In Remote SSH, the workspace, sidecar, Node runtime, configuration, and tunnel
are remote. The VS Code UI and browser are local. Install Node and configure
paths on the remote host, but complete the remote OAuth/login steps in the local
browser surface.

## A provider-backed local agent asks for a provider, OAuth, or API key

That is a specialist/operator path, not part of normal VS Code launcher setup.
Provider credentials are independent from ChatGPT's MCP OAuth connection.

If your goal is simply to use ChatGPT Work through PiLink, do not configure a
local model provider at all.

## Collecting a safe diagnostic report

Include:

- PiLink version and platform;
- local vs Remote SSH;
- Node version and selected executable source;
- hosting mode and redacted hostname;
- the failing layer and HTTP status/error code;
- whether DCR or manual OAuth was used;
- timestamps and metadata-only logs;
- Git status/diff when reporting a source build.

Exclude secrets, tokens, authorization codes, callback query parameters,
Cloudflare credentials, private paths not needed to reproduce the problem,
prompts, file contents, and complete tool results.
