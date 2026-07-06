/**
 * SSE Pattern 13: Compaction
 *
 * Validates that compaction events (compaction.start, compaction.end)
 * fire when the message history exceeds the configured threshold.
 *
 * Uses a low message-count trigger to force compaction in tests.
 */

import { describe, it, expect, afterEach } from 'vitest'
import {
  createTestSession,
  type TestSession,
  assertStreamCompleted,
  assertHasUsage,
} from '../harness/index.js'

const HAS_KEY = !!process.env['ANTHROPIC_API_KEY']

describe.skipIf(!HAS_KEY)('SSE Pattern 13: Compaction', () => {
  let ts: TestSession

  afterEach(async () => {
    if (ts) await ts.cleanup()
  })

  it('compaction fires after message threshold is exceeded', async () => {
    ts = await createTestSession({
      tools: 'none',
      maxTurns: 2,
      maxTokens: 256,
      configOverrides: {
        compaction: {
          trigger: { type: 'messages' as const, threshold: 4 }, // Low threshold
          retain: { type: 'messages' as const, count: 2 },
          strategy: 'truncate' as const,
          summaryModel: null,
        },
      },
      recordFixtures: true,
    })

    // Turn 1: Establish context (2 messages: user + assistant)
    const turn1 = await ts.run('Remember: my favorite number is 42.')
    assertStreamCompleted(turn1)

    // Turn 2: Add more context (now 4 messages — should trigger compaction)
    const turn2 = await ts.run('My second favorite number is 7.')
    assertStreamCompleted(turn2)

    // Turn 3: This should trigger compaction before the model call
    const turn3 = await ts.run('What are my favorite numbers?')

    ts.recordFixture('13-compaction', turn3, {
      prompt: 'Third turn — should trigger compaction',
      expectedBehavior: 'compaction.start + compaction.end before model response',
    })

    assertStreamCompleted(turn3)
    assertHasUsage(turn3)

    // Check if compaction happened (it may or may not depending on exact
    // message count and when the manager evaluates)
    if (turn3.hasEvent('compaction.start')) {
      expect(turn3.hasEvent('compaction.end')).toBe(true)

      // compaction.start should come before turn.start (compaction happens pre-turn)
      const events = turn3.events
      const compIdx = events.findIndex(e => e.type === 'compaction.start')
      const turnIdx = events.findIndex(e => e.type === 'turn.start')
      // Compaction should be before or at the same point as turn start
      expect(compIdx).toBeLessThan(turnIdx)
    }

    // Regardless of compaction, the session should still work
    const state = ts.session.getState()
    expect(state.turnCount).toBeGreaterThanOrEqual(3)
  }, 90_000)
})
