/**
 * Tool Test: Agent Spawn
 *
 * Tests the agent_spawn tool directly — spawning sub-agents,
 * background mode, and error cases.
 */

import { describe, it, expect, afterEach } from 'vitest'
import {
  createTestSession,
  type TestSession,
  assertStreamCompleted,
  assertToolCalled,
  assertToolSucceeded,
  assertToolFailed,
  assertHasEvent,
  assertHasUsage,
  calculatorTool,
} from '../harness/index.js'

const HAS_KEY = !!process.env['ANTHROPIC_API_KEY']

describe.skipIf(!HAS_KEY)('Tool: Agent Spawn', () => {
  let ts: TestSession

  afterEach(async () => {
    if (ts) await ts.cleanup()
  })

  it('agent_spawn unavailable when spawner not configured', async () => {
    ts = await createTestSession({
      tools: 'full',
      maxTurns: 3,
      maxTokens: 256,
      enableAgentSpawning: false, // spawner NOT attached
    })

    const stream = await ts.run(
      'Use the agent_spawn tool to create a helper named "test" with prompt "Say hello". ' +
      'If it fails, explain why.',
    )

    assertStreamCompleted(stream)
    assertToolCalled(stream, 'agent_spawn')
    assertToolFailed(stream, 'agent_spawn')

    // Should get the "not available" error
    const calls = stream.tools().filter(t => t.toolName === 'agent_spawn')
    expect(calls.some(c => c.result.includes('not available'))).toBe(true)
  }, 60_000)

  it('agent_spawn works when spawner is configured', async () => {
    ts = await createTestSession({
      model: 'anthropic:claude-sonnet-4-20250514',
      tools: [calculatorTool],
      systemPrompt:
        'You are a delegation assistant. Your ONLY job is to delegate tasks to sub-agents using agent_spawn. ' +
        'You must NEVER use any other tool directly. ALWAYS use agent_spawn to delegate work.',
      maxTurns: 5,
      maxTokens: 512,
      enableAgentSpawning: true,
      recordFixtures: true,
    })

    const stream = await ts.run(
      'Use agent_spawn to create a sub-agent named "calc-helper" with prompt: ' +
      '"Use the calculate tool to compute 9 * 11 and tell me the answer." ' +
      'Report what it found.',
    )

    ts.recordFixture('tool-agent-spawn', stream, {
      prompt: 'Spawn calc-helper sub-agent',
      tools: 'calculator + agent_spawn',
      expectedBehavior: 'agent_spawn succeeds, sub-agent computes 99',
    })

    assertStreamCompleted(stream)
    assertToolCalled(stream, 'agent_spawn')

    // The agent_spawn tool returns the sub-agent's result as its tool result.
    // For non-inline (isolated) mode, agent.spawn/agent.complete events are
    // collected on the handle. The parent stream sees tool.call.start/end.
    const spawnCalls = stream.tools().filter(t => t.toolName === 'agent_spawn')
    expect(spawnCalls.length).toBeGreaterThanOrEqual(1)
    // The spawn call should NOT be an error (spawner is configured)
    expect(spawnCalls[0]!.isError).toBe(false)

    assertHasUsage(stream)
  }, 120_000)

  it('background agent returns immediately', async () => {
    ts = await createTestSession({
      model: 'anthropic:claude-sonnet-4-20250514',
      tools: [calculatorTool],
      systemPrompt:
        'You are a delegation assistant. Your ONLY job is to delegate tasks using agent_spawn. ' +
        'NEVER use any other tool directly. When told to use background mode, set background=true.',
      maxTurns: 5,
      maxTokens: 512,
      enableAgentSpawning: true,
    })

    const stream = await ts.run(
      'Use agent_spawn with background=true to create a sub-agent named "bg-worker" ' +
      'with prompt: "Calculate 5 + 5." Report that it was launched.',
    )

    assertStreamCompleted(stream)
    assertToolCalled(stream, 'agent_spawn')

    // Background spawn should succeed
    const calls = stream.tools().filter(t => t.toolName === 'agent_spawn')
    expect(calls.length).toBeGreaterThanOrEqual(1)

    // At least one should have returned with background=true metadata
    const bgCall = calls.find(c => c.result.includes('background') || c.result.includes('launched'))
    expect(bgCall).toBeTruthy()
  }, 60_000)
})
