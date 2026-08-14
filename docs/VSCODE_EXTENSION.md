# VS Code extension

This compatibility page replaces the previous duplicated extension guide.

VSPiLink's VS Code extension provides:

- a primary **ChatGPT MCP** status/setup/dashboard mode;
- an optional **Pi Local** provider/model/chat mode;
- a graphical entry that contains both the **Single agent** and
  **Collaborative public chat** server modes;
- Workspace Trust and explicit multi-root selection;
- an Integrated Browser launch for the OpenAI-controlled UI;
- loopback-protected administration of the sidecar;
- hosting, OAuth, session, collaboration, task, and supervised-agent status;
- SecretStorage-backed credentials and a configurable Node.js 24.18.0
  executable.

The VSPiLink webview is not a browser and does not embed or inspect ChatGPT.
The current supported web execution surface is ChatGPT Work with an installed
plugin. Pi Local is independent and uses its selected provider.

The ChatGPT MCP/Pi Local selector chooses the execution surface; it does not
choose the server capability catalog. Select the core catalog as **Single
agent** or **Collaborative public chat** in the guided runtime setup (or with
`pilink start --mode single|collaboration`). The graphical `vscode` entry is
only the handoff into this extension and must not be stored as
`PI_RUNTIME_MODE=vscode`. See [Runtime mode selection](operations/mode-selection.md)
for capability differences, headless operation, and migration.

Canonical references:

- [Installation](INSTALLATION.md)
- [Connect ChatGPT Work](CONNECT_CHATGPT.md)
- [Architecture](ARCHITECTURE.md)
- [Security model](SECURITY_MODEL.md)
- [Functional parity](FUNCTIONAL_PARITY.md)
- [Troubleshooting](TROUBLESHOOTING.md)
