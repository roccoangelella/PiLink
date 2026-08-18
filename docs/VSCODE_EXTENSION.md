# PiLink VS Code extension

The PiLink VS Code extension is the graphical launcher for the PiLink MCP
bridge. The design target is deliberately small:

> open a project, start PiLink safely, make the MCP endpoint reachable when
> needed, connect ChatGPT, and see whether the bridge is healthy.

The extension is not a second ChatGPT interface and it is not intended to expose
every PiLink subsystem as a peer in the main UI.

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

The previous dashboard mixed execution surfaces, server workflows, hosting,
OAuth, access policy, local model providers, tasks, agents, and monitoring on
one screen. That was technically expressive but difficult to reason about.

The extension now follows one rule: **show the next action in the ordinary MCP
bridge lifecycle and hide specialist mechanisms from the normal path.**

A fresh graphical setup therefore uses:

- the **single-agent** PiLink toolset;
- **project-folder** access;
- no unrestricted shell;
- no local model-provider setup;
- no collaboration workflow choice;
- no native VS Code MCP setup choice.

Those other PiLink capabilities can continue to exist for compatibility or
operator use without defining the graphical product.

## Main lifecycle

### 1. Choose the project

Open and trust the project folder that PiLink may access. The extension will not
perform privileged setup or start PiLink from a VS Code Restricted Mode
workspace.

### 2. Choose the endpoint

For a new project the main card offers three choices:

**Set up stable endpoint** is the recommended normal path for ChatGPT Work. It
uses the native hosting prompts for a persistent Cloudflare hostname or an
existing HTTPS origin.

**Temporary quick start** starts the same safe single-agent bridge through a
Cloudflare Quick Tunnel. This is convenient for evaluation, but the public URL
changes when the tunnel is recreated.

**Local only** starts PiLink without a public endpoint. This is useful when the
MCP client is on the same machine.

### 3. Start PiLink

Once configured, the main action is simply **Start PiLink** whenever the bridge
is stopped.

### 4. Connect ChatGPT

When the public HTTPS endpoint is healthy, select **Connect ChatGPT** and
complete the owner verification/OAuth flow. If the OAuth client already exists,
the UI says **Continue connection** instead of encouraging duplicate client
registration.

### 5. Work in ChatGPT

After authorization, the extension says **OAuth ready**. Open ChatGPT Work and
work there. When ChatGPT actually invokes a PiLink tool, an MCP session becomes
active and the extension reports **Connected**.

The extension never needs to mirror the ChatGPT transcript to prove that PiLink
is working.

## Status model

The dashboard keeps three facts visible:

| Field | Meaning |
| --- | --- |
| **Server** | Is the local PiLink process running? |
| **Endpoint** | Is PiLink local-only or exposed through public HTTPS? |
| **ChatGPT** | Is ChatGPT unconfigured, awaiting OAuth, authorized, or actively connected? |

This avoids overloading one “connected” indicator with several independent
states.

Common ChatGPT states are:

**Not connected** — no ChatGPT OAuth client is prepared yet.

**Authorize** — the client already exists but OAuth is unfinished. Continue the
existing flow.

**OAuth ready** — authorization is stored and reusable. No permanent transport
has to remain open.

**Connected** / **N active** — one or more MCP transports are active now.

## Details & recovery

Normal use should not require the lower disclosure. **Details & recovery** keeps
only the bridge operations useful for diagnosis or repair:

- restart/stop;
- hosting reconfiguration;
- MCP URL copy;
- private configuration access;
- PiLink terminal;
- documentation.

This section also shows the project, hosting type, server workflow, and MCP
endpoint so an operator can verify what is actually running without navigating
multiple product tabs.

## What was deliberately removed from the graphical product

### Local provider / Pi Local chat

PiLink retains local-agent/provider implementation for compatibility and other
entry points, but the VS Code dashboard no longer presents it as a second
product. A user who installed the extension only to start MCP should never be
asked to choose a model provider.

### Native VS Code MCP setup

The compatibility implementation can remain in the extension, but its scope and
connection controls are no longer normal user-facing settings or dashboard
actions. The extension itself is the PiLink launcher; it does not need to teach
a second MCP integration during setup.

### Collaboration enablement

The collaboration server mode remains supported by PiLink, but the graphical
launcher does not advertise it as a sibling of the single-agent workflow. If an
existing project is already configured for collaboration, the dashboard detects
that state and offers **Switch to single-agent** rather than silently changing
it.

### Full-access launch

Full access removes the project boundary and allows general process execution as
the PiLink OS user. It is remote code execution by design.

The ordinary VS Code workflow therefore does not offer a Full-access launch
button. If an existing configuration already contains Full access, the
dashboard enters an explicit safety state instead of showing the normal Start
button. Operators who deliberately need unrestricted access should use the
PiLink CLI and its explicit security controls.

## Recent activity

The only monitoring retained on the main surface is a short metadata-only list
of recent MCP calls. It is useful for answering “is the client using PiLink?”
without turning the extension into an observability product.

The list is bounded and contains operational metadata such as tool name,
outcome, duration, and time. It intentionally excludes:

- prompts;
- file paths;
- tool arguments;
- tool results;
- ChatGPT transcript content;
- cookies or browser DOM;
- model reasoning.

## Stable endpoint versus Quick Tunnel

A stable origin is the recommended default because the remote MCP endpoint and
OAuth identity are meant to survive ordinary restarts.

Quick Tunnel remains useful for evaluation, but its hostname is transient. When
it changes, the old ChatGPT connection still points at the previous origin. For
a durable installation, use the fixed-domain or existing-domain path.

## Daily use

With stable hosting and OAuth already configured, daily use should be close to:

1. open the project;
2. start PiLink if it is stopped;
3. open ChatGPT Work;
4. work.

If the dashboard says **OAuth ready**, do not repeat OAuth registration. ChatGPT
will create an MCP transport when it needs the tools.

## Compatibility versus UX

The extension backend still contains some older/specialist commands and state so
existing installations are not unnecessarily broken. They are intentionally
not promoted through the command palette or main dashboard.

This separation is deliberate: retaining compatibility does not require
retaining the old UX.

## Implementation map

- `packages/vscode/media/app.js` — state-driven launcher UI;
- `packages/vscode/media/app.css` — VS Code-themed responsive styling;
- `packages/vscode/src/dashboard.ts` — webview lifecycle and CSP;
- `packages/vscode/src/extension.ts` — process, hosting, OAuth, and compatibility implementation;
- `packages/vscode/src/runtime-mode.ts` — single-agent default and legacy workflow state;
- `packages/vscode/src/protocol.ts` — webview command/state protocol.

For protocol and trust boundaries see [Architecture](ARCHITECTURE.md) and
[Security model](SECURITY_MODEL.md). For remote authorization details see
[Connect ChatGPT Work](CONNECT_CHATGPT.md).
