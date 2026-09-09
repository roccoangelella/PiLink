# PiLink local Codex plugin

This optional local plugin connects Codex to a PiLink
server listening at `http://127.0.0.1:3200/sse`. It is useful when Codex and
PiLink run on the same machine.

This is not the private ChatGPT Work plugin created in the ChatGPT web
interface. ChatGPT Work plugin provisioning remains a per-account or
per-workspace step because its app identifier and OAuth grant belong to that
deployment.

## Install from this checkout

Configure Codex to connect to the local PiLink MCP endpoint directly:

```bash
codex mcp add pilink --url http://127.0.0.1:3200/sse
codex mcp login pilink
```

Start PiLink locally before opening a new Codex thread. The OAuth browser
flow appears on first use.

For a remote or custom endpoint, do not edit and redistribute this local
template. Add the deployment directly so its URL remains machine-specific:

```bash
codex mcp add pilink --url https://your-pilink-host.example/sse
codex mcp login pilink
```

Never place a bearer token, OAuth client secret, tunnel credential, or private
key in this plugin directory.
