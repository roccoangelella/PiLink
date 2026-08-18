# VSPiLink: how the VS Code extension works

VSPiLink is PiLink's optional VS Code control surface. It is useful for setup,
starting and stopping PiLink, choosing the server workflow, connecting remote
MCP clients, configuring Pi Local, and monitoring activity.

The most important thing to understand is what VSPiLink **is not**:

- it is not ChatGPT;
- it is not a second ChatGPT conversation window;
- it is not the PiLink server itself;
- the **ChatGPT MCP / Pi Local** buttons do not select the server's security or
  capability mode;
- the collaboration feed does not mirror your ChatGPT transcript.

If the interface feels like several unrelated controls were put on one screen,
that is because VSPiLink is controlling several independent layers. The rest
of this guide separates those layers.

## The 60-second mental model

For ChatGPT Work, the normal path is:

```text
You
  |
  v
ChatGPT Work
  |
  v
private PiLink plugin
  |
  | HTTPS + OAuth + MCP
  v
PiLink server on your machine
  |
  v
selected workspace
```

VSPiLink sits beside that path as the local control panel:

```text
VS Code / VSPiLink
  |
  | loopback-only protected admin channel
  v
PiLink server
```

For Pi Local, the model is different:

```text
VSPiLink local chat
  |
  v
supervised Pi agent
  |
  +--> configured model provider
  |
  v
selected workspace
```

So when you use **ChatGPT MCP**, you normally write your instructions in
ChatGPT Work. When you use **Pi Local**, you can use the local chat controls in
VSPiLink.

## The four decisions the UI mixes together

There are four independent choices. Changing one does not automatically change
the others.

### 1. Server workflow: Single-agent vs Public chat & orchestration

This is the PiLink server capability catalog for the workspace.

**Single-agent** is the simpler default. It exposes the workspace harness but
does not expose public collaboration chat, tasks, memory, work-loop, or remote
agent-management tools. A locally configured Pi provider may still supervise
one local agent through the protected VS Code administration path.

**Public chat & orchestration** adds the collaboration services used by
multiple or coordinated authenticated MCP agents: shared agent chat, tasks,
work coordination, memory projections, and supervised-agent controls.

Changing this choice changes server policy and therefore requires a server
restart. It is not just a visual tab switch.

A useful rule:

- choose **Single-agent** when you mainly want one remote or local coding agent
  to work in the selected folder;
- choose **Public chat & orchestration** when you specifically want shared
  tasks, coordination messages, multiple observed agents, or remote
  supervision features.

### 2. Execution surface: ChatGPT MCP vs Pi Local

The two large buttons at the top choose what the dashboard is showing. They do
**not** change the server workflow above.

**ChatGPT MCP** means: "I want an external ChatGPT Work plugin to reach this
PiLink server over OAuth-protected MCP." This side of the UI is mostly setup,
connection status, and monitoring. Your actual prompt belongs in ChatGPT Work.

**Pi Local** means: "I want a supervised Pi agent that calls a model provider
configured on this machine." Provider credentials, provider/model selection,
and local chat are separate from ChatGPT OAuth and OpenAI Work usage.

You can switch between these surfaces without changing the underlying
Single-agent/Public-chat server policy.

### 3. Access boundary: Open folder vs Full access

This decides what an authorized agent can reach on the machine.

**Open folder** is the normal mode. File tools are confined to the canonical
selected workspace. There is no general-purpose shell. Some repository
build/test profiles can still execute repository-controlled code, but they
require their own explicit opt-in.

**Full access** deliberately removes the workspace boundary for an explicitly
authorized OAuth client and enables general command execution with the PiLink
OS user's permissions. It is remote code execution by design. It does not grant
root automatically, but it should be treated as machine-level access.

The access boundary is independent from both the server workflow and the
ChatGPT MCP/Pi Local surface selector.

### 4. Hosting and OAuth: how a remote client reaches PiLink

A remote ChatGPT Work plugin cannot connect to `127.0.0.1` on your machine. It
needs a reachable HTTPS origin plus OAuth authorization.

VSPiLink can work with several hosting arrangements, including:

- **Cloudflare Named Tunnel**: stable managed hostname; best fit for a durable
  remote connection;
- **Existing/direct HTTPS domain**: use infrastructure you already operate;
- **Quick Tunnel**: temporary public hostname; useful for evaluation, but the
  hostname changes when recreated;
- **Local only**: no public endpoint; appropriate for local clients and Pi
  Local, not a remote ChatGPT Work plugin;
- legacy `nip.io` support for the older direct setup path.

Hosting only makes the server reachable. OAuth decides which client is allowed
to use it and with which scopes.

## What the main screen is actually showing

### ChatGPT MCP / Pi Local header buttons

These are **view/surface selectors**. Think of them as "show me the remote MCP
controls" versus "show me the local Pi-agent controls."

They are not equivalent to Single-agent/Public chat & orchestration.

### PiLink workflow card

This is the important server-mode selector. It controls the capability catalog
served to MCP clients and the collaboration/runtime policy behind the
workspace.

If the server is already running, changing the workflow requires a restart so
all clients see one coherent tool catalog.

### Top status indicator

The status text is a compressed summary. On the ChatGPT MCP surface, the common
states mean:

| Status | What it means |
| --- | --- |
| **Restricted** | VS Code does not trust the workspace. VSPiLink will not start/configure privileged operations. |
| **Choose workflow** | Select Single-agent or Public chat & orchestration first. |
| **Setup required** | PiLink does not yet have a usable local configuration for this workspace. |
| **Server stopped** | Configuration exists, but the PiLink service is not currently healthy. |
| **Not connected** | The server is running, but no ChatGPT OAuth client has been set up yet. |
| **Client registered / Finish sign-in** | An OAuth client exists, but authorization in ChatGPT is not complete. Do not create another client just because there is no active MCP session yet. |
| **OAuth ready / ChatGPT ready** | Authorization is stored. ChatGPT can create a new MCP transport session when needed. |
| **MCP active** | One or more MCP connections are active right now. |

`MCP active` counts transport connections. It is not the same thing as the
number of agents shown in the collaboration monitor.

### Collaboration messages, tasks, activity, and observed agents

These panels are an operational monitor, not a transcript viewer.

VSPiLink intentionally does not read the ChatGPT page, DOM, cookies, composer,
private transcript, or hidden reasoning. A collaboration message appears only
when an agent deliberately publishes through PiLink's collaboration tools, for
example `agent_chat_post`. An observed agent identity can therefore remain
empty even while an MCP connection is healthy.

Likewise, the task area contains tasks created through PiLink's task tools. It
does not automatically convert every ChatGPT instruction into a visible task.

## First-time recipe: use ChatGPT Work on a project

This is the path to follow if your goal is simply: "I want ChatGPT Work to use
PiLink tools on this folder."

1. **Open the project folder in VS Code and trust it.**
   VSPiLink deliberately blocks setup, OAuth, service start, and file access in
   Restricted Mode.

2. **Open the VSPiLink view.**
   If the right sidebar is hidden, use **View -> Appearance -> Secondary Side
   Bar** and select **VSPiLink**. You can also open the dashboard in an editor
   panel.

3. **Choose the server workflow.**
   Start with **Single-agent** unless you know you need PiLink's shared chat,
   task, memory, or orchestration tools. You can move to **Public chat &
   orchestration** later; doing so restarts the server.

4. **Select ChatGPT MCP at the top.**
   This tells VSPiLink to show the remote-connection workflow. It does not
   itself start ChatGPT or change the server's capability mode.

5. **Select Start setup / Connect ChatGPT via MCP.**
   The extension chooses or confirms the workspace and prepares the PiLink
   configuration.

6. **Choose Open folder access for normal use.**
   Select Full access only when you deliberately want the authorized remote
   client to operate outside the workspace and run general commands.

7. **Choose hosting.**
   For a durable ChatGPT connection, prefer a stable HTTPS origin such as a
   Cloudflare Named Tunnel or an existing domain. Quick Tunnel is convenient
   for testing but its URL is transient.

8. **Let VSPiLink provision and start PiLink.**
   At this point there are two different health questions: is the local PiLink
   service running, and is its public HTTPS endpoint reachable? Both need to be
   healthy for remote use.

9. **Connect the private PiLink plugin in ChatGPT Work.**
   The public MCP URL ends in `/sse`. PiLink itself is not an unrelated public
   marketplace result named "MCP server"; use the PiLink plugin supplied by
   your personal/workspace plugin source or the creation/import controls
   available to the deployment owner.

10. **Complete OAuth.**
    Prefer automatic/Dynamic Client Registration when the active ChatGPT flow
    supports it. VSPiLink uses a local-owner verification step: it creates a
    short-lived pairing page and separately shows a local verification code.
    Possession of the public pairing URL alone is not enough to authorize the
    browser.

    The manual callback/client-ID/client-secret flow remains a compatibility
    fallback for a builder that explicitly requires user-defined OAuth client
    values. Do not create a manual client just because the status says
    `Client registered` or `Finish sign-in`.

11. **Wait for OAuth ready / ChatGPT ready.**
    This means the durable authorization exists. It does not require an MCP
    transport to remain open continuously.

12. **Do the actual work in ChatGPT Work.**
    Start a Work task and ask ChatGPT to inspect or modify the configured
    workspace. When ChatGPT invokes PiLink, VSPiLink should move to `MCP active`.

A good first request is deliberately read-only:

```text
Use PiLink to inspect the configured workspace. Report the workspace root,
Git status, package scripts, and the tests you would run. Do not modify files.
```

Verify that ChatGPT reports the expected folder before authorizing writes or
execution.

## Returning the next day

With a stable public origin, normal use should be much shorter:

1. open the project in VS Code;
2. open VSPiLink if you want to inspect status;
3. start/restart PiLink if the server is stopped;
4. open ChatGPT Work and use the already-installed PiLink plugin.

If the status says **OAuth ready / ChatGPT ready**, you should not repeat the
callback or client-registration process. ChatGPT will open a new MCP transport
when it needs tools.

Quick Tunnel is the exception: a recreated Quick Tunnel has a different public
origin, so the old ChatGPT connection points at the old URL. For persistent use,
move to a stable hostname.

## First-time recipe: use Pi Local instead of ChatGPT Work

Use this path when you want the model call to come from a provider configured
in PiLink rather than from ChatGPT Work.

1. Open and trust the workspace.
2. Choose the desired server workflow. **Single-agent** is the normal local
   default; choose **Public chat & orchestration** only when you need those
   coordination capabilities.
3. Select **Pi Local** at the top of VSPiLink.
4. Configure the agent provider, authentication method, and model.
5. Start the PiLink runtime locally. Public hosting and ChatGPT OAuth are not
   required merely to use Pi Local.
6. Use the local chat controls, or create/supervise an agent from VSPiLink.
7. Use agent output/follow-up/cancel/stop controls to manage the local runtime.

Pi Local provider credentials do not authorize ChatGPT MCP, and ChatGPT OAuth
does not sign you in to a Pi Local provider. They are intentionally separate.

## When to choose Public chat & orchestration

Choose the collaboration workflow when the thing you want is not merely
"ChatGPT can read/edit my folder" but rather "agents should coordinate through
PiLink."

That workflow adds the server-side collaboration layer used for:

- explicit agent-to-agent coordination messages;
- durable shared tasks and task ownership;
- work-loop coordination;
- governed memory projections;
- supervised Pi-agent management exposed to appropriately authorized remote
  clients.

The dashboard can then monitor those published coordination objects. It still
does not mirror arbitrary ChatGPT conversation content.

## Button and command glossary

The Command Palette exposes more actions than a normal first-time user needs.
The important ones are:

| UI/command | What it really does |
| --- | --- |
| **ChatGPT MCP** | Shows the remote ChatGPT/OAuth/MCP setup and monitor surface. |
| **Pi Local** | Shows the locally configured Pi-provider/agent surface. |
| **Choose VSPiLink Workflow** | Selects Single-agent or Public chat & orchestration; this changes server policy and may restart PiLink. |
| **Connect ChatGPT via MCP / Start setup** | Runs or resumes the guided remote setup. It can configure the workspace, access mode, hosting, server start, and connection onboarding. |
| **Open ChatGPT Work** | Opens the OpenAI-controlled Work UI. Opening it is navigation, not proof of an MCP connection. |
| **Start Safely (Workspace Access)** | Starts PiLink with the selected workspace boundary. |
| **Start with Full Access** | Starts the explicitly unsafe machine-level access mode for an authorized client. |
| **Start Locally Only** | Starts PiLink without a public remote endpoint. |
| **Stop / Restart** | Controls the PiLink service managed by the extension. |
| **Copy MCP URL** | Copies the protocol endpoint, normally `https://.../sse`. It is not a human web page. |
| **Register an OAuth Client** | Manual OAuth compatibility path. Normally unnecessary when automatic registration works. |
| **Connect to VS Code Agents** | Authorizes VS Code's native MCP provider against the local PiLink service. This is separate from ChatGPT Work. |
| **Open the Agent and Task Monitor** | Opens the operational collaboration monitor; it is not a ChatGPT transcript. |
| **Configure the Agent Provider and Model** | Configures the provider/model used by Pi Local supervised agents. |
| **Create an Agent** | Starts a supervised Pi agent when the local provider/runtime is ready. |
| **Open Private Configuration** | Opens the private PiLink configuration selected by the extension. Treat it as sensitive. |

Advanced reset, hosting, and manual OAuth commands exist for recovery and
compatibility. They should not be part of the normal daily workflow.

## Common confusing situations

### "ChatGPT is working, but the collaboration feed is empty"

That can be completely normal. The feed contains only messages deliberately
published through PiLink's collaboration APIs. It is not a copy of the ChatGPT
conversation.

### "It says OAuth ready, but MCP is not active"

`OAuth ready` means ChatGPT has durable authorization. `MCP active` means a
transport connection is open right now. ChatGPT may open one only when it
actually invokes PiLink tools.

### "It says Client registered / Finish sign-in"

The local OAuth client already exists. Continue the authorization flow in
ChatGPT. Do not register another client unless you are intentionally replacing
or repairing the existing one.

### "I clicked ChatGPT MCP but nothing changed in the server"

Correct: that button changes the dashboard surface. Use the **PiLink workflow**
selector to change Single-agent/Public chat & orchestration.

### "I selected Public chat & orchestration but ChatGPT still is not connected"

Also expected. The workflow controls which tools/services the server exposes;
it does not create public hosting, install a ChatGPT plugin, or grant OAuth.
Those are separate steps.

### "I opened the `/sse` URL in a browser and it looks broken"

`/sse` is an MCP transport endpoint, not a normal website. Validate it through
PiLink/VSPiLink health and OAuth discovery rather than by expecting a human UI
at that URL.

### "I restarted VS Code. Do I need to register OAuth again?"

Normally no. OAuth client information is persistent. With a stable public
origin, restart the server and reuse the existing authorization. A transient
Quick Tunnel URL is the main exception.

### "Why does changing workflow restart the server?"

The workflow determines the tool catalog and security/collaboration policy for
the process lifetime. Restarting prevents old and new MCP connections from
seeing inconsistent capabilities.

### "Why can't VSPiLink just show my ChatGPT conversation?"

Because it is intentionally not connected to the ChatGPT DOM, cookies,
composer, transcript, or reasoning. The extension communicates with the PiLink
server through its local protected administration interface and only displays
PiLink-owned operational data.

## Security boundaries worth remembering

- **Workspace Trust** is the first local gate. Restricted workspaces cannot
  start/configure privileged VSPiLink operations.
- **OAuth scopes** decide which MCP tools a client may request.
- **Open folder vs Full access** is a separate filesystem/process boundary.
- **Repository execution approval** is separate again; even inside a confined
  workspace, running a repository's build/test code can execute arbitrary code
  as the PiLink OS user.
- Public MCP clients never receive the loopback administration bootstrap
  secret used by VSPiLink.
- Secrets and persistent PiLink control state should remain outside the
  workspace exposed to agents.

## Where the pieces live

The extension is only the graphical layer. Relevant implementation areas are:

- `packages/vscode/src/extension.ts` — command wiring, server/process control,
  OAuth/admin integration, dashboard state;
- `packages/vscode/src/dashboard.ts` — VS Code webview lifecycle;
- `packages/vscode/media/main.js` — visible dashboard state machine and UI;
- `packages/vscode/src/wizard-controller.ts` — guided setup phases;
- `packages/vscode/src/oauth-client.ts` — local/native OAuth client handling;
- `packages/vscode/src/process-supervisor.ts` — extension-managed processes;
- PiLink's core server and protocol packages — the actual MCP/tool/security
  implementation.

For the deeper trust-boundary and server model, see [Architecture](ARCHITECTURE.md).
For the exact ChatGPT connection procedure and OAuth compatibility paths, see
[Connect ChatGPT Work](CONNECT_CHATGPT.md). For installation and Remote SSH
behavior, see [Installation](INSTALLATION.md).
