import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  OllamaProvider,
  resolveOllamaHost,
  isOllamaReachable,
} from '../../../src/provider/ollama.js'
import { resolveProvider, registerProvider, unregisterProvider } from '../../../src/provider/registry.js'
import type { ProviderChunk, ProviderRequest } from '../../../src/provider/types.js'

// Mock the openai module — OllamaProvider rides OpenAIProvider's SDK path.
vi.mock('openai', () => {
  return {
    default: class MockOpenAI {
      baseURL: string | undefined
      constructor(opts?: { baseURL?: string }) {
        this.baseURL = opts?.baseURL
      }
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
    model: 'llama3.3',
    system: 'You are helpful.',
    messages: [{ role: 'user', content: 'Hello' }],
    tools: [],
    maxTokens: 100,
    temperature: null,
    ...overrides,
  }
}

async function* mockStream(chunks: unknown[]): AsyncGenerator<unknown> {
  for (const c of chunks) yield c
}

describe('resolveOllamaHost', () => {
  const saved = process.env.OLLAMA_HOST
  afterEach(() => {
    if (saved === undefined) delete process.env.OLLAMA_HOST
    else process.env.OLLAMA_HOST = saved
  })

  it('defaults to localhost:11434', () => {
    delete process.env.OLLAMA_HOST
    expect(resolveOllamaHost()).toBe('http://localhost:11434')
  })

  it('honors OLLAMA_HOST with a scheme', () => {
    process.env.OLLAMA_HOST = 'https://ollama.internal:11434'
    expect(resolveOllamaHost()).toBe('https://ollama.internal:11434')
  })

  it("adds http:// to Ollama's scheme-less host:port convention", () => {
    process.env.OLLAMA_HOST = '127.0.0.1:11434'
    expect(resolveOllamaHost()).toBe('http://127.0.0.1:11434')
  })

  it('strips trailing slashes', () => {
    expect(resolveOllamaHost('http://localhost:11434///')).toBe('http://localhost:11434')
  })

  it('explicit arg wins over env', () => {
    process.env.OLLAMA_HOST = 'http://elsewhere:1234'
    expect(resolveOllamaHost('http://here:11434')).toBe('http://here:11434')
  })
})

describe('OllamaProvider', () => {
  let provider: OllamaProvider

  beforeEach(() => {
    provider = new OllamaProvider({ host: 'http://localhost:11434' })
  })

  describe('metadata', () => {
    it('has name "ollama"', () => {
      expect(provider.name).toBe('ollama')
    })

    it('exposes the resolved host for reachability probes', () => {
      expect(provider.host).toBe('http://localhost:11434')
    })

    it('points the SDK at <host>/v1', () => {
      const client = (provider as unknown as { staticClient: { baseURL?: string } }).staticClient
      expect(client.baseURL).toBe('http://localhost:11434/v1')
    })
  })

  describe('pricing — local inference is free', () => {
    it('returns explicit zero pricing (never estimates cloud rates)', () => {
      const pricing = provider.getModelPricing('llama3.3')
      expect(pricing).toEqual({ input: 0, output: 0, cacheRead: null, cacheWrite: null })
    })
  })

  describe('stream — mocked SDK (inherited OpenAI-compatible path)', () => {
    it('yields text_delta and message_complete for text-only response', async () => {
      const client = (provider as unknown as { staticClient: { chat: { completions: { create: ReturnType<typeof vi.fn> } } } }).staticClient
      client.chat.completions.create.mockResolvedValue(
        mockStream([
          { choices: [{ delta: { content: 'Hi' }, finish_reason: null }] },
          { choices: [{ delta: { content: ' there' }, finish_reason: null }] },
          {
            choices: [{ delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 2 },
          },
        ]),
      )

      const chunks: ProviderChunk[] = []
      for await (const chunk of provider.stream(makeRequest())) {
        chunks.push(chunk)
      }

      const text = chunks
        .filter((c) => c.type === 'text_delta')
        .map((c) => (c as Extract<ProviderChunk, { type: 'text_delta' }>).text)
        .join('')
      expect(text).toBe('Hi there')
      expect(chunks.at(-1)?.type).toBe('message_complete')
      // Model id passes through untranslated — no vendor-prefix mapping.
      const call = client.chat.completions.create.mock.calls[0]![0] as { model: string }
      expect(call.model).toBe('llama3.3')
    })

    it('yields tool_use_start + args deltas for function calling', async () => {
      const client = (provider as unknown as { staticClient: { chat: { completions: { create: ReturnType<typeof vi.fn> } } } }).staticClient
      client.chat.completions.create.mockResolvedValue(
        mockStream([
          {
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{ index: 0, id: 'call_1', function: { name: 'readFile', arguments: '' } }],
              },
              finish_reason: null,
            }],
            usage: null,
          },
          {
            choices: [{
              index: 0,
              delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"a.txt"}' } }] },
              finish_reason: 'tool_calls',
            }],
            usage: null,
          },
          { choices: [], usage: { prompt_tokens: 5, completion_tokens: 3 } },
        ]),
      )

      const chunks: ProviderChunk[] = []
      for await (const chunk of provider.stream(makeRequest())) {
        chunks.push(chunk)
      }

      expect(chunks.find((c) => c.type === 'tool_use_start')).toMatchObject({
        type: 'tool_use_start',
        id: 'call_1',
        name: 'readFile',
      })
      const args = chunks
        .filter((c) => c.type === 'tool_use_args_delta')
        .map((c) => (c as Extract<ProviderChunk, { type: 'tool_use_args_delta' }>).delta)
        .join('')
      expect(args).toContain('a.txt')
    })
  })

  describe('registry integration', () => {
    it('resolveProvider handles ollama:<model> strings', () => {
      registerProvider(new OllamaProvider({ host: 'http://localhost:11434' }))
      try {
        const { provider: resolved, model } = resolveProvider('ollama:llama3.3')
        expect(resolved.name).toBe('ollama')
        expect(model).toBe('llama3.3')
      } finally {
        unregisterProvider('ollama')
      }
    })
  })
})

describe('isOllamaReachable', () => {
  it('returns false quickly when nothing listens on the port', async () => {
    // Port 1 is never an Ollama server; the probe must swallow the failure.
    const reachable = await isOllamaReachable('http://127.0.0.1:1', 200)
    expect(reachable).toBe(false)
  })
})
