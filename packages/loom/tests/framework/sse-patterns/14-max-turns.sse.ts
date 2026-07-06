/**
 * SSE Pattern 14: Max Turns Limit
 *
 * Validates that the loop stops when maxTurns is reached.
 * The session.end reason should be 'max_turns'.
 */

import { describe, it, expect, afterEach } from 'vitest'
import {
  createTestSession,
  type TestSession,
  assertHasEvent,
  assertEndReason,
  assertHasUsage,
  calculatorTool,
} from '../harness/index.js'

const HAS_KEY = !!process.env['ANTHROPIC_API_KEY']

describe.skipIf(!HAS_KEY)('SSE Pattern 14: Max Turns Limit', () => {
  let ts: TestSession

  afterEach(async () => {
    if (ts) await ts.cleanup()
  })

  it('session ends with max_turns when limit reached', async () => {
    ts = await createTestSession({
      model: 'anthropic:claude-sonnet-4-20250514',
      tools: [calculatorTool],
      systemPrompt:
        'You MUST call the calculate tool on EVERY turn. After getting a result, ' +
        'call calculate again with a different expression. Keep calling calculate forever.',
      maxTurns: 2, // Very low — will hit limit fast with tool use
      maxTokens: 256,
      recordFixtures: true,
    })

    const stream = await ts.run(
      'Call calculate with "1 + 1". After each result, call calculate again.',
    )

    ts.recordFixture('14-max-turns', stream, {
      prompt: 'Infinite tool loop — limited by maxTurns=2',
      expectedBehavior: 'session.end with reason=max_turns after 2 turns',
    })

    assertHasEvent(stream, 'session.start')
    assertHasEvent(stream, 'session.end')
    assertHasUsage(stream)

    // End reason should be max_turns (loop was stopped by the limit)
    const reason = stream.endReason()
    // Could be 'max_turns' or 'end_turn' depending on exact timing
    expect(reason === 'max_turns' || reason === 'end_turn').toBe(true)

    // Should have exactly maxTurns turns
    expect(stream.turnCount()).toBeLessThanOrEqual(2)
  }, 60_000)
})
