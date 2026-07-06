/**
 * Unit tests for the per-provider pricing data and savings math helpers.
 *
 * Pricing now flows from a committed snapshot of models.dev (see
 * scripts/sync-models.ts). These tests pin the lookup behavior model-by-model
 * AGAINST that snapshot — when sync-models is re-run and a price changes,
 * the relevant assertion will fail loudly so the change is reviewed in the
 * PR rather than silently shipped.
 *
 * Lessons baked into this file:
 *   - The 'haiku' substring pattern of the old manual table caught Haiku 4.5
 *     with Haiku 3.5 rates — so we test version-specific IDs explicitly.
 *   - Opus 4.5+ is priced 3× lower than Opus 3 / 4 / 4.1 — so we test BOTH
 *     the cheap-tier and legacy-tier IDs.
 *   - Anthropic flipped its naming convention between Claude 3 and Claude 4:
 *       Claude 3 family: "claude-3-opus-20240229" (version-then-family)
 *       Claude 4 family: "claude-opus-4-20250514" (family-then-version)
 *     Both forms are tested.
 *   - The savings math hard-coded 0.1× cache rate and 90% discount; tests
 *     pin the per-provider derivation now used in loop.ts cache.status.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FALLBACK_PRICING,
  _resetCatalogCache,
  _resetFallbackWarnings,
  calculateCost,
  computeCostWithFallback,
  estimateCostFallback,
  getModelInfo,
  getModelPricing,
  listModels,
  warnIfFallbackPricing,
} from '../../../src/provider/pricing.js'

describe('getModelPricing — Anthropic', () => {
  describe('Opus version disambiguation', () => {
    it('returns $5/$25 for Opus 4.7 (current cheap-tier Opus)', () => {
      const p = getModelPricing('anthropic', 'claude-opus-4-7')
      expect(p?.input).toBe(5)
      expect(p?.output).toBe(25)
      expect(p?.cacheRead).toBe(0.5)
      expect(p?.cacheWrite).toBe(6.25)
    })

    it('returns $5/$25 for Opus 4.6', () => {
      const p = getModelPricing('anthropic', 'claude-opus-4-6')
      expect(p?.input).toBe(5)
      expect(p?.output).toBe(25)
    })

    it('returns $5/$25 for Opus 4.5 (bare and dated)', () => {
      const bare = getModelPricing('anthropic', 'claude-opus-4-5')
      const dated = getModelPricing('anthropic', 'claude-opus-4-5-20251101')
      expect(bare?.input).toBe(5)
      expect(dated?.input).toBe(5)
    })

    it('returns LEGACY $15/$75 for Opus 4 (no minor) and Opus 4.1', () => {
      const opus4 = getModelPricing('anthropic', 'claude-opus-4-20250514')
      const opus41 = getModelPricing('anthropic', 'claude-opus-4-1-20250805')
      expect(opus4?.input).toBe(15)
      expect(opus4?.output).toBe(75)
      expect(opus41?.input).toBe(15)
    })

    it('returns LEGACY $15/$75 for Claude 3 Opus (3-then-family ID format)', () => {
      // Claude 3.x used "claude-3-opus-20240229", not "claude-opus-3-...".
      const p = getModelPricing('anthropic', 'claude-3-opus-20240229')
      expect(p?.input).toBe(15)
    })
  })

  describe('Haiku version disambiguation', () => {
    it('returns $1/$5 for Haiku 4.5 (the current Haiku) — bare and dated', () => {
      const bare = getModelPricing('anthropic', 'claude-haiku-4-5')
      const dated = getModelPricing('anthropic', 'claude-haiku-4-5-20251001')
      expect(bare).toEqual({ input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 })
      expect(dated).toEqual({ input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 })
    })

    it('returns $0.80/$4 for Haiku 3.5 (3-then-family ID format)', () => {
      const p = getModelPricing('anthropic', 'claude-3-5-haiku-20241022')
      expect(p?.input).toBe(0.8)
      expect(p?.output).toBe(4)
    })

    it('returns $0.25/$1.25 for Haiku 3', () => {
      const p = getModelPricing('anthropic', 'claude-3-haiku-20240307')
      expect(p?.input).toBe(0.25)
      expect(p?.output).toBe(1.25)
    })
  })

  describe('Sonnet (all current Sonnets share rates)', () => {
    it.each([
      'claude-sonnet-4-6',
      'claude-sonnet-4-5',
      'claude-sonnet-4-20250514',
      'claude-3-7-sonnet-20250219',
    ])('returns $3/$15 for %s', (model) => {
      const p = getModelPricing('anthropic', model)
      expect(p?.input).toBe(3)
      expect(p?.output).toBe(15)
      expect(p?.cacheRead).toBe(0.3)
    })
  })

  describe('dated-suffix fallback', () => {
    it('strips an unrecognized -YYYYMMDD suffix and retries the bare ID', () => {
      // "claude-opus-4-7-20991231" doesn't exist in the snapshot, but the
      // bare "claude-opus-4-7" does. The dated-suffix strip should resolve it.
      const p = getModelPricing('anthropic', 'claude-opus-4-7-20991231')
      expect(p?.input).toBe(5)
    })
  })
})

describe('getModelPricing — OpenAI', () => {
  it('resolves the GPT-5.4 family (current flagship)', () => {
    expect(getModelPricing('openai', 'gpt-5.4')?.input).toBe(2.5)
    expect(getModelPricing('openai', 'gpt-5.4-mini')?.input).toBe(0.75)
    expect(getModelPricing('openai', 'gpt-5.4-nano')?.input).toBe(0.2)
  })

  it('models OpenAI cache as null cacheWrite (cache writes are free)', () => {
    // OpenAI's automatic prompt caching does not bill a separate write cost.
    // models.dev reflects that by omitting cache_write — we expose null.
    const p = getModelPricing('openai', 'gpt-5.4')
    expect(p?.cacheWrite).toBeNull()
    expect(p?.cacheRead).toBe(0.25)
  })

  it('resolves legacy gpt-4o family (more-specific mini wins)', () => {
    expect(getModelPricing('openai', 'gpt-4o')?.input).toBe(2.5)
    expect(getModelPricing('openai', 'gpt-4o-mini')?.input).toBe(0.15)
  })
})

describe('getModelPricing — Google', () => {
  it('resolves Gemini 2.5 family', () => {
    expect(getModelPricing('google', 'gemini-2.5-pro')?.input).toBe(1.25)
    expect(getModelPricing('google', 'gemini-2.5-flash')?.input).toBe(0.3)
    expect(getModelPricing('google', 'gemini-2.5-flash-lite')?.input).toBe(0.1)
  })

  it('Gemini cache_write is null (no separate write fee in models.dev data)', () => {
    const p = getModelPricing('google', 'gemini-2.5-pro')
    expect(p?.cacheWrite).toBeNull()
  })
})

describe('getModelPricing — unknown', () => {
  it.each([
    ['anthropic', 'claude-mythos-7'],
    ['openai', 'gpt-99-quantum'],
    ['xai', 'grok-3'],
  ])('returns null for unknown %s/%s', (provider, model) => {
    expect(getModelPricing(provider, model)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// getModelInfo — capabilities + limits surfaced from models.dev
// ---------------------------------------------------------------------------

describe('getModelInfo', () => {
  it('surfaces Sonnet 4.6 capabilities and limits', () => {
    const info = getModelInfo('anthropic', 'claude-sonnet-4-6')
    expect(info).not.toBeNull()
    expect(info!.id).toBe('claude-sonnet-4-6')
    expect(info!.name).toBe('Claude Sonnet 4.6')
    expect(info!.supportsToolCall).toBe(true)
    expect(info!.contextWindow).toBeGreaterThan(0)
    expect(info!.maxOutput).toBeGreaterThan(0)
    expect(info!.inputModalities).toContain('text')
  })

  it('returns null for unknown models (no partial info)', () => {
    expect(getModelInfo('anthropic', 'claude-mythos-7')).toBeNull()
  })
})

describe('listModels', () => {
  it('lists every Anthropic text model with pricing (≥10 entries)', () => {
    const ms = listModels('anthropic')
    expect(ms.length).toBeGreaterThan(10)
    expect(ms.every(m => m.pricing.input > 0)).toBe(true)
  })

  it('returns empty array for unknown providers', () => {
    expect(listModels('xai')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Cost calculation arithmetic
// ---------------------------------------------------------------------------

describe('calculateCost', () => {
  it('multiplies tokens by per-MTok rates', () => {
    const cost = calculateCost(
      { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      1_000_000, 0,
    )
    expect(cost).toBeCloseTo(3, 6)
  })

  it('sums input + output + cache_read + cache_write', () => {
    const cost = calculateCost(
      { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      1000, 500, 2000, 1000,
    )
    const expected =
      (1000 * 3 + 500 * 15 + 2000 * 0.3 + 1000 * 3.75) / 1_000_000
    expect(cost).toBeCloseTo(expected, 8)
  })

  it('treats null cacheRead/cacheWrite as zero cost (e.g. OpenAI no-write)', () => {
    const cost = calculateCost(
      { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: null },
      1000, 500, 2000, 1000,
    )
    // Only input + output + cache_read should be billed; cache_write skipped.
    const expected = (1000 * 2.5 + 500 * 15 + 2000 * 0.25) / 1_000_000
    expect(cost).toBeCloseTo(expected, 8)
  })
})

describe('estimateCostFallback', () => {
  it('matches calculateCost(FALLBACK_PRICING, ...)', () => {
    const a = estimateCostFallback(1000, 500, 200, 100)
    const b = calculateCost(FALLBACK_PRICING, 1000, 500, 200, 100)
    expect(a).toBeCloseTo(b, 10)
  })
})

// ---------------------------------------------------------------------------
// computeCostWithFallback — pricing + provenance flag
// ---------------------------------------------------------------------------
//
// BUG #24 (accuracy-audit): the status bar showed exact `$X.XXXX` even when
// the cost was computed via the Sonnet-tier fallback for an uncatalogued
// model. The single emit point (`loop.ts`) now needs to know whether the
// resolved pricing was authoritative or estimated, so it can flag the
// `TurnUsage.isFallbackPricing` it puts on the `turn.end` event and the
// status bar can render `≈ $` instead of `$`.
//
// These tests pin the function's contract: same arithmetic as
// `calculateCost` / `estimateCostFallback`, plus a boolean that surfaces
// whether the model was catalogued.

describe('computeCostWithFallback', () => {
  afterEach(() => {
    _resetFallbackWarnings()
    vi.restoreAllMocks()
  })

  it('returns isFallback: false and authoritative cost for a catalogued model', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = computeCostWithFallback('anthropic', 'claude-sonnet-4-6', 1000, 500, 0, 0)
    expect(r.isFallback).toBe(false)
    const pricing = getModelPricing('anthropic', 'claude-sonnet-4-6')!
    expect(r.costUsd).toBeCloseTo(calculateCost(pricing, 1000, 500, 0, 0), 10)
  })

  it('returns isFallback: true and Sonnet-tier cost for an uncatalogued model', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = computeCostWithFallback('anthropic', 'claude-mythos-7', 1000, 500, 200, 100)
    expect(r.isFallback).toBe(true)
    expect(r.costUsd).toBeCloseTo(estimateCostFallback(1000, 500, 200, 100), 10)
  })

  it('fires the one-time fallback warn exactly once across repeated calls', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    computeCostWithFallback('anthropic', 'claude-mythos-7', 100, 50, 0, 0)
    computeCostWithFallback('anthropic', 'claude-mythos-7', 100, 50, 0, 0)
    computeCostWithFallback('anthropic', 'claude-mythos-7', 100, 50, 0, 0)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('does not warn for a catalogued model', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    computeCostWithFallback('anthropic', 'claude-sonnet-4-6', 100, 50, 0, 0)
    expect(spy).not.toHaveBeenCalled()
  })

  it('normalizes a `provider:model` prefix when classifying fallback', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = computeCostWithFallback('anthropic', 'anthropic:claude-haiku-4-5-20251001', 1, 1, 0, 0)
    expect(r.isFallback).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Fallback warning
// ---------------------------------------------------------------------------

describe('warnIfFallbackPricing', () => {
  afterEach(() => {
    _resetFallbackWarnings()
    vi.restoreAllMocks()
  })

  it('returns false and does not warn for a known model', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(warnIfFallbackPricing('anthropic', 'claude-sonnet-4-6')).toBe(false)
    expect(spy).not.toHaveBeenCalled()
  })

  it('warns once for an unknown model', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(warnIfFallbackPricing('anthropic', 'claude-mythos-7')).toBe(true)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0]![0]).toContain('claude-mythos-7')
  })

  it('does not warn twice for the same model', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    warnIfFallbackPricing('anthropic', 'claude-mythos-7')
    warnIfFallbackPricing('anthropic', 'claude-mythos-7')
    warnIfFallbackPricing('anthropic', 'claude-mythos-7')
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('warns separately for distinct unknown models', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    warnIfFallbackPricing('anthropic', 'claude-mythos-7')
    warnIfFallbackPricing('openai', 'gpt-99-quantum')
    expect(spy).toHaveBeenCalledTimes(2)
  })
})

// ---------------------------------------------------------------------------
// Savings math (mirrors loop.ts cache.status emission)
// ---------------------------------------------------------------------------
//
// loop.ts derives the discount fraction and per-turn USD savings from the
// resolved ModelPricing rather than hard-coded constants. These tests pin
// the per-provider numerics with the actual rates from models.dev — if an
// upstream price change breaks the assumption, the assertion fires.

describe('savings math (mirrors loop.ts)', () => {
  function discount(pricing: { input: number; cacheRead: number | null }): number {
    if (pricing.input <= 0) return 0
    const rate = pricing.cacheRead ?? pricing.input * 0.1
    return Math.max(0, pricing.input - rate) / pricing.input
  }
  function savingsUsd(pricing: { input: number; cacheRead: number | null }, tokens: number): number {
    if (pricing.input <= 0) return 0
    const rate = pricing.cacheRead ?? pricing.input * 0.1
    return (tokens * (pricing.input - rate)) / 1_000_000
  }

  it('Anthropic Sonnet 4.6 → 90% discount on cache reads', () => {
    const p = getModelPricing('anthropic', 'claude-sonnet-4-6')!
    expect(discount(p)).toBeCloseTo(0.9, 6)
    expect(savingsUsd(p, 1_000_000)).toBeCloseTo(2.7, 6)
  })

  it('Anthropic Opus 4.7 → 90% discount on cache reads', () => {
    const p = getModelPricing('anthropic', 'claude-opus-4-7')!
    expect(discount(p)).toBeCloseTo(0.9, 6)
    expect(savingsUsd(p, 1_000_000)).toBeCloseTo(4.5, 6)
  })

  it('OpenAI gpt-5.4 → 90% discount on cache reads', () => {
    const p = getModelPricing('openai', 'gpt-5.4')!
    expect(discount(p)).toBeCloseTo(0.9, 4)
  })

  it('OpenAI o4-mini → ~75% discount (NOT 90%) — proves per-provider derivation', () => {
    const p = getModelPricing('openai', 'o4-mini')!
    // input $1.10 vs cache_read $0.28 → discount = 0.7454...
    expect(discount(p)).toBeGreaterThan(0.7)
    expect(discount(p)).toBeLessThan(0.8)
  })

  it('OpenAI gpt-4o-mini → ~47% discount', () => {
    const p = getModelPricing('openai', 'gpt-4o-mini')!
    // input $0.15 vs cache_read $0.08 → discount ≈ 0.4667
    expect(discount(p)).toBeGreaterThan(0.4)
    expect(discount(p)).toBeLessThan(0.5)
  })

  it('Google Gemini 2.5 Pro → ~75% discount (NOT 90%) — proves per-provider derivation', () => {
    const p = getModelPricing('google', 'gemini-2.5-pro')!
    // input $1.25 vs cache_read $0.31 → discount = 0.752
    expect(discount(p)).toBeGreaterThan(0.7)
    expect(discount(p)).toBeLessThan(0.8)
  })

  it('returns 0 savings when input rate is unknown', () => {
    expect(discount({ input: 0, cacheRead: 0 })).toBe(0)
    expect(savingsUsd({ input: 0, cacheRead: 0 }, 100_000)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Catalog cache reset (test-only export sanity check)
// ---------------------------------------------------------------------------

describe('_resetCatalogCache', () => {
  it('forces the next lookup to re-read the file', () => {
    const before = getModelPricing('anthropic', 'claude-sonnet-4-6')
    _resetCatalogCache()
    const after = getModelPricing('anthropic', 'claude-sonnet-4-6')
    expect(after).toEqual(before)
  })
})

// ---------------------------------------------------------------------------
// Provider-prefix normalization (regression — fixes the
// "anthropic:anthropic:claude-..." double-prefix warn loop)
// ---------------------------------------------------------------------------

describe('provider-prefix idempotency', () => {
  it('getModelPricing: bare and prefixed forms resolve identically', () => {
    const bare = getModelPricing('anthropic', 'claude-haiku-4-5-20251001')
    const pref = getModelPricing('anthropic', 'anthropic:claude-haiku-4-5-20251001')
    expect(bare).not.toBeNull()
    expect(pref).toEqual(bare)
  })

  it('getModelInfo: bare and prefixed forms resolve identically', () => {
    const bare = getModelInfo('anthropic', 'claude-sonnet-4-6')
    const pref = getModelInfo('anthropic', 'anthropic:claude-sonnet-4-6')
    expect(bare).not.toBeNull()
    expect(pref).toEqual(bare)
  })

  it('warnIfFallbackPricing: prefixed model resolves and does NOT warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    _resetFallbackWarnings()
    const fired = warnIfFallbackPricing('anthropic', 'anthropic:claude-haiku-4-5-20251001')
    expect(fired).toBe(false)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('warnIfFallbackPricing: still warns ONCE for genuinely unknown models', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    _resetFallbackWarnings()
    const fired1 = warnIfFallbackPricing('anthropic', 'anthropic:claude-quantum-9000')
    const fired2 = warnIfFallbackPricing('anthropic', 'anthropic:claude-quantum-9000')
    expect(fired1).toBe(true)
    expect(fired2).toBe(false) // dedup by composite key still works
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})
