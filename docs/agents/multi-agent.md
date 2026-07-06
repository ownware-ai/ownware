---
title: Multi-agent teams
description: One lead agent coordinating named specialist subagents — how the subagents array becomes a working team.
type: concept
---

# Multi-agent teams

Some jobs are too big for one agent's attention. A **team profile** has a lead agent that delegates to named **subagents**, each with its own isolated tools, messages, and config — so a specialist's context never leaks back and confuses the lead.

**For AI agents:** declare subagents in the profile's `agent.json` as `"subagents": [{ "name", "description" }]`. At runtime the lead spawns them via the engine's `agent_spawn` tool; each runs in isolation (`isolator.ts` — separate tool list, messages, config) and returns only its result. For programmatic orchestration outside a profile, `@ownware/loom` exports `fanOut` (parallel), `pipeline` (sequential, each stage gets the previous result), `mapReduce`, and `AgentSpawner`.

## When to use a team

- The work splits into distinct roles (research, then drafting, then review).
- You want parallel coverage — several specialists working at once on independent parts.
- One agent would otherwise thrash between unrelated modes.

If a single agent with the right tools can do the job, keep it single — teams add coordination cost.

## Declaring a team

Subagents live in the lead's `agent.json`. This is the legal desk from [Example profiles](example-profiles.md):

```json title="profiles/ownware-law/agent.json (excerpt)"
{
  "name": "ownware-law",
  "subagents": [
    { "name": "researcher", "description": "Finds case law, statutes, precedent" },
    { "name": "analyst",    "description": "Deep-reads contracts; extracts terms & risks" },
    { "name": "drafter",    "description": "Writes contracts, memos, briefs" },
    { "name": "checker",    "description": "Scans against GDPR/HIPAA/SOC2/CCPA" }
  ]
}
```

The lead reads each `description` to decide which specialist to hand a task to. Private specialist implementations can live in the profile's `helpers/` folder, spawnable only by their parent.

## Coordination patterns

Programmatically, the engine gives you three shapes:

```ts
import {
  fanOut, pipeline,
  AnthropicProvider, builtinTools, createDefaultConfig,
} from '@ownware/loom'

// Shared coordination options: the provider, tools, and config every worker runs with.
const opts = {
  provider: new AnthropicProvider(),
  tools: builtinTools,
  config: createDefaultConfig('sonnet'),
}

// Parallel — independent reviews at once. Each spec is an AgentSpec
// ({ name, systemPrompt?, model?, tools?, … }); systemPrompt is the role.
const results = await fanOut(
  [
    { name: 'security-review', systemPrompt: 'Audit auth.ts for CVEs; list findings.' },
    { name: 'perf-review',     systemPrompt: 'Find hot loops in loop.ts; list them.' },
  ],
  opts,
) // → AgentResult[] — results[i].content

// Sequential — the initial `input` flows through; each stage receives the
// PREVIOUS stage's output as its input (no per-stage prompt function).
const final = await pipeline(
  [
    { name: 'researcher', systemPrompt: 'Gather the key facts on the topic you are given.' },
    { name: 'writer',     systemPrompt: 'Draft a clear article from the facts you receive.' },
    { name: 'reviewer',   systemPrompt: 'Critique and polish the draft you receive.' },
  ],
  'The history of the printing press', // initial input, threaded stage → stage
  opts,
) // → AgentResult — final.content
```

Isolation is the guarantee that makes this safe: each subagent gets its own tool list, message history, and config, and returns only its output.

## Next steps

- [Example profiles](example-profiles.md) — real teams (`ownware-law`, `ownware-finance`, `ownware-security`).
- [Profile format](profile-format.md) — where `subagents` sits in `agent.json`.
- [Engine deep dive](../../packages/loom/README.md) — `fanOut`/`pipeline`/`mapReduce` in full.
