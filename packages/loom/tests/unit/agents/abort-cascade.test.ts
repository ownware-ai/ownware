/**
 * Unit Test — foundation-hardening R2: a parent session "stop" must cascade
 * into a spawned sub-agent.
 *
 * Pre-fix (`spawner.ts:113`): each agent got a fresh, UNLINKED
 * `new AbortController()`. `createLinkedAbortController` (`core/abort.ts:8`)
 * existed but was never used. So hitting "stop" during a foreground sub-agent
 * did nothing — the child ran to its own completion (or was killed only by the
 * 120s agent-tool timeout) and kept spending tokens. The `agent.ts` comment
 * claiming "parent abort propagation via context.signal" was simply false.
 *
 * Post-fix: the agent's controller is linked to `parentConfig.abortSignal`, so
 * aborting the parent synchronously aborts the child's signal, and the child
 * loop unwinds at its next turn/stream boundary.
 *
 * The mocked loop records the abort signal it actually receives, so the test
 * asserts the cascade on the real signal the child loop would check.
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

function makeLoopResult(text: string): LoopResult {
  return {
    reason: 'aborted',
    messages: [{ role: 'assistant', content: [{ type: 'text', text }] }],
    totalUsage: {
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
      cacheCreationTokens: 0, model: 'mock', costUsd: 0,
    },
    turnCount: 1,
  }
}

describe('R2 — parent abort cascades into a spawned sub-agent', () => {
  beforeEach(() => vi.clearAllMocks())

  it("aborting the parent signal aborts the child loop's signal", async () => {
    let childSignal: AbortSignal | undefined

    // The child loop records the signal it was handed, then runs until it sees
    // that signal abort (exactly what the real loop does at its turn boundary).
    mockLoop.mockImplementation(async function* (params) {
      childSignal = params.config.abortSignal ?? undefined
      yield { type: 'session.start' as const, sessionId: 'child', model: 'mock', timestamp: Date.now() }
      while (!params.config.abortSignal?.aborted) {
        await new Promise(r => setTimeout(r, 5))
      }
      return makeLoopResult('child stopped on parent abort')
    })

    const parent = new AbortController()
    const spawner = new AgentSpawner({
      provider: createMockProvider(),
      tools: [],
      config: { ...createDefaultConfig('mock:test'), abortSignal: parent.signal },
    })

    const handle = await spawner.spawn({ name: 'child' }, 'isolated')
    // Let the background child loop start and record its signal.
    await new Promise(r => setTimeout(r, 20))

    try {
      expect(childSignal).toBeDefined()
      // It's a distinct linked controller, not the parent signal passed through.
      expect(childSignal).not.toBe(parent.signal)
      expect(childSignal!.aborted).toBe(false)

      // Hit "stop" on the parent. AbortController.abort() dispatches the
      // 'abort' event synchronously, so the linked child aborts immediately.
      parent.abort()

      // THE cascade assertion (fails pre-fix: an unlinked child stays false).
      expect(childSignal!.aborted).toBe(true)
    } finally {
      // Always stop the child so a pre-fix failure can't leak a running loop.
      spawner.abort(handle.id)
    }

    // The child actually unwinds and the wait resolves (status aborted) rather
    // than hanging for 120s — the orphan the P1 described.
    await spawner.waitForAgent(handle.id).catch(() => { /* throws "aborted" — expected */ })
    expect(spawner.getAgent(handle.id)?.status).toBe('aborted')
  })

  it('a session with no abort signal still spawns (link is a no-op)', async () => {
    // Guards the createLinkedAbortController(undefined) path — non-abortable
    // hosts must keep working exactly as before.
    mockLoop.mockImplementation(async function* () {
      yield { type: 'session.start' as const, sessionId: 'child', model: 'mock', timestamp: Date.now() }
      return makeLoopResult('done')
    })

    const spawner = new AgentSpawner({
      provider: createMockProvider(),
      tools: [],
      config: createDefaultConfig('mock:test'), // no abortSignal
    })

    const handle = await spawner.spawn({ name: 'child' }, 'isolated')
    expect(handle.status).toBe('running')
    await spawner.waitForAgent(handle.id)
    expect(spawner.getAgent(handle.id)?.status).toBe('completed')
  })
})
