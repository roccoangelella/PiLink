# Product strategy

> **Status: non-binding product hypothesis.** This document does not describe
> entitlements, promised release dates, support commitments, or current paid
> plans. Shipping behavior is defined by code, tests, and
> [Functional parity](FUNCTIONAL_PARITY.md).

## Brand

- **Product name:** PiLink — local agent bridge and orchestrator
- **Tagline:** From chat to code, on your machine.

Recommended short description:

> PiLink connects authenticated agents to the files, repositories, public chat,
> and supervised agents running on your development machine through a
> self-hosted OAuth/MCP bridge. Its optional VSPiLink extension adds graphical
> control inside VS Code.

The product should not market itself as a Codex clone or replacement. Its
distinct value is bringing user-authorized agent workflows to an
operator-controlled machine while preserving the PiLink harness, CLI, public
orchestration, and optional Pi Local ecosystem.

Before broader commercial use, product and alternative names require domain,
package, marketplace, and trademark clearance. `VS` and `Pi` can be ambiguous
without the descriptive subtitle.

## Target users

1. Individual developers and consultants who want ChatGPT Work to operate on a
   local or Remote SSH workspace.
2. Small teams that require a self-hosted execution boundary, stable endpoint,
   shared collaboration state, and clear revocation.
3. Organizations that want a managed control plane while keeping source and
   command execution on customer-owned hosts or VPCs.

The current architecture is strongest for one trusted owner or a small set of
independently authorized trusted clients. It must not be marketed as a hardened
public multi-tenant execution service without additional isolation, identity,
policy, review, and operations work.

## Product principles

- **Local data plane:** code and commands stay on the selected customer host by
  default.
- **Explicit authority:** workspace, execution, Full access, provider, and
  OAuth-client decisions are separate.
- **ChatGPT-native control:** use the supported Work/plugin surface rather than
  replacing it with another remote transcript.
- **Recoverable setup:** a stable endpoint and durable OAuth client survive
  ordinary restarts.
- **No quota mythology:** optimize model and context choices without promising
  free, infinite, or separate inference.
- **Upstream fidelity:** preserve PiLink tool/login/CLI contracts and record the
  exact upstream synchronization point.
- **Progressive complexity:** first task before advanced agents, Full access,
  native MCP, or infrastructure controls.

## Shipping now

The current repository contains:

- an MIT-licensed PiLink-derived OAuth/MCP server;
- a VS Code workspace extension and packaged sidecar;
- exact Node.js 24.18.0 runtime validation and a release-installer path for a
  checksum-verified per-user managed runtime;
- safe workspace and explicit Full-access modes;
- existing-domain, Cloudflare Named/Quick Tunnel, local-only, and legacy
  `nip.io` hosting paths;
- pinned, SHA-256-verified first-run acquisition for the supported Linux
  `cloudflared` and Caddy binaries, with mandatory hashes for custom mirrors;
- ChatGPT OAuth/DCR and user-defined compatibility support;
- Integrated Browser launch and a VS Code status/control dashboard;
- PiLink file/Git/execution tools plus collaborative chat/tasks/work loop and
  read-only memory projections;
- supervised Pi Local agents and preserved provider login modes;
- CLI/headless operation and the optional Textual monitor.

Shipping does not imply:

- a public Marketplace listing;
- a hosted relay or SaaS control plane;
- fully validated cross-platform cloudflared and OS-service installation;
- normal-Chat MCP availability;
- SSO, SCIM, organization RBAC, VPC deployment, or SLA;
- independent security certification;
- unlimited OpenAI or provider usage.

## Roadmap hypotheses

### Release readiness

- signed VSIX and documented update channel;
- finish cross-platform validation and update lifecycle for the managed Node
  sidecar already provisioned by the release installer;
- broaden verified `cloudflared`/Caddy acquisition beyond the currently
  supported Linux architectures and expand OS-native service management;
- English-first localization with Italian resources;
- state-driven diagnostics, backup/recovery, revoke, and uninstall;
- per-workspace profiles and explicit workspace switching;
- privacy, support, compatibility, and security-response policies;
- reproducible release/SBOM/provenance and independent security review.

### Managed relay

A future relay/control plane could provide device enrollment, stable hostnames,
tunnel lifecycle, health, policy distribution, and update coordination. Its
default data plane should remain on the customer host:

- no source upload by default;
- no prompt/transcript collection by default;
- no provider or OAuth secret stored in the control plane unless strictly
  required and explicitly disclosed;
- outbound authenticated device connection;
- per-device revocation and audit;
- optional customer-owned domain/VPC path.

### Team and enterprise

- organization-managed device and workspace inventory;
- SSO/RBAC and plugin distribution policy;
- per-client tool and access-mode policy;
- bounded metadata audit export;
- fleet deployment, rotation, update rings, and rollback;
- customer-managed keys or on-prem/VPC control plane;
- support, incident response, and SLA options.

### Authentication scale

OpenAI's current plugin authentication guidance prefers Client ID Metadata
Documents where supported and recommends an established identity provider for
larger deployments. A roadmap for team/managed editions should evaluate CIMD,
`private_key_jwt`, transport identity, and an external authorization service
without removing the self-contained trusted-owner mode.

## Packaging hypotheses

| Edition hypothesis | Proposed contents | Commercial hypothesis |
| --- | --- | --- |
| **Community** | Current MIT core, self-hosted VSIX/CLI, safe workspace, Pi Local, community support | Free |
| **Desktop** | Signed builds, bundled runtime, profiles, automated hosting, backup/recovery, diagnostics, direct support | €19–29/month or €190–290/year per developer |
| **Team** | Desktop features plus policy, fleet inventory, audit export, team distribution, priority support | €39–59/user/month with a minimum seat count |
| **Enterprise** | VPC/on-prem control plane, SSO/RBAC, deployment assistance, SLA and security review | Annual contract |
| **Managed relay add-on** | Stable managed connectivity and device health while execution remains customer-side | Per active host or included in Team/Enterprise |

The prices above are discovery ranges, not published prices or market facts.
Validate willingness to pay, support cost, active-host usage, and procurement
requirements before choosing a model.

Avoid per-token PiLink pricing. PiLink does not own OpenAI or third-party
inference and cannot guarantee its cost. Per-developer, per-managed-host, or
support/service pricing is easier to explain and audit.

## MIT implications

The current code is distributed under MIT. That permits commercial use,
modification, distribution, sublicensing, and sale provided the copyright and
license notice is preserved in substantial copies.

Practical consequences:

- the existing MIT code remains usable by customers and competitors;
- a paid standalone distribution can sell convenience, signed artifacts,
  support, updates, and managed operations without pretending the underlying
  MIT code is exclusive;
- future proprietary services/modules need a clear technical and licensing
  boundary;
- contribution rights, dependency licenses, notices, brand assets, and
  upstream attribution need legal review before a commercial launch.

This is product planning, not legal advice.

## Recommended onboarding product journey

1. Install signed extension.
2. Choose **Connect ChatGPT Work** or **Pi Local**.
3. Select and review the workspace boundary.
4. Choose stable hosting; keep temporary hosting under an advanced/test choice.
5. Run automated local/public/OAuth diagnostics.
6. Open Work → Plugins at the closest supported point and present only the
   clicks still required by OpenAI.
7. Complete DCR OAuth without callback copy/paste.
8. Run a read-only first task.
9. Explain collaboration monitoring after basic tools work.
10. Offer Full access only as a later, client-bound security decision.

The extension cannot safely scrape or automate clicks inside ChatGPT. The
product should automate its own runtime, endpoint, discovery, DCR, clipboard,
and diagnostics, then clearly identify the remaining OpenAI-controlled action.

## Documentation and visual roadmap

The current README uses an original PiLink hero asset, and the
[illustrated walkthrough](ILLUSTRATED_GUIDE.md) ships four sanitized,
version-labelled interface diagrams. They deliberately avoid real usernames,
paths, domains, OAuth codes, and credentials. Future release validation should
also capture sanitized, dated screenshots for:

1. first-run mode selection;
2. hosting and access selection;
3. current Work plugin installation/connection;
4. OAuth consent with workspace and scopes;
5. a read-only first task beside the VS Code dashboard;
6. agent chat and task board populated through MCP;
7. Full-access warning and client binding;
8. Remote SSH and recovery states.

OpenAI UI screenshots will age quickly. Every screenshot needs adjacent text
that remains usable when a button is renamed or moved.

## Release gates

A commercial-release candidate should not ship until:

- installation works without source checkout or manual runtime archaeology;
- the supported Work/plugin flow is tested on each declared plan/workspace
  class;
- missing entitlements fail with a precise explanation;
- safe mode, DCR, redirect, token rotation, revocation, admin isolation, and
  release secret scans pass;
- Linux, macOS, Windows, and Remote SSH claims match tested reality;
- upgrade, rollback, offboarding, and recovery are documented;
- current upstream feature fixes are audited and the synchronization commit is
  updated;
- support and security-response ownership is assigned.

## Success measures

- median time from install to first read-only tool call;
- percentage of setups completed without manual OAuth fallback;
- percentage of users selecting safe mode first;
- reconnect success after restart;
- support incidents by layer: workspace, runtime, hosting, OAuth, plugin, MCP;
- unauthorized/incorrect-workspace near misses;
- active workspaces/hosts, not model tokens;
- recovery and revocation completion time.
