# PiLink VS Code extension

The PiLink VS Code extension is the graphical launcher for the PiLink MCP
bridge. Its product contract is deliberately small:

> choose a project, start PiLink with a safe fixed policy, configure the MCP
> endpoint, connect ChatGPT, and show whether the bridge is healthy.

It is not a second ChatGPT interface and it is not a general control panel for
every PiLink subsystem.

```text
You work here:

ChatGPT Work
    |
    v
PiLink plugin
    |
    | OAuth + MCP
    v
PiLink server --------> project folder
    ^
    |
VS Code starts and monitors this side
```

## Product rule

Older builds mixed execution surfaces, workflows, hosting, OAuth, access policy,
local model providers, tasks, agents, and monitoring on one screen. The current
extension follows one rule: **the normal graphical workflow is the single-agent
MCP bridge, with project-folder access.**

Every graphical setup/reconfiguration writes:

- `PI_RUNTIME_MODE=single`;
- Project-folder access / `PI_UNSAFE_FULL_ACCESS=false`;
- paired OAuth consent;
- the endpoint/hosting settings selected by the user.

There is no graphical workflow selector, Full-access launch, provider/model
setup, native VS Code MCP product, manual OAuth-client product, collaboration
console, transcript, task board, or activity feed.

## Main lifecycle

### 1. Choose the project

Open and trust the project folder PiLink may access. The extension blocks setup,
startup, OAuth, and project changes in VS Code Restricted Mode.

In a multi-root workspace, choose the exact project. Changing a configured
project requires a local confirmation and keeps OAuth/hosting state separate
from the workspace boundary.

### 2. Configure an endpoint

For a new project, the main card offers three choices.

**Set up stable endpoint** is the primary/recommended path for ChatGPT. It lets
you choose either:

- **Cloudflare fixed domain** — PiLink provisions the tunnel and DNS from a
  scoped API token, uses that token once, and stores only the generated tunnel
  token file; or
- **Existing HTTPS domain** — use a reverse proxy/HTTPS origin you already
  operate.

**Temporary quick start** creates a Cloudflare Quick Tunnel. It is convenient
for evaluation but the public URL changes when the tunnel is recreated.

**Local only** starts PiLink without a public endpoint for same-machine clients.

All three paths use the same Single-agent / Project-folder security policy.

### 3. Start PiLink again later

Once configured, the main action is **Start PiLink** whenever the extension-owned
bridge is stopped.

The launcher refuses to start a saved Full-access configuration. It also refuses
to take ownership of a process already running outside this VS Code session.

### 4. Connect ChatGPT

When a public HTTPS endpoint is healthy, select **Connect ChatGPT**. The
extension copies the MCP URL, creates a short-lived local-owner pairing request,
and opens the PiLink pairing page before handing off to ChatGPT Work.

If the OAuth client already exists but authorization is unfinished, the UI says
**Continue connection** rather than encouraging duplicate registration.

If OAuth is already durable, the UI says **OAuth ready** and opens ChatGPT Work
without repeating setup.

### 5. Work in ChatGPT

Do the actual coding task in ChatGPT Work. When ChatGPT invokes a PiLink tool,
an MCP session becomes active and the launcher reports **Connected** / the
active-session count.

The extension does not need to mirror the ChatGPT transcript or tool activity to
prove the bridge is working.

## Status model

The dashboard keeps three facts visible:

| Field | Meaning |
| --- | --- |
| **Server** | Is the local PiLink process running? |
| **Endpoint** | Is PiLink local-only or exposed through public HTTPS? |
| **ChatGPT** | Is ChatGPT unconfigured, awaiting OAuth, authorized, or actively connected? |

`OAuth ready` without an active transport is normal. A remote client can create
an MCP transport only when it actually needs PiLink tools.

The dashboard deliberately avoids a generic “everything is connected” status.
Server health, endpoint reachability, and OAuth/MCP state are separate facts and
are displayed separately.

## Reconfigure endpoint

**Details & recovery -> Reconfigure endpoint...** and the Command Palette action
**PiLink: Reconfigure PiLink** use a dedicated safe reconfiguration flow. The
available endpoint types are:

- Cloudflare fixed domain;
- existing HTTPS domain;
- Cloudflare Quick Tunnel;
- local only.

Reconfiguration always resets the graphical policy to Single agent and
Project-folder access. It does not expose the old collaboration or Full-access
selectors.

## Details & recovery

The collapsed section contains bridge operations only:

- restart/stop;
- reconfigure endpoint;
- copy MCP URL;
- open the private configuration;
- show the extension-owned PiLink terminal/output;
- open this guide.

It also shows the selected project, hosting type, current workflow, process
ownership, and MCP endpoint so an operator can verify actual state without
navigating several product modes.

## Existing advanced configurations

### Collaboration

PiLink core still supports `PI_RUNTIME_MODE=collaboration`, but the launcher does
not enable it. If an existing project is already configured for collaboration,
the dashboard labels it **Collaboration (advanced)** and offers **Switch to
single-agent**.

Use the PiLink CLI/operator workflow if collaboration is truly required. The
normal graphical product remains single-agent.

### Full access

Full access removes the project boundary and allows general process execution as
the PiLink OS user. It is remote code execution by design.

The current extension does not offer a Full-access start. If an existing
configuration has `PI_UNSAFE_FULL_ACCESS=true`, the main card enters a safety
state, blocks ordinary start/restart/connect actions, and offers **Reconfigure
safely...**. Reconfiguration clears Full access and restores the fixed graphical
policy.

Deliberate unrestricted operation belongs to the PiLink CLI/operator workflow.

### Legacy managed Named Tunnel

The simplified extension no longer owns the legacy `cloudflare-named` managed
service mode. If an existing configuration uses it, normal start is refused.
Reconfigure to Cloudflare fixed domain, an existing HTTPS domain, Quick Tunnel,
or local-only; otherwise manage the legacy service through the CLI/service
manager.

## Removed product surfaces

The extension controller and webview protocol were narrowed, not merely hidden.
The normal VS Code product no longer exposes:

- Pi Local/provider-backed chat;
- provider/model authentication controls;
- agent spawning/output controls;
- native VS Code MCP server-definition integration;
- manual OAuth-client registration controls;
- collaboration enablement/monitoring controls;
- Full-access launch controls;
- the old multi-step wizard protocol;
- transcript/task/activity monitoring surfaces.

The core PiLink server/CLI may still support specialist capabilities where they
make sense. They are no longer separate VS Code products.

## Process ownership

The extension will not silently compete with another PiLink owner.

- If the extension owns the process, it can stop/restart it.
- If the configured port already belongs to a PiLink process outside the current
  VS Code session, reconfiguration/start ownership is refused and the user is
  told to stop/manage that process with the CLI or service manager.
- Changing the project while an external PiLink is running is refused.

This keeps one configuration/port under one active owner.

## OAuth browser behavior

PiLink owner verification requires persistent browser storage. If VS Code's
integrated browser uses ephemeral storage, the extension refuses the flow and
offers the relevant setting instead of pretending OAuth can persist.

The extension prefers VS Code's integrated browser. It falls back to the system
browser only after an explicit warning/choice, which matters in Remote SSH where
the UI and PiLink host can be different machines.

## Daily use

With a stable endpoint and OAuth already authorized, daily use should be close
to:

1. open the project;
2. start PiLink if it is stopped;
3. open ChatGPT Work;
4. work.

If the dashboard says **OAuth ready**, do not repeat client registration. A new
MCP transport will appear when ChatGPT actually invokes PiLink.

Quick Tunnel is the exception because recreating it changes the public origin.

## Implementation map

- `packages/vscode/media/app.js` — command-only, state-driven launcher UI;
- `packages/vscode/media/app.css` — VS Code-themed responsive styling;
- `packages/vscode/src/dashboard.ts` — webview lifecycle and CSP;
- `packages/vscode/src/extension.ts` — focused launcher controller, hosting,
  process ownership, OAuth pairing, and safe reconfiguration;
- `packages/vscode/src/protocol.ts` — narrow launcher command/state contract;
- `packages/vscode/src/configuration.ts` — private configuration generation and
  public dashboard-safe client summaries.

The old `media/main.js` and `media/styles.css` dashboard implementation was
removed, and the release verifier rejects packages containing them.

For trust boundaries see [Architecture](ARCHITECTURE.md) and
[Security model](SECURITY_MODEL.md). For remote authorization details see
[Connect ChatGPT Work](CONNECT_CHATGPT.md).
