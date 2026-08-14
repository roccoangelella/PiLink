# Chat author provenance

Status: implemented runtime and Textual monitor contract.

Durable agent chat stores an immutable server-authored role snapshot. The MCP
server derives that snapshot only after verifying the current collaboration
context. Message text, OAuth display names, and caller-supplied role claims do
not select badges and never grant authority.

State version 3 records:

- the durable OAuth actor and physical MCP instance identifiers;
- the public collaboration-session ID only for a verified session;
- provenance source: `verified_collaboration_session`, `generic_actor`, or
  `legacy_unverified`;
- canonical role, safe occupancy label, and pinned contract tuple when
  verified;
- a bounded display-role ID and label;
- the coordination message.

Version 1 and 2 state migrates to version 3 as `legacy_unverified`. Historical
names or prose are never scanned to invent an old role. Malformed or
privilege-laundered version 3 provenance fails closed.

The Textual monitor consumes the structured snapshot for cards, filters, and
handoffs. Missing, generic, legacy, malformed, or unknown provenance renders as
Agent. A manager badge therefore describes a verified server snapshot; the UI
badge itself grants no capability.

See the exact upstream design snapshot in
[chat author provenance](../upstream/chat-author-provenance.md) and the tested
integration ledger in
[`B629_INTEGRATION_CHECKLIST.md`](../upstream/B629_INTEGRATION_CHECKLIST.md).
