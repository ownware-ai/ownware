/**
 * Provider Test: OpenAI
 *
 * Tests OpenAI GPT models through Loom's provider adapter.
 * Requires OPENAI_API_KEY environment variable.
 */

import { describe, it, expect, afterEach } from 'vitest'
import {
  createTestSession,
  type TestSession,
  assertStreamCompleted,
  assertHasEvent,
  assertHasUsage,
  assertTextContains,
  assertToolCalled,
  calculatorTool,
} from '../harness/index.js'

const HAS_KEY = !!process.env['OPENAI_API_KEY']

describe.skipIf(!HAS_KEY)('Provider: OpenAI', () => {
  let ts: TestSession

  afterEach(async () => {
    if (ts) await ts.cleanup()
  })

  it('GPT-4o-mini streams text correctly', async () => {
    ts = await createTestSession({
      model: 'openai:gpt-4o-mini',
      tools: 'none',
      maxTurns: 1,
      maxTokens: 128,
    })

    const stream = await ts.run('Say exactly: OPENAI STREAMING TEST')
    assertStreamCompleted(stream)
    assertHasEvent(stream, 'text.delta')
    assertTextContains(stream, 'OPENAI')
    assertHasUsage(stream)
  }, 30_000)

  it('GPT-4o-mini uses tools', async () => {
    ts = await createTestSession({
      model: 'openai:gpt-4o-mini',
      tools: [calculatorTool],
      systemPrompt: 'Always use the calculate tool for math. NEVER compute in your head.',
      maxTurns: 3,
      maxTokens: 256,
    })

    const stream = await ts.run('Use the calculate tool to compute 15 + 27. Report the result.')
    assertStreamCompleted(stream)

    const tools = stream.tools().filter(t => t.toolName === 'calculate')
    expect(tools.length).toBeGreaterThanOrEqual(1)
    expect(tools[0]!.isError).toBe(false)
    expect(tools[0]!.result).toContain('42')
  }, 60_000)

  it('multi-turn context retained on GPT-4o-mini', async () => {
    ts = await createTestSession({
      model: 'openai:gpt-4o-mini',
      tools: 'none',
      maxTurns: 2,
      maxTokens: 128,
    })

    await ts.run('Remember this word: NEPTUNE. Just acknowledge.')
    const stream = await ts.run('What word did I ask you to remember?')

    assertStreamCompleted(stream)
    assertTextContains(stream, 'NEPTUNE')
  }, 60_000)
})
