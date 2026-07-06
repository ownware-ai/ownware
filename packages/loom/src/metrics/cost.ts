/**
 * Cost Breakdown Computation
 *
 * Pure function — given the raw usage state a session accumulates plus
 * the active model's pricing, returns a typed `CostBreakdown`.
 *
 * No I/O, no provider calls, no surprises. Designed to be cheap enough
 * that callers (UI clients, gateway) can refresh on every turn boundary.
 */

import type { ModelPricing } from '../provider/pricing.js'
import type { CacheStats, CostBreakdown, TokenBreakdown } from './types.js'

export interface CostBreakdownInputs {
  /** USD totals already accumulated by the loop. */
  readonly totalUsd: number
  /** Number of completed turns. */
  readonly turnCount: number
  /** Raw input tokens billed at full input rate. */
  readonly inputTokens: number
  /** Output tokens billed at output rate. */
  readonly outputTokens: number
  /** Tokens served from the prompt cache. */
  readonly cacheReadTokens: number
  /** Tokens written to the prompt cache. */
  readonly cacheCreationTokens: number
  /** Active model's pricing, or null when pricing is unknown for the model. */
  readonly pricing: ModelPricing | null
}

/**
 * Compute the unified `CostBreakdown` from raw session usage.
 *
 * `savedUsd` is null when the model's pricing has no cache rates.
 * `avgUsdPerTurn` is 0 when no turns have completed (avoids div-by-0
 * surprises in UI consumers).
 */
export function computeCostBreakdown(input: CostBreakdownInputs): CostBreakdown {
  const tokens: TokenBreakdown = {
    input: input.inputTokens,
    output: input.outputTokens,
    cacheRead: input.cacheReadTokens,
    cacheCreation: input.cacheCreationTokens,
    total: input.inputTokens + input.outputTokens + input.cacheCreationTokens,
  }

  const cache: CacheStats = {
    readTokens: input.cacheReadTokens,
    creationTokens: input.cacheCreationTokens,
    savedUsd: estimateCacheSavings(input.pricing, input.cacheReadTokens, input.cacheCreationTokens),
  }

  const avgUsdPerTurn = input.turnCount > 0 ? input.totalUsd / input.turnCount : 0

  return {
    totalUsd: input.totalUsd,
    avgUsdPerTurn,
    turnCount: input.turnCount,
    tokens,
    cache,
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Estimate USD saved by prompt caching versus a hypothetical uncached
 * baseline. Returns `null` when the model has no cache pricing
 * (`cacheRead === null` or `pricing === null`) so callers can render
 * "—" rather than a misleading 0.
 *
 * Math:
 *   readSavings  = readTokens × (input - cacheRead) / MTok
 *   writePremium = creationTokens × (cacheWrite - input) / MTok    (when cacheWrite is set)
 *   savedUsd     = max(0, readSavings − writePremium)
 *
 * Bounded at 0 — cache premium > read savings is rare but possible
 * on a session that wrote a lot and read little (early turns); the
 * "savings" line shouldn't go negative on a UI.
 */
function estimateCacheSavings(
  pricing: ModelPricing | null,
  cacheReadTokens: number,
  cacheCreationTokens: number,
): number | null {
  if (pricing === null) return null
  if (pricing.cacheRead === null) return null

  const inputRate = pricing.input
  const readRate = pricing.cacheRead
  const writeRate = pricing.cacheWrite ?? inputRate  // No premium when cacheWrite isn't priced separately.

  const readSavings = (cacheReadTokens / 1_000_000) * (inputRate - readRate)
  const writePremium = (cacheCreationTokens / 1_000_000) * Math.max(0, writeRate - inputRate)

  return Math.max(0, readSavings - writePremium)
}
