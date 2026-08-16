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
import type { LoomEvent } from '../../../core/events.js'
import type { Tool, ToolResult, ToolUIDescriptor } from '../../../tools/types.js'

class DescriptorToolProvider implements ProviderAdapter {
  readonly name = 'descriptor-tool-fixture'
  private turn = 0

  async *stream(_request: ProviderRequest): AsyncGenerator<ProviderChunk> {
    if (this.turn++ === 0) {
      yield { type: 'tool_use_start', id: 'call-1', name: 'custom_tool' }
      yield { type: 'tool_use_args_delta', id: 'call-1', delta: '{}' }
      yield {
        type: 'message_complete',
        content: [{ type: 'tool_use', id: 'call-1', name: 'custom_tool', input: {} }],
        stopReason: 'tool_use',
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
      }
      return
    }
    yield {
      type: 'message_complete',
      content: [{ type: 'text', text: 'done' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
    }
  }

  async countTokens(_messages: Message[]): Promise<number> { return 0 }
  supportsFeature(_feature: ProviderFeature): boolean { return false }
  formatTools(_tools: ToolDefinition[]): unknown[] { return [] }
  getModelPricing(_model: string): ModelPricing | null { return null }
}

function toolWithDescriptor(uiDescriptor: ToolUIDescriptor): Tool {
  return {
    name: 'custom_tool',
    description: 'fixture',
    input_schema: { type: 'object', properties: {} },
    uiDescriptor,
    isReadOnly: true,
    execute(): ToolResult {
      return { content: 'ok', isError: false }
    },
  }
}

async function run(tool: Tool): Promise<LoomEvent[]> {
  const session = new Session({
    config: createDefaultConfig('fixture:model'),
    provider: new DescriptorToolProvider(),
    tools: [tool],
    compaction: null,
  })
  const events: LoomEvent[] = []
  for await (const event of session.submitMessage('go')) events.push(event)
  return events
}

describe('tool UI descriptor events', () => {
  it('publishes the bounded descriptor from the exact registered tool object', async () => {
    const descriptor: ToolUIDescriptor = {
      kind: 'external-action',
      summary: { verb: 'Custom operation', primaryField: 'target' },
      preview: { contentField: 'result', format: 'plain', truncateAtLines: 12 },
      openAction: { target: 'url', pathField: 'target' },
    }
    const events = await run(toolWithDescriptor(descriptor))
    const start = events.find(event => event.type === 'tool.call.start')
    const end = events.find(event => event.type === 'tool.call.end')
    expect(start).toMatchObject({ uiDescriptor: descriptor })
    expect(end).toMatchObject({ uiDescriptor: descriptor })
  })

  it('omits malformed custom presentation data instead of publishing it', async () => {
    const malformed = {
      kind: 'external-action',
      summary: { verb: `oversized-${'x'.repeat(200)}` },
    } as unknown as ToolUIDescriptor
    const events = await run(toolWithDescriptor(malformed))
    const start = events.find(event => event.type === 'tool.call.start')
    const end = events.find(event => event.type === 'tool.call.end')
    expect(start).not.toHaveProperty('uiDescriptor')
    expect(end).not.toHaveProperty('uiDescriptor')
  })
})
