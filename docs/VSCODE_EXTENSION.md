# PiLink VS Code extension

This page is the launcher reference. For onboarding, start with [Getting started](GETTING_STARTED.md).

## Scope

The extension controls the normal PiLink MCP bridge lifecycle for one selected project. The graphical policy is fixed to:

- `PI_RUNTIME_MODE=single`;
- Project-folder access / `PI_UNSAFE_FULL_ACCESS=false`;
- paired OAuth consent;
- the endpoint settings selected in the launcher.

It is not a chat client or monitoring console. The dashboard has no transcript, task board, agent list, or activity feed.

## Installation and runtime

Install or update with:

```bash
pilink install-vscode-plugin
```

The release installers can also provision the supported sidecar Node.js runtime. See [Installation](INSTALLATION.md) for supported VS Code/runtime combinations and Remote SSH details.

After installation, open or reload VS Code and select **PiLink** in the Activity Bar.

## Project trust

The launcher blocks setup, startup, OAuth, and project changes while the workspace is in Restricted Mode.

In a multi-root workspace, select the exact project PiLink may access. Project changes require local confirmation.

## Endpoint choices

For a new project, the launcher offers:

- **Set up stable endpoint**
  - **Cloudflare fixed domain** — requires a domain you control and the required scoped token for provisioning.
  - **Existing HTTPS domain** — uses an HTTPS origin/reverse proxy you already operate.
- **Temporary quick start** — creates a Quick Tunnel for evaluation. The public URL can change when recreated.
- **Local only** — same-machine access only; remote ChatGPT Work cannot reach it.

Reconfiguration uses **Details & recovery -> Reconfigure endpoint...** or **PiLink: Reconfigure PiLink** and keeps the same Single-agent / Project-folder policy.

## Main actions and states

| Launcher state | Main action or meaning |
| --- | --- |
| Restricted workspace | **Manage Workspace Trust** |
| New project | **Set up stable endpoint** |
| Configured but stopped | **Start PiLink** |
| Local bridge only | **Configure remote endpoint** |
| Public endpoint ready | **Connect ChatGPT** |
| OAuth unfinished | **Continue connection** |
| OAuth stored | **OAuth ready** / **Open ChatGPT Work** |
| Active MCP transport | Connected / active-session count |

**OAuth ready** is durable authorization state, not proof of a live network session. A live MCP transport appears only when ChatGPT Work actually invokes PiLink.

## Connecting ChatGPT Work

For a public endpoint, **Connect ChatGPT** creates a short-lived local owner-verification request before OAuth handoff.

The ChatGPT account/workspace must already permit the private PiLink plugin to be created, imported, or installed. PiLink does not grant that entitlement.

See [Connect ChatGPT Work](CONNECT_CHATGPT.md) for the full sequence and first read-only task.

## Status fields

The dashboard keeps three separate facts visible:

| Field | Meaning |
| --- | --- |
| **Server** | Local PiLink process state. |
| **Endpoint** | Local-only versus public HTTPS reachability. |
| **ChatGPT** | Authorization state and, when present, active MCP sessions. |

These are intentionally separate. A running server is not automatically a reachable endpoint, and stored OAuth authorization is not automatically an active transport.

## Details & recovery

The collapsed section contains bridge operations such as restart/stop, endpoint reconfiguration, copying the MCP URL, opening the private configuration, showing PiLink terminal/output, and opening the guide.

## Existing advanced configurations

The launcher does not silently broaden access:

- existing Collaboration configurations are shown as an advanced state and can be moved back to **Switch to single-agent**;
- saved Full-access configurations are not started by the normal launcher and can be reset with **Reconfigure safely...**;
- legacy managed Named-Tunnel service configurations are not owned by the simplified launcher.

Specialist collaboration, Full access, manual OAuth-client management, provider-backed agents, and legacy service hosting remain core PiLink CLI/operator concerns where supported.

## Process ownership

The extension does not compete with another PiLink owner. If the configured port is already owned by a PiLink process outside the current VS Code session, start/reconfiguration is refused until that process is managed or stopped through its existing owner.

## OAuth browser behavior

Local owner verification requires persistent browser storage. If VS Code's integrated browser cannot provide it, the launcher reports the problem rather than treating OAuth as complete. It prefers the integrated browser and offers a system-browser fallback only after an explicit warning/choice; in Remote SSH, the UI browser and PiLink host may be different machines.

## Daily use

With a stable HTTPS origin and stored authorization:

1. open the trusted project;
2. use **Start PiLink** if the bridge is stopped;
3. use **Open ChatGPT Work** when appropriate;
4. work in ChatGPT Work.

A missing active session is not a reason to repeat OAuth. Quick Tunnel recreation is the important exception because it changes the public origin.

For trust boundaries see [Architecture](ARCHITECTURE.md) and [Security model](SECURITY_MODEL.md).
