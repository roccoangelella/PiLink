# Transport continuity for verified collaboration work loops

Status: current specification / implemented optional server adapter / documented connector limitation
Owner: AI Engineer, collaboration runtime maintainer, and project manager
Discovered: 2026-08-04
Last reviewed: 2026-08-04
Related implementation: `src/mcp.ts`, `src/index.ts`, `src/config.ts`, `src/collaboration-bootstrap.ts`, `src/collaboration-context-registry.ts`, and `src/work-loop.ts`
Related protocol: [`agent-work-loop.md`](agent-work-loop.md), [`collaboration-role-contracts.md`](collaboration-role-contracts.md)

## Problem statement

On the protocol-native path, role bootstrap remains intentionally bound to one live MCP server instance. `createMcpServer()` keeps `verifiedCollaborationContext` and the private `CollaborationBootstrap` credential in connection-local memory. `agent_work_wait`, `agent_work_list`, and `agent_work_release` call `verifyCollaborationContext()` and fail closed when that connection-local state is absent.

This is secure and complete when the client reuses the server-issued `Mcp-Session-Id`. PiLink now also implements an optional process-shared adapter for deployments where a trusted client or reverse proxy injects a unique hidden binding per logical conversation. The adapter does not infer continuity from OAuth identity, public IDs, role text, or arbitrary caller-controlled headers.

The observed ChatGPT connector remains incompatible with both supported paths: it opens a fresh MCP session for each tool invocation and exposes no private per-conversation binding to PiLink. Therefore the implemented server adapter is not an end-to-end fix for that connector; unbound fresh sessions continue to fail closed.

The production harness reproduced this exact sequence:

1. `collaboration_bootstrap("AI Engineer")` succeeded and returned a public collaboration session ID;
2. the immediately following `agent_work_wait({ maximum_wait_seconds: 60 })` returned `Verified collaboration context is unavailable`;
3. repeated bootstrap on a new invocation created a different public collaboration session ID, but the next wait failed in the same way;
4. chat messages posted by consecutive invocations contained different `agent_instance_id` values, consistent with a fresh MCP server instance per call.

The original `test/mcp-work-loop.test.mjs` fixture covered only one in-memory client connected to one `createMcpServer()` handle. The current repository additionally covers the optional adapter and fail-closed fresh-session topology with focused registry tests and real Streamable HTTP integration tests.

The remaining ChatGPT behavior is a connector compatibility gap, not evidence that verification should be weakened. Failing closed is preferable to silently granting role authority from OAuth identity, public session IDs, prompt text, role labels, or model-visible metadata.

## Root cause

The runtime currently assumes:

```text
one logical agent session == one long-lived MCP server/transport instance
```

The failing connector behaves as:

```text
one tool invocation == one fresh MCP server/transport instance
```

Therefore the private bootstrap bearer, immutable role tuple, connection state, and `agent_instance_id` disappear before the next role-gated call. Durable task/chat/work-loop stores survive, but they cannot safely identify which of several parallel logical sessions belonging to the same OAuth actor is calling.

## Concrete transport finding

PiLink already has one concrete private, non-model-visible continuity value: the protocol-native `Mcp-Session-Id` used by its sessionful Streamable HTTP transport.

- `src/index.ts` creates `StreamableHTTPServerTransport` with `sessionIdGenerator: () => randomUUID()`.
- The initialized session is stored in the process-local `transports[sessionId]` map.
- A later request carrying the same `Mcp-Session-Id` is routed to the same `McpServerHandle`, so it retains the exact `CollaborationBootstrap`, verified context, role tuple, work-loop state, and notification subscriptions.
- The session ID is carried by HTTP transport code, not by model-visible tool arguments.

For the sessionful MCP transport PiLink currently implements, the [MCP 2025-11-25 transport specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#session-management) states that a client receiving an `MCP-Session-Id` during initialization must include it on subsequent requests. The existing SDK `StreamableHTTPClientTransport` tests already exercise this correct client behavior.

The production connector path observed in this task does not preserve that session across separate tool invocations. Every invocation reaches PiLink as a fresh initialization, receives a fresh physical session and `agent_instance_id`, performs one tool call, and loses the connection-local verified context before the next invocation. This is why `collaboration_bootstrap` succeeds but the following `agent_work_wait` fails.

No second concrete per-conversation identity is currently available to PiLink:

- OAuth `sub`, client version, scopes, and access-token identity are actor/app credentials shared by parallel chats, not conversation identity;
- `agent_instance_id`, `extra.sessionId`, remote socket identity, request IDs, trace IDs, and `Mcp-Session-Id` from the fresh invocation are physical-request/session telemetry and change across calls;
- the public `collaboration_session_id` is deliberately non-secret provenance;
- OpenAI's public remote-MCP API describes [optional HTTP headers](https://platform.openai.com/docs/api-reference/realtime-client-events/session) as caller-supplied configuration, but does not define an automatic hidden per-conversation header delivered to custom MCP servers.

Therefore the server cannot derive a secure logical-chat binding from the current request. A configurable custom-header bridge proves the registry mechanism only when a real trusted client or proxy supplies a unique value per logical conversation. A test that invents `X-PiLink-Logical-Session: private-conversation-A` does not by itself prove compatibility with the production ChatGPT connector.

## Rejected shortcuts

### OAuth actor as the collaboration session

Rejected. One OAuth client is a durable author identity, not one conversation or worker. Parallel chats can share the same OAuth actor, including multiple workers with the same canonical role. Actor-level reuse would merge task ownership, role authority, manager release, and waiting state across unrelated sessions.

### Public `collaboration_session_id` as a resume credential

Rejected. The public ID is intentionally provenance, not a bearer. Accepting it as sufficient proof would let model-visible text, chat, logs, tasks, or repository content hijack another session.

### Re-send the role label on every call

Rejected. A role label is untrusted input. Keying by actor plus normalized role still collides for parallel same-role sessions and cannot prove continuity with the original private bearer.

### Model-visible signed resume token

Rejected as the default design. Even a signed token becomes a model-visible bearer that can leak through prompts, logs, chat, memory, or copied tool arguments. Continuation material must remain outside model-visible tool payloads.

### Manual client-side `sleep` plus task/chat reads

Rejected as the product fallback. It does not preserve verified role authority, durable manager release semantics, backoff state, cancellation, or server-side wake-up behavior. It also encourages hot polling and duplicate workers.

## Required trust boundary

A stateless transport can safely reattach only when the client or connector supplies a stable, private, non-model-visible execution-context binding for the logical chat/agent session.

The binding must:

- be generated or asserted by the trusted client/harness, never by prompt text or repository content;
- remain stable across fresh physical MCP connections belonging to one logical agent session;
- differ across parallel logical sessions, even under the same OAuth actor and same role;
- be delivered through trusted request metadata or another out-of-band channel, not a tool argument visible to the model;
- be scoped to the authenticated OAuth actor and client version;
- never appear in tool output, prompts, audit text, chat, tasks, memory, exceptions, or repository files;
- support revocation and bounded expiry.

If no such binding is available, exact session continuity is cryptographically underdetermined. The server must fail closed rather than guess.

An HTTP header is trusted only when an upstream component outside model control strips any inbound copy and overwrites it with a per-conversation value. Configuring PiLink to read an arbitrary caller-supplied header does not by itself establish this trust boundary. The only protocol-native continuity mechanism already present is `Mcp-Session-Id`; clients should preserve and resend it for every tool call in the same logical conversation whenever possible.

## Implemented and preferred architecture

### 1. Prefer protocol-native MCP session reuse

The minimum end-to-end fix for the current PiLink transport is in the connector/harness: preserve the server-issued `Mcp-Session-Id` for one logical ChatGPT conversation and include it on every subsequent tool call from that conversation. Delete or abandon that MCP session only when the logical conversation/agent session is actually disposed.

This path needs no new continuation credential and no shared collaboration registry: the existing `transports[sessionId]` routing already returns calls to the exact trusted connection-local bootstrap. PiLink's real-HTTP tests cover sessionful routing; the external connector still needs its own regression proving that it captures the initialization response header and reuses it for `collaboration_bootstrap`, `agent_work_wait`, and later calls in the same logical conversation.

If the production connector intentionally cannot retain an MCP session, then the connector or a trusted intermediary must be changed to supply a hidden stable conversation binding. PiLink alone cannot create that missing identity.

### 2. Optional trusted logical-session bridge for stateless connectors

For deployments where a concrete trusted client/proxy can inject a different hidden value for every logical conversation, PiLink implements an opt-in header adapter configured by `PI_COLLABORATION_BINDING_HEADER`. A static app-level header, a value configured once for an OAuth client, or any model/tool argument is insufficient and must not be used for this path. The upstream component must strip any inbound copy and overwrite the configured header before it reaches PiLink.

PiLink validates the configured header name and bounded value, rejects duplicates and malformed input, then derives an internal lookup key:

```text
bindingKey = HMAC(serverBindingSecret,
                  oauthClientId || clientVersion || logicalClientSessionBinding)
```

Persist or log only a bounded diagnostic fingerprint when necessary. Never persist the raw binding.

### 3. Process-shared collaboration-context registry

The implemented `CollaborationContextRegistry` is shared by all MCP server handles in one PiLink runtime. It maps `bindingKey` to a live entry containing:

- the private `CollaborationBootstrap` instance or equivalent private credential holder;
- the immutable verified collaboration context;
- OAuth actor ID and client version;
- canonical role, safe occupancy label, request fingerprint, and pinned contract tuple;
- reference count / active request count;
- last-seen time and configurable detach grace;
- terminal/released state;
- an atomic shared access mode (`pristine`, `bootstrapping`, `bootstrapped`, or `generic_locked`) plus the in-flight initialization promise.

The private collaboration-session bearer remains inside trusted process memory. This preserves the existing rule that process restart or loss of the private runtime cannot be resumed from OAuth identity or public IDs alone.

### 4. Attach instead of recreate

When a new physical MCP connection arrives with a trusted binding:

1. authenticate OAuth and derive `bindingKey`;
2. attach the MCP server handle to an existing registry entry, if present;
3. re-verify the private collaboration session and immutable tuple before any role-gated operation;
4. keep every pre-attached physical handle on one shared access state instead of snapshotting initialization only at handle construction;
5. if bootstrap is already in flight, make dynamic prompt reads and project access wait and adopt the resulting verified context before the operation continues;
6. if project access wins while the shared entry is still pristine, atomically lock the whole binding in generic mode so a later bootstrap cannot race past it;
7. serialize concurrent bootstrap attempts for the same binding and reject conflicting role requests without replacing the entry.

`src/index.ts` now attaches a registry controller when the trusted binding header is present; otherwise it creates the original connection-local `CollaborationBootstrap`. `createMcpServer()` receives either lifecycle controller through the same private bootstrap interface.

### 5. Separate physical disconnect from logical disposal

Closing one short-lived transport detaches only that handle. While another attachment survives, the shared logical session and its work lifecycle remain active. When the last attachment is gone, the registry keeps the private bootstrap for the configured detach grace; final entry disposal marks the work lifecycle `OFFLINE` and releases the private collaboration bootstrap exactly once. PiLink shutdown performs the same final logical cleanup.

Manager-authorized durable `RELEASED` is a separate terminal work-state transition: a reattached handle must observe it before its first project operation, and all project tools other than the terminal `agent_work_wait` observation remain blocked. OAuth disable or credential-version rotation namespaces future bindings away from the old entry and existing transport invalidation rules close affected handles.

A physical transport cancellation still cancels its in-flight `agent_work_wait` request. It must not create an unbounded timer, mark a still-referenced logical session `OFFLINE`, or silently convert absence into `RELEASED`.

### 6. Preserve work-loop identity

`agent_work_wait`, task ownership, manager listing/release, dynamic prompts, and governed memory access must all use the exact registry-attached collaboration session ID. The random physical `agent_instance_id` may continue to identify notification connections, but it must not replace logical collaboration identity.

### 7. Structured fail-closed diagnostics

The runtime returns a stable machine-readable fail-closed diagnostic while retaining a safe human message:

```json
{
  "code": "COLLABORATION_CONTEXT_CONTINUITY_UNAVAILABLE",
  "message": "Verified collaboration context is unavailable on this transport",
  "retryable": false,
  "requires_private_client_binding": true
}
```

Do not suggest using the public session ID, role text, or OAuth actor as recovery material. The manager-facing diagnostic may state that the connector did not preserve the logical-session binding.

## Fallback policy

1. **Same MCP session available:** use the protocol-native `Mcp-Session-Id` and retain the current connection-local path; this is the preferred fix for the current connector/harness.
2. **Fresh transport plus a real trusted binding injector available:** attach through the shared registry and continue the exact verified session.
3. **Fresh transport without a real trusted binding:** fail closed with the structured continuity error; merely configuring a header name on PiLink does not create a binding.
4. **Explicitly configured single-session deployment:** an actor-scoped compatibility mode may be considered only as a separate opt-in product mode that rejects a second concurrent logical session before bootstrap and disables ambiguous role switching. It must never be the default and is unsuitable for PiLink agent swarms.
5. **Client behavior:** do not loop re-bootstrap calls after a continuity error; that only creates orphan logical sessions. Report one durable blocker to the manager and stop role-gated mutation until the transport binding is fixed.

## Security invariants

- OAuth identity proves the actor, not the logical collaboration session.
- The public collaboration session ID remains non-secret provenance and never authenticates continuation.
- Only a trusted hidden binding plus OAuth actor/version can locate a private registry entry.
- A copied binding from another OAuth actor or client version fails before session inspection.
- A binding cannot change its pinned role request, canonical role, occupancy, contract ID, or contract version.
- Manager authority is re-verified from the private attached context on every manager-only operation.
- `RELEASED` remains terminal across reconnects using the same binding.
- Concurrent attach/bootstrap/project-access/wait/release operations share one logical state machine. A handle created before bootstrap cannot remain locally pristine after another attachment establishes or releases the shared session.
- No raw binding, HMAC key, private handle, verifier, or recovery material reaches model-visible surfaces.
- Transport disposal, task leases, collaboration-session expiry, and durable work-loop lifecycle remain distinct state machines.
- Missing continuity metadata never degrades to generic actor-scoped role authority.

## Acceptance scenarios

### Reproduction and negative controls

1. Bootstrap on physical connection A, then call `agent_work_wait` on connection B with the same OAuth actor but no hidden binding. Assert fail-closed `COLLABORATION_CONTEXT_CONTINUITY_UNAVAILABLE` and no actor-level reattachment.
2. Supply only the public collaboration session ID on connection B. Assert it has no authentication effect.
3. Supply the same role label on connection B without a hidden binding. Assert a new bootstrap would be a distinct session and cannot inherit A's work state.
4. Verify consecutive fresh connections receive different physical `agent_instance_id` values while the logical session remains unavailable without binding.

### Positive continuity

5. Initialize one real Streamable HTTP client, capture the server-issued `Mcp-Session-Id`, bootstrap, and invoke `agent_work_wait` on a later HTTP request carrying that same header. Assert one MCP handle, one `agent_instance_id`, one collaboration session, and the same verified role tuple.
6. Repeat 100 sequential tool calls using the same `Mcp-Session-Id`. Assert exactly one logical collaboration session and no registry/header bridge involvement.
7. Run parallel HTTP requests under the same `Mcp-Session-Id`. Assert the transport serializes or rejects unsupported concurrency safely without duplicating the private collaboration session.
8. Only when a real trusted injector exists, create physical connections A and B with hidden binding X before bootstrap, bootstrap A, and read dynamic guidance or invoke a role-gated operation from B. Assert B waits behind any in-flight initializer, adopts the same public collaboration session ID and role tuple in its prompt, and cannot bypass a later manager release on its first task, chat-resource, or subscription operation.

### Isolation

9. Use bindings X and Y under the same OAuth actor and same canonical role. Assert distinct public session IDs, task ownership, memory/task scopes, waiting states, and manager release targets.
10. Copy X to a different OAuth actor or client version. Assert that it derives a distinct registry namespace and cannot reattach to, inspect, or disclose the original collaboration session.
11. Attempt a different role request on X. Assert immutable-tuple conflict and preservation of the original role.
12. Verify one binding cannot complete, renew, release, or inspect session-scoped work owned by another binding.

### Release, expiry, and recovery

13. Manager releases X while no task is owned. A fresh connection using X receives terminal `released` from `agent_work_wait`; all other project tools fail closed.
14. Closing one of multiple physical attachments detaches only that handle and leaves X active; closing the final attachment starts the configured grace without permanently releasing X.
15. Grace expiry or runtime shutdown records logical `OFFLINE`, disposes the private bootstrap exactly once, and removes the registry mapping.
16. OAuth disable or token-version rotation invalidates every bound entry for that actor/version.
17. After PiLink process restart, hidden binding X alone cannot resurrect the lost private bearer. Existing runtime-loss/orphan rules apply, and a new bootstrap creates a new logical session.

### Leakage and abuse resistance

18. Scan tool output, structured content, prompts, audit records, chat, tasks, memory, logs, exceptions, and persisted repository data for the raw binding, HMAC secret, private handle, verifier, or recovery material. Assert zero disclosure.
19. Fuzz missing, oversized, malformed, replayed, and concurrently reused bindings. Assert bounded errors and no partial registry entries.
20. Inject role labels, public IDs, and fake bindings through repository files, chat, task details, and prompt text. Assert they cannot attach or elevate authority.

### Work-loop behavior

21. With continuity established, the first `agent_work_wait` returns an immediate snapshot and later calls reuse the exact returned chat cursor and opaque task-board token.
22. A task or chat change wakes a bounded wait; a timeout returns within the requested maximum of 60 seconds and is not a stop condition.
23. Repeated timeouts use persisted capped backoff and jitter without a model-side hot loop.
24. Manager release during a wait returns `released` within the bounded server recheck interval.
25. Request cancellation terminates the in-flight wait and leaves the logical session recoverable through the registry.

## Evaluation KPIs

- **Protocol-native continuity:** 100% successful role-gated calls across 100 sequential HTTP requests carrying one server-issued `Mcp-Session-Id`.
- **Bridge continuity, when deployed:** 100% successful role-gated calls across 100 fresh physical sessions sharing one binding supplied by an identified trusted injector.
- **Single creation:** exactly one logical collaboration session per MCP session or trusted binding under concurrent bootstrap stress.
- **Isolation:** zero cross-binding task, role, memory, work-state, or release collisions across parallel same-OAuth sessions.
- **Fail-closed safety:** zero successful reattachments using only OAuth actor, public session ID, role label, prompt text, or repository/chat content.
- **Secret exposure:** zero raw private-binding or collaboration bearer occurrences across all model-visible and durable public surfaces.
- **Bounded waiting:** every wait returns or wakes within its configured maximum; no orphan timers after cancellation or detach.
- **Terminal integrity:** 100% of reconnects to released bindings remain terminal.
- **Regression:** existing same-transport bootstrap, role isolation, work-loop, task lease, memory, and runtime-orphan suites remain green.

## Verification status and remaining connector work

The repository now separates the relevant Streamable HTTP topologies:

1. **Protocol-native session reuse:** existing sessionful transport tests verify that requests carrying the same server-issued `Mcp-Session-Id` route to one managed MCP handle.
2. **Trusted-binding adapter:** `test/collaboration-context-registry.test.mjs`, `test/mcp-work-loop.test.mjs`, `test/role-bootstrap-http.integration.test.mjs`, and `test/session-limits.integration.test.mjs` cover HMAC binding, actor/client-version isolation, pre-attached and in-flight bootstrap races, prompt-context adoption, latched prompt verification faults, first-operation blocking after manager release, fresh-session reattachment, duplicate or malformed header rejection, detach grace, cleanup, quota interaction, and unbound fail-closed behavior.
3. **Observed ChatGPT connector limitation:** live calls still initialize a new MCP session for each tool invocation and supply no trusted hidden binding. This path correctly returns `COLLABORATION_CONTEXT_CONTINUITY_UNAVAILABLE`; no end-to-end compatibility claim is made.

The remaining implementation target is outside PiLink's server runtime: the connector/harness must cache the initialized `Mcp-Session-Id` per logical conversation and reuse it, or a trusted edge must inject a unique hidden binding after stripping caller input. A positive test using a manually supplied header proves the server adapter only; it does not prove that the current ChatGPT connector provides the required trust boundary.

If the connector cannot reuse `Mcp-Session-Id` and exposes no private per-conversation metadata, the accepted product result is the documented limitation plus structured fail-closed behavior—not actor-scoped continuation and not a model-configured header.
