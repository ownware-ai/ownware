/**
 * Unit Tests — computeCostBreakdown (Phase 9 / unified metrics)
 */

import { describe, it, expect } from 'vitest'

import { computeCostBreakdown } from '../../../src/metrics/cost.js'
import type { ModelPricing } from '../../../src/provider/pricing.js'

const ANTHROPIC_SONNET_PRICING: ModelPricing = {
  input: 3,         // $3 / MTok
  output: 15,       // $15 / MTok
  cacheRead: 0.30,  // 10% of input
  cacheWrite: 3.75, // 125% of input
}

const PRICING_NO_CACHE: ModelPricing = {
  input: 5,
  output: 20,
  cacheRead: null,
  cacheWrite: null,
}

describe('computeCostBreakdown — empty session', () => {
  it('returns zeros for an unused session', () => {
    const out = computeCostBreakdown({
      totalUsd: 0,
      turnCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      pricing: ANTHROPIC_SONNET_PRICING,
    })

    expect(out.totalUsd).toBe(0)
    expect(out.avgUsdPerTurn).toBe(0)
    expect(out.turnCount).toBe(0)
    expect(out.tokens).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
      total: 0,
    })
    expect(out.cache.savedUsd).toBe(0)
  })
})

describe('computeCostBreakdown — token totals', () => {
  it('total excludes cacheRead (avoids double-counting context)', () => {
    const out = computeCostBreakdown({
      totalUsd: 0,
      turnCount: 1,
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 800,
      cacheCreationTokens: 300,
      pricing: ANTHROPIC_SONNET_PRICING,
    })
    // 1000 + 500 + 300 = 1800
    expect(out.tokens.total).toBe(1800)
    expect(out.tokens.cacheRead).toBe(800)
  })
})

describe('computeCostBreakdown — average', () => {
  it('avgUsdPerTurn is totalUsd / turnCount', () => {
    const out = computeCostBreakdown({
      totalUsd: 1.5,
      turnCount: 5,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      pricing: ANTHROPIC_SONNET_PRICING,
    })
    expect(out.avgUsdPerTurn).toBe(0.3)
  })

  it('avgUsdPerTurn is 0 when no turns have completed', () => {
    const out = computeCostBreakdown({
      totalUsd: 0,
      turnCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      pricing: ANTHROPIC_SONNET_PRICING,
    })
    expect(out.avgUsdPerTurn).toBe(0)
  })
})

describe('computeCostBreakdown — cache savings', () => {
  it('estimates savedUsd from cacheRead and cacheCreation rates', () => {
    // 1M cache reads at $3/MTok input vs $0.30/MTok cacheRead = saved $2.70
    // 0 cache writes → no premium
    const out = computeCostBreakdown({
      totalUsd: 0,
      turnCount: 1,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 0,
      pricing: ANTHROPIC_SONNET_PRICING,
    })
    expect(out.cache.savedUsd).toBeCloseTo(2.7, 5)
  })

  it('subtracts the cache-write premium from the read savings', () => {
    // 1M reads → +$2.70 saved
    // 1M writes at $3.75 vs $3 input → −$0.75 premium
    // Net: $1.95
    const out = computeCostBreakdown({
      totalUsd: 0,
      turnCount: 1,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 1_000_000,
      pricing: ANTHROPIC_SONNET_PRICING,
    })
    expect(out.cache.savedUsd).toBeCloseTo(1.95, 5)
  })

  it('clamps savedUsd at 0 — never reports negative savings', () => {
    // Heavy writes, no reads — write premium > read savings, but clamp at 0
    const out = computeCostBreakdown({
      totalUsd: 0,
      turnCount: 1,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 1_000_000,
      pricing: ANTHROPIC_SONNET_PRICING,
    })
    expect(out.cache.savedUsd).toBe(0)
  })

  it('returns null savedUsd when pricing has no cache rate', () => {
    const out = computeCostBreakdown({
      totalUsd: 0,
      turnCount: 1,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 0,
      pricing: PRICING_NO_CACHE,
    })
    expect(out.cache.savedUsd).toBeNull()
  })

  it('returns null savedUsd when pricing is unknown for the model', () => {
    const out = computeCostBreakdown({
      totalUsd: 0,
      turnCount: 1,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 0,
      pricing: null,
    })
    expect(out.cache.savedUsd).toBeNull()
  })
})

describe('computeCostBreakdown — token counts pass through', () => {
  it('preserves cache totals on the cache stats', () => {
    const out = computeCostBreakdown({
      totalUsd: 0,
      turnCount: 1,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 200,
      cacheCreationTokens: 75,
      pricing: ANTHROPIC_SONNET_PRICING,
    })
    expect(out.cache.readTokens).toBe(200)
    expect(out.cache.creationTokens).toBe(75)
  })
})
