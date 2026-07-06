/**
 * Tool Test: Filesystem
 *
 * Tests readFile, writeFile, editFile, glob, grep tools
 * against real files in a sandbox workspace.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { join } from 'node:path'
import {
  createTestSession,
  type TestSession,
  assertStreamCompleted,
  assertToolCalled,
  assertToolSucceeded,
  assertTextContains,
  assertHasUsage,
  codingToolSet,
} from '../harness/index.js'

const HAS_KEY = !!process.env['ANTHROPIC_API_KEY']

describe.skipIf(!HAS_KEY)('Tool: Filesystem', () => {
  let ts: TestSession

  afterEach(async () => {
    if (ts) await ts.cleanup()
  })

  it('readFile reads sandbox file content', async () => {
    ts = await createTestSession({
      tools: 'readonly',
      maxTurns: 3,
      maxTokens: 256,
      recordFixtures: true,
    })

    await ts.sandbox!.writeFile('target.txt', 'UNIQUE_CONTENT_12345')

    const stream = await ts.run(
      `Read the file at ${join(ts.sandbox!.path, 'target.txt')} and tell me its exact contents.`,
    )

    ts.recordFixture('tool-filesystem-read', stream, {
      prompt: 'Read target.txt',
      tools: 'readonly',
      expectedBehavior: 'readFile → returns UNIQUE_CONTENT_12345',
    })

    assertStreamCompleted(stream)
    assertToolCalled(stream, 'readFile')
    assertToolSucceeded(stream, 'readFile')
    assertTextContains(stream, 'UNIQUE_CONTENT_12345')
  }, 60_000)

  it('glob finds files by pattern', async () => {
    ts = await createTestSession({
      tools: 'readonly',
      maxTurns: 3,
      maxTokens: 512,
    })

    await ts.sandbox!.seedProject()

    const stream = await ts.run(
      `Use the glob tool to find all .ts files in ${ts.sandbox!.path}. List what you find.`,
    )

    assertStreamCompleted(stream)

    // Should have called glob
    const tools = stream.tools()
    const globCalls = tools.filter(t => t.toolName === 'glob' || t.toolName === 'listFiles')
    expect(globCalls.length).toBeGreaterThanOrEqual(1)
    expect(globCalls.some(c => !c.isError)).toBe(true)

    // Should mention TypeScript files
    const text = stream.text()
    expect(text.includes('index.ts') || text.includes('.ts')).toBe(true)
  }, 60_000)

  it('writeFile creates a new file in sandbox', async () => {
    ts = await createTestSession({
      tools: 'coding',
      maxTurns: 3,
      maxTokens: 256,
      permissionMode: 'allow-all',
    })

    const targetPath = join(ts.sandbox!.path, 'new-file.txt')

    const stream = await ts.run(
      `Write the text "CREATED_BY_AGENT" to the file ${targetPath}`,
    )

    assertStreamCompleted(stream)
    assertToolCalled(stream, 'writeFile')
    assertToolSucceeded(stream, 'writeFile')

    // Verify the file was actually created
    expect(ts.sandbox!.exists('new-file.txt')).toBe(true)
    const content = await ts.sandbox!.readFile('new-file.txt')
    expect(content).toContain('CREATED_BY_AGENT')
  }, 60_000)

  it('grep searches file contents', async () => {
    ts = await createTestSession({
      tools: 'readonly',
      maxTurns: 3,
      maxTokens: 512,
    })

    await ts.sandbox!.seedProject()

    const stream = await ts.run(
      `Use the grep tool to search for "greet" in all files under ${ts.sandbox!.path}. Report the matches.`,
    )

    assertStreamCompleted(stream)
    assertToolCalled(stream, 'grep')
    assertToolSucceeded(stream, 'grep')

    // Should find greet in src/index.ts and tests/index.test.ts
    assertTextContains(stream, 'greet')
    assertHasUsage(stream)
  }, 60_000)
})
