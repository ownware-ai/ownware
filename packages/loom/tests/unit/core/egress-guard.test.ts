import { describe, expect, it, vi } from 'vitest'
import { Session } from '../../../src/core/session.js'
import { createDefaultConfig } from '../../../src/core/config.js'
import { EgressBlockedError, type EgressControl } from '../../../src/egress/types.js'
import { HookRegistry } from '../../../src/hooks/registry.js'
import { HookRuntime } from '../../../src/hooks/runtime.js'
import { defineTool, type Tool } from '../../../src/tools/types.js'
import type {
  ProviderAdapter,
  ProviderChunk,
  ProviderFeature,
  ProviderRequest,
  ToolDefinition,
} from '../../../src/provider/types.js'
import type { LoomEvent } from '../../../src/core/events.js'

function localOnlyControl(): EgressControl & { routeUnavailable: ReturnType<typeof vi.fn> } {
  return {
    mode: 'local-only',
    beforeDispatch: vi.fn(),
    responseObserved: vi.fn(),
    redirectBlocked: vi.fn(),
    dispatchFailed: vi.fn(),
    routeUnavailable: vi.fn().mockRejectedValue(
      new EgressBlockedError('local_only_route_unavailable'),
    ),
  }
}

function toolUseProvider(toolName: string): ProviderAdapter {
  return {
    name: 'controlled-provider',
    egressMediation: 'delegated',
    async *stream(_request: ProviderRequest): AsyncGenerator<ProviderChunk> {
      const id = 'tool-call-1'
      yield { type: 'tool_use_start', toolCallId: id, toolName, input: {} } as ProviderChunk
      yield {
        type: 'message_complete',
        content: [{ type: 'tool_use', id, name: toolName, input: {} }],
        stopReason: 'tool_use',
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
      } as ProviderChunk
    },
    async countTokens() { return 1 },
    supportsFeature(_feature: ProviderFeature) { return true },
    formatTools(tools: ToolDefinition[]) { return tools },
    getModelPricing() { return null },
  }
}

async function runOneTurn(session: Session): Promise<LoomEvent[]> {
  const events: LoomEvent[] = []
  for await (const event of session.submitMessage('go')) events.push(event)
  return events
}

function uncontainedTool(category: Tool['category'], executed: ReturnType<typeof vi.fn>): Tool {
  return defineTool({
    name: `escape_${category ?? 'unknown'}`,
    description: 'Adversarial tool whose execute function must remain unreachable.',
    category,
    egress: { contractRevision: 'test-1', mediation: 'uncontained' },
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      executed()
      return { content: 'escaped', isError: false }
    },
  })
}

describe('local-only egress guard', () => {
  it.each([
    ['shell', 'process'],
    ['browser', 'browser'],
    ['mcp', 'connector'],
    ['external-action', 'tool'],
  ] as const)('blocks an uncontained %s tool before execute', async (category, sourceKind) => {
    const executed = vi.fn()
    const control = localOnlyControl()
    const tool = uncontainedTool(category, executed)
    const session = new Session({
      config: {
        ...createDefaultConfig('controlled:model'),
        maxTurns: 1,
        maxTokens: 100,
        egressControl: control,
      },
      provider: toolUseProvider(tool.name),
      tools: [tool],
      permissionMode: 'ask',
      checkPermission: vi.fn().mockResolvedValue('allow'),
      requestApproval: vi.fn().mockResolvedValue(true),
    })

    const events = await runOneTurn(session)

    expect(executed).not.toHaveBeenCalled()
    expect(control.routeUnavailable).toHaveBeenCalledWith(expect.objectContaining({
      sourceKind,
      sourceRef: tool.name,
      mediation: 'uncontained',
    }))
    expect(events).toContainEqual(expect.objectContaining({
      type: 'security.block',
      toolName: tool.name,
      reason: 'egress-route-unavailable',
    }))
    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool.call.end',
      toolName: tool.name,
      isError: true,
    }))
  })

  it('blocks an undeclared provider before its stream can dispatch', async () => {
    const control = localOnlyControl()
    const stream = vi.fn(async function* (): AsyncGenerator<ProviderChunk> {
      yield {
        type: 'message_complete',
        content: [{ type: 'text', text: 'must not run' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
      } as ProviderChunk
    })
    const provider = {
      ...toolUseProvider('unused'),
      name: 'uncontained-provider',
      egressMediation: 'uncontained' as const,
      stream,
    }
    const session = new Session({
      config: {
        ...createDefaultConfig('uncontained:model'),
        maxTurns: 1,
        maxTokens: 100,
        egressControl: control,
      },
      provider,
      tools: [],
    })

    await runOneTurn(session)

    expect(stream).not.toHaveBeenCalled()
    expect(control.routeUnavailable).toHaveBeenCalledWith({
      sourceKind: 'provider',
      sourceRef: 'uncontained-provider',
      mediation: 'uncontained',
    })
  })

  it('blocks an uncontained lifecycle hook before its function runs', async () => {
    const invoked = vi.fn()
    const control = localOnlyControl()
    const registry = new HookRegistry().register('session.start', {
      type: 'fn',
      name: 'remote_hook',
      fn: async () => {
        invoked()
        return { continue: true }
      },
      egress: {
        contractRevision: 1,
        sourceKind: 'connector',
        sourceRef: 'remote_hook',
        mediation: 'uncontained',
      },
    })

    const result = await new HookRuntime({ registry }).run({
      event: 'session.start',
      turnIndex: 0,
      sessionId: 'session-1',
      model: 'controlled:model',
    }, undefined, control)

    expect(invoked).not.toHaveBeenCalled()
    expect(result).toEqual({
      continue: false,
      blockedHook: 'remote_hook',
      blockedReason: 'Hook has no verified outbound containment for this local-only run.',
    })
  })

  it('propagates an egress-authority persistence failure instead of executing', async () => {
    const invoked = vi.fn()
    const authorityFailure = new Error('receipt database unavailable')
    const control = localOnlyControl()
    control.routeUnavailable.mockRejectedValue(authorityFailure)
    const registry = new HookRegistry().register('session.start', {
      type: 'fn',
      name: 'remote_hook',
      fn: async () => {
        invoked()
        return { continue: true }
      },
    })

    await expect(new HookRuntime({ registry }).run({
      event: 'session.start',
      turnIndex: 0,
      sessionId: 'session-1',
      model: 'controlled:model',
    }, undefined, control)).rejects.toBe(authorityFailure)
    expect(invoked).not.toHaveBeenCalled()
  })
})
