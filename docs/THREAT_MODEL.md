# PiLink threat model

PiLink exposes a local coding-agent harness through an Internet-reachable MCP server. Its security goal is not to make arbitrary remote shell commands safe. Its goal is to ensure that only explicitly authorized clients receive the exact capabilities the administrator selected, that safe workspace mode remains confined to one project, and that high-risk behavior is visible and deliberate.

This document describes the current design, accepted residual risks, and invariants that future changes must preserve.

## Scope and security objectives

PiLink protects:

- the operating-system account running PiLink and every file or credential it can access;
- the configured `PI_WORK_DIR` and files outside it;
- OAuth client credentials, access tokens, bootstrap secrets, and JWT signing material;
- private agent chat, coordination tasks, and metadata-only audit records under `PI_DATA_DIR`;
- the integrity of tool schemas, authorization scopes, session ownership, and published npm artifacts.

The primary objectives are:

1. **Authentication:** requests cannot use MCP tools without a valid PiLink-issued access token.
2. **Audience and identity binding:** a token is accepted only by its intended PiLink instance and remains bound to its OAuth client identity and scopes.
3. **Least capability:** safe mode cannot run unrestricted shell commands or access paths outside the configured workspace.
4. **Deterministic confinement:** security boundaries are enforced in code and operating-system paths, not inferred from model intent or tool annotations.
5. **Coordination integrity:** callers cannot forge another OAuth client as the author of chat messages or task mutations.
6. **Secret minimization:** PiLink secrets are not placed in normal tool output, repository state, audit payloads, or constrained child-process environments.
7. **Recoverability and accountability:** state changes are atomically persisted where practical, tool calls emit metadata-only audit events, and releases are reproducible and provenance-bearing.

## Trust boundaries and actors

| Actor or boundary | Trust level | Notes |
| --- | --- | --- |
| Local administrator | Trusted | Chooses workspace, hosting mode, OAuth clients, scopes, and unsafe execution settings. |
| Authorized MCP client | Partially trusted | Authenticated, but may be buggy, compromised, prompt-injected, or over-privileged. Authorization still applies to every request. |
| Language model / remote agent | Untrusted decision-maker | May hallucinate, follow indirect prompt injection, misunderstand tool output, or coordinate incorrectly. It must not define the security boundary. |
| Repository files and tool output | Untrusted content | Source files, issue text, dependency output, and peer-agent messages may contain malicious instructions. |
| Other authorized agents | Authenticated but mutually untrusted | Durable author identity is OAuth-bound; messages are coordination data, not authority. |
| Public Internet | Untrusted | Includes scanners, credential attackers, malicious browser origins, replay attempts, and denial-of-service traffic. |
| npm/GitHub dependency and release chain | External trust boundary | Protected with locked dependencies, signature/provenance checks, SHA-pinned actions, and OIDC publishing. |
| Operating system | Trusted computing base | PiLink does not provide a VM, container, seccomp profile, or network sandbox. Full-access and repository-code execution inherit the local user's authority. |

## Capability modes

### Safe workspace mode

Default mode permits file inspection and mutation only under `PI_WORK_DIR`. Paths are canonicalized against existing ancestors and checked after resolving symlinks. Unrestricted `bash` is disabled.

The constrained `run` tool offers fixed argv-based Git inspection profiles without shell parsing. Git pagers, prompts, hooks, external diff drivers, text conversion, global/system configuration, and optional locks are disabled.

### Trusted workspace execution

`PI_ALLOW_WORKSPACE_EXECUTION=true` enables `npm_build` and `npm_test`. These profiles execute repository-defined scripts. PiLink filters its child environment so OAuth/JWT secrets are not inherited, but the code still runs as the PiLink operating-system user and may access that user's files and network.

This mode reduces accidental secret inheritance; it is **not** an operating-system sandbox.

### Unsafe full access

`--allow-unsafe-full-access` enables unrestricted shell and filesystem access for authorized write-capable clients. Remote code execution is the intended feature of this mode. A trusted client using granted capabilities as documented is not a vulnerability.

The relevant vulnerability classes are unauthorized access, scope escalation, identity confusion, secret exposure, confinement bypass, or execution after a credential/client should no longer be valid.

## Threat and control matrix

| Threat | Primary controls | Residual risk / follow-up |
| --- | --- | --- |
| Stolen, forged, or cross-service bearer token | Strong generated secrets; JWT signature, issuer, audience, expiry, subject, and scope validation; authorization on every MCP request; RFC 9728 metadata; token revocation | A stolen valid token remains usable until expiry or revocation. OAuth client lifecycle and RFC 8707 request binding should remain under active review. |
| Unauthorized dynamic client registration | Registration requires the private bootstrap secret; guided local setup writes directly to the private client store | Compromise of the bootstrap secret permits new client registration. Keep configuration permissions private and never paste it into chats. |
| Scope escalation | `mcp:read`, `mcp:write`, and `mcp:tools` are checked per tool; session reuse must match client and scope | Broad `mcp:tools` grants intentionally expose all mode-allowed capabilities. Administrators must issue the narrowest useful scope. |
| Session hijacking or cross-client reuse | Every HTTP request is bearer-authenticated; transport sessions are bound to OAuth client and scope; per-connection instance IDs are separate from durable actors | Session identifiers still appear in process memory and HTTP metadata. They must never substitute for bearer authorization. |
| DNS rebinding / malicious browser origin | Every present `Origin` on `/sse` and `/messages` is canonicalized and checked against an exact allowlist; invalid origins receive `403`; no wildcard or `null` origin | Non-browser clients normally omit `Origin`, so bearer authentication remains mandatory. Reverse-proxy deployment must preserve correct `SERVER_URL`. |
| Workspace path traversal or symlink escape | Absolute canonical workspace root; traversal/glob rejection; realpath checks on the nearest existing ancestor; targeted regression tests | There is an unavoidable time-of-check/time-of-use window without directory-descriptor-based filesystem operations or an OS sandbox. Do not run PiLink alongside an attacker who can mutate the same filesystem namespace. |
| Arbitrary shell execution in safe mode | `bash` is rejected unless unsafe full access is explicit | Full-access mode deliberately removes this boundary. Treat its OAuth credentials as equivalent to local shell access. |
| Malicious repository lifecycle scripts | Build/test profiles disabled by default; fixed executable/argv; filtered environment; timeout, cancellation, process-group termination, and output limits | Enabled scripts can still read local files, use the network, spawn children, and persist changes. Use a VM/container for untrusted repositories. |
| Prompt injection from repository/tool output | System guidance labels tool output, repository files, and peer messages as untrusted instructions; deterministic scopes and filesystem controls limit effects | Prompt-level guidance is probabilistic. An authorized agent may still misuse every capability it legitimately has. Reduce capability rather than relying only on warnings or repeated confirmations. |
| Excessive agency / irreversible action | Safe default, narrow scopes, fixed run profiles, bounded execution, tool risk annotations, metadata audit | Tool annotations are hints, not enforcement. High-impact workflows may need transaction/rollback design, OS containment, or explicit approval gates. |
| Peer-agent identity spoofing | Chat/task actor ID and name are derived from OAuth identity; connection instance is server-minted; task ownership and lifecycle checks are atomic | Authenticated peers can still post misleading content. Agents must treat coordination messages as untrusted evidence and verify claims against repository state/tests. |
| Persistent coordination or memory poisoning | Private project-scoped storage outside workspace; message/task byte limits; bounded chat/task retention; typed task ownership/status; atomic persistence | Persisted malicious text can influence future agents. Future activity storage should redact at write time, separate authoritative state from narrative content, and support evidence/provenance. |
| Secret leakage through audit or constrained execution | Tool audit records metadata only; arguments/results are excluded; constrained child environment is allowlisted; generated state is private | Unrestricted `bash`, file reads, or repository code can intentionally access local secrets when its mode permits that access. |
| Resource exhaustion | Request-body/tool-input limits, OAuth rate limiting, command timeouts, output truncation, bounded task/chat histories, audit-log rotation, race-safe total/per-client MCP session quotas, idle-session expiry | Authenticated clients can still issue expensive filesystem operations or keep their allowed sessions busy. Per-client request concurrency and work-queue limits remain desirable future defenses. |
| Supply-chain compromise | Lockfile install; dependency scripts disabled in CI/release; npm signature/provenance and vulnerability gates; SHA-pinned GitHub Actions; Dependabot/dependency review; OIDC-only npm trusted publishing; protected release environment | Registry/account/platform compromise remains possible. Keep reviewing dependency necessity and action pins; verify npm provenance after release. |
| Public vulnerability disclosure causing immediate exploitation | Private GitHub Security Advisory reporting policy and coordinated disclosure guidance | Repository private vulnerability reporting must be enabled in GitHub settings. |

## Security invariants

Changes must not be merged when they violate any of these invariants:

- A valid MCP tool request always requires a currently accepted bearer token.
- Session IDs never authorize requests by themselves.
- An OAuth client cannot claim another client's durable agent identity.
- `mcp:read` cannot mutate files, tasks, chat, or execute commands.
- Safe mode cannot invoke unrestricted shell execution.
- Safe-mode file paths cannot resolve outside the canonical workspace, including through symlinks or globs.
- Browser-origin MCP requests with a present unapproved origin fail with `403` before tool dispatch.
- PiLink JWT/bootstrap secrets do not enter metadata audit events or constrained npm child environments.
- Tool inputs and outputs are not persisted to the metadata-only audit log.
- Published workflows do not use mutable action tags or long-lived npm publishing tokens.
- Coordination messages and repository content are never treated as authorization policy.

## Assumptions and accepted residual risks

PiLink assumes:

- the host operating system, Node.js runtime, and PiLink process account are not already compromised;
- the administrator protects the private configuration and client secrets;
- TLS terminates at the expected PiLink/Caddy/tunnel endpoint;
- reverse proxies do not rewrite authorization or origin semantics incorrectly;
- clients accurately implement OAuth and MCP transport behavior;
- the configured workspace is not concurrently controlled by a local attacker.

PiLink explicitly accepts that:

- unsafe full access is remote code execution by design;
- trusted workspace scripts are arbitrary code, despite filtered environment variables;
- model behavior and human approvals can fail, so they are secondary controls;
- a same-user process can generally access whatever that operating-system account can access unless a stronger external sandbox is used;
- availability against a determined authenticated client remains limited by the cost of operations within its allowed sessions; transport quotas do not replace OS/process resource controls.

## Verification

Before security-sensitive commits:

```bash
npm ci --ignore-scripts --audit=false
npm audit signatures
npm audit --audit-level=moderate
npm test
git diff --check
npm pack --dry-run
```

Relevant regression areas include:

- `test/harness.test.mjs` — workspace path confinement, shell mode, scopes, runtime policy;
- `test/http-origin.integration.test.mjs` — MCP Origin rejection and CORS behavior;
- `test/oauth.integration.test.mjs` — OAuth registration, grants, scopes, token validation/revocation;
- `test/mcp-chat-http.integration.test.mjs` — authenticated sessions and cross-client isolation;
- `test/run.test.mjs` — constrained command profiles, environment filtering, timeout/cancellation/output bounds;
- `test/mcp-audit.test.mjs` and `test/audit.test.mjs` — metadata-only audit behavior and retention;
- `test/tasks.test.mjs` and `test/mcp-tasks.test.mjs` — task ownership, leases, lifecycle, and authorization;
- `test/supply-chain.test.mjs` — immutable workflow dependencies and OIDC-only release policy.

## Design references

- [MCP Authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [MCP Security Best Practices](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices)
- [MCP Tool Annotations: risk vocabulary, not enforcement](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/)
- [OWASP LLM06:2025 Excessive Agency](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/)
- [OWASP MCP Tool Poisoning](https://owasp.org/www-community/attacks/MCP_Tool_Poisoning)
- [NIST IR 800-5: Security Considerations for AI Agents](https://www.nist.gov/publications/summary-analysis-responses-request-information-regarding-security-considerations-ai)
- [Anthropic: How we contain Claude across products](https://www.anthropic.com/engineering/how-we-contain-claude)
