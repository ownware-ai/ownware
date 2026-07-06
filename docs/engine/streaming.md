---
title: Streaming events
description: Loom's loop is an AsyncGenerator of typed events — the public contract every consumer filters on. Here's the full vocabulary.
type: reference
---

# Streaming events

Loom's loop is a provider-agnostic `AsyncGenerator<LoomEvent>`. Every event has a `type` discriminator; you filter in a `for await`. No event emitter, no callbacks.

```ts
for await (const e of Loom.stream('sonnet', 'Summarize package.json', { tools })) {
  switch (e.type) {
    case 'text.delta': process.stdout.write(e.text); break
    case 'tool.call.start': console.log(`→ ${e.toolName}`); break
  }
}
```

## The event vocabulary

| Event type | When |
|---|---|
| `session.start` / `session.end` | Top-level session boundaries |
| `turn.start` / `turn.end` | Each model call |
| `text.delta` / `text.complete` | Streamed assistant text |
| `thinking.delta` / `thinking.complete` | Extended thinking (Claude) |
| `tool.call.start` / `tool.call.args_delta` / `tool.call.progress` / `tool.call.end` | Full tool-call lifecycle |
| `tool_result.drop` | A tool result was dropped by compaction to reclaim context |
| `agent.spawn` / `agent.complete` | Sub-agent orchestration |
| `permission.request` / `permission.response` | Human-in-the-loop tool approvals |
| `credential.request` / `credential.response` | Human-in-the-loop credential prompts (a tool needs a secret) |
| `compaction.start` / `compaction.end` | Automatic compaction |
| `context.pressure` | Context approaching the window |
| `cache.status` | Prompt-cache hit / miss / write |
| `checkpoint.saved` | Session state persisted |
| `security.block` / `security.redact` | Zone- or rule-triggered denial / redaction |
| `audit.entry` | Structured audit-log entry |
| `recovery` | Recoverable retry after a provider error |
| `error` | Fatal |

This is the **public contract** — the same vocabulary Ownware's gateway forwards over SSE, so a client written against Loom events works against Ownware too.

## Helpers

When you don't want to write the `for await` yourself:

```ts
import { collectText, collectResult, filterEvents } from '@ownware/loom'

const text = await collectText(agent.run('Hello'))
const { text, usage, turnCount } = await collectResult(agent.run('Hello'))
for await (const e of filterEvents(agent.run('Hello'), 'tool.call.end')) {
  console.log(`${e.toolName} took ${e.durationMs}ms`)
}
```

## Next steps

- [Call patterns](call-patterns.md) — every pattern yields these events.
- [Security](security.md) — the `security.*` and `permission.*` events.
- [Compaction & state](context.md) — `compaction.*` and `checkpoint.saved`.
