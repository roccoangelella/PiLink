# Upstream lineage

The [PiLink repository](https://github.com/roccoangelella/PiLink) preserves and
integrates two project development lines that had diverged:

- [`master`](https://github.com/roccoangelella/PiLink/tree/master) — the
  OAuth-protected Pi coding-tool MCP server, CLI, safe/full-access modes, and
  public hosting foundations;
- [`feature/agent-public-chat`](https://github.com/roccoangelella/PiLink/tree/feature/agent-public-chat)
  — durable agent chat, task ownership, collaboration sessions/roles, work
  loop, governed memory, audit/progress, and the Textual monitor.

PiLink also adds the optional VSPiLink VS Code extension without treating one
project branch as a drop-in replacement for the other.

## Recorded synchronization points

| Line | Recorded commit | Meaning |
| --- | --- | --- |
| Upstream/local master base | `9f7621b6d8b94f0aaa715db240cf516f9d2a44c8` | MCP reconnect-session recycling after the earlier feature merge was reverted |
| Feature integration baseline | `b629c0ee004b7e792125158879c55ee00bd89310` | Final upstream files imported where non-overlapping; runtime, Textual, tests, and protocols adapted where PiLink has additive changes |
| Feature branch head observed on 2026-08-04 | `b629c0ee004b7e792125158879c55ee00bd89310` | No known feature-branch delta beyond the recorded baseline on that observation date |

The two later feature commits observed after `0d0f8e…` were:

- `f6d22d82` — preserve collaboration context and chat role provenance;
- `b629c0ee` — synchronize pre-attached collaboration handles.

PiLink completed the selective integration of those fixes. The exact final upstream
versions of `src/chat-provenance.ts`,
`src/collaboration-context-registry.ts`, `test/chat-provenance.test.mjs`, and
`test/collaboration-context-registry.test.mjs` are present, together with
authority-marked snapshots of the two new protocol documents. Overlapping
changes in `src/chat.ts`, `src/config.ts`, `src/index.ts`, `src/mcp.ts`, the
Textual monitor, and their tests were adapted without discarding PiLink's
additive product/runtime behavior.

On 2026-08-04, after a clean TypeScript build, the focused Node integration set
passed 46 of 46 tests. It covered chat provenance, shared-context registry,
durable chat migration, MCP chat/work-loop behavior, real HTTP trusted-binding
continuity and isolation, and session lifecycle limits. The optional Textual
layout/provenance set passed 6 of 6 tests in an isolated environment with
`textual>=0.51,<0.52`. Commands and exact files are recorded in
[the b629 integration checklist](upstream/B629_INTEGRATION_CHECKLIST.md).

The recorded feature integration baseline is therefore `b629c0ee…`. Complete
release validation remains a separate gate; no parity is claimed for a later
upstream commit until it is reviewed and tested.

Branch heads are moving references. Release notes and parity claims must always
name an exact commit.

## Preserved upstream master behavior

- `pilink init`, `start`, `serve`, setup/reset, hosting, and client lifecycle;
- private `.env` configuration and generated secrets;
- safe workspace mode and explicit unrestricted mode;
- Pi Agent file/search/edit/write harness;
- constrained Git/run profiles and opt-in repository build/test;
- Streamable HTTP and legacy SSE compatibility;
- OAuth token, client, refresh, revocation, discovery, and session lifecycle;
- Quick Tunnel, direct `nip.io`, and reverse-proxy/local operation;
- bounded MCP session quotas and health reporting.

## Integrated feature-branch behavior

- project-scoped `AgentChatBroker` and `pilink://agent-chat` resource;
- authenticated chat author provenance and per-connection instance identity;
- leased `AgentTaskStore` lifecycle;
- verified collaboration bootstrap, roles, prompts, and resumable sessions;
- durable `agent_work_*` waiting/list/release lifecycle;
- governed read-only agent-memory projections;
- metadata-only tool audit and progress;
- optional execution approval and hardened constrained-run behavior;
- bundled Python/Textual `pilink chat` monitor.

The original public tool namespaces remain visible where their services are
available:

- `agent_chat_*`;
- `agent_task_*`;
- `agent_work_*`;
- `agent_memory_*`;
- `collaboration_bootstrap`;
- `get_system_prompt`;
- `run`.

Private collaboration data must remain outside the workspace. An unsafe data
layout disables/fails the collaboration layer closed rather than silently
placing authority state inside the repository.

## Additive PiLink behavior

- VS Code sidebar and wide dashboard;
- Integrated Browser launch for the OpenAI-controlled UI;
- graphical hosting, access, recovery, and OAuth workflows;
- existing-domain and Cloudflare Named Tunnel management;
- local protected administrative status and controls;
- MCP client/session, collaboration, and metadata-only activity projections;
- supervised Pi agent operations: spawn, list, status, output, follow-up,
  cancel, and stop;
- Pi Local chat with preserved provider/model/login selection;
- native VS Code MCP client compatibility;
- exact Node.js 24.18.0 runtime contract;
- release-package secret scanning.

The supervised local agent runtime is additive. It does not pretend that a
spawned Pi agent is a new remote ChatGPT conversation.

## Login preservation

PiLink keeps three authentication domains separate:

1. **ChatGPT plugin → PiLink MCP OAuth**, including DCR and the manual
   user-defined compatibility path.
2. **VS Code local administration/native MCP**, using protected host-side
   credentials.
3. **Pi Local model provider**, retaining existing credentials, browser OAuth,
   device-code OAuth, and API-key modes supported by the Pi runtime.

No login path is removed merely because it is not part of the recommended
ChatGPT Work onboarding. A Pi provider login cannot replace MCP OAuth, and MCP
OAuth cannot replace a provider login.

## Attribution and license

The repository uses the MIT License with the PiLink contributors' copyright
notice. Redistributions must preserve that notice and the MIT terms in
substantial copies.

PiLink builds on the Pi Agent ecosystem, including
[`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent).
Dependency license and notice review remains a release responsibility.

The selectively imported files above were authored upstream by Rocco Angelella
and the PiLink contributors. Their exact source authority is
[`roccoangelella/PiLink@b629c0ee`](https://github.com/roccoangelella/PiLink/tree/b629c0ee004b7e792125158879c55ee00bd89310),
and [NOTICE](../NOTICE.md) preserves that attribution. The protocol snapshots in
[`docs/upstream`](upstream/) carry their exact commit links and are review
evidence, not a PiLink claim of authorship or complete integration.

## Synchronization procedure

For each upstream update:

1. record the exact old and new upstream commits;
2. inspect master and feature histories independently;
3. classify changes as security, protocol, tool contract, data migration, UI,
   test, or documentation;
4. preserve PiLink additions without renaming upstream public tools;
5. update or migrate private state explicitly;
6. run original upstream tests plus PiLink integration tests;
7. verify OAuth session isolation and collaboration disposal over real HTTP;
8. verify CLI, VS Code, Pi Local, and headless operation;
9. update [Functional parity](FUNCTIONAL_PARITY.md), this commit table, and
   release notes in the same reviewed change.

Do not use a branch name, merged PR title, or green build alone as evidence of
parity.
