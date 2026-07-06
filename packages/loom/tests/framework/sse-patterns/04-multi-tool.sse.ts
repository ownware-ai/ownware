/**
 * SSE Pattern 4: Multiple Tool Calls
 *
 * Model calls multiple tools in a single turn (parallel tool calls).
 * Validates tool.call.start/end pairing across concurrent executions.
 */

import { describe, it, expect, afterEach } from 'vitest'
import {
  createTestSession,
  type TestSession,
  assertStreamCompleted,
  assertHasEvent,
  assertToolCalled,
  assertHasUsage,
  calculatorTool,
} from '../harness/index.js'

const HAS_KEY = !!process.env['ANTHROPIC_API_KEY']

describe.skipIf(!HAS_KEY)('SSE Pattern 4: Multiple Tool Calls', () => {
  let ts: TestSession

  afterEach(async () => {
    if (ts) await ts.cleanup()
  })

  it('multiple calculator calls in one turn', async () => {
    ts = await createTestSession({
      model: 'anthropic:claude-sonnet-4-20250514',
      tools: [calculatorTool],
      systemPrompt:
        'You are a tool-use testing assistant. You MUST ALWAYS use the calculate tool for ANY math. ' +
        'NEVER compute math in your head. ALWAYS call the calculate tool. Call it multiple times if needed.',
      maxTurns: 5,
      maxTokens: 512,
      recordFixtures: true,
    })

    const stream = await ts.run(
      'Call the calculate tool THREE separate times with these expressions: "10 + 5", "20 * 3", "100 / 4". ' +
      'Report all three results.',
    )

    ts.recordFixture('04-multi-tool', stream, {
      prompt: 'Three separate calculator calls',
      tools: 'calculator',
      expectedBehavior: '3 tool.call.start/end pairs with results 15, 60, 25',
    })

    assertStreamCompleted(stream)
    assertHasEvent(stream, 'tool.call.start')
    assertHasEvent(stream, 'tool.call.end')
    assertToolCalled(stream, 'calculate')

    // Should have multiple tool calls
    const tools = stream.tools().filter(t => t.toolName === 'calculate')
    expect(tools.length).toBeGreaterThanOrEqual(2)

    // Each tool call must have a unique toolCallId
    const ids = tools.map(t => t.toolCallId)
    const uniqueIds = new Set(ids)
    expect(uniqueIds.size).toBe(ids.length)

    // All should succeed
    expect(tools.every(t => !t.isError)).toBe(true)
    expect(tools.every(t => t.durationMs >= 0)).toBe(true) // May be 0ms for fast sync tools

    assertHasUsage(stream)
  }, 90_000)

  it('read-only tools can execute in parallel', async () => {
    ts = await createTestSession({
      tools: 'readonly',
      maxTurns: 5,
      maxTokens: 512,
    })

    await ts.sandbox!.writeFile('a.txt', 'File A content')
    await ts.sandbox!.writeFile('b.txt', 'File B content')

    const stream = await ts.run(
      `Read both files: ${ts.sandbox!.path}/a.txt and ${ts.sandbox!.path}/b.txt. ` +
      'Report what each one says.',
    )

    assertStreamCompleted(stream)

    // Should have called readFile at least twice
    const readCalls = stream.tools().filter(t => t.toolName === 'readFile')
    expect(readCalls.length).toBeGreaterThanOrEqual(2)
    expect(readCalls.every(t => !t.isError)).toBe(true)
  }, 60_000)
})
