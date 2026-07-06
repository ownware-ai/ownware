import { describe, it, expect } from 'vitest'
import {
  parseModelString,
  resolveAlias,
  listAliases,
  registerAlias,
} from '../../../src/provider/router.js'

describe('parseModelString', () => {
  describe('explicit provider:model format', () => {
    it('parses anthropic:model', () => {
      const result = parseModelString('anthropic:claude-sonnet-4-20250514')
      expect(result).toEqual({
        providerName: 'anthropic',
        modelId: 'claude-sonnet-4-20250514',
      })
    })

    it('parses openai:model', () => {
      const result = parseModelString('openai:gpt-4o')
      expect(result).toEqual({
        providerName: 'openai',
        modelId: 'gpt-4o',
      })
    })

    it('parses google:model', () => {
      const result = parseModelString('google:gemini-2.5-pro')
      expect(result).toEqual({
        providerName: 'google',
        modelId: 'gemini-2.5-pro',
      })
    })

    it('handles custom provider', () => {
      const result = parseModelString('custom:my-model-v1')
      expect(result).toEqual({
        providerName: 'custom',
        modelId: 'my-model-v1',
      })
    })
  })

  describe('aliases', () => {
    it('resolves "sonnet" alias', () => {
      const result = parseModelString('sonnet')
      expect(result.providerName).toBe('anthropic')
      expect(result.modelId).toContain('claude-sonnet')
    })

    it('resolves "opus" alias', () => {
      const result = parseModelString('opus')
      expect(result.providerName).toBe('anthropic')
      expect(result.modelId).toContain('claude-opus')
    })

    it('resolves "haiku" alias', () => {
      const result = parseModelString('haiku')
      expect(result.providerName).toBe('anthropic')
      expect(result.modelId).toContain('claude-haiku')
    })

    it('resolves "gpt4o" alias', () => {
      const result = parseModelString('gpt4o')
      expect(result).toEqual({
        providerName: 'openai',
        modelId: 'gpt-4o',
      })
    })

    it('resolves "gemini-pro" alias', () => {
      const result = parseModelString('gemini-pro')
      expect(result.providerName).toBe('google')
      expect(result.modelId).toContain('gemini')
    })

    it('resolves "o3" alias', () => {
      const result = parseModelString('o3')
      expect(result.providerName).toBe('openai')
      expect(result.modelId).toBe('o3')
    })
  })

  describe('auto-detection from prefix', () => {
    it('detects claude models as anthropic', () => {
      const result = parseModelString('claude-opus-4-20250514')
      expect(result.providerName).toBe('anthropic')
      expect(result.modelId).toBe('claude-opus-4-20250514')
    })

    it('detects gpt- models as openai', () => {
      const result = parseModelString('gpt-4-turbo')
      expect(result.providerName).toBe('openai')
      expect(result.modelId).toBe('gpt-4-turbo')
    })

    it('detects gemini models as google', () => {
      const result = parseModelString('gemini-1.5-flash')
      expect(result.providerName).toBe('google')
      expect(result.modelId).toBe('gemini-1.5-flash')
    })

    it('detects o4-mini as openai', () => {
      const result = parseModelString('o4-mini')
      expect(result.providerName).toBe('openai')
      expect(result.modelId).toBe('o4-mini')
    })
  })

  describe('error cases', () => {
    it('throws on unknown model without prefix', () => {
      expect(() => parseModelString('mystery-model')).toThrow(
        /Cannot determine provider/,
      )
    })

    it('throws on empty string', () => {
      expect(() => parseModelString('')).toThrow()
    })
  })
})

describe('resolveAlias', () => {
  it('resolves known alias', () => {
    const result = resolveAlias('sonnet')
    expect(result).toContain('anthropic:')
  })

  it('returns input unchanged for non-alias', () => {
    expect(resolveAlias('anthropic:my-model')).toBe('anthropic:my-model')
  })
})

describe('listAliases', () => {
  it('returns object with known aliases', () => {
    const aliases = listAliases()
    expect(aliases).toHaveProperty('sonnet')
    expect(aliases).toHaveProperty('gpt4o')
    expect(aliases).toHaveProperty('gemini-pro')
  })
})

describe('registerAlias', () => {
  it('registers a custom alias', () => {
    registerAlias('mymodel', 'custom:model-v1')
    const result = parseModelString('mymodel')
    expect(result).toEqual({
      providerName: 'custom',
      modelId: 'model-v1',
    })
  })
})
