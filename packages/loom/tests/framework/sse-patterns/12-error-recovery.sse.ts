/**
 * SSE Pattern 12: Error Recovery
 *
 * A tool returns an error → model receives the error → model adjusts
 * and produces a coherent follow-up response.
 */

import { describe, it, expect, afterEach } from 'vitest'
import {
  createTestSession,
  type TestSession,
  assertStreamCompleted,
  assertToolCalled,
  assertToolFailed,
  assertHasUsage,
  failingTool,
  calculatorTool,
} from '../harness/index.js'

const HAS_KEY = !!process.env['ANTHROPIC_API_KEY']

describe.skipIf(!HAS_KEY)('SSE Pattern 12: Error Recovery', () => {
  let ts: TestSession

  afterEach(async () => {
    if (ts) await ts.cleanup()
  })

  it('model recovers from tool error and responds gracefully', async () => {
    ts = await createTestSession({
      tools: [failingTool, calculatorTool],
      maxTurns: 5,
      maxTokens: 512,
      recordFixtures: true,
    })

    const stream = await ts.run(
      'First try the always_fail tool with message "test error". ' +
      'When it fails, use the calculate tool to compute 7 + 3 instead. Report the result.',
    )

    ts.recordFixture('12-error-recovery', stream, {
      prompt: 'Use failing tool, then recover with calculator',
      tools: 'failing + calculator',
      expectedBehavior: 'always_fail returns error → model uses calculate → reports 10',
    })

    assertStreamCompleted(stream)

    // The failing tool was called and returned an error
    assertToolCalled(stream, 'always_fail')
    assertToolFailed(stream, 'always_fail')

    // The model should have recovered by using the calculator
    assertToolCalled(stream, 'calculate')

    const calcCalls = stream.tools().filter(t => t.toolName === 'calculate')
    expect(calcCalls.some(c => !c.isError)).toBe(true)

    // Multiple turns (at least: tool call turn, error turn, recovery turn)
    expect(stream.turnCount()).toBeGreaterThanOrEqual(2)

    assertHasUsage(stream)
  }, 90_000)
})
