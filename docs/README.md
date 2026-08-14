# PiLink documentation

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
| Choose single-agent, collaboration, or VS Code graphical mode | [Runtime mode selection](operations/mode-selection.md) |
| Understand what crosses each boundary | [Architecture](ARCHITECTURE.md) and [Security model](SECURITY_MODEL.md) |

## Product and implementation

- [Architecture](ARCHITECTURE.md) — runtime, trust, identity, transport, and
  data-flow models.
- [Security model](SECURITY_MODEL.md) — capabilities, threats, secrets, and
  operator responsibilities.
- [Functional parity](FUNCTIONAL_PARITY.md) — preserved PiLink behavior and
  additive PiLink behavior.
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

## Document inventory

Every tracked document is listed once here. Public PiLink guides retain
stable root-level names because the packaged extension and release verifier
depend on them; internal engineering records remain grouped by purpose.

### Public product guides

- [Architecture](ARCHITECTURE.md)
- [Connect ChatGPT Work](CONNECT_CHATGPT.md)
- [Functional parity](FUNCTIONAL_PARITY.md)
- [Getting started compatibility entry point](GETTING_STARTED.md)
- [Illustrated setup walkthrough](ILLUSTRATED_GUIDE.md)
- [Installation](INSTALLATION.md)
- [Product strategy](PRODUCT_STRATEGY.md)
- [Security model](SECURITY_MODEL.md)
- [Troubleshooting](TROUBLESHOOTING.md)
- [Upstream lineage](UPSTREAM_LINEAGE.md)
- [Upstream parity integration](UPSTREAM_PARITY_INTEGRATION.md)
- [Usage, models, and costs](USAGE_AND_COSTS.md)
- [VS Code extension](VSCODE_EXTENSION.md)

### Architecture, decisions, and evaluation

- [Governed agent memory](architecture/agent-memory.md)
- [Project workspaces](architecture/project-workspaces.md)
- [Archived collaboration-memory architecture](archive/collaboration-memory-architecture.md)
- [Collaboration program decision](decisions/collaboration-program.md)
- [Collaboration evaluation plan](evaluation/collaboration-plan.md)
- [Role-bootstrap behavior](evaluation/role-bootstrap-behavior.md)

### Operations, protocols, and reference

- [Legacy PiLink getting-started operations](operations/getting-started.md)
- [Runtime mode selection](operations/mode-selection.md)
- [Release operations](operations/releasing.md)
- [Protocol index](protocols/README.md)
- [Agent work-loop transport continuity](protocols/agent-work-loop-transport-continuity.md)
- [Agent work loop](protocols/agent-work-loop.md)
- [Autonomous pull](protocols/autonomous-pull.md)
- [Chat-author provenance](protocols/chat-author-provenance.md)
- [Collaboration role contracts](protocols/collaboration-role-contracts.md)
- [Role-bootstrap registry](reference/role-bootstrap-registry.md)

### Research, reviews, security, and upstream records

- [Collaboration protocol research](research/collaboration-protocol.md)
- [Credential-hardening review](reviews/credential-hardening.md)
- [Scheduler-ownership review](reviews/scheduler-ownership.md)
- [Session-activity review](reviews/session-activity.md)
- [Threat model](security/threat-model.md)
- [B629 integration checklist](upstream/B629_INTEGRATION_CHECKLIST.md)
- [Upstream transport-continuity record](upstream/agent-work-loop-transport-continuity.md)
- [Upstream chat-author provenance record](upstream/chat-author-provenance.md)

## Supersession and relationship summary

The public product guides describe PiLink 2.2.0. Purpose-grouped documents
preserve the PiLink collaboration lineage and remain authoritative for the
subsystems they specify unless a public guide explicitly narrows a product
boundary. Files under `docs/upstream/` are provenance records, not independent
runtime policy.

## OpenAI documentation used by this guide

OpenAI product surfaces change independently of PiLink. The connection and
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
