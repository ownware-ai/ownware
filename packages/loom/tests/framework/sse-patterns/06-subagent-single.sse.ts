/**
 * SSE Pattern 6: Sub-Agent Single
 *
 * Validates the event stream when a parent agent spawns a single
 * foreground sub-agent via agent_spawn tool.
 *
 * Event sequence:
 *   tool.call.start(agent_spawn) → tool.call.end(result) → text synthesis
 */

import { describe, it, expect, afterEach } from 'vitest'
import {
  createTestSession,
  type TestSession,
  assertStreamCompleted,
  assertToolCalled,
  assertHasUsage,
  assertEventOrder,
  calculatorTool,
} from '../harness/index.js'

const HAS_KEY = !!process.env['ANTHROPIC_API_KEY']

describe.skipIf(!HAS_KEY)('SSE Pattern 6: Sub-Agent Single', () => {
  let ts: TestSession

  afterEach(async () => {
    if (ts) await ts.cleanup()
  })

  it('foreground sub-agent executes and returns result to parent', async () => {
    ts = await createTestSession({
      model: 'anthropic:claude-sonnet-4-20250514',
      tools: [calculatorTool],
      systemPrompt:
        'You are a delegation assistant. Delegate all tasks to sub-agents using agent_spawn. ' +
        'NEVER use other tools directly.',
      maxTurns: 5,
      maxTokens: 512,
      enableAgentSpawning: true,
      recordFixtures: true,
    })

    const stream = await ts.run(
      'Use agent_spawn to delegate this task: "Calculate 7 * 13 using the calculate tool and report the answer." ' +
      'Name the agent "multiplier". Report what it found.',
    )

    ts.recordFixture('06-subagent-single', stream, {
      prompt: 'Spawn multiplier sub-agent',
      expectedBehavior: 'agent_spawn called → sub-agent runs → parent reports result',
    })

    assertStreamCompleted(stream)
    assertToolCalled(stream, 'agent_spawn')

    // The spawn call should succeed
    const spawnCalls = stream.tools().filter(t => t.toolName === 'agent_spawn')
    expect(spawnCalls.length).toBeGreaterThanOrEqual(1)
    expect(spawnCalls[0]!.isError).toBe(false)

    // tool.call.start should come before tool.call.end
    assertEventOrder(stream, 'tool.call.start', 'tool.call.end')

    // Multiple turns expected: tool call turn + synthesis turn
    expect(stream.turnCount()).toBeGreaterThanOrEqual(2)

    assertHasUsage(stream)
  }, 120_000)
})
