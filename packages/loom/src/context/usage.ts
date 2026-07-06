/**
 * Context Usage Measurement
 *
 * `measureContextUsage` is the engine-level helper: pass it the inputs
 * a request would carry (model, system prompt, messages, tools) and it
 * returns a typed `ContextUsage` breakdown.
 *
 * `Session.getContextUsage()` is a thin wrapper around this that pulls
 * the inputs from the session's own state.
 *
 * Why local estimates by default: a `/context` panel needs to be cheap
 * to recompute on every turn, and the chars/4 heuristic is within ~10%
 * of actual for mixed code+prose. Exact counts via the provider API
 * are a future opt-in — see `types.ts` for the upgrade path.
 */

import type { Message, ContentBlock } from '../messages/types.js'
import type { Tool } from '../tools/types.js'
import type { SystemPrompt } from '../core/system-prompt.js'
import { systemPromptToText } from '../core/system-prompt.js'
import {
  estimateTokens,
  estimateMessageTokens,
  estimateSystemPromptTokens,
  getModelContextWindow,
} from '../messages/tokens.js'

import type {
  ContextUsage,
  ContextUsageBreakdown,
  CountMethod,
  TokenCounter,
} from './types.js'

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface MeasureContextUsageOptions {
  /** Provider-prefixed model id (e.g. `anthropic:claude-sonnet-4-6`). */
  readonly model: string

  /** Assembled system prompt — string or block array. */
  readonly systemPrompt: SystemPrompt

  /** Conversation messages. */
  readonly messages: readonly Message[]

  /** Tool definitions sent to the model. */
  readonly tools: readonly Tool[]

  /**
   * Optional pluggable counter for exact token counts. When supplied,
   * the helper anchors the system+messages+skills portion to the
   * counter's reading and reports `method: 'mixed'` (tools stay on the
   * local estimate because most provider APIs don't accept tools).
   *
   * On counter failure (network, rate limit, unsupported model) the
   * helper falls back to all-local estimation rather than throwing —
   * `/context` panels remain reliable even when the API is flaky.
   *
   * Omit (or pass `undefined`) to use the local chars/4 heuristic for
   * every category — the default behaviour, no I/O, deterministic.
   */
  readonly counter?: TokenCounter
}

/** Detail emitted alongside a `ContextUsage` when callers want to see how the number was computed. */
export interface MeasureContextUsageDiagnostics {
  /** Exact count returned by the counter for system+messages+skills, when supplied. */
  readonly counterTotal?: number
  /** Local estimate of system+messages+skills before scaling, when a counter was used. */
  readonly localTotal?: number
  /** Multiplier applied to scale local category estimates onto the exact total. 1.0 means perfect alignment. */
  readonly scale?: number
  /** Reason the counter was not used (when applicable). */
  readonly counterError?: string
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Compute a `ContextUsage` breakdown for the given request inputs.
 *
 * Default path (no counter): local chars/4 estimator, ~10-15% variance,
 * deterministic, zero I/O. Suitable for live UI display.
 *
 * Hybrid path (counter supplied): the counter provides the exact
 * messages+system+skills total; tools stay on the local estimate;
 * categories are scaled so the breakdown sums to the exact anchor.
 * Suitable for budget gates and audits.
 */
export async function measureContextUsage(
  opts: MeasureContextUsageOptions,
): Promise<ContextUsage> {
  const result = await measureContextUsageWithDiagnostics(opts)
  return result.usage
}

/**
 * Same as `measureContextUsage` but also returns the diagnostic detail
 * (counter total, scale factor, fallback reason). Useful for tests and
 * for any UI that wants to surface "exact" vs "estimate" provenance.
 */
export async function measureContextUsageWithDiagnostics(
  opts: MeasureContextUsageOptions,
): Promise<{ usage: ContextUsage; diagnostics: MeasureContextUsageDiagnostics }> {
  const { model, systemPrompt, messages, tools, counter } = opts

  // Always compute the local breakdown first — the hybrid path uses it
  // as the per-category proportion when scaling, and the failure path
  // falls back to it directly.
  const local = computeLocalBreakdown(systemPrompt, messages, tools)

  if (!counter) {
    return finalize(model, local, 'estimate', {})
  }

  // Empty-messages guard: Anthropic's count_tokens API rejects empty
  // message arrays (the API requires at least one user message), and a
  // counter returning 0 here would scale the system prompt to 0 in the
  // breakdown — visibly wrong on a /context panel showing "session
  // start." Skip the counter and use the local estimator unconditionally
  // for empty conversations; the local estimate of system+tools alone
  // is well within ±10% and avoids a misleading API call.
  if (messages.length === 0) {
    return finalize(model, local, 'estimate', {
      counterError: 'Skipped counter on empty message history (counter requires non-empty messages)',
    })
  }

  // Hybrid path: anchor system+messages+skills to the counter's reading.
  try {
    const systemText = systemPromptToText(systemPrompt)
    const counterTotal = await counter.count([...messages], systemText)

    if (!Number.isFinite(counterTotal) || counterTotal < 0) {
      return finalize(model, local, 'estimate', {
        counterError: `Counter returned non-finite value: ${counterTotal}`,
      })
    }

    const localAnchored =
      local.systemPrompt
      + local.skills
      + local.messages
    const scale = localAnchored > 0 ? counterTotal / localAnchored : 1

    const scaledBreakdown: ContextUsageBreakdown = {
      systemPrompt: Math.round(local.systemPrompt * scale),
      tools: local.tools, // Counter usually doesn't include tools; keep estimate.
      memory: local.memory,
      // skills + messages get scaled too. Math.round can introduce a tiny
      // rounding drift; we correct it below to preserve the sum invariant.
      skills: Math.round(local.skills * scale),
      messages: Math.round(local.messages * scale),
    }

    // Sum invariant: the anchored categories must total `counterTotal`
    // exactly. Math.round across three values can drift by ±1; absorb
    // the drift into `messages` (the largest category, least sensitive
    // to a 1-token wobble).
    const anchoredSum = scaledBreakdown.systemPrompt + scaledBreakdown.skills + scaledBreakdown.messages
    const drift = counterTotal - anchoredSum
    const correctedBreakdown: ContextUsageBreakdown = {
      ...scaledBreakdown,
      messages: Math.max(0, scaledBreakdown.messages + drift),
    }

    return finalize(model, correctedBreakdown, 'mixed', {
      counterTotal,
      localTotal: localAnchored,
      scale,
    })
  } catch (err) {
    // Counter threw (network failure, unsupported model, rate limit).
    // Production paths must NOT crash on a flaky counter — fall back.
    return finalize(model, local, 'estimate', {
      counterError: err instanceof Error ? err.message : String(err),
    })
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function finalize(
  model: string,
  breakdown: ContextUsageBreakdown,
  method: CountMethod,
  diagnostics: MeasureContextUsageDiagnostics,
): { usage: ContextUsage; diagnostics: MeasureContextUsageDiagnostics } {
  const used =
    breakdown.systemPrompt
    + breakdown.tools
    + breakdown.memory
    + breakdown.skills
    + breakdown.messages
  const contextWindow = getModelContextWindow(model)
  const free = Math.max(0, contextWindow - used)
  const utilization = contextWindow > 0 ? Math.min(1, used / contextWindow) : 0

  return {
    usage: { model, contextWindow, used, free, utilization, breakdown, method },
    diagnostics,
  }
}

function computeLocalBreakdown(
  systemPrompt: SystemPrompt,
  messages: readonly Message[],
  tools: readonly Tool[],
): ContextUsageBreakdown {
  const systemPromptTokens = countSystemPrompt(systemPrompt)
  const toolsTokens = countTools(tools)
  const skillsTokens = countSkillResultTokens(messages)
  const messagesTokens = Math.max(0, estimateMessageTokens([...messages]) - skillsTokens)

  return {
    systemPrompt: systemPromptTokens,
    tools: toolsTokens,
    memory: 0,
    skills: skillsTokens,
    messages: messagesTokens,
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function countSystemPrompt(prompt: SystemPrompt): number {
  const text = systemPromptToText(prompt)
  return estimateSystemPromptTokens(text)
}

function countTools(tools: readonly Tool[]): number {
  if (tools.length === 0) return 0
  let total = 0
  for (const tool of tools) {
    const wire = `${tool.name}\n${tool.description}\n${stableSchemaText(tool.inputSchema)}`
    total += estimateTokens(wire)
  }
  return total
}

/**
 * Sum of tokens consumed by `tool_result` blocks whose paired `tool_use`
 * was named `skill`. Walks the conversation in O(messages × blocks)
 * which is fine — these arrays are small in practice.
 */
function countSkillResultTokens(messages: readonly Message[]): number {
  const skillToolUseIds = collectSkillToolUseIds(messages)
  if (skillToolUseIds.size === 0) return 0

  let total = 0
  for (const msg of messages) {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue
    for (const block of msg.content) {
      if (block.type !== 'tool_result') continue
      if (!skillToolUseIds.has(block.toolUseId)) continue
      total += blockTextTokens(block.content)
    }
  }
  return total
}

function collectSkillToolUseIds(messages: readonly Message[]): Set<string> {
  const ids = new Set<string>()
  for (const msg of messages) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue
    for (const block of msg.content) {
      if (block.type === 'tool_use' && block.name === 'skill') {
        ids.add(block.id)
      }
    }
  }
  return ids
}

function blockTextTokens(content: string | ContentBlock[]): number {
  if (typeof content === 'string') return estimateTokens(content)
  let total = 0
  for (const block of content) {
    if (block.type === 'text') total += estimateTokens(block.text)
  }
  return total
}

/**
 * Deterministic JSON of an inputSchema for token estimation. Object
 * key order matters for token count, so we sort to make repeated
 * measurements identical.
 */
function stableSchemaText(schema: unknown): string {
  return JSON.stringify(schema, sortedReplacer)
}

function sortedReplacer(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  const obj = value as Record<string, unknown>
  const sorted: Record<string, unknown> = {}
  for (const k of Object.keys(obj).sort()) sorted[k] = obj[k]
  return sorted
}
