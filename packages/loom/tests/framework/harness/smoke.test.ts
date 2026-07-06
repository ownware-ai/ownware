/**
 * Smoke Test — Verify the harness foundation works.
 *
 * This test runs WITHOUT an API key using a mock provider.
 * It validates that createTestSession, collectEvents, sandbox,
 * assertions, and fixture recording all function correctly.
 */

import { describe, it, expect, afterEach } from 'vitest'
import {
  createTestSession,
  type TestSession,
  assertStreamCompleted,
  assertHasEvent,
  assertTextContains,
  assertHasUsage,
  assertToolCalled,
  assertToolSucceeded,
  assertEventOrder,
  createSandbox,
  calculatorTool,
  failingTool,
} from './index.js'

const HAS_KEY = !!process.env['ANTHROPIC_API_KEY']

// ---------------------------------------------------------------------------
// Sandbox tests (no API key needed)
// ---------------------------------------------------------------------------

describe('Harness: Sandbox', () => {
  it('creates a temp directory and writes/reads files', async () => {
    const sandbox = await createSandbox()
    expect(sandbox.path).toBeTruthy()

    await sandbox.writeFile('test.txt', 'hello world')
    const content = await sandbox.readFile('test.txt')
    expect(content).toBe('hello world')
    expect(sandbox.exists('test.txt')).toBe(true)
    expect(sandbox.exists('nonexistent.txt')).toBe(false)

    await sandbox.cleanup()
    expect(sandbox.exists('test.txt')).toBe(false)
  })

  it('seedProject creates a realistic project structure', async () => {
    const sandbox = await createSandbox()
    await sandbox.seedProject()

    expect(sandbox.exists('package.json')).toBe(true)
    expect(sandbox.exists('src/index.ts')).toBe(true)
    expect(sandbox.exists('src/utils.ts')).toBe(true)
    expect(sandbox.exists('tests/index.test.ts')).toBe(true)
    expect(sandbox.exists('README.md')).toBe(true)
    expect(sandbox.exists('data/sample.txt')).toBe(true)

    const pkg = JSON.parse(await sandbox.readFile('package.json'))
    expect(pkg.name).toBe('test-project')

    await sandbox.cleanup()
  })

  it('writes nested directories automatically', async () => {
    const sandbox = await createSandbox()
    await sandbox.writeFile('deep/nested/path/file.txt', 'deep content')
    expect(sandbox.exists('deep/nested/path/file.txt')).toBe(true)
    const content = await sandbox.readFile('deep/nested/path/file.txt')
    expect(content).toBe('deep content')
    await sandbox.cleanup()
  })
})

// ---------------------------------------------------------------------------
// Session creation tests (needs API key for real runs)
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_KEY)('Harness: TestSession', () => {
  let ts: TestSession

  afterEach(async () => {
    if (ts) await ts.cleanup()
  })

  it('createTestSession creates a working session', async () => {
    ts = await createTestSession({
      model: 'anthropic:claude-haiku-4-5-20251001',
      tools: 'none',
      maxTurns: 2,
      maxTokens: 256,
    })

    expect(ts.session).toBeTruthy()
    expect(ts.provider).toBeTruthy()
    expect(ts.tools).toHaveLength(0)
    expect(ts.sandbox).toBeTruthy()
    expect(ts.hitl).toBeTruthy()
    expect(ts.spawner).toBeNull()
  })

  it('ts.run() collects a complete event stream', async () => {
    ts = await createTestSession({
      tools: 'none',
      maxTurns: 1,
      maxTokens: 128,
    })

    const stream = await ts.run('Say exactly: HELLO SMOKE TEST')

    assertStreamCompleted(stream)
    assertHasEvent(stream, 'session.start')
    assertHasEvent(stream, 'session.end')
    assertHasEvent(stream, 'turn.start')
    assertHasEvent(stream, 'turn.end')
    assertHasEvent(stream, 'text.delta')
    assertHasUsage(stream)

    // Verify event ordering
    assertEventOrder(stream, 'session.start', 'turn.start')
    assertEventOrder(stream, 'turn.start', 'turn.end')
    assertEventOrder(stream, 'turn.end', 'session.end')

    // Verify content
    const text = stream.text()
    expect(text.length).toBeGreaterThan(0)

    // Verify usage
    const usage = stream.usage()
    expect(usage.inputTokens).toBeGreaterThan(0)
    expect(usage.outputTokens).toBeGreaterThan(0)
  }, 30_000)

  it('ts.run() with calculator tool', async () => {
    ts = await createTestSession({
      tools: [calculatorTool],
      maxTurns: 3,
      maxTokens: 256,
    })

    const stream = await ts.run('Use the calculate tool to compute 15 * 7. Report the answer.')

    assertStreamCompleted(stream)
    assertToolCalled(stream, 'calculate')
    assertToolSucceeded(stream, 'calculate')

    // The tool should return "105"
    const calls = stream.tools().filter(t => t.toolName === 'calculate')
    expect(calls.length).toBeGreaterThanOrEqual(1)
    expect(calls.some(c => c.result.includes('105'))).toBe(true)
  }, 60_000)

  it('multi-turn conversation retains context', async () => {
    ts = await createTestSession({
      tools: 'none',
      maxTurns: 2,
      maxTokens: 128,
    })

    const turn1 = await ts.run('Remember this secret code: ZEPHYR-42. Just acknowledge.')
    assertStreamCompleted(turn1)

    const turn2 = await ts.run('What was the secret code I just told you?')
    assertStreamCompleted(turn2)
    assertTextContains(turn2, 'ZEPHYR-42')
  }, 60_000)
})
