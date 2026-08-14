# Troubleshooting

Diagnose VSPiLink one layer at a time. A green tunnel does not prove OAuth is
valid, and an OAuth client does not prove an MCP transport is active.

## Connection layers

| Layer | Healthy evidence | Common failure |
| --- | --- | --- |
| Workspace | Correct canonical root, trusted window | Wrong parent folder, Restricted Mode |
| Sidecar | Local health and authenticated admin status | Node mismatch, port conflict, duplicate owner |
| Hosting | Stable public HTTPS origin reaches the sidecar | Tunnel stopped, DNS/proxy mismatch |
| OAuth | Metadata is discoverable and one client is authorized | Wrong callback, expired consent, stale origin |
| Plugin | VSPiLink is installed and enabled in ChatGPT Work | Looking in normal Chat or wrong catalog result |
| MCP | Authenticated session and tool list | Stale token/session, scope mismatch |
| Collaboration | Explicit agent messages/tasks appear | No `agent_chat_post` or `agent_task_*` calls yet |

## Plugins or MCP are missing in normal Chat

This is expected under the current official product model. On ChatGPT web:

1. Use the top surface selector to switch from **Chat** to **Work**.
2. Open **Plugins** in the left sidebar.
3. Install or enable VSPiLink.
4. Start a new Work task.

ChatGPT Pro may increase included Work/Codex usage, but it does not add remote
MCP tools to normal Chat. See [Usage, models, and costs](USAGE_AND_COSTS.md).

## VSPiLink is not in the plugin catalog

VSPiLink may be a private/personal or workspace plugin rather than a public
catalog entry. Do not search for "MCP server" and install an unrelated vendor.

Check:

1. **Work → Plugins → Installed** for an existing installation.
2. The **Personal** or **Created by me** area when your account exposes it.
3. Your workspace's plugin area when an administrator shared it.
4. Workspace plugin policy with the administrator.

If you cannot create, import, share, or install the private plugin, the missing
capability is account/workspace-side. Changing a VSPiLink provider or API key
will not make that control appear.

## Developer Mode or the old plus button is missing

Developer Mode/custom-connector setup is a compatibility path from older
ChatGPT interfaces, not the current primary VSPiLink workflow. Its location and
availability can vary. Use ChatGPT Work and the current Plugins workflow.

Do not weaken OAuth registration, accept arbitrary callbacks, or expose the
bootstrap secret because a legacy UI control is absent.

## I cannot find the callback or fallback URL

With Dynamic Client Registration, there is no callback for the user to copy.
The client registers its redirect URI directly with VSPiLink.

Only use the manual flow when the active plugin builder explicitly displays a
Callback/Redirect URL and supports a user-defined client. In that case:

1. copy the complete HTTPS callback exactly;
2. paste it into VSPiLink's manual OAuth fallback;
3. copy the resulting Client ID, one-time secret, Authorization URL, and Token
   URL into the matching fields;
4. use `client_secret_post` when requested.

If those fields are not present, that surface does not support the fallback.

## The endpoint link opens a blank/error page

An MCP URL ending in `/sse` is a protocol endpoint, not a landing page. A
normal browser does not send the bearer token or MCP handshake, so a 401,
method error, stream, or blank-looking page can be correct.

Validate instead:

- local sidecar health in the VSPiLink dashboard;
- the public `/health` aggregate response;
- OAuth protected-resource and authorization-server metadata;
- a real plugin OAuth/MCP connection.

Temporary `trycloudflare.com` or `nip.io` addresses shown by old setup/test
flows may already be dead. Use the endpoint currently shown by the active
configuration. For regular use, migrate to a Named Tunnel or existing stable
domain.

## VS Code warns before opening several external links

Read the entire target before approving it. Normal VSPiLink setup should open
only the documented ChatGPT pages, the configured VSPiLink origin, and official
documentation. Do not approve an unfamiliar `nip.io`, Quick Tunnel, callback,
or test-fixture hostname merely because it appeared during development.

If the target does not match the active configured origin or an official
`chatgpt.com`, `learn.chatgpt.com`, or `developers.openai.com` page, select
**Cancel/Close** and inspect the VSPiLink output channel. External-link approval
is not required to keep the local runtime alive.

## Approve works once, then reports missing, expired, or already used

OAuth consent requests and authorization codes are single-use and short-lived.
The second click correctly fails after the first request was consumed.

1. Do not click **Approve** again.
2. Return to the ChatGPT Work/plugin tab that initiated OAuth.
3. Wait for its redirect or completion state.
4. If ChatGPT reports setup failure, start a fresh **Connect/Authenticate**
   action so VSPiLink creates a new consent request.
5. Capture the first redirect/error and VSPiLink server log before retrying.

Repeatedly refreshing `/oauth/authorize` without its original query parameters
cannot recreate the request.

## OAuth returns to ChatGPT but setup still fails

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

## Connected, but the collaboration monitor is empty

The monitor does not mirror the ChatGPT transcript. It shows messages only
after an agent calls `agent_chat_post`, and tasks only after `agent_task_*` is
used. Tool activity is metadata-only.

Verify ordinary file/Git tools first. An empty chat/task board with successful
MCP calls is healthy.

## Collaboration tools are missing

Check the effective server mode before changing scopes or Full access. Read
`runtime_mode` from `/health` (or `/admin/status` from the local dashboard):

- `single` intentionally registers only the classic workspace harness;
  `agent_chat_*`, `agent_task_*`, `agent_memory_*`, `agent_work_*`, and
  supervised-agent controls are not part of that tool catalog;
- `collaboration` registers those services, subject to the client's OAuth
  scope, verified collaboration bootstrap, private data placement, and an
  explicitly configured provider/model for supervised agents.

Choose **Public chat & orchestration** in the VS Code workflow selector or
restart the CLI with `pilink start --mode collaboration`. A mode change takes
effect only after restart, and existing MCP sessions must reconnect to obtain
the new tool list. Do not enable Full access to repair a mode mismatch. See
[Runtime mode selection](operations/mode-selection.md).

## Administrative endpoint returns HTTP 500

Check private data placement. `PI_DATA_DIR` and any coordination data directory
must be outside `PI_WORK_DIR`. For example, configuring both the workspace and
private data under the same `/home/user` workspace can make collaboration state
readable by workspace tools, so the service fails closed.

Use a specific project as the safe workspace or place private state outside the
authorized tree. Restart after correcting the configuration. Do not move
private state into the repository.

## VSPiLink uses the wrong folder

1. In VS Code select **File → Open Folder…** and open the intended project.
2. In a multi-root window, open the Command Palette and run **VSPiLink: Use the
   Current Folder as the VSPiLink Workspace**, then select the exact folder.
3. Review the canonical path shown before authorizing OAuth.
4. Restart the managed runtime if the configuration changed.

Using `/home/user` as a workspace intentionally authorizes every descendant in
safe mode. It also prevents private state under that directory from satisfying
the required separation. Use Full access only when broad machine authority is
the actual intent and a specific OAuth client has been reviewed.

## Node version mismatch

VSPiLink requires Node.js **24.18.0 exactly**.

1. Open **File → Preferences → Settings**.
2. Search for **VSPiLink: Node Executable**.
3. Enter the absolute path to the Node 24.18.0 binary.
4. Run **Developer: Reload Window**.

The VS Code extension-host Node version is independent from the sidecar
version unless it happens to match exactly.

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
  is read-only. Reconnect VSPiLink with write access; changing the arguments
  cannot expand an existing token.
- **executes code from the workspace and is disabled by default** — for a
  repository you trust, set `PI_ALLOW_WORKSPACE_EXECUTION=true` in VSPiLink's
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
- Use the VSPiLink restart action after the previous owner has exited.
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

VSPiLink intentionally refuses an unverifiable hosting binary. Read the exact
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
  then verify the binary with `--version` before restarting VSPiLink.

The URL and SHA-256 variables are not credentials and should remain visible in
configuration diagnostics. Redact actual Cloudflare tokens, certificates, API
tokens, tunnel credential files, and private OAuth material. An internal mirror
hostname may still be sensitive organizational topology.

## Remote SSH path or browser confusion

In Remote SSH, the workspace, sidecar, Node runtime, configuration, and tunnel
are remote. The VS Code UI and Integrated Browser are local. Install Node and
configure paths on the remote host, but complete the ChatGPT login in the local
browser tab.

## Pi Local asks for a provider, OAuth, or API key

That is expected only in **Pi Local** mode. Switch back to **ChatGPT MCP** for
the plugin workflow. Pi Local credentials do not authenticate ChatGPT's MCP
client, and ChatGPT OAuth does not pay for a Pi Local provider.

## Collecting a safe diagnostic report

Include:

- VSPiLink version and platform;
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
