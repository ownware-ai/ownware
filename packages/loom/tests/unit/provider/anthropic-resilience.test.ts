/**
 * Anthropic adapter resilience — stop-reason mapping, overloaded-error
 * detection, compaction-iteration usage summation.
 *
 * All network-free; exercises the adapter against a scripted SDK mock.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AnthropicProvider } from '../../../src/provider/anthropic.js'
import type { ProviderRequest } from '../../../src/provider/types.js'
import { ProviderError } from '../../../src/core/errors.js'

interface MockStreamScript {
  readonly events: readonly unknown[]
  readonly finalMessage: Record<string, unknown>
}

const cap: { script: MockStreamScript | null } = { script: null }
function setScript(s: MockStreamScript) { cap.script = s }

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    messages = {
      stream: () => {
        const script = cap.script ?? {
          events: [],
          finalMessage: {
            content: [],
            stop_reason: 'end_turn',
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        }
        async function* iterate() {
          for (const e of script.events) yield e
        }
        const it = iterate()
        return {
          [Symbol.asyncIterator]: () => it,
          finalMessage: async () => script.finalMessage,
          abort: () => {},
        }
      },
    }
  }
  return { default: MockAnthropic }
})

function makeRequest(overrides?: Partial<ProviderRequest>): ProviderRequest {
  return {
    model: 'claude-sonnet-4-6',
    system: 'sys',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    maxTokens: 1024,
    temperature: null,
    ...overrides,
  }
}

async function drain(gen: AsyncGenerator<unknown>): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const c of gen) out.push(c)
  return out
}

describe('AnthropicProvider — stop reason mapping', () => {
  let provider: AnthropicProvider

  beforeEach(() => {
    cap.script = null
    provider = new AnthropicProvider({ apiKey: 'test' })
  })

  it('maps end_turn', async () => {
    setScript({
      events: [],
      finalMessage: {
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    })
    const chunks = await drain(provider.stream(makeRequest())) as Array<{ type: string; stopReason?: string }>
    const mc = chunks.find(c => c.type === 'message_complete')!
    expect(mc.stopReason).toBe('end_turn')
  })

  it('maps tool_use', async () => {
    setScript({
      events: [],
      finalMessage: {
        content: [{ type: 'text', text: '' }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    })
    const chunks = await drain(provider.stream(makeRequest())) as Array<{ type: string; stopReason?: string }>
    expect((chunks.find(c => c.type === 'message_complete') as { stopReason: string }).stopReason).toBe('tool_use')
  })

  it('maps max_tokens', async () => {
    setScript({
      events: [],
      finalMessage: {
        content: [{ type: 'text', text: 'partial' }],
        stop_reason: 'max_tokens',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    })
    const chunks = await drain(provider.stream(makeRequest())) as Array<{ type: string; stopReason?: string }>
    expect((chunks.find(c => c.type === 'message_complete') as { stopReason: string }).stopReason).toBe('max_tokens')
  })

  it('maps refusal — content policy block surfaces as refusal, not end_turn', async () => {
    setScript({
      events: [],
      finalMessage: {
        content: [{ type: 'text', text: 'I cannot help with that.' }],
        stop_reason: 'refusal',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    })
    const chunks = await drain(provider.stream(makeRequest())) as Array<{ type: string; stopReason?: string }>
    expect((chunks.find(c => c.type === 'message_complete') as { stopReason: string }).stopReason).toBe('refusal')
  })

  it('maps pause_turn', async () => {
    setScript({
      events: [],
      finalMessage: {
        content: [{ type: 'thinking', thinking: 'still working', signature: 'sig' }],
        stop_reason: 'pause_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    })
    const chunks = await drain(provider.stream(makeRequest())) as Array<{ type: string; stopReason?: string }>
    expect((chunks.find(c => c.type === 'message_complete') as { stopReason: string }).stopReason).toBe('pause_turn')
  })

  it('maps stop_sequence', async () => {
    setScript({
      events: [],
      finalMessage: {
        content: [{ type: 'text', text: 'hit the stop' }],
        stop_reason: 'stop_sequence',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    })
    const chunks = await drain(provider.stream(makeRequest())) as Array<{ type: string; stopReason?: string }>
    expect((chunks.find(c => c.type === 'message_complete') as { stopReason: string }).stopReason).toBe('stop_sequence')
  })

  it('maps null stop_reason to end_turn', async () => {
    setScript({
      events: [],
      finalMessage: {
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    })
    const chunks = await drain(provider.stream(makeRequest())) as Array<{ type: string; stopReason?: string }>
    expect((chunks.find(c => c.type === 'message_complete') as { stopReason: string }).stopReason).toBe('end_turn')
  })

  it('forward-compat: unknown stop_reason falls back to end_turn with a warn', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setScript({
      events: [],
      finalMessage: {
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'some_future_reason',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    })
    const chunks = await drain(provider.stream(makeRequest())) as Array<{ type: string; stopReason?: string }>
    expect((chunks.find(c => c.type === 'message_complete') as { stopReason: string }).stopReason).toBe('end_turn')
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown stop_reason "some_future_reason"'))
    warnSpy.mockRestore()
  })
})

describe('AnthropicProvider — overloaded_error detection', () => {
  let provider: AnthropicProvider

  beforeEach(() => {
    cap.script = null
    provider = new AnthropicProvider({ apiKey: 'test' })
  })

  it('throws retryable ProviderError with 529 when overloaded_error is present', async () => {
    setScript({
      events: [],
      finalMessage: {
        content: [],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0 },
        error: { type: 'overloaded_error', message: 'Anthropic is temporarily overloaded' },
      },
    })
    try {
      await drain(provider.stream(makeRequest()))
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError)
      const pe = err as ProviderError
      expect(pe.statusCode).toBe(529)
      expect(pe.recoverable).toBe(true)
      expect(pe.message).toMatch(/overloaded/i)
    }
  })

  it('throws unrecoverable ProviderError when a non-overload error is present in the body', async () => {
    setScript({
      events: [],
      finalMessage: {
        content: [],
        stop_reason: null,
        usage: { input_tokens: 0, output_tokens: 0 },
        error: { type: 'invalid_request_error', message: 'bad params' },
      },
    })
    try {
      await drain(provider.stream(makeRequest()))
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError)
      expect((err as ProviderError).recoverable).toBe(false)
      expect((err as ProviderError).message).toMatch(/bad params/)
    }
  })

  it('does not throw when no error field is present (happy path)', async () => {
    setScript({
      events: [],
      finalMessage: {
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    })
    const chunks = await drain(provider.stream(makeRequest())) as Array<{ type: string }>
    expect(chunks.find(c => c.type === 'message_complete')).toBeDefined()
  })
})

describe('AnthropicProvider — usage.iterations summation', () => {
  let provider: AnthropicProvider

  beforeEach(() => {
    cap.script = null
    provider = new AnthropicProvider({ apiKey: 'test' })
  })

  it('passes through usage verbatim when no iterations[] present', async () => {
    setScript({
      events: [],
      finalMessage: {
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 10,
        },
      },
    })
    const chunks = await drain(provider.stream(makeRequest())) as Array<{
      type: string
      usage?: Record<string, number>
    }>
    const mc = chunks.find(c => c.type === 'message_complete')!
    expect(mc.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 20,
      cacheCreationTokens: 10,
    })
  })

  it('sums iterations[] into the top-level usage when compaction occurred', async () => {
    setScript({
      events: [],
      finalMessage: {
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: {
          // Top-level = final iteration only
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 5,
          iterations: [
            { input_tokens: 500, output_tokens: 80, cache_read_input_tokens: 40, cache_creation_input_tokens: 15 },
            { input_tokens: 200, output_tokens: 30, cache_read_input_tokens: 20, cache_creation_input_tokens: 10 },
          ],
        },
      },
    })
    const chunks = await drain(provider.stream(makeRequest())) as Array<{
      type: string
      usage?: Record<string, number>
    }>
    const mc = chunks.find(c => c.type === 'message_complete')!
    // 100 + 500 + 200, 20 + 80 + 30, 10 + 40 + 20, 5 + 15 + 10
    expect(mc.usage).toEqual({
      inputTokens: 800,
      outputTokens: 130,
      cacheReadTokens: 70,
      cacheCreationTokens: 30,
    })
  })

  it('handles iterations entries with missing cache_* fields', async () => {
    setScript({
      events: [],
      finalMessage: {
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 50,
          output_tokens: 10,
          iterations: [
            { input_tokens: 100, output_tokens: 20 },
            { input_tokens: 30 },
          ],
        },
      },
    })
    const chunks = await drain(provider.stream(makeRequest())) as Array<{
      type: string
      usage?: Record<string, number>
    }>
    const mc = chunks.find(c => c.type === 'message_complete')!
    expect(mc.usage).toEqual({
      inputTokens: 180,
      outputTokens: 30,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    })
  })
})
