---
title: Hooks
description: The engine's lifecycle hook system — run code at fixed points of the agent loop (session start, before/after tools, session end, error), block actions, and feed context back to the model.
type: concept
---

# Hooks

The engine has two hook layers, separated on purpose:

1. **Lifecycle hooks** (`hooks/`) — bind behavior to fixed points of the agent loop. This is the system `agent.json` hooks compile into, and the one embedders reach for first.
2. **Programmatic tool interceptors** (`tools/hooks.ts`) — wrap a single tool's execution with input-mutation power, for hosts embedding the engine in code.

They stay separate because input mutation must never become profile-declarable: a portable profile may observe, guard, and ask — it may not silently rewrite what a tool is about to do.

**For AI agents:** lifecycle hooks = `HookRegistry` + `HookRuntime` from `@ownware/loom`, passed to `new Session({ hooks, reminders })`. Events: `session.start`, `tool.pre`, `tool.post`, `model.pre`, `model.post`, `session.end`, `error` (plus `user.prompt.submit`, reserved — declared but not fired yet). A spec is `{ type: 'fn', name, fn }` or `{ type: 'command', name, command }`. A `tool.pre` hook returning `{ continue: false, reason }` blocks the tool with a synthesized denied result; `session.end`/`error` are informational (nothing left to block). Outcomes route through the `ReminderInjector` so the model sees them next turn. Profile authors should use the declarative surface instead: [agents/hooks.md](../agents/hooks.md).

## Lifecycle hooks

### The events

| Event | Fires | `continue: false` means |
|---|---|---|
| `session.start` | once, top of the loop | informational (recorded as a reminder; the run proceeds) |
| `user.prompt.submit` | **reserved** — declared in the event union but not fired by the loop yet | — |
| `tool.pre` | before each tool execution | **the tool never runs** — the model gets a denied result with your reason |
| `tool.post` | after each tool that actually ran | informational — post-hooks can't roll back, same as the standard hook convention (a git post-commit hook cannot abort the commit) |
| `model.pre` | before **each provider call attempt** (retries after compaction / rate-limit recovery fire it again). Fired before the reminder drain, so a hook's `additionalContext` lands on THIS request — the "inject fresh context per call" moment | ignored — observe/inject only |
| `model.post` | after each successful provider response, once the assistant message is recorded — carries `stopReason`, `inputTokens`/`outputTokens`/`costUsd`, `toolCallCount`. The metering moment | ignored |
| `session.end` | on **every** loop exit — normal end, abort, max-turns, budget, error — with the terminal `reason` | ignored |
| `error` | on unrecoverable failure, just before `session.end` | ignored |

`session.end` fires even on abort by design: an audit trail that skips aborted runs is not an audit trail.

### Wiring one up

```ts
import {
  Session, HookRegistry, HookRuntime,
  ReminderInjector, createDefaultRegistry,
} from '@ownware/loom'

const registry = new HookRegistry()

registry.register('tool.pre', {
  type: 'fn',
  name: 'no-prod',
  fn: (ctx) => {
    if (ctx.event !== 'tool.pre') return { continue: true }
    const target = String(ctx.toolInput['file_path'] ?? '')
    if (target.startsWith('/srv/prod')) {
      return { continue: false, reason: 'Production paths are off-limits in this session.' }
    }
    return { continue: true }
  },
})

registry.register('session.end', {
  type: 'fn',
  name: 'archive',
  fn: async (ctx) => {
    if (ctx.event === 'session.end') await archiveRun(ctx.sessionId, ctx.reason)
    return { continue: true }
  },
})

// ONE injector, shared by the runtime and the session — this is what
// makes hook outcomes visible to the model on its next turn.
const reminders = new ReminderInjector(createDefaultRegistry())
const hooks = new HookRuntime({ registry, reminders })

const session = new Session({ config, provider, tools, hooks, reminders })
```

Pass `hooks` and `reminders` **together**. The runtime emits its outcomes into that exact injector instance; passing one without the other silently drops the feedback loop.

### `command` specs — the standard shell-hook convention

```ts
registry.register('tool.pre', {
  type: 'command',
  name: 'policy-check',
  command: './hooks/check.sh',
  timeoutMs: 10_000,
})
```

The contract is the one git hooks, husky, and CI systems established: the event context arrives as **JSON on stdin**; **exit 0 allows, non-zero blocks** (stderr becomes the reason); stdout that parses as JSON is treated as a structured result — `{ "continue": false, "reason": "…" }`, `{ "output": "…" }`, or `{ "additionalContext": "…" }`. A timeout always blocks (fail closed); raise the window per spec with `timeoutMs` (default 5s).

### Outcomes reach the model

Hook results route through the reminder injector as `<system-reminder>` fragments on the next turn:

- `continue: false` → *hook X blocked the action: reason* — the model adapts instead of retrying.
- `output` → surfaced as hook output.
- `additionalContext` → injected context (e.g. a `session.start` hook loading fresh data).

This loop-back is the difference between a gate and a teacher: a blocked model that knows *why* changes course.

### Execution model

Hooks for an event run in registration order; the first `continue: false` stops the chain. The runtime never throws — executor errors, timeouts, and aborts all resolve to a block with a reason, so the loop can treat hook execution as total. When no hook is bound for an event, the loop's no-hook path is byte-identical to having no runtime at all.

## Programmatic tool interceptors

`ToolHookRegistry` (from `tools/hooks.ts`) wraps a **single tool's execution** for embedders: a before-hook can inspect, **rewrite the input**, or veto; an after-hook can inspect or **rewrite the result**. It is consumed by the single-tool executor and never reachable from a profile — the input-mutation power is exactly why.

Reach for it when your host application needs to transform calls in-process (inject a tenant id into every filesystem path, cache a tool's results, strip a field from outputs). For everything a profile should be able to declare — audit, notify, archive, approve, block — use lifecycle hooks.

## Hooks vs guards vs zones

| Mechanism | Job | Style |
|---|---|---|
| **Lifecycle hooks** | Observe, steer, ask, and gate at loop moments | Declarative (`agent.json`) or code |
| **Tool interceptors** | Rewrite one tool's input/output in-process | Imperative, embed-only |
| **Guards (`policies`)** | Reject bad **input** by pattern before execution | Declarative policy |
| **Zones + permissions** | Decide auto-run / ask / never — the security floor | Declarative + human-in-the-loop |

Hooks are steering and observability. The security floor the model can't talk past stays in [zones and permissions](security.md) — don't build containment out of hooks.

## Next steps

- [Hooks in agent.json](../agents/hooks.md) — the declarative surface: five actions incl. `approve` (pause for a human decision from web, terminal, or a chat channel), the trust model, operator env vars.
- [Security](security.md) — guards, zones, permission gates.
- [Streaming events](streaming.md) — observe the same lifecycle from outside the process instead.
