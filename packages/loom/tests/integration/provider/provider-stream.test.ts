import { describe, it, expect } from 'vitest'
import { AnthropicProvider } from '../../../src/provider/anthropic.js'
import { OpenAIProvider } from '../../../src/provider/openai.js'
import type { ProviderChunk, ProviderRequest } from '../../../src/provider/types.js'

const hasAnthropicKey = !!process.env.ANTHROPIC_API_KEY
const hasOpenAIKey = !!process.env.OPENAI_API_KEY

function makeSimpleRequest(model: string): ProviderRequest {
  return {
    model,
    system: 'Respond with exactly one word.',
    messages: [{ role: 'user', content: 'Say "hello"' }],
    tools: [],
    maxTokens: 30,
    temperature: 0,
  }
}

describe.skipIf(!hasAnthropicKey)('AnthropicProvider — real API', () => {
  it('streams a text response', async () => {
    const provider = new AnthropicProvider()
    const chunks: ProviderChunk[] = []

    for await (const chunk of provider.stream(
      makeSimpleRequest('claude-haiku-4-5-20251001'),
    )) {
      chunks.push(chunk)
    }

    // Must have at least one text_delta
    const textDeltas = chunks.filter(c => c.type === 'text_delta')
    expect(textDeltas.length).toBeGreaterThan(0)

    // Must end with message_complete
    const complete = chunks[chunks.length - 1]!
    expect(complete.type).toBe('message_complete')
    if (complete.type === 'message_complete') {
      expect(complete.stopReason).toBe('end_turn')
      expect(complete.content.length).toBeGreaterThan(0)
      expect(complete.usage.inputTokens).toBeGreaterThan(0)
      expect(complete.usage.outputTokens).toBeGreaterThan(0)
    }
  }, 30_000)

  it('countTokens returns a number', async () => {
    const provider = new AnthropicProvider()
    const count = await provider.countTokens(
      [{ role: 'user', content: 'Hello world' }],
      'System prompt',
    )
    expect(count).toBeGreaterThan(0)
    expect(typeof count).toBe('number')
  }, 15_000)
})

describe.skipIf(!hasOpenAIKey)('OpenAIProvider — real API', () => {
  it('streams a text response', async () => {
    const provider = new OpenAIProvider()
    const chunks: ProviderChunk[] = []

    for await (const chunk of provider.stream(
      makeSimpleRequest('gpt-4o-mini'),
    )) {
      chunks.push(chunk)
    }

    // Must have at least one text_delta
    const textDeltas = chunks.filter(c => c.type === 'text_delta')
    expect(textDeltas.length).toBeGreaterThan(0)

    // Must end with message_complete
    const complete = chunks[chunks.length - 1]!
    expect(complete.type).toBe('message_complete')
    if (complete.type === 'message_complete') {
      expect(complete.stopReason).toBe('end_turn')
      expect(complete.content.length).toBeGreaterThan(0)
    }
  }, 30_000)

  it('handles tool calling', async () => {
    const provider = new OpenAIProvider()
    const chunks: ProviderChunk[] = []

    const request: ProviderRequest = {
      model: 'gpt-4o-mini',
      system: 'You are a helpful assistant. When asked about weather, always use the get_weather tool.',
      messages: [{ role: 'user', content: 'What is the weather in Tokyo?' }],
      tools: [{
        name: 'get_weather',
        description: 'Get current weather for a location',
        inputSchema: {
          type: 'object',
          properties: {
            location: { type: 'string', description: 'City name' },
          },
          required: ['location'],
        },
      }],
      maxTokens: 200,
      temperature: 0,
    }

    for await (const chunk of provider.stream(request)) {
      chunks.push(chunk)
    }

    // Should have tool_use chunks
    const toolStart = chunks.find(c => c.type === 'tool_use_start')
    expect(toolStart).toBeDefined()
    if (toolStart?.type === 'tool_use_start') {
      expect(toolStart.name).toBe('get_weather')
    }

    const toolEnd = chunks.find(c => c.type === 'tool_use_end')
    expect(toolEnd).toBeDefined()

    const complete = chunks.find(c => c.type === 'message_complete')!
    expect(complete.type).toBe('message_complete')
    if (complete.type === 'message_complete') {
      expect(complete.stopReason).toBe('tool_use')
      expect(complete.content.some(b => b.type === 'tool_use')).toBe(true)
    }
  }, 30_000)
})
