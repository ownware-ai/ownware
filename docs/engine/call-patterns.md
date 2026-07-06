---
title: Call patterns
description: The four equivalent ways to run a Loom agent — one-shot, streaming, builder, and full session — pick the one that matches how much control you need.
type: reference
---

# Call patterns

Loom gives you four ways to run an agent. They share the same engine; they differ in how much you compose up front and how you consume output.

## 1. One-shot — `Loom.run`

Collects the whole run and returns the result. Simplest.

```ts
const { text, usage, turnCount, reason } = await Loom.run('sonnet', 'Explain monads')
// `reason` tells you WHY the run ended — e.g. 'completed', 'max_turns', 'aborted',
// 'budget_exceeded' — so you can distinguish a real answer from a truncated one.
```

## 2. Streaming — `Loom.stream`

Yields every event as it happens. Use when you want live output or to react to tool calls.

```ts
for await (const e of Loom.stream('gpt-4o', 'Write a haiku')) {
  if (e.type === 'text.delta') process.stdout.write(e.text)
}
```

See [Streaming events](streaming.md) for the full `type` vocabulary.

## 3. Builder — `Loom.create(...).build()`

Composable and re-runnable. Shape an agent once, invoke it many times.

```ts
const agent = Loom.create('sonnet')
  .withSystemPrompt('You are a legal analyst')
  .withTools(filesystemTools)
  .withMaxTurns(20)
  .withPermissionMode('ask')
  .build()

for await (const e of agent.run('Analyze this contract')) { /* ... */ }
```

## 4. Full session — `new Session(...)`

Multi-turn conversations that remember prior context. **Compaction and checkpointing live at this layer.**

```ts
import { Session, AnthropicProvider, builtinTools, createDefaultConfig } from '@ownware/loom'

const session = new Session({
  config: createDefaultConfig('sonnet'),  // takes a model string, not an object
  provider: new AnthropicProvider(),
  tools: builtinTools,
})

for await (const e of session.submitMessage('Remember: code is ALPHA-7')) {}
for await (const e of session.submitMessage('What is the code?')) {
  if (e.type === 'text.delta') process.stdout.write(e.text) // "ALPHA-7"
}
```

## Collecting results

Helpers turn a stream back into a value when you don't want to write the `for await` yourself:

```ts
import { collectText, collectResult, filterEvents } from '@ownware/loom'

const text = await collectText(agent.run('Hello'))
const { text, usage, turnCount } = await collectResult(agent.run('Hello'))
for await (const e of filterEvents(agent.run('Hello'), 'tool.call.end')) {
  console.log(`${e.toolName} took ${e.durationMs}ms`)
}
```

## Next steps

- [Built-in tools](built-in-tools.md) and [Custom tools](custom-tools.md)
- [Compaction & state](context.md) — where Session's memory management lives
- [Streaming events](streaming.md)
