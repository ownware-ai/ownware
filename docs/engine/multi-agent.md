---
title: Multi-agent coordination
description: Compose sub-agents in code with fanOut, pipeline, and mapReduce — each isolated so no context leaks back to the parent.
type: concept
---

# Multi-agent coordination

Loom spawns sub-agents and coordinates them in three shapes. Each sub-agent runs with **isolated tool lists, messages, and config** (`isolator.ts`) — no context leaks back to the parent.

```ts
import {
  fanOut, pipeline, mapReduce,
  AnthropicProvider, builtinTools, createDefaultConfig,
} from '@ownware/loom'

// The coordination options every worker runs with. fanOut/pipeline build the
// isolated AgentSpawner internally from these — you don't pass a spawner.
const opts = {
  provider: new AnthropicProvider(),
  tools: builtinTools,
  config: createDefaultConfig('sonnet'),
}
```

Each worker is an **`AgentSpec`** — `{ name, systemPrompt?, model?, tools?, maxTurns? }`. There is no `prompt` field; a worker's role is its `systemPrompt`.

## Parallel fan-out

Run independent agents at once and collect all results:

```ts
const results = await fanOut(
  [
    { name: 'security-review', systemPrompt: 'Audit auth.ts for CVEs; list findings.' },
    { name: 'perf-review',     systemPrompt: 'Find hot loops in loop.ts; list them.' },
    { name: 'style-review',    systemPrompt: 'Check naming conventions; list issues.' },
  ],
  opts,
) // → AgentResult[]  (results[i].content)
```

## Sequential pipeline

Chain agents so each stage receives the previous stage's output. You pass one initial
`input` string; the engine threads each result into the next stage (no per-stage function):

```ts
const final = await pipeline(
  [
    { name: 'researcher', systemPrompt: 'Gather the key facts on the topic you are given.' },
    { name: 'writer',     systemPrompt: 'Draft a clear article from the facts you receive.' },
    { name: 'reviewer',   systemPrompt: 'Critique and polish the draft you receive.' },
  ],
  'The history of the printing press',  // initial input
  opts,
) // → AgentResult  (final.content)
```

## Map-reduce

`mapReduce` fans a list of items out to workers and folds their outputs back into one result — the shape for "process N things, then combine."

## Isolation is the guarantee

Every sub-agent gets its own tool list, message history, and config, and returns only its output. That isolation is what makes fan-out safe: a worker exploring a dead end can't pollute the parent's context or another worker's. The parent decides what each child can do; the child can't reach back.

## The spawner

`AgentSpawner` is the factory the coordination functions build internally to create the isolated child sessions. `fanOut`/`pipeline`/`mapReduce` construct it for you from `opts.{provider, tools, config}`; reach for `AgentSpawner` directly only when you want to spawn and manage children yourself.

## Next steps

- [Security](security.md) — sub-agents can be given a stricter posture than the parent.
- [Call patterns](call-patterns.md) — each sub-agent runs the same engine.
- [Streaming events](streaming.md) — `agent.spawn` / `agent.complete` events track orchestration.
