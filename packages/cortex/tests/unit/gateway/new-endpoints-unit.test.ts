/**
 * Unit tests for new CRUD endpoint logic.
 *
 * Tests Zod validation, search scoring, thread export formatting.
 */

import { describe, it, expect } from 'vitest'
import {
  UpdateThreadSchema,
  SaveSettingsSchema,
  SaveProviderSchema,
  ValidateProviderSchema,
} from '../../../src/gateway/validation/schemas.js'
import { scoreMatch } from '../../../src/gateway/handlers/search.js'

// ---------------------------------------------------------------------------
// Zod schema validation
// ---------------------------------------------------------------------------

describe('Zod schemas — new endpoints', () => {
  describe('UpdateThreadSchema', () => {
    it('accepts valid title update', () => {
      expect(UpdateThreadSchema.safeParse({ title: 'New Title' }).success).toBe(true)
    })

    it('accepts null title', () => {
      expect(UpdateThreadSchema.safeParse({ title: null }).success).toBe(true)
    })

    it('accepts status update', () => {
      expect(UpdateThreadSchema.safeParse({ status: 'completed' }).success).toBe(true)
    })

    it('rejects invalid status', () => {
      expect(UpdateThreadSchema.safeParse({ status: 'invalid' }).success).toBe(false)
    })

    it('rejects unknown keys (strict)', () => {
      expect(UpdateThreadSchema.safeParse({ title: 'X', unknown: true }).success).toBe(false)
    })

    it('accepts empty object (no-op update)', () => {
      expect(UpdateThreadSchema.safeParse({}).success).toBe(true)
    })
  })

  describe('SaveSettingsSchema', () => {
    it('accepts valid key-value object', () => {
      expect(SaveSettingsSchema.safeParse({ theme: 'dark', fontSize: '14' }).success).toBe(true)
    })

    it('rejects empty object', () => {
      expect(SaveSettingsSchema.safeParse({}).success).toBe(false)
    })
  })

  describe('SaveProviderSchema', () => {
    it('accepts valid provider + key', () => {
      expect(SaveProviderSchema.safeParse({ provider: 'anthropic', key: 'sk-test' }).success).toBe(true)
    })

    it('rejects missing key', () => {
      expect(SaveProviderSchema.safeParse({ provider: 'anthropic' }).success).toBe(false)
    })

    it('rejects empty key', () => {
      expect(SaveProviderSchema.safeParse({ provider: 'anthropic', key: '' }).success).toBe(false)
    })
  })

  describe('ValidateProviderSchema', () => {
    it('accepts valid input', () => {
      expect(ValidateProviderSchema.safeParse({ provider: 'openai', key: 'sk-test' }).success).toBe(true)
    })
  })

  // Onboarding schema tests removed — the legacy desktop first-run endpoints
  // and their schemas were deleted from the gateway.
})

// ---------------------------------------------------------------------------
// Search scoring
// ---------------------------------------------------------------------------

describe('search scoring', () => {
  it('exact match returns 100', () => {
    expect(scoreMatch('coder', 'coder')).toBe(100)
  })

  it('case-insensitive exact match returns 100', () => {
    expect(scoreMatch('Coder', 'coder')).toBe(100)
  })

  it('starts-with returns 75', () => {
    expect(scoreMatch('coder-agent', 'coder')).toBe(75)
  })

  it('contains returns 50', () => {
    expect(scoreMatch('my-coder-agent', 'coder')).toBe(50)
  })

  it('no match returns 0', () => {
    expect(scoreMatch('writer', 'coder')).toBe(0)
  })

  it('empty text returns 0 for non-empty query', () => {
    expect(scoreMatch('', 'test')).toBe(0)
  })
})
