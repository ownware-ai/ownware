/**
 * Draft-hold (Slice 8d) — the heart of "draft for my approval".
 *
 * 8b-1 made a draft-approval run safe by WITHHOLDING write/send tools. 8d goes
 * a step further: a draft-approval run is HANDED those tools, but each one's
 * `execute` is WRAPPED so invoking it parks the call as an approval (the draft)
 * and returns a benign "queued for your approval — nothing sent" result to the
 * model, WITHOUT running the real side effect. The agent gets to do its full
 * job (read, reason, compose the email/edit) and stops at the send/write line;
 * the user approves later (the execute step lands with the approve API).
 *
 * Pure + dependency-light: the persistence coupling (which run, which store)
 * is the injected `HoldSink`, so this is unit-tested with a fake sink and fake
 * tools — no DB, no model. Read/write classification reuses `Tool.isReadOnly`
 * (the same source the team member-policy + 8b-1 use); unknown = mutating.
 */

import type { Tool, ToolResult } from '@ownware/loom'
import type { SafetyLevel } from './safety.js'

/** A held tool call handed to the sink (production: recorded as an approval). */
export interface HeldCall {
  readonly toolName: string
  readonly toolInput: unknown
}

/** Where a held call goes. Returns void — the sink owns persistence + its own
 *  error routing; a hold must never throw back into the agent loop. */
export interface HoldSink {
  hold(call: HeldCall): void
}

export const HELD_RESULT_MESSAGE =
  'Drafted and queued for the user’s approval — nothing was sent or changed. ' +
  'It will be reviewed in Approvals. Do not retry; continue with anything else, then stop.'

/**
 * Wrap ONE mutating tool so invoking it parks an approval and returns a
 * non-error "held" result — the real `execute` never runs. Spread-wrap is safe:
 * Loom tools are plain objects (defineTool), so `execute` is an own property.
 */
export function holdTool(tool: Tool, sink: HoldSink): Tool {
  return {
    ...tool,
    execute: async (input: Record<string, unknown>): Promise<ToolResult> => {
      // Never let a sink failure surface as a tool error (which the model might
      // retry). Record best-effort; the result is "held" regardless.
      try {
        sink.hold({ toolName: tool.name, toolInput: input })
      } catch {
        /* sink owns its logging; a held action is still not executed */
      }
      return {
        content: HELD_RESULT_MESSAGE,
        isError: false,
        metadata: { held: true, toolName: tool.name },
      }
    },
  }
}

/**
 * The run-time tool transform for a scheduled run.
 *
 *  - 'full-access'    → every tool, unchanged (the user opted in).
 *  - 'read-only'      → only provably read-only tools (unknown = withheld).
 *  - 'draft-approval' → read tools pass through; every write/send tool is
 *                       wrapped to hold. If no sink is available (misconfig /
 *                       no run context), it FAILS CLOSED to read-only — a
 *                       draft-approval run never executes a write without a
 *                       place to park the approval.
 */
export function applyRunSafety(
  tools: readonly Tool[],
  level: SafetyLevel,
  sink?: HoldSink,
): Tool[] {
  switch (level) {
    case 'full-access':
      return [...tools]
    case 'read-only':
      return tools.filter((t) => t.isReadOnly === true)
    case 'draft-approval':
      if (sink == null) return tools.filter((t) => t.isReadOnly === true) // fail closed
      return tools.map((t) => (t.isReadOnly === true ? t : holdTool(t, sink)))
    default: {
      const _exhaustive: never = level
      void _exhaustive
      return tools.filter((t) => t.isReadOnly === true)
    }
  }
}

/**
 * Envelope a sub-agent SPAWN POOL with the run's safety level — IN PLACE.
 *
 * A scheduled run's parent tools are enveloped by {@link applyRunSafety}, but
 * delegation must not be an escape hatch: `agent_spawn` is `isReadOnly` (so it
 * survives the read-only / draft-approval filter) and the spawner's pool is the
 * parent's FULL assembled tool set. Enveloping that pool with the SAME level
 * makes safe-by-default TRANSITIVE — a read-only run's children get no writes;
 * a draft-approval run's children hold every write to the SAME approval sink;
 * full-access passes through. A null level (interactive, non-scheduled run) is
 * a deliberate no-op — those runs are not safety-enveloped.
 *
 * Mutates in place: the spawner stores the pool array by reference, so a fresh
 * array would never reach it. Pure otherwise (no DB, no model).
 */
export function envelopeSpawnerPool(
  pool: Tool[],
  level: SafetyLevel | undefined,
  sink?: HoldSink,
): void {
  if (level == null) return
  const enveloped = applyRunSafety(pool, level, sink)
  pool.length = 0
  pool.push(...enveloped)
}

/**
 * A short human label for the approvals inbox row, derived generically from
 * common argument shapes (recipient / subject / path / channel / url). Best
 * effort — bespoke per-tool summaries can layer on later. Pure.
 */
export function summarizeHeldCall(toolName: string, toolInput: unknown): string {
  const o = (toolInput != null && typeof toolInput === 'object' ? toolInput : {}) as Record<string, unknown>
  const pick = (...keys: readonly string[]): string | null => {
    for (const k of keys) {
      const v = o[k]
      if (typeof v === 'string' && v.trim().length > 0) return v.trim()
    }
    return null
  }
  const target = pick('to', 'recipient', 'channel', 'path', 'file_path', 'url', 'query')
  const subject = pick('subject', 'title', 'message')
  if (target != null && subject != null) return `${toolName} → ${target} — ${subject.slice(0, 60)}`
  if (target != null) return `${toolName} → ${target}`
  if (subject != null) return `${toolName} — ${subject.slice(0, 60)}`
  return toolName
}
