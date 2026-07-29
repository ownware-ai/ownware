/**
 * Unit tests — the transport `fetch` hook against the REAL vendor SDKs.
 *
 * The sibling `transport-options.test.ts` mocks the SDKs and proves the option
 * reaches the constructor. That is necessary but weak: it would still pass if
 * the SDK ignored the option entirely. These tests close that gap.
 *
 * `fetch` IS the network boundary, so substituting it lets us drive the real
 * `openai` / `@anthropic-ai/sdk` clients end-to-end with **zero network**. What
 * that proves, which a mock cannot:
 *
 *   1. The closure is genuinely invoked by the real SDK request pipeline —
 *      stored on an options object.
 *   2. It receives the fully-formed request, with `defaultHeaders` already
 *      merged in, so a closure can read and rewrite what the SDK intended.
 *   3. A response returned by the closure is parsed by the SDK and arrives as
 *      normalized `ProviderChunk`s — the hook does not break streaming.
 *   4. When the closure throws, the failure surfaces as a typed `ProviderError`
 *      at the `stream()` boundary — never an unhandled rejection escaping
 *      mid-stream, which is what would reach a customer as a dead conversation.
 *
 * This is also the harness shape every later provider slice reuses: point the
 * transport at a local fake and the whole flow is provable without an account.
 */

import { describe, expect, it, vi } from 'vitest'

import { AnthropicProvider } from '../../../provider/anthropic.js'
import { OpenAIProvider } from '../../../provider/openai.js'
import { ProviderError } from '../../../core/errors.js'
import type { ProviderChunk, ProviderFetch, ProviderRequest } from '../../../provider/types.js'

// -------------------------------------------------------------------------
// Canned wire responses — the smallest valid streams each SDK will parse
// -------------------------------------------------------------------------

function openaiStreamResponse(text: string): Response {
  const chunk = (delta: object, finish: string | null) =>
    `data: ${JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'gpt-4o',
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`

  const body =
    chunk({ role: 'assistant', content: text }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n'

  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

function anthropicStreamResponse(text: string): Response {
  const event = (type: string, data: object) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`

  const body =
    event('message_start', {
      message: {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 0 },
      },
    }) +
    event('content_block_start', {
      index: 0,
      content_block: { type: 'text', text: '' },
    }) +
    event('content_block_delta', {
      index: 0,
      delta: { type: 'text_delta', text },
    }) +
    event('content_block_stop', { index: 0 }) +
    event('message_delta', {
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 3 },
    }) +
    event('message_stop', {})

  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

function request(model: string): ProviderRequest {
  return {
    model,
    system: 'you are a test',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    maxTokens: 64,
    temperature: null,
  } as unknown as ProviderRequest
}

async function collect(stream: AsyncGenerator<ProviderChunk>): Promise<ProviderChunk[]> {
  const out: ProviderChunk[] = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

// -------------------------------------------------------------------------
// The closure is really invoked, and really carries the request
// -------------------------------------------------------------------------

describe('OpenAI — custom fetch drives the real SDK pipeline into a fake endpoint', () => {
  it('invokes the closure and streams its response back as ProviderChunks', async () => {
    const seen: Array<{ url: string; authorization: string | null; account: string | null }> = []

    const transportFetch: ProviderFetch = async (input, init) => {
      const headers = new Headers(init?.headers as HeadersInit | undefined)
      seen.push({
        url: typeof input === 'string' ? input : input.toString(),
        authorization: headers.get('authorization'),
        account: headers.get('X-Account-Id'),
      })
      return openaiStreamResponse('hi there')
    }

    const provider = new OpenAIProvider({
      apiKey: 'sk-unused',
      fetch: transportFetch,
      defaultHeaders: { 'X-Account-Id': 'acct-42' },
    })

    const chunks = await collect(provider.stream(request('gpt-4o')))

    // The real SDK constructed the request; no provider authorized or served it.
    expect(seen).toHaveLength(1)
    expect(seen[0]!.url).toContain('/chat/completions')

    // 2 — defaultHeaders were merged before the closure saw the request, so a
    //     closure can read and rewrite whatever the SDK intended to send
    expect(seen[0]!.account).toBe('acct-42')
    expect(seen[0]!.authorization).toBe('Bearer sk-unused')

    // 3 — the closure's response was parsed and normalized by the adapter
    const text = chunks
      .filter((c): c is Extract<ProviderChunk, { type: 'text_delta' }> => c.type === 'text_delta')
      .map(c => c.text)
      .join('')
    expect(text).toBe('hi there')

    const complete = chunks.at(-1)
    expect(complete?.type).toBe('message_complete')
  })

  it('lets the closure redirect the request to a different endpoint', async () => {
    // The property that makes an alternate-endpoint credential expressible at
    // all: the closure decides the final URL, not the adapter.
    const hit: string[] = []
    const transportFetch: ProviderFetch = async input => {
      const url = typeof input === 'string' ? input : input.toString()
      hit.push(url)
      return openaiStreamResponse('rerouted')
    }

    const provider = new OpenAIProvider({
      apiKey: 'sk-unused',
      baseURL: 'https://example.invalid/v1',
      fetch: transportFetch,
    })

    await collect(provider.stream(request('gpt-4o')))

    expect(hit[0]).toContain('example.invalid')
  })

  it('applies the closure on the dynamic apiKeyProvider path too', async () => {
    // The production path. A hook that worked only for static keys would
    // vanish the moment the gateway wired a resolver-backed provider.
    const calls = vi.fn(async () => openaiStreamResponse('dynamic'))
    const resolved = vi.fn(async () => 'sk-resolved')

    const provider = new OpenAIProvider({
      apiKeyProvider: resolved,
      fetch: calls as unknown as ProviderFetch,
    })

    await collect(provider.stream(request('gpt-4o')))

    expect(resolved).toHaveBeenCalledTimes(1)
    expect(calls).toHaveBeenCalledTimes(1)
  })
})

describe('Anthropic — custom fetch drives the real SDK pipeline into a fake endpoint', () => {
  it('invokes the closure and streams its response back as ProviderChunks', async () => {
    const seen: Array<{ url: string; account: string | null }> = []

    const transportFetch: ProviderFetch = async (input, init) => {
      const headers = new Headers(init?.headers as HeadersInit | undefined)
      seen.push({
        url: typeof input === 'string' ? input : input.toString(),
        account: headers.get('X-Account-Id'),
      })
      return anthropicStreamResponse('hello from claude')
    }

    const provider = new AnthropicProvider({
      apiKey: 'sk-ant-unused',
      fetch: transportFetch,
      defaultHeaders: { 'X-Account-Id': 'acct-99' },
    })

    const chunks = await collect(provider.stream(request('claude-sonnet-4-6')))

    expect(seen).toHaveLength(1)
    expect(seen[0]!.url).toContain('/v1/messages')
    expect(seen[0]!.account).toBe('acct-99')

    const text = chunks
      .filter((c): c is Extract<ProviderChunk, { type: 'text_delta' }> => c.type === 'text_delta')
      .map(c => c.text)
      .join('')
    expect(text).toBe('hello from claude')
    expect(chunks.at(-1)?.type).toBe('message_complete')
  })
})

// -------------------------------------------------------------------------
// Unhappy path — a throwing closure must not escape as a raw rejection
// -------------------------------------------------------------------------

describe('a throwing transport fetch fails honestly', () => {
  it('surfaces as a typed ProviderError from OpenAI, not a raw throw', async () => {
    const provider = new OpenAIProvider({
      apiKey: 'sk-unused',
      fetch: async () => {
        throw new Error('token refresh failed upstream')
      },
    })

    await expect(collect(provider.stream(request('gpt-4o')))).rejects.toBeInstanceOf(ProviderError)
  })

  it('surfaces as a typed ProviderError from Anthropic, not a raw throw', async () => {
    const provider = new AnthropicProvider({
      apiKey: 'sk-ant-unused',
      fetch: async () => {
        throw new Error('token refresh failed upstream')
      },
    })

    await expect(
      collect(provider.stream(request('claude-sonnet-4-6'))),
    ).rejects.toBeInstanceOf(ProviderError)
  })

  it('names the provider on the typed error so the failure is attributable', async () => {
    const provider = new OpenAIProvider({
      apiKey: 'sk-unused',
      fetch: async () => {
        throw new Error('boom')
      },
    })

    try {
      await collect(provider.stream(request('gpt-4o')))
      expect.unreachable('stream should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError)
      expect((err as ProviderError).provider).toBe('openai')
    }
  })

  it('is re-entered once per HTTP attempt, not once per stream()', async () => {
    // This proves the contract documented on `ProviderTransportOptions.fetch`,
    // and it is load-bearing: the SDK's own retry re-enters the closure, so a
    // credential refresh performed inside MUST be single-flight or one stalled
    // turn becomes N concurrent refreshes against the token endpoint.
    //
    // Asserted as ">= 2" deliberately. The exact retry count is the vendor's
    // policy, not ours, and pinning it would make this test a tripwire for an
    // SDK upgrade rather than a statement about our contract. What matters is
    // that re-entry happens at all.
    let attempts = 0
    const provider = new OpenAIProvider({
      apiKey: 'sk-unused',
      fetch: async () => {
        attempts++
        throw new Error('transient connection failure')
      },
    })

    await expect(collect(provider.stream(request('gpt-4o')))).rejects.toBeInstanceOf(ProviderError)
    expect(attempts).toBeGreaterThanOrEqual(2)
  })

  it('propagates an upstream auth rejection as a typed error, not a hang', async () => {
    // The realistic revoked-credential shape: the closure cannot refresh, so it
    // returns the provider's own 401 rather than throwing. It must still become
    // a typed error rather than being parsed as a stream.
    const provider = new OpenAIProvider({
      apiKey: 'sk-unused',
      fetch: async () =>
        new Response(JSON.stringify({ error: { message: 'invalid_grant' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
    })

    await expect(collect(provider.stream(request('gpt-4o')))).rejects.toBeInstanceOf(ProviderError)
  })
})
