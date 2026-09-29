# PiLink for VS Code

The VS Code extension is the launcher/status surface for the core PiLink MCP bridge. The server, CLI, OAuth implementation, and MCP tools remain in the core project.

For user onboarding, use [Getting started](../../docs/GETTING_STARTED.md). This README is the package-level reference.

## Normal flow

1. Install PiLink for VS Code and the supported sidecar runtime on the workspace host. For a first installation, use the [release-bundle installer](../../docs/INSTALLATION.md#recommended-vs-code-release-install).
2. Open and trust the project PiLink may access.
3. Open **PiLink** from the Activity Bar.
4. Choose:
   - **Set up stable endpoint** for a durable remote HTTPS origin;
   - **Temporary quick start** for a temporary Quick Tunnel evaluation;
   - **Local only** for same-machine MCP clients.
5. For a public endpoint, use **Connect ChatGPT**.
6. Complete local owner verification, then OAuth for the intended private PiLink plugin.
7. Start with a read-only task in ChatGPT Work.

A stable remote endpoint requires either a Cloudflare fixed domain you control or an existing HTTPS domain/reverse proxy you operate. Cloudflare provisioning requires **Account -> Cloudflare Tunnel -> Edit**, **Zone -> DNS -> Edit**, and **Zone -> Zone -> Read**; see [Cloudflare fixed-domain token permissions](../../docs/INSTALLATION.md#cloudflare-fixed-domain-token-permissions). A Quick Tunnel can change URL when recreated. **Local only** is not reachable by remote ChatGPT Work.

The private PiLink plugin must be provisioned for the ChatGPT workspace or created/imported through controls the account is permitted to use. PiLink cannot grant those controls.

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

For a first installation, download the matching PiLink GitHub release bundle and follow the [recommended release install](../../docs/INSTALLATION.md#recommended-vs-code-release-install). The release installer can provision the supported private sidecar Node.js runtime.

If the PiLink CLI is already installed on the workspace host:

```bash
pilink install-vscode-plugin
```

For Remote SSH, both installation paths run on the remote workspace host; browser pairing remains in the local VS Code UI/browser flow. See [Remote SSH](../../docs/INSTALLATION.md#remote-ssh).

## More documentation

- [Getting started](../../docs/GETTING_STARTED.md)
- [Connect ChatGPT Work](../../docs/CONNECT_CHATGPT.md)
- [Illustrated setup](../../docs/ILLUSTRATED_GUIDE.md)
- [VS Code extension reference](../../docs/VSCODE_EXTENSION.md)
- [Installation](../../docs/INSTALLATION.md)
- [Security model](../../docs/SECURITY_MODEL.md)
- [Troubleshooting](../../docs/TROUBLESHOOTING.md)
