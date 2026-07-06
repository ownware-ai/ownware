/**
 * SSE Pattern 2: Multi-Turn Context Retention
 *
 * Validates that the Session maintains conversation history across
 * multiple submitMessage() calls. Turn 2 must reference Turn 1's context.
 */

import { describe, it, expect, afterEach } from 'vitest'
import {
  createTestSession,
  type TestSession,
  assertStreamCompleted,
  assertTextContains,
  assertHasUsage,
} from '../harness/index.js'

const HAS_KEY = !!process.env['ANTHROPIC_API_KEY']

describe.skipIf(!HAS_KEY)('SSE Pattern 2: Multi-Turn Context', () => {
  let ts: TestSession

  afterEach(async () => {
    if (ts) await ts.cleanup()
  })

  it('second turn recalls first turn context', async () => {
    ts = await createTestSession({
      tools: 'none',
      maxTurns: 2,
      maxTokens: 128,
      recordFixtures: true,
    })

    const turn1 = await ts.run('Remember this code: AMBER-7734. Just acknowledge.')
    ts.recordFixture('02-multi-turn-1', turn1, {
      prompt: 'Remember AMBER-7734',
      expectedBehavior: 'Acknowledges the code',
    })
    assertStreamCompleted(turn1)

    const turn2 = await ts.run('What was the code I told you?')
    ts.recordFixture('02-multi-turn-2', turn2, {
      prompt: 'Recall the code',
      expectedBehavior: 'Returns AMBER-7734',
    })
    assertStreamCompleted(turn2)
    assertTextContains(turn2, 'AMBER-7734')

    // Usage should accumulate across turns
    assertHasUsage(turn1)
    assertHasUsage(turn2)

    // Session state should reflect both turns
    const state = ts.session.getState()
    expect(state.turnCount).toBe(2)
    expect(state.messages.length).toBeGreaterThanOrEqual(4) // 2 user + 2 assistant
  }, 60_000)

  it('three turns build cumulative context', async () => {
    ts = await createTestSession({
      tools: 'none',
      maxTurns: 2,
      maxTokens: 128,
    })

    await ts.run('My name is Alice.')
    await ts.run('My favorite color is blue.')
    const turn3 = await ts.run('What is my name and favorite color?')

    assertStreamCompleted(turn3)
    assertTextContains(turn3, 'Alice')
    assertTextContains(turn3, 'blue')
  }, 90_000)
})
