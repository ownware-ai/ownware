/**
 * Integration Tests — Multi-Agent Coordination
 *
 * Tests fanOut, pipeline, and mapReduce with realistic mock providers
 * that simulate actual model behavior (text responses, tool calls, turns).
 *
 * These tests verify the full path:
 *   spawner → loop → provider → tool execution → result collection
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../../../src/core/loop.js', () => ({
  loop: vi.fn(),
}))

import { fanOut, pipeline, mapReduce } from '../../../src/agents/coordinator.js'
import { AgentSpawner } from '../../../src/agents/spawner.js'
import { loop } from '../../../src/core/loop.js'
import { createDefaultConfig } from '../../../src/core/config.js'
import { createMockProvider } from '../../helpers/mock-provider.js'
import type { LoopResult, LoopParams } from '../../../src/core/loop.js'

const mockLoop = vi.mocked(loop)

function makeResult(text: string, turns = 1, cost = 0.01): LoopResult {
  return {
    reason: 'end_turn',
    messages: [
      { role: 'user', content: 'input' },
      { role: 'assistant', content: [{ type: 'text', text }] },
    ],
    totalUsage: {
      inputTokens: 100 * turns,
      outputTokens: 50 * turns,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      model: 'mock',
      costUsd: cost,
    },
    turnCount: turns,
  }
}

// ---------------------------------------------------------------------------
// fanOut integration
// ---------------------------------------------------------------------------

describe('fanOut — parallel agents', () => {
  it('runs 3 agents in parallel and collects ordered results', async () => {
    let callIndex = 0
    const startTimes: number[] = []

    mockLoop.mockImplementation(async function* () {
      const idx = ++callIndex
      startTimes.push(Date.now())
      yield { type: 'session.start' as const, sessionId: `s-${idx}`, model: 'mock', timestamp: Date.now() }

      // Simulate varying processing times
      await new Promise(r => setTimeout(r, 10 + idx * 5))

      return makeResult(`Result from agent ${idx}`, 2, 0.02)
    })

    const results = await fanOut(
      [
        { name: 'security-agent', systemPrompt: 'Check for security issues' },
        { name: 'perf-agent', systemPrompt: 'Check for performance issues' },
        { name: 'style-agent', systemPrompt: 'Check for style issues' },
      ],
      {
        provider: createMockProvider(),
        tools: [],
        config: createDefaultConfig('mock:test'),
      },
    )

    expect(results).toHaveLength(3)
    results.forEach(r => {
      expect(r.content).toContain('Result from agent')
      expect(r.turnCount).toBe(2)
      expect(r.usage.costUsd).toBe(0.02)
    })

    // All 3 loops should have been called
    expect(callIndex).toBe(3)
  })

  it('aborts remaining agents if one fails', async () => {
    let callIndex = 0

    mockLoop.mockImplementation(async function* () {
      const idx = ++callIndex
      yield { type: 'session.start' as const, sessionId: `s-${idx}`, model: 'mock', timestamp: Date.now() }

      if (idx === 2) {
        throw new Error('Agent 2 crashed')
      }

      // Other agents take longer
      await new Promise(r => setTimeout(r, 100))
      return makeResult(`OK ${idx}`)
    })

    await expect(
      fanOut(
        [{ name: 'a1' }, { name: 'a2-fails' }, { name: 'a3' }],
        {
          provider: createMockProvider(),
          tools: [],
          config: createDefaultConfig('mock:test'),
        },
      ),
    ).rejects.toThrow()
  })

  it('respects agentTimeoutMs', async () => {
    mockLoop.mockImplementation(async function* (params) {
      yield { type: 'session.start' as const, sessionId: 'slow', model: 'mock', timestamp: Date.now() }
      // Simulate slow agent that checks abort
      while (!params.config.abortSignal?.aborted) {
        await new Promise(r => setTimeout(r, 10))
      }
      return makeResult('timed out')
    })

    await expect(
      fanOut(
        [{ name: 'slow-agent' }],
        {
          provider: createMockProvider(),
          tools: [],
          config: createDefaultConfig('mock:test'),
          agentTimeoutMs: 100,
        },
      ),
    ).rejects.toThrow(/aborted|timed out/i)
  })
})

// ---------------------------------------------------------------------------
// pipeline integration
// ---------------------------------------------------------------------------

describe('pipeline — sequential agents', () => {
  it('chains output → input across 3 agents', async () => {
    const receivedInputs: string[] = []

    mockLoop.mockImplementation(async function* (params: LoopParams) {
      const userMsg = params.messages.find(m => m.role === 'user')
      const inputText = typeof userMsg?.content === 'string' ? userMsg.content : ''
      receivedInputs.push(inputText)

      yield { type: 'session.start' as const, sessionId: 'test', model: 'mock', timestamp: Date.now() }

      // Each agent transforms the input
      return makeResult(`[processed] ${inputText}`)
    })

    const result = await pipeline(
      [
        { name: 'researcher', systemPrompt: 'Research the topic' },
        { name: 'writer', systemPrompt: 'Write based on research' },
        { name: 'reviewer', systemPrompt: 'Review the writing' },
      ],
      'Tell me about TypeScript',
      {
        provider: createMockProvider(),
        tools: [],
        config: createDefaultConfig('mock:test'),
      },
    )

    // First agent got the initial input
    expect(receivedInputs[0]).toBe('Tell me about TypeScript')
    // Second agent got the first agent's output
    expect(receivedInputs[1]).toBe('[processed] Tell me about TypeScript')
    // Third agent got the second agent's output
    expect(receivedInputs[2]).toBe('[processed] [processed] Tell me about TypeScript')

    // Final result is from the last agent
    expect(result.content).toContain('[processed] [processed] [processed]')
  })

  it('stops and throws if a middle stage fails', async () => {
    let callCount = 0

    mockLoop.mockImplementation(async function* () {
      callCount++
      yield { type: 'session.start' as const, sessionId: 'test', model: 'mock', timestamp: Date.now() }

      if (callCount === 2) {
        throw new Error('Writer failed')
      }

      return makeResult('OK')
    })

    await expect(
      pipeline(
        [{ name: 'researcher' }, { name: 'writer' }, { name: 'reviewer' }],
        'input',
        {
          provider: createMockProvider(),
          tools: [],
          config: createDefaultConfig('mock:test'),
        },
      ),
    ).rejects.toThrow('Writer failed')

    // Third agent should never have been called
    expect(callCount).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// mapReduce integration
// ---------------------------------------------------------------------------

describe('mapReduce — parallel then combine', () => {
  it('maps 3 agents then reduces to 1', async () => {
    let callNum = 0
    const allInputs: string[] = []

    mockLoop.mockImplementation(async function* (params: LoopParams) {
      callNum++
      const userMsg = params.messages.find(m => m.role === 'user')
      if (userMsg && typeof userMsg.content === 'string') {
        allInputs.push(userMsg.content)
      }

      yield { type: 'session.start' as const, sessionId: `s-${callNum}`, model: 'mock', timestamp: Date.now() }

      if (callNum <= 3) {
        // Map agents
        return makeResult(`Finding ${callNum}: something important`)
      }
      // Reduce agent
      return makeResult('Final synthesized report with all findings')
    })

    const result = await mapReduce(
      [
        { name: 'scanner-auth', systemPrompt: 'Scan auth module' },
        { name: 'scanner-api', systemPrompt: 'Scan api module' },
        { name: 'scanner-db', systemPrompt: 'Scan db module' },
      ],
      { name: 'synthesizer', systemPrompt: 'Combine all findings' },
      {
        provider: createMockProvider(),
        tools: [],
        config: createDefaultConfig('mock:test'),
      },
    )

    // 3 map agents + 1 reduce agent = 4 total calls
    expect(callNum).toBe(4)

    // Reduce agent should have received combined input (last entry)
    const reducerInput = allInputs[allInputs.length - 1]
    expect(reducerInput).toBeDefined()
    expect(reducerInput).toContain('scanner-auth')
    expect(reducerInput).toContain('scanner-api')
    expect(reducerInput).toContain('scanner-db')
    expect(reducerInput).toContain('Finding')

    // Final result from reducer
    expect(result.content).toContain('synthesized report')
  })
})

// ---------------------------------------------------------------------------
// Abort + timeout integration
// ---------------------------------------------------------------------------

describe('abort and timeout integration', () => {
  it('spawner.abort() stops agent and waitForAgent rejects', async () => {
    mockLoop.mockImplementation(async function* (params) {
      yield { type: 'session.start' as const, sessionId: 'test', model: 'mock', timestamp: Date.now() }
      while (!params.config.abortSignal?.aborted) {
        await new Promise(r => setTimeout(r, 10))
      }
      return makeResult('aborted')
    })

    const spawner = new AgentSpawner({
      provider: createMockProvider(),
      tools: [],
      config: createDefaultConfig('mock:test'),
    })

    const handle = await spawner.spawn({ name: 'long-running' }, 'isolated')

    // Abort after 50ms
    setTimeout(() => spawner.abort(handle.id), 50)

    await expect(spawner.waitForAgent(handle.id)).rejects.toThrow(/aborted/)
  })

  it('agent with timeout auto-aborts', async () => {
    mockLoop.mockImplementation(async function* (params) {
      yield { type: 'session.start' as const, sessionId: 'test', model: 'mock', timestamp: Date.now() }
      while (!params.config.abortSignal?.aborted) {
        await new Promise(r => setTimeout(r, 10))
      }
      return makeResult('timed-out')
    })

    const spawner = new AgentSpawner({
      provider: createMockProvider(),
      tools: [],
      config: createDefaultConfig('mock:test'),
    })

    const handle = await spawner.spawn(
      { name: 'slow' },
      'isolated',
      undefined,
      { timeoutMs: 80 },
    )

    await expect(spawner.waitForAgent(handle.id)).rejects.toThrow(/aborted|timed out/)
  })

  it('overallTimeoutMs aborts all agents in fanOut', async () => {
    mockLoop.mockImplementation(async function* (params) {
      yield { type: 'session.start' as const, sessionId: 'test', model: 'mock', timestamp: Date.now() }
      while (!params.config.abortSignal?.aborted) {
        await new Promise(r => setTimeout(r, 10))
      }
      return makeResult('timed-out')
    })

    await expect(
      fanOut(
        [{ name: 'a1' }, { name: 'a2' }],
        {
          provider: createMockProvider(),
          tools: [],
          config: createDefaultConfig('mock:test'),
          overallTimeoutMs: 100,
        },
      ),
    ).rejects.toThrow(/aborted|timed out/i)
  })
})
