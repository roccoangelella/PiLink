# Usage, models, and costs

This page separates VSPiLink behavior from OpenAI and third-party provider
pricing. It was reviewed against current official OpenAI documentation on
2026-08-04; always check the live pages before making a purchasing decision.

## The short version

- Current official ChatGPT web documentation supports plugins and their remote
  MCP tools in **ChatGPT Work**, not in normal Chat.
- **ChatGPT Work and Codex share usage, credits, and limits.** Moving from
  Codex to Work is a workflow change, not a documented way to move consumption
  to a cheaper normal-Chat allowance.
- ChatGPT Pro offers higher included Codex/Work usage than Plus in the current
  pricing model. It does **not** enable VSPiLink MCP tools in normal Chat.
- VSPiLink itself does not provide OpenAI inference and cannot inspect, reset,
  or guarantee a user's OpenAI allowance.
- Pi Local uses the chosen provider. OAuth, subscription, API-key billing,
  rate limits, and model availability remain that provider's responsibility.
- "Maximize included inference" means choosing an appropriate model and tight
  task scope. It never means infinite or free inference.

Official sources:

- [Use ChatGPT](https://learn.chatgpt.com/docs/use-chatgpt)
- [Get started with ChatGPT Work](https://learn.chatgpt.com/docs/get-started-with-work)
- [Pricing and usage limits](https://learn.chatgpt.com/docs/pricing)
- [Plugins](https://learn.chatgpt.com/docs/plugins)
- [MCP](https://learn.chatgpt.com/docs/extend/mcp)

## Surface and consumption model

| Surface | Can use the VSPiLink plugin/MCP? | Consumption owner |
| --- | --- | --- |
| Normal Chat | No, under the current official plugin model | The user's normal Chat plan rules |
| ChatGPT Work | Yes, when the plugin is installed and allowed | Shared Work/Codex usage and credits |
| Codex host | Yes, through Codex MCP configuration where supported | Shared Work/Codex usage, or API billing when explicitly using an API key |
| Pi Local | Yes, through the local Pi runtime rather than the ChatGPT plugin | The selected provider/account/API key |

OpenAI states that feature availability can also depend on plan, platform,
region, rollout, and workspace settings. An organization administrator may
disable Work, plugins, or individual tools.

## Sol, Terra, and Luna

OpenAI currently describes the GPT-5.6 family by workload:

| Model strategy | Use when | Cost-control tradeoff |
| --- | --- | --- |
| **Sol** | The task is genuinely difficult: ambiguous architecture, complex reasoning, advanced coding, or high-stakes review | Reserve it for work where deeper reasoning materially changes the result |
| **Terra** | Everyday production work: implementation, reports, document analysis, routine coding, and sound judgment | Recommended default for balanced capability and consumption |
| **Luna** | Fast, focused, high-volume work: routing, extraction, classification, support, background automation, and bounded coding tasks | Best opportunity to stretch included usage when the task does not need Sol/Terra depth |

These are routing heuristics, not guarantees. Actual consumption varies with
context size, reasoning, tool calls, retrieval, caching, task duration, and the
result produced. A small-looking request can become expensive if it repeatedly
loads a large repository or invokes many tools.

### Practical routing

1. Start routine repository inspection, small edits, test fixes, and
   documentation on Terra or Luna.
2. Escalate to Sol for hard architecture, subtle debugging, complex security
   review, or repeated failure on a smaller model.
3. Return to Terra or Luna for mechanical follow-up after the hard decision is
   resolved.
4. Use separate, bounded tasks instead of asking one long session to retain an
   entire organization or home directory indefinitely.

VSPiLink does not automatically override the model selected in ChatGPT Work.
The user or active OpenAI surface remains authoritative.

## Make included usage last longer

The current OpenAI pricing guide recommends several practices that also fit
VSPiLink:

- give precise instructions and remove irrelevant context;
- expose only the source files or directories required for the task;
- define the expected output, acceptance criteria, and stopping point;
- disable MCP servers that are not needed for the current task;
- use Terra or Luna for routine work when their capability is sufficient;
- split discovery, implementation, and review into explicit bounded phases;
- ask for a short Git diff or targeted test instead of an unrestricted scan;
- avoid repeatedly sending generated logs or large tool results back into the
  model.

Workspace confinement is useful for cost control as well as security: it
reduces the set of paths the model may inspect by accident.

## What a higher plan changes

Current OpenAI pricing advertises higher included Work/Codex usage for Pro
tiers than Plus. Exact rates and plan prices can change, and tasks do not have a
fixed message cost. Upgrading may increase available capacity, but it does not:

- create an unlimited inference entitlement;
- guarantee that a specific model remains available;
- move plugin-backed MCP calls into normal Chat;
- remove workspace or administrator policy;
- pay for a separate third-party provider used by Pi Local;
- make Full access safer.

Use the live [OpenAI pricing page](https://learn.chatgpt.com/docs/pricing) and
the usage view linked there for current limits.

## API-key use

If a Codex or Pi Local workflow is deliberately authenticated with an API key,
usage may be billed through that API account instead of an included ChatGPT
allowance. Do not add an API key merely to work around a UI or OAuth setup
problem. It changes the billing and trust model and does not turn normal Chat
into an MCP client.

Keep API keys out of:

- the Git workspace;
- `.env` examples committed to source control;
- ChatGPT prompts and collaboration chat;
- screenshots and logs;
- VS Code webview state.

Use the extension's protected credential input/SecretStorage path or the
provider's supported credential store.

## Claims VSPiLink documentation must not make

- "Chat is cheaper than Work for the same VSPiLink task."
- "Work does not consume Codex credits."
- "Pro unlocks MCP in normal Chat."
- "Pi Local is free."
- "Luna provides unlimited messages."
- "One prompt has a predictable fixed cost."
- "VSPiLink can see or manage your OpenAI balance."

The supportable claim is narrower: VSPiLink helps users keep tasks, workspace
scope, model choice, and enabled tools intentional so they can make better use
of whatever inference their chosen plan or provider includes.
