/**
 * Compaction Manager
 *
 * Orchestrates context compaction before each model call.
 * Implements the CompactionManager interface consumed by the agent loop.
 *
 * Responsibilities:
 * - Checks token count against the configured trigger threshold
 * - Delegates to the configured strategy (summarize, truncate, sliding_window, hierarchical)
 * - Circuit breaker: stops after 3 consecutive failures
 * - forceCompact() for reactive recovery (prompt_too_long errors)
 *
 * @see ../core/loop.ts — the loop calls compactIfNeeded() before each model call
 */

import type { Message } from '../messages/types.js'
import type { CompactionResult, CompactionStrategy } from './types.js'
import type { CompactionConfig, CompactionRetain, CompactionTrigger } from '../core/config.js'
import type { ProviderAdapter } from '../provider/types.js'
import { CompactionError } from '../core/errors.js'
import { summarize } from './summarize.js'
import { truncate } from './truncate.js'
import { slidingWindow } from './sliding-window.js'
import { hierarchical } from './hierarchical.js'
import { snapshot } from './snapshot.js'

// Re-export the interface so the loop can import from this module
export type { CompactionManager } from './types.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Circuit breaker threshold: stop attempting compaction after this many
 * consecutive failures. Prevents burning API calls on irrecoverable contexts.
 */
const MAX_CONSECUTIVE_FAILURES = 3

/**
 * Minimum number of non-system messages required before compaction is attempted.
 * Compacting 2 messages would produce a summary larger than the original.
 */
const MIN_MESSAGES_FOR_COMPACTION = 4

/**
 * Safety timeout for compaction operations. If compaction takes longer than
 * this, abort and fall back to truncation. Prevents the agent loop from
 * hanging on a compaction call that never resolves.
 *
 * Inspired by OpenClaw's compaction safety timeout (30s default).
 */
const COMPACTION_SAFETY_TIMEOUT_MS = 30_000

// ---------------------------------------------------------------------------
// Manager implementation
// ---------------------------------------------------------------------------

export interface CompactionManagerOptions {
  /** Compaction config from LoomConfig */
  readonly config: CompactionConfig
  /** Provider adapter for token counting and summarization calls */
  readonly provider: ProviderAdapter
  /** Context window size in tokens (used for fraction-based triggers) */
  readonly contextWindowTokens: number
}

/**
 * Create a CompactionManager instance.
 *
 * The manager is stateful — it tracks consecutive failures for the
 * circuit breaker. Create one per session (or per LoopParams).
 */
export function createCompactionManager(
  options: CompactionManagerOptions,
): import('./types.js').CompactionManager {
  const { config, provider, contextWindowTokens } = options

  /** Consecutive failure count for circuit breaker */
  let consecutiveFailures = 0

  /**
   * Check if compaction is needed based on the trigger config,
   * and compact if so. Returns null if no compaction occurred.
   *
   * @param currentTokens — optional precomputed token count. When the
   *   caller (typically the loop) has already computed the effective
   *   context size via `getEffectiveContextUsage`, passing it through
   *   here avoids a redundant `provider.countTokens` round-trip on
   *   Anthropic/Google (50-200ms per turn). When omitted, falls back
   *   to calling `provider.countTokens` — preserves the pre-unification
   *   call shape for callers that haven't been updated.
   */
  async function compactIfNeeded(
    messages: Message[],
    systemPrompt: string,
    currentTokens?: number,
  ): Promise<CompactionResult | null> {
    // Disabled trigger — never compact
    if (config.trigger.type === 'disabled') {
      return null
    }

    // Circuit breaker — stop after N consecutive failures
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      return null
    }

    // Not enough messages to warrant compaction
    if (countConversationMessages(messages) < MIN_MESSAGES_FOR_COMPACTION) {
      return null
    }

    // Check if we've exceeded the trigger threshold
    const shouldCompact = await checkTrigger(
      messages,
      systemPrompt,
      config.trigger,
      provider,
      contextWindowTokens,
      currentTokens,
    )

    if (!shouldCompact) {
      return null
    }

    return executeCompaction(messages, systemPrompt)
  }

  /**
   * Force compaction regardless of trigger thresholds.
   * Used for reactive recovery when the API returns prompt_too_long.
   */
  async function forceCompact(
    messages: Message[],
    systemPrompt: string,
  ): Promise<CompactionResult | null> {
    // Circuit breaker still applies — if we've failed 3 times,
    // forcing won't help
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      return null
    }

    // Need at least some messages to compact
    if (countConversationMessages(messages) < 2) {
      return null
    }

    return executeCompaction(messages, systemPrompt)
  }

  /**
   * Execute the configured compaction strategy.
   * Handles errors with circuit breaker, safety timeout, and fallback to truncation.
   */
  async function executeCompaction(
    messages: Message[],
    systemPrompt: string,
  ): Promise<CompactionResult | null> {
    const timeoutMs = config.safetyTimeoutMs ?? COMPACTION_SAFETY_TIMEOUT_MS
    try {
      const result = await withSafetyTimeout(
        runStrategy(
          config.strategy,
          messages,
          systemPrompt,
          config.retain,
          provider,
          config.summaryModel,
        ),
        timeoutMs,
        config.strategy,
      )

      // Success — reset circuit breaker
      consecutiveFailures = 0
      return result
    } catch (error) {
      consecutiveFailures++

      // If the primary strategy failed and it's not truncation,
      // fall back to truncation as a last resort
      if (config.strategy !== 'truncate') {
        try {
          const fallbackResult = await runStrategy(
            'truncate',
            messages,
            systemPrompt,
            config.retain,
            provider,
            null,
          )

          // Fallback succeeded — don't reset circuit breaker fully
          // (the primary strategy still failed)
          return fallbackResult
        } catch (fallbackError) {
          // Both strategies failed
          throw new CompactionError(
            `Compaction failed (primary: ${config.strategy}, fallback: truncate): ${
              error instanceof Error ? error.message : String(error)
            }`,
            config.strategy,
          )
        }
      }

      // Truncation itself failed — unusual but possible
      throw new CompactionError(
        `Compaction failed (${config.strategy}): ${
          error instanceof Error ? error.message : String(error)
        }`,
        config.strategy,
      )
    }
  }

  return { compactIfNeeded, forceCompact }
}

// ---------------------------------------------------------------------------
// Trigger evaluation
// ---------------------------------------------------------------------------

/**
 * Check whether the current conversation exceeds the trigger threshold.
 */
async function checkTrigger(
  messages: Message[],
  systemPrompt: string,
  trigger: CompactionTrigger,
  provider: ProviderAdapter,
  contextWindowTokens: number,
  currentTokens?: number,
): Promise<boolean> {
  switch (trigger.type) {
    case 'disabled':
      return false

    case 'messages':
      return countConversationMessages(messages) >= trigger.threshold

    case 'tokens': {
      // Prefer the caller-supplied count (computed by loop via
      // `getEffectiveContextUsage` — exact baseline + delta). Fall
      // back to `provider.countTokens` only when no precomputed value
      // is available (legacy callers).
      const tokenCount =
        currentTokens ?? (await provider.countTokens(messages, systemPrompt))
      return tokenCount >= trigger.threshold
    }

    case 'fraction': {
      const tokenCount =
        currentTokens ?? (await provider.countTokens(messages, systemPrompt))
      return tokenCount >= contextWindowTokens * trigger.threshold
    }
  }
}

// ---------------------------------------------------------------------------
// Strategy dispatch
// ---------------------------------------------------------------------------

/**
 * Run the named compaction strategy.
 */
async function runStrategy(
  strategy: CompactionStrategy,
  messages: Message[],
  systemPrompt: string,
  retain: CompactionRetain,
  provider: ProviderAdapter,
  summaryModel: string | null,
): Promise<CompactionResult> {
  switch (strategy) {
    case 'summarize':
      return summarize(messages, systemPrompt, retain, provider, summaryModel)

    case 'truncate':
      return truncate(messages, systemPrompt, retain, provider)

    case 'sliding_window':
      return slidingWindow(messages, systemPrompt, retain, provider)

    case 'hierarchical':
      return hierarchical(messages, systemPrompt, retain, provider, summaryModel)

    case 'snapshot':
      return snapshot(messages, systemPrompt, retain, provider)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Count non-system messages in the conversation.
 */
function countConversationMessages(messages: Message[]): number {
  return messages.filter(m => m.role !== 'system').length
}

/**
 * Wrap a compaction promise with a safety timeout.
 * If the compaction takes longer than the timeout, reject with an error
 * so the circuit breaker and fallback logic can handle it.
 */
async function withSafetyTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  strategy: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new CompactionError(
        `Compaction strategy "${strategy}" timed out after ${Math.round(timeoutMs / 1000)}s`,
        strategy,
      ))
    }, timeoutMs)
  })

  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
