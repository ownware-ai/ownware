import { describe, expect, it, vi } from 'vitest'
import { Session } from '../../../src/core/session.js'
import { createDefaultConfig } from '../../../src/core/config.js'
import { defineTool, type Tool } from '../../../src/tools/types.js'
import { unsafeCreateSensitiveInputHandle } from '../../../src/sensitive-input/types.js'
import type { LoomEvent } from '../../../src/core/events.js'
import type {
  ProviderAdapter,
  ProviderChunk,
  ProviderFeature,
  ProviderRequest,
  ToolDefinition,
} from '../../../src/provider/types.js'

const SECRET = 'opaque-canary-秘密'

function provider(toolName: string, requests: ProviderRequest[] = []): ProviderAdapter {
  let calls = 0
  return {
    name: 'mock',
    async *stream(request: ProviderRequest): AsyncGenerator<ProviderChunk> {
      requests.push(request)
      calls++
      if (calls > 1) {
        yield {
          type: 'message_complete',
          content: [{ type: 'text', text: 'done' }],
          stopReason: 'end_turn',
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          },
        } as ProviderChunk
        return
      }
      yield {
        type: 'tool_use_start',
        toolCallId: 'call-1',
        toolName,
        input: {},
      } as ProviderChunk
      yield {
        type: 'message_complete',
        content: [{ type: 'tool_use', id: 'call-1', name: toolName, input: {} }],
        stopReason: 'tool_use',
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      } as ProviderChunk
    },
    async countTokens() { return 10 },
    supportsFeature(_feature: ProviderFeature) { return true },
    formatTools(tools: ToolDefinition[]) { return tools },
    getModelPricing() { return null },
  } as unknown as ProviderAdapter
}

function sensitiveTool(): Tool {
  return defineTool({
    name: 'test_sensitive',
    description: 'test',
    isReadOnly: false,
    requiresPermission: false,
    inputSchema: { type: 'object', properties: {} },
    async *execute() {
      const resolution = yield {
        message: 'Waiting',
        sensitiveInputRequest: {
          label: 'Test value',
          usage: 'Unit test',
          binding: { kind: 'test-target', revision: 'test.inject.v1' },
        },
      }
      yield { message: `post-injection progress ${SECRET}` }
      return {
        content: `tool result ${SECRET} ${JSON.stringify(SECRET).slice(1, -1)}`,
        metadata: {
          nested: [SECRET],
          hostile: {
            value: SECRET,
            toJSON: () => ({ leaked: SECRET }),
          },
        },
        isError: resolution.status !== 'injected',
      }
    },
  })
}

async function run(session: Session): Promise<LoomEvent[]> {
  const events: LoomEvent[] = []
  const stream = session.submitMessage('go')
  let next = await stream.next()
  while (!next.done) {
    events.push(next.value)
    next = await stream.next()
  }
  return events
}

function config() {
  const base = createDefaultConfig('mock:model')
  return { ...base, maxTurns: 2, maxTokens: 100 }
}

describe('sensitive input loop lifecycle', () => {
  it('publishes only metadata after synchronous registration and redacts all tool output', async () => {
    const tool = sensitiveTool()
    const handle = unsafeCreateSensitiveInputHandle('one-use-handle')
    const providerRequests: ProviderRequest[] = []
    const session = new Session({
      config: config(),
      provider: provider(tool.name, providerRequests),
      tools: [tool],
      checkPermission: vi.fn().mockResolvedValue('allow'),
      requestApproval: vi.fn().mockResolvedValue(true),
      sensitiveInputs: {
        isRegistered: candidate => candidate === tool,
        request: () => ({
          status: 'pending',
          adapterRevision: 'test.inject.v1',
          provision: Promise.resolve({ status: 'provided', handle }),
        }),
        consume: async candidate =>
          candidate === handle ? { status: 'injected' } : { status: 'indeterminate' },
        redactText: text => text.split(SECRET).join('[REDACTED:SENSITIVE_INPUT]')
          .split(JSON.stringify(SECRET).slice(1, -1))
          .join('[REDACTED:SENSITIVE_INPUT]'),
      },
    })

    const events = await run(session)
    const request = events.find((event): event is Extract<
      LoomEvent,
      { type: 'sensitive.input.request' }
    > => event.type === 'sensitive.input.request')
    const response = events.find(event => event.type === 'sensitive.input.response')

    expect(request).toMatchObject({
      toolCallId: 'call-1',
      toolName: tool.name,
      label: 'Test value',
      usage: 'Unit test',
      agentId: null,
      adapterRevision: 'test.inject.v1',
    })
    expect(request).not.toHaveProperty('binding')
    expect(response).toMatchObject({
      status: 'injected',
      adapterRevision: 'test.inject.v1',
      agentId: null,
    })
    expect(JSON.stringify(events)).not.toContain(SECRET)
    expect(providerRequests).toHaveLength(2)
    expect(JSON.stringify(providerRequests)).not.toContain(SECRET)
  })

  it('does not publish an unresolvable request when the host fails closed', async () => {
    const tool = sensitiveTool()
    const session = new Session({
      config: config(),
      provider: provider(tool.name),
      tools: [tool],
      checkPermission: vi.fn().mockResolvedValue('allow'),
      requestApproval: vi.fn().mockResolvedValue(true),
      sensitiveInputs: {
        isRegistered: candidate => candidate === tool,
        request: () => ({ status: 'unavailable' }),
      },
    })

    const events = await run(session)
    expect(events.some(event => event.type === 'sensitive.input.request')).toBe(false)
    expect(events.some(event => event.type === 'sensitive.input.response')).toBe(false)
    expect(events.find(event => event.type === 'tool.call.end')).toMatchObject({
      isError: true,
    })
  })
})
