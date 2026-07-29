import { describe, expect, it, vi } from 'vitest'

import {
  createOpenAIDirectProvider,
  DirectOpenAIProviderConfigurationError,
  type RuntimeSelection,
} from '../../../src/index.js'
import type {
  ProviderChunk,
  ProviderFetch,
  ProviderRequest,
} from '@ownware/loom'
import { createDefaultConfig, Session } from '@ownware/loom'

const DIRECT_SELECTION: RuntimeSelection = {
  runtime: 'ownware',
  access: {
    route: 'openai-chatgpt-direct',
    experimentalOptIn: true,
    capabilityEnvelope: 'openai-chatgpt-direct.v1',
  },
}

function sse(...events: readonly Record<string, unknown>[]): Response {
  return new Response(
    events
      .map((event) =>
        `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`
      )
      .join(''),
    {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    },
  )
}

async function collect(
  stream: AsyncGenerator<ProviderChunk>,
): Promise<ProviderChunk[]> {
  const chunks: ProviderChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function request(): ProviderRequest {
  return {
    model: 'gpt-direct-test',
    system: 'Use the approved Ownware tools.',
    messages: [{ role: 'user', content: 'Hello' }],
    tools: [],
    maxTokens: 64,
    temperature: null,
  }
}

describe('direct OpenAI route provider construction', () => {
  it('composes the explicit direct route with credential-bound bearer and account transport', async () => {
    const fetchImpl = vi.fn<ProviderFetch>(async () =>
      sse({
        type: 'response.completed',
        sequence_number: 1,
        response: {
          id: 'resp_direct',
          status: 'completed',
          output: [],
          usage: {
            input_tokens: 5,
            output_tokens: 2,
          },
        },
      })
    )
    const getAccessToken = vi.fn(async () => ({
      accessToken: 'synthetic-access-token',
      accountId: 'synthetic-account',
    }))

    const provider = createOpenAIDirectProvider({
      selection: DIRECT_SELECTION,
      tokenSource: { getAccessToken },
      context: () => ({
        agentId: 'agent-test',
        sessionId: 'session-test',
        threadId: 'thread-test',
      }),
      transport: {
        baseURL: 'https://route.example.invalid/backend-api/codex',
        account: {
          mode: 'required',
          headerName: 'X-Route-Account',
        },
        headers: { 'X-Route-Origin': 'ownware-test' },
      },
      fetchImpl,
    })

    const chunks = await collect(provider.stream(request()))

    expect(getAccessToken).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const firstCall = fetchImpl.mock.calls[0]
    expect(firstCall).toBeDefined()
    if (firstCall === undefined) return
    const [input, init] = firstCall
    expect(String(input)).toBe(
      'https://route.example.invalid/backend-api/codex/responses',
    )
    const headers = new Headers(init?.headers)
    expect(headers.get('authorization')).toBe(
      'Bearer synthetic-access-token',
    )
    expect(headers.get('x-route-account')).toBe('synthetic-account')
    expect(headers.get('x-route-origin')).toBe('ownware-test')
    expect(chunks.at(-1)).toMatchObject({
      type: 'message_complete',
      usage: {
        inputTokens: 5,
        outputTokens: 2,
        costBasis: 'subscription_allowance',
      },
    })
  })

  it('carries subscription billing semantics through the existing Ownware loop', async () => {
    const provider = createOpenAIDirectProvider({
      selection: DIRECT_SELECTION,
      tokenSource: {
        getAccessToken: async () => ({
          accessToken: 'synthetic-access-token',
          accountId: 'synthetic-account',
        }),
      },
      context: () => ({
        agentId: 'agent-test',
        sessionId: 'session-test',
        threadId: 'thread-test',
      }),
      transport: {
        baseURL: 'https://route.example.invalid/backend-api/codex',
        account: { mode: 'omit' },
      },
      fetchImpl: async () =>
        sse({
          type: 'response.completed',
          sequence_number: 1,
          response: {
            id: 'resp_direct_loop',
            status: 'completed',
            output: [],
            usage: {
              input_tokens: 9,
              output_tokens: 4,
            },
          },
        }),
    })
    const session = new Session({
      config: createDefaultConfig('openai:gpt-direct-test'),
      provider,
      tools: [],
    })
    const events = []
    for await (const event of session.submitMessage('Hello')) {
      events.push(event)
    }

    const turnEnd = events.find((event) => event.type === 'turn.end')
    expect(turnEnd).toMatchObject({
      type: 'turn.end',
      usage: {
        inputTokens: 9,
        outputTokens: 4,
        costUsd: 0,
        costBasis: 'subscription_allowance',
      },
    })
    expect(session.getState().totalUsage).toMatchObject({
      costUsd: 0,
      costBasis: 'subscription_allowance',
    })
  })

  it('rejects any route selection other than the explicit direct envelope', () => {
    expect(() =>
      createOpenAIDirectProvider({
        selection: {
          runtime: 'ownware',
          access: { route: 'provider-api' },
        },
        tokenSource: {
          getAccessToken: async () => ({
            accessToken: 'synthetic',
            accountId: undefined,
          }),
        },
        context: () => ({
          agentId: 'agent',
          sessionId: 'session',
          threadId: 'thread',
        }),
        transport: {
          baseURL: 'https://route.example.invalid/backend-api/codex',
          account: { mode: 'omit' },
        },
      })
    ).toThrow(
      expect.objectContaining({
        name: 'DirectOpenAIProviderConfigurationError',
        code: 'selection_not_direct',
      }),
    )
  })

  it.each([
    'http://route.example.invalid/backend-api/codex',
    'https://user:secret@route.example.invalid/backend-api/codex',
    'https://route.example.invalid/backend-api/codex?mode=direct',
    'https://route.example.invalid/backend-api/codex/responses',
  ])('rejects unsafe or already-materialized base URL %s', (baseURL) => {
    expect(() =>
      createOpenAIDirectProvider({
        selection: DIRECT_SELECTION,
        tokenSource: {
          getAccessToken: async () => ({
            accessToken: 'synthetic',
            accountId: undefined,
          }),
        },
        context: () => ({
          agentId: 'agent',
          sessionId: 'session',
          threadId: 'thread',
        }),
        transport: {
          baseURL,
          account: { mode: 'omit' },
        },
      })
    ).toThrow(
      expect.objectContaining({
        code: 'base_url_invalid',
      }),
    )
  })

  it('rejects static credential headers and account-header collisions', () => {
    const make = (headers: Record<string, string>) =>
      createOpenAIDirectProvider({
        selection: DIRECT_SELECTION,
        tokenSource: {
          getAccessToken: async () => ({
            accessToken: 'synthetic',
            accountId: 'account',
          }),
        },
        context: () => ({
          agentId: 'agent',
          sessionId: 'session',
          threadId: 'thread',
        }),
        transport: {
          baseURL: 'https://route.example.invalid/backend-api/codex',
          account: {
            mode: 'required',
            headerName: 'X-Route-Account',
          },
          headers,
        },
      })

    expect(() => make({ Authorization: 'static-secret' })).toThrow(
      expect.objectContaining({ code: 'header_protected' }),
    )
    expect(() => make({ 'x-route-account': 'static-account' })).toThrow(
      expect.objectContaining({ code: 'account_header_conflict' }),
    )
  })

  it('fails before the model endpoint when a required account id is absent', async () => {
    const fetchImpl = vi.fn<ProviderFetch>()
    const provider = createOpenAIDirectProvider({
      selection: DIRECT_SELECTION,
      tokenSource: {
        getAccessToken: async () => ({
          accessToken: 'synthetic-access-token',
          accountId: undefined,
        }),
      },
      context: () => ({
        agentId: 'agent',
        sessionId: 'session',
        threadId: 'thread',
      }),
      transport: {
        baseURL: 'https://route.example.invalid/backend-api/codex',
        account: {
          mode: 'required',
          headerName: 'X-Route-Account',
        },
      },
      fetchImpl,
    })

    await expect(collect(provider.stream(request()))).rejects.toThrow(
      'Direct OpenAI route requires a credential-bound account identifier.',
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('fails with a stable configuration error for unknown account modes', () => {
    expect(() =>
      createOpenAIDirectProvider({
        selection: DIRECT_SELECTION,
        tokenSource: {
          getAccessToken: async () => ({
            accessToken: 'synthetic',
            accountId: undefined,
          }),
        },
        context: () => ({
          agentId: 'agent',
          sessionId: 'session',
          threadId: 'thread',
        }),
        transport: {
          baseURL: 'https://route.example.invalid/backend-api/codex',
          account: { mode: 'future-account-mode' },
        } as never,
      })
    ).toThrow(
      expect.objectContaining({
        name: DirectOpenAIProviderConfigurationError.name,
        code: 'account_invalid',
      }),
    )
  })
})
