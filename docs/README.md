# PiLink documentation

PiLink documentation is organized by task. Start with the user journey that
matches what you are trying to connect; use operator and developer material only
when you need those controls.

## Start by goal

| Goal | Start here |
| --- | --- |
| Install PiLink or PiLink for VS Code | [Installation](INSTALLATION.md) |
| Use the safe VS Code launcher | [Getting started](GETTING_STARTED.md) |
| Connect a compatible ChatGPT Work plugin | [Connect ChatGPT Work](CONNECT_CHATGPT.md) |
| Understand VS Code states and recovery | [PiLink for VS Code](VSCODE_EXTENSION.md) |
| Use ChatGPT as a local model provider | [ChatGPT LLM Gateway](operations/llm-gateway.md) |
| Diagnose a failure | [Troubleshooting](TROUBLESHOOTING.md) |

Remote ChatGPT use requires a reachable HTTPS origin and a ChatGPT
account/workspace where the intended PiLink plugin is available or permitted to
be created/imported. PiLink cannot grant that SaaS capability. The normal VS Code
path is Single agent with Project-folder access.

## User guides

- [Installation](INSTALLATION.md) — source/release install, runtime requirements,
  VS Code installation, Remote SSH, and upgrades.
- [Getting started](GETTING_STARTED.md) — shortest safe VS Code path.
- [Connect ChatGPT Work](CONNECT_CHATGPT.md) — plugin availability, owner
  verification, OAuth, connection states, and first read-only task.
- [PiLink for VS Code](VSCODE_EXTENSION.md) — launcher state model and recovery.
- [Troubleshooting](TROUBLESHOOTING.md) — symptom-first diagnostics.
- [Usage, models, and costs](USAGE_AND_COSTS.md) — provider/model cost context.

The [illustrated setup](ILLUSTRATED_GUIDE.md) is a visual reference and includes
older sanitized UI illustrations; prefer the current button names in the guides
above when they differ.

## Operator and security reference

- [Security model](SECURITY_MODEL.md)
- [Architecture](ARCHITECTURE.md)
- [Runtime mode selection](operations/mode-selection.md)
- [ChatGPT LLM Gateway](operations/llm-gateway.md)
- [Computer Use preview](operations/computer-use.md)
- [CLI operations](operations/getting-started.md)
- [Source CLI workflow and launcher recovery](operations/source-cli.md)
- [Experimental KDE/Wayland browser-focus work](operations/background-wake-experiment.md)

The gateway is a specialist path: its `stream: true` behavior is buffered SSE,
caller-advertised tools execute in the caller harness, and optional browser wake
requires explicit browser approval. Windows wake confirmation is intentionally
stricter than Linux passive detection.

## Developer and maintenance reference

These pages document implementation, review, release, or future-work context;
they are not onboarding steps:

- [Gateway implementation](operations/gateway-implementation.md)
- [Gateway UX review](operations/gateway-ux-review.md)
- [UX next-iteration implementation](operations/ux-next-iteration-implementation.md)
- [UX next-iteration proposal](operations/ux-next-iteration-proposal.md)
- [Release operations](operations/releasing.md)

Current code, tests, and explicit local policy take precedence over prose. A
README, chat message, task, role label, or model response never grants runtime
authorization.
