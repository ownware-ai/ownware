import {
  AuthenticationError,
  ContextWindowExceededError,
  RateLimitError,
  type ContentBlock,
  type Message,
  type ProviderAdapter,
  type ProviderChunk,
  type ProviderRequest,
  type ToolDefinition,
} from '@ownware/loom'
import {
  VerificationObservationSchema,
  evaluateVerificationProbe,
  skippedVerificationProbe,
  type VerificationObservation,
  type VerificationProbeId,
  type VerificationProbeResult,
} from './verification.js'

const DEFAULT_MAX_TOKENS = 256
const DEFAULT_ABORT_AFTER_MS = 100

export interface VerificationMediaFixtures {
  readonly image?: { readonly mediaType: string; readonly data: string }
  readonly pdf?: { readonly data: string }
}

export interface ProviderRouteVerificationRunOptions {
  readonly adapter: ProviderAdapter
  readonly model: string
  readonly probes: readonly VerificationProbeId[]
  readonly media?: VerificationMediaFixtures
  readonly maxTokens?: number
  readonly abortAfterMs?: number
  /** Route-scoped negative calls. Each must reject through Loom's typed errors. */
  readonly errorDrivers?: Partial<Record<
    'auth_error' | 'rate_limit_error' | 'context_window_error',
    () => Promise<void>
  >>
}

/**
 * Execute selected contract probes directly through a Loom adapter.
 * Only normalized observations leave this function; prompt/response content
 * and raw provider errors are intentionally discarded.
 */
export async function runProviderRouteVerification(
  options: ProviderRouteVerificationRunOptions,
): Promise<VerificationProbeResult[]> {
  const selected = [...new Set(options.probes)]
  const results = new Map<VerificationProbeId, VerificationProbeResult>()
  const baselineProbes = selected.filter(probe =>
    probe === 'text_streaming'
    || probe === 'terminal_events'
    || probe === 'usage_reporting'
    || probe === 'provider_reported_cost',
  )
  if (baselineProbes.length > 0) {
    const request = baseRequest(options, [{ role: 'user', content: 'Reply with the word OK.' }])
    const observed = await observeStream(options.adapter, request)
    for (const probe of baselineProbes) results.set(probe, evaluateVerificationProbe(probe, observed))
  }

  for (const probe of selected) {
    if (results.has(probe)) continue
    switch (probe) {
      case 'sequential_tool_calls':
        results.set(probe, options.adapter.supportsFeature('tool_use')
          ? evaluateVerificationProbe(probe, await sequentialTools(options))
          : skippedVerificationProbe(probe, 'unsupported_by_adapter'))
        break
      case 'parallel_tool_calls':
        results.set(probe, options.adapter.supportsFeature('parallel_tool_use')
          ? evaluateVerificationProbe(probe, await parallelTools(options))
          : skippedVerificationProbe(probe, 'unsupported_by_adapter'))
        break
      case 'cancellation':
        results.set(probe, evaluateVerificationProbe(probe, await abortProbe(options, 'cancelled')))
        break
      case 'timeout':
        results.set(probe, evaluateVerificationProbe(probe, await abortProbe(options, 'timed_out')))
        break
      case 'reasoning':
        results.set(probe,
          options.adapter.supportsFeature('thinking') || options.adapter.supportsFeature('extended_thinking')
            ? evaluateVerificationProbe(probe, await reasoningProbe(options))
            : skippedVerificationProbe(probe, 'unsupported_by_adapter'))
        break
      case 'image_input':
        results.set(probe, options.media?.image == null
          ? skippedVerificationProbe(probe, 'missing_input_fixture')
          : !options.adapter.supportsFeature('vision')
            ? skippedVerificationProbe(probe, 'unsupported_by_adapter')
            : evaluateVerificationProbe(probe, await mediaProbe(options, 'image')))
        break
      case 'pdf_input':
        results.set(probe, options.media?.pdf == null
          ? skippedVerificationProbe(probe, 'missing_input_fixture')
          : !options.adapter.supportsFeature('pdf')
            ? skippedVerificationProbe(probe, 'unsupported_by_adapter')
            : evaluateVerificationProbe(probe, await mediaProbe(options, 'pdf')))
        break
      case 'prompt_caching':
        results.set(probe, options.adapter.supportsFeature('cache_control')
          ? evaluateVerificationProbe(probe, await cacheProbe(options))
          : skippedVerificationProbe(probe, 'unsupported_by_adapter'))
        break
      case 'structured_output':
        // Loom advertises model support but does not yet expose a normalized
        // strict-output request option. A prompt asking for JSON is not proof.
        results.set(probe, skippedVerificationProbe(probe, 'unsupported_by_adapter'))
        break
      case 'auth_error':
      case 'rate_limit_error':
      case 'context_window_error': {
        const driver = options.errorDrivers?.[probe]
        results.set(probe, driver == null
          ? skippedVerificationProbe(probe, 'unsafe_without_fixture')
          : evaluateVerificationProbe(probe, await errorProbe(driver)))
        break
      }
      default:
        break
    }
  }
  return selected.map(probe => results.get(probe) ?? skippedVerificationProbe(probe, 'inconclusive'))
}

async function sequentialTools(
  options: ProviderRouteVerificationRunOptions,
): Promise<VerificationObservation> {
  const firstMessages: Message[] = [{ role: 'user', content: 'Call first_probe once.' }]
  const first = await collectStream(options.adapter, baseRequest(options, firstMessages, [FIRST_TOOL]))
  const firstComplete = completion(first.chunks)
  const firstToolUses = firstComplete?.content.filter(block => block.type === 'tool_use') ?? []
  if (firstComplete == null || firstToolUses.length === 0) {
    return observationFrom(baseRequest(options, firstMessages, [FIRST_TOOL]), first, [firstToolUses.length])
  }
  const toolResults: ContentBlock[] = firstToolUses.map(tool => ({
    type: 'tool_result',
    toolUseId: tool.id,
    content: 'first probe completed',
    isError: false,
  }))
  const secondMessages: Message[] = [
    ...firstMessages,
    { role: 'assistant', content: firstComplete.content },
    { role: 'user', content: toolResults },
    { role: 'user', content: 'Now call second_probe once.' },
  ]
  const secondRequest = baseRequest(options, secondMessages, [SECOND_TOOL])
  const second = await collectStream(options.adapter, secondRequest)
  const secondToolUses = completion(second.chunks)?.content.filter(block => block.type === 'tool_use') ?? []
  const combined = {
    chunks: [...first.chunks, ...second.chunks],
    error: second.error ?? first.error,
  }
  return observationFrom(secondRequest, combined, [firstToolUses.length, secondToolUses.length])
}

async function parallelTools(
  options: ProviderRouteVerificationRunOptions,
): Promise<VerificationObservation> {
  const request = baseRequest(
    options,
    [{ role: 'user', content: 'Call first_probe and second_probe in the same turn.' }],
    [FIRST_TOOL, SECOND_TOOL],
  )
  const result = await collectStream(options.adapter, request)
  const toolCount = completion(result.chunks)?.content.filter(block => block.type === 'tool_use').length ?? 0
  return observationFrom(request, result, toolCount > 0 ? [toolCount] : [])
}

async function reasoningProbe(
  options: ProviderRouteVerificationRunOptions,
): Promise<VerificationObservation> {
  const request: ProviderRequest = {
    ...baseRequest(options, [{ role: 'user', content: 'Reason briefly, then answer with OK.' }]),
    maxTokens: Math.max(2_048, options.maxTokens ?? DEFAULT_MAX_TOKENS),
    thinking: { enabled: true, budgetTokens: 1_024, effort: 'low' },
  }
  return observeStream(options.adapter, request)
}

async function mediaProbe(
  options: ProviderRouteVerificationRunOptions,
  kind: 'image' | 'pdf',
): Promise<VerificationObservation> {
  const block: ContentBlock = kind === 'image'
    ? {
        type: 'image',
        source: {
          type: 'base64',
          mediaType: options.media!.image!.mediaType,
          data: options.media!.image!.data,
        },
      }
    : {
        type: 'document',
        source: { type: 'base64', mediaType: 'application/pdf', data: options.media!.pdf!.data },
      }
  return observeStream(options.adapter, baseRequest(options, [{
    role: 'user',
    content: [block, { type: 'text', text: 'Acknowledge this input with OK.' }],
  }]))
}

async function cacheProbe(
  options: ProviderRouteVerificationRunOptions,
): Promise<VerificationObservation> {
  const request: ProviderRequest = {
    ...baseRequest(options, [{ role: 'user', content: 'Reply with OK.' }]),
    system: [{
      type: 'text',
      text: 'You are a deterministic route verification assistant. Return only the requested value.',
      cache_control: { type: 'ephemeral' },
    }],
  }
  await collectStream(options.adapter, request)
  return observeStream(options.adapter, request)
}

async function abortProbe(
  options: ProviderRouteVerificationRunOptions,
  outcome: 'cancelled' | 'timed_out',
): Promise<VerificationObservation> {
  const controller = new AbortController()
  const request = baseRequest(
    options,
    [{ role: 'user', content: 'Write a long numbered list with at least 500 entries.' }],
    [],
    controller.signal,
  )
  const timer = setTimeout(() => controller.abort(), options.abortAfterMs ?? DEFAULT_ABORT_AFTER_MS)
  try {
    const result = await collectStream(options.adapter, request)
    if (controller.signal.aborted && completion(result.chunks) == null) {
      return observationFrom(request, result, [], outcome)
    }
    return observationFrom(request, result)
  } finally {
    clearTimeout(timer)
  }
}

async function errorProbe(driver: () => Promise<void>): Promise<VerificationObservation> {
  let error: unknown
  try {
    await driver()
  } catch (caught) {
    error = caught
  }
  return VerificationObservationSchema.parse({
    ...EMPTY_OBSERVATION,
    eventTypes: error == null ? ['message_complete'] : ['stream_error'],
    terminalOutcome: error == null ? 'completed' : 'errored',
    errorCategory: classifyError(error),
  })
}

async function observeStream(
  adapter: ProviderAdapter,
  request: ProviderRequest,
): Promise<VerificationObservation> {
  return observationFrom(request, await collectStream(adapter, request))
}

async function collectStream(
  adapter: ProviderAdapter,
  request: ProviderRequest,
): Promise<{ readonly chunks: ProviderChunk[]; readonly error?: unknown }> {
  const chunks: ProviderChunk[] = []
  try {
    for await (const chunk of adapter.stream(request)) chunks.push(chunk)
    return { chunks }
  } catch (error) {
    return { chunks, error }
  }
}

function observationFrom(
  request: ProviderRequest,
  result: { readonly chunks: readonly ProviderChunk[]; readonly error?: unknown },
  toolCallBatches: readonly number[] = [],
  forcedOutcome?: 'cancelled' | 'timed_out',
): VerificationObservation {
  const complete = completion(result.chunks)
  const usage = complete?.usage
  const terminalOutcome = forcedOutcome
    ?? (result.error != null ? 'errored' : complete != null ? 'completed' : 'missing')
  return VerificationObservationSchema.parse({
    eventTypes: [...new Set([
      ...result.chunks.map(chunk => chunk.type),
      ...(result.error == null ? [] : ['stream_error' as const]),
    ])],
    terminalOutcome,
    toolCallBatches,
    cancellationRequested: forcedOutcome === 'cancelled',
    timeoutConfigured: forcedOutcome === 'timed_out',
    request: requestFacts(request),
    response: {
      reasoningObserved: result.chunks.some(chunk => chunk.type === 'thinking_delta')
        || (usage?.reasoningTokens ?? 0) > 0,
      structuredOutputValid: false,
    },
    usage: {
      ...(usage == null ? {} : {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheCreationTokens,
        ...(usage.reasoningTokens == null ? {} : { reasoningTokens: usage.reasoningTokens }),
        ...(usage.reportedCostUsd == null ? {} : { reportedCostUsd: usage.reportedCostUsd }),
      }),
    },
    errorCategory: forcedOutcome === 'timed_out'
      ? 'timeout'
      : forcedOutcome ?? classifyError(result.error),
  })
}

function requestFacts(request: ProviderRequest): VerificationObservation['request'] {
  const inputKinds = new Set<'text' | 'image' | 'pdf'>()
  for (const message of request.messages) {
    if (typeof message.content === 'string') {
      inputKinds.add('text')
      continue
    }
    for (const block of message.content) {
      if (block.type === 'image') inputKinds.add('image')
      else if (block.type === 'document') inputKinds.add('pdf')
      else if (block.type === 'text') inputKinds.add('text')
    }
  }
  const systemMarkers = typeof request.system === 'string'
    ? 0
    : request.system.filter(block => block.cache_control != null).length
  const messageMarkers = request.messages.reduce((total, message) => {
    if (typeof message.content === 'string') return total
    return total + message.content.filter(block => block.cache_control != null).length
  }, 0)
  return {
    reasoningOption: request.thinking?.enabled === true,
    inputKinds: [...inputKinds],
    structuredOutputSchema: false,
    cacheMarkers: systemMarkers + messageMarkers,
  }
}

function baseRequest(
  options: ProviderRouteVerificationRunOptions,
  messages: Message[],
  tools: ToolDefinition[] = [],
  signal?: AbortSignal,
): ProviderRequest {
  return {
    model: options.model,
    system: 'Follow the verification instruction exactly.',
    messages,
    tools,
    maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    temperature: 0,
    stallWarnMs: 10_000,
    stallTimeoutMs: 30_000,
    ...(signal == null ? {} : { signal }),
  }
}

function completion(chunks: readonly ProviderChunk[]) {
  return chunks.findLast(chunk => chunk.type === 'message_complete')
}

function classifyError(error: unknown): VerificationObservation['errorCategory'] {
  if (error == null) return 'none'
  if (error instanceof AuthenticationError) return 'authentication'
  if (error instanceof RateLimitError) return 'rate_limit'
  if (error instanceof ContextWindowExceededError) return 'context_window'
  return 'provider'
}

const EMPTY_OBSERVATION = {
  eventTypes: [] as const,
  terminalOutcome: 'missing' as const,
  toolCallBatches: [] as const,
  cancellationRequested: false,
  timeoutConfigured: false,
  request: {
    reasoningOption: false,
    inputKinds: ['text'] as const,
    structuredOutputSchema: false,
    cacheMarkers: 0,
  },
  response: { reasoningObserved: false, structuredOutputValid: false },
  usage: {},
  errorCategory: 'none' as const,
}

const FIRST_TOOL: ToolDefinition = {
  name: 'first_probe',
  description: 'Record the first verification step.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
}

const SECOND_TOOL: ToolDefinition = {
  name: 'second_probe',
  description: 'Record the second verification step.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
}
