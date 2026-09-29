# PiLink for VS Code

The VS Code extension is the launcher/status surface for the core PiLink MCP bridge. The server, CLI, OAuth implementation, and MCP tools remain in the core project.

For user onboarding, use [Getting started](../../docs/GETTING_STARTED.md). This README is the package-level reference.

## Normal flow

1. Install a supported VS Code build and the supported PiLink sidecar/runtime.
2. Open and trust the project PiLink may access.
3. Open **PiLink** from the Activity Bar.
4. Choose:
   - **Set up stable endpoint** for a durable remote HTTPS origin;
   - **Temporary quick start** for a temporary Quick Tunnel evaluation;
   - **Local only** for same-machine clients.
5. For a public endpoint, use **Connect ChatGPT**.
6. Complete local owner verification, then OAuth for the private PiLink plugin.
7. Start with a read-only task in ChatGPT Work.

A stable remote endpoint requires either a Cloudflare fixed domain you control with the required scoped token, or an existing HTTPS domain/reverse proxy you operate. A Quick Tunnel can change URL when recreated. **Local only** is not reachable by remote ChatGPT Work.

The ChatGPT account/workspace must permit creation, import, or installation of the private PiLink plugin. PiLink cannot grant that entitlement.

## Graphical safety policy

Every normal graphical setup/reconfiguration uses:

- `PI_RUNTIME_MODE=single`;
- Project-folder access / `PI_UNSAFE_FULL_ACCESS=false`;
- paired OAuth consent.

The launcher does not expose Full-access launch, collaboration enablement, provider/model setup, native VS Code MCP setup, or manual OAuth-client registration as ordinary graphical paths.

## Main launcher states

| State | Main action |
| --- | --- |
| Restricted workspace | **Manage Workspace Trust** |
| New project | **Set up stable endpoint** |
| Configured but stopped | **Start PiLink** |
| Local bridge only | **Configure remote endpoint** |
| Public endpoint ready | **Connect ChatGPT** |
| OAuth unfinished | **Continue connection** |
| OAuth stored | **Open ChatGPT Work** |
| Active MCP session | **Open ChatGPT Work** |

The status area keeps **Server**, **Endpoint**, and **ChatGPT** separate.

**OAuth ready** means authorization is stored. It does not mean a live MCP session exists. A session becomes active when ChatGPT Work invokes PiLink.

The dashboard has no transcript, task board, agent list, or activity feed.

## Install

If the PiLink CLI is installed:

```bash
pilink install-vscode-plugin
```

The release-bundle installers can additionally provision the supported sidecar Node.js runtime.

## More documentation

- [Getting started](../../docs/GETTING_STARTED.md)
- [Connect ChatGPT Work](../../docs/CONNECT_CHATGPT.md)
- [Illustrated setup](../../docs/ILLUSTRATED_GUIDE.md)
- [VS Code extension reference](../../docs/VSCODE_EXTENSION.md)
- [Installation](../../docs/INSTALLATION.md)
- [Security model](../../docs/SECURITY_MODEL.md)
- [Troubleshooting](../../docs/TROUBLESHOOTING.md)
