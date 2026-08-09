import { createServer, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  OpenAICompatibleProvider,
  assertSafeCredentialHeaderName,
  normalizeCompatibleBaseUrl,
} from '../../../provider/openai-compatible.js'
import type { ProviderChunk, ProviderRequest } from '../../../provider/types.js'

let server: Server
let baseURL: string
let lastHeaders: Record<string, string | string[] | undefined>
let lastBody: Record<string, unknown>
let requestStarted: (() => void) | null

beforeEach(async () => {
  lastHeaders = {}
  lastBody = {}
  requestStarted = null
  server = createServer((req, res) => {
    lastHeaders = req.headers
    if (req.url === '/v1/models') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: [{ id: 'fixture-model' }] }))
      return
    }
    if (req.url !== '/v1/chat/completions') {
      res.statusCode = 404
      res.end()
      return
    }
    let body = ''
    req.setEncoding('utf8')
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const parsed = JSON.parse(body) as { model?: string }
      lastBody = parsed as Record<string, unknown>
      requestStarted?.()
      res.setHeader('content-type', 'text/event-stream')
      res.setHeader('cache-control', 'no-cache')
      res.flushHeaders()
      if (parsed.model === 'cancel-model') return
      writeSse(res, {
        id: 'chatcmpl_fixture',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'fixture-model',
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [{
              index: 0,
              id: 'call_fixture',
              type: 'function',
              function: { name: 'lookup', arguments: '{"city":' },
            }],
          },
          finish_reason: null,
        }],
      })
      writeSse(res, {
        id: 'chatcmpl_fixture',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'fixture-model',
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{ index: 0, function: { arguments: '"Sydney"}' } }],
          },
          finish_reason: 'tool_calls',
        }],
      })
      writeSse(res, {
        id: 'chatcmpl_fixture',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'fixture-model',
        choices: [],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 4,
          prompt_tokens_details: { cached_tokens: 2 },
        },
      })
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address == null || typeof address === 'string') throw new Error('fixture did not bind')
  baseURL = `http://127.0.0.1:${address.port}/v1`
})

afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
})

describe('OpenAICompatibleProvider', () => {
  it('streams tools and usage through an explicit credential header', async () => {
    const provider = new OpenAICompatibleProvider({
      name: 'oai_0123456789ab',
      baseURL,
      auth: {
        kind: 'header',
        name: 'x-api-key',
        prefix: 'Key ',
        credentialProvider: async () => 'fixture-secret',
      },
      includeUsage: true,
    })

    const chunks = await collect(provider.stream(request('fixture-model')))
    const models = await provider.discoverModels()

    expect(lastHeaders['authorization']).toBeUndefined()
    expect(lastHeaders['x-api-key']).toBe('Key fixture-secret')
    expect(lastBody).toMatchObject({
      max_tokens: 128,
      stream_options: { include_usage: true },
    })
    expect(lastBody).not.toHaveProperty('max_completion_tokens')
    expect(chunks).toEqual(expect.arrayContaining([
      { type: 'tool_use_start', id: 'call_fixture', name: 'lookup' },
      { type: 'tool_use_args_delta', id: 'call_fixture', delta: '{"city":' },
      { type: 'tool_use_args_delta', id: 'call_fixture', delta: '"Sydney"}' },
      { type: 'tool_use_end', id: 'call_fixture' },
      expect.objectContaining({
        type: 'message_complete',
        stopReason: 'tool_use',
        usage: expect.objectContaining({
          inputTokens: 10,
          outputTokens: 4,
          cacheReadTokens: 2,
          cacheCreationTokens: 0,
        }),
      }),
    ]))
    expect(provider.supportsFeature('streaming')).toBe(true)
    expect(provider.supportsFeature('tool_use')).toBe(false)
    expect(provider.getModelPricing('fixture-model')).toBeNull()
    expect(models).toEqual(['fixture-model'])
  })

  it('forwards cancellation to the compatible HTTP request', async () => {
    const started = new Promise<void>(resolve => { requestStarted = resolve })
    const provider = new OpenAICompatibleProvider({
      name: 'oai_0123456789ab',
      baseURL,
      auth: { kind: 'none' },
    })
    const controller = new AbortController()
    const consuming = collect(provider.stream(request('cancel-model', controller.signal)))
    await started
    controller.abort()
    await expect(consuming).rejects.toThrow()
  })

  it('omits optional usage settings unless the connection opts in', async () => {
    const provider = new OpenAICompatibleProvider({
      name: 'oai_0123456789ab',
      baseURL,
      auth: { kind: 'none' },
    })

    await collect(provider.stream(request('fixture-model')))
    expect(lastBody).not.toHaveProperty('stream_options')
  })

  it('keeps custom connection ids isolated while allowing fixed preset slugs', () => {
    const preset = new OpenAICompatibleProvider({
      name: 'fireworks-ai',
      registryKind: 'preset',
      baseURL,
      auth: { kind: 'none' },
    })

    expect(preset.name).toBe('fireworks-ai')
    expect(() => new OpenAICompatibleProvider({
      name: 'fireworks-ai',
      baseURL,
      auth: { kind: 'none' },
    })).toThrow(/oai_/)
    expect(() => new OpenAICompatibleProvider({
      name: 'Fireworks AI',
      registryKind: 'preset',
      baseURL,
      auth: { kind: 'none' },
    })).toThrow(/canonical lowercase slug/)
  })

  it('rejects unsafe endpoints and credential headers', () => {
    expect(() => normalizeCompatibleBaseUrl('http://example.com/v1')).toThrow(/HTTPS/)
    expect(() => normalizeCompatibleBaseUrl('http://169.254.169.254/v1')).toThrow()
    expect(() => normalizeCompatibleBaseUrl('https://user:secret@example.com/v1')).toThrow(/credentials/)
    expect(normalizeCompatibleBaseUrl(`${baseURL}/`)).toBe(baseURL)
    expect(() => assertSafeCredentialHeaderName('Host')).toThrow(/not allowed/)
    expect(() => assertSafeCredentialHeaderName('Authorization')).toThrow(/bearer auth/)
    expect(() => assertSafeCredentialHeaderName('X-Forwarded-For')).toThrow(/not allowed/)
    expect(assertSafeCredentialHeaderName('api-key')).toBe('api-key')
  })
})

function request(model: string, signal?: AbortSignal): ProviderRequest {
  return {
    model,
    system: 'You are a fixture.',
    messages: [{ role: 'user', content: 'Look it up.' }],
    tools: [{
      name: 'lookup',
      description: 'Look up a city',
      inputSchema: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
    }],
    maxTokens: 128,
    temperature: null,
    ...(signal == null ? {} : { signal }),
  }
}

async function collect(stream: AsyncGenerator<ProviderChunk>): Promise<ProviderChunk[]> {
  const chunks: ProviderChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function writeSse(res: import('node:http').ServerResponse, value: object): void {
  res.write(`data: ${JSON.stringify(value)}\n\n`)
}
