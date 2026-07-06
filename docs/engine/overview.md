---
title: Loom overview
description: Loom is the open-source agent engine that powers Ownware — the full while(true) agent loop, exposed as a zero-dependency TypeScript library you drive from code.
type: concept
---

# Loom

**Loom is the agent runtime engine — the full engine, exposed as a library.** It's the `while(true)` loop underneath Ownware: it calls models, executes tools, streams every event, enforces security, compacts context, and coordinates sub-agents. Ownware wraps Loom behind profiles and a gateway; Loom is what you reach for when you want to build an agent **in code**, with full control and no opinions.

```ts
import { Loom } from '@ownware/loom'

const result = await Loom.run('anthropic:claude-sonnet-4-6', 'What is 2+2?')
console.log(result.text)   // "4"
console.log(result.usage)  // { inputTokens, outputTokens, cacheReadTokens, model, costUsd, ... }
```

**For AI agents:** `@ownware/loom` is a zero-dependency, strict-TypeScript, ESM library. Four call patterns: `Loom.run(model, prompt, opts?)` (one-shot → `{text, usage, turnCount}`), `Loom.stream(...)` (`AsyncGenerator<LoomEvent>`), `Loom.create(model).with*().build()` (builder), `new Session({config, provider, tools})` (multi-turn). Tools are `defineTool({name, description, inputSchema, execute})`. Security composes from three independent layers (input guards, zones, permissions). Providers built in: `anthropic`/`openai`/`google`/`openrouter`/`ollama`; `registerProvider()` for custom. Set `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`GOOGLE_API_KEY`/`OPENROUTER_API_KEY` (Ollama is keyless). Package: [`packages/loom`](../../packages/loom).

## Loom or Ownware?

Both build agents — the difference is altitude.

| Use **Ownware** when… | Use **Loom** when… |
|---|---|
| You want an agent as a text profile, served over HTTP, reachable from channels | You're embedding an agent directly in your own app, in code |
| You want the gateway, threads, connectors, credential vault, schedules | You want the raw loop and to compose everything yourself |
| Most people, most of the time | You're a developer who wants full, low-level control |

Ownware *is* Loom underneath — anything Ownware does, Loom can do in code, minus the product surface (profiles, gateway, channels). If you outgrow profiles, drop to Loom.

## What you get out of the box

- **Deep filesystem access** — `readFile`, `writeFile`, `editFile`, `listFiles`, `glob`, and a **ripgrep-powered** `grep` (regex, multiline, `.gitignore`-aware, output caps)
- **Shell execution** with a 5-level security classifier
- **Full browser automation** (Chrome DevTools Protocol)
- **MCP client** over stdio / SSE / HTTP / WebSocket with OAuth2 PKCE
- **Sub-agent spawning** — parallel fan-out, pipelines, map-reduce
- **Streaming everything** — text, thinking, tool progress, cache status, security blocks — as an `AsyncGenerator`
- **Zone-based security** (7 levels) with **combination rules** that block dangerous multi-step patterns
- **Input guards** — declarative per-tool policies that reject bad calls before execution
- **Automatic compaction**, **checkpointing** (memory / file built-in; implement `CheckpointStore` for Postgres/S3/…), prompt caching, pricing math, retry with jitter, provider fallback

## Architecture at a glance

```
User ──► Session ──► Loop ──► Provider.stream() ──► Tools ──► Loop ──► ...
            ▲          ▲           ▲                  ▲
         Checkpoint  Compaction  Permissions       Guards + Zones
```

Everything flows through the `while(true)` loop. Providers stream chunks; tools execute (parallel reads, serial writes); guards and zones gate every call; compaction manages history; checkpoints persist state.

## Design principles

- **No framework dependencies.** Raw Node, direct SDK calls, no magic.
- **Strict TypeScript.** `strict: true`, no `any`, `readonly` config.
- **AsyncGenerator everywhere.** Consumers pull at their own pace — no event emitters.
- **Discriminated unions.** Every event, error, and config variant has a `type`.
- **Fail loudly.** Invalid state throws immediately.
- **Unopinionated engine.** No default prompt, no pre-selected tools, no baked-in safety — you compose the posture you want.

## Next steps

- [Getting started](getting-started.md) — install and run your first agent.
- [Call patterns](call-patterns.md) — the four ways to run an agent.
- [Built-in tools](built-in-tools.md) — the batteries-included tool kit.
- [Custom tools](custom-tools.md) — give the agent your own logic.
- [Providers](providers.md) · [Streaming events](streaming.md) · [MCP](mcp.md) · [Multi-agent](multi-agent.md) · [Compaction & checkpointing](context.md) · [Hooks](hooks.md).
- [Security](security.md) — the three composable layers.
- [CLI](cli.md) — run a Loom agent from the terminal with `npx @ownware/loom`.
