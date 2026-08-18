# VSPiLink: the VS Code control surface

VSPiLink is the optional GUI for operating PiLink from VS Code. Its main job is
simple: **start the PiLink MCP server for the open project, connect a remote
client, and show whether the bridge is healthy.**

It is not intended to become another chat application.

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
VSPiLink starts and manages this side
```

## What changed

Older VSPiLink builds exposed several independent concepts at the same visual
level: ChatGPT MCP vs Pi Local, single-agent vs collaboration, hosting, OAuth,
agent chat, tasks, providers, and access policy. That made the dashboard look
like a product switchboard rather than a start button for PiLink.

The redesigned dashboard uses a different rule:

> show only the next action needed for the ordinary PiLink lifecycle; put
> optional capability switches under Advanced.

A fresh installation therefore starts from **single-agent** automatically.
Collaboration remains supported, but it is an explicit advanced opt-in.

## The main screen

The screen has four parts.

### 1. PiLink status

The header shows the current workspace and one short state such as **Setup**,
**Stopped**, **Online**, **Ready**, or **Connected**.

### 2. One primary action

The large card changes with the lifecycle:

| Situation | What VSPiLink asks you to do |
| --- | --- |
| VS Code does not trust the folder | Manage Workspace Trust |
| PiLink has never been configured | Start PiLink |
| PiLink is configured but stopped | Start PiLink |
| Public endpoint is online | Connect ChatGPT |
| OAuth exists but is unfinished | Continue connection |
| OAuth is ready | Open ChatGPT Work |
| An MCP transport is active | Open ChatGPT Work |

This is intentionally much less flexible than the old top-level dashboard. The
ordinary path should not require understanding the implementation architecture.

### 3. Three always-visible facts

The bottom of the main card reports:

- **Server** — running or stopped;
- **Remote** — local-only, authorization pending, OAuth ready, or active;
- **Access** — Project folder or Full machine.

These answer the questions that matter while debugging a connection without
turning the screen into a monitoring console.

### 4. Advanced

Hosting changes, collaboration, Full access, VS Code's native MCP provider,
manual OAuth registration, the terminal, configuration, and the optional local
Pi agent are grouped under one disclosure.

## First run: the shortest path

For the common goal — "let ChatGPT Work use PiLink on this project" — use this
flow:

1. Open the project folder in VS Code.
2. Trust the folder.
3. Open **VSPiLink** in the Secondary Side Bar.
4. Select **Quick start for ChatGPT**.
5. Wait for PiLink and the temporary HTTPS endpoint to become healthy.
6. Select **Connect ChatGPT**.
7. Complete the owner verification/OAuth flow.
8. Do the actual work in ChatGPT Work.

Quick start deliberately uses:

- **single-agent** workflow;
- **Project folder** access;
- no unrestricted shell;
- a temporary Cloudflare Quick Tunnel.

The temporary hostname changes when the tunnel is recreated. Once you know you
want a durable installation, use **Stable endpoint...** instead.

## Stable endpoint

**Stable endpoint...** opens the existing native VS Code setup prompts. They
support the more operational hosting cases without crowding the main screen:

- Cloudflare fixed domain / provisioned Named Tunnel;
- managed Cloudflare Named Tunnel;
- an existing HTTPS domain/reverse proxy;
- Quick Tunnel;
- local-only operation;
- the legacy `nip.io` path.

The safe permission choice is **Project folder only**. Choosing Full access in
that advanced flow requires an explicit warning/confirmation.

## Local-only use

Select **Local only** on first run when the PiLink server should stay on the
machine. This is useful for local MCP clients and for the optional local Pi
runtime. A remote ChatGPT Work plugin cannot reach a loopback-only endpoint.

If you later want ChatGPT Work, use **Make it reachable from ChatGPT** or
**Change hosting...**.

## OAuth states

Connection status is deliberately split into three concepts:

**Not connected** means no ChatGPT OAuth client has been prepared yet.

**Authorization pending** means the OAuth client already exists, but the user
has not finished authorization. Continue the existing flow; do not create a
second client merely because no MCP session is active.

**OAuth ready** means authorization is durable. There does not have to be a
permanent network connection. ChatGPT opens a transport when it invokes PiLink.

**Connected** means at least one MCP transport is active at that moment.

## Why the dashboard no longer has ChatGPT MCP / Pi Local tabs

They represented two different execution surfaces, not two PiLink server modes,
and looked too much like a product-level choice.

ChatGPT Work is now treated as the ordinary remote client. Its controls are
part of the main server lifecycle.

The optional local provider/agent runtime still exists, but it is under
**Advanced -> Optional local Pi agent**. Provider credentials remain completely
separate from ChatGPT OAuth.

## Why collaboration moved to Advanced

The original PiLink concept is a single-agent workspace bridge. That is now the
automatic default.

Enable **Public chat & orchestration** only when you need PiLink's additional
coordination layer:

- explicit agent-to-agent messages;
- shared tasks and task ownership;
- work-loop coordination;
- governed memory projections;
- remote supervised-agent controls.

Switching workflow restarts PiLink because the workflow changes the MCP tool
catalog. It does not publish an endpoint, install a ChatGPT plugin, alter OAuth
credentials, or grant Full access.

When collaboration is enabled, VSPiLink displays a visible notice and exposes
the existing **Agent & Task Monitor** action.

## Full access

**Project folder** is the normal security boundary. File operations are
confined to the selected canonical workspace and a general-purpose shell is not
available.

**Full machine** is remote code execution by design. It permits an explicitly
authorized OAuth client to access files outside the project and run commands as
the PiLink OS user.

For that reason the redesigned dashboard:

- never offers Full access as a first-run primary action;
- keeps the control under Advanced;
- does not enable the button until an eligible ChatGPT OAuth client with the
  required tool scope exists;
- keeps the Full-machine state visible in the main status row whenever it is
  active.

Re-running the normal hosting setup with Project-folder access resets the
configuration back to the safe boundary.

## Recent activity

The main dashboard keeps one lightweight monitor because it is useful for
answering "is ChatGPT actually calling PiLink?"

It shows at most a few recent MCP calls and only the metadata PiLink deliberately
publishes: tool name, outcome, duration, and access mode.

It does not show:

- prompts;
- file paths;
- tool arguments;
- tool results;
- ChatGPT transcript content;
- cookies or browser storage;
- model reasoning.

The richer collaboration chat/task monitor remains separate and is only useful
when the collaboration workflow is enabled.

## Optional local Pi agent

The provider/model and supervised-agent backend was useful enough to keep, but
not important enough to define the dashboard.

Under **Advanced -> Optional local Pi agent** you can still:

- configure the provider and model;
- authenticate to the provider;
- create a supervised local agent;
- inspect output;
- stop an active agent;
- sign out of the provider.

This functionality is independent from ChatGPT MCP OAuth and can be ignored
completely by users who only want VSPiLink as a graphical launcher for PiLink.

## Daily use

With a stable HTTPS endpoint and OAuth already authorized, daily use should be
approximately:

1. open the project;
2. start PiLink if it is stopped;
3. open ChatGPT Work;
4. work.

If VSPiLink says **OAuth ready**, do not repeat client registration or callback
setup. A new MCP transport will appear when the remote client actually needs
PiLink.

Quick Tunnel is the main exception because the public hostname is temporary.

## What remains available from the Command Palette

The extension still registers compatibility and recovery commands even though
most are no longer promoted in the dashboard. This protects existing workflows
while making the primary UI simpler.

Examples include initialization, manual client registration, legacy hosting,
reset/recovery, provider configuration, local-agent management, and the native
VS Code MCP provider.

## Implementation map

The relevant extension pieces are now intentionally separated:

- `packages/vscode/media/app.js` — the focused dashboard state machine;
- `packages/vscode/media/app.css` — the VS Code-themed responsive UI;
- `packages/vscode/src/dashboard.ts` — webview lifecycle and CSP;
- `packages/vscode/src/extension.ts` — process, OAuth, hosting, agent, and command
  implementation;
- `packages/vscode/src/runtime-mode.ts` — automatic single-agent default plus
  explicit collaboration opt-in;
- `packages/vscode/src/protocol.ts` — the narrow webview message/state contract.

The previous `media/main.js` and `media/styles.css` implementation is no longer
loaded or packaged by the extension.

For protocol/security boundaries see [Architecture](ARCHITECTURE.md) and
[Security model](SECURITY_MODEL.md). For the remote authorization details see
[Connect ChatGPT Work](CONNECT_CHATGPT.md).
