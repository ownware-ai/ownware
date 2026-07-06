/**
 * Model catalog invariants.
 *
 * These tests guard against the most common mistakes when adding a new
 * model to one of the per-provider catalogs:
 *   - duplicate IDs across providers
 *   - more than one default per provider (or zero defaults)
 *   - alias collisions
 *   - wrong provider prefix on the canonical ID
 *   - missing required metadata fields
 */

import { describe, it, expect } from 'vitest'
import {
  ALL_MODELS,
  ANTHROPIC_MODELS,
  OPENAI_MODELS,
  GOOGLE_MODELS,
  findModelById,
  findModelByAlias,
  modelsByProvider,
  normalizeModelId,
} from '../../../src/gateway/catalog/models/index.js'

describe('model catalog', () => {
  describe('uniqueness', () => {
    it('has no duplicate IDs across the union', () => {
      const seen = new Set<string>()
      for (const m of ALL_MODELS) {
        expect(seen.has(m.id)).toBe(false)
        seen.add(m.id)
      }
    })

    it('has no duplicate aliases across the union', () => {
      const seen = new Set<string>()
      for (const m of ALL_MODELS) {
        for (const alias of m.aliases) {
          expect(seen.has(alias)).toBe(false)
          seen.add(alias)
        }
      }
    })
  })

  describe('per-provider invariants', () => {
    const providers = [
      { name: 'anthropic', models: ANTHROPIC_MODELS },
      { name: 'openai', models: OPENAI_MODELS },
      { name: 'google', models: GOOGLE_MODELS },
    ] as const

    for (const { name, models } of providers) {
      describe(name, () => {
        it('has at least one model', () => {
          expect(models.length).toBeGreaterThan(0)
        })

        it('every model uses the correct provider prefix on id', () => {
          for (const m of models) {
            expect(m.id.startsWith(`${name}:`)).toBe(true)
            expect(m.provider).toBe(name)
          }
        })

        it('has exactly one default model', () => {
          const defaults = models.filter((m) => m.default === true)
          expect(defaults).toHaveLength(1)
        })

        it('defaults are not deprecated', () => {
          for (const m of models) {
            if (m.default) {
              expect(m.deprecated).not.toBe(true)
            }
          }
        })
      })
    }
  })

  describe('metadata completeness', () => {
    it('every model has a non-empty name and description', () => {
      for (const m of ALL_MODELS) {
        expect(m.name.length).toBeGreaterThan(0)
        expect(m.description.length).toBeGreaterThan(0)
      }
    })

    it('every model has a valid tier', () => {
      const validTiers = ['flagship', 'balanced', 'fast', 'legacy', 'preview']
      for (const m of ALL_MODELS) {
        expect(validTiers).toContain(m.tier)
      }
    })

    it('every model has a positive context window and output limit', () => {
      for (const m of ALL_MODELS) {
        expect(m.contextWindow).toBeGreaterThan(0)
        expect(m.maxOutputTokens).toBeGreaterThan(0)
      }
    })

    it('pricing is either a positive number or explicitly null', () => {
      for (const m of ALL_MODELS) {
        if (m.costPer1kInput !== null) {
          expect(m.costPer1kInput).toBeGreaterThan(0)
        }
        if (m.costPer1kOutput !== null) {
          expect(m.costPer1kOutput).toBeGreaterThan(0)
        }
      }
    })

    it('every model has a valid ISO release date', () => {
      for (const m of ALL_MODELS) {
        expect(() => new Date(m.releaseDate)).not.toThrow()
        const d = new Date(m.releaseDate)
        expect(Number.isNaN(d.getTime())).toBe(false)
      }
    })
  })

  describe('findModelById', () => {
    it('finds a known model by canonical id', () => {
      const m = findModelById('anthropic:claude-sonnet-4-6')
      expect(m).toBeDefined()
      expect(m?.name).toBe('Claude Sonnet 4.6')
    })

    it('returns undefined for an unknown id', () => {
      expect(findModelById('fake:not-a-model')).toBeUndefined()
    })
  })

  describe('findModelByAlias', () => {
    it('finds Claude Sonnet by the `sonnet` alias', () => {
      const m = findModelByAlias('sonnet')
      expect(m).toBeDefined()
      expect(m?.id).toBe('anthropic:claude-sonnet-4-6')
    })

    it('is case-insensitive', () => {
      expect(findModelByAlias('SONNET')?.id).toBe('anthropic:claude-sonnet-4-6')
      expect(findModelByAlias('Opus')?.id).toBe('anthropic:claude-opus-4-6')
    })

    it('also matches by canonical id', () => {
      const m = findModelByAlias('anthropic:claude-haiku-4-5-20251001')
      expect(m?.name).toBe('Claude Haiku 4.5')
    })

    it('returns undefined for an unknown alias', () => {
      expect(findModelByAlias('not-a-real-alias')).toBeUndefined()
    })
  })

  describe('normalizeModelId (heals any path that persists a bad model)', () => {
    it('resolves a friendly display NAME to the canonical id (the PROF-1 repro)', () => {
      const m = findModelById('openrouter:deepseek-v4-flash')
      expect(m).toBeDefined()
      // The exact bug: a profile saved the label "Deepseek V4 Flash" as its model
      // (instead of the id), which killed runs with "Cannot resolve provider".
      expect(normalizeModelId(m!.name)).toBe('openrouter:deepseek-v4-flash')
      expect(normalizeModelId(m!.name.toUpperCase())).toBe('openrouter:deepseek-v4-flash') // case-insensitive
    })

    it('resolves a bare alias and leaves a canonical id untouched', () => {
      expect(normalizeModelId('sonnet')).toBe('anthropic:claude-sonnet-4-6')
      expect(normalizeModelId('anthropic:claude-sonnet-4-6')).toBe('anthropic:claude-sonnet-4-6')
    })

    it('passes an unrecognized string through unchanged (so the provider raises a clear error)', () => {
      expect(normalizeModelId('totally-made-up-model')).toBe('totally-made-up-model')
    })
  })

  describe('modelsByProvider', () => {
    it('returns all anthropic models', () => {
      const models = modelsByProvider('anthropic')
      expect(models.length).toBe(ANTHROPIC_MODELS.length)
      expect(models.every((m) => m.provider === 'anthropic')).toBe(true)
    })

    it('returns an empty array for unknown provider', () => {
      expect(modelsByProvider('fake-provider')).toHaveLength(0)
    })

    it('preserves catalog order', () => {
      const models = modelsByProvider('anthropic')
      // The first entry in our anthropic catalog is Claude Opus 4.6
      expect(models[0]?.id).toBe('anthropic:claude-opus-4-6')
    })
  })
})
