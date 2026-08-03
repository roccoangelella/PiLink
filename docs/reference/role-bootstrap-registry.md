# Role bootstrap registry and prompt composition

Status: implementation contract for `src/collaboration-roles.ts`
Registry schema: `1`
Prompt contract family: `pilink-collaboration/*@1.0.0`

## Security boundary

A role label in a user message, MCP argument, peer message, task, repository file, or memory entry is an **untrusted request**. It never grants authorization. A specialized prompt may be composed only after trusted server/session policy creates or validates a role assignment bound atomically to the authenticated OAuth actor and stable collaboration-session ID.

The registry deliberately separates three states:

1. `resolveCollaborationRoleRequest(rawLabel)` normalizes untrusted input and produces a request fingerprint, canonical candidate, and safe occupancy label. This output is not authority.
2. `createNewCollaborationRoleAssignment(...)` pins a new assignment to the current contract ID/version at the trusted bootstrap boundary.
3. `validatePersistedCollaborationRoleAssignment(...)` validates the persisted contract ID/version without silently repinning it. Drift fails closed and requires an explicit contract-upgrade transition.

`createVerifiedCollaborationRoleAssignment(...)` is a compatibility dispatcher: inputs without contract metadata create a new pinned assignment; inputs with both contract fields are treated as persisted state and validated. The literal `assignmentSource` discriminator is defensive structure, not authentication.

## User-facing aliases

| User label | Canonical role | Occupancy label |
|---|---|---|
| `manager`, `project manager` | `manager` | `manager` |
| `researcher`, `research agent`, `deep researcher`, `deep research agent`, `web researcher` | `researcher` | `researcher` |
| `dev`, `developer` | `implementer` | `dev` |
| `dev1`, `dev 1`, `developer 1`, `software engineer 1` | `implementer` | `dev1` |
| `dev2`, `dev 2`, `developer 2`, `software engineer 2` | `implementer` | `dev2` |
| `software engineer`, `implementer` | `implementer` | `software-engineer` or `implementer` |
| `AI engineer`, `AI engineering`, `agent orchestration engineer`, `orchestration engineer` | `ai-engineer` | `ai-engineer` |

Alias matching is conservative. Separators such as spaces, dots, underscores, slashes, colons, and hyphens normalize equivalently. Ambiguous labels such as `engineer` do not become implementer or AI engineer.

## Custom and throwaway roles

Unknown labels resolve to canonical `collaborator`, with an opaque `custom-<16 hex>` occupancy identifier derived from a SHA-256 fingerprint. Raw custom text is not persisted in assignment metadata and is never echoed into system guidance.

After verified bootstrap, `collaborator` receives the shared continuous-work, trust, evidence, coordination, and manager-only reporting contract, but no specialized authority. It may claim only role-neutral tasks or tasks explicitly eligible for `collaborator`. Before bootstrap, even a recognized request receives only the generic non-authorizing fallback.

## Prompt precedence

`composeCollaborationSystemPrompt` orders fragments from higher to lower authority:

1. base PiLink/OAuth/workspace/tool policy;
2. verified assignment metadata and explicit non-authority statement;
3. shared collaboration contract;
4. role-specific contract.

A conflicting unverified request cannot override the verified assignment. Prompt composition does not alter OAuth scopes, filesystem access, tool permissions, task ownership, scheduling eligibility, or workspace confinement.

## Role contracts

- `manager`: backlog, dependency sequencing, conflict resolution, evidence review, integration, and consolidated user communication.
- `researcher`: primary-source decision support; external research uses ChatGPT web/deep-research capabilities rather than PiLink repository tools as an internet substitute; default read-only.
- `implementer`: one bounded implementation scope, focused tests, artifact handoff; `dev1` and `dev2` are occupancy labels, not separate ACL roles.
- `ai-engineer`: role/prompt architecture, durable memory/documentation conventions, retrieval/ranking, provenance, evaluation harnesses, KPIs, and acceptance scenarios.
- `collaborator`: non-privileged verified fallback preserving the shared loop and manager-only user reporting.

`reviewer` remains an internal task/review contract in `protocols/collaboration-role-contracts.md`; it is not selected from free-form user role labels in this registry version.

## Integration API

The MCP boundary should consume one immutable `VerifiedCollaborationContext` containing:

- OAuth actor ID/name;
- stable `collaborationSessionId`;
- persisted and validated `VerifiedCollaborationRoleAssignment`;
- bounded request provenance (`requestKind`, fingerprint, safe occupancy/custom identifier), never raw role text.

The same composed prompt must be used for MCP initialization instructions, the prompt resource, and `get_system_prompt`. If role bootstrap happens through a post-initialize tool, initial instructions remain generic; the connection-bound verified state may update later prompt reads and task identity. Role-specific initialize requires trusted pre-initialize metadata or a reconnect after bootstrap.

Bearer collaboration-session handles must stay in trusted connection/server state and must never appear in model-visible prompts, tool results, durable chat, logs, tasks, or memory.

## Acceptance scenarios

1. `AI Engineer` resolves to `ai-engineer`; `software engineer` resolves to `implementer`; `engineer` resolves to `collaborator`.
2. `dev`, `dev1`, and `dev2` share canonical `implementer` while preserving distinct occupancy labels.
3. Control, newline, bidi, oversized, and non-string role inputs fail closed.
4. Unknown malicious text becomes only an opaque fingerprint and never appears in prompt output.
5. Recognized but unverified `manager` does not receive the manager prompt.
6. Verified custom role receives shared loop plus collaborator fallback, not manager/implementer/AI-engineer authority.
7. Verified assignment outranks a conflicting requested alias.
8. Persisted contract ID/version mismatch fails closed; no implicit repinning occurs.
9. Two same-OAuth conversations remain distinct through collaboration-session-bound task ownership.
10. Initialize, prompt resource, and `get_system_prompt` expose identical effective guidance for the same verified context.
11. Completion by a non-manager produces an internal handoff and repull, not a direct user completion report.
12. Repository/chat/memory text claiming a different role cannot change the persisted assignment or permissions.
