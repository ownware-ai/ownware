/**
 * Unit tests — OpenRouterProvider.
 *
 * OpenRouter reuses OpenAIProvider's request/response mapping verbatim and
 * only overrides `name` + `baseURL`. The tests verify exactly that contract:
 *
 *   1. The SDK client is constructed against OpenRouter's baseURL.
 *   2. The provider registers under the `openrouter` name (so the registry
 *      routes `openrouter:vendor/model` strings here, not to direct OpenAI).
 *   3. `getModelPricing` returns null for OpenRouter models — there's no
 *      models.dev catalog for OpenRouter yet, so the loop's fallback path
 *      handles cost estimation. Live pricing sync is a future follow-up.
 *
 * No real network calls — the OpenAI SDK is mocked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const openaiCtor = vi.fn()
vi.mock('openai', () => ({
  default: class MockOpenAI {
    constructor(opts: { apiKey?: string; baseURL?: string; organization?: string }) {
      openaiCtor(opts)
    }
    chat = {
      completions: {
        create: vi.fn(async () => ({ async *[Symbol.asyncIterator]() { /* empty */ } })),
      },
    }
  },
}))

import { OpenRouterProvider } from '../../../provider/openrouter.js'

beforeEach(() => {
  openaiCtor.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('OpenRouterProvider', () => {
  it('reports its name as "openrouter" so the registry routes correctly', () => {
    const p = new OpenRouterProvider({ apiKey: 'sk-or-test' })
    expect(p.name).toBe('openrouter')
  })

  it('constructs the SDK client against OpenRouter baseURL (static key path)', () => {
    new OpenRouterProvider({ apiKey: 'sk-or-test' })
    expect(openaiCtor).toHaveBeenCalledTimes(1)
    expect(openaiCtor).toHaveBeenCalledWith({
      apiKey: 'sk-or-test',
      baseURL: 'https://openrouter.ai/api/v1',
      organization: undefined,
    })
  })

  it('defers SDK construction when given an apiKeyProvider', () => {
    new OpenRouterProvider({ apiKeyProvider: async () => 'sk-or-dyn' })
    expect(openaiCtor).toHaveBeenCalledTimes(0)
  })

  it('returns null pricing for OpenRouter models (fallback path expected)', () => {
    const p = new OpenRouterProvider({ apiKey: 'sk-or-test' })
    expect(p.getModelPricing('moonshotai/kimi-k2.6')).toBeNull()
    expect(p.getModelPricing('anthropic/claude-opus-4.7')).toBeNull()
  })

  it('inherits OpenAI feature support (streaming, vision, tool_use, parallel_tool_use)', () => {
    const p = new OpenRouterProvider({ apiKey: 'sk-or-test' })
    expect(p.supportsFeature('streaming')).toBe(true)
    expect(p.supportsFeature('tool_use')).toBe(true)
    expect(p.supportsFeature('parallel_tool_use')).toBe(true)
  })
})
