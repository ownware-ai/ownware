import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GoogleProvider } from '../../../src/provider/google.js'
import type { ProviderChunk, ProviderRequest } from '../../../src/provider/types.js'

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
    // Export the mocks so tests can configure them
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

describe('GoogleProvider', () => {
  let provider: GoogleProvider

  beforeEach(() => {
    provider = new GoogleProvider({ apiKey: 'test-key' })
    vi.clearAllMocks()
  })

  describe('metadata', () => {
    it('has name "google"', () => {
      expect(provider.name).toBe('google')
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

    it('does not support thinking', () => {
      expect(provider.supportsFeature('thinking')).toBe(false)
    })

    it('does not support cache_control', () => {
      expect(provider.supportsFeature('cache_control')).toBe(false)
    })
  })

  describe('formatTools', () => {
    it('wraps tools in functionDeclarations', () => {
      const result = provider.formatTools([
        {
          name: 'search',
          description: 'Search the web',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
        },
      ])

      expect(result).toHaveLength(1)
      expect(result[0]).toHaveProperty('functionDeclarations')
      const decls = (result[0] as { functionDeclarations: unknown[] }).functionDeclarations
      expect(decls[0]).toMatchObject({
        name: 'search',
        description: 'Search the web',
      })
    })

    it('strips additionalProperties from schema', () => {
      const result = provider.formatTools([
        {
          name: 'test',
          description: 'Test',
          inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
        },
      ])

      const decls = (result[0] as { functionDeclarations: unknown[] }).functionDeclarations
      expect(decls[0]).not.toHaveProperty('parameters.additionalProperties')
    })
  })

  describe('stream — mocked SDK', () => {
    it('yields text_delta and message_complete for text response', async () => {
      const { __mockGenerateContentStream } = await import('@google/generative-ai') as unknown as {
        __mockGenerateContentStream: ReturnType<typeof vi.fn>
      }

      __mockGenerateContentStream.mockResolvedValue({
        stream: (async function* () {
          yield {
            candidates: [{
              content: { parts: [{ text: 'Hello from Gemini' }] },
            }],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
          }
        })(),
      })

      const chunks: ProviderChunk[] = []
      for await (const chunk of provider.stream(makeRequest())) {
        chunks.push(chunk)
      }

      const textDeltas = chunks.filter(c => c.type === 'text_delta')
      expect(textDeltas).toHaveLength(1)
      expect(textDeltas[0]).toMatchObject({ text: 'Hello from Gemini' })

      const complete = chunks.find(c => c.type === 'message_complete')!
      expect(complete.stopReason).toBe('end_turn')
      expect(complete.content).toContainEqual({ type: 'text', text: 'Hello from Gemini' })
      expect(complete.usage.inputTokens).toBe(10)
    })

    it('yields tool_use chunks for function calls', async () => {
      const { __mockGenerateContentStream } = await import('@google/generative-ai') as unknown as {
        __mockGenerateContentStream: ReturnType<typeof vi.fn>
      }

      __mockGenerateContentStream.mockResolvedValue({
        stream: (async function* () {
          yield {
            candidates: [{
              content: {
                parts: [{
                  functionCall: { name: 'read_file', args: { path: '/test.ts' } },
                }],
              },
            }],
            usageMetadata: { promptTokenCount: 15, candidatesTokenCount: 8 },
          }
        })(),
      })

      const chunks: ProviderChunk[] = []
      for await (const chunk of provider.stream(makeRequest())) {
        chunks.push(chunk)
      }

      expect(chunks.find(c => c.type === 'tool_use_start')).toMatchObject({
        type: 'tool_use_start',
        name: 'read_file',
      })

      expect(chunks.find(c => c.type === 'tool_use_args_delta')).toBeDefined()
      expect(chunks.find(c => c.type === 'tool_use_end')).toBeDefined()

      const complete = chunks.find(c => c.type === 'message_complete')!
      expect(complete.stopReason).toBe('tool_use')
      expect(complete.content).toContainEqual(
        expect.objectContaining({
          type: 'tool_use',
          name: 'read_file',
          input: { path: '/test.ts' },
        }),
      )
    })

    it('handles mixed text + function call in one chunk', async () => {
      const { __mockGenerateContentStream } = await import('@google/generative-ai') as unknown as {
        __mockGenerateContentStream: ReturnType<typeof vi.fn>
      }

      __mockGenerateContentStream.mockResolvedValue({
        stream: (async function* () {
          yield {
            candidates: [{
              content: {
                parts: [
                  { text: 'Let me read that file.' },
                  { functionCall: { name: 'read_file', args: { path: '/x.ts' } } },
                ],
              },
            }],
            usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 12 },
          }
        })(),
      })

      const chunks: ProviderChunk[] = []
      for await (const chunk of provider.stream(makeRequest())) {
        chunks.push(chunk)
      }

      expect(chunks.filter(c => c.type === 'text_delta')).toHaveLength(1)
      expect(chunks.filter(c => c.type === 'tool_use_start')).toHaveLength(1)

      const complete = chunks.find(c => c.type === 'message_complete')!
      expect(complete.content).toHaveLength(2) // text + tool_use
      expect(complete.stopReason).toBe('tool_use')
    })

    it('handles empty stream gracefully', async () => {
      const { __mockGenerateContentStream } = await import('@google/generative-ai') as unknown as {
        __mockGenerateContentStream: ReturnType<typeof vi.fn>
      }

      __mockGenerateContentStream.mockResolvedValue({
        stream: (async function* () {
          yield {
            candidates: [{ content: { parts: [] } }],
            usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 0 },
          }
        })(),
      })

      const chunks: ProviderChunk[] = []
      for await (const chunk of provider.stream(makeRequest())) {
        chunks.push(chunk)
      }

      const complete = chunks.find(c => c.type === 'message_complete')!
      expect(complete.content).toHaveLength(0)
      expect(complete.stopReason).toBe('end_turn')
    })
  })
})
