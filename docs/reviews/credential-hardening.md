# Acceptance review: collaboration-session credential hardening

Review task: `90b63f83-f9b1-4642-8a92-1457860b98db`
Primary reviewed implementation commit: `2033daa`
Final test-only follow-up: `d3fe019`
Reviewer independence: same project OAuth actor, separate security-review task/session context; not claimed as different-actor review.

## Scope

Reviewed only:

- `src/collaboration-sessions.ts`;
- `test/collaboration-sessions.test.mjs`;
- `test/fixtures/collaboration-session-worker.mjs`;
- `test/fixtures/collaboration-session-resume-worker.mjs`.

Public MCP session/recovery-handle wiring is outside the accepted surface and remains absent from committed `src/mcp.ts`.

## Verification performed

For implementation commit `2033daa`:

- exact commit scope inspected: four intended files only;
- `git diff 2033daa^ 2033daa --check` passed;
- independent focused suite passed 13/13;
- manager reported full shared suite 130/130;
- independently reproduced lost-response/default-change replay against the committed build;
- independently attempted wrong-key-material/same-key-ID list, start, and resume against the committed build;
- verified state remained byte-for-byte unchanged after all wrong-key operations;
- verified no `agent_session_*`, `collaboration_session_handle`, or `CollaborationSessionStore` public MCP wiring exists in `src/mcp.ts`;
- inspected HMAC domains, state schema, generation binding, recovery records, lock behavior, quota, liveness touches, legacy migration, validation, and persisted/public fields.

## Final verdict

**ACCEPT for the private/internal credential-store core at `2033daa` + `d3fe019`.**

The source fixes both previously confirmed high-severity defects, and the test-only follow-up now covers wrong-material read, start, authentication, resume, and byte-for-byte state immutability. Independent focused verification passes 13/13; both exact commit deltas pass diff checks; the manager reports full shared suite 130/130.

This acceptance does not authorize public/model-visible recovery-handle MCP wiring. The exposure, keyring, tombstone-retention, task reconciliation, and project-ID boundaries below remain unchanged.

## Accepted security properties

### Explicit validated server key

The store requires an explicit key record:

```ts
{
  keyId: string;
  keyMaterial: unpaddedBase64url32To64Bytes;
}
```

Malformed, missing, padded, too-short, or too-long key material is rejected before use.

### Versioned and domain-separated HMAC

Separate HMAC domains are used for:

- current credential verifiers;
- resume request identifiers;
- deterministically rederived resume secrets;
- legacy revoked tombstones;
- state-level credential-key binding.

Credential verifier input binds:

- key ID;
- project key;
- collaboration-session ID;
- OAuth actor ID;
- credential generation;
- bearer secret.

Resume request and secret derivations additionally bind source/target generation, request ID, and requested TTL where relevant.

### State-level key-material binding

The persisted state contains a versioned `credentialKeyBinding` HMAC over the project, state schema/protocol, and key ID using the configured material.

This closes the confirmed key-confusion corruption:

1. create state using material A and key ID K;
2. reopen using material B with the same key ID K;
3. attempt list/start/resume;
4. every operation fails before mutation;
5. persisted state remains byte-for-byte unchanged.

Independent committed-build result:

```text
list:   credential key material does not match persisted state
start:  credential key material does not match persisted state
resume: credential key material does not match persisted state
state unchanged: true
```

A different key ID also fails closed before state use.

### Generation-bound rotation

Every credential has a positive generation. A successful resume:

- validates the current generation credential;
- increments exactly once;
- invalidates the old credential for ordinary authentication;
- persists the new verifier only;
- records a short bounded recovery record containing no plaintext credential or request ID;
- records the prior verifier, source/target generation, HMAC of request ID, TTL, rotation time, and recovery expiry.

### Retry-safe lost-response recovery

A repeated request using:

- the previous credential;
- the same opaque request ID;
- the same explicit parameters, or omitted TTL that originally selected a server default;
- within the bounded recovery window;

rederives the identical new credential without storing plaintext.

Different concurrent request IDs for one source generation produce exactly one winner. The loser receives a stable conflict rather than a second valid generation.

### Configuration-change retry safety

The original implementation draft incorrectly resolved an omitted retry TTL from the current server default before matching persisted recovery state. A successful rotation under default 60 followed by response loss and restart under default 120 therefore stranded the caller.

Commit `2033daa` preserves whether TTL was omitted. During matching recovery, omitted TTL uses the persisted winning TTL; explicitly supplied mismatched TTL still fails.

Independent committed-build result:

```text
first default: 60
replacement default: 120
same request + old credential + omitted TTL: identical generation-2 handle
winning expiration preserved: true
```

### Actor and project binding

A credential is valid only for its persisted OAuth actor and path-derived project. A different actor cannot reuse it, and a state file cannot be loaded as another project.

This is necessary but not sufficient for future public exposure: sibling logical sessions sharing one OAuth client remain the same actor. A model-visible bearer can therefore be replayed by a sibling that sees it. Public MCP exposure remains blocked.

### Constant-time MAC comparison

Validated fixed-size base64url MACs are compared with `timingSafeEqual`. Invalid encodings fail before comparison.

### No plaintext persistence

Persisted state does not contain:

- current or previous bearer secret;
- full collaboration-session handle;
- resume request ID;
- server key material.

Public session projections omit verifiers and recovery state. Tested error messages do not include bearer material.

### Bounded recovery and terminal cleanup

- recovery duration is bounded;
- expired recovery metadata is removed;
- release and revoke erase recovery metadata;
- old credentials fail after recovery expiry;
- expired sessions cannot resume after the configured resume window.

### Per-actor quota

A bounded active-or-resumable session quota is enforced per OAuth actor in addition to the project total. Released sessions free capacity.

### Throttled liveness persistence

Ordinary authentication does not rewrite and increment the session record on every call. `lastSeenAt` persistence is throttled by a configured interval, avoiding a global serialized write for every future session-bound operation.

### Cross-process mutation safety

Session creation and resume use the project store’s hardened cross-process lock. Tests cover:

- synchronized creation;
- same resume request converging to one deterministic credential;
- different requests yielding exactly one winner;
- dead lock-owner recovery;
- live, permission-ambiguous, or malformed owner records failing safe.

### Legacy fail-closed migration

Unkeyed v1 credentials cannot be safely transformed into keyed credentials because the original secret is unavailable. Migration therefore:

- preserves public session/provenance fields;
- revokes legacy sessions;
- increments revision;
- removes the old unkeyed hash;
- creates a keyed non-authenticating tombstone;
- requires a new session/reassignment for future work.

This is the correct fail-closed migration.

## Test-only follow-up completed

Commit `d3fe019` adds the required wrong-material `resume()` regression using a valid handle and request ID. It verifies the state-key binding rejects the request before rotation/recovery and that persisted state remains unchanged. The follow-up changes only `test/collaboration-sessions.test.mjs`; its diff check is clean and the focused suite remains 13/13.

## Residual risks and follow-up backlog

### Public model-visible carrier remains rejected

`CollaborationSessionCredential` still models a returned bearer credential for the internal core. Do not expose it through MCP tools until the project accepts:

- a non-model-visible transport/server session binding, or a clearly bounded fallback recovery surface;
- complete redaction from model-visible traces, activity, task state, audit, logs, and errors;
- the residual same-OAuth sibling risk;
- administrative recovery after recovery-window expiry.

### Single-key state, no keyring migration

The state is bound to exactly one configured key ID/material. Changing either fails closed. That prevents silent corruption but does not provide online rotation.

A future keyring/migration task should define:

- current and accepted previous key IDs;
- state-binding validation under the correct key;
- atomic verifier/recovery re-MAC or session revocation policy;
- rollback and crash recovery;
- removal deadline for previous keys.

Do not add an ad hoc second-key fallback inside authentication.

### Terminal tombstone retention

Legacy migration creates revoked tombstones, but project-capacity cleanup can still delete released/revoked/old-expired records. Tasks, activity, reviews, and independence evidence may reference public session IDs.

A future retention design should preserve bounded public provenance while erasing credential verifiers/recovery secrets, and must never delete a session still referenced by an active task or unresolved review.

### Session-to-task terminal reconciliation

Release/revoke occurs in the session store and task ownership lives in another store. Define a durable outbox/reconciliation policy before public autonomous pull:

- immediate task release/reassignment; or
- preserve until lease expiry with explicit manager attention.

Avoid nested cross-store locks.

### Project identity

The store remains keyed by canonical workspace path. Multi-worktree collaboration requires the accepted server-generated project-ID migration across all stores together.

## Final boundary

Allowed under this accepted internal-core boundary:

- retain `2033daa` as the internal credential core;
- build scheduler/task integration against an abstract verified session context;
- use public collaboration-session IDs for provenance and exact owner scope;
- keep the credential store private and server-bound.

Not allowed yet:

- public MCP `agent_session_*` tools returning or accepting the bearer;
- a required model-visible handle argument on every task/pull call;
- authentication by public collaboration-session ID alone;
- claiming same-OAuth sibling sessions are cryptographically independent;
- online key rotation without a keyring/migration design;
- claiming session release/revoke is atomically reconciled with task state;
- claiming worktree-shared project identity before project-ID migration.
