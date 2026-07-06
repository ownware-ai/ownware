import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  pickDefaultModel,
  listOllamaModels,
  NO_PROVIDER_INSTRUCTION,
} from '../../../src/provider/auto-pick.js'
import { resolveProvider, registerProvider, unregisterProvider } from '../../../src/provider/registry.js'
import type { ProviderAdapter } from '../../../src/provider/types.js'

const PROVIDER_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_API_KEY',
  'OPENROUTER_API_KEY',
] as const

const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const v of PROVIDER_ENV_VARS) {
    saved[v] = process.env[v]
    delete process.env[v]
  }
})

afterEach(() => {
  for (const v of PROVIDER_ENV_VARS) {
    if (saved[v] === undefined) delete process.env[v]
    else process.env[v] = saved[v]
  }
})

describe('pickDefaultModel', () => {
  it('prefers a cloud key over the local probe', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test'
    const picked = await pickDefaultModel({ probe: async () => ['llama3.2:latest'] })
    expect(picked).toBe('anthropic:claude-sonnet-4-6')
  })

  it('walks the key order (openrouter when only that key is set)', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test'
    const picked = await pickDefaultModel({ probe: async () => null })
    expect(picked).toBe('openrouter:kimi-k2.7-code')
  })

  it('falls back to the first installed Ollama model when keyless', async () => {
    const picked = await pickDefaultModel({ probe: async () => ['qwen3:8b', 'llama3.2'] })
    expect(picked).toBe('ollama:qwen3:8b')
  })

  it('returns null when keyless and no Ollama answers', async () => {
    const picked = await pickDefaultModel({ probe: async () => null })
    expect(picked).toBeNull()
  })

  it('returns null when Ollama answers with zero installed models', async () => {
    const picked = await pickDefaultModel({ probe: async () => [] })
    expect(picked).toBeNull()
  })
})

describe('NO_PROVIDER_INSTRUCTION', () => {
  it('names every unlock path in one sentence — env keys and Ollama', () => {
    for (const v of PROVIDER_ENV_VARS) expect(NO_PROVIDER_INSTRUCTION).toContain(v)
    expect(NO_PROVIDER_INSTRUCTION).toContain('ollama.com')
    expect(NO_PROVIDER_INSTRUCTION).toContain('ollama pull')
  })
})

describe('listOllamaModels', () => {
  it('returns null quickly when nothing listens', async () => {
    expect(await listOllamaModels('http://127.0.0.1:1', 200)).toBeNull()
  })
})

describe('resolveProvider — actionable errors for unconfigured providers', () => {
  it('names the env var and the keyless path for a known cloud provider', () => {
    unregisterProvider('anthropic')
    expect(() => resolveProvider('anthropic:claude-sonnet-4-6')).toThrowError(
      /set ANTHROPIC_API_KEY.*ollama\.com/is,
    )
  })

  it('still resolves normally once the provider is registered', () => {
    const fake: ProviderAdapter = {
      name: 'anthropic',
      stream: (() => {
        throw new Error('unused')
      }) as unknown as ProviderAdapter['stream'],
      supportsFeature: () => true,
      getModelPricing: () => null,
    } as unknown as ProviderAdapter
    registerProvider(fake)
    try {
      const { model } = resolveProvider('anthropic:claude-sonnet-4-6')
      expect(model).toBe('claude-sonnet-4-6')
    } finally {
      unregisterProvider('anthropic')
    }
  })

  it('suggests the keyless path even for unknown provider names', () => {
    expect(() => resolveProvider('nonexistent:model-x')).toThrowError(/ollama\.com|Ollama/i)
  })
})
