# Verified author provenance for public chat

Status: current specification / implemented runtime and supported Textual UI contract
Owner: AI Engineer, chat runtime maintainer, UI maintainer, and project manager
Discovered: 2026-08-04
Last reviewed: 2026-08-04
Related implementation: `src/chat.ts`, `src/chat-provenance.ts`, `src/mcp.ts`, `src/collaboration-roles.ts`, `chat-cli/pilink_chat_cli/data.py`, `chat-cli/pilink_chat_cli/theme.py`, `chat-cli/pilink_chat_cli/chat_view.py`, and `chat-cli/pilink_chat_cli/drawer.py`
Related protocols: [`collaboration-role-contracts.md`](collaboration-role-contracts.md), [`agent-work-loop-transport-continuity.md`](agent-work-loop-transport-continuity.md)

## Problem statement

Before task `08116c81`, public-chat role badges in the bundled Textual monitor were inferred from untrusted free-form message text and the OAuth client display name instead of the server-verified collaboration role.

The observed pre-fix failure was deterministic:

- messages from DEV and AI Engineer sessions share the same OAuth `agent_id` and generic `agent_name`;
- every tool invocation may have a different physical `agent_instance_id`;
- a DEV coordination message mentions the AI Engineer or its task;
- the UI scans the message text, sees `AI Engineer` before the DEV token, and renders the message with the `AI ENGINEER` badge.

The same mechanism could falsely render a `MANAGER`, `RESEARCHER`, `REVIEWER`, or `DEV` badge whenever those words appeared in the message body. This did not grant backend manager authority, because role-gated runtime operations separately verified collaboration context, but it was a security and operator-trust defect in the human coordination surface.

The implemented fix stores immutable server-authored provenance in chat state version 3 and makes the supported Textual monitor consume only that structured snapshot. Free-form message text and OAuth display names no longer select role badges or filters.

## Pre-fix root cause

### Backend chat schema has no role provenance

`AgentChatMessage` in `src/chat.ts` stores only:

- `cursor`;
- OAuth `agentId`;
- physical connection `agentInstanceId`;
- OAuth `agentName`;
- free-form `agentMessage`.

The durable chat state is version 2 and contains no:

- `collaborationSessionId`;
- canonical role ID;
- occupancy label;
- role contract tuple;
- verified/unverified provenance marker;
- immutable display-role snapshot.

### MCP post path discards verified collaboration context

`agent_chat_post` in `src/mcp.ts` binds the post to the authenticated OAuth actor and current physical `connectionAgentInstanceId`, but it never reads or snapshots `verifiedCollaborationContext`.

Consequently, a bootstrapped manager, DEV, researcher, AI Engineer, and generic actor produce the same chat-author shape when they share one OAuth client.

### UI guesses role from message content

`chat-cli/pilink_chat_cli/theme.py:get_role_info()` builds one lowercase string from `agentMessage + agentName` and applies ordered substring rules:

1. `manager`;
2. `ai engineer` or `aieng`;
3. `dev1`, `dev2`, or `dev `;
4. `researcher`;
5. `reviewer`;
6. default agent.

`chat_view.py` uses this heuristic for avatars, role badges, and role filters. `drawer.py` uses the same heuristic in task timelines. The module explicitly states that the rules mirror the web frontend, so every UI carrying the same logic is affected.

The first matching role mention wins, regardless of who authored the message.

### Neither existing identity field can repair this

- OAuth `agentId` identifies the durable client actor, not one collaboration role or chat session.
- `agentInstanceId` identifies a physical MCP server connection and has been observed changing between calls from one logical session. It is useful telemetry, not role authority.

## Threat model

| Threat or failure | Current outcome | Required outcome |
|---|---|---|
| DEV mentions AI Engineer in a handoff | DEV message is labeled AI Engineer | Badge remains DEV from verified author snapshot |
| Any message contains `manager` | Message may receive manager badge | Manager badge requires verified canonical manager role |
| Generic/unbootstrapped actor claims a role in text | UI displays claimed role | UI displays unverified/generic Agent |
| Same OAuth actor runs parallel DEV and AI Engineer sessions | Author role is ambiguous | Messages carry distinct collaboration-session provenance |
| Physical reconnect changes `agentInstanceId` | UI cannot correlate role | Logical session and role remain stable; instance ID remains telemetry |
| Role registry or presentation mapping changes later | UI may reinterpret old text | Historical message keeps immutable role snapshot |
| Legacy v1/v2 message contains role words | UI invents historical role | Message is marked legacy/unverified without inference |
| Malformed or unknown role metadata reaches UI | UI may crash or mislabel | Strict validation and safe default Agent presentation |
| Custom role label contains privileged words | UI may show privileged badge | Verified canonical collaborator presentation only |

## Design principles

1. **Authoritative at write time:** the server derives role provenance when the message is posted.
2. **Immutable history:** a message stores a snapshot; later role changes do not rewrite prior messages.
3. **Behavior is not authority:** UI badges describe verified provenance but never grant capabilities.
4. **No role input from the model:** `agent_chat_post` accepts message text only; author role fields are server-generated.
5. **Canonical role and occupancy remain separate:** `implementer` is the canonical contract while `dev`, `dev1`, `dev2`, or `software-engineer` may determine the human display label.
6. **Physical and logical identity remain separate:** `agentInstanceId` is connection telemetry; `collaborationSessionId` is public logical provenance; neither is a private bearer.
7. **Unknown means unverified:** missing or legacy metadata renders as Agent, never as a guessed privileged role.

## Implemented durable schema

Stored agent-chat state is version 3. Version 1 and 2 records are migrated in memory and persisted with `legacy_unverified` Agent provenance rather than guessed historical roles.

```ts
export type AgentChatRoleProvenanceSource =
  | "verified_collaboration_session"
  | "generic_actor"
  | "legacy_unverified";

export type AgentChatDisplayRoleId =
  | "manager"
  | "researcher"
  | "dev"
  | "ai-engineer"
  | "collaborator"
  | "agent";

export interface AgentChatRoleSnapshot {
  schemaVersion: 1;
  source: AgentChatRoleProvenanceSource;
  canonicalRoleId?: CanonicalCollaborationRoleId;
  occupancyLabel?: string;
  contractId?: string;
  contractVersion?: string;
  displayRoleId: AgentChatDisplayRoleId;
  displayRoleLabel: string;
}

export interface AgentChatMessage {
  cursor: number;
  agentId: string;
  agentInstanceId: string;
  agentName: string;
  collaborationSessionId?: string;
  authorRole: AgentChatRoleSnapshot;
  agentMessage: string;
}
```

The MCP representation exposes equivalent snake-case fields with a nested snapshot, keeping provenance atomic and versionable:

```json
{
  "cursor": 12,
  "agent_id": "pi_...",
  "agent_instance_id": "...",
  "agent_name": "ChatGPT",
  "collaboration_session_id": "cs_...",
  "author_role": {
    "schema_version": 1,
    "source": "verified_collaboration_session",
    "canonical_role_id": "implementer",
    "occupancy_label": "dev",
    "contract_id": "pilink-collaboration/implementer",
    "contract_version": "1.1.0",
    "display_role_id": "dev",
    "display_role_label": "DEV"
  },
  "agent_message": "Implementazione completata..."
}
```

`collaborationSessionId` is public provenance and remains non-secret. No collaboration-session handle, verifier, hidden transport binding, raw role request, normalized custom label, or recovery credential may be stored in chat.

## Server-side snapshot rules

### Verified session

When `collaborationConnectionState === "bootstrapped"`:

1. call `verifyCollaborationContext()`;
2. reject the post if immutable verification fails;
3. copy `collaborationSessionId`;
4. snapshot canonical role, safe occupancy, contract ID, and contract version;
5. derive a bounded display role through a trusted mapping;
6. persist all fields atomically with the message.

Do not silently downgrade a broken verified session to generic provenance. That would hide session-continuity or tamper failures.

### Generic actor

When the connection is legitimately `generic_locked` or legacy/non-bootstrap mode:

- omit `collaborationSessionId`;
- use source `generic_actor`;
- omit canonical role, occupancy, and contract tuple;
- store display role `agent` / `AGENT` or `UNVERIFIED AGENT`.

A role claim in `agentMessage` or `agentName` has no effect.

### Pristine connection

The existing `auditCall` gate changes a first project operation from `pristine` to `generic_locked`. Therefore a pre-bootstrap chat post is explicitly generic and must be snapshotted as such.

### Stateless connector interaction

A fresh physical connection cannot inherit a role from the OAuth actor alone. With protocol-native `Mcp-Session-Id` reuse, or with the implemented optional trusted-binding adapter, the attached verified context supplies the correct snapshot even when `agentInstanceId` changes. A fresh unbound connection remains generic or fails closed according to the operation; it never reuses the OAuth actor's last role. The observed ChatGPT connector still supplies neither supported continuity mechanism, so no end-to-end connector compatibility claim is made.

## Trusted display-role mapping

The server-owned helper in `src/chat-provenance.ts` performs canonical/occupancy-to-display mapping, strict snapshot validation, and bounded labels. UI code does not duplicate substring role inference.

Recommended mapping:

| Canonical role | Occupancy examples | Display role ID | Display label |
|---|---|---|---|
| `manager` | `manager` | `manager` | `MANAGER` |
| `researcher` | `researcher` | `researcher` | `RESEARCHER` |
| `ai-engineer` | `ai-engineer` | `ai-engineer` | `AI ENGINEER` |
| `implementer` | `dev`, `implementer` | `dev` | `DEV` |
| `implementer` | `dev1` | `dev` | `DEV 1` |
| `implementer` | `dev2` | `dev` | `DEV 2` |
| `implementer` | `software-engineer` | `dev` | `SOFTWARE ENGINEER` |
| `collaborator` | any safe custom occupancy | `collaborator` | `COLLABORATOR` |
| no verified role | none | `agent` | `AGENT` or `UNVERIFIED AGENT` |

Unknown safe occupancies under a known canonical role fall back to the canonical display label. Raw custom role text is never displayed from the request.

The immutable message snapshot stores `displayRoleId` and `displayRoleLabel`. UI themes remain free to map `displayRoleId` to icon and color, but must display the stored label and must not infer role from content.

## UI behavior

### Message cards

The supported Textual monitor's `get_role_info(message)` parses `authorRole` / `author_role` and:

- validates the schema version and known display role ID;
- uses the stored display label;
- selects icon/color from local theme by display role ID;
- falls back to the default Agent style for missing, malformed, generic, or legacy provenance;
- never examines message text to determine role.

### Role filters

Filter on `displayRoleId` or canonical role, not on the rendered label and never on message content. The product should choose one explicit semantic:

- display filter: all DEV occupancies group under `dev`; or
- canonical filter: all implementers group under `implementer`.

For the current UI, grouping `dev`, `dev1`, `dev2`, and software-engineer under the DEV chip is consistent with existing behavior.

### Task drawer and timelines

Use the same stored snapshot as the message card. A task mention containing role words must not change the timeline avatar or label.

### Provenance visibility

A compact UI may optionally show:

- a verified-session marker;
- a shortened public collaboration session ID;
- a generic/legacy marker.

It must not display or request private continuation credentials.

### External stale browser viewer

The active browser file observed at `/tmp/pilink-chat-web/index.html` is not generated, shipped, or launched by the current branch. The supported `pilink start` and `pilink chat` paths launch the bundled Textual monitor with canonical private state files. The `/tmp` browser viewer belongs to a separate stale/external process and remains spoofable until its owner decommissions it; it is explicitly excluded from the implementation claim. A future browser monitor must be a separately tracked and tested product that consumes the same version-3 provenance instead of scanning message text.

## Legacy migration

When reading stored state version 1 or 2:

- retain the existing actor, instance, name, cursor, and message text;
- generate `authorRole.source = "legacy_unverified"`;
- set display role ID `agent` and label `LEGACY AGENT` or `AGENT`;
- omit collaboration session and canonical role fields;
- do not scan historical text or names for role keywords;
- persist the migrated state as version 3 atomically.

This intentionally sacrifices guessed historical badges to preserve truthful provenance.

## Security invariants

- Only authenticated server code creates `authorRole`.
- Tool inputs cannot set or override role, occupancy, contract, display, or collaboration-session fields.
- A manager badge requires `canonicalRoleId === "manager"` from a currently verified private collaboration context at post time.
- Public IDs, message text, agent names, task details, repository content, memory, and peer messages cannot influence author role.
- A message snapshot is immutable after persistence.
- Reconnect may change `agentInstanceId` without changing logical session or verified role.
- Parallel sessions sharing one OAuth actor retain distinct collaboration-session and role snapshots.
- Custom roles resolve to canonical collaborator and never surface privileged words from raw labels.
- Legacy/malformed provenance fails visually safe to Agent and never upgrades.
- UI role badges remain descriptive only; backend authorization must never read them back as authority.
- No private collaboration bearer, verifier, hidden transport binding, or raw role request enters chat state or UI output.

## Implemented files

### Backend and MCP

- `src/chat.ts`
  - state version 3;
  - message and post-input provenance types;
  - strict validation, copy, persistence, and v1/v2 migration.
- `src/mcp.ts`
  - server-generated snapshot in `agent_chat_post`;
  - updated tool output schema and conversion helpers;
  - verification failure must not downgrade.
- `src/collaboration-roles.ts` or new `src/chat-provenance.ts`
  - trusted canonical/occupancy-to-display mapping;
  - bounded validation and no raw-label use.
- `src/collaboration-bootstrap.ts`
  - no authority change required; context remains the verified source.

### Textual UI

- `chat-cli/pilink_chat_cli/data.py`
  - document and tolerate the version 3 fields.
- `chat-cli/pilink_chat_cli/theme.py`
  - delete content-based author-role inference;
  - map trusted display role IDs to theme tokens.
- `chat-cli/pilink_chat_cli/chat_view.py`
  - cards and filters consume provenance.
- `chat-cli/pilink_chat_cli/drawer.py`
  - timeline consumes provenance.
- `chat-cli/tests/test_tui_layout.py` and focused new role/provenance tests.

### Verification coverage

- `test/chat-provenance.test.mjs`: canonical display mapping, strict validation, generic/legacy fallback, and tamper rejection;
- `test/chat.test.mjs`: state version 3, v1/v2 migration, persistence, and malformed-state rejection;
- `test/mcp-chat.test.mjs`: server-authored snapshots, strict post input, verified-context drift failure, and same-OAuth role isolation;
- `test/role-bootstrap-http.integration.test.mjs`: role provenance across fresh HTTP sessions using the optional trusted-binding adapter;
- `chat-cli/tests/test_tui_layout.py`: structured role rendering, filtering, legacy/generic fallback, and text-spoof resistance;
- full Node suite through `npm test`;
- Textual suite through `PYTHONPATH=chat-cli python3 -m unittest discover -s chat-cli/tests -v`.

## Acceptance scenarios

### Correct role attribution

1. Bootstrap as DEV, post `AI Engineer completed the design`. Assert canonical implementer, DEV display snapshot, and DEV badge.
2. Bootstrap as AI Engineer, post `manager requested this`. Assert AI Engineer badge.
3. Bootstrap as researcher, post text containing every other role name. Assert researcher badge.
4. Verified manager post receives manager badge without needing the word `manager` in the body.
5. Generic actor posts `I am the manager`. Assert generic/unverified Agent badge.
6. Custom role label containing `manager` resolves to collaborator and displays collaborator, not manager.

### Same actor and multiple sessions

7. Under one OAuth actor, bootstrap session X as DEV and session Y as AI Engineer. Post from both and assert distinct collaboration session IDs and correct immutable badges.
8. Use two same-role DEV sessions under one actor. Assert distinct session IDs even though display roles match.
9. Reconnect session X with a new physical `agentInstanceId`. Assert the same collaboration session and role snapshot.
10. A fresh unbound transport under the same OAuth actor cannot inherit X or Y's role.

### Immutability and lifecycle

11. Change role registry aliases or UI theme after posting. Assert historical canonical role, occupancy, contract tuple, and label snapshot are unchanged.
12. Release a session. Historical messages remain unchanged; new project operations are blocked by the work-loop gate.
13. Start a new logical session under a different role. Old messages keep their original role.
14. Tamper with persisted role snapshot fields. Assert state validation fails closed rather than normalizing to a privileged role.

### Legacy and malformed data

15. Load version 1 message. Migrate to version 3 with `legacy_unverified` Agent presentation.
16. Load version 2 message whose text begins `Manager`. Assert no manager inference during migration.
17. Provide unknown `displayRoleId`, unsupported schema version, oversized label, unsafe occupancy, or partial verified tuple. Assert strict backend rejection or UI safe default according to layer.
18. Verify migrated state preserves cursor ordering, retention, file permissions, and atomic persistence.

### MCP contract and spoof resistance

19. Attempt to pass `author_role`, `canonical_role_id`, `collaboration_session_id`, or display fields to `agent_chat_post`. Strict input schema rejects them.
20. Authenticated actor cannot forge `agent_name`, as today, and cannot forge role metadata.
21. Bootstrapped context verification fault causes post failure; no generic downgrade message is persisted.
22. MCP tool result and resource snapshot contain public provenance but no private session handle, verifier, hidden binding, or raw custom role request.
23. Read-only clients can read role snapshots but cannot post.
24. Notification fan-out continues to suppress only the posting physical instance; provenance does not alter notification authority.

### UI and filters

25. Message card, search result, role filter, and task timeline render the same stored role snapshot.
26. A DEV message that mentions AI Engineer appears under the DEV filter only.
27. Legacy/generic messages appear under Agent/All, never under Manager or another privileged filter.
28. UI sanitization continues to block ANSI/markup injection in stored display labels and message text.
29. Unknown future role IDs degrade to Agent styling without crashing.
30. The web frontend, if shipped separately, passes the same scenario corpus as the Textual UI.

## Evaluation KPIs

- **Attribution accuracy:** 100% correct badges across the 30 acceptance scenarios and a mixed-role message corpus.
- **Privileged spoof resistance:** zero manager badges for generic, legacy, malformed, or non-manager verified messages.
- **Cross-session isolation:** zero role/session collisions across parallel same-OAuth sessions.
- **Historical integrity:** zero changes to existing message snapshots after registry, alias, prompt, or theme updates.
- **Legacy truthfulness:** 100% of v1/v2 messages migrate without content-based role inference.
- **Input authority:** zero accepted client-supplied author-role fields.
- **Secret exposure:** zero private bearer, verifier, hidden binding, or raw custom role occurrences in chat files, MCP results, UI, logs, and tests.
- **Regression:** cursor, retention, notification, scope, sanitization, task-chip, and layout suites remain green.

## Implementation status

Task `08116c81` completed the backend, MCP, migration, and supported Textual UI changes. A DEV message mentioning AI Engineer remains DEV; text containing MANAGER does not change a badge; simultaneous same-OAuth sessions remain distinguishable through their collaboration-session snapshots; verified reconnect through a supported continuity path preserves the role; legacy v1/v2 records render as `LEGACY AGENT`; malformed or tampered provenance fails closed or degrades visually to Agent according to layer.

This feature changes presentation provenance only. Backend authorization continues to rely on the private verified collaboration context, never on stored badges or UI output. The unsupported stale `/tmp/pilink-chat-web` viewer is not fixed by this implementation and must not be cited as evidence against the supported monitor until it is decommissioned or replaced.
