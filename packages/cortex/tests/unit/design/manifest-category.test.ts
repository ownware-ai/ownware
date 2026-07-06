/**
 * CT-9 regression — the design-system manifest schema was too strict in
 * TWO fields, silently dropping 13 of 16 shipped systems:
 *
 *   1. `category` was a closed `z.enum([8 dev words])` — authors used
 *      design-flavored words (`marketing`, `premium`, `futuristic`, …).
 *      Now an OPEN lowercase-kebab string (shape validated, vocabulary free).
 *   2. `summary` capped at 140 chars — authors wrote ~200 (max 213).
 *      Raised to 280 (still bounded — summary is baked into prompt context).
 *
 * Both relaxations let the full catalog surface in the picker +
 * `list_design_systems`, while still failing loudly on genuinely malformed
 * data (uppercase category, unbounded summary).
 */

import { describe, it, expect } from 'vitest'
import {
  DesignSystemCategorySchema,
  DesignSystemManifestSchema,
} from '../../../profiles/ownware-design/helpers/manifest.schema.js'

describe('DesignSystemCategorySchema (CT-9)', () => {
  it('accepts the design-flavored categories the old enum rejected', () => {
    for (const cat of [
      'marketing',
      'ambient',
      'premium',
      'futuristic',
      'crafted',
      'friendly',
      'typographic',
      'retro',
      'warm',
      'utility',
    ]) {
      expect(DesignSystemCategorySchema.safeParse(cat).success).toBe(true)
    }
  })

  it('still accepts the original dev categories', () => {
    for (const cat of ['starter', 'editorial', 'minimal', 'tech', 'data']) {
      expect(DesignSystemCategorySchema.safeParse(cat).success).toBe(true)
    }
  })

  it('rejects malformed labels (shape still validated, fails loudly)', () => {
    for (const bad of ['Marketing', 'has space', 'UPPER', '', '-leading', 'trailing-']) {
      expect(DesignSystemCategorySchema.safeParse(bad).success).toBe(false)
    }
  })
})

describe('DesignSystemManifestSchema summary cap (CT-9)', () => {
  const base = {
    schemaVersion: 'ownware-design-system/v1' as const,
    id: 'sample-system',
    name: 'Sample',
    category: 'marketing',
    surface: 'web' as const,
    swatches: ['#000000', '#ffffff', '#ff0066'],
    source: { type: 'starter' as const, author: 'ownware' as const },
    files: { design: 'DESIGN.md' as const, tokens: 'tokens.css' as const },
  }

  it('accepts a realistic ~210-char summary (the authored standard)', () => {
    const summary = 'x'.repeat(210) // longest shipped summary is 213
    expect(DesignSystemManifestSchema.safeParse({ ...base, summary }).success).toBe(true)
  })

  it('still rejects an unbounded summary (token discipline: prompt-baked)', () => {
    const summary = 'x'.repeat(281)
    expect(DesignSystemManifestSchema.safeParse({ ...base, summary }).success).toBe(false)
  })
})
