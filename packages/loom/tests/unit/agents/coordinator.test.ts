import { describe, it, expect, vi } from 'vitest'

// We test coordinator logic through its public API.
// Since fanOut/pipeline depend on AgentSpawner which calls loop(),
// we mock the loop module to avoid real provider calls.

vi.mock('../../../src/core/loop.js', () => ({
  loop: vi.fn(),
}))

import { fanOut, pipeline, mapReduce } from '../../../src/agents/coordinator.js'
import { loop } from '../../../src/core/loop.js'
import { createDefaultConfig } from '../../../src/core/config.js'
import { createMockProvider } from '../../helpers/mock-provider.js'
import type { Tool } from '../../../src/tools/types.js'
import type { LoopResult } from '../../../src/core/loop.js'

const mockLoop = vi.mocked(loop)

function makeTool(name: string): Tool {
  return {
    name,
    description: `Tool ${name}`,
    inputSchema: { type: 'object', properties: {} },
    execute: async () => ({ content: 'ok', isError: false }),
  }
}

function makeLoopResult(text: string, turns = 1): LoopResult {
  return {
    reason: 'end_turn',
    messages: [
      { role: 'user', content: 'input' },
      { role: 'assistant', content: [{ type: 'text', text }] },
    ],
    totalUsage: {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      model: 'mock',
      costUsd: 0.01,
    },
    turnCount: turns,
  }
}

// Helper to make the mocked loop return a result via AsyncGenerator
function mockLoopReturning(result: LoopResult) {
  mockLoop.mockImplementation(async function* () {
    // Yield a session.start event
    yield {
      type: 'session.start' as const,
      sessionId: 'test',
      model: 'mock',
      timestamp: Date.now(),
    }
    return result
  })
}

describe('fanOut', () => {
  it('runs multiple agents and returns results', async () => {
    let callCount = 0
    mockLoop.mockImplementation(async function* () {
      callCount++
      yield {
        type: 'session.start' as const,
        sessionId: `test-${callCount}`,
        model: 'mock',
        timestamp: Date.now(),
      }
      return makeLoopResult(`Result ${callCount}`)
    })

    const results = await fanOut(
      [
        { name: 'agent-1' },
        { name: 'agent-2' },
        { name: 'agent-3' },
      ],
      {
        provider: createMockProvider(),
        tools: [makeTool('shell')],
        config: createDefaultConfig('mock:test'),
      },
    )

    expect(results).toHaveLength(3)
    results.forEach(r => {
      expect(r.content).toBeTruthy()
      expect(r.turnCount).toBe(1)
    })
  })
})

describe('pipeline', () => {
  it('chains agent outputs to inputs', async () => {
    const inputs: string[] = []

    mockLoop.mockImplementation(async function* (params) {
      // Capture the user message input
      const userMsg = params.messages.find(m => m.role === 'user')
      if (userMsg && typeof userMsg.content === 'string') {
        inputs.push(userMsg.content)
      }

      yield {
        type: 'session.start' as const,
        sessionId: 'test',
        model: 'mock',
        timestamp: Date.now(),
      }

      return makeLoopResult(`Processed: ${typeof userMsg?.content === 'string' ? userMsg.content : ''}`)
    })

    const result = await pipeline(
      [
        { name: 'step-1' },
        { name: 'step-2' },
      ],
      'initial input',
      {
        provider: createMockProvider(),
        tools: [],
        config: createDefaultConfig('mock:test'),
      },
    )

    expect(result.content).toBeTruthy()
    // First agent should have received "initial input"
    expect(inputs[0]).toBe('initial input')
    // Second agent should have received output from first
    expect(inputs[1]).toContain('Processed')
  })
})

describe('mapReduce', () => {
  it('fans out then reduces', async () => {
    let callNum = 0
    mockLoop.mockImplementation(async function* () {
      callNum++
      yield {
        type: 'session.start' as const,
        sessionId: `test-${callNum}`,
        model: 'mock',
        timestamp: Date.now(),
      }
      return makeLoopResult(`Output ${callNum}`)
    })

    const result = await mapReduce(
      [{ name: 'mapper-1' }, { name: 'mapper-2' }],
      { name: 'reducer' },
      {
        provider: createMockProvider(),
        tools: [],
        config: createDefaultConfig('mock:test'),
      },
    )

    expect(result.content).toBeTruthy()
    // Should have called loop 3 times: 2 mappers + 1 reducer
    expect(callNum).toBe(3)
  })
})
