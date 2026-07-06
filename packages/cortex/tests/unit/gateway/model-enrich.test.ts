/**
 * Catalog fact-merge invariants.
 *
 * Proves the catalog's objective numbers (context / max-output / pricing) come
 * from the live snapshots (models.dev + OpenRouter), not the hand-typed
 * catalog values — and that the catalog value is used only as a fallback when
 * the snapshot lacks the model.
 *
 * These depend on the committed snapshots in @ownware/loom
 * (src/provider/models.dev.json + openrouter-models.json). If a sync changes
 * upstream numbers, update the expected values here in the same commit.
 */

import { describe, it, expect } from 'vitest'
import { ALL_MODELS, findModelById } from '../../../src/gateway/catalog/models/index.js'
import {
  enrichModel,
  enrichCatalog,
  modelsUsingFallback,
} from '../../../src/gateway/catalog/models/enrich.js'

describe('catalog fact merge', () => {
  it('overrides a stale hand-typed maxOutput with the models.dev value (Sonnet 4.6)', () => {
    const m = findModelById('anthropic:claude-sonnet-4-6')
    expect(m).toBeDefined()
    if (!m) return
    // The catalog hand-typed 128k; models.dev says the real cap is 64k. The
    // bug we set out to kill: the picker was claiming double the real limit.
    expect(m.maxOutputTokens).toBe(128_000)
    const e = enrichModel(m)
    expect(e.maxOutputTokens).toBe(64_000)
    expect(e.contextWindow).toBe(1_000_000)
    expect(e.costPer1kInput).toBe(0.003)
    expect(e.costPer1kOutput).toBe(0.015)
  })

  it('pulls OpenRouter facts via orSlug (DeepSeek V4 Pro)', () => {
    const m = findModelById('openrouter:deepseek-v4-pro')
    expect(m).toBeDefined()
    if (!m) return
    const e = enrichModel(m)
    expect(e.contextWindow).toBe(1_048_576)
    expect(e.maxOutputTokens).toBe(384_000)
    expect(e.costPer1kInput).toBe(0.000435)
    expect(e.costPer1kOutput).toBe(0.00087)
  })

  it('corrects a stale hand-typed price from models.dev (Opus 4.6: catalog $15 → source $5)', () => {
    const m = findModelById('anthropic:claude-opus-4-6')
    expect(m).toBeDefined()
    if (!m) return
    // Catalog hand-typed 0.015/0.075 per 1K ($15/$75 per MTok) — 3× the real
    // rate. models.dev says $5/$25. The merge trusts the source.
    expect(m.costPer1kInput).toBe(0.015)
    const e = enrichModel(m)
    expect(e.costPer1kInput).toBe(0.005)
    expect(e.costPer1kOutput).toBe(0.025)
  })

  it('falls back to the catalog value when the snapshot has no entry', () => {
    // An OpenRouter entry with no orSlug can't be joined → enrich is a no-op.
    const synthetic = {
      id: 'openrouter:not-a-real-model',
      name: 'Synthetic',
      provider: 'openrouter' as const,
      tier: 'fast' as const,
      description: 'test-only',
      contextWindow: 12_345,
      maxOutputTokens: 678,
      costPer1kInput: 0.001,
      costPer1kOutput: 0.002,
      capabilities: ['tools'] as const,
      aliases: [] as const,
      releaseDate: '2026-01-01',
    }
    const e = enrichModel(synthetic)
    expect(e.contextWindow).toBe(12_345)
    expect(e.maxOutputTokens).toBe(678)
    expect(e.costPer1kInput).toBe(0.001)
    expect(e.costPer1kOutput).toBe(0.002)
  })

  // The wire-contract guard. `/api/v1/models` returns enriched ModelInfo, and
  // The client's zod schema requires contextWindow/maxOutputTokens as numbers and
  // formatContext() crashes on undefined. This proves every shipped model has
  // complete, valid objective numbers — whether from snapshot or fallback — so
  // a blank spec can never reach the picker.
  it('every shipped model has complete, valid facts after enrich', () => {
    for (const m of enrichCatalog(ALL_MODELS)) {
      expect(m.contextWindow, `${m.id} contextWindow`).toBeGreaterThan(0)
      expect(m.maxOutputTokens, `${m.id} maxOutputTokens`).toBeGreaterThan(0)
      // pricing may legitimately be null (unknown) but never undefined.
      expect(m.costPer1kInput, `${m.id} costPer1kInput`).not.toBeUndefined()
      expect(m.costPer1kOutput, `${m.id} costPer1kOutput`).not.toBeUndefined()
    }
  })

  // Visibility: the fallback set is hand-typed numbers no snapshot covers yet.
  // It should be small and shrink over time. If this list grows unexpectedly,
  // a sync is overdue (or a new model was added without snapshot coverage).
  it('reports which models still rely on hand-typed fallback numbers', () => {
    const fallback = modelsUsingFallback(ALL_MODELS)
    // Surfaced in test output for review; not a hard assertion on membership
    // (that would churn every time a snapshot updates upstream).
    console.info(
      `[catalog] ${fallback.length} model(s) using hand-typed fallback:`,
      fallback.map((m) => m.id),
    )
    // Guard against silent blow-up: the vast majority must be snapshot-backed.
    expect(fallback.length).toBeLessThan(ALL_MODELS.length / 2)
  })
})
