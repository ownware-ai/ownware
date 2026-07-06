/**
 * Session Metrics — unified shape for everything a `/metrics` panel
 * (or a gateway endpoint, or a client overlay) wants to surface about
 * a running session: context window utilization, token totals, USD
 * cost, cache savings.
 *
 * Why one shape: before this, cost lived on `Session.totalUsage`
 * (raw tokens + USD), context lived on `Session.getContextUsage()`,
 * cache stats lived inside the loop's private `cacheSavings` tracker.
 * Three different shapes for related concerns. UI clients + Cortex
 * gateway both want to display "the session's resource state" in
 * one panel — `SessionMetrics` is that one panel's source of truth.
 *
 * All numbers are non-negative and integer-valued (token counts) or
 * non-negative finite floats (USD). `readonly` everywhere so
 * consumers can hold a snapshot without worrying about mutation.
 */

import type { ContextUsage } from '../context/types.js'

// ---------------------------------------------------------------------------
// Tokens — raw counts as the provider reported them
// ---------------------------------------------------------------------------

export interface TokenBreakdown {
  /** Standard input tokens (prompt content paid at full input rate). */
  readonly input: number
  /** Output tokens (assistant generations paid at output rate). */
  readonly output: number
  /**
   * Tokens served from the prompt cache. Billed at the cache-read rate
   * (typically 10% of input on Anthropic). Counted toward the model's
   * context window like any input token.
   */
  readonly cacheRead: number
  /**
   * Tokens written to the prompt cache. Billed at the cache-write rate
   * (typically 125% of input on Anthropic, premium amortized over
   * subsequent reads).
   */
  readonly cacheCreation: number
  /**
   * Sum that's most useful for "how many tokens have I sent across all
   * turns?" — input + output + cacheCreation. Cache reads are excluded
   * because they re-use prior tokens that were already counted (you
   * don't double-pay context for a cached prefix).
   */
  readonly total: number
}

// ---------------------------------------------------------------------------
// Cache — savings vs uncached baseline
// ---------------------------------------------------------------------------

export interface CacheStats {
  /** Cumulative tokens served from cache across the session. */
  readonly readTokens: number
  /** Cumulative tokens written to cache across the session. */
  readonly creationTokens: number
  /**
   * Estimated USD saved versus a hypothetical uncached baseline.
   *
   * Computed as
   *   savings = readTokens × (input - cacheRead)/MTok
   *           − cacheCreation × (cacheWrite - input)/MTok
   *
   * Anthropic-style: cache reads pay 10% of input rate (savings = 90%);
   * cache writes pay 125% of input rate (premium = 25%). Net positive
   * once read volume exceeds ~3× write volume — typically the case in
   * normal multi-turn agent sessions.
   *
   * `null` when the model's pricing has no cache rates (caching not
   * priced for that route, or pricing table doesn't include it).
   */
  readonly savedUsd: number | null
}

// ---------------------------------------------------------------------------
// Cost — USD-denominated
// ---------------------------------------------------------------------------

export interface CostBreakdown {
  /** Total USD spent across all turns this session. */
  readonly totalUsd: number
  /** Average USD per turn (`totalUsd / turnCount`). 0 when `turnCount === 0`. */
  readonly avgUsdPerTurn: number
  /** Number of completed turns this session. */
  readonly turnCount: number
  /** Token-level breakdown summing to the cost above. */
  readonly tokens: TokenBreakdown
  /** Cache-savings rollup. */
  readonly cache: CacheStats
}

// ---------------------------------------------------------------------------
// Top-level snapshot
// ---------------------------------------------------------------------------

/**
 * Everything the gateway / UI client / model itself might want to display
 * about a session's resource state, in one typed snapshot. Cheap to
 * compute (no API calls in the default path) — safe for live UI.
 */
export interface SessionMetrics {
  /** Provider-prefixed model id. */
  readonly model: string
  /** Total turns this session. */
  readonly turnCount: number
  /** Context-window utilization + per-category breakdown. See `context/types.ts`. */
  readonly context: ContextUsage
  /** USD cost + raw tokens + cache stats. */
  readonly cost: CostBreakdown
}
