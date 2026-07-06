/**
 * Hook Types
 *
 * Lifecycle hooks let consumers (Cortex profiles) inject behaviour at
 * fixed event points in the agent loop without forking the engine. A
 * hook can:
 *   - block an action (return `continue: false`)
 *   - emit a success / context reminder for the model to see next turn
 *   - log, audit, or notify external systems
 *
 * Hook implementations come in two flavours: a JS function (`fn`) for
 * typed in-process behaviour, or a shell command (`command`) following
 * the long-standing cross-language hook convention (context as JSON on
 * stdin, exit code decides continue, stdout JSON as structured result —
 * the same contract git hooks, husky, and CI systems established).
 * Loom extends that convention with the `fn` flavour, model-visible
 * outcomes via the reminder injector, and a reserved third variant —
 * `agent` (run a subagent profile as the hook) — for a later
 * cortex-side wire-up.
 *
 * Not to be confused with `tools/hooks.ts` (`ToolHookRegistry`) — that
 * is the PROGRAMMATIC per-tool interceptor for embedders (before/after
 * one tool, with input-mutation power), consumed by the single-tool
 * executor. THIS module is the lifecycle surface profiles bind to.
 * They stay separate on purpose: input-mutation power must not become
 * profile-declarable (see the cortex trust model).
 *
 * Outcomes route through the reminder injector so the model sees what
 * happened. Loom wires nothing about *what* a hook does — only when it
 * runs, with what context, and how its result is reflected back.
 */

import type { ContentBlock } from '../messages/types.js'

// ---------------------------------------------------------------------------
// Event lifecycle
// ---------------------------------------------------------------------------

/**
 * Lifecycle points at which hooks fire. Names follow the dotted style
 * already used by `LoomEvent` (e.g. `tool.call.start`).
 *
 * `session.start`        — once, at the top of `loop()` before the first turn.
 * `user.prompt.submit`   — RESERVED: declared for the "gate/annotate the
 *                          incoming message" use case, but not fired by
 *                          Session/loop yet. Registering a hook here is a
 *                          no-op until the emit lands — documented as
 *                          reserved so nobody ships a gate that never runs.
 * `tool.pre`             — before each tool execution, after the model requested it.
 * `tool.post`            — after each tool completes (only when it actually ran).
 * `model.pre`            — before each provider call (every attempt, including
 *                          retries after compaction / rate-limit recovery).
 *                          Fired BEFORE the reminder drain, so a hook's
 *                          `additionalContext` lands on THIS request.
 *                          INFORMATIONAL: `continue: false` is ignored.
 * `model.post`           — after each successful provider response, once the
 *                          assistant message is recorded — carries stop reason,
 *                          usage counters, and the tool-call count. Metering /
 *                          latency / cost hooks anchor here. INFORMATIONAL.
 * `session.end`          — once, on every loop exit path (normal end, abort,
 *                          max turns, budget, error). INFORMATIONAL: the
 *                          session is already over, so `continue: false`
 *                          is ignored — mirrors the post-* hooks of the
 *                          standard hook convention, which cannot abort.
 * `error`                — when the loop ends with an unrecoverable error,
 *                          just before the `session.end` hook. INFORMATIONAL.
 */
export type HookEvent =
  | 'session.start'
  | 'user.prompt.submit'
  | 'tool.pre'
  | 'tool.post'
  | 'model.pre'
  | 'model.post'
  | 'session.end'
  | 'error'

// ---------------------------------------------------------------------------
// Per-event context
// ---------------------------------------------------------------------------

/**
 * Discriminated context passed to a hook. Each variant carries only the
 * fields meaningful to its event. Hooks pattern-match on `event`.
 */
export type HookContext =
  | {
      readonly event: 'session.start'
      readonly turnIndex: number
      readonly sessionId: string
      readonly model: string
    }
  | {
      readonly event: 'user.prompt.submit'
      readonly turnIndex: number
      readonly prompt: string | ContentBlock[]
    }
  | {
      readonly event: 'tool.pre'
      readonly turnIndex: number
      readonly toolName: string
      readonly toolInput: Record<string, unknown>
    }
  | {
      readonly event: 'tool.post'
      readonly turnIndex: number
      readonly toolName: string
      readonly toolInput: Record<string, unknown>
      readonly result: string
      readonly isError: boolean
    }
  | {
      readonly event: 'model.pre'
      readonly turnIndex: number
      /** The model about to be called (may be the fallback mid-session). */
      readonly model: string
      /** Conversation length at call time (message count, cheap signal). */
      readonly messageCount: number
    }
  | {
      readonly event: 'model.post'
      readonly turnIndex: number
      readonly model: string
      /** Provider stop reason verbatim (`end_turn`, `tool_use`, `max_tokens`, …). */
      readonly stopReason: string
      readonly inputTokens: number
      readonly outputTokens: number
      readonly costUsd: number
      /** Tool calls the model requested in this response (0 = it answered). */
      readonly toolCallCount: number
    }
  | {
      readonly event: 'session.end'
      readonly turnIndex: number
      readonly sessionId: string
      /**
       * Why the session ended — the loop's StopReason verbatim:
       * `end_turn`, `aborted`, `max_turns`, `budget_exceeded`, `error`,
       * `max_tokens`, `refusal`, `pause_turn`, `stop_sequence`. Typed
       * as string so this module stays decoupled from core/events.
       */
      readonly reason: string
    }
  | {
      readonly event: 'error'
      readonly turnIndex: number
      /** Machine code (e.g. a provider error code, or 'UNKNOWN'). */
      readonly code: string
      readonly message: string
    }

// ---------------------------------------------------------------------------
// Hook return shape
// ---------------------------------------------------------------------------

/**
 * What a hook returns. All fields optional; an empty object is "allow,
 * say nothing." A command hook can produce this shape by writing JSON
 * to stdout; otherwise stdout is treated as `output` and the exit code
 * decides `continue`.
 */
export interface HookResult {
  /** When false, the action is blocked. Default: true. */
  readonly continue?: boolean
  /** Reason for a block. Surfaced in the `hook.blocked` reminder. */
  readonly reason?: string
  /** Free-text output. Surfaces in the `hook.success` reminder when present. */
  readonly output?: string
  /** Extra context for the model. Surfaces in the `hook.context` reminder. */
  readonly additionalContext?: string
}

// ---------------------------------------------------------------------------
// Hook definitions
// ---------------------------------------------------------------------------

export type HookFn = (ctx: HookContext) => Promise<HookResult> | HookResult

/**
 * Discriminated union of hook implementations.
 *
 *   - `fn`      — in-process JS function. Runs in the agent's process.
 *   - `command` — shell command. Receives the context as JSON on stdin.
 *
 * A future `agent` variant (run a subagent profile as the hook) is
 * intentionally not part of this union yet — that wiring lives in
 * Cortex and will land alongside the helper-spawn API.
 */
export type HookSpec =
  | {
      readonly type: 'fn'
      readonly name: string
      readonly fn: HookFn
      readonly timeoutMs?: number
    }
  | {
      readonly type: 'command'
      readonly name: string
      readonly command: string
      readonly timeoutMs?: number
    }

// ---------------------------------------------------------------------------
// Aggregate run result
// ---------------------------------------------------------------------------

export interface HookRunResult {
  /** True iff every hook returned (or omitted) `continue: true`. */
  readonly continue: boolean
  /** When blocked, the reason from the first blocking hook. */
  readonly blockedReason?: string
  /** When blocked, the `name` of the blocking hook. */
  readonly blockedHook?: string
}
