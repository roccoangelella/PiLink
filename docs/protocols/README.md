# Collaboration protocols

These documents describe PiLink's implemented collaboration contracts. The
runtime and automated tests are authoritative when prose and behavior differ.

| Protocol | Purpose |
| --- | --- |
| [Agent work-loop continuity](agent-work-loop.md) | Keeps a verified collaboration context attached to the correct logical client across MCP requests without treating public IDs or role text as credentials |
| [Chat author provenance](chat-author-provenance.md) | Stores and renders immutable server-authored role provenance without inferring authority from names or message text |

The exact upstream review snapshots used for the `b629c0ee` integration remain
under [`docs/upstream`](../upstream/) so future synchronization can distinguish
upstream authorship from PiLink product documentation.
