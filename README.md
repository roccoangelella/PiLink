# PiLink

<p align="center">
  <img src="docs/assets/brand/pilink-lockup.svg" width="560" alt="PiLink">
</p>

PiLink is a self-hosted, OAuth-protected MCP bridge that gives authorized AI
clients controlled access to a project you choose. The normal path is
**project-scoped by default**; broader execution and Full machine access require
separate operator decisions.

PiLink is an independent open-source project. It is not affiliated with or
endorsed by OpenAI, Microsoft, or Cloudflare.

## Choose your route

PiLink has three distinct workflows. Pick the one that matches where you want
the model and tools to run.

### 1. VS Code MCP bridge → ChatGPT Work

Use this when you want a small graphical launcher for a selected project and a
remote ChatGPT client.

**Prerequisites**

- VS Code 1.106 or newer and a trusted project folder.
- The PiLink sidecar runtime. Release installers can provision the required
  Node.js runtime; source builds require Node.js **24.18.0 exactly** and npm
  **11.16.0 exactly**.
- A reachable HTTPS origin for remote use. A temporary Quick Tunnel is available
  for evaluation; stable use needs a Cloudflare fixed domain or an HTTPS reverse
  proxy you operate.
- A ChatGPT account/workspace where the intended private PiLink plugin is already
  available, or where permitted plugin creation/import controls exist. PiLink
  cannot grant that account/workspace capability.

Install or update the extension, then open **PiLink** from the Activity Bar:

```bash
pilink install-vscode-plugin
```

The graphical setup always uses **Single agent + Project-folder access**. When
the endpoint is healthy, select **Connect ChatGPT**, complete local owner
verification and OAuth, then begin with a read-only task that confirms the
project boundary.

See [Getting started](docs/GETTING_STARTED.md),
[PiLink for VS Code](docs/VSCODE_EXTENSION.md), and
[Connect ChatGPT Work](docs/CONNECT_CHATGPT.md).

### 2. CLI MCP bridge

Use this when you do not need the VS Code launcher. Start the project-scoped
single-agent bridge directly:

```bash
pilink start --mode single
```

For remote MCP clients, configure a reachable HTTPS origin. For a local server
behind an existing reverse proxy, use:

```bash
pilink serve --mode single
```

Collaboration is an explicit operator workflow, not part of the default bridge:

```bash
pilink start --mode collaboration
```

See [Installation](docs/INSTALLATION.md),
[Runtime mode selection](docs/operations/mode-selection.md), and the
[Security model](docs/SECURITY_MODEL.md).

### 3. Local ChatGPT LLM Gateway

Use this when a local coding agent should receive model responses from a
connected ChatGPT conversation through a loopback OpenAI-compatible API.

```bash
pilink gateway start
# equivalent launch surface:
pilink start --mode cli

# after setup, launch Pi Agent in the current project:
pilink-cli
```

The gateway requires a compatible ChatGPT MCP connection, OAuth/Dynamic Client
Registration support, and an active worker conversation. The local API normally
binds to `127.0.0.1:3210` and requires its bearer key.

Important limits:

- `stream: true` is **buffered SSE**: PiLink receives the complete ChatGPT result
  before emitting OpenAI-style stream events. It is not token streaming.
- Tool calls are returned to the local caller harness; **PiLink does not execute
  caller-advertised tools**. The harness executes them with its own permissions.
- Common generation controls such as `temperature`, `top_p`,
  `max_completion_tokens`, and `store` are accepted only for compatibility and
  are ignored there; strict mode rejects unsupported controls.
- Browser auto-wake is optional and requires one-time extension approval. On
  Linux, PiLink may enable wake after detecting the approved Chromium extension.
  On Windows, passive profile detection is not trusted: verify the extension in
  the browser/profile reached by a normal HTTPS link and explicitly confirm it;
  headless setup requires manual verification before
  `pilink gateway browser-extension --enable`.

See [ChatGPT LLM Gateway](docs/operations/llm-gateway.md) for the full protocol,
wake, retry, and security contract.

## Install from source

```bash
git clone https://github.com/roccoangelella/PiLink.git
cd PiLink
node --version   # v24.18.0
npm --version    # 11.16.0
npm ci
npm run build
```

`npm run build` compiles PiLink and may create or repair a PiLink-owned launcher
in an existing user-writable directory already on `PATH`. It never uses `sudo`,
edits shell startup files, or replaces an unrelated command. If no safe launcher
location exists, run:

```bash
npm run cli -- start
```

Private OAuth state, tunnel credentials, provider credentials, and PiLink data
must stay outside the project exposed to MCP clients.

## Security boundaries

Project-folder access is the baseline. Filesystem tools are confined to the
canonical selected project; repository execution is a separate opt-in. Public
MCP OAuth, local owner administration, and optional provider authentication are
separate trust boundaries.

### Full machine access

Full access removes the project boundary and enables process execution as the
PiLink OS user. It is remote code execution by design and is **not** part of the
normal VS Code workflow.

Use it only after reviewing the OAuth client and the
[Security model](docs/SECURITY_MODEL.md):

```bash
pilink clients list
PI_FULL_ACCESS_CLIENT_IDS=pi_your_client_id \
  pilink start --allow-unsafe-full-access
```

Compatibility shortcuts such as `pilink agents`, `pilink-agents`,
`pilink single-agents`, and `pilink-single-agent` enter Full-access workflows;
they are not synonyms for ordinary project-scoped mode selection.

## Hosting choices

| Choice | Intended use | URL behavior |
| --- | --- | --- |
| Cloudflare fixed domain | Regular remote use | Stable |
| Existing HTTPS domain | Operator-managed reverse proxy | Stable |
| Cloudflare Quick Tunnel | Evaluation | Changes when recreated |
| Local only | Same-machine clients | Not reachable by ChatGPT web |

A public URL is not authorization. Remote access still requires the configured
OAuth flow and the relevant client/plugin capability.

## Documentation

**Start here**

- [Documentation by task](docs/README.md)
- [Installation](docs/INSTALLATION.md)
- [Getting started](docs/GETTING_STARTED.md)
- [Connect ChatGPT Work](docs/CONNECT_CHATGPT.md)
- [PiLink for VS Code](docs/VSCODE_EXTENSION.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)

**Reference / operator**

- [Security model](docs/SECURITY_MODEL.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Runtime mode selection](docs/operations/mode-selection.md)
- [ChatGPT LLM Gateway](docs/operations/llm-gateway.md)
- [Usage, models, and costs](docs/USAGE_AND_COSTS.md)

## Development

```bash
npm ci
npm run dev          # compile/watch only
npm run dev:server   # run the raw development server
npm run test:all
npm run release:check
```

PiLink uses the [MIT License](LICENSE) and the
[`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
harness. Repository history and [NOTICE](NOTICE.md) retain attribution.
