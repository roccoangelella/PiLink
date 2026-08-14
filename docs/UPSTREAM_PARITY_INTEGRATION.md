# Upstream parity integration

This filename is retained as a compatibility link. The canonical record is
[Upstream lineage](UPSTREAM_LINEAGE.md), and the release checklist is
[Functional parity](FUNCTIONAL_PARITY.md).

The current explicitly documented collaboration integration baseline is
[`roccoangelella/PiLink@b629c0ee004b7e792125158879c55ee00bd89310`](https://github.com/roccoangelella/PiLink/tree/b629c0ee004b7e792125158879c55ee00bd89310)
from `feature/agent-public-chat`. It includes project-scoped agent chat, tasks,
verified collaboration roles/sessions, work-loop lifecycle, governed read-only
memory, metadata-only audit/progress, immutable chat-author provenance, and
trusted logical binding continuity while preserving the original PiLink tool
names.

PiLink's supervised Pi runtime, VS Code dashboard, hosting workflows, and
local administration remain additive. OAuth transports remain pinned to the
client, credential generation, and original scopes; collaboration credentials
remain server-side; repository execution remains explicitly gated.

The `f6d22d82` and `b629c0ee` changes were adapted into PiLink's additive
runtime rather than replacing its overlapping files. On 2026-08-04 the focused
Node integration set passed 46 of 46 tests and the optional Textual layout set
passed 6 of 6 tests with Textual 0.51.x. See the exact file ledger and commands
in [the b629 integration checklist](upstream/B629_INTEGRATION_CHECKLIST.md).

This baseline records feature-branch integration evidence. It does not replace
the complete release gates in [Functional parity](FUNCTIONAL_PARITY.md), and it
does not claim parity with commits later than the pinned hash.
