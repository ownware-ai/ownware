---
title: Compaction, checkpointing & prompt assembly
description: How Loom manages long conversations — automatic compaction, state persistence, and building the system prompt from composable fragments.
type: concept
---

# Compaction, checkpointing & prompt assembly

Three systems keep a long-running agent coherent: **compaction** trims history when it fills, **checkpointing** persists state, and **prompt assembly** builds the system prompt from fragments. All live at the [Session](call-patterns.md#4-full-session--new-session) layer.

## Compaction

When history approaches the context window, Loom rewrites it:

```ts
const config = {
  compaction: {
    trigger: { type: 'fraction', threshold: 0.80 },  // fire at 80% full
    retain: { type: 'messages', count: 6 },           // keep last 6 turns raw
    strategy: 'summarize',                            // 'truncate' | 'sliding_window' | 'hierarchical' | 'snapshot'
  },
}
```

`strategy` is one of the named presets above (`summarize` · `truncate` · `sliding_window` · `hierarchical` · `snapshot`) — it's a string, not an interface you implement. Compaction emits `compaction.start` / `compaction.end` events, and `context.pressure` fires as the window fills.

## Checkpointing

Persist and restore session state:

```ts
import { FileCheckpointStore, Session } from '@ownware/loom'

const store = new FileCheckpointStore('./checkpoints')
const session = new Session({ config, provider, tools, checkpoint: store })

// Auto-saved after each tool turn. To restore, load the checkpoint and map it
// into SessionState — the two shapes differ, and load() can return null:
const cp = await store.load(sessionId)   // Checkpoint | null
if (cp) {
  session.restore({
    sessionId: cp.sessionId,
    messages: cp.messages,
    turnCount: cp.turnIndex,
    totalUsage: { ...cp.usage, model: config.model },
    createdAt: cp.timestamp,
    updatedAt: cp.timestamp,
  })
}
```

Ships with `MemoryCheckpointStore` and `FileCheckpointStore`. Implement the `CheckpointStore` interface (`save` / `load` / `list` / `delete`) for Postgres, S3, Redis — anything. Each save emits `checkpoint.saved`.

## Prompt assembly — fragments

Loom builds the system prompt from composable fragments. Use the defaults, replace specific slots, or build from scratch:

```ts
import {
  PromptBuilder,
  createIdentityFragment,
  createToolsFragment,
  createSafetyFragment,
  createMemoryFragment,
  createContextFragment,
} from '@ownware/loom'

const soulMd = 'You are Scout, a focused research assistant.'  // your SOUL.md text (or null)
const agentsMd = await readFile('./AGENTS.md', 'utf8').catch(() => '')  // your memory file, as a string

const prompt = new PromptBuilder()
  .addFragment(createIdentityFragment(soulMd))                  // (soulMd: string | null, label?)
  .addFragment(createToolsFragment(tools))                     // (tools: Tool[], options?)
  .addFragment(createSafetyFragment())                         // built-in "act with care" rules (label?)
  .addFragment(createMemoryFragment(agentsMd))                 // (agentsMd: string, label?)
  .addFragment(createContextFragment({ cwd: process.cwd() })) // { date?, platform?, cwd?, gitBranch? }
  .build()
```

**Project instructions & memory.** `createContextFragment` adds environment facts only — `date`, `platform`, `cwd`, `gitBranch` — it does **not** read any file. To inject `AGENTS.md`/project instructions, read the file yourself and pass its contents to `createMemoryFragment(agentsMd)`.

**Safety.** `createSafetyFragment()` injects Loom's built-in "act with care" guidance (its only argument is an optional `label`). It's steering, not enforcement — the real security floor is guards + zones (see [Security](security.md)).

**Skills.** `createSkillsFragment(skills)` injects reusable prompt + tool + guide triples; the skill matcher activates them based on the user message.

## Next steps

- [Call patterns](call-patterns.md) — Session is where all three live.
- [Streaming events](streaming.md) — the `compaction.*` / `checkpoint.saved` / `context.pressure` events.
- [Security](security.md) — where enforcement actually lives (guards + zones), below the prompt.
