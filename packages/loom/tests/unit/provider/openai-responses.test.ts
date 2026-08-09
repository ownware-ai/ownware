import { describe, expect, it } from 'vitest'

import { OpenAIResponsesProvider } from '../../../src/provider/openai-responses.js'
import type {
  ProviderChunk,
  ProviderFetch,
  ProviderRequest,
} from '../../../src/provider/types.js'

function sse(...events: readonly Record<string, unknown>[]): Response {
  const body = events
    .map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('')
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

async function collect(
  stream: AsyncGenerator<ProviderChunk>,
): Promise<ProviderChunk[]> {
  const chunks: ProviderChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function request(
  overrides: Partial<ProviderRequest> = {},
): ProviderRequest {
  return {
    model: 'gpt-test',
    system: 'Be concise.',
    messages: [{ role: 'user', content: 'Hello' }],
    tools: [],
    maxTokens: 64,
    temperature: null,
    ...overrides,
  }
}

describe('OpenAIResponsesProvider', () => {
  it('is available from the engine public package surface', async () => {
    const loom = await import('../../../src/index.js')
    expect(loom.OpenAIResponsesProvider).toBe(OpenAIResponsesProvider)
  })

  it('sends the supported text envelope through /responses and translates its terminal stream', async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = []
    const transport: ProviderFetch = async (input, init) => {
      requests.push({
        url: input instanceof Request
          ? input.url
          : input instanceof URL
            ? input.toString()
            : input,
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      })
      return sse(
        {
          type: 'response.output_text.delta',
          sequence_number: 1,
          output_index: 0,
          content_index: 0,
          item_id: 'msg_test',
          delta: 'Hello back',
        },
        {
          type: 'response.completed',
          sequence_number: 2,
          response: {
            id: 'resp_test',
            status: 'completed',
            output: [],
            usage: {
              input_tokens: 10,
              input_tokens_details: { cached_tokens: 4 },
              output_tokens: 3,
              output_tokens_details: { reasoning_tokens: 1 },
              total_tokens: 13,
            },
          },
        },
      )
    }

    const provider = new OpenAIResponsesProvider({
      apiKey: 'unused-test-key',
      fetch: transport,
    })
    const chunks = await collect(provider.stream(request()))

    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toContain('/responses')
    expect(requests[0]!.body).toEqual({
      model: 'gpt-test',
      instructions: 'Be concise.',
      input: [{ role: 'user', content: 'Hello' }],
      max_output_tokens: 64,
      stream: true,
      store: false,
    })
    expect(chunks).toEqual([
      { type: 'text_delta', text: 'Hello back' },
      {
        type: 'message_complete',
        content: [{ type: 'text', text: 'Hello back' }],
        stopReason: 'end_turn',
        usage: {
          inputTokens: 6,
          outputTokens: 3,
          cacheReadTokens: 4,
          cacheCreationTokens: 0,
          reasoningTokens: 1,
          requestId: 'resp_test',
        },
      },
    ])
  })

  it('forwards a requested temperature instead of silently changing sampling', async () => {
    let requestBody: Record<string, unknown> | undefined
    const transport: ProviderFetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return sse({
        type: 'response.completed',
        sequence_number: 1,
        response: {
          id: 'resp_temperature',
          status: 'completed',
          output: [],
          usage: null,
        },
      })
    }
    const provider = new OpenAIResponsesProvider({
      apiKey: 'unused-test-key',
      fetch: transport,
    })

    await collect(provider.stream(request({ temperature: 0.25 })))

    expect(requestBody?.temperature).toBe(0.25)
  })

  it('resolves a fresh dynamic bearer and preserves route headers for every call', async () => {
    const seen: Array<{
      url: string
      authorization: string | null
      account: string | null
    }> = []
    const keys = ['first-synthetic-token', 'second-synthetic-token']
    let keyIndex = 0
    const transport: ProviderFetch = async (input, init) => {
      const headers = new Headers(init?.headers)
      seen.push({
        url: input instanceof Request
          ? input.url
          : input instanceof URL
            ? input.toString()
            : input,
        authorization: headers.get('authorization'),
        account: headers.get('ChatGPT-Account-Id'),
      })
      return sse({
        type: 'response.completed',
        sequence_number: 1,
        response: {
          id: `resp_dynamic_${seen.length}`,
          status: 'completed',
          output: [],
          usage: null,
        },
      })
    }
    const provider = new OpenAIResponsesProvider({
      apiKeyProvider: async () => keys[keyIndex++]!,
      baseURL: 'https://example.invalid/backend-api/codex',
      defaultHeaders: { 'ChatGPT-Account-Id': 'synthetic-account' },
      fetch: transport,
    })

    await collect(provider.stream(request()))
    await collect(provider.stream(request()))

    expect(seen).toEqual([
      {
        url: 'https://example.invalid/backend-api/codex/responses',
        authorization: 'Bearer first-synthetic-token',
        account: 'synthetic-account',
      },
      {
        url: 'https://example.invalid/backend-api/codex/responses',
        authorization: 'Bearer second-synthetic-token',
        account: 'synthetic-account',
      },
    ])
  })

  it('retains a function call when its arguments arrive only on output_item.done', async () => {
    let requestBody: Record<string, unknown> | undefined
    const transport: ProviderFetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return sse(
        {
          type: 'response.output_item.added',
          sequence_number: 1,
          output_index: 0,
          item: {
            id: 'fc_test',
            type: 'function_call',
            status: 'in_progress',
            call_id: 'call_test',
            name: 'read_file',
            arguments: '',
          },
        },
        {
          type: 'response.output_item.done',
          sequence_number: 2,
          output_index: 0,
          item: {
            id: 'fc_test',
            type: 'function_call',
            status: 'completed',
            call_id: 'call_test',
            name: 'read_file',
            arguments: '{"path":"README.md"}',
          },
        },
        {
          type: 'response.completed',
          sequence_number: 3,
          response: {
            id: 'resp_tool',
            status: 'completed',
            output: [],
            usage: {
              input_tokens: 20,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens: 8,
              output_tokens_details: { reasoning_tokens: 0 },
              total_tokens: 28,
            },
          },
        },
      )
    }
    const provider = new OpenAIResponsesProvider({
      apiKey: 'unused-test-key',
      fetch: transport,
    })
    const chunks = await collect(provider.stream(request({
      tools: [{
        name: 'read_file',
        description: 'Read one file.',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
          additionalProperties: false,
        },
      }],
    })))

    expect(requestBody?.tools).toEqual([{
      type: 'function',
      name: 'read_file',
      description: 'Read one file.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
      strict: false,
    }])
    expect(chunks).toEqual([
      { type: 'tool_use_start', id: 'call_test', name: 'read_file' },
      {
        type: 'tool_use_args_delta',
        id: 'call_test',
        delta: '{"path":"README.md"}',
      },
      { type: 'tool_use_end', id: 'call_test' },
      {
        type: 'message_complete',
        content: [{
          type: 'tool_use',
          id: 'call_test',
          name: 'read_file',
          input: { path: 'README.md' },
        }],
        stopReason: 'tool_use',
        usage: {
          inputTokens: 20,
          outputTokens: 8,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          requestId: 'resp_tool',
        },
      },
    ])
  })

  it('replays engine tool calls and results as linked Responses input items', async () => {
    let requestBody: Record<string, unknown> | undefined
    const transport: ProviderFetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return sse({
        type: 'response.completed',
        sequence_number: 1,
        response: {
          id: 'resp_after_tool',
          status: 'completed',
          output: [],
          usage: {
            input_tokens: 30,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 0,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 30,
          },
        },
      })
    }
    const provider = new OpenAIResponsesProvider({
      apiKey: 'unused-test-key',
      fetch: transport,
    })
    await collect(provider.stream(request({
      messages: [
        { role: 'user', content: 'Inspect the file.' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'I will inspect it.' },
            {
              type: 'tool_use',
              id: 'call_read',
              name: 'read_file',
              input: { path: 'README.md' },
            },
          ],
        },
        {
          role: 'user',
          content: [{
            type: 'tool_result',
            toolUseId: 'call_read',
            content: 'Synthetic contents',
            isError: false,
          }],
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this image.' },
            {
              type: 'image',
              source: {
                type: 'base64',
                mediaType: 'image/png',
                data: 'c3ludGhldGlj',
              },
            },
          ],
        },
      ],
    })))

    expect(requestBody?.input).toEqual([
      { role: 'user', content: 'Inspect the file.' },
      { role: 'assistant', content: 'I will inspect it.' },
      {
        type: 'function_call',
        call_id: 'call_read',
        name: 'read_file',
        arguments: '{"path":"README.md"}',
      },
      {
        type: 'function_call_output',
        call_id: 'call_read',
        output: 'Synthetic contents',
      },
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'Describe this image.' },
          {
            type: 'input_image',
            image_url: 'data:image/png;base64,c3ludGhldGlj',
            detail: 'auto',
          },
        ],
      },
    ])
  })

  it('fails before transport when a tool result has no preceding tool call', async () => {
    let transportCalled = false
    const provider = new OpenAIResponsesProvider({
      apiKey: 'unused-test-key',
      fetch: async () => {
        transportCalled = true
        throw new Error('transport must not be called')
      },
    })

    await expect(collect(provider.stream(request({
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result',
          toolUseId: 'call_orphan',
          content: 'Synthetic orphan result',
          isError: false,
        }],
      }],
    })))).rejects.toThrow('orphan tool_result')
    expect(transportCalled).toBe(false)
  })

  it('streams function argument deltas once and does not duplicate the done snapshot', async () => {
    const transport: ProviderFetch = async () => sse(
      {
        type: 'response.output_item.added',
        sequence_number: 1,
        output_index: 0,
        item: {
          id: 'fc_delta',
          type: 'function_call',
          status: 'in_progress',
          call_id: 'call_delta',
          name: 'read_file',
          arguments: '',
        },
      },
      {
        type: 'response.function_call_arguments.delta',
        sequence_number: 2,
        output_index: 0,
        item_id: 'fc_delta',
        delta: '{"path":',
      },
      {
        type: 'response.function_call_arguments.delta',
        sequence_number: 3,
        output_index: 0,
        item_id: 'fc_delta',
        delta: '"README.md"}',
      },
      {
        type: 'response.output_item.done',
        sequence_number: 4,
        output_index: 0,
        item: {
          id: 'fc_delta',
          type: 'function_call',
          status: 'completed',
          call_id: 'call_delta',
          name: 'read_file',
          arguments: '{"path":"README.md"}',
        },
      },
      {
        type: 'response.completed',
        sequence_number: 5,
        response: {
          id: 'resp_delta',
          status: 'completed',
          output: [],
          usage: null,
        },
      },
    )
    const provider = new OpenAIResponsesProvider({
      apiKey: 'unused-test-key',
      fetch: transport,
    })
    const chunks = await collect(provider.stream(request()))

    expect(chunks.filter((chunk) => chunk.type === 'tool_use_args_delta')).toEqual([
      { type: 'tool_use_args_delta', id: 'call_delta', delta: '{"path":' },
      { type: 'tool_use_args_delta', id: 'call_delta', delta: '"README.md"}' },
    ])
    expect(chunks.at(-1)).toMatchObject({
      type: 'message_complete',
      stopReason: 'tool_use',
      content: [{
        type: 'tool_use',
        id: 'call_delta',
        name: 'read_file',
        input: { path: 'README.md' },
      }],
    })
  })

  it('maps an authoritative max-output incomplete terminal without claiming normal completion', async () => {
    const transport: ProviderFetch = async () => sse(
      {
        type: 'response.output_text.delta',
        sequence_number: 1,
        output_index: 0,
        content_index: 0,
        item_id: 'msg_partial',
        delta: 'Partial answer',
      },
      {
        type: 'response.incomplete',
        sequence_number: 2,
        response: {
          id: 'resp_partial',
          status: 'incomplete',
          output: [],
          incomplete_details: { reason: 'max_output_tokens' },
          usage: {
            input_tokens: 10,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 4,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 14,
          },
        },
      },
    )
    const provider = new OpenAIResponsesProvider({
      apiKey: 'unused-test-key',
      fetch: transport,
    })
    const chunks = await collect(provider.stream(request()))

    expect(chunks.at(-1)).toEqual({
      type: 'message_complete',
      content: [{ type: 'text', text: 'Partial answer' }],
      stopReason: 'max_tokens',
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        requestId: 'resp_partial',
      },
    })
  })

  it('preserves a refusal finalized only by response.refusal.done', async () => {
    const transport: ProviderFetch = async () => sse(
      {
        type: 'response.refusal.done',
        sequence_number: 1,
        output_index: 0,
        content_index: 0,
        item_id: 'msg_refusal',
        refusal: 'I cannot help with that request.',
      },
      {
        type: 'response.completed',
        sequence_number: 2,
        response: {
          id: 'resp_refusal',
          status: 'completed',
          output: [],
          usage: null,
        },
      },
    )
    const provider = new OpenAIResponsesProvider({
      apiKey: 'unused-test-key',
      fetch: transport,
    })
    const chunks = await collect(provider.stream(request()))

    expect(chunks).toEqual([
      { type: 'text_delta', text: 'I cannot help with that request.' },
      {
        type: 'message_complete',
        content: [{ type: 'text', text: 'I cannot help with that request.' }],
        stopReason: 'refusal',
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          requestId: 'resp_refusal',
        },
      },
    ])
  })

  it('rejects a regressing Responses sequence instead of deriving completion', async () => {
    const transport: ProviderFetch = async () => sse(
      {
        type: 'response.output_text.delta',
        sequence_number: 2,
        output_index: 0,
        content_index: 0,
        item_id: 'msg_order',
        delta: 'Untrusted ordering',
      },
      {
        type: 'response.completed',
        sequence_number: 1,
        response: {
          id: 'resp_order',
          status: 'completed',
          output: [],
          usage: null,
        },
      },
    )
    const provider = new OpenAIResponsesProvider({
      apiKey: 'unused-test-key',
      fetch: transport,
    })

    await expect(collect(provider.stream(request()))).rejects.toThrow(
      'Responses event sequence was not strictly increasing.',
    )
  })

  it('requests configured reasoning and maps its summary separately from answer text', async () => {
    let requestBody: Record<string, unknown> | undefined
    const transport: ProviderFetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return sse(
        {
          type: 'response.reasoning_summary_text.delta',
          sequence_number: 1,
          output_index: 0,
          summary_index: 0,
          item_id: 'rs_test',
          delta: 'Checking the request.',
        },
        {
          type: 'response.reasoning_summary_text.done',
          sequence_number: 2,
          output_index: 0,
          summary_index: 0,
          item_id: 'rs_test',
          text: 'Checking the request.',
        },
        {
          type: 'response.output_text.delta',
          sequence_number: 3,
          output_index: 1,
          content_index: 0,
          item_id: 'msg_reasoned',
          delta: 'Final answer.',
        },
        {
          type: 'response.completed',
          sequence_number: 4,
          response: {
            id: 'resp_reasoned',
            status: 'completed',
            output: [],
            usage: null,
          },
        },
      )
    }
    const provider = new OpenAIResponsesProvider({
      apiKey: 'unused-test-key',
      fetch: transport,
    })
    const chunks = await collect(provider.stream(request({
      thinking: { enabled: true, budgetTokens: 8_000 },
    })))

    expect(requestBody?.reasoning).toEqual({
      effort: 'medium',
      summary: 'auto',
    })
    expect(chunks).toEqual([
      { type: 'thinking_delta', text: 'Checking the request.' },
      { type: 'text_delta', text: 'Final answer.' },
      {
        type: 'message_complete',
        content: [
          { type: 'thinking', text: 'Checking the request.' },
          { type: 'text', text: 'Final answer.' },
        ],
        stopReason: 'end_turn',
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          requestId: 'resp_reasoned',
        },
      },
    ])
  })

  it('does not claim general thinking support until opaque reasoning can round-trip', () => {
    const provider = new OpenAIResponsesProvider({
      apiKey: 'unused-test-key',
      fetch: async () => {
        throw new Error('transport must not be called')
      },
    })

    expect(provider.supportsFeature('thinking')).toBe(false)
  })

  it('fails before transport when prior thinking cannot be faithfully replayed', async () => {
    let transportCalled = false
    const provider = new OpenAIResponsesProvider({
      apiKey: 'unused-test-key',
      fetch: async () => {
        transportCalled = true
        throw new Error('transport must not be called')
      },
    })

    await expect(collect(provider.stream(request({
      messages: [{
        role: 'assistant',
        content: [{ type: 'thinking', text: 'Summary without opaque state.' }],
      }],
    })))).rejects.toThrow(
      'Responses request contains an input kind outside the supported envelope.',
    )
    expect(transportCalled).toBe(false)
  })

  it('rejects reasoning with tools before a tool effect can make replay necessary', async () => {
    let transportCalled = false
    const provider = new OpenAIResponsesProvider({
      apiKey: 'unused-test-key',
      fetch: async () => {
        transportCalled = true
        throw new Error('transport must not be called')
      },
    })

    await expect(collect(provider.stream(request({
      thinking: { enabled: true, effort: 'low', budgetTokens: 2_000 },
      tools: [{
        name: 'write_file',
        description: 'Write one file.',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
          additionalProperties: false,
        },
      }],
    })))).rejects.toThrow(
      'Responses transport cannot safely combine reasoning with tools.',
    )
    expect(transportCalled).toBe(false)
  })

  it('fails before transport rather than ignoring explicit cache markers', async () => {
    let transportCalled = false
    const provider = new OpenAIResponsesProvider({
      apiKey: 'unused-test-key',
      fetch: async () => {
        transportCalled = true
        throw new Error('transport must not be called')
      },
    })

    await expect(collect(provider.stream(request({
      system: [{
        type: 'text',
        text: 'Cached instruction.',
        cache_control: { type: 'ephemeral' },
      }],
    })))).rejects.toThrow(
      'Responses transport cannot honor explicit cache-control markers.',
    )
    expect(transportCalled).toBe(false)
  })

  it('fails before transport rather than ignoring unknown provider options', async () => {
    let transportCalled = false
    const provider = new OpenAIResponsesProvider({
      apiKey: 'unused-test-key',
      fetch: async () => {
        transportCalled = true
        throw new Error('transport must not be called')
      },
    })

    await expect(collect(provider.stream(request({
      providerOptions: { imaginary_option: true },
    })))).rejects.toThrow(
      'Responses transport received unsupported provider options.',
    )
    expect(transportCalled).toBe(false)
  })

  it('surfaces a failed terminal with stable content-free wording', async () => {
    const transport: ProviderFetch = async () => sse({
      type: 'response.failed',
      sequence_number: 1,
      response: {
        id: 'resp_failed',
        status: 'failed',
        output: [],
        error: {
          code: 'provider_private_code',
          message: 'private provider prose that must not cross the adapter',
        },
        usage: null,
      },
    })
    const provider = new OpenAIResponsesProvider({
      apiKey: 'unused-test-key',
      fetch: transport,
    })

    await expect(collect(provider.stream(request()))).rejects.toThrow(
      'Responses stream reported failure.',
    )
    await expect(collect(provider.stream(request()))).rejects.not.toThrow(
      'private provider prose',
    )
  })

  it('does not emit completion when another event arrives after a terminal event', async () => {
    const transport: ProviderFetch = async () => sse(
      {
        type: 'response.completed',
        sequence_number: 1,
        response: {
          id: 'resp_early_terminal',
          status: 'completed',
          output: [],
          usage: null,
        },
      },
      {
        type: 'response.output_text.delta',
        sequence_number: 2,
        output_index: 0,
        content_index: 0,
        item_id: 'msg_too_late',
        delta: 'late output',
      },
    )
    const provider = new OpenAIResponsesProvider({
      apiKey: 'unused-test-key',
      fetch: transport,
    })
    const observed: ProviderChunk[] = []

    await expect((async () => {
      for await (const chunk of provider.stream(request())) observed.push(chunk)
    })()).rejects.toThrow('Responses event arrived after a terminal event.')
    expect(observed.some((chunk) => chunk.type === 'message_complete')).toBe(false)
  })

  it('preserves answer text finalized only by response.output_text.done', async () => {
    const transport: ProviderFetch = async () => sse(
      {
        type: 'response.output_text.done',
        sequence_number: 1,
        output_index: 0,
        content_index: 0,
        item_id: 'msg_done_only',
        text: 'Done-only answer.',
      },
      {
        type: 'response.completed',
        sequence_number: 2,
        response: {
          id: 'resp_done_only',
          status: 'completed',
          output: [],
          usage: null,
        },
      },
    )
    const provider = new OpenAIResponsesProvider({
      apiKey: 'unused-test-key',
      fetch: transport,
    })
    const chunks = await collect(provider.stream(request()))

    expect(chunks[0]).toEqual({
      type: 'text_delta',
      text: 'Done-only answer.',
    })
    expect(chunks.at(-1)).toMatchObject({
      type: 'message_complete',
      content: [{ type: 'text', text: 'Done-only answer.' }],
    })
  })

  it('reconciles every text part from a completed message snapshot when deltas are absent', async () => {
    const transport: ProviderFetch = async () => sse(
      {
        type: 'response.output_item.done',
        sequence_number: 1,
        output_index: 0,
        item: {
          id: 'msg_snapshot',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [
            {
              type: 'output_text',
              text: 'First part. ',
              annotations: [],
              logprobs: [],
            },
            {
              type: 'output_text',
              text: 'Second part.',
              annotations: [],
              logprobs: [],
            },
          ],
        },
      },
      {
        type: 'response.completed',
        sequence_number: 2,
        response: {
          id: 'resp_snapshot',
          status: 'completed',
          output: [],
          usage: null,
        },
      },
    )
    const provider = new OpenAIResponsesProvider({
      apiKey: 'unused-test-key',
      fetch: transport,
    })
    const chunks = await collect(provider.stream(request()))

    expect(chunks).toEqual([
      { type: 'text_delta', text: 'First part. ' },
      { type: 'text_delta', text: 'Second part.' },
      {
        type: 'message_complete',
        content: [{ type: 'text', text: 'First part. Second part.' }],
        stopReason: 'end_turn',
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          requestId: 'resp_snapshot',
        },
      },
    ])
  })

  it('reconciles text and function calls from the authoritative completed response', async () => {
    const transport: ProviderFetch = async () => sse({
      type: 'response.completed',
      sequence_number: 1,
      response: {
        id: 'resp_terminal_snapshot',
        status: 'completed',
        output: [
          {
            id: 'msg_terminal',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{
              type: 'output_text',
              text: 'I will read it.',
              annotations: [],
              logprobs: [],
            }],
          },
          {
            id: 'fc_terminal',
            type: 'function_call',
            status: 'completed',
            call_id: 'call_terminal',
            name: 'read_file',
            arguments: '{"path":"README.md"}',
          },
        ],
        usage: null,
      },
    })
    const provider = new OpenAIResponsesProvider({
      apiKey: 'unused-test-key',
      fetch: transport,
    })
    const chunks = await collect(provider.stream(request()))

    expect(chunks).toEqual([
      { type: 'text_delta', text: 'I will read it.' },
      { type: 'tool_use_start', id: 'call_terminal', name: 'read_file' },
      {
        type: 'tool_use_args_delta',
        id: 'call_terminal',
        delta: '{"path":"README.md"}',
      },
      { type: 'tool_use_end', id: 'call_terminal' },
      {
        type: 'message_complete',
        content: [
          { type: 'text', text: 'I will read it.' },
          {
            type: 'tool_use',
            id: 'call_terminal',
            name: 'read_file',
            input: { path: 'README.md' },
          },
        ],
        stopReason: 'tool_use',
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          requestId: 'resp_terminal_snapshot',
        },
      },
    ])
  })

  it('preserves output-item order when a function call precedes answer text', async () => {
    const transport: ProviderFetch = async () => sse({
      type: 'response.completed',
      sequence_number: 1,
      response: {
        id: 'resp_ordered_content',
        status: 'completed',
        output: [
          {
            id: 'fc_first',
            type: 'function_call',
            status: 'completed',
            call_id: 'call_first',
            name: 'read_file',
            arguments: '{"path":"README.md"}',
          },
          {
            id: 'msg_second',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{
              type: 'output_text',
              text: 'Then explain it.',
              annotations: [],
              logprobs: [],
            }],
          },
        ],
        usage: null,
      },
    })
    const provider = new OpenAIResponsesProvider({
      apiKey: 'unused-test-key',
      fetch: transport,
    })
    const chunks = await collect(provider.stream(request()))
    const completed = chunks.at(-1)

    expect(completed).toMatchObject({
      type: 'message_complete',
      content: [
        {
          type: 'tool_use',
          id: 'call_first',
          name: 'read_file',
          input: { path: 'README.md' },
        },
        { type: 'text', text: 'Then explain it.' },
      ],
    })
  })

  it('forwards the caller abort signal to the Responses request', async () => {
    const controller = new AbortController()
    let observedSignal: AbortSignal | null | undefined
    let markStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const transport: ProviderFetch = async (_input, init) => {
      observedSignal = init?.signal
      markStarted?.()
      return new Promise<Response>((_resolve, reject) => {
        observedSignal?.addEventListener('abort', () => {
          reject(new DOMException('synthetic abort', 'AbortError'))
        }, { once: true })
      })
    }
    const provider = new OpenAIResponsesProvider({
      apiKey: 'unused-test-key',
      fetch: transport,
    })

    const running = collect(provider.stream(request({
      signal: controller.signal,
    })))
    await started
    controller.abort()

    await expect(running).rejects.toThrow('Request was aborted.')
    expect(observedSignal?.aborted).toBe(true)
  })

  it('uses engine stall limits when the response body stops producing events', async () => {
    const encoder = new TextEncoder()
    const transport: ProviderFetch = async () => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          setTimeout(() => {
            controller.enqueue(encoder.encode(
              'event: response.completed\n'
              + 'data: {"type":"response.completed","sequence_number":1,'
              + '"response":{"id":"resp_late","status":"completed",'
              + '"output":[],"usage":null}}\n\n',
            ))
            controller.close()
          }, 80)
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )
    const provider = new OpenAIResponsesProvider({
      apiKey: 'unused-test-key',
      fetch: transport,
    })

    await expect(collect(provider.stream(request({
      stallWarnMs: 1_000,
      stallTimeoutMs: 20,
    })))).rejects.toThrow('Stream stalled: no events received for 0.02s')
  })

  it('surfaces a stream-level error with stable content-free wording', async () => {
    const transport: ProviderFetch = async () => sse({
      type: 'error',
      sequence_number: 1,
      code: 'provider_private_code',
      message: 'private provider prose that must not cross the adapter',
      param: null,
    })
    const provider = new OpenAIResponsesProvider({
      apiKey: 'unused-test-key',
      fetch: transport,
    })

    await expect(collect(provider.stream(request()))).rejects.toThrow(
      'Responses stream reported a protocol error.',
    )
    await expect(collect(provider.stream(request()))).rejects.not.toThrow(
      'private provider prose',
    )
  })

  it('rejects hosted-tool output outside the declared custom-function envelope', async () => {
    const transport: ProviderFetch = async () => sse(
      {
        type: 'response.output_item.added',
        sequence_number: 1,
        output_index: 0,
        item: {
          id: 'ws_test',
          type: 'web_search_call',
          status: 'in_progress',
        },
      },
      {
        type: 'response.completed',
        sequence_number: 2,
        response: {
          id: 'resp_hosted_tool',
          status: 'completed',
          output: [],
          usage: null,
        },
      },
    )
    const provider = new OpenAIResponsesProvider({
      apiKey: 'unused-test-key',
      fetch: transport,
    })

    await expect(collect(provider.stream(request()))).rejects.toThrow(
      'Responses stream contained an unsupported material event.',
    )
  })
})
