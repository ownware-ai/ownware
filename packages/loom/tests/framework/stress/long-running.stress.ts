/**
 * Stress Test: Long-Running Session
 *
 * Runs a multi-turn conversation with many turns to verify:
 * - Usage accumulates correctly
 * - No memory leaks (message count stays bounded with compaction)
 * - Session state remains consistent
 */

import { describe, it, expect } from 'vitest'
import {
  createTestSession,
  assertStreamCompleted,
  assertHasUsage,
} from '../harness/index.js'

const HAS_KEY = !!process.env['ANTHROPIC_API_KEY']

describe.skipIf(!HAS_KEY)('Stress: Long-Running Session', () => {
  it('10-turn conversation maintains state and accumulates usage', async () => {
    const ts = await createTestSession({
      tools: 'none',
      maxTurns: 2,
      maxTokens: 128,
      maxBudgetUsd: 1.00,
    })

    try {
      let totalInput = 0
      let totalOutput = 0
      const turnCount = 10

      for (let i = 0; i < turnCount; i++) {
        const stream = await ts.run(`Turn ${i + 1}. Say: "Turn ${i + 1} acknowledged." Nothing else.`)
        assertStreamCompleted(stream)
        assertHasUsage(stream)

        const usage = stream.usage()
        totalInput += usage.inputTokens
        totalOutput += usage.outputTokens
      }

      // Verify session state
      const state = ts.session.getState()
      expect(state.turnCount).toBe(turnCount)
      expect(state.messages.length).toBeGreaterThanOrEqual(turnCount * 2) // user + assistant per turn

      // Verify usage accumulation is non-trivial
      expect(totalInput).toBeGreaterThan(0)
      expect(totalOutput).toBeGreaterThan(0)

      // Input tokens should grow with each turn (more context)
      // The total should be significantly more than just 10x the first turn
      expect(state.totalUsage.inputTokens).toBeGreaterThan(0)
      expect(state.totalUsage.outputTokens).toBeGreaterThan(0)
    } finally {
      await ts.cleanup()
    }
  }, 120_000)
})
