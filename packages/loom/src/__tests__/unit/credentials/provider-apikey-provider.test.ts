/**
 * Unit tests — provider `apiKeyProvider` hook (board: credentials-
 * unification — C24a).
 *
 * The hook is the integration point between loom's provider adapters
 * and the gateway's resolver-backed credential flow. When set, every
 * `stream()` invocation resolves a fresh API key from the gateway
 * BEFORE constructing the SDK client. The dynamic key cannot leak
 * across requests because the SDK client is constructed per call
 * and immediately GC'd after the stream completes.
 *
 * The tests here mock the underlying SDK constructors to verify the
 * wire shape WITHOUT making real provider calls. Real-API tests live
 * in the integration suite under `tests/integration/`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the three SDKs BEFORE importing the providers — the providers
// instantiate the SDK class at construction (legacy path), so the
// mock has to be in place when the import resolves.
const anthropicCtor = vi.fn()
vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    constructor(opts: { apiKey?: string; baseURL?: string }) {
      anthropicCtor(opts)
    }
    messages = {
      stream: vi.fn(() => ({ async *[Symbol.asyncIterator]() { /* empty */ } })),
      countTokens: vi.fn(() => ({ input_tokens: 0 })),
    }
  },
}))

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

const googleCtor = vi.fn()
vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: class MockGoogle {
    constructor(apiKey: string) {
      googleCtor(apiKey)
    }
    getGenerativeModel = vi.fn(() => ({
      countTokens: vi.fn(() => ({ totalTokens: 0 })),
    }))
  },
}))

import { AnthropicProvider } from '../../../provider/anthropic.js'
import { OpenAIProvider } from '../../../provider/openai.js'
import { GoogleProvider } from '../../../provider/google.js'

beforeEach(() => {
  anthropicCtor.mockClear()
  openaiCtor.mockClear()
  googleCtor.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Static path — legacy behaviour preserved
// ---------------------------------------------------------------------------

describe('AnthropicProvider — static apiKey path (legacy)', () => {
  it('constructs the SDK client ONCE at constructor time', () => {
    new AnthropicProvider({ apiKey: 'sk-ant-static' })
    expect(anthropicCtor).toHaveBeenCalledTimes(1)
    expect(anthropicCtor).toHaveBeenCalledWith({
      apiKey: 'sk-ant-static',
      baseURL: undefined,
    })
  })

  it('passes baseURL through to the SDK constructor', () => {
    new AnthropicProvider({ apiKey: 'sk-ant-static', baseURL: 'https://example.com' })
    expect(anthropicCtor).toHaveBeenCalledWith({
      apiKey: 'sk-ant-static',
      baseURL: 'https://example.com',
    })
  })
})

describe('OpenAIProvider — static apiKey path (legacy)', () => {
  it('constructs the SDK client ONCE at constructor time', () => {
    new OpenAIProvider({ apiKey: 'sk-oa-static' })
    expect(openaiCtor).toHaveBeenCalledTimes(1)
    expect(openaiCtor).toHaveBeenCalledWith({
      apiKey: 'sk-oa-static',
      baseURL: undefined,
      organization: undefined,
    })
  })

  it('passes organization through to the SDK constructor', () => {
    new OpenAIProvider({ apiKey: 'sk-oa-static', organization: 'org-xyz' })
    expect(openaiCtor).toHaveBeenCalledWith({
      apiKey: 'sk-oa-static',
      baseURL: undefined,
      organization: 'org-xyz',
    })
  })
})

describe('GoogleProvider — static apiKey path (legacy)', () => {
  it('constructs the SDK client ONCE at constructor time', () => {
    new GoogleProvider({ apiKey: 'goog-static' })
    expect(googleCtor).toHaveBeenCalledTimes(1)
    expect(googleCtor).toHaveBeenCalledWith('goog-static')
  })
})

// ---------------------------------------------------------------------------
// Dynamic apiKeyProvider path — new behaviour
// ---------------------------------------------------------------------------

describe('AnthropicProvider — dynamic apiKeyProvider', () => {
  it('does NOT construct an SDK client at constructor time', () => {
    new AnthropicProvider({ apiKeyProvider: async () => 'sk-ant-dyn' })
    expect(anthropicCtor).toHaveBeenCalledTimes(0)
  })

  it('calls the apiKeyProvider on every stream() invocation', async () => {
    const provider = new AnthropicProvider({ apiKeyProvider: async () => 'sk-ant-dyn' })
    const tokens = await provider.countTokens([])
    void tokens
    await provider.countTokens([])
    expect(anthropicCtor).toHaveBeenCalledTimes(2)
    expect(anthropicCtor).toHaveBeenCalledWith({ apiKey: 'sk-ant-dyn' })
  })

  it('passes the resolved key into the SDK constructor', async () => {
    let returned = 'sk-ant-call-1'
    const provider = new AnthropicProvider({
      apiKeyProvider: async () => returned,
    })
    await provider.countTokens([])
    expect(anthropicCtor).toHaveBeenLastCalledWith({ apiKey: 'sk-ant-call-1' })
    returned = 'sk-ant-call-2'
    await provider.countTokens([])
    expect(anthropicCtor).toHaveBeenLastCalledWith({ apiKey: 'sk-ant-call-2' })
  })

  it('forwards baseURL through the dynamic path', async () => {
    const provider = new AnthropicProvider({
      apiKeyProvider: async () => 'sk-ant-dyn',
      baseURL: 'https://proxy.example.com',
    })
    await provider.countTokens([])
    expect(anthropicCtor).toHaveBeenCalledWith({
      apiKey: 'sk-ant-dyn',
      baseURL: 'https://proxy.example.com',
    })
  })

  it('throws when the apiKeyProvider rejects', async () => {
    const provider = new AnthropicProvider({
      apiKeyProvider: async () => {
        throw new Error('resolve failed')
      },
    })
    await expect(provider.countTokens([])).rejects.toThrow('resolve failed')
  })
})

describe('OpenAIProvider — dynamic apiKeyProvider', () => {
  it('does NOT construct an SDK client at constructor time', () => {
    new OpenAIProvider({ apiKeyProvider: async () => 'sk-oa-dyn' })
    expect(openaiCtor).toHaveBeenCalledTimes(0)
  })

  it('forwards baseURL + organization through the dynamic path', async () => {
    const provider = new OpenAIProvider({
      apiKeyProvider: async () => 'sk-oa-dyn',
      baseURL: 'https://proxy.example.com',
      organization: 'org-xyz',
    })
    // Trigger stream() so getClient() runs. Use an empty mock stream.
    const iter = provider.stream({
      messages: [],
      tools: [],
      model: 'gpt-4o',
      maxTokens: 1,
      temperature: null,
      system: '',
    })
    try { await iter.next() } catch { /* mock returns empty */ }
    expect(openaiCtor).toHaveBeenLastCalledWith({
      apiKey: 'sk-oa-dyn',
      baseURL: 'https://proxy.example.com',
      organization: 'org-xyz',
    })
  })
})

describe('GoogleProvider — dynamic apiKeyProvider', () => {
  it('does NOT read GOOGLE_API_KEY env when apiKeyProvider is set', () => {
    const prev = process.env['GOOGLE_API_KEY']
    process.env['GOOGLE_API_KEY'] = 'env-fallback-should-be-ignored'
    try {
      new GoogleProvider({ apiKeyProvider: async () => 'goog-dyn' })
      expect(googleCtor).toHaveBeenCalledTimes(0)
    } finally {
      if (prev === undefined) delete process.env['GOOGLE_API_KEY']
      else process.env['GOOGLE_API_KEY'] = prev
    }
  })

  it('constructs a fresh SDK client per stream call', async () => {
    const provider = new GoogleProvider({ apiKeyProvider: async () => 'goog-dyn' })
    await provider.countTokens([])
    await provider.countTokens([])
    expect(googleCtor).toHaveBeenCalledTimes(2)
    expect(googleCtor).toHaveBeenLastCalledWith('goog-dyn')
  })
})

// ---------------------------------------------------------------------------
// Plaintext discipline
// ---------------------------------------------------------------------------

describe('Provider apiKeyProvider — plaintext discipline', () => {
  it('the provider does not store the resolved value beyond the SDK client', async () => {
    const provider = new AnthropicProvider({
      apiKeyProvider: async () => 'sk-ant-PLAINTEXT-LEAK-CHECK-PROVIDER',
    })
    // Run a call.
    await provider.countTokens([])
    // The provider's own JSON shape must not carry the value. The SDK
    // client construction happens through the mock; the value lives
    // there briefly and not in the provider instance.
    expect(JSON.stringify(provider)).not.toContain('PLAINTEXT-LEAK-CHECK')
  })
})
