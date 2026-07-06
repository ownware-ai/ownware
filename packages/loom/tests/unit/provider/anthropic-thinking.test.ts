/**
 * Anthropic extended-thinking adapter tests (no network).
 *
 * Covers the validation contract and the round-trip of thinking blocks
 * between the SDK-shaped final message and the Loom message format.
 * Network-backed assertions live in src/__tests__/e2e/real-agent.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AnthropicProvider } from '../../../src/provider/anthropic.js'
import type { ProviderRequest } from '../../../src/provider/types.js'
import type { Message } from '../../../src/messages/types.js'

// ---------------------------------------------------------------------------
// SDK mock: capture the params passed to messages.stream() and replay a
// scripted stream + finalMessage() back to the adapter.
// ---------------------------------------------------------------------------

interface MockStreamScript {
  readonly events: readonly unknown[]
  readonly finalMessage: {
    content: unknown[]
    stop_reason: string
    usage: {
      input_tokens: number
      output_tokens: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
    }
  }
}

const streamCapture: {
  lastParams: Record<string, unknown> | null
  lastScript: MockStreamScript | null
} = { lastParams: null, lastScript: null }

function setMockScript(script: MockStreamScript): void {
  streamCapture.lastScript = script
}

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    messages = {
      stream: (params: Record<string, unknown>) => {
        streamCapture.lastParams = params
        const script = streamCapture.lastScript ?? {
          events: [],
          finalMessage: {
            content: [],
            stop_reason: 'end_turn',
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        }
        async function* iterate() {
          for (const evt of script.events) yield evt
        }
        const iterator = iterate()
        return {
          [Symbol.asyncIterator]: () => iterator,
          finalMessage: async () => script.finalMessage,
          abort: () => {},
        }
      },
    }
  }
  return { default: MockAnthropic }
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(overrides?: Partial<ProviderRequest>): ProviderRequest {
  return {
    model: 'claude-sonnet-4-6',
    system: 'You are helpful.',
    messages: [{ role: 'user', content: 'Hello' }],
    tools: [],
    maxTokens: 4096,
    temperature: null,
    ...overrides,
  }
}

async function drain(gen: AsyncGenerator<unknown>): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const c of gen) out.push(c)
  return out
}

describe('AnthropicProvider — extended thinking', () => {
  let provider: AnthropicProvider

  beforeEach(() => {
    streamCapture.lastParams = null
    streamCapture.lastScript = null
    provider = new AnthropicProvider({ apiKey: 'test-key' })
  })

  // ── Validation ───────────────────────────────────────────────────────────

  it('omits the thinking param when config is absent', async () => {
    setMockScript({
      events: [],
      finalMessage: {
        content: [{ type: 'text', text: 'hi' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    })
    await drain(provider.stream(makeRequest()))
    expect(streamCapture.lastParams).not.toBeNull()
    expect(streamCapture.lastParams!.thinking).toBeUndefined()
  })

  it('omits the thinking param when enabled is false', async () => {
    setMockScript({
      events: [],
      finalMessage: {
        content: [{ type: 'text', text: 'hi' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    })
    await drain(provider.stream(makeRequest({
      thinking: { enabled: false, budgetTokens: 4096 },
    })))
    expect(streamCapture.lastParams!.thinking).toBeUndefined()
  })

  it('passes thinking param to the API when enabled with valid budget', async () => {
    setMockScript({
      events: [],
      finalMessage: {
        content: [{ type: 'text', text: 'hi' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    })
    await drain(provider.stream(makeRequest({
      maxTokens: 8192,
      thinking: { enabled: true, budgetTokens: 2048 },
    })))
    expect(streamCapture.lastParams!.thinking).toEqual({
      type: 'enabled',
      budget_tokens: 2048,
    })
  })

  it('throws when model does not support reasoning', async () => {
    await expect(drain(provider.stream(makeRequest({
      model: 'claude-3-5-haiku-20241022',
      thinking: { enabled: true, budgetTokens: 2048 },
    })))).rejects.toThrow(/not supported by model/)
  })

  it('throws when budget is below the 1024-token floor', async () => {
    await expect(drain(provider.stream(makeRequest({
      thinking: { enabled: true, budgetTokens: 512 },
    })))).rejects.toThrow(/budgetTokens must be an integer >= 1024/)
  })

  it('throws when budget is not an integer', async () => {
    await expect(drain(provider.stream(makeRequest({
      thinking: { enabled: true, budgetTokens: 1024.5 },
    })))).rejects.toThrow(/budgetTokens must be an integer >= 1024/)
  })

  it('throws when budget equals maxTokens', async () => {
    await expect(drain(provider.stream(makeRequest({
      maxTokens: 2048,
      thinking: { enabled: true, budgetTokens: 2048 },
    })))).rejects.toThrow(/strictly less than maxTokens/)
  })

  it('throws when budget exceeds maxTokens', async () => {
    await expect(drain(provider.stream(makeRequest({
      maxTokens: 2048,
      thinking: { enabled: true, budgetTokens: 4096 },
    })))).rejects.toThrow(/strictly less than maxTokens/)
  })

  // ── Streaming + final-message content ────────────────────────────────────

  it('yields thinking_delta chunks and preserves signature on final content', async () => {
    setMockScript({
      events: [
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm ' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'let me check' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-abc' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'text' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'ok' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'message_stop' },
      ],
      finalMessage: {
        content: [
          { type: 'thinking', thinking: 'hmm let me check', signature: 'sig-abc' },
          { type: 'text', text: 'ok' },
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    })

    const chunks = await drain(provider.stream(makeRequest({
      maxTokens: 8192,
      thinking: { enabled: true, budgetTokens: 2048 },
    }))) as Array<{ type: string; text?: string; content?: Array<{ type: string; text?: string; signature?: string }> }>

    const thinkingDeltas = chunks.filter(c => c.type === 'thinking_delta')
    expect(thinkingDeltas).toHaveLength(2)
    expect(thinkingDeltas.map(c => c.text).join('')).toBe('hmm let me check')

    const final = chunks.find(c => c.type === 'message_complete')!
    const thinkingBlock = final.content!.find(b => b.type === 'thinking')!
    expect(thinkingBlock.text).toBe('hmm let me check')
    expect(thinkingBlock.signature).toBe('sig-abc')
  })

  it('round-trips redacted_thinking blocks in the final message', async () => {
    setMockScript({
      events: [],
      finalMessage: {
        content: [
          { type: 'redacted_thinking', data: 'REDACTED_DATA' },
          { type: 'text', text: 'ok' },
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    })

    const chunks = await drain(provider.stream(makeRequest())) as Array<{
      type: string
      content?: Array<{ type: string; data?: string }>
    }>
    const final = chunks.find(c => c.type === 'message_complete')!
    const redacted = final.content!.find(b => b.type === 'redacted_thinking')!
    expect(redacted.data).toBe('REDACTED_DATA')
  })

  // ── Assistant-message serialization (round-trip for next request) ────────

  it('serializes thinking blocks with signature back into the next request', async () => {
    setMockScript({
      events: [],
      finalMessage: {
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    })

    const priorAssistant: Message = {
      role: 'assistant',
      content: [
        { type: 'thinking', text: 'prior reasoning', signature: 'sig-123' },
        { type: 'tool_use', id: 'tu_1', name: 'calc', input: { a: 1 } },
      ],
    }

    await drain(provider.stream(makeRequest({
      messages: [
        { role: 'user', content: 'go' },
        priorAssistant,
        {
          role: 'user',
          content: [{ type: 'tool_result', toolUseId: 'tu_1', content: '2', isError: false }],
        },
      ],
    })))

    const sentMessages = streamCapture.lastParams!.messages as Array<{
      role: string
      content: Array<Record<string, unknown>>
    }>
    const assistantSent = sentMessages.find(m => m.role === 'assistant')!
    const thinkingSent = assistantSent.content.find(b => b.type === 'thinking')
    expect(thinkingSent).toBeDefined()
    expect(thinkingSent).toMatchObject({
      type: 'thinking',
      thinking: 'prior reasoning',
      signature: 'sig-123',
    })
  })

  it('drops thinking blocks with no signature rather than sending an invalid block', async () => {
    setMockScript({
      events: [],
      finalMessage: {
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    })

    const priorAssistant: Message = {
      role: 'assistant',
      content: [
        { type: 'thinking', text: 'leaked thought' },
        { type: 'text', text: 'visible answer' },
      ],
    }

    await drain(provider.stream(makeRequest({
      messages: [
        { role: 'user', content: 'hi' },
        priorAssistant,
        { role: 'user', content: 'again' },
      ],
    })))

    const sentMessages = streamCapture.lastParams!.messages as Array<{
      role: string
      content: Array<Record<string, unknown>>
    }>
    const assistantSent = sentMessages.find(m => m.role === 'assistant')!
    expect(assistantSent.content.find(b => b.type === 'thinking')).toBeUndefined()
    expect(assistantSent.content.find(b => b.type === 'text')).toMatchObject({
      type: 'text',
      text: 'visible answer',
    })
  })

  it('serializes redacted_thinking blocks back into the next request', async () => {
    setMockScript({
      events: [],
      finalMessage: {
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    })

    const priorAssistant: Message = {
      role: 'assistant',
      content: [
        { type: 'redacted_thinking', data: 'REDACTED_X' },
        { type: 'text', text: 'ok' },
      ],
    }

    await drain(provider.stream(makeRequest({
      messages: [
        { role: 'user', content: 'hi' },
        priorAssistant,
        { role: 'user', content: 'go' },
      ],
    })))

    const sentMessages = streamCapture.lastParams!.messages as Array<{
      role: string
      content: Array<Record<string, unknown>>
    }>
    const assistantSent = sentMessages.find(m => m.role === 'assistant')!
    const redacted = assistantSent.content.find(b => b.type === 'redacted_thinking')
    expect(redacted).toMatchObject({ type: 'redacted_thinking', data: 'REDACTED_X' })
  })
})
