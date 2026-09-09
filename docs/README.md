# PiLink documentation

This directory contains the public user and operator documentation shipped with
PiLink. Internal agent prompts, research notes, evaluation plans, review
records, and historical integration ledgers are intentionally excluded from
the public repository and release packages.

## Launch modes overview

PiLink provides three CLI launch experiences, ordered by workflow:

1. **Single agent (`pilink start --mode single`)**:
   Classic single-agent project bridge. Exposes workspace-scoped project tools (read, search, edit, write, safe Git inspection) to a single MCP client under a project-folder boundary without public collaboration services.
2. **Agents chat (`pilink start --mode collaboration`)**:
   Collaborative multi-agent orchestration. Enables verified multi-agent chat (`pilink chat`), durable tasks, shared memory, and supervised-agent workflows.
3. **CLI pilink-endpoint (`pilink start --mode cli`)**:
   Launches the ChatGPT gateway provider (`pilink-endpoint`), exposing a local OpenAI-compatible endpoint (`http://127.0.0.1:3210/v1`) with native tool calling backed by a ChatGPT session. Existing dedicated gateway subcommands (`pilink gateway start`, `serve`, `connect`, `status`, `release`) remain available. See the [ChatGPT LLM Gateway guide](operations/llm-gateway.md).

PiLink for VS Code is installed separately with `pilink install-vscode-plugin`; it is not a launch mode.

## Start here

| Goal | Guide |
| --- | --- |
| Install PiLink or the optional VS Code extension | [Installation](INSTALLATION.md) |
| Start through the simplified VS Code launcher | [Getting started](GETTING_STARTED.md) |
| Understand how the VS Code extension works | [PiLink VS Code extension](VSCODE_EXTENSION.md) |
| Connect ChatGPT Work | [Connect ChatGPT Work](CONNECT_CHATGPT.md) |
| Use ChatGPT as a local OpenAI-compatible model provider with tool calling | [ChatGPT LLM Gateway](operations/llm-gateway.md) |
| Understand runtime modes and launch surfaces | [Runtime mode selection](operations/mode-selection.md) |
| Run/develop from source or repair the `pilink` launcher | [Source CLI workflow](operations/source-cli.md) |
| Diagnose a problem | [Troubleshooting](TROUBLESHOOTING.md) |

## Public guides

- [Architecture](ARCHITECTURE.md)
- [Connect ChatGPT Work](CONNECT_CHATGPT.md)
- [Getting started](GETTING_STARTED.md)
- [Illustrated extension setup](ILLUSTRATED_GUIDE.md)
- [Installation](INSTALLATION.md)
- [Security model](SECURITY_MODEL.md)
- [ChatGPT LLM Gateway](operations/llm-gateway.md)
- [Source CLI workflow and launcher recovery](operations/source-cli.md)
- [Troubleshooting](TROUBLESHOOTING.md)
- [Usage, models, and costs](USAGE_AND_COSTS.md)
- [VS Code extension](VSCODE_EXTENSION.md)
- [Getting started (CLI operations)](operations/getting-started.md)
- [Runtime mode selection](operations/mode-selection.md)
- [Release operations](operations/releasing.md)

Current code, tests, and explicit local policy take precedence over prose. A
README, chat message, task, role label, or model response never grants runtime
authorization.
