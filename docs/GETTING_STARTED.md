# Getting started

This filename is retained for links from older releases. The normal PiLink VS
Code onboarding flow is intentionally short:

1. Follow [Installation](INSTALLATION.md).
2. Open the project you want PiLink to access and trust that VS Code window.
3. Open the **PiLink** view in the Secondary Side Bar.
4. Select **Quick start for ChatGPT** for the simplest remote setup, or **Local
   only** when no public endpoint is needed.
5. When the dashboard says the public endpoint is ready, select **Connect
   ChatGPT** and follow [Connect ChatGPT Work](CONNECT_CHATGPT.md).
6. Begin with the read-only first task in that guide.
7. Read [Security model](SECURITY_MODEL.md) before enabling repository
   execution, collaboration, or Full access from another operator surface.

Fresh ordinary graphical setups use **Single agent** and **Project-folder**
access automatically. You do not need to choose a server workflow, model
provider, or machine-wide permission before starting PiLink.

Use **Advanced setup...** only when you deliberately need a stable/legacy
hosting arrangement or another specialist configuration. That compatibility
flow can expose additional workflow/access choices, so review them explicitly
rather than treating it as the normal first-run path.

The provider-backed local Pi runtime, native VS Code MCP compatibility,
collaboration enablement, manual OAuth registration, and Full-access launch are
not promoted as parallel products in the main dashboard. They remain available
through their appropriate CLI/backend compatibility paths for operators who
actually need them.

When Dynamic Client Registration is available, the normal OAuth path does not
require manually copying a callback URL, client ID, or client secret. Keep the
manual client-registration path only as a compatibility fallback for builders
that explicitly require it.

For model/provider cost considerations see [Usage, models, and costs](USAGE_AND_COSTS.md).
For errors, use the layer-by-layer [Troubleshooting guide](TROUBLESHOOTING.md).
