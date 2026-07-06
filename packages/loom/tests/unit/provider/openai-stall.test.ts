/**
 * Unit Tests — OpenAI Provider Stall Detection
 *
 * Verifies that the OpenAI provider detects stream stalls via withStallGuard
 * and throws ProviderError after the configured timeout.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { OpenAIProvider } from '../../../src/provider/openai.js'
import type { ProviderChunk, ProviderRequest } from '../../../src/provider/types.js'
import { ProviderError } from '../../../src/core/errors.js'

// Mock the openai module
vi.mock('openai', () => {
  return {
    default: class MockOpenAI {
      chat = {
        completions: {
          create: vi.fn(),
        },
      }
    },
  }
})

function makeRequest(overrides?: Partial<ProviderRequest>): ProviderRequest {
  return {
    model: 'gpt-4o',
    system: 'You are helpful.',
    messages: [{ role: 'user', content: 'Hello' }],
    tools: [],
    maxTokens: 100,
    temperature: null,
    ...overrides,
  }
}

describe('OpenAI Provider — stall detection', () => {
  let provider: OpenAIProvider

  beforeEach(() => {
    vi.useFakeTimers()
    provider = new OpenAIProvider({ apiKey: 'test-key' })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('throws ProviderError after stall timeout with no events', async () => {
    const mockStream = {
      [Symbol.asyncIterator]: () => {
        let yielded = false
        return {
          next() {
            if (!yielded) {
              yielded = true
              return Promise.resolve({
                done: false as const,
                value: { choices: [{ index: 0, delta: { content: 'Hi' }, finish_reason: null }], usage: null },
              })
            }
            return new Promise<IteratorResult<unknown>>(() => {})
          },
          return() {
            return Promise.resolve({ done: true as const, value: undefined })
          },
        }
      },
    }

    const client = (provider as unknown as { staticClient: { chat: { completions: { create: ReturnType<typeof vi.fn> } } } }).staticClient
    client.chat.completions.create.mockResolvedValue(mockStream)

    const gen = provider.stream(makeRequest({ stallWarnMs: 100, stallTimeoutMs: 200 }))

    // Get first chunk
    const first = await gen.next()
    expect(first.done).toBe(false)

    // Attach error handler before advancing timers to prevent unhandled rejection
    const nextPromise = gen.next()
    const caughtError = nextPromise.catch((e: unknown) => e)

    await vi.advanceTimersByTimeAsync(250)

    const err = await caughtError
    expect(err).toBeInstanceOf(ProviderError)
  })

  it('does not stall-timeout when events arrive regularly', async () => {
    const mockChunks = [
      { choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }], usage: null },
      { choices: [{ index: 0, delta: { content: ' world' }, finish_reason: 'stop' }], usage: null },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ]

    const mockStream = {
      [Symbol.asyncIterator]: async function* () {
        for (const chunk of mockChunks) yield chunk
      },
    }

    const client = (provider as unknown as { staticClient: { chat: { completions: { create: ReturnType<typeof vi.fn> } } } }).staticClient
    client.chat.completions.create.mockResolvedValue(mockStream)

    const chunks: ProviderChunk[] = []
    for await (const chunk of provider.stream(makeRequest({ stallWarnMs: 100, stallTimeoutMs: 200 }))) {
      chunks.push(chunk)
    }

    const textDeltas = chunks.filter(c => c.type === 'text_delta')
    expect(textDeltas).toHaveLength(2)
    expect(chunks.find(c => c.type === 'message_complete')).toBeDefined()
  })

  it('uses default timeouts when not configured', async () => {
    const mockChunks = [
      { choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }], usage: null },
      { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } },
    ]

    const mockStream = {
      [Symbol.asyncIterator]: async function* () {
        for (const chunk of mockChunks) yield chunk
      },
    }

    const client = (provider as unknown as { staticClient: { chat: { completions: { create: ReturnType<typeof vi.fn> } } } }).staticClient
    client.chat.completions.create.mockResolvedValue(mockStream)

    const chunks: ProviderChunk[] = []
    for await (const chunk of provider.stream(makeRequest())) {
      chunks.push(chunk)
    }

    expect(chunks.find(c => c.type === 'message_complete')).toBeDefined()
  })
})
