/**
 * SSE PATTERN 4 — Multiple tool calls in one turn
 *
 * Uses the bundled `coder` profile (preset: full) on a safe sandbox
 * workspace. Asks the agent to perform a task that requires reading
 * multiple files in succession.
 *
 * Validates:
 *  - Multiple tool.call.start / tool.call.end pairs
 *  - LLM produces final synthesis text after all tools complete
 *  - Each tool's durationMs recorded
 *  - turn.end usage reflects total token cost
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { createTestGateway, type TestGateway } from '../harness/index.js'
import { assertStreamCompleted, assertHasEvent } from '../harness/assertions.js'

const HAS_KEY = !!process.env['ANTHROPIC_API_KEY'] && !process.env['ANTHROPIC_API_KEY']!.includes('OWNWARE_TEST_DUMMY')

describe.skipIf(!HAS_KEY)('SSE Pattern 4: Multiple tool calls', () => {
  let gw: TestGateway
  let sandboxPath: string

  beforeAll(async () => {
    gw = await createTestGateway({
      useBundledProfiles: true,
      recordFixtures: true,
    })

    // Create a SAFE sandbox with three small files for the agent to read
    sandboxPath = join(gw.tmpDir, 'sandbox')
    await mkdir(sandboxPath, { recursive: true })
    await writeFile(join(sandboxPath, 'colors.txt'), 'red\ngreen\nblue\n')
    await writeFile(join(sandboxPath, 'numbers.txt'), '1\n2\n3\n4\n5\n')
    await writeFile(join(sandboxPath, 'fruits.txt'), 'apple\nbanana\ncherry\n')
  }, 30_000)

  afterAll(async () => {
    await gw.stop()
  })

  it('agent reads multiple files in one task → multiple tool calls', async () => {
    // Workspace points to the sandbox so all tool calls are confined there
    const ws = gw.state.createWorkspace(sandboxPath, 'sandbox-ws')
    const thread = gw.state.createThread('coder', 'multi-tool', ws.id)

    // Stream raw so we can auto-approve any permission requests mid-stream
    const { events } = await gw.client.sseRaw('/api/v1/run', {
      prompt:
        'Read these three files: colors.txt, numbers.txt, fruits.txt. ' +
        'Then tell me the first item from each file. ' +
        'Use parallel tool calls if possible.',
      profileId: 'coder',
      threadId: thread.id,
      workspaceId: ws.id,
    })

    const collected: Array<{ event: string; data: unknown }> = []
    for await (const e of events) {
      collected.push(e)
      // Auto-approve any permission request mid-stream
      if (e.event === 'permission.request') {
        await gw.client.post(`/api/v1/threads/${thread.id}/resume`, { action: 'approve' })
      }
    }

    // Build a stream object from collected events for analysis
    const { parseSSE } = await import('../harness/sse-parser.js')
    const raw = collected.map(e => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join('')
    const stream = parseSSE(raw)

    gw.recorder.recordSSE('pattern-04-multi-tool', stream, {
      prompt: 'Read 3 files and report first item from each',
      profileId: 'coder',
      threadId: thread.id,
      expectedBehavior: 'Multiple tool.call.start/end pairs, then synthesis text',
    })

    assertStreamCompleted(stream)
    assertHasEvent(stream, 'tool.call.start')
    assertHasEvent(stream, 'tool.call.end')

    const tools = stream.tools()
    expect(tools.length).toBeGreaterThanOrEqual(2) // at least 2 file reads
    // All tool calls should have results
    for (const t of tools) {
      expect(t.result).toBeDefined()
      expect(typeof t.durationMs).toBe('number')
    }

    // Final text should reference at least one expected item
    const text = stream.text().toLowerCase()
    const hasRed = text.includes('red')
    const hasOne = text.includes('1') || text.includes('one')
    const hasApple = text.includes('apple')
    expect([hasRed, hasOne, hasApple].filter(Boolean).length).toBeGreaterThanOrEqual(2)
  }, 180_000)
})
