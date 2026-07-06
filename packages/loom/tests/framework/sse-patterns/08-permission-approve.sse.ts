/**
 * SSE Pattern 8: Permission Approve
 *
 * Tool requires approval → permission.request fires → responder approves
 * → permission.response(granted=true) → tool executes → result returned.
 */

import { describe, it, expect, afterEach } from 'vitest'
import {
  createTestSession,
  type TestSession,
  assertStreamCompleted,
  assertHasEvent,
  assertToolCalled,
  assertToolSucceeded,
  assertPermissionRequested,
  assertEventOrder,
  assertHasUsage,
  permissionTool,
} from '../harness/index.js'

const HAS_KEY = !!process.env['ANTHROPIC_API_KEY']

describe.skipIf(!HAS_KEY)('SSE Pattern 8: Permission Approve', () => {
  let ts: TestSession

  afterEach(async () => {
    if (ts) await ts.cleanup()
  })

  it('approved permission allows tool execution', async () => {
    ts = await createTestSession({
      tools: [permissionTool],
      maxTurns: 5,
      maxTokens: 256,
      permissionMode: 'ask',
      recordFixtures: true,
    })

    const stream = await ts.runWithResponder(
      'Use the write_sensitive tool to write "APPROVED_CONTENT".',
      () => true, // approve all
    )

    ts.recordFixture('08-permission-approve', stream, {
      prompt: 'Write sensitive content — approve',
      expectedBehavior: 'permission.request → approve → tool executes',
    })

    assertStreamCompleted(stream)

    // Permission events
    assertHasEvent(stream, 'permission.request')
    assertHasEvent(stream, 'permission.response')
    assertPermissionRequested(stream, 'write_sensitive')

    // Permission was granted
    const perms = stream.permissions()
    const writePerm = perms.find(p => p.toolName === 'write_sensitive')!
    expect(writePerm.granted).toBe(true)

    // Tool executed after approval
    assertToolCalled(stream, 'write_sensitive')
    assertToolSucceeded(stream, 'write_sensitive')

    // Ordering: request before response, response before tool.call.end
    assertEventOrder(stream, 'permission.request', 'permission.response')
    assertEventOrder(stream, 'permission.response', 'tool.call.end')

    assertHasUsage(stream)
  }, 60_000)
})
