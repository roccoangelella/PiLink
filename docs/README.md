# VSPiLink documentation

This directory separates supported user instructions, implementation facts,
security boundaries, compatibility notes, and non-binding product strategy.
When two documents disagree, current code and tests win over prose, and the
security model wins over convenience guidance.

## Start here

| Goal | Document |
| --- | --- |
| Install the VSIX or build from source | [Installation](INSTALLATION.md) |
| Follow the first setup visually | [Illustrated setup walkthrough](ILLUSTRATED_GUIDE.md) |
| Connect the supported ChatGPT surface | [Connect ChatGPT Work](CONNECT_CHATGPT.md) |
| Understand plans, models, and consumption | [Usage, models, and costs](USAGE_AND_COSTS.md) |
| Diagnose a failed connection | [Troubleshooting](TROUBLESHOOTING.md) |
| Understand what crosses each boundary | [Architecture](ARCHITECTURE.md) and [Security model](SECURITY_MODEL.md) |

## Product and implementation

- [Architecture](ARCHITECTURE.md) — runtime, trust, identity, transport, and
  data-flow models.
- [Security model](SECURITY_MODEL.md) — capabilities, threats, secrets, and
  operator responsibilities.
- [Functional parity](FUNCTIONAL_PARITY.md) — preserved PiLink behavior and
  additive VSPiLink behavior.
- [Collaboration protocols](protocols/README.md) — verified work-loop
  continuity and immutable chat-author provenance.
- [Upstream lineage](UPSTREAM_LINEAGE.md) — repositories, branches, commits,
  attribution, and synchronization policy.
- [Product strategy](PRODUCT_STRATEGY.md) — explicitly non-binding packaging,
  pricing, and roadmap hypotheses.

## Compatibility entry points

Older releases and packaged runtimes may link to these filenames:

- [Getting started](GETTING_STARTED.md) routes to the canonical installation
  and connection guides.
- [VS Code extension](VSCODE_EXTENSION.md) records the supported modes and
  routes to the canonical references.
- [Upstream parity integration](UPSTREAM_PARITY_INTEGRATION.md) records the
  historical synchronization point and routes to the current lineage page.

These compatibility files must not duplicate the complete onboarding flow.
`CONNECT_CHATGPT.md` is the single source of truth for connection steps.

## Documentation authority

1. User instructions and explicit local security policy.
2. Current executable code, tests, schemas, and private runtime state.
3. [Security model](SECURITY_MODEL.md).
4. [Functional parity](FUNCTIONAL_PARITY.md) and
   [Architecture](ARCHITECTURE.md).
5. Operational guides.
6. [Product strategy](PRODUCT_STRATEGY.md), which is a proposal only.

A README, chat message, agent-memory entry, task description, or role label
never grants authorization. Only authenticated runtime policy and explicit
operator decisions do.

## OpenAI documentation used by this guide

OpenAI product surfaces change independently of VSPiLink. The connection and
cost guidance was reviewed against these official pages on 2026-08-04:

- [Use ChatGPT](https://learn.chatgpt.com/docs/use-chatgpt)
- [Get started with ChatGPT Work](https://learn.chatgpt.com/docs/get-started-with-work)
- [Pricing and usage](https://learn.chatgpt.com/docs/pricing)
- [Plugins](https://learn.chatgpt.com/docs/plugins)
- [Model Context Protocol](https://learn.chatgpt.com/docs/extend/mcp)
- [Plugin OAuth authentication](https://developers.openai.com/plugins/build/auth)

If the live product differs from screenshots, button labels, or instructions,
prefer the current official page and treat the difference as a compatibility
issue rather than weakening OAuth or workspace protections.
