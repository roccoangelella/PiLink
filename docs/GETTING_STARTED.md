# Getting started

This filename is retained for links from older releases. The normal VSPiLink
onboarding flow is intentionally short:

1. Follow [Installation](INSTALLATION.md).
2. Open the project you want PiLink to access and trust that VS Code window.
3. Open the **PiLink** view in the Secondary Side Bar.
4. Select **Quick start for ChatGPT** for the simplest remote setup, or **Local
   only** when no public endpoint is needed.
5. When the dashboard says the public endpoint is ready, select **Connect
   ChatGPT** and follow [Connect ChatGPT Work](CONNECT_CHATGPT.md).
6. Begin with the read-only first task in that guide.
7. Read [Security model](SECURITY_MODEL.md) before enabling repository
   execution, collaboration, or Full access.

Fresh graphical setups use **Single agent** automatically. You do not need to
choose a server workflow before starting PiLink. The additive collaboration
workflow remains available under **Advanced -> Workflow** for users who need
shared chat/tasks, memory/work-loop coordination, or remote supervised-agent
controls.

The optional local provider-backed Pi agent is also under **Advanced**. It is
separate from the ChatGPT MCP connection and can be ignored completely when
VSPiLink is used only as a graphical launcher for PiLink.

When Dynamic Client Registration is available, the normal OAuth path does not
require manually copying a callback URL, client ID, or client secret. Keep the
manual client-registration path only as a compatibility fallback for builders
that explicitly require it.

For model/provider cost considerations see [Usage, models, and costs](USAGE_AND_COSTS.md).
For errors, use the layer-by-layer [Troubleshooting guide](TROUBLESHOOTING.md).
