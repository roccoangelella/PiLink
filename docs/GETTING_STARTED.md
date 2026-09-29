# Getting started

Use this path for the normal PiLink VS Code -> ChatGPT Work setup.

## Before you start

- Use a supported VS Code installation and the supported PiLink sidecar/runtime from [Installation](INSTALLATION.md).
- Open the exact project PiLink may access and trust that VS Code window.
- For remote ChatGPT Work use, your ChatGPT account/workspace must allow the private PiLink plugin to be created, imported, or installed. PiLink cannot grant that entitlement.

## Shortest safe path

1. Open **PiLink** from the VS Code Activity Bar.
2. Confirm the selected trusted project. The graphical launcher uses **Single agent** and **Project-folder** access.
3. Choose an endpoint:
   - **Set up stable endpoint** for regular remote use. Use either a Cloudflare fixed domain you control with the required scoped token, or an existing HTTPS domain/reverse proxy you operate.
   - **Temporary quick start** for evaluation. It creates a Quick Tunnel whose public URL can change when recreated.
   - **Local only** for same-machine clients. Remote ChatGPT Work cannot reach a local-only endpoint.
4. If the bridge is stopped later, use **Start PiLink**.
5. When the public HTTPS endpoint is healthy, use **Connect ChatGPT**.
6. Complete local owner verification first, then complete OAuth for the private PiLink plugin.
7. In ChatGPT Work, begin with a read-only request that identifies the configured project before allowing edits or repository execution.

A stable HTTPS origin is the durable path because the plugin and OAuth configuration are tied to that origin. A recreated Quick Tunnel has a different public origin and may require the plugin connection to be updated.

**OAuth ready** means authorization has been stored; it does not mean an MCP session is active. The launcher reports an active connection only when ChatGPT Work actually opens a PiLink transport to invoke tools.

The VS Code dashboard is a launcher/status surface. It does not contain a ChatGPT transcript, task board, or activity feed.

For the full remote connection sequence see [Connect ChatGPT Work](CONNECT_CHATGPT.md). For launcher states and recovery see [PiLink for VS Code](VSCODE_EXTENSION.md). For trust and execution boundaries read [Security model](SECURITY_MODEL.md).
