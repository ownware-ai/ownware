/**
 * Tool Test: Shell Execute
 *
 * Tests shell command execution in sandbox workspace.
 * Validates security boundaries and output capture.
 */

import { describe, it, expect, afterEach } from 'vitest'
import {
  createTestSession,
  type TestSession,
  assertStreamCompleted,
  assertToolCalled,
  assertToolSucceeded,
  assertTextContains,
  assertHasUsage,
} from '../harness/index.js'

const HAS_KEY = !!process.env['ANTHROPIC_API_KEY']

describe.skipIf(!HAS_KEY)('Tool: Shell', () => {
  let ts: TestSession

  afterEach(async () => {
    if (ts) await ts.cleanup()
  })

  it('executes safe read-only commands', async () => {
    ts = await createTestSession({
      tools: 'coding',
      maxTurns: 3,
      maxTokens: 256,
    })

    await ts.sandbox!.seedProject()

    const stream = await ts.run(
      `Run the shell command "ls" in the directory ${ts.sandbox!.path} and tell me what files you see.`,
    )

    assertStreamCompleted(stream)

    // Should have called shell_execute or bash
    const tools = stream.tools()
    const shellCall = tools.find(t =>
      t.toolName === 'shell_execute' || t.toolName === 'bash',
    )
    expect(shellCall).toBeTruthy()
    expect(shellCall!.isError).toBe(false)

    // Output should include known files
    assertTextContains(stream, 'package.json')
    assertHasUsage(stream)
  }, 60_000)

  it('captures command output correctly', async () => {
    ts = await createTestSession({
      tools: 'coding',
      maxTurns: 3,
      maxTokens: 256,
    })

    await ts.sandbox!.writeFile('count.txt', 'line1\nline2\nline3\n')

    const stream = await ts.run(
      `Run "wc -l ${ts.sandbox!.path}/count.txt" and tell me the line count.`,
    )

    assertStreamCompleted(stream)
    assertTextContains(stream, '3')
  }, 60_000)
})
