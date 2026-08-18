# Getting started

This filename is retained for links from older releases. The normal PiLink VS
Code onboarding flow is intentionally short:

1. Follow [Installation](INSTALLATION.md).
2. Open the project you want PiLink to access and trust that VS Code window.
3. Open the **PiLink** view in the Secondary Side Bar.
4. Choose **Set up stable endpoint** for regular ChatGPT use, **Temporary quick
   start** for evaluation, or **Local only** for same-machine clients.
5. Every graphical setup uses **Single agent** and **Project-folder** access.
6. When the dashboard says the public endpoint is ready, select **Connect
   ChatGPT** and follow [Connect ChatGPT Work](CONNECT_CHATGPT.md).
7. Begin with the read-only first task in that guide.
8. Read [Security model](SECURITY_MODEL.md) before enabling repository execution,
   collaboration, or Full access from the PiLink CLI/operator workflow.

**Set up stable endpoint** supports a Cloudflare fixed domain or an existing
HTTPS reverse proxy. PiLink recommends this path because a Quick Tunnel receives
a different public URL when it is recreated.

The graphical reconfiguration flow is also fixed to Single agent and
Project-folder access. It does not ask for a collaboration mode, model provider,
or machine-wide permission.

Provider-backed local agents, native VS Code MCP integration, collaboration
enablement, manual OAuth registration, legacy managed services, and Full-access
launch are not parallel products in the current VS Code launcher. Use the core
PiLink CLI/operator paths only when you explicitly need those specialist
capabilities.

When Dynamic Client Registration is available, the normal OAuth path does not
require manually copying a callback URL, client ID, or client secret. Keep the
manual client-registration path only as a compatibility fallback for builders
that explicitly require it.

For model/provider cost considerations see [Usage, models, and costs](USAGE_AND_COSTS.md).
For errors, use the layer-by-layer [Troubleshooting guide](TROUBLESHOOTING.md).
