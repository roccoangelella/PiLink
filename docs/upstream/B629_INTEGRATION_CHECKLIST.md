# PiLink `b629c0ee` integration checklist

This is the exact review ledger for the two upstream commits after VSPiLink's
recorded `0d0f8e…` feature baseline:

- [`f6d22d82b946c449ace10f4063e7e729cb7cf7f8`](https://github.com/roccoangelella/PiLink/commit/f6d22d82b946c449ace10f4063e7e729cb7cf7f8)
  — preserve collaboration context and chat role provenance;
- [`b629c0ee004b7e792125158879c55ee00bd89310`](https://github.com/roccoangelella/PiLink/commit/b629c0ee004b7e792125158879c55ee00bd89310)
  — synchronize pre-attached collaboration handles.

Counts below are Git's exact additions/deletions for the sequential upstream
patches. A checked item records either a verbatim final import or a completed
VSPiLink adaptation, as stated in its section. The completion evidence at the
end verifies the integrated callers and real HTTP behavior.

## Imported verbatim from final `b629c0ee`

- [x] `src/chat-provenance.ts` — final file, 206 lines added relative to the
  pre-`f6d22d82` tree; SHA-256
  `987d9a366ea2e45f804a1d7e73593eedbcdbc1f54494d9cbbd06c00237d1c877`.
- [x] `src/collaboration-context-registry.ts` — `f6d22d82` `+218/-0`, then
  `b629c0ee` `+87/-2`; final SHA-256
  `c2538e11edcc376bbe0c956f27c7e3b0285bf5175727f918a6f67aac38e9226b`.
- [x] `test/chat-provenance.test.mjs` — `+78/-0`; SHA-256
  `8f057d81062cfd31b4f5b8c76b31ff73a3eb0594599346f0dc65a76526fc4456`.
- [x] `test/collaboration-context-registry.test.mjs` — `f6d22d82`
  `+194/-0`, then `b629c0ee` `+101/-0`; final SHA-256
  `46068674d23ed43203a2fec95a7d8d059eb63d6757f75bb9ec117d764650a578`.
- [x] Authority-marked final protocol snapshots:
  [transport continuity](agent-work-loop-transport-continuity.md) and
  [chat author provenance](chat-author-provenance.md).

## Overlapping runtime changes adapted

- [x] `.env.example` (`f6d22d82` `+8/-0`): document the optional trusted
  `PI_COLLABORATION_BINDING_HEADER`, require the edge to strip/overwrite inbound
  copies and use one hidden stable value per logical conversation, and expose
  `PI_COLLABORATION_BINDING_DETACH_GRACE=600`.
- [x] `src/config.ts` (`f6d22d82` `+25/-0`): add
  `collaborationBindingHeader?` and
  `collaborationBindingDetachGraceSeconds`; parse the detach grace as a positive
  integer; normalize the configured header to lowercase; reject invalid header
  syntax and the reserved `authorization`, `mcp-session-id`,
  `mcp-protocol-version`, `cookie`, and `set-cookie` names.
- [x] `src/index.ts` (`f6d22d82` `+88/-3`): create one process-level
  `CollaborationContextRegistry`; derive its HMAC binding key from `JWT_SECRET`;
  bind entries to authenticated actor plus effective OAuth client version;
  validate the trusted header as single-occurrence, scalar, trimmed, non-empty,
  at most 512 UTF-8 bytes, and free of controls; attach both Streamable HTTP and
  legacy SSE sessions; disconnect the work-loop only on final logical disposal;
  call `disposeAll()` during shutdown. Requests with malformed trusted bindings
  must return OAuth-style HTTP 400 `invalid_request`.
- [x] `src/chat.ts` (`f6d22d82` `+75/-7`): migrate durable chat state from v2
  to v3; add immutable `authorRole` and optional `collaborationSessionId`; assign
  legacy v1/v2 records `legacy_unverified` without inferring privilege from
  names or prose; require a valid `cs_…` ID only for verified provenance; reject
  it for unverified provenance; enforce exact v3 state/message keys; copy frozen
  role snapshots on reads and writes.
- [x] `src/mcp.ts` (`f6d22d82` `+67/-7`, then `b629c0ee` `+66/-17`; combined
  final delta from the pre-fix tree `+131/-22`):
  - accept shared logical bootstrap handles and initialize connection state from
    `bootstrap.initialized`;
  - add optional `synchronizeSharedContext()` and
    `prepareSharedProjectAccess()` handle methods;
  - preserve and revalidate the immutable verified collaboration tuple on every
    role-gated operation;
  - serialize server-authored chat provenance in tool/resource responses and
    post verified snapshots only after server verification;
  - make `get_system_prompt` and its MCP prompt dynamically adopt context from
    a pre-attached handle, including waiting behind in-flight bootstrap;
  - prepare shared project access before tools, resource reads, and resource
    subscriptions so a pristine handle either adopts the shared context or
    atomically locks generic access;
  - latch immutable-tuple verification faults, detach the failed attachment
    exactly once, and never retry synchronization after the latch;
  - avoid marking a shared logical work-loop offline when only one physical
    handle closes;
  - continue returning fail-closed
    `COLLABORATION_CONTEXT_CONTINUITY_UNAVAILABLE` when neither native MCP
    session reuse nor a trusted logical binding is present.
- [x] `src/run.ts`: neither upstream commit changes this file.

The overlapping `src/*.ts` files were adapted rather than replaced because
VSPiLink already has additive product/runtime work in them. The checks above
record the completed behavioral merge.

## Overlapping Textual monitor changes adapted

All are from `f6d22d82`; `b629c0ee` does not change `chat-cli`.

- [x] `chat-cli/pilink_chat_cli/chat_view.py` (`+4/-6`): pass the whole message
  to role resolution and filter by structured role ID.
- [x] `chat-cli/pilink_chat_cli/data.py` (`+6/-1`): document/read chat state v3,
  `authorRole`, and optional `collaborationSessionId`.
- [x] `chat-cli/pilink_chat_cli/drawer.py` (`+5/-5`): resolve handoff badges
  from the structured message and fall back to generic Agent.
- [x] `chat-cli/pilink_chat_cli/theme.py` (`+93/-31`): remove role inference
  from message text and OAuth display names; validate the complete server-authored
  snapshot; map only canonical verified roles; degrade missing, legacy,
  malformed, or spoofed data to Agent.
- [x] `chat-cli/tests/test_tui_layout.py` (`+64/-2`): use v3 fixtures and prove
  that verified DEV renders as DEV while prose/name spoofing, malformed tuples,
  and snapshot-free legacy messages remain Agent.

## Overlapping test changes adapted

- [x] `test/chat.test.mjs` (`f6d22d82` `+77/-1`): assert v1/v2 migration to
  v3 `legacy_unverified`, no word-based role inference, and fail-closed tampered
  v3 provenance.
- [x] `test/mcp-chat.test.mjs` (`f6d22d82` `+148/-3`): add the upstream tests
  “verified parallel sessions snapshot immutable author roles without text
  inference” and “verified chat post fails closed when collaboration
  verification fails”, including structured tool/resource payload assertions.
- [x] `test/mcp-work-loop.test.mjs` (`f6d22d82` `+53/-5`, then `b629c0ee`
  `+272/-1`; combined final delta `+324/-5`): preserve shared-handle online
  state; test prompt waiting/adoption across concurrent bootstrap; prove a
  synchronization fault is latched and detached once; prove a pre-attached
  handle's first tool/resource/subscription call observes manager release.
- [x] `test/role-bootstrap-http.integration.test.mjs` (`f6d22d82` `+151/-2`,
  then `b629c0ee` `+49/-0`; combined final delta `+200/-2`): exercise real HTTP
  trusted-binding continuity, duplicate/invalid header rejection, actor/client
  isolation, unbound failure, cleanup, and the dormant pre-attached handle after
  manager release.
- [x] `test/session-limits.integration.test.mjs` (`f6d22d82` `+13/-0`): verify
  default/configured binding values, lowercase normalization, reserved-header
  rejection, and quota interaction.

## Overlapping documentation adapted

- [x] Adapt the two-row protocol index addition from upstream `docs/README.md`
  (`f6d22d82` `+2/-0`) to VSPiLink's documentation topology.
- [x] Adapt `docs/protocols/agent-work-loop.md` (`f6d22d82` `+15/-5`, then
  `b629c0ee` `+2/-2`) if VSPiLink adopts the trusted-binding adapter. It must
  distinguish native `Mcp-Session-Id` reuse from the optional hidden binding,
  explain final logical disposal, and include pre-attached-handle race coverage.

## Completion evidence

The feature integration baseline advanced to `b629c0ee` on 2026-08-04 after
every item above was imported or adapted and the following focused evidence
passed:

```bash
npm run build
node --test \
  test/chat-provenance.test.mjs \
  test/collaboration-context-registry.test.mjs \
  test/chat.test.mjs \
  test/mcp-chat.test.mjs \
  test/mcp-work-loop.test.mjs \
  test/role-bootstrap-http.integration.test.mjs \
  test/session-limits.integration.test.mjs
```

Result: **46 passed, 0 failed**. This includes real HTTP trusted-header
validation, actor/client/generation isolation, malformed and duplicate binding
rejection, manager-release blocking, pre-attached-handle synchronization,
shared logical attachment disposal, and session quota/cleanup behavior.

The optional Textual provenance/layout set was run with its documented pinned
dependency in an isolated Python import directory:

```bash
PYTHONPATH="<textual-0.51.x-target>:./chat-cli" \
  python3 -m unittest discover -s chat-cli/tests -p 'test_tui_layout.py'
```

Result: **6 passed, 0 failed** with `textual>=0.51,<0.52`.

This closes the pinned feature-integration delta. The full product release
still requires every gate in [Functional parity](../FUNCTIONAL_PARITY.md),
including the complete root and VS Code suites, artifact scans, packaging, and
manual UI/Remote SSH checks. A later upstream commit requires a new ledger.
