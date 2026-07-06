/**
 * Tests for session.end event emission in the agent loop.
 *
 * Verifies that session.end is the last yielded event before the generator
 * returns, and that it carries correct data for every stop reason.
 */

import { describe, it, expect } from 'vitest'
import { loop, type LoopParams } from '../../../src/core/loop.js'
import { createDefaultConfig, mergeConfig } from '../../../src/core/config.js'
import { createMockProvider } from '../../helpers/mock-provider.js'
import { userMsg } from '../../helpers/fixtures.js'
import { ProviderError } from '../../../src/core/errors.js'
import type { LoomEvent, SessionEndEvent } from '../../../src/core/events.js'
import type { ProviderChunk } from '../../../src/provider/types.js'

/** Collect all events from the loop generator and return events + final result. */
async function collectLoop(params: LoopParams) {
  const events: LoomEvent[] = []
  const gen = loop(params)
  let next = await gen.next()
  while (!next.done) {
    events.push(next.value)
    next = await gen.next()
  }
  return { events, result: next.value }
}

function makeParams(overrides: Partial<LoopParams> = {}): LoopParams {
  const config = createDefaultConfig('mock:test-model')
  const provider = createMockProvider({ summaryResponse: 'Hello!' })
  return {
    messages: [userMsg('Hi')],
    systemPrompt: 'You are a test assistant.',
    provider,
    tools: [],
    config,
    compaction: null,
    checkpoint: null,
    checkPermission: async () => 'allow' as const,
    requestApproval: async () => true,
    ...overrides,
  }
}

describe('session.end event', () => {
  it('is emitted on normal end_turn completion', async () => {
    const params = makeParams()
    const { events, result } = await collectLoop(params)

    const sessionEnd = events.filter(e => e.type === 'session.end')
    expect(sessionEnd).toHaveLength(1)

    const endEvent = sessionEnd[0] as SessionEndEvent
    expect(endEvent.reason).toBe('end_turn')
    expect(endEvent.turnCount).toBe(result.turnCount)
    expect(endEvent.sessionId).toBe(params.config.sessionId)
    expect(endEvent.timestamp).toBeGreaterThan(0)
  })

  it('is the LAST yielded event before generator returns', async () => {
    const params = makeParams()
    const { events } = await collectLoop(params)

    const lastEvent = events[events.length - 1]
    expect(lastEvent.type).toBe('session.end')
  })

  it('has matching sessionId with session.start', async () => {
    const params = makeParams()
    const { events } = await collectLoop(params)

    const startEvent = events.find(e => e.type === 'session.start')
    const endEvent = events.find(e => e.type === 'session.end') as SessionEndEvent
    expect(startEvent).toBeDefined()
    expect(endEvent).toBeDefined()
    expect(endEvent.sessionId).toBe(
      (startEvent as { sessionId: string }).sessionId,
    )
  })

  it('is emitted on abort', async () => {
    const controller = new AbortController()
    controller.abort()

    const config = mergeConfig(createDefaultConfig('mock:test-model'), {
      abortSignal: controller.signal,
    })
    const params = makeParams({ config })
    const { events, result } = await collectLoop(params)

    const endEvent = events.find(e => e.type === 'session.end') as SessionEndEvent
    expect(endEvent).toBeDefined()
    expect(endEvent.reason).toBe('aborted')
    expect(result.reason).toBe('aborted')
  })

  it('is emitted on max_turns', async () => {
    const config = mergeConfig(createDefaultConfig('mock:test-model'), {
      maxTurns: 0, // 0 means unlimited, use 1 to trigger immediately
    })
    // Set maxTurns to trigger: the loop checks turnIndex >= maxTurns
    // With maxTurns=1 and initial turnIndex=0, first iteration runs,
    // then turnIndex becomes 1 which triggers on second iteration.
    // But we need it to trigger on first check — set maxTurns=0 won't work
    // since 0 means unlimited. Instead, use a tool-using mock to force
    // multiple turns, or use a mock that increments past the limit.
    // Simplest: set maxTurns=1 and use a tool-using response to force turn 1.

    // Actually, let's create a provider that returns tool_use to force loop continuation
    const provider = createMockProviderWithToolUse()
    const configWithLimit = mergeConfig(createDefaultConfig('mock:test-model'), {
      maxTurns: 1,
    })
    const params = makeParams({
      config: configWithLimit,
      provider,
      tools: [{
        name: 'test_tool',
        description: 'A test tool',
        inputSchema: { type: 'object' as const, properties: {} },
        isReadOnly: true,
        requiresPermission: false,
        execute: async () => ({ content: 'done', isError: false }),
      }],
    })
    const { events, result } = await collectLoop(params)

    const endEvent = events.find(e => e.type === 'session.end') as SessionEndEvent
    expect(endEvent).toBeDefined()
    expect(endEvent.reason).toBe('max_turns')
    expect(result.reason).toBe('max_turns')
  })

  it('is emitted on budget_exceeded', async () => {
    // Set a very low budget that will be exceeded after one turn
    const config = mergeConfig(createDefaultConfig('mock:test-model'), {
      maxBudgetUsd: 0.000001, // Extremely low
    })

    // Use a tool-returning mock so the loop continues to check budget
    const provider = createMockProviderWithToolUse()
    const params = makeParams({
      config,
      provider,
      tools: [{
        name: 'test_tool',
        description: 'A test tool',
        inputSchema: { type: 'object' as const, properties: {} },
        isReadOnly: true,
        requiresPermission: false,
        execute: async () => ({ content: 'done', isError: false }),
      }],
    })
    const { events, result } = await collectLoop(params)

    const endEvent = events.find(e => e.type === 'session.end') as SessionEndEvent
    expect(endEvent).toBeDefined()
    expect(endEvent.reason).toBe('budget_exceeded')
    expect(result.reason).toBe('budget_exceeded')
  })

  it('is emitted on unrecoverable error', async () => {
    const error = new ProviderError('Server error', 'mock', {
      statusCode: 500,
      recoverable: false,
    })
    const provider = createMockProvider({
      streamError: error,
      failOnStreamCall: 1,
    })
    const params = makeParams({ provider })
    const { events, result } = await collectLoop(params)

    const endEvent = events.find(e => e.type === 'session.end') as SessionEndEvent
    expect(endEvent).toBeDefined()
    expect(endEvent.reason).toBe('error')
    expect(result.reason).toBe('error')
  })

  it('carries correct totalUsage and turnCount', async () => {
    const params = makeParams()
    const { events, result } = await collectLoop(params)

    const endEvent = events.find(e => e.type === 'session.end') as SessionEndEvent
    expect(endEvent.totalUsage.inputTokens).toBe(result.totalUsage.inputTokens)
    expect(endEvent.totalUsage.outputTokens).toBe(result.totalUsage.outputTokens)
    expect(endEvent.turnCount).toBe(result.turnCount)
  })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a mock provider that returns a tool_use on the first call,
 * then end_turn on subsequent calls.
 */
function createMockProviderWithToolUse() {
  let callCount = 0
  return {
    name: 'mock' as const,
    streamCallCount: 0,
    streamRequests: [] as unknown[],

    async *stream(): AsyncGenerator<ProviderChunk> {
      callCount++
      if (callCount === 1) {
        yield { type: 'text_delta' as const, text: '' }
        yield {
          type: 'tool_use_start' as const,
          id: 'call_1',
          name: 'test_tool',
        }
        yield {
          type: 'tool_use_args_delta' as const,
          id: 'call_1',
          delta: '{}',
        }
        yield { type: 'tool_use_end' as const, id: 'call_1' }
        yield {
          type: 'message_complete' as const,
          content: [{ type: 'tool_use' as const, id: 'call_1', name: 'test_tool', input: {} }],
          stopReason: 'tool_use' as const,
          usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0 },
        }
      } else {
        yield { type: 'text_delta' as const, text: 'Done' }
        yield {
          type: 'message_complete' as const,
          content: [{ type: 'text' as const, text: 'Done' }],
          stopReason: 'end_turn' as const,
          usage: { inputTokens: 50, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 },
        }
      }
    },

    async countTokens(): Promise<number> {
      return 500
    },

    supportsFeature(): boolean {
      return true
    },

    formatTools(tools: unknown[]): unknown[] {
      return tools
    },
  }
}
