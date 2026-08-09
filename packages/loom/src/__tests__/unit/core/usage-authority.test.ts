import { describe, expect, it } from 'vitest'
import { Session } from '../../../core/session.js'
import { createDefaultConfig } from '../../../core/config.js'
import type {
  ProviderAdapter,
  ProviderChunk,
  ProviderFeature,
  ProviderRequest,
  ToolDefinition,
} from '../../../provider/types.js'
import type { ModelPricing } from '../../../provider/pricing.js'
import type { Message } from '../../../messages/types.js'

class UsageProvider implements ProviderAdapter {
  readonly name = 'usage-authority'
  async *stream(_request: ProviderRequest): AsyncGenerator<ProviderChunk> {
    yield {
      type: 'message_complete',
      content: [{ type: 'text', text: 'done' }],
      stopReason: 'end_turn',
      usage: {
        inputTokens: 10,
        outputTokens: 7,
        cacheReadTokens: 2,
        cacheCreationTokens: 1,
        reasoningTokens: 3,
        reportedCostUsd: 0.0042,
        requestId: 'request-1',
        generationId: 'generation-1',
        servedModelId: 'served-model-1',
        servedProvider: 'served-provider-1',
        servedTier: 'priority',
      },
    }
  }
  async countTokens(_messages: Message[]): Promise<number> { return 0 }
  supportsFeature(_feature: ProviderFeature): boolean { return false }
  formatTools(_tools: ToolDefinition[]): unknown[] { return [] }
  getModelPricing(_model: string): ModelPricing | null { return null }
}

describe('provider usage authority', () => {
  it('marks normalized provider completion and preserves provider-returned facts', async () => {
    const session = new Session({
      config: createDefaultConfig('usage-authority:model'),
      provider: new UsageProvider(),
      tools: [],
      compaction: null,
    })
    const events = []
    for await (const event of session.submitMessage('hello')) events.push(event)
    const turnEnd = events.find(event => event.type === 'turn.end')
    expect(turnEnd).toMatchObject({
      type: 'turn.end',
      usage: {
        usageAuthority: 'provider_response',
        reasoningTokens: 3,
        costClassification: 'provider_reported',
        costUsd: 0.0042,
        providerFacts: {
          requestId: 'request-1',
          generationId: 'generation-1',
          servedModelId: 'served-model-1',
          servedProvider: 'served-provider-1',
          servedTier: 'priority',
        },
      },
    })
  })
})
