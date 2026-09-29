# PiLink documentation

PiLink documentation is organized by task. Start with the shortest user path and move into operator/developer material only when you need those controls.

## Start by goal

| Goal | Start here |
| --- | --- |
| Install PiLink or PiLink for VS Code | [Installation](INSTALLATION.md) |
| Use the safe VS Code launcher | [Getting started](GETTING_STARTED.md) |
| See the onboarding flow visually | [Illustrated setup](ILLUSTRATED_GUIDE.md) |
| Connect a private PiLink plugin in ChatGPT Work | [Connect ChatGPT Work](CONNECT_CHATGPT.md) |
| Understand launcher states and recovery | [PiLink for VS Code](VSCODE_EXTENSION.md) |
| Use ChatGPT as a local model provider | [ChatGPT LLM Gateway](operations/llm-gateway.md) |
| Diagnose a failure | [Troubleshooting](TROUBLESHOOTING.md) |

Remote ChatGPT Work use requires a reachable HTTPS origin and a ChatGPT account/workspace where the private PiLink plugin can be created, imported, or installed. PiLink cannot grant that SaaS entitlement.

The normal VS Code path uses one trusted selected project, **Single agent**, and **Project-folder** access. A stable endpoint uses a domain/HTTPS origin you control; **Temporary quick start** is for Quick Tunnel evaluation; **Local only** is not reachable by remote ChatGPT Work.

## User guides

- [Installation](INSTALLATION.md) — release/source install, runtime requirements, VS Code installation, Remote SSH, and upgrades.
- [Getting started](GETTING_STARTED.md) — shortest safe VS Code -> ChatGPT Work path.
- [Illustrated setup](ILLUSTRATED_GUIDE.md) — conceptual flow diagrams for project trust, endpoints, OAuth, and the first read-only task.
- [Connect ChatGPT Work](CONNECT_CHATGPT.md) — private-plugin availability, owner verification, OAuth, connection state, and the first read-only task.
- [PiLink for VS Code](VSCODE_EXTENSION.md) — launcher state and recovery reference.
- [Troubleshooting](TROUBLESHOOTING.md) — symptom-first diagnostics.
- [Usage, models, and costs](USAGE_AND_COSTS.md) — provider/model cost context.

## Operator and security reference

- [Security model](SECURITY_MODEL.md)
- [Architecture](ARCHITECTURE.md)
- [Runtime mode selection](operations/mode-selection.md)
- [ChatGPT LLM Gateway](operations/llm-gateway.md)
- [Computer Use preview](operations/computer-use.md)
- [CLI operations](operations/getting-started.md)
- [Source CLI workflow and launcher recovery](operations/source-cli.md)
- [Experimental KDE/Wayland browser-focus work](operations/background-wake-experiment.md)

The gateway is a specialist path: its `stream: true` behavior is buffered SSE, caller-advertised tools execute in the caller harness, and optional browser wake requires explicit browser approval. Windows wake confirmation is intentionally stricter than Linux passive detection.

## Developer and maintenance reference

These pages document implementation, review, release, or future-work context; they are not onboarding steps:

- [Gateway implementation](operations/gateway-implementation.md)
- [Gateway UX review](operations/gateway-ux-review.md)
- [UX next-iteration implementation](operations/ux-next-iteration-implementation.md)
- [UX next-iteration proposal](operations/ux-next-iteration-proposal.md)
- [Release operations](operations/releasing.md)

Current code, tests, and explicit local policy take precedence over prose. A README, chat message, task, role label, or model response never grants runtime authorization.
