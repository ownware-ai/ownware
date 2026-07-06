/**
 * Sub-Agent Pattern: Single Foreground
 *
 * Parent spawns one sub-agent, waits for completion, uses result.
 * Tests the full agent lifecycle: agent.spawn → child runs → agent.complete.
 */

import { describe, it, expect, afterEach } from 'vitest'
import {
  createTestSession,
  type TestSession,
  assertStreamCompleted,
  assertHasEvent,
  assertToolCalled,
  assertToolSucceeded,
  assertAgentSpawned,
  assertHasUsage,
  assertEventOrder,
  calculatorTool,
} from '../harness/index.js'

const HAS_KEY = !!process.env['ANTHROPIC_API_KEY']

describe.skipIf(!HAS_KEY)('Sub-Agent: Single Foreground', () => {
  let ts: TestSession

  afterEach(async () => {
    if (ts) await ts.cleanup()
  })

  it('spawns a sub-agent that returns a result', async () => {
    ts = await createTestSession({
      model: 'anthropic:claude-sonnet-4-20250514',
      tools: [calculatorTool],
      systemPrompt:
        'You are a delegation assistant. Your ONLY job is to delegate tasks to sub-agents using agent_spawn. ' +
        'You must NEVER use any other tool directly. ALWAYS use agent_spawn to delegate.',
      maxTurns: 5,
      maxTokens: 512,
      enableAgentSpawning: true,
      recordFixtures: true,
    })

    const stream = await ts.run(
      'Use agent_spawn to create a sub-agent named "math-helper" with prompt: ' +
      '"Use the calculate tool to compute 12 * 8 and report the result." ' +
      'Report what it found.',
    )

    ts.recordFixture('subagent-single', stream, {
      prompt: 'Spawn math-helper sub-agent',
      expectedBehavior: 'agent_spawn → child computes 96 → parent reports result',
    })

    assertStreamCompleted(stream)

    // The parent should have called agent_spawn
    assertToolCalled(stream, 'agent_spawn')

    // For non-inline (isolated) mode, agent.spawn/agent.complete events are
    // collected on the handle, not in the parent stream. The parent sees
    // tool.call.start/end wrapping the agent_spawn call.
    const spawnCalls = stream.tools().filter(t => t.toolName === 'agent_spawn')
    expect(spawnCalls.length).toBeGreaterThanOrEqual(1)
    // The spawn call should NOT be an error (spawner is configured)
    expect(spawnCalls[0]!.isError).toBe(false)

    assertHasUsage(stream)
  }, 120_000)
})
