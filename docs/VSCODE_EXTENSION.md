# VS Code extension

This compatibility page replaces the previous duplicated extension guide.

VSPiLink's VS Code extension provides:

- a primary **ChatGPT MCP** status/setup/dashboard mode;
- an optional **Pi Local** provider/model/chat mode;
- Workspace Trust and explicit multi-root selection;
- an Integrated Browser launch for the OpenAI-controlled UI;
- loopback-protected administration of the sidecar;
- hosting, OAuth, session, collaboration, task, and supervised-agent status;
- SecretStorage-backed credentials and a configurable Node.js 24.18.0
  executable.

The VSPiLink webview is not a browser and does not embed or inspect ChatGPT.
The current supported web execution surface is ChatGPT Work with an installed
plugin. Pi Local is independent and uses its selected provider.

Canonical references:

- [Installation](INSTALLATION.md)
- [Connect ChatGPT Work](CONNECT_CHATGPT.md)
- [Architecture](ARCHITECTURE.md)
- [Security model](SECURITY_MODEL.md)
- [Functional parity](FUNCTIONAL_PARITY.md)
- [Troubleshooting](TROUBLESHOOTING.md)
