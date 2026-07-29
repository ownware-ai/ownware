/**
 * Unit tests — adapter transport options (`fetch` / `defaultHeaders`).
 *
 * These options exist so a credential whose authority is not a static bearer
 * key — an OAuth token needing rotation, a request that must carry an account
 * identifier, a tenant-specific endpoint — can be expressed without teaching
 * the core loop about any provider. The properties worth proving are therefore
 * not "the option is stored" but:
 *
 *   1. The closure REACHES the SDK on **both** construction paths (static key
 *      and dynamic `apiKeyProvider`). A hook honoured on one path and dropped
 *      on the other is the dangerous case: the gateway swaps a provider from a
 *      static key to a resolver-backed one and the credential silently stops
 *      being attached.
 *   2. An adapter that CANNOT honour an option fails loudly at construction,
 *      never accept-and-ignore. A dropped `fetch` is a request leaving without
 *      its credential while still looking configured.
 *   3. Passing nothing changes nothing — the existing static path stays
 *      byte-identical, so this is not a behaviour change for current callers.
 *
 * No network. The vendor SDKs are mocked so we can observe exactly what
 * options they were constructed with.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

// --- SDK mocks ------------------------------------------------------------
// Each records the options object it was constructed with so the tests can
// assert on what actually reached the vendor client.

const openaiCtor = vi.fn()
vi.mock('openai', () => ({
  default: class MockOpenAI {
    constructor(opts: Record<string, unknown>) {
      openaiCtor(opts)
    }
    chat = {
      completions: {
        create: vi.fn(async () => ({
          async *[Symbol.asyncIterator]() {
            /* empty stream */
          },
        })),
      },
    }
  },
}))

const anthropicCtor = vi.fn()
vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    constructor(opts: Record<string, unknown>) {
      anthropicCtor(opts)
    }
    messages = { stream: vi.fn() }
  },
}))

const googleCtor = vi.fn()
const getGenerativeModel = vi.fn(() => ({
  generateContentStream: vi.fn(async () => ({
    stream: (async function* () {
      /* empty */
    })(),
  })),
}))
vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: class MockGoogle {
    constructor(apiKey: string) {
      googleCtor(apiKey)
    }
    getGenerativeModel = getGenerativeModel
  },
}))

import { AnthropicProvider } from '../../../provider/anthropic.js'
import { ConfigError } from '../../../core/errors.js'
import { GoogleProvider } from '../../../provider/google.js'
import { OpenAIProvider } from '../../../provider/openai.js'
import { OpenRouterProvider } from '../../../provider/openrouter.js'
import type { ProviderFetch } from '../../../provider/types.js'

/** A recognisable closure — identity is what the assertions check. */
const sentinelFetch: ProviderFetch = async () => new Response('{}')

beforeEach(() => {
  openaiCtor.mockClear()
  anthropicCtor.mockClear()
  googleCtor.mockClear()
  getGenerativeModel.mockClear()
})

// -------------------------------------------------------------------------
// Property 1 — the hook reaches the SDK on BOTH construction paths
// -------------------------------------------------------------------------

describe('transport options reach the SDK — static key path', () => {
  it('forwards fetch and defaultHeaders to the OpenAI client', () => {
    new OpenAIProvider({
      apiKey: 'sk-test',
      fetch: sentinelFetch,
      defaultHeaders: { 'X-Account-Id': 'acct-1' },
    })

    expect(openaiCtor).toHaveBeenCalledTimes(1)
    const opts = openaiCtor.mock.calls[0]![0] as Record<string, unknown>
    expect(opts.fetch).toBe(sentinelFetch)
    expect(opts.defaultHeaders).toEqual({ 'X-Account-Id': 'acct-1' })
  })

  it('forwards fetch and defaultHeaders to the Anthropic client', () => {
    new AnthropicProvider({
      apiKey: 'sk-ant-test',
      fetch: sentinelFetch,
      defaultHeaders: { 'X-Account-Id': 'acct-2' },
    })

    const opts = anthropicCtor.mock.calls[0]![0] as Record<string, unknown>
    expect(opts.fetch).toBe(sentinelFetch)
    expect(opts.defaultHeaders).toEqual({ 'X-Account-Id': 'acct-2' })
  })
})

describe('transport options reach the SDK — dynamic apiKeyProvider path', () => {
  // This is the path that matters most: the gateway wires every provider
  // through `apiKeyProvider` so each call flows through resolve → audit →
  // spend gate. A hook that worked only on the static path would vanish in
  // production while passing every static-path test.

  it('forwards fetch on the OpenAI dynamic path, on every stream call', async () => {
    const provider = new OpenAIProvider({
      apiKeyProvider: async () => 'resolved-key',
      fetch: sentinelFetch,
      defaultHeaders: { 'X-Account-Id': 'acct-3' },
    })

    // Nothing is constructed until a stream begins — the key is resolved per call.
    expect(openaiCtor).not.toHaveBeenCalled()

    await drain(provider.stream(baseRequest()))

    expect(openaiCtor).toHaveBeenCalledTimes(1)
    const opts = openaiCtor.mock.calls[0]![0] as Record<string, unknown>
    expect(opts.apiKey).toBe('resolved-key')
    expect(opts.fetch).toBe(sentinelFetch)
    expect(opts.defaultHeaders).toEqual({ 'X-Account-Id': 'acct-3' })
  })

  it('re-applies the hook on each subsequent stream (fresh client per call)', async () => {
    const provider = new OpenAIProvider({
      apiKeyProvider: async () => 'resolved-key',
      fetch: sentinelFetch,
    })

    await drain(provider.stream(baseRequest()))
    await drain(provider.stream(baseRequest()))

    expect(openaiCtor).toHaveBeenCalledTimes(2)
    for (const call of openaiCtor.mock.calls) {
      expect((call[0] as Record<string, unknown>).fetch).toBe(sentinelFetch)
    }
  })
})

describe('OpenRouter inherits the transport contract', () => {
  it('forwards fetch while keeping its own baseURL', () => {
    new OpenRouterProvider({ apiKey: 'sk-or', fetch: sentinelFetch })

    const opts = openaiCtor.mock.calls[0]![0] as Record<string, unknown>
    expect(opts.fetch).toBe(sentinelFetch)
    expect(opts.baseURL).toBe('https://openrouter.ai/api/v1')
  })

  it('allows the endpoint to be redirected for testing against a fake', () => {
    new OpenRouterProvider({ apiKey: 'sk-or', baseURL: 'http://127.0.0.1:9/v1' })

    const opts = openaiCtor.mock.calls[0]![0] as Record<string, unknown>
    expect(opts.baseURL).toBe('http://127.0.0.1:9/v1')
  })
})

// -------------------------------------------------------------------------
// Property 2 — an adapter that cannot honour an option refuses it
// -------------------------------------------------------------------------

describe('Google refuses a custom fetch instead of silently ignoring it', () => {
  it('throws ConfigError naming the offending field', () => {
    expect(() => new GoogleProvider({ apiKey: 'g-test', fetch: sentinelFetch })).toThrow(
      ConfigError,
    )

    try {
      new GoogleProvider({ apiKey: 'g-test', fetch: sentinelFetch })
      expect.unreachable('constructor should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError)
      expect((err as ConfigError).field).toBe('fetch')
      // The message must say what to do instead, not just what failed.
      expect((err as ConfigError).message).toMatch(/defaultHeaders|baseURL/)
    }
  })

  it('throws before constructing any SDK client — no half-wired provider', () => {
    expect(() => new GoogleProvider({ apiKey: 'g-test', fetch: sentinelFetch })).toThrow()
    expect(googleCtor).not.toHaveBeenCalled()
  })

  it('still accepts the options it CAN honour', async () => {
    const provider = new GoogleProvider({
      apiKey: 'g-test',
      baseURL: 'http://127.0.0.1:9',
      defaultHeaders: { 'X-Account-Id': 'acct-4' },
    })

    await drain(provider.stream(baseRequest('gemini-2.5-pro')))

    // Transport lands in getGenerativeModel's RequestOptions — this SDK's only seam.
    const requestOptions = getGenerativeModel.mock.calls[0]![1] as Record<string, unknown>
    expect(requestOptions.baseUrl).toBe('http://127.0.0.1:9')
    expect(requestOptions.customHeaders).toEqual({ 'X-Account-Id': 'acct-4' })
  })
})

// -------------------------------------------------------------------------
// Property 3 — omitting the options changes nothing
// -------------------------------------------------------------------------

describe('omitting transport options leaves the existing path unchanged', () => {
  it('does not introduce fetch/defaultHeaders keys on the OpenAI client', () => {
    new OpenAIProvider({ apiKey: 'sk-test' })

    const opts = openaiCtor.mock.calls[0]![0] as Record<string, unknown>
    // Absent, not `undefined` — an explicit `fetch: undefined` would override
    // the SDK's own default rather than leaving it alone.
    expect('fetch' in opts).toBe(false)
    expect('defaultHeaders' in opts).toBe(false)
  })

  it('does not introduce them on the Anthropic client', () => {
    new AnthropicProvider({ apiKey: 'sk-ant-test' })

    const opts = anthropicCtor.mock.calls[0]![0] as Record<string, unknown>
    expect('fetch' in opts).toBe(false)
    expect('defaultHeaders' in opts).toBe(false)
  })

  it('passes empty RequestOptions to Google when nothing is configured', async () => {
    const provider = new GoogleProvider({ apiKey: 'g-test' })
    await drain(provider.stream(baseRequest('gemini-2.5-pro')))

    expect(getGenerativeModel.mock.calls[0]![1]).toEqual({})
  })
})

// -------------------------------------------------------------------------
// helpers
// -------------------------------------------------------------------------

function baseRequest(model = 'gpt-4o') {
  return {
    model,
    system: 'sys',
    messages: [{ role: 'user' as const, content: 'hi' }],
    tools: [],
    maxTokens: 16,
    temperature: null,
  } as never
}

/** Run a stream to completion, ignoring chunks and any terminal error. */
async function drain(stream: AsyncGenerator<unknown>): Promise<void> {
  try {
    for await (const _ of stream) {
      /* discard */
    }
  } catch {
    // The mocked SDKs yield nothing and some adapters then fail to assemble a
    // terminal chunk. Irrelevant here — these tests assert on construction.
  }
}
