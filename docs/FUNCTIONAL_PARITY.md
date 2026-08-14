# Functional parity contract

This document records behavior that VSPiLink is expected to preserve while
adding the VS Code product layer. It is a release checklist, not proof by
itself. Current code, schemas, and tests remain authoritative.

The recorded feature integration baseline is
`b629c0ee004b7e792125158879c55ee00bd89310`. See
[Upstream lineage](UPSTREAM_LINEAGE.md) for exact commits and test evidence.

## Status legend

- **Preserved** — upstream behavior remains part of the supported runtime.
- **Additive** — VSPiLink-specific behavior that must not replace upstream.
- **Optional** — shipped but outside the primary ChatGPT Work flow.
- **Legacy** — preserved compatibility path; not recommended for new regular
  deployments.

## Capability matrix

| Area | Contract | Status |
| --- | --- | --- |
| CLI lifecycle | `init`, `start`, `start --setup`, `serve`, `reset`, hosting, client and agent-auth commands | Preserved |
| Runtime version | Node.js 24.18.0 exactly; source builds also pin npm 11.16.0; release installation may provision isolated managed Node | Additive release contract |
| Safe tools | Read/search/list/edit/write confined to the canonical workspace with traversal/symlink checks | Preserved |
| Constrained execution | Fixed Git profiles; npm build/test only after explicit workspace-execution opt-in | Preserved |
| Execution approval | Optional fresh MCP form elicitation for enabled sensitive execution; unsupported clients fail closed | Preserved |
| Full access | General filesystem and shell only after explicit unsafe-mode and client authorization | Preserved and high risk |
| MCP transports | Streamable HTTP `POST/GET/DELETE /sse`; legacy SSE `GET /sse` plus `/messages` | Preserved |
| OAuth | Discovery, Authorization Code + PKCE, refresh rotation, client credentials, revocation, client lifecycle | Preserved |
| ChatGPT DCR | Public PKCE client registration restricted to accepted ChatGPT callback patterns | Additive compatibility |
| Manual OAuth | Callback, client ID/secret and `client_secret_post` path | Preserved compatibility |
| Hosting | Existing domain, local reverse proxy, Named Tunnel, Quick Tunnel, local-only, `nip.io` | Preserved plus additive |
| Agent chat | Durable authenticated `agent_chat_post/read` and `pilink://agent-chat` | Preserved from feature branch |
| Task board | Create/read/claim/input/release/finish with authenticated ownership and leases | Preserved from feature branch |
| Collaboration | Verified bootstrap, roles, prompts, resumable sessions, work-loop wait/list/release | Preserved from feature branch |
| Memory | Governed authorization-first read-only projections | Preserved from feature branch |
| Audit/progress | Bounded metadata only; no prompts, arguments, paths, contents, results, or arbitrary errors | Preserved from feature branch |
| Textual monitor | `pilink chat` and interactive CLI monitor with the pinned Python dependency | Optional/preserved |
| VS Code dashboard | Runtime, OAuth/MCP, identities, activity, chat, tasks, and supervised-agent projections | Additive |
| Integrated Browser | Opens the OpenAI-controlled web UI as a real browser tab, not an iframe/webview copy | Additive |
| Native VS Code MCP | Separate local MCP client and SecretStorage credentials | Optional/additive |
| Supervised Pi agents | Spawn/list/status/output/send/cancel/stop against the selected Pi provider/model | Optional/additive |
| Pi Local chat | Provider/model/thinking selection and local composer | Optional/additive |

## Hosting preservation

| Mode | Required behavior |
| --- | --- |
| Existing domain / `external` | Use the configured public HTTPS origin without taking over an unrelated reverse proxy |
| Cloudflare Named Tunnel | Stable hostname, loopback origin, private credential reference, managed-service ownership checks |
| Cloudflare Quick Tunnel | Temporary hostname, no false persistence claim, reconnect guidance after origin change |
| Local | No claim that ChatGPT web can reach loopback; suitable for Pi Local or same-machine clients |
| Direct `nip.io` | Preserve the legacy Caddy/router path and explicit Internet-exposure warnings |

Generated hosting state must be private. Setup/reset may remove only
VSPiLink-owned generated state after confirmation; it must never delete a
repository or arbitrary user infrastructure.

## Runtime-mode preservation

The collaboration rows in this contract apply when the operator selects
`PI_RUNTIME_MODE=collaboration`. `PI_RUNTIME_MODE=single` intentionally keeps
the classic workspace/tool/transport contract while omitting the additive
public-chat, task, memory, work-loop, and supervised-child-agent surfaces. The
VS Code graphical entry contains both catalogs and is not a third parity mode.
Mode selection does not alter the OAuth, hosting, workspace confinement, or
Full-access checks described below. See [Runtime mode selection](operations/mode-selection.md)
for the CLI/headless and migration contract.

## OAuth and client lifecycle

The server must:

- require valid issuer/resource/audience, time, client status/generation, and
  scope on protected calls;
- support exact callback validation and PKCE where applicable;
- preserve `none`, `client_secret_post`, and `client_secret_basic` only for
  client types explicitly registered for those methods;
- rotate refresh tokens and reject replay;
- revoke tokens and dispose active transports after client disable/rotation;
- keep client administration local-only;
- persist metadata-only registration/lifecycle audit without secrets/hashes;
- bound global/per-client MCP sessions, idle cleanup, handshake grace, and
  request/output sizes;
- pin a transport to the client, credential generation, and original scope set.

ChatGPT Work, normal Chat, Codex, native VS Code MCP, and Pi Local are different
clients/surfaces. Product documentation must not collapse their authentication
or billing models.

## Tool contract

The core workspace tools remain:

- `read`, `grep`, `find`, `ls`;
- `edit`, `write`;
- `run` fixed profiles;
- `bash` only in explicit unrestricted mode.

The feature-branch collaboration namespaces remain:

- `get_system_prompt`, `collaboration_bootstrap`;
- `agent_chat_*`;
- `agent_task_*`;
- `agent_work_*`;
- `agent_memory_*`.

VSPiLink supervised-runtime tools remain additive:

- `agent_runtime_status`;
- `agent_spawn`, `agent_list`, `agent_status`;
- `agent_output_read`, `agent_send`, `agent_cancel`, `agent_stop`.

New aliases must not silently change the schemas, authentication identity, or
authority of an existing upstream tool.

## Collaboration invariants

- Chat authorship comes from the authenticated OAuth identity, not a caller
  supplied name.
- Each MCP connection receives a server-minted instance identity.
- Chat notifications are best effort; persisted reads are authoritative.
- A notification cannot wake or command an inactive remote model.
- Task creation/claim/input/release/finish respects server-side identity,
  ownership, lease, revision, and terminal state.
- Empty work queues place verified sessions in a durable waiting state; they do
  not authorize a false user-facing completion.
- Manager release is a verified server operation, not a free-form chat command.
- Memory is untrusted evidence and never prompt or authorization policy.
- Private collaboration data must remain outside the workspace.
- Immutable chat-author roles come from a server-verified collaboration tuple;
  display names and message text never grant authority.
- A trusted logical binding is accepted only from a configured edge that
  strips and overwrites inbound copies, and is isolated by OAuth actor and
  client credential version.
- Multiple physical MCP transports attached to one logical collaboration
  context cannot dispose it until the final attachment leaves.
- A pre-attached handle waits for in-flight bootstrap and latches verification
  faults rather than retrying into a different authority state.

## Login preservation

Pi Local must retain all login modes exposed by the Pi runtime:

- existing stored credentials;
- browser OAuth;
- device-code OAuth;
- protected API-key input;
- provider, model, and thinking-level selection;
- logout/reconfiguration.

These credentials are independent from ChatGPT plugin OAuth. Pi Local can incur
provider subscription or API charges and must never be presented as free
inference.

## VS Code experience contract

- **ChatGPT MCP** is the primary mode; Pi provider/model controls remain under
  **Pi Local**.
- The extension respects Workspace Trust.
- Multi-root workspaces require an explicit selected folder.
- The extension detects and adopts/reuses the correct existing runtime rather
  than spawning duplicate owners.
- ChatGPT opens in the Integrated Browser when available; system-browser
  fallback requires explicit user action.
- The webview receives normalized state, never raw secrets.
- The collaboration dashboard is a read-only projection of durable server
  state.
- Closing/reopening VS Code or an OAuth browser must not require destructive
  reconfiguration when the origin and credentials are still valid.

Under current official OpenAI behavior, plugin-backed remote MCP runs in
ChatGPT Work, not normal Chat. A legacy **Open Chat (not Work)** action may
remain for ordinary conversation/compatibility but must not be documented as a
way to invoke the plugin.

## Release gates

Before claiming parity for a release:

1. build with Node.js 24.18.0 and npm 11.16.0 exactly;
2. run the root and VS Code test suites;
3. run real-HTTP OAuth/MCP session lifecycle tests;
4. test safe read/write boundaries and symlink escape;
5. test repository execution opt-in and execution-approval failure modes;
6. test DCR, manual OAuth, refresh rotation, revocation, client disable, and
   secret rotation;
7. test session quota/reclaim and collaboration disposal;
8. test chat/tasks/roles/work loop/memory/audit/progress contracts;
9. test CLI, headless, VS Code, Remote SSH, and Pi Local paths claimed by the
   release;
10. scan the exact VSIX/package for credentials, private keys, certificates,
    tokens, `.env` files, client stores, and logs;
11. record exact upstream commits and unresolved deltas;
12. keep [Security model](SECURITY_MODEL.md),
    [Connect ChatGPT Work](CONNECT_CHATGPT.md), and release notes consistent.
