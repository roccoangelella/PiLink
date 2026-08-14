# Agent work-loop continuity

Status: implemented server contract, with an explicit connector limitation.

PiLink never treats an OAuth actor, public collaboration-session ID, role
label, prompt, or repository content as proof that two physical MCP connections
belong to the same logical worker. Verified role and manager authority remain
attached only through private, non-model-visible transport state.

## Supported continuity paths

1. **Protocol-native MCP session reuse — preferred.** A client retains the
   server-issued `Mcp-Session-Id` and sends it on later requests from the same
   logical conversation. PiLink routes those requests to the original MCP
   handle and its private collaboration bootstrap.
2. **Trusted logical-binding adapter — optional.** A trusted reverse proxy or
   client may inject one private value per logical conversation through the
   header named by `PI_COLLABORATION_BINDING_HEADER`. The edge must remove any
   inbound copy and overwrite it; merely allowing an Internet caller to choose
   the header does not create trust.
3. **No private continuity value — fail closed.** A fresh transport cannot
   recover verified authority from public or model-visible values. Role-gated
   operations return `COLLABORATION_CONTEXT_CONTINUITY_UNAVAILABLE`.

The configured binding value is validated as a single non-empty scalar of at
most 512 UTF-8 bytes without control characters. PiLink derives its internal
registry key with an HMAC over the OAuth actor, client credential version, and
private logical binding; the raw binding is never logged, persisted, returned,
or copied into collaboration data.

## Shared context lifecycle

All physical handles for one trusted binding share a process-level state
machine: `pristine`, `bootstrapping`, `bootstrapped`, or `generic_locked`.
Prompt reads and first project operations wait behind an in-flight bootstrap,
then adopt the verified immutable tuple. If project access wins first, the
entire shared binding becomes generic; a later role bootstrap cannot race past
that decision.

Closing one physical handle detaches only that handle. After the final detach,
the registry retains the logical context for
`PI_COLLABORATION_BINDING_DETACH_GRACE` seconds (600 by default), then marks the
work loop offline and disposes the private bootstrap once. Runtime shutdown
performs the same final cleanup. A manager-authorized `released` state remains
terminal and is checked before the first project operation of a reattached
handle.

## Connector limitation

This adapter helps only when a real trusted component supplies the private
per-conversation binding. A connector that creates a fresh MCP session for each
tool call, does not reuse `Mcp-Session-Id`, and supplies no trusted binding
cannot securely continue a verified multi-agent role across calls. PiLink
does not weaken identity checks to disguise that limitation.

## Verification

Coverage includes:

- native Streamable HTTP session reuse;
- actor and OAuth client-version isolation;
- duplicate, malformed, empty, oversized, and control-character header denial;
- pre-attached prompt, project-operation, resource, and subscription races;
- immutable verification-fault latching and one-time detach;
- terminal manager release and final logical disposal;
- real HTTP and legacy SSE attachment behavior.

See the exact upstream design snapshot in
[transport continuity](../upstream/agent-work-loop-transport-continuity.md) and
the integration ledger in
[`B629_INTEGRATION_CHECKLIST.md`](../upstream/B629_INTEGRATION_CHECKLIST.md).
