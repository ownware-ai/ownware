/**
 * Mock ProviderAdapter for compaction tests.
 *
 * Configurable token counts, streaming responses, and failure injection.
 */

import type {
  ProviderAdapter,
  ProviderChunk,
  ProviderRequest,
  ProviderFeature,
  ToolDefinition,
} from '../../src/provider/types.js'
import type { Message } from '../../src/messages/types.js'

export interface MockProviderOptions {
  /**
   * Fixed token count to return from countTokens().
   * If a function, called with the messages to compute dynamically.
   */
  tokenCount?: number | ((messages: Message[], system?: string) => number)

  /**
   * Text to return from stream() calls (for summarization).
   * Can be a string or a function that receives the request.
   */
  summaryResponse?: string | ((request: ProviderRequest) => string)

  /**
   * If set, stream() will throw this error on the Nth call (1-indexed).
   */
  failOnStreamCall?: number

  /**
   * Custom stream error to throw.
   */
  streamError?: Error
}

export function createMockProvider(opts: MockProviderOptions = {}): MockProvider {
  let streamCallCount = 0

  const provider: MockProvider = {
    name: 'mock',

    streamCallCount: 0,
    streamRequests: [],

    async *stream(request: ProviderRequest): AsyncGenerator<ProviderChunk> {
      streamCallCount++
      provider.streamCallCount = streamCallCount
      provider.streamRequests.push(request)

      // Fail on Nth call if configured
      if (opts.failOnStreamCall && streamCallCount === opts.failOnStreamCall) {
        const error = opts.streamError ?? new Error('Mock stream failure')
        yield { type: 'stream_error', error } as ProviderChunk
        return
      }

      // Determine response text
      let text: string
      if (typeof opts.summaryResponse === 'function') {
        text = opts.summaryResponse(request)
      } else {
        text = opts.summaryResponse ?? 'Mock summary of the conversation.'
      }

      // Yield text delta
      yield { type: 'text_delta', text } as ProviderChunk

      // Yield message complete
      yield {
        type: 'message_complete',
        content: [{ type: 'text', text }],
        stopReason: 'end_turn',
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      } as ProviderChunk
    },

    async countTokens(messages: Message[], system?: string): Promise<number> {
      if (typeof opts.tokenCount === 'function') {
        return opts.tokenCount(messages, system)
      }
      if (opts.tokenCount !== undefined) {
        return opts.tokenCount
      }
      // Default: rough estimate based on message count
      return messages.length * 500
    },

    supportsFeature(_feature: ProviderFeature): boolean {
      return true
    },

    formatTools(tools: ToolDefinition[]): unknown[] {
      return tools
    },

    /** Mock returns null — pricing-table lookup is provider-specific and
     *  we don't ship a fake pricing table for tests. Loom callsites that
     *  need pricing fall back gracefully on a null return. */
    getModelPricing(_model: string) {
      return null
    },
  }

  return provider
}

export interface MockProvider extends ProviderAdapter {
  /** How many times stream() was called */
  streamCallCount: number
  /** All requests passed to stream() */
  streamRequests: ProviderRequest[]
}
