import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  getSpeechCapabilities,
  selectSttProvider,
  HttpSttProvider,
} from '../../../src/speech/index.js'
import type { CredentialStore } from '../../../src/credential/store/index.js'

// ---------------------------------------------------------------------------
// Fake credential store — only the methods speech selection touches.
// ---------------------------------------------------------------------------

interface FakeCred {
  id: string
  variableName: string
  value: string
}

function makeStore(creds: FakeCred[]): CredentialStore {
  return {
    list: async () => creds.map((c) => ({ variableName: c.variableName, id: c.id })) as never,
    decrypt: async (id: string) => {
      const c = creds.find((x) => x.id === id)
      return c ? ({ value: c.value, metadata: {} } as never) : null
    },
  } as unknown as CredentialStore
}

describe('getSpeechCapabilities', () => {
  it('reports unavailable when no speech-capable key is saved', async () => {
    const store = makeStore([{ id: '1', variableName: 'ANTHROPIC_API_KEY', value: 'sk-ant' }])
    const caps = await getSpeechCapabilities(store)
    expect(caps.available).toBe(false)
    expect(caps.configuredProviders).toEqual([])
    expect(caps.defaultProvider).toBeNull()
  })

  it('reports available and picks the highest-priority provider (groq > openrouter > openai)', async () => {
    const store = makeStore([
      { id: '1', variableName: 'OPENAI_API_KEY', value: 'sk-oai' },
      { id: '2', variableName: 'OPENROUTER_API_KEY', value: 'sk-or' },
    ])
    const caps = await getSpeechCapabilities(store)
    expect(caps.available).toBe(true)
    expect(caps.configuredProviders).toEqual(['openrouter', 'openai'])
    expect(caps.defaultProvider).toBe('openrouter')
    expect(caps.defaultModel).toBe('openai/whisper-large-v3-turbo')
  })
})

describe('selectSttProvider', () => {
  it('returns null when nothing is configured', async () => {
    expect(await selectSttProvider(makeStore([]))).toBeNull()
  })

  it('binds to the highest-priority configured provider', async () => {
    const store = makeStore([
      { id: '1', variableName: 'OPENAI_API_KEY', value: 'sk-oai' },
      { id: '2', variableName: 'GROQ_API_KEY', value: 'sk-groq' },
    ])
    const provider = await selectSttProvider(store)
    expect(provider).not.toBeNull()
    expect(provider!.providerId).toBe('groq')
    expect(provider!.model).toBe('whisper-large-v3-turbo')
  })
})

describe('HttpSttProvider.transcribeBuffer', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('openai shape: posts multipart with auth + model + file part', async () => {
    let captured: { url: string; auth: string | null; model: unknown; hasFile: boolean } | null = null
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const form = init!.body as FormData
      captured = {
        url: String(url),
        auth: new Headers(init!.headers).get('authorization'),
        model: form.get('model'),
        hasFile: form.get('file') != null,
      }
      return new Response(JSON.stringify({ text: 'make the headline bigger', language: 'en', duration: 1.7 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    const provider = new HttpSttProvider({
      providerId: 'groq',
      shape: 'openai',
      baseUrl: 'https://api.groq.com/openai/v1',
      model: 'whisper-large-v3-turbo',
      getKey: async () => 'sk-test',
    })
    const result = await provider.transcribeBuffer(new Uint8Array([1, 2, 3]), 'audio.wav', { mimeType: 'audio/wav' })

    expect(result.text).toBe('make the headline bigger')
    expect(result.provider).toBe('groq')
    expect(result.durationSeconds).toBe(1.7)
    expect(captured!.url).toBe('https://api.groq.com/openai/v1/audio/transcriptions')
    expect(captured!.auth).toBe('Bearer sk-test')
    expect(captured!.model).toBe('whisper-large-v3-turbo')
    expect(captured!.hasFile).toBe(true)
  })

  it('openrouter shape: posts JSON with base64 input_audio (not multipart)', async () => {
    let captured: { contentType: string | null; body: Record<string, unknown> } | null = null
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      captured = {
        contentType: new Headers(init!.headers).get('content-type'),
        body: JSON.parse(init!.body as string) as Record<string, unknown>,
      }
      return new Response(JSON.stringify({ text: 'hello world' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    const provider = new HttpSttProvider({
      providerId: 'openrouter',
      shape: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'openai/whisper-large-v3-turbo',
      getKey: async () => 'sk-or',
    })
    const result = await provider.transcribeBuffer(new Uint8Array([1, 2, 3]), 'audio.wav', { mimeType: 'audio/wav' })

    expect(result.text).toBe('hello world')
    expect(captured!.contentType).toBe('application/json')
    expect(captured!.body['model']).toBe('openai/whisper-large-v3-turbo')
    const inputAudio = captured!.body['input_audio'] as { data: string; format: string }
    expect(inputAudio.format).toBe('wav')
    expect(typeof inputAudio.data).toBe('string')
    expect(inputAudio.data.length).toBeGreaterThan(0)
  })

  it('throws a clear error when the upstream returns non-OK', async () => {
    globalThis.fetch = vi.fn(async () => new Response('bad key', { status: 401 })) as typeof fetch
    const provider = new HttpSttProvider({
      providerId: 'openai',
      shape: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini-transcribe',
      getKey: async () => 'sk-bad',
    })
    await expect(provider.transcribeBuffer(new Uint8Array([1]), 'audio.wav')).rejects.toThrow(/openai HTTP 401/)
  })

  it('throws when no key is available', async () => {
    const provider = new HttpSttProvider({
      providerId: 'groq',
      shape: 'openai',
      baseUrl: 'https://api.groq.com/openai/v1',
      model: 'whisper-large-v3-turbo',
      getKey: async () => null,
    })
    await expect(provider.transcribeBuffer(new Uint8Array([1]), 'audio.wav')).rejects.toThrow(/no API key/)
  })
})

// Silence unused-import lint for symmetry with other suites.
beforeEach(() => {})
