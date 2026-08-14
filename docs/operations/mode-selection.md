# Runtime mode selection

PiLink has three operator-facing entry experiences. Two are core server
modes; the third is a graphical handoff that contains both core modes:

| Entry | Core value | Select it when | What it exposes |
| --- | --- | --- | --- |
| **Single agent** | `PI_RUNTIME_MODE=single` | You want the original PiLink-style remote harness or one local Pi conversation | Workspace tools and the existing OAuth/MCP transport; no collaboration feed, task board, memory, or work loop. The loopback-only VS Code Pi Local controller may run one provider-backed agent without coordination tools |
| **Collaborative public chat** | `PI_RUNTIME_MODE=collaboration` | One or more authorized agents must coordinate through durable public chat and tasks | Everything in Single agent, plus verified roles, chat, tasks, memory, work-loop, and supervised Pi agents when a provider/model is configured; bounded audit/progress metadata remains available in either mode |
| **VS Code graphical** | `pilink start --mode vscode` (handoff) | You want guided setup, a dashboard, ChatGPT launch, Pi Local chat, and one place to switch the two server modes | The VS Code extension contains both Single agent and Collaborative public chat; it does not create a third server capability mode |

The **ChatGPT MCP** versus **Pi Local** selector is a separate execution-surface
choice inside the graphical entry. ChatGPT MCP uses OAuth and the remote MCP
endpoint. Pi Local uses the configured Pi provider credentials. Selecting Pi
Local does not authenticate ChatGPT, and selecting ChatGPT MCP does not select
or pay for a Pi provider.

## Choose from the CLI

Use an explicit mode on every new or automated launch. The command-line mode is
the operator's decision and cannot be selected by a ChatGPT prompt, a public
chat message, or an MCP tool call:

```bash
# Classic one-agent server, with public hosting when required.
pilink start --mode single

# Durable public-chat/task orchestration and optional supervised Pi agents.
pilink start --mode collaboration

# Open or hand off to the VS Code graphical setup/dashboard.
pilink start --mode vscode
```

In an interactive terminal, `pilink start` without `--mode` shows the same
three choices and lets Enter retain the current core mode. In a headless shell,
CI job, or redirected input, it never waits for a prompt; it uses the configured
`PI_RUNTIME_MODE` (or the compatibility default) and continues. Prefer an
explicit flag in service units and scripts so a copied environment cannot
silently change the capability catalog.

For a local or reverse-proxy deployment, use the same mode with `serve`:

```bash
pilink serve --mode single
pilink serve --mode collaboration
```

`vscode` is a handoff mode. It should not be written as
`PI_RUNTIME_MODE=vscode`; the core server accepts only `single` and
`collaboration`. The graphical entry writes the selected core mode to its
private configuration and starts/restarts the sidecar through the extension
host. Switching a core mode takes effect on restart so every MCP connection
sees one coherent tool catalog.

If a legacy configuration has no `PI_RUNTIME_MODE`, run the guided selector and
save the resulting choice before relying on it in automation. Current 2.2.x
compatibility behavior treats an omitted value as `collaboration`, preserving
the feature-branch experience when the core server is launched headlessly. The
VS Code dashboard intentionally displays an unconfigured legacy workspace as
Single agent until the user explicitly chooses a workflow, so opening the GUI
does not silently enable collaboration. An explicit value is still recommended
because it makes the capability boundary reviewable and stable.

## Capability and security boundaries

The runtime mode controls which services are constructed. It does not grant a
client access by itself:

| Control | Single agent | Collaborative public chat | Independent of both |
| --- | --- | --- | --- |
| Workspace `read`/`grep`/`find`/`ls`/`edit`/`write` | Yes, subject to OAuth scope | Yes, subject to OAuth scope | — |
| Fixed `run` profiles | Yes, subject to execution policy | Yes, subject to execution policy | `PI_ALLOW_WORKSPACE_EXECUTION`, approval policy |
| General `bash` and outside-workspace files | Only in explicit Full access | Only in explicit Full access | `PI_UNSAFE_FULL_ACCESS`, `PI_FULL_ACCESS_CLIENT_IDS` |
| Public chat and tasks | Not registered | Registered | OAuth scope and verified identity |
| Memory and work loop | Not registered | Registered | Private data placement and collaboration verification |
| Provider-backed agents | One loopback-controlled Pi Local agent; no remote MCP agent-management tools | Registered for remote orchestration and local administration with an explicit provider/model | Provider credentials, concurrency and permission policy |
| Hosting, OAuth, CORS, session quotas | Yes | Yes | Operator configuration |

Single mode must not be described as “less secure” merely because it omits
collaboration. It has fewer remote capabilities. Collaboration is an additive
capability choice, not an implicit Full-access choice. In either mode, the
recommended baseline is a trusted project folder, workspace-only access,
write-scoped clients only when needed, and no repository execution until the
repository is trusted.

The VS Code dashboard is a loopback administration surface and a read-only
projection of collaboration state. It does not copy the private ChatGPT
transcript into its webview. Opening ChatGPT in the Integrated Browser does not
change the OAuth or workspace boundary.

## Headless and SSH operation

Headless operation is a first-class path. Use `serve` behind an existing
reverse proxy or tunnel, and keep the process in a service manager, tmux, or
an SSH session:

```bash
PI_RUNTIME_MODE=single pilink serve
PI_RUNTIME_MODE=collaboration PI_CHAT_CLI=off pilink serve
```

The optional `pilink chat` command is the Textual collaboration monitor. It is
not a second remote prompt box and does not turn Single agent into
Collaboration. Do not launch it for a Single agent deployment; use health and
admin status instead. In CI or another non-interactive shell set
`PI_CHAT_CLI=off` so a monitor cannot take over process input. When using the
automatic monitor, keep it attached to the same private data directory as the
server and never put that directory inside the workspace.

For SSH/Remote SSH, run the sidecar and any tunnel on the host that owns the
workspace. The VS Code client may be local, but the selected mode, OAuth state,
provider credentials, private collaboration data, and public endpoint belong
to the remote host. Do not run a CLI owner and an extension owner against the
same configuration at the same time.

## Migration from the pre-mode release

Mode selection changes the tool catalog, so treat it as an operator change,
not as a prompt preference:

1. Stop the existing `pilink start`, `pilink serve`, tunnel, or extension-owned
   sidecar.
2. Back up the private `.env`, OAuth client store, refresh/revocation state,
   and (if used) collaboration data. Preserve private file permissions.
3. Choose `single` to retain the classic one-agent boundary, or choose
   `collaboration` to enable the public-chat/task orchestration features.
4. Persist the choice as `PI_RUNTIME_MODE` (or let the graphical wizard write
   it), then restart. Never switch a live process by editing `.env` underneath
   it.
5. Re-check each OAuth client's scope and reconnect clients whose expected
   tools changed. A token cannot elevate a Single agent connection into
   Collaboration, and changing mode is not a reason to grant `mcp:tools`.
6. If running both experiences for a migration, use separate configuration
   directories, data directories, ports, OAuth clients, and public origins.
   Never share a live private data directory between two processes.

Existing collaboration messages/tasks are retained when the same private data
directory is reused, but they are not exposed while the server is in Single
agent mode. Switching back to Collaboration makes them available again subject
to the existing OAuth identity, role, lifecycle, and retention rules.

## Troubleshooting mode confusion

- `runtime_mode` in `/health` and `/admin/status` is the server's effective
  core mode; it is not the hosting mode and not the ChatGPT/Pi Local selector.
- If collaboration tools are missing, check the effective mode, restart after
  changing configuration, and reconnect the client. Do not enable Full access
  to repair a mode mismatch.
- A `409 collaboration_disabled` response from local collaboration status is
  expected in Single agent mode.
- An empty monitor is not proof that ChatGPT's private transcript was lost.
  The monitor only shows messages/tasks deliberately published to the durable
  collaboration store.
- If a mode change would require a different workspace or public origin, use a
  separate setup rather than overwriting generated state without a backup.
