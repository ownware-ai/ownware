import { describe, it, expect, vi, beforeEach } from 'vitest'
import { OpenAIProvider } from '../../../src/provider/openai.js'
import type { ProviderChunk, ProviderRequest } from '../../../src/provider/types.js'

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

describe('OpenAIProvider', () => {
  let provider: OpenAIProvider

  beforeEach(() => {
    provider = new OpenAIProvider({ apiKey: 'test-key' })
  })

  describe('metadata', () => {
    it('has name "openai"', () => {
      expect(provider.name).toBe('openai')
    })
  })

  describe('supportsFeature', () => {
    it('supports streaming', () => {
      expect(provider.supportsFeature('streaming')).toBe(true)
    })

    it('supports vision', () => {
      expect(provider.supportsFeature('vision')).toBe(true)
    })

    it('supports tool_use', () => {
      expect(provider.supportsFeature('tool_use')).toBe(true)
    })

    it('supports structured_output', () => {
      expect(provider.supportsFeature('structured_output')).toBe(true)
    })

    it('does not support thinking', () => {
      expect(provider.supportsFeature('thinking')).toBe(false)
    })

    it('does not support cache_control', () => {
      expect(provider.supportsFeature('cache_control')).toBe(false)
    })
  })

  describe('formatTools', () => {
    it('converts to OpenAI function calling format', () => {
      const tools = provider.formatTools([
        {
          name: 'read_file',
          description: 'Read a file',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'File path' },
            },
            required: ['path'],
          },
        },
      ])

      expect(tools).toHaveLength(1)
      expect(tools[0]).toMatchObject({
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a file',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'File path' },
            },
          },
        },
      })
    })
  })

  describe('countTokens', () => {
    it('estimates tokens for string messages', async () => {
      const count = await provider.countTokens(
        [{ role: 'user', content: 'Hello world' }],
        'System prompt',
      )
      expect(count).toBeGreaterThan(0)
      expect(typeof count).toBe('number')
    })

    it('estimates tokens for content block messages', async () => {
      const count = await provider.countTokens([
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'A long response with many words in it for testing' }],
        },
      ])
      expect(count).toBeGreaterThan(5)
    })

    it('handles tool_result blocks', async () => {
      const count = await provider.countTokens([
        {
          role: 'user',
          content: [
            { type: 'tool_result', toolUseId: 'id1', content: 'result text here', isError: false },
          ],
        },
      ])
      expect(count).toBeGreaterThan(0)
    })
  })

  describe('stream — mocked SDK', () => {
    it('yields text_delta and message_complete for text-only response', async () => {
      // Create mock stream
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

      // Access the mock
      const client = (provider as unknown as { staticClient: { chat: { completions: { create: ReturnType<typeof vi.fn> } } } }).staticClient
      client.chat.completions.create.mockResolvedValue(mockStream)

      const chunks: ProviderChunk[] = []
      for await (const chunk of provider.stream(makeRequest())) {
        chunks.push(chunk)
      }

      // Should have text deltas
      const textDeltas = chunks.filter(c => c.type === 'text_delta')
      expect(textDeltas).toHaveLength(2)
      expect(textDeltas[0]).toMatchObject({ type: 'text_delta', text: 'Hello' })
      expect(textDeltas[1]).toMatchObject({ type: 'text_delta', text: ' world' })

      // Should have message_complete
      const complete = chunks.find(c => c.type === 'message_complete')
      expect(complete).toBeDefined()
      expect(complete).toMatchObject({
        type: 'message_complete',
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'Hello world' }],
      })
    })

    it('yields tool_use chunks for function calling', async () => {
      const mockChunks = [
        {
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                id: 'call_abc',
                function: { name: 'read_file', arguments: '' },
              }],
            },
            finish_reason: null,
          }],
          usage: null,
        },
        {
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                function: { arguments: '{"path":' },
              }],
            },
            finish_reason: null,
          }],
          usage: null,
        },
        {
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                function: { arguments: '"/src/main.ts"}' },
              }],
            },
            finish_reason: 'tool_calls',
          }],
          usage: null,
        },
        { choices: [], usage: { prompt_tokens: 20, completion_tokens: 10 } },
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

      expect(chunks.find(c => c.type === 'tool_use_start')).toMatchObject({
        type: 'tool_use_start',
        id: 'call_abc',
        name: 'read_file',
      })

      const argDeltas = chunks.filter(c => c.type === 'tool_use_args_delta')
      expect(argDeltas.length).toBeGreaterThanOrEqual(2)

      expect(chunks.find(c => c.type === 'tool_use_end')).toMatchObject({
        type: 'tool_use_end',
        id: 'call_abc',
      })

      const complete = chunks.find(c => c.type === 'message_complete')!
      expect(complete.stopReason).toBe('tool_use')
      expect(complete.content).toContainEqual(
        expect.objectContaining({
          type: 'tool_use',
          id: 'call_abc',
          name: 'read_file',
          input: { path: '/src/main.ts' },
        }),
      )
    })

    it('maps "length" finish_reason to "max_tokens"', async () => {
      const mockChunks = [
        { choices: [{ index: 0, delta: { content: 'truncated' }, finish_reason: 'length' }], usage: null },
        { choices: [], usage: { prompt_tokens: 10, completion_tokens: 100 } },
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

      const complete = chunks.find(c => c.type === 'message_complete')!
      expect(complete.stopReason).toBe('max_tokens')
    })
  })
})
