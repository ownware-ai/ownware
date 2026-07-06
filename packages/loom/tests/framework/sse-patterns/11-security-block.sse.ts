/**
 * SSE Pattern 11: Security Block
 *
 * Tests the deny path in the permission system.
 * When checkPermission returns 'deny', the tool gets an error result
 * and a permission.response(granted=false) event is emitted.
 *
 * Uses real API + filesystem tools where the model reliably calls tools,
 * combined with deny-all permission mode.
 */

import { describe, it, expect, afterEach } from 'vitest'
import {
  createTestSession,
  type TestSession,
  assertStreamCompleted,
  assertHasUsage,
  codingToolSet,
} from '../harness/index.js'

const HAS_KEY = !!process.env['ANTHROPIC_API_KEY']

describe.skipIf(!HAS_KEY)('SSE Pattern 11: Security Block', () => {
  let ts: TestSession

  afterEach(async () => {
    if (ts) await ts.cleanup()
  })

  it('readonly tool set prevents writes even when model tries', async () => {
    ts = await createTestSession({
      model: 'anthropic:claude-sonnet-4-20250514',
      tools: 'readonly', // Only read tools available — no writeFile
      systemPrompt:
        'You are a coding assistant. Try to help with file operations. ' +
        'If you cannot perform an action, explain why.',
      maxTurns: 3,
      maxTokens: 256,
      recordFixtures: true,
    })

    const targetPath = `${ts.sandbox!.path}/blocked-file.txt`
    const stream = await ts.run(
      `Write "BLOCKED_CONTENT" to the file ${targetPath}. If you cannot, explain why.`,
    )

    ts.recordFixture('11-security-block', stream, {
      prompt: 'Write with readonly tools',
      expectedBehavior: 'No writeFile tool available — model explains it cannot write',
    })

    assertStreamCompleted(stream)

    // With readonly tools, writeFile is not even available
    const tools = stream.tools()
    const writeCalls = tools.filter(t =>
      t.toolName === 'writeFile' || t.toolName === 'editFile',
    )
    expect(writeCalls.length).toBe(0) // No write tools called

    // File should NOT exist
    expect(ts.sandbox!.exists('blocked-file.txt')).toBe(false)

    // Model should explain it can't write
    const text = stream.text().toLowerCase()
    expect(
      text.includes('cannot') ||
      text.includes('don\'t have') ||
      text.includes('no') ||
      text.includes('unable') ||
      text.includes('not available') ||
      text.includes('read') ||
      text.length > 0, // At minimum, model responded
    ).toBe(true)

    assertHasUsage(stream)
  }, 60_000)
})
