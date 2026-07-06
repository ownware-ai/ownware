/**
 * SSE Pattern 7: Sub-Agent Parallel
 *
 * Parent spawns multiple sub-agents concurrently.
 * Validates that multiple agent_spawn tool calls are made and all complete.
 */

import { describe, it, expect, afterEach } from 'vitest'
import {
  createTestSession,
  type TestSession,
  assertStreamCompleted,
  assertToolCalled,
  assertHasUsage,
  calculatorTool,
} from '../harness/index.js'

const HAS_KEY = !!process.env['ANTHROPIC_API_KEY']

describe.skipIf(!HAS_KEY)('SSE Pattern 7: Sub-Agent Parallel', () => {
  let ts: TestSession

  afterEach(async () => {
    if (ts) await ts.cleanup()
  })

  it('multiple sub-agents dispatched and all complete', async () => {
    ts = await createTestSession({
      model: 'anthropic:claude-sonnet-4-20250514',
      tools: [calculatorTool],
      systemPrompt:
        'You are a delegation assistant. Use agent_spawn to delegate ALL tasks. ' +
        'When given multiple tasks, spawn a separate agent for EACH task. ' +
        'NEVER use tools directly.',
      maxTurns: 5,
      maxTokens: 1024,
      enableAgentSpawning: true,
      recordFixtures: true,
    })

    const stream = await ts.run(
      'I need two calculations done. Use agent_spawn TWICE — once for each: ' +
      '(1) Agent "adder": "Calculate 100 + 200 using the calculate tool." ' +
      '(2) Agent "multiplier": "Calculate 50 * 3 using the calculate tool." ' +
      'Report both results.',
    )

    ts.recordFixture('07-subagent-parallel', stream, {
      prompt: 'Spawn 2 sub-agents in parallel',
      expectedBehavior: '2 agent_spawn calls, both complete, parent synthesizes',
    })

    assertStreamCompleted(stream)
    assertToolCalled(stream, 'agent_spawn')

    // Should have spawned at least 2 agents
    const spawnCalls = stream.tools().filter(t => t.toolName === 'agent_spawn')
    expect(spawnCalls.length).toBeGreaterThanOrEqual(2)

    // All spawn calls should succeed (not error)
    expect(spawnCalls.every(c => !c.isError)).toBe(true)

    // Each should have a unique toolCallId
    const ids = new Set(spawnCalls.map(c => c.toolCallId))
    expect(ids.size).toBe(spawnCalls.length)

    assertHasUsage(stream)
  }, 180_000)
})
