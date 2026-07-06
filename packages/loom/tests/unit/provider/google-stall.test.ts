/**
 * Unit Tests — Google Provider Stall Detection
 *
 * Verifies that the Google provider detects stream stalls via withStallGuard
 * and throws ProviderError after the configured timeout.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { GoogleProvider } from '../../../src/provider/google.js'
import type { ProviderChunk, ProviderRequest } from '../../../src/provider/types.js'
import { ProviderError } from '../../../src/core/errors.js'

// Mock @google/generative-ai
vi.mock('@google/generative-ai', () => {
  const mockGenerateContentStream = vi.fn()
  const mockCountTokens = vi.fn()

  return {
    GoogleGenerativeAI: class {
      getGenerativeModel() {
        return {
          generateContentStream: mockGenerateContentStream,
          countTokens: mockCountTokens,
        }
      }
    },
    __mockGenerateContentStream: mockGenerateContentStream,
    __mockCountTokens: mockCountTokens,
  }
})

function makeRequest(overrides?: Partial<ProviderRequest>): ProviderRequest {
  return {
    model: 'gemini-2.5-pro',
    system: 'You are helpful.',
    messages: [{ role: 'user', content: 'Hello' }],
    tools: [],
    maxTokens: 100,
    temperature: null,
    ...overrides,
  }
}

describe('Google Provider — stall detection', () => {
  let provider: GoogleProvider

  beforeEach(() => {
    vi.useFakeTimers()
    provider = new GoogleProvider({ apiKey: 'test-key' })
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('throws ProviderError after stall timeout with no events', async () => {
    const { __mockGenerateContentStream } = await import('@google/generative-ai') as unknown as {
      __mockGenerateContentStream: ReturnType<typeof vi.fn>
    }

    __mockGenerateContentStream.mockResolvedValue({
      stream: {
        [Symbol.asyncIterator]: () => {
          let yielded = false
          return {
            next() {
              if (!yielded) {
                yielded = true
                return Promise.resolve({
                  done: false as const,
                  value: {
                    candidates: [{ content: { parts: [{ text: 'Hi' }] } }],
                    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 },
                  },
                })
              }
              return new Promise<IteratorResult<unknown>>(() => {})
            },
            return() {
              return Promise.resolve({ done: true as const, value: undefined })
            },
          }
        },
      },
    })

    const gen = provider.stream(makeRequest({ stallWarnMs: 100, stallTimeoutMs: 200 }))

    // Get first chunk
    const first = await gen.next()
    expect(first.done).toBe(false)

    // Attach error handler before advancing timers
    const nextPromise = gen.next()
    const caughtError = nextPromise.catch((e: unknown) => e)

    await vi.advanceTimersByTimeAsync(250)

    const err = await caughtError
    expect(err).toBeInstanceOf(ProviderError)
  })

  it('does not stall-timeout when events arrive regularly', async () => {
    const { __mockGenerateContentStream } = await import('@google/generative-ai') as unknown as {
      __mockGenerateContentStream: ReturnType<typeof vi.fn>
    }

    __mockGenerateContentStream.mockResolvedValue({
      stream: (async function* () {
        yield {
          candidates: [{ content: { parts: [{ text: 'Hello from Gemini' }] } }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
        }
      })(),
    })

    const chunks: ProviderChunk[] = []
    for await (const chunk of provider.stream(makeRequest({ stallWarnMs: 100, stallTimeoutMs: 200 }))) {
      chunks.push(chunk)
    }

    const textDeltas = chunks.filter(c => c.type === 'text_delta')
    expect(textDeltas).toHaveLength(1)
    expect(chunks.find(c => c.type === 'message_complete')).toBeDefined()
  })

  it('uses default timeouts when not configured', async () => {
    const { __mockGenerateContentStream } = await import('@google/generative-ai') as unknown as {
      __mockGenerateContentStream: ReturnType<typeof vi.fn>
    }

    __mockGenerateContentStream.mockResolvedValue({
      stream: (async function* () {
        yield {
          candidates: [{ content: { parts: [{ text: 'ok' }] } }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 },
        }
      })(),
    })

    const chunks: ProviderChunk[] = []
    for await (const chunk of provider.stream(makeRequest())) {
      chunks.push(chunk)
    }

    expect(chunks.find(c => c.type === 'message_complete')).toBeDefined()
  })
})
