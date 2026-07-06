/**
 * SSE Pattern 9: Permission Deny
 *
 * Tool requires approval → permission.request fires → responder denies
 * → permission.response(granted=false) → tool NOT executed → model recovers.
 */

import { describe, it, expect, afterEach } from 'vitest'
import {
  createTestSession,
  type TestSession,
  assertStreamCompleted,
  assertHasEvent,
  assertPermissionRequested,
  assertHasUsage,
  permissionTool,
} from '../harness/index.js'

const HAS_KEY = !!process.env['ANTHROPIC_API_KEY']

describe.skipIf(!HAS_KEY)('SSE Pattern 9: Permission Deny', () => {
  let ts: TestSession

  afterEach(async () => {
    if (ts) await ts.cleanup()
  })

  it('denied permission blocks tool execution', async () => {
    ts = await createTestSession({
      tools: [permissionTool],
      maxTurns: 5,
      maxTokens: 256,
      permissionMode: 'ask',
      recordFixtures: true,
    })

    const stream = await ts.runWithResponder(
      'Use the write_sensitive tool to write "DENIED_CONTENT". ' +
      'If you cannot, say "permission denied".',
      () => false, // deny all
    )

    ts.recordFixture('09-permission-deny', stream, {
      prompt: 'Write sensitive content — deny',
      expectedBehavior: 'permission.request → deny → tool NOT executed → graceful recovery',
    })

    assertStreamCompleted(stream)

    // Permission events
    assertHasEvent(stream, 'permission.request')
    assertHasEvent(stream, 'permission.response')
    assertPermissionRequested(stream, 'write_sensitive')

    // Permission was denied
    const perms = stream.permissions()
    const writePerm = perms.find(p => p.toolName === 'write_sensitive')!
    expect(writePerm.granted).toBe(false)

    // Tool should have an error result (permission denied)
    const tools = stream.tools()
    const writeCall = tools.find(t => t.toolName === 'write_sensitive')
    if (writeCall) {
      expect(writeCall.isError).toBe(true)
    }

    // Model should recover gracefully
    const text = stream.text().toLowerCase()
    expect(
      text.includes('denied') ||
      text.includes('cannot') ||
      text.includes('permission') ||
      text.includes('not allowed') ||
      text.includes('unable'),
    ).toBe(true)

    assertHasUsage(stream)
  }, 60_000)
})
