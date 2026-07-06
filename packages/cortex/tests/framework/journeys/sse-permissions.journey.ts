/**
 * SSE PATTERNS 8 + 9 + 10 + 11 — Permissions (HITL)
 *
 * Uses the bundled `coder` profile (preset: full, permissionMode: ask).
 * Sandbox workspace ensures all operations are confined to a temp dir.
 *
 * Pattern 8:  Approve mid-stream → tool executes
 * Pattern 9:  Deny mid-stream → tool does not execute, agent recovers
 * Pattern 10: "always" → permission persisted, second run no prompt
 * Pattern 11: Security block (zone NEVER) → hard block, no askable
 *
 * Note: Pattern 11 depends on a tool being in zone NEVER. The default
 * coder profile uses 'standard' security, so writeFile may be in BUILD
 * zone (askable). We test the security.block path indirectly when zones
 * actually block — and otherwise verify the permission flow works.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { createTestGateway, type TestGateway } from '../harness/index.js'
import { assertHasEvent } from '../harness/assertions.js'
import { parseSSE, type SSEStream } from '../harness/sse-parser.js'

const HAS_KEY = !!process.env['ANTHROPIC_API_KEY'] && !process.env['ANTHROPIC_API_KEY']!.includes('OWNWARE_TEST_DUMMY')

interface RunResult {
  stream: SSEStream
  permissionRequests: Array<{ requestId: string; toolName: string }>
}

async function setupSandbox(tmpDir: string): Promise<string> {
  const sandbox = join(tmpDir, 'perm-sandbox')
  await mkdir(sandbox, { recursive: true })
  await writeFile(join(sandbox, 'data.txt'), 'original content\n')
  return sandbox
}

/** Run with a programmable permission responder. */
async function runWithResponder(
  gw: TestGateway,
  threadId: string,
  prompt: string,
  workspaceId: string,
  decide: (req: { toolName: string; requestId: string }) => 'approve' | 'deny' | 'always',
): Promise<RunResult> {
  const { events } = await gw.client.sseRaw('/api/v1/run', {
    prompt,
    profileId: 'coder',
    threadId,
    workspaceId,
  })

  const collected: Array<{ event: string; data: unknown }> = []
  const permissionRequests: Array<{ requestId: string; toolName: string }> = []

  for await (const e of events) {
    collected.push(e)
    if (e.event === 'permission.request') {
      const req = e.data as { requestId: string; toolName: string }
      permissionRequests.push(req)
      const action = decide(req)
      await gw.client.post(`/api/v1/threads/${threadId}/resume`, { action })
    }
  }

  const raw = collected.map(e => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join('')
  return { stream: parseSSE(raw), permissionRequests }
}

describe.skipIf(!HAS_KEY)('SSE Permissions (HITL)', () => {
  let gw: TestGateway
  let sandbox: string
  let wsId: string

  beforeAll(async () => {
    gw = await createTestGateway({
      useBundledProfiles: true,
      recordFixtures: true,
    })
    sandbox = await setupSandbox(gw.tmpDir)
    const ws = gw.state.createWorkspace(sandbox, 'permission-sandbox')
    wsId = ws.id
  }, 30_000)

  afterAll(async () => {
    await gw.stop()
  })

  // ── Pattern 8: HITL approve ────────────────────────────────────────

  it('Pattern 8: approve mid-stream → tool executes', async () => {
    const thread = gw.state.createThread('coder', 'perm-approve', wsId)

    const result = await runWithResponder(
      gw,
      thread.id,
      `Read the file ${join(sandbox, 'data.txt')} and tell me what it says. Then stop.`,
      wsId,
      () => 'approve',
    )

    gw.recorder.recordSSE('pattern-08-permission-approve', result.stream, {
      prompt: 'Read data.txt with auto-approve',
      profileId: 'coder',
      threadId: thread.id,
      expectedBehavior: 'permission.request → approve → tool.call.start → tool.call.end',
    })

    // Either: a permission was requested and approved, OR the tool was
    // already in an allowed zone. Either way the read should succeed.
    if (result.permissionRequests.length > 0) {
      assertHasEvent(result.stream, 'permission.request')
    }
    assertHasEvent(result.stream, 'tool.call.start')
    assertHasEvent(result.stream, 'tool.call.end')

    // Final text should reference the file content
    const text = result.stream.text().toLowerCase()
    expect(text.includes('original') || text.includes('content')).toBe(true)
  }, 240_000)

  // ── Pattern 9: HITL deny ───────────────────────────────────────────
  //
  // With 'standard' security, writeFile is in BUILD zone (Zone 2), which
  // exceeds the maxAutoZone of WORKSPACE (Zone 1). This triggers a
  // permission.request. The responder denies it, so the write is blocked.

  it('Pattern 9: deny mid-stream → write blocked', async () => {
    const thread = gw.state.createThread('coder', 'perm-deny', wsId)
    const targetFile = join(sandbox, 'deny-target.txt')

    const result = await runWithResponder(
      gw,
      thread.id,
      `Try to write the text "FORBIDDEN" to the file ${targetFile}. ` +
        'If you are denied, acknowledge that you cannot do it. Then stop.',
      wsId,
      () => 'deny',
    )

    gw.recorder.recordSSE('pattern-09-permission-deny', result.stream, {
      prompt: 'Write to file — deny permission',
      profileId: 'coder',
      threadId: thread.id,
      expectedBehavior: 'permission.request → deny → write blocked',
    })

    // Permission request should have fired for the write tool
    expect(result.permissionRequests.length).toBeGreaterThan(0)

    // File must NOT exist — the write was denied
    const { existsSync } = await import('node:fs')
    expect(existsSync(targetFile)).toBe(false)
  }, 240_000)

  // ── Pattern 10: "always" → persistence ─────────────────────────────

  it('Pattern 10: "always" persists permission, second run skips prompt', async () => {
    const thread1 = gw.state.createThread('coder', 'perm-always-1', wsId)

    const r1 = await runWithResponder(
      gw,
      thread1.id,
      `Read ${join(sandbox, 'data.txt')} and tell me what it says.`,
      wsId,
      () => 'always',
    )

    gw.recorder.recordSSE('pattern-10-permission-always-1', r1.stream, {
      prompt: 'Read data.txt with always',
      profileId: 'coder',
      threadId: thread1.id,
      expectedBehavior: 'First run: permission.request → always → tool executes',
    })

    // Second run should not need permission for the same tool
    const thread2 = gw.state.createThread('coder', 'perm-always-2', wsId)
    let promptedAgain = 0
    const r2 = await runWithResponder(
      gw,
      thread2.id,
      `Read ${join(sandbox, 'data.txt')} again and tell me what it says.`,
      wsId,
      () => { promptedAgain++; return 'always' },
    )

    gw.recorder.recordSSE('pattern-10-permission-always-2', r2.stream, {
      prompt: 'Second read — should not prompt',
      profileId: 'coder',
      threadId: thread2.id,
      expectedBehavior: 'No permission.request — already approved via "always"',
    })

    // Tool should still execute on the second run
    assertHasEvent(r2.stream, 'tool.call.start')
    // The "always" permission should persist — second run should not prompt
    // for the same tool. Allow 0 prompts (ideal) or prompts for different tools.
    expect(promptedAgain).toBe(0)
  }, 300_000)

  // ── Pattern 11: Security block (zone NEVER) ─────────────────────────
  //
  // Trigger a zone NEVER classification by asking the agent to write to a
  // sensitive path (.env file). The zone classifier should hard-block this
  // with NO permission.request (not askable — permanently forbidden).

  it('Pattern 11: zone NEVER hard-blocks sensitive path writes', async () => {
    const thread = gw.state.createThread('coder', 'perm-never', wsId)
    const sensitiveTarget = join(sandbox, '.env')

    const result = await runWithResponder(
      gw,
      thread.id,
      `Write the text "SECRET_KEY=abc123" to the file ${sensitiveTarget}. ` +
        'If you cannot do it, explain why.',
      wsId,
      () => 'approve', // should never be called — NEVER zone is not askable
    )

    gw.recorder.recordSSE('pattern-11-security-block-never', result.stream, {
      prompt: 'Write to .env file — zone NEVER should hard-block',
      profileId: 'coder',
      threadId: thread.id,
      expectedBehavior: 'security.block or tool.call.end with isError — no permission.request',
    })

    // Zone NEVER should NOT produce a permission.request (it's a hard block)
    const permReqs = result.permissionRequests.filter(
      p => p.toolName === 'writeFile' || p.toolName === 'editFile',
    )
    expect(permReqs.length).toBe(0)

    // The tool should NOT have written the file successfully
    const { existsSync, readFileSync } = await import('node:fs')
    if (existsSync(sensitiveTarget)) {
      const content = readFileSync(sensitiveTarget, 'utf-8')
      expect(content).not.toContain('SECRET_KEY')
    }

    // The model should produce a graceful follow-up explaining it can't
    const text = result.stream.text().toLowerCase()
    expect(
      text.includes('cannot') ||
      text.includes('blocked') ||
      text.includes('denied') ||
      text.includes('not allowed') ||
      text.includes('sensitive') ||
      text.includes('security'),
    ).toBe(true)
  }, 240_000)
})
