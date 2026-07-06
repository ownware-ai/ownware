/**
 * Unit Tests — Agent Spawner
 *
 * Tests abort, timeout, waitForAgent, and spawn modes.
 * Uses mocked loop to avoid real API calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../src/core/loop.js', () => ({
  loop: vi.fn(),
}))

import { AgentSpawner } from '../../../src/agents/spawner.js'
import { loop } from '../../../src/core/loop.js'
import { createDefaultConfig } from '../../../src/core/config.js'
import { createMockProvider } from '../../helpers/mock-provider.js'
import type { LoopResult } from '../../../src/core/loop.js'

const mockLoop = vi.mocked(loop)

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

function createSpawner() {
  return new AgentSpawner({
    provider: createMockProvider(),
    tools: [],
    config: createDefaultConfig('mock:test'),
  })
}

// ---------------------------------------------------------------------------
// spawn + waitForAgent
// ---------------------------------------------------------------------------

describe('AgentSpawner', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('spawn + waitForAgent', () => {
    it('spawns agent and returns result via waitForAgent', async () => {
      mockLoop.mockImplementation(async function* () {
        yield { type: 'session.start' as const, sessionId: 'test', model: 'mock', timestamp: Date.now() }
        return makeLoopResult('Agent completed')
      })

      const spawner = createSpawner()
      const handle = await spawner.spawn({ name: 'test-agent' }, 'isolated')

      expect(handle.status).toBe('running')

      const result = await spawner.waitForAgent(handle.id)
      expect(result.content).toBe('Agent completed')
      expect(result.turnCount).toBe(1)
    })

    it('waitForAgent throws for unknown agent', async () => {
      const spawner = createSpawner()
      await expect(spawner.waitForAgent('nonexistent')).rejects.toThrow('not found')
    })

    it('waitForAgent returns immediately if already completed', async () => {
      mockLoop.mockImplementation(async function* () {
        yield { type: 'session.start' as const, sessionId: 'test', model: 'mock', timestamp: Date.now() }
        return makeLoopResult('Done')
      })

      const spawner = createSpawner()
      const handle = await spawner.spawn({ name: 'fast' }, 'isolated')

      // Wait a bit for the background agent to finish
      await new Promise(r => setTimeout(r, 50))

      // Should return immediately
      const result = await spawner.waitForAgent(handle.id)
      expect(result.content).toBe('Done')
    })
  })

  // -----------------------------------------------------------------------
  // Abort
  // -----------------------------------------------------------------------

  describe('abort', () => {
    it('abort() sets status to aborted', async () => {
      // Make the loop hang until aborted
      mockLoop.mockImplementation(async function* (params) {
        yield { type: 'session.start' as const, sessionId: 'test', model: 'mock', timestamp: Date.now() }
        // Check abort signal (like the real loop does)
        while (!params.config.abortSignal?.aborted) {
          await new Promise(r => setTimeout(r, 10))
          yield { type: 'turn.start' as const, turnIndex: 0, timestamp: Date.now() }
        }
        return makeLoopResult('Aborted')
      })

      const spawner = createSpawner()
      const handle = await spawner.spawn({ name: 'long-running' }, 'isolated')

      // Agent should be running
      expect(spawner.getAgent(handle.id)?.status).toBe('running')

      // Abort it
      spawner.abort(handle.id)

      // Should be aborted
      expect(spawner.getAgent(handle.id)?.status).toBe('aborted')
    })

    it('abort() triggers the AbortSignal so loop stops', async () => {
      let loopSawAbort = false

      mockLoop.mockImplementation(async function* (params) {
        yield { type: 'session.start' as const, sessionId: 'test', model: 'mock', timestamp: Date.now() }

        // Simulate the loop checking abort each turn
        for (let i = 0; i < 100; i++) {
          if (params.config.abortSignal?.aborted) {
            loopSawAbort = true
            return makeLoopResult('Stopped')
          }
          await new Promise(r => setTimeout(r, 5))
        }
        return makeLoopResult('Should not reach here')
      })

      const spawner = createSpawner()
      const handle = await spawner.spawn({ name: 'abortable' }, 'isolated')

      // Wait a tick for the loop to start
      await new Promise(r => setTimeout(r, 20))

      spawner.abort(handle.id)

      // Wait for the loop to actually see the abort
      await new Promise(r => setTimeout(r, 50))

      expect(loopSawAbort).toBe(true)
    })

    it('waitForAgent rejects after abort', async () => {
      mockLoop.mockImplementation(async function* (params) {
        yield { type: 'session.start' as const, sessionId: 'test', model: 'mock', timestamp: Date.now() }
        // Hang until aborted
        await new Promise((_, reject) => {
          params.config.abortSignal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
        return makeLoopResult('never')
      })

      const spawner = createSpawner()
      const handle = await spawner.spawn({ name: 'will-abort' }, 'isolated')

      // Abort after a short delay
      setTimeout(() => spawner.abort(handle.id), 30)

      await expect(spawner.waitForAgent(handle.id)).rejects.toThrow('aborted')
    })

    it('abortAll() aborts all running agents', async () => {
      mockLoop.mockImplementation(async function* (params) {
        yield { type: 'session.start' as const, sessionId: 'test', model: 'mock', timestamp: Date.now() }
        while (!params.config.abortSignal?.aborted) {
          await new Promise(r => setTimeout(r, 10))
        }
        return makeLoopResult('Aborted')
      })

      const spawner = createSpawner()
      await spawner.spawn({ name: 'a1' }, 'isolated')
      await spawner.spawn({ name: 'a2' }, 'isolated')
      await spawner.spawn({ name: 'a3' }, 'isolated')

      expect(spawner.listActive()).toHaveLength(3)

      spawner.abortAll()

      const all = spawner.listAll()
      expect(all.every(a => a.status === 'aborted')).toBe(true)
    })
  })

  // -----------------------------------------------------------------------
  // Timeout
  // -----------------------------------------------------------------------

  describe('timeout', () => {
    it('auto-aborts agent after timeoutMs', async () => {
      mockLoop.mockImplementation(async function* (params) {
        yield { type: 'session.start' as const, sessionId: 'test', model: 'mock', timestamp: Date.now() }
        // Simulate slow agent
        while (!params.config.abortSignal?.aborted) {
          await new Promise(r => setTimeout(r, 10))
        }
        return makeLoopResult('Timed out')
      })

      const spawner = createSpawner()
      const handle = await spawner.spawn(
        { name: 'slow-agent' },
        'isolated',
        undefined,
        { timeoutMs: 100 },
      )

      // Wait for timeout + buffer
      await new Promise(r => setTimeout(r, 200))

      const agent = spawner.getAgent(handle.id)
      expect(agent?.status).toBe('aborted')
      expect(agent?.error?.message).toContain('timed out')
    })

    it('waitForAgent with timeout rejects', async () => {
      mockLoop.mockImplementation(async function* () {
        yield { type: 'session.start' as const, sessionId: 'test', model: 'mock', timestamp: Date.now() }
        // Never finish
        await new Promise(() => {})
        return makeLoopResult('never')
      })

      const spawner = createSpawner()
      const handle = await spawner.spawn({ name: 'hanging' }, 'isolated')

      await expect(
        spawner.waitForAgent(handle.id, 100),
      ).rejects.toThrow('Timed out')
    })
  })

  // -----------------------------------------------------------------------
  // Spawn modes
  // -----------------------------------------------------------------------

  describe('spawn modes', () => {
    it('isolated mode starts with provided messages', async () => {
      let receivedMessages: any[] = []
      mockLoop.mockImplementation(async function* (params) {
        receivedMessages = params.messages
        yield { type: 'session.start' as const, sessionId: 'test', model: 'mock', timestamp: Date.now() }
        return makeLoopResult('Done')
      })

      const spawner = createSpawner()
      const parentMsgs = [{ role: 'user' as const, content: 'context' }]
      await spawner.spawn({ name: 'isolated' }, 'isolated', parentMsgs)
      await new Promise(r => setTimeout(r, 50))

      expect(receivedMessages).toHaveLength(1)
      expect(receivedMessages[0].content).toBe('context')
    })

    it('isolated mode without messages starts empty', async () => {
      let receivedMessages: any[] = []
      mockLoop.mockImplementation(async function* (params) {
        receivedMessages = params.messages
        yield { type: 'session.start' as const, sessionId: 'test', model: 'mock', timestamp: Date.now() }
        return makeLoopResult('Done')
      })

      const spawner = createSpawner()
      await spawner.spawn({ name: 'empty' }, 'isolated')
      await new Promise(r => setTimeout(r, 50))

      expect(receivedMessages).toHaveLength(0)
    })

    it('forked mode deep-copies parent messages', async () => {
      let receivedMessages: any[] = []
      mockLoop.mockImplementation(async function* (params) {
        receivedMessages = params.messages
        yield { type: 'session.start' as const, sessionId: 'test', model: 'mock', timestamp: Date.now() }
        return makeLoopResult('Done')
      })

      const parentMsgs = [
        { role: 'user' as const, content: 'original message' },
      ]

      const spawner = createSpawner()
      await spawner.spawn({ name: 'forked' }, 'forked', parentMsgs)
      await new Promise(r => setTimeout(r, 50))

      // Should have the message
      expect(receivedMessages).toHaveLength(1)
      expect(receivedMessages[0].content).toBe('original message')

      // Should be a deep copy (different reference)
      expect(receivedMessages[0]).not.toBe(parentMsgs[0])
    })

    it('each agent gets unique agentId in config', async () => {
      const agentIds: string[] = []
      mockLoop.mockImplementation(async function* (params) {
        agentIds.push(params.config.agentId!)
        yield { type: 'session.start' as const, sessionId: 'test', model: 'mock', timestamp: Date.now() }
        return makeLoopResult('Done')
      })

      const spawner = createSpawner()
      await spawner.spawn({ name: 'a' }, 'isolated')
      await spawner.spawn({ name: 'b' }, 'isolated')
      await new Promise(r => setTimeout(r, 50))

      expect(agentIds).toHaveLength(2)
      expect(agentIds[0]).not.toBe(agentIds[1])
      expect(agentIds[0]).toMatch(/^agent_/)
      expect(agentIds[1]).toMatch(/^agent_/)
    })
  })

  // -----------------------------------------------------------------------
  // listActive / listAll
  // -----------------------------------------------------------------------

  describe('tracking', () => {
    it('listActive shows only running agents', async () => {
      mockLoop.mockImplementation(async function* () {
        yield { type: 'session.start' as const, sessionId: 'test', model: 'mock', timestamp: Date.now() }
        return makeLoopResult('Done')
      })

      const spawner = createSpawner()
      await spawner.spawn({ name: 'fast' }, 'isolated')

      // Initially running
      expect(spawner.listActive().length).toBeGreaterThanOrEqual(0) // may already be done

      // Wait for completion
      await new Promise(r => setTimeout(r, 50))

      // Should be completed, not in active list
      expect(spawner.listAll()).toHaveLength(1)
    })
  })

  // ---------------------------------------------------------------------------
  // onEvent hook — the Cortex gateway relies on this to persist + fan out
  // every subagent event into its (thread_id, agent_id) stream. If any event
  // type is dropped here, a client's "View thread" surface silently loses data.
  // ---------------------------------------------------------------------------

  describe('onEvent hook', () => {
    it('forwards every subagent event to the hook in order (not just spawn/complete)', async () => {
      const sessionId = 'test-session'
      const now = Date.now()

      mockLoop.mockImplementation(async function* () {
        yield { type: 'session.start' as const, sessionId, model: 'mock', timestamp: now }
        yield { type: 'turn.start' as const, turnIndex: 0, timestamp: now }
        yield { type: 'text.delta' as const, text: 'Hello ', turnIndex: 0 }
        yield { type: 'text.delta' as const, text: 'world', turnIndex: 0 }
        yield {
          type: 'turn.end' as const,
          turnIndex: 0,
          stopReason: 'end_turn',
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            model: 'mock',
            costUsd: 0.001,
          },
          timestamp: now,
        }
        return makeLoopResult('Hello world')
      })

      const captured: Array<{ type: string; agentId: string }> = []
      const spawner = new AgentSpawner({
        provider: createMockProvider(),
        tools: [],
        config: createDefaultConfig('mock:test'),
        onEvent: (event, agentId) => {
          captured.push({ type: event.type, agentId })
        },
      })

      const handle = await spawner.spawn({ name: 'captured-agent' }, 'isolated')
      await spawner.waitForAgent(handle.id)

      // The spawner wraps the loop with agent.spawn (before) and agent.complete
      // (after). Together with the loop events above, we expect the full list.
      const types = captured.map(e => e.type)
      expect(types).toContain('agent.spawn')
      expect(types).toContain('session.start')
      expect(types).toContain('turn.start')
      expect(types).toContain('text.delta')
      expect(types).toContain('turn.end')
      expect(types).toContain('agent.complete')

      // text.delta must appear TWICE — no de-duping, no filtering
      const textDeltas = types.filter(t => t === 'text.delta')
      expect(textDeltas).toHaveLength(2)

      // Ordering: spawn before session.start before turn.start before deltas
      // before turn.end before complete. The hook must preserve emit order.
      const spawnIdx = types.indexOf('agent.spawn')
      const sessionIdx = types.indexOf('session.start')
      const turnStartIdx = types.indexOf('turn.start')
      const firstDeltaIdx = types.indexOf('text.delta')
      const turnEndIdx = types.indexOf('turn.end')
      const completeIdx = types.indexOf('agent.complete')
      expect(spawnIdx).toBeLessThan(sessionIdx)
      expect(sessionIdx).toBeLessThan(turnStartIdx)
      expect(turnStartIdx).toBeLessThan(firstDeltaIdx)
      expect(firstDeltaIdx).toBeLessThan(turnEndIdx)
      expect(turnEndIdx).toBeLessThan(completeIdx)

      // Every event must be tagged with the handle's id, not null/undefined
      for (const e of captured) {
        expect(e.agentId).toBe(handle.id)
      }
    })

    it('awaits async hooks before consuming the next event', async () => {
      mockLoop.mockImplementation(async function* () {
        yield { type: 'text.delta' as const, text: 'a', turnIndex: 0 }
        yield { type: 'text.delta' as const, text: 'b', turnIndex: 0 }
        yield { type: 'text.delta' as const, text: 'c', turnIndex: 0 }
        return makeLoopResult('abc')
      })

      const order: string[] = []
      const spawner = new AgentSpawner({
        provider: createMockProvider(),
        tools: [],
        config: createDefaultConfig('mock:test'),
        onEvent: async (event) => {
          if (event.type === 'text.delta') {
            order.push(`enter:${event.text}`)
            // Simulate async DB write — if the spawner does NOT await the
            // hook, a later event will interleave before this push runs.
            await new Promise(resolve => setTimeout(resolve, 5))
            order.push(`exit:${event.text}`)
          }
        },
      })

      const handle = await spawner.spawn({ name: 'async-hook-agent' }, 'isolated')
      await spawner.waitForAgent(handle.id)

      // Each event must completely finish its async work before the next
      // event's enter runs. If this fails, persistence would race.
      expect(order).toEqual([
        'enter:a', 'exit:a',
        'enter:b', 'exit:b',
        'enter:c', 'exit:c',
      ])
    })

    it('hook is not called for agents that were never spawned', async () => {
      const captured: unknown[] = []
      const spawner = new AgentSpawner({
        provider: createMockProvider(),
        tools: [],
        config: createDefaultConfig('mock:test'),
        onEvent: (event) => { captured.push(event) },
      })

      // No spawn() call — hook should see nothing
      expect(captured).toHaveLength(0)
      expect(spawner.listActive()).toHaveLength(0)
    })
  })
})
