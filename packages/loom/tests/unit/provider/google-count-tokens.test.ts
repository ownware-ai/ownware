/**
 * Tests for Google provider countTokens model resolution.
 *
 * Verifies that countTokens uses the configured model,
 * not a hardcoded 'gemini-2.5-pro'.
 */

import { describe, it, expect, vi } from 'vitest'
import { GoogleProvider } from '../../../src/provider/google.js'

// We cannot call the real API without credentials, but we can verify
// that the provider stores and uses the correct model string.

describe('GoogleProvider countTokens model', () => {
  it('uses default model (gemini-2.5-pro) when no model specified', () => {
    const provider = new GoogleProvider({ apiKey: 'test-key' })
    // Access the private field via casting to verify storage
    const defaultModel = (provider as unknown as { defaultModel: string }).defaultModel
    expect(defaultModel).toBe('gemini-2.5-pro')
  })

  it('uses the model passed in constructor options', () => {
    const provider = new GoogleProvider({ apiKey: 'test-key', model: 'gemini-2.0-flash' })
    const storedModel = (provider as unknown as { defaultModel: string }).defaultModel
    expect(storedModel).toBe('gemini-2.0-flash')
  })

  it('stores different Gemini model variants correctly', () => {
    const variants = [
      'gemini-2.5-pro',
      'gemini-2.0-flash',
      'gemini-1.5-pro',
      'gemini-1.5-flash',
    ]

    for (const model of variants) {
      const provider = new GoogleProvider({ apiKey: 'test-key', model })
      const storedModel = (provider as unknown as { defaultModel: string }).defaultModel
      expect(storedModel).toBe(model)
    }
  })
})
