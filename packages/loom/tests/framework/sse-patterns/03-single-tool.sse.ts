/**
 * SSE Pattern 3: Single Tool Call
 *
 * Model calls one tool, receives the result, and responds.
 * Validates the tool event lifecycle:
 *   turn.start → tool.call.start → tool.call.end → turn.end → (next turn) → text
 */

import { describe, it, expect, afterEach } from 'vitest'
import {
  createTestSession,
  type TestSession,
  assertStreamCompleted,
  assertHasEvent,
  assertToolCalled,
  assertToolSucceeded,
  assertTextContains,
  assertHasUsage,
  assertEventOrder,
  calculatorTool,
} from '../harness/index.js'

const HAS_KEY = !!process.env['ANTHROPIC_API_KEY']

describe.skipIf(!HAS_KEY)('SSE Pattern 3: Single Tool Call', () => {
  let ts: TestSession

  afterEach(async () => {
    if (ts) await ts.cleanup()
  })

  it('calculator tool call produces correct event sequence', async () => {
    ts = await createTestSession({
      model: 'anthropic:claude-sonnet-4-20250514',
      tools: [calculatorTool],
      systemPrompt:
        'You are a tool-use testing assistant. You MUST ALWAYS use the calculate tool for ANY math. ' +
        'NEVER compute math in your head. ALWAYS call the calculate tool. This is a strict requirement.',
      maxTurns: 3,
      maxTokens: 256,
      recordFixtures: true,
    })

    const stream = await ts.run(
      'Call the calculate tool with expression "25 * 4" and report the result.',
    )

    ts.recordFixture('03-single-tool', stream, {
      prompt: 'Calculate 25 * 4',
      tools: 'calculator',
      expectedBehavior: 'tool.call.start(calculate) → tool.call.end(100) → text with 100',
    })

    assertStreamCompleted(stream)

    // Tool events
    assertHasEvent(stream, 'tool.call.start')
    assertHasEvent(stream, 'tool.call.end')
    assertToolCalled(stream, 'calculate')
    assertToolSucceeded(stream, 'calculate')

    // Verify tool result
    const tools = stream.tools()
    const calcCall = tools.find(t => t.toolName === 'calculate')!
    expect(calcCall.result).toContain('100')
    expect(calcCall.isError).toBe(false)
    expect(calcCall.durationMs).toBeGreaterThanOrEqual(0) // May be 0ms for fast sync tools
    expect(calcCall.toolCallId).toBeTruthy()

    // Tool start appears before tool end
    assertEventOrder(stream, 'tool.call.start', 'tool.call.end')

    // The model should report 100 in its text response
    assertTextContains(stream, '100')

    // At least 2 turns (1 for tool call, 1 for response)
    expect(stream.turnCount()).toBeGreaterThanOrEqual(2)

    assertHasUsage(stream)
  }, 60_000)

  it('readFile tool reads from sandbox', async () => {
    ts = await createTestSession({
      tools: 'readonly',
      maxTurns: 3,
      maxTokens: 256,
    })

    // Seed a file to read
    await ts.sandbox!.writeFile('test-read.txt', 'CONTENTS_FROM_SANDBOX_FILE')

    const stream = await ts.run(
      `Read the file at ${ts.sandbox!.path}/test-read.txt and tell me what it contains.`,
    )

    assertStreamCompleted(stream)
    assertToolCalled(stream, 'readFile')
    assertToolSucceeded(stream, 'readFile')
    assertTextContains(stream, 'CONTENTS_FROM_SANDBOX_FILE')
  }, 60_000)
})
