import OpenAI from 'openai'
import { ProviderError } from '../core/errors.js'
import { assertPairing } from '../messages/pairing.js'
import type { ContentBlock, Message } from '../messages/types.js'
import { mapBudgetToEffort, translateOpenAIError } from './openai.js'
import type { ModelPricing } from './pricing.js'
import { getModelPricing } from './pricing.js'
import { withStallGuard } from './stall-guard.js'
import { createEgressFetch } from '../egress/fetch.js'
import type {
  ProviderAdapter,
  ProviderChunk,
  ProviderCostBasis,
  ProviderFeature,
  ProviderFetch,
  ProviderRequest,
  ProviderTransportOptions,
  ProviderUsage,
  ToolDefinition,
} from './types.js'

type ResponsesInput = OpenAI.Responses.ResponseInput

const STALL_WARN_MS = 30_000
const STALL_TIMEOUT_MS = 90_000

function responsesPartKey(itemId: string, contentIndex: number): string {
  return `${itemId}:${contentIndex}`
}

function translateResponsesError(error: unknown): Error {
  if (
    error instanceof OpenAI.APIError
    && error.constructor === OpenAI.APIError
    && error.status === undefined
  ) {
    return new ProviderError(
      'Responses stream reported a protocol error.',
      'openai',
      { recoverable: true },
    )
  }
  return translateOpenAIError(error)
}

function unsupportedInput(): never {
  throw new ProviderError(
    'Responses request contains an input kind outside the supported envelope.',
    'openai',
  )
}

function toResponsesInstructions(
  system: ProviderRequest['system'],
): string {
  if (typeof system === 'string') return system
  if (system.some((block) => block.cache_control !== undefined)) {
    throw new ProviderError(
      'Responses transport cannot honor explicit cache-control markers.',
      'openai',
    )
  }
  return system.map((block) => block.text).join('\n\n')
}

function toolOutput(content: string | readonly ContentBlock[]): string {
  if (typeof content === 'string') return content
  return JSON.stringify(content.map((block) => {
    if (block.type === 'text') return { type: 'text', text: block.text }
    if (block.type === 'image') return {
      type: 'image',
      source: block.source,
    }
    return unsupportedInput()
  }))
}

function toResponsesInput(messages: readonly Message[]): ResponsesInput {
  const input: unknown[] = []
  for (const message of messages) {
    if (message.role === 'system') continue
    if (message.role === 'user') {
      if (typeof message.content === 'string') {
        input.push({ role: 'user', content: message.content })
        continue
      }
      let parts: OpenAI.Responses.ResponseInputContent[] = []
      const flushParts = (): void => {
        if (parts.length === 0) return
        input.push({ role: 'user', content: parts })
        parts = []
      }
      for (const block of message.content) {
        if (block.type === 'text') {
          parts.push({ type: 'input_text', text: block.text })
          continue
        }
        if (block.type === 'image') {
          parts.push({
            type: 'input_image',
            image_url: block.source.type === 'base64'
              ? `data:${block.source.mediaType};base64,${block.source.data}`
              : block.source.url,
            detail: 'auto',
          })
          continue
        }
        if (block.type === 'tool_result') {
          flushParts()
          input.push({
            type: 'function_call_output',
            call_id: block.toolUseId,
            output: block.isError
              ? `Tool execution failed:\n${toolOutput(block.content)}`
              : toolOutput(block.content),
          })
          continue
        }
        unsupportedInput()
      }
      flushParts()
      continue
    }
    let assistantText = ''
    const flushAssistantText = (): void => {
      if (assistantText.length === 0) return
      input.push({ role: 'assistant', content: assistantText })
      assistantText = ''
    }
    for (const block of message.content) {
      if (block.type === 'text') {
        assistantText += block.text
        continue
      }
      if (block.type === 'tool_use') {
        flushAssistantText()
        input.push({
          type: 'function_call',
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input),
        })
        continue
      }
      unsupportedInput()
    }
    flushAssistantText()
  }
  return input as ResponsesInput
}

function responseUsage(value: unknown): ProviderUsage {
  const usage = value as {
    input_tokens?: unknown
    output_tokens?: unknown
    input_tokens_details?: { cached_tokens?: unknown }
    output_tokens_details?: { reasoning_tokens?: unknown }
  } | null
  const totalInput = typeof usage?.input_tokens === 'number'
    ? usage.input_tokens
    : 0
  const cached = typeof usage?.input_tokens_details?.cached_tokens === 'number'
    ? usage.input_tokens_details.cached_tokens
    : 0
  const output = typeof usage?.output_tokens === 'number'
    ? usage.output_tokens
    : 0
  const reasoning = typeof usage?.output_tokens_details?.reasoning_tokens === 'number'
    ? usage.output_tokens_details.reasoning_tokens
    : 0
  return {
    inputTokens: Math.max(0, totalInput - cached),
    outputTokens: Math.max(0, output),
    cacheReadTokens: Math.max(0, cached),
    cacheCreationTokens: 0,
    ...(reasoning > 0 ? { reasoningTokens: reasoning } : {}),
  }
}

function responseServingFacts(value: unknown): Partial<ProviderUsage> {
  if (typeof value !== 'object' || value === null) return {}
  const response = value as Record<string, unknown>
  return {
    ...(typeof response['id'] === 'string' ? { requestId: response['id'] } : {}),
    ...(typeof response['model'] === 'string'
      ? { servedModelId: response['model'] }
      : {}),
    ...(typeof response['provider'] === 'string'
      ? { servedProvider: response['provider'] }
      : {}),
    ...(typeof response['service_tier'] === 'string'
      ? { servedTier: response['service_tier'] }
      : {}),
  }
}

/**
 * OpenAI Responses transport for the native engine loop.
 *
 * This class implements only syntax/stream translation. A caller that routes
 * it to a non-platform endpoint owns authentication, endpoint rewriting and
 * the separately declared capability envelope.
 */
export class OpenAIResponsesProvider implements ProviderAdapter {
  readonly name = 'openai'
  readonly egressMediation = 'fetch' as const
  private readonly staticClient: OpenAI | null
  private readonly apiKeyProvider: (() => Promise<string>) | undefined
  private readonly dynamicBaseURL: string | undefined
  private readonly costBasis: ProviderCostBasis | undefined
  private readonly maxRetries: number | undefined
  private readonly staticOptions: {
    readonly apiKey?: string
    readonly baseURL?: string
  }
  private readonly transport: {
    fetch?: ProviderFetch
    defaultHeaders?: Readonly<Record<string, string>>
  }

  constructor(opts?: {
    apiKey?: string
    baseURL?: string
    apiKeyProvider?: () => Promise<string>
    costBasis?: ProviderCostBasis
    maxRetries?: number
  } & ProviderTransportOptions) {
    this.staticOptions = {
      ...(opts?.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
      ...(opts?.baseURL !== undefined ? { baseURL: opts.baseURL } : {}),
    }
    this.costBasis = opts?.costBasis
    this.maxRetries = opts?.maxRetries
    this.transport = {
      ...(opts?.fetch !== undefined ? { fetch: opts.fetch } : {}),
      ...(opts?.defaultHeaders !== undefined
        ? { defaultHeaders: opts.defaultHeaders }
        : {}),
    }
    if (opts?.apiKeyProvider !== undefined) {
      this.staticClient = null
      this.apiKeyProvider = opts.apiKeyProvider
      this.dynamicBaseURL = opts.baseURL
    } else {
      this.staticClient = new OpenAI({
        apiKey: opts?.apiKey,
        ...(opts?.baseURL !== undefined ? { baseURL: opts.baseURL } : {}),
        ...(this.maxRetries !== undefined
          ? { maxRetries: this.maxRetries }
          : {}),
        ...this.sdkTransport,
      })
      this.apiKeyProvider = undefined
      this.dynamicBaseURL = undefined
    }
  }

  private get sdkTransport(): Partial<ConstructorParameters<typeof OpenAI>[0]> {
    return this.transport as Partial<ConstructorParameters<typeof OpenAI>[0]>
  }

  private async client(request?: ProviderRequest): Promise<OpenAI> {
    const requestTransport = request?.egressControl === undefined
      ? this.transport
      : {
          ...this.transport,
          fetch: createEgressFetch({
            fetch: this.transport.fetch ?? globalThis.fetch,
            control: request.egressControl,
            sourceRef: this.name,
            mediation: this.transport.fetch === undefined
              ? 'platform_fetch'
              : 'custom_fetch',
          }),
        }
    const sdkTransport = requestTransport as Partial<ConstructorParameters<typeof OpenAI>[0]>
    if (this.apiKeyProvider === undefined) {
      if (this.staticClient === null) {
        throw new ProviderError(
          'Responses client was not configured.',
          'openai',
        )
      }
      if (request?.egressControl === undefined) return this.staticClient
      return new OpenAI({
        ...this.staticOptions,
        ...(this.maxRetries !== undefined ? { maxRetries: this.maxRetries } : {}),
        ...sdkTransport,
      })
    }
    return new OpenAI({
      apiKey: await this.apiKeyProvider(),
      ...(this.dynamicBaseURL !== undefined
        ? { baseURL: this.dynamicBaseURL }
        : {}),
      ...(this.maxRetries !== undefined
        ? { maxRetries: this.maxRetries }
        : {}),
      ...sdkTransport,
    })
  }

  async *stream(request: ProviderRequest): AsyncGenerator<ProviderChunk> {
    try {
      yield* this.streamResponses(request)
    } catch (error) {
      throw translateResponsesError(error)
    }
  }

  private async *streamResponses(
    request: ProviderRequest,
  ): AsyncGenerator<ProviderChunk> {
    assertPairing(request.messages)
    if (request.thinking?.enabled === true && request.tools.length > 0) {
      throw new ProviderError(
        'Responses transport cannot safely combine reasoning with tools.',
        'openai',
      )
    }
    if (
      request.providerOptions !== undefined
      && Object.keys(request.providerOptions).length > 0
    ) {
      throw new ProviderError(
        'Responses transport received unsupported provider options.',
        'openai',
      )
    }
    const instructions = toResponsesInstructions(request.system)
    const client = await this.client(request)
    const params: OpenAI.Responses.ResponseCreateParamsStreaming = {
      model: request.model,
      instructions,
      input: toResponsesInput(request.messages),
      max_output_tokens: request.maxTokens,
      stream: true,
      store: false,
      ...(request.temperature !== null
        ? { temperature: request.temperature }
        : {}),
      ...(request.tools.length > 0
        ? { tools: this.formatTools(request.tools) as OpenAI.Responses.Tool[] }
        : {}),
      ...(request.thinking?.enabled === true
        ? {
            reasoning: {
              effort: request.thinking.effort
                ?? mapBudgetToEffort(request.thinking.budgetTokens),
              summary: 'auto',
            },
          }
        : {}),
    }
    const stream = await client.responses.create(
      params,
      request.signal === undefined ? undefined : { signal: request.signal },
    )
    const guardedStream = withStallGuard(stream, {
      provider: 'openai',
      warnMs: request.stallWarnMs ?? STALL_WARN_MS,
      timeoutMs: request.stallTimeoutMs ?? STALL_TIMEOUT_MS,
    })

    let terminal: {
      readonly stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal'
      readonly usage: ProviderUsage
    } | undefined
    let lastSequence = -1
    const responseParts = new Map<string, {
      readonly outputIndex: number
      readonly contentIndex: number
      readonly kind: 'text' | 'refusal'
      text: string
    }>()
    const reasoningParts = new Map<string, {
      readonly outputIndex: number
      readonly summaryIndex: number
      text: string
    }>()
    const tools = new Map<string, {
      readonly id: string
      readonly name: string
      readonly outputIndex: number
      arguments: string
      ended: boolean
    }>()

    const reconcileMessage = (
      item: OpenAI.Responses.ResponseOutputMessage,
      outputIndex: number,
    ): ProviderChunk[] => {
      const chunks: ProviderChunk[] = []
      for (const [contentIndex, snapshot] of item.content.entries()) {
        const key = responsesPartKey(item.id, contentIndex)
        const kind = snapshot.type === 'output_text' ? 'text' : 'refusal'
        const snapshotText = snapshot.type === 'output_text'
          ? snapshot.text
          : snapshot.refusal
        const part = responseParts.get(key) ?? {
          outputIndex,
          contentIndex,
          kind,
          text: '',
        }
        if (
          part.kind !== kind
          || part.outputIndex !== outputIndex
          || part.contentIndex !== contentIndex
          || !snapshotText.startsWith(part.text)
        ) {
          throw new ProviderError(
            'Responses message snapshot conflicted with earlier stream data.',
            'openai',
          )
        }
        const remaining = snapshotText.slice(part.text.length)
        part.text = snapshotText
        responseParts.set(key, part)
        if (remaining.length > 0) {
          chunks.push({ type: 'text_delta', text: remaining })
        }
      }
      return chunks
    }

    const reconcileReasoning = (
      item: OpenAI.Responses.ResponseReasoningItem,
      outputIndex: number,
    ): ProviderChunk[] => {
      const chunks: ProviderChunk[] = []
      for (const [summaryIndex, snapshot] of item.summary.entries()) {
        const key = responsesPartKey(item.id, summaryIndex)
        const part = reasoningParts.get(key) ?? {
          outputIndex,
          summaryIndex,
          text: '',
        }
        if (
          part.outputIndex !== outputIndex
          || part.summaryIndex !== summaryIndex
          || !snapshot.text.startsWith(part.text)
        ) {
          throw new ProviderError(
            'Responses reasoning snapshot conflicted with earlier stream data.',
            'openai',
          )
        }
        const remaining = snapshot.text.slice(part.text.length)
        part.text = snapshot.text
        reasoningParts.set(key, part)
        if (remaining.length > 0) {
          chunks.push({ type: 'thinking_delta', text: remaining })
        }
      }
      return chunks
    }

    const reconcileFunctionCall = (
      item: OpenAI.Responses.ResponseFunctionToolCall,
      outputIndex: number,
    ): ProviderChunk[] => {
      const chunks: ProviderChunk[] = []
      const key = item.id ?? item.call_id
      let tracked = tools.get(key)
      if (tracked === undefined) {
        tracked = {
          id: item.call_id,
          name: item.name,
          outputIndex,
          arguments: '',
          ended: false,
        }
        tools.set(key, tracked)
        chunks.push({
          type: 'tool_use_start',
          id: tracked.id,
          name: tracked.name,
        })
      }
      if (
        tracked.id !== item.call_id
        || tracked.name !== item.name
        || tracked.outputIndex !== outputIndex
        || !item.arguments.startsWith(tracked.arguments)
      ) {
        throw new ProviderError(
          'Responses function call conflicted with earlier stream data.',
          'openai',
        )
      }
      const remaining = item.arguments.slice(tracked.arguments.length)
      if (remaining.length > 0) {
        tracked.arguments = item.arguments
        chunks.push({
          type: 'tool_use_args_delta',
          id: tracked.id,
          delta: remaining,
        })
      }
      if (!tracked.ended) {
        tracked.ended = true
        chunks.push({ type: 'tool_use_end', id: tracked.id })
      }
      return chunks
    }

    const reconcileOutput = (
      output: OpenAI.Responses.ResponseOutputItem[],
    ): ProviderChunk[] => {
      const chunks: ProviderChunk[] = []
      for (const [outputIndex, item] of output.entries()) {
        if (item.type === 'message') {
          chunks.push(...reconcileMessage(item, outputIndex))
          continue
        }
        if (item.type === 'function_call') {
          chunks.push(...reconcileFunctionCall(item, outputIndex))
          continue
        }
        if (item.type === 'reasoning') {
          chunks.push(...reconcileReasoning(item, outputIndex))
          continue
        }
        throw new ProviderError(
          'Responses output contained an unsupported material item.',
          'openai',
        )
      }
      return chunks
    }

    for await (const event of guardedStream) {
      if (
        !Number.isSafeInteger(event.sequence_number)
        || event.sequence_number < 0
        || event.sequence_number <= lastSequence
      ) {
        throw new ProviderError(
          'Responses event sequence was not strictly increasing.',
          'openai',
        )
      }
      lastSequence = event.sequence_number
      if (terminal !== undefined) {
        throw new ProviderError(
          'Responses event arrived after a terminal event.',
          'openai',
        )
      }
      if (event.type === 'response.output_text.delta') {
        const key = responsesPartKey(event.item_id, event.content_index)
        const part = responseParts.get(key) ?? {
          outputIndex: event.output_index,
          contentIndex: event.content_index,
          kind: 'text' as const,
          text: '',
        }
        if (
          part.kind !== 'text'
          || part.outputIndex !== event.output_index
          || part.contentIndex !== event.content_index
        ) {
          throw new ProviderError(
            'Responses output text referenced a conflicting content part.',
            'openai',
          )
        }
        part.text += event.delta
        responseParts.set(key, part)
        yield { type: 'text_delta', text: event.delta }
        continue
      }
      if (event.type === 'response.output_text.done') {
        const key = responsesPartKey(event.item_id, event.content_index)
        const part = responseParts.get(key) ?? {
          outputIndex: event.output_index,
          contentIndex: event.content_index,
          kind: 'text' as const,
          text: '',
        }
        if (
          part.kind !== 'text'
          || part.outputIndex !== event.output_index
          || part.contentIndex !== event.content_index
          || !event.text.startsWith(part.text)
        ) {
          throw new ProviderError(
            'Responses output text conflicted with earlier stream data.',
            'openai',
          )
        }
        const remaining = event.text.slice(part.text.length)
        part.text = event.text
        responseParts.set(key, part)
        if (remaining.length > 0) {
          yield { type: 'text_delta', text: remaining }
        }
        continue
      }
      if (event.type === 'response.reasoning_summary_text.delta') {
        const key = responsesPartKey(event.item_id, event.summary_index)
        const part = reasoningParts.get(key) ?? {
          outputIndex: event.output_index,
          summaryIndex: event.summary_index,
          text: '',
        }
        if (
          part.outputIndex !== event.output_index
          || part.summaryIndex !== event.summary_index
        ) {
          throw new ProviderError(
            'Responses reasoning summary referenced a conflicting part.',
            'openai',
          )
        }
        part.text += event.delta
        reasoningParts.set(key, part)
        yield { type: 'thinking_delta', text: event.delta }
        continue
      }
      if (event.type === 'response.reasoning_summary_text.done') {
        const key = responsesPartKey(event.item_id, event.summary_index)
        const part = reasoningParts.get(key) ?? {
          outputIndex: event.output_index,
          summaryIndex: event.summary_index,
          text: '',
        }
        if (
          part.outputIndex !== event.output_index
          || part.summaryIndex !== event.summary_index
          || !event.text.startsWith(part.text)
        ) {
          throw new ProviderError(
            'Responses reasoning summary conflicted with earlier stream data.',
            'openai',
          )
        }
        const remaining = event.text.slice(part.text.length)
        part.text = event.text
        reasoningParts.set(key, part)
        if (remaining.length > 0) {
          yield { type: 'thinking_delta', text: remaining }
        }
        continue
      }
      if (event.type === 'response.refusal.delta') {
        const key = responsesPartKey(event.item_id, event.content_index)
        const part = responseParts.get(key) ?? {
          outputIndex: event.output_index,
          contentIndex: event.content_index,
          kind: 'refusal' as const,
          text: '',
        }
        if (
          part.kind !== 'refusal'
          || part.outputIndex !== event.output_index
          || part.contentIndex !== event.content_index
        ) {
          throw new ProviderError(
            'Responses refusal referenced a conflicting content part.',
            'openai',
          )
        }
        part.text += event.delta
        responseParts.set(key, part)
        yield { type: 'text_delta', text: event.delta }
        continue
      }
      if (event.type === 'response.refusal.done') {
        const key = responsesPartKey(event.item_id, event.content_index)
        const part = responseParts.get(key) ?? {
          outputIndex: event.output_index,
          contentIndex: event.content_index,
          kind: 'refusal' as const,
          text: '',
        }
        if (
          part.kind !== 'refusal'
          || part.outputIndex !== event.output_index
          || part.contentIndex !== event.content_index
          || !event.refusal.startsWith(part.text)
        ) {
          throw new ProviderError(
            'Responses refusal conflicted with earlier stream data.',
            'openai',
          )
        }
        const remaining = event.refusal.slice(part.text.length)
        part.text = event.refusal
        responseParts.set(key, part)
        if (remaining.length > 0) {
          yield { type: 'text_delta', text: remaining }
        }
        continue
      }
      if (
        event.type === 'response.output_item.added'
        && event.item.type === 'function_call'
      ) {
        const tracked = {
          id: event.item.call_id,
          name: event.item.name,
          outputIndex: event.output_index,
          arguments: event.item.arguments,
          ended: false,
        }
        tools.set(event.item.id ?? event.item.call_id, tracked)
        yield {
          type: 'tool_use_start',
          id: tracked.id,
          name: tracked.name,
        }
        if (tracked.arguments.length > 0) {
          yield {
            type: 'tool_use_args_delta',
            id: tracked.id,
            delta: tracked.arguments,
          }
        }
        continue
      }
      if (event.type === 'response.function_call_arguments.delta') {
        const tracked = tools.get(event.item_id)
        if (
          tracked === undefined
          || tracked.ended
          || tracked.outputIndex !== event.output_index
        ) {
          throw new ProviderError(
            'Responses function arguments referenced an unknown or completed call.',
            'openai',
          )
        }
        tracked.arguments += event.delta
        yield {
          type: 'tool_use_args_delta',
          id: tracked.id,
          delta: event.delta,
        }
        continue
      }
      if (event.type === 'response.function_call_arguments.done') {
        const tracked = tools.get(event.item_id)
        if (
          tracked === undefined
          || tracked.ended
          || tracked.outputIndex !== event.output_index
        ) {
          throw new ProviderError(
            'Responses function arguments referenced an unknown or completed call.',
            'openai',
          )
        }
        if (!event.arguments.startsWith(tracked.arguments)) {
          throw new ProviderError(
            'Responses function arguments conflicted with earlier stream data.',
            'openai',
          )
        }
        const remaining = event.arguments.slice(tracked.arguments.length)
        tracked.arguments = event.arguments
        if (remaining.length > 0) {
          yield {
            type: 'tool_use_args_delta',
            id: tracked.id,
            delta: remaining,
          }
        }
        continue
      }
      if (
        event.type === 'response.output_item.done'
        && event.item.type === 'function_call'
      ) {
        for (const chunk of reconcileFunctionCall(
          event.item,
          event.output_index,
        )) yield chunk
        continue
      }
      if (
        event.type === 'response.output_item.done'
        && event.item.type === 'message'
      ) {
        for (const chunk of reconcileMessage(
          event.item,
          event.output_index,
        )) yield chunk
        continue
      }
      if (
        event.type === 'response.output_item.done'
        && event.item.type === 'reasoning'
      ) {
        for (const chunk of reconcileReasoning(
          event.item,
          event.output_index,
        )) yield chunk
        continue
      }
      if (
        (
          event.type === 'response.output_item.added'
          || event.type === 'response.output_item.done'
        )
        && (
          event.item.type === 'message'
          || event.item.type === 'reasoning'
        )
      ) {
        continue
      }
      if (event.type === 'error') {
        throw new ProviderError(
          'Responses stream reported a protocol error.',
          'openai',
        )
      }
      if (event.type === 'response.failed') {
        throw new ProviderError(
          'Responses stream reported failure.',
          'openai',
        )
      }
      if (event.type === 'response.incomplete') {
        if (
          event.response.incomplete_details?.reason !== 'max_output_tokens'
          || tools.size > 0
        ) {
          throw new ProviderError(
            'Responses stream ended incomplete outside the supported envelope.',
            'openai',
          )
        }
        for (const chunk of reconcileOutput(event.response.output)) yield chunk
        terminal = {
          stopReason: 'max_tokens',
          usage: {
            ...responseUsage(event.response.usage),
            ...responseServingFacts(event.response),
          },
        }
        continue
      }
      if (event.type === 'response.completed') {
        for (const chunk of reconcileOutput(event.response.output)) yield chunk
        terminal = {
          stopReason: [...responseParts.values()].some(
            (part) => part.kind === 'refusal',
          )
            ? 'refusal'
            : tools.size > 0
              ? 'tool_use'
              : 'end_turn',
          usage: {
            ...responseUsage(event.response.usage),
            ...responseServingFacts(event.response),
          },
        }
        continue
      }
      if (
        event.type === 'response.created'
        || event.type === 'response.in_progress'
        || event.type === 'response.queued'
        || event.type === 'response.content_part.added'
        || event.type === 'response.content_part.done'
        || event.type === 'response.reasoning_summary_part.added'
        || event.type === 'response.reasoning_summary_part.done'
        || event.type === 'response.reasoning_summary.done'
      ) {
        continue
      }
      throw new ProviderError(
        'Responses stream contained an unsupported material event.',
        'openai',
      )
    }
    if (terminal === undefined) {
      throw new ProviderError(
        'Responses stream ended without a terminal event.',
        'openai',
      )
    }
    const orderedContent: Array<{
      readonly outputIndex: number
      readonly contentIndex: number
      readonly block: ContentBlock
    }> = []
    for (const part of reasoningParts.values()) {
      if (part.text.length > 0) {
        orderedContent.push({
          outputIndex: part.outputIndex,
          contentIndex: part.summaryIndex,
          block: { type: 'thinking', text: part.text },
        })
      }
    }
    for (const part of responseParts.values()) {
      if (part.text.length > 0) {
        orderedContent.push({
          outputIndex: part.outputIndex,
          contentIndex: part.contentIndex,
          block: { type: 'text', text: part.text },
        })
      }
    }
    for (const tool of tools.values()) {
      if (!tool.ended) {
        throw new ProviderError(
          'Responses stream ended with an incomplete function call.',
          'openai',
        )
      }
      let input: Record<string, unknown>
      try {
        input = JSON.parse(tool.arguments || '{}') as Record<string, unknown>
      } catch {
        throw new ProviderError(
          'Responses function arguments were not valid JSON.',
          'openai',
        )
      }
      orderedContent.push({
        outputIndex: tool.outputIndex,
        contentIndex: 0,
        block: {
          type: 'tool_use',
          id: tool.id,
          name: tool.name,
          input,
        },
      })
    }
    orderedContent.sort((left, right) => (
      left.outputIndex - right.outputIndex
      || left.contentIndex - right.contentIndex
    ))
    const content: ContentBlock[] = []
    for (const { block } of orderedContent) {
      const previous = content.at(-1)
      if (previous?.type === 'text' && block.type === 'text') {
        content[content.length - 1] = {
          type: 'text',
          text: previous.text + block.text,
        }
        continue
      }
      if (previous?.type === 'thinking' && block.type === 'thinking') {
        content[content.length - 1] = {
          type: 'thinking',
          text: previous.text + block.text,
        }
        continue
      }
      content.push(block)
    }
    yield {
      type: 'message_complete',
      content,
      stopReason: terminal.stopReason,
      usage: {
        ...terminal.usage,
        ...(this.costBasis !== undefined
          ? { costBasis: this.costBasis }
          : {}),
      },
    }
  }

  async countTokens(messages: Message[], system?: string): Promise<number> {
    let total = system == null ? 0 : Math.ceil(system.length / 4)
    for (const message of messages) {
      total += Math.ceil(JSON.stringify(message.content).length / 4)
    }
    return total
  }

  supportsFeature(feature: ProviderFeature): boolean {
    return new Set<ProviderFeature>([
      'streaming',
      'vision',
      'tool_use',
      'parallel_tool_use',
      'structured_output',
    ]).has(feature)
  }

  formatTools(tools: ToolDefinition[]): unknown[] {
    return tools.map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      strict: false,
    }))
  }

  getModelPricing(model: string): ModelPricing | null {
    return getModelPricing('openai', model)
  }
}
