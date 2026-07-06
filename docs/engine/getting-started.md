---
title: Getting started
description: Install the Loom engine and run your first agent in code — one-shot, then streaming.
type: howto
---

# Getting started

At the end of this page you've run an agent from code, both as a one-shot call and as a live stream.

> **Prerequisites** — Node ≥ 22. A provider key: set one of `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_API_KEY`.

## 1. Install

```bash
bun add @ownware/loom      # bun
npm install @ownware/loom  # npm
```

`@vscode/ripgrep` auto-installs the correct platform binary for the `grep` tool via postinstall — no manual setup.

## 2. One-shot run

```ts title="run.ts"
import { Loom } from '@ownware/loom'

const result = await Loom.run('anthropic:claude-sonnet-4-6', 'What is 2+2?')
console.log(result.text)   // "4"
console.log(result.usage)  // { inputTokens, outputTokens, cacheReadTokens, model, costUsd, ... }
```

```bash
npx tsx run.ts
```

## 3. Stream events instead

Loom's loop is an `AsyncGenerator<LoomEvent>` — filter in a `for await`:

```ts
import { Loom, filesystemTools } from '@ownware/loom'

for await (const event of Loom.stream('sonnet', 'Summarize package.json', {
  tools: filesystemTools,
})) {
  if (event.type === 'text.delta') process.stdout.write(event.text)
  if (event.type === 'tool.call.start') console.log(`→ ${event.toolName}(${JSON.stringify(event.input)})`)
}
```

`'sonnet'`, `'opus'`, `'haiku'` are short aliases — see [Providers](providers.md).

## Verify it works

Run the streaming script; you should see the model's text print incrementally, and a `→ readFile(...)` line when it reads `package.json`. That's the loop calling a tool and streaming the result.

## Next steps

- [Call patterns](call-patterns.md) — one-shot, streaming, builder, and full sessions.
- [Built-in tools](built-in-tools.md) — the filesystem/shell/browser kit.
- [Streaming events](streaming.md) — the full event vocabulary.
