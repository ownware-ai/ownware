/**
 * SSE PATTERN 12 — Error recovery
 *
 * Uses the bundled `coder` profile in a sandbox.
 * Asks the agent to read a file that does not exist.
 * Validates:
 *   - tool.call.end with isError: true
 *   - LLM produces follow-up text acknowledging the error
 *   - Stream still completes via `done`
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { createTestGateway, type TestGateway } from '../harness/index.js'
import { assertStreamCompleted, assertHasEvent } from '../harness/assertions.js'
import { parseSSE } from '../harness/sse-parser.js'

const HAS_KEY = !!process.env['ANTHROPIC_API_KEY'] && !process.env['ANTHROPIC_API_KEY']!.includes('OWNWARE_TEST_DUMMY')

describe.skipIf(!HAS_KEY)('SSE Pattern 12: Error recovery', () => {
  let gw: TestGateway
  let sandbox: string
  let wsId: string

  beforeAll(async () => {
    gw = await createTestGateway({
      useBundledProfiles: true,
      recordFixtures: true,
    })
    sandbox = join(gw.tmpDir, 'error-sandbox')
    await mkdir(sandbox, { recursive: true })
    const ws = gw.state.createWorkspace(sandbox, 'error-sandbox')
    wsId = ws.id
  }, 30_000)

  afterAll(async () => {
    await gw.stop()
  })

  it('reading non-existent file → tool error → LLM acknowledges gracefully', async () => {
    const thread = gw.state.createThread('coder', 'error-recovery', wsId)
    const missingFile = join(sandbox, 'this-file-does-not-exist.txt')

    const { events } = await gw.client.sseRaw('/api/v1/run', {
      prompt:
        `Try to read the file ${missingFile}. ` +
        'If the read fails, tell me clearly that the file was not found, then stop.',
      profileId: 'coder',
      threadId: thread.id,
      workspaceId: wsId,
    })

    const collected: Array<{ event: string; data: unknown }> = []
    for await (const e of events) {
      collected.push(e)
      if (e.event === 'permission.request') {
        await gw.client.post(`/api/v1/threads/${thread.id}/resume`, { action: 'approve' })
      }
    }
    const raw = collected.map(e => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join('')
    const stream = parseSSE(raw)

    gw.recorder.recordSSE('pattern-12-error-recovery', stream, {
      prompt: 'Read non-existent file, expect error and graceful recovery',
      profileId: 'coder',
      threadId: thread.id,
      expectedBehavior: 'tool.call.end with isError: true → LLM acknowledges → done',
    })

    assertStreamCompleted(stream)
    assertHasEvent(stream, 'tool.call.start')
    assertHasEvent(stream, 'tool.call.end')

    // At least one tool call should have isError: true
    const tools = stream.tools()
    const errored = tools.filter(t => t.isError === true)
    expect(errored.length).toBeGreaterThanOrEqual(1)

    // The LLM's final text should acknowledge the failure
    const text = stream.text().toLowerCase()
    const acknowledged =
      text.includes('not found') ||
      text.includes("doesn't exist") ||
      text.includes('does not exist') ||
      text.includes('no such file') ||
      text.includes('cannot') ||
      text.includes("couldn't")
    expect(acknowledged).toBe(true)
  }, 240_000)
})
