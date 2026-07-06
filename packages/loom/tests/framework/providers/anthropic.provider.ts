/**
 * Provider Test: Anthropic
 *
 * Tests Anthropic-specific behavior: Haiku and Sonnet streaming,
 * token counting, and model-specific features.
 */

import { describe, it, expect, afterEach } from 'vitest'
import {
  createTestSession,
  type TestSession,
  assertStreamCompleted,
  assertHasEvent,
  assertHasUsage,
  assertTextContains,
  calculatorTool,
} from '../harness/index.js'

const HAS_KEY = !!process.env['ANTHROPIC_API_KEY']

describe.skipIf(!HAS_KEY)('Provider: Anthropic', () => {
  let ts: TestSession

  afterEach(async () => {
    if (ts) await ts.cleanup()
  })

  it('Haiku streams text correctly', async () => {
    ts = await createTestSession({
      model: 'anthropic:claude-haiku-4-5-20251001',
      tools: 'none',
      maxTurns: 1,
      maxTokens: 128,
    })

    const stream = await ts.run('Say exactly: HAIKU STREAMING TEST')
    assertStreamCompleted(stream)
    assertHasEvent(stream, 'text.delta')
    assertTextContains(stream, 'HAIKU')
    assertHasUsage(stream)

    // Verify Haiku is cheap
    const usage = stream.usage()
    expect(usage.costUsd).toBeLessThan(0.01)
  }, 30_000)

  it('Sonnet streams text correctly', async () => {
    ts = await createTestSession({
      model: 'anthropic:claude-sonnet-4-20250514',
      tools: 'none',
      maxTurns: 1,
      maxTokens: 128,
    })

    const stream = await ts.run('Say exactly: SONNET STREAMING TEST')
    assertStreamCompleted(stream)
    assertHasEvent(stream, 'text.delta')
    assertTextContains(stream, 'SONNET')
    assertHasUsage(stream)
  }, 30_000)

  it('Sonnet uses tools reliably', async () => {
    ts = await createTestSession({
      model: 'anthropic:claude-sonnet-4-20250514',
      tools: [calculatorTool],
      systemPrompt: 'Always use the calculate tool for math. NEVER compute in your head.',
      maxTurns: 3,
      maxTokens: 256,
    })

    const stream = await ts.run('Use calculate tool: 33 + 67')
    assertStreamCompleted(stream)

    const tools = stream.tools().filter(t => t.toolName === 'calculate')
    expect(tools.length).toBeGreaterThanOrEqual(1)
    expect(tools[0]!.isError).toBe(false)
    expect(tools[0]!.result).toContain('100')
  }, 60_000)

  it('Haiku is faster than Sonnet for simple prompts', async () => {
    const haiku = await createTestSession({
      model: 'anthropic:claude-haiku-4-5-20251001',
      tools: 'none',
      maxTurns: 1,
      maxTokens: 64,
    })
    const sonnet = await createTestSession({
      model: 'anthropic:claude-sonnet-4-20250514',
      tools: 'none',
      maxTurns: 1,
      maxTokens: 64,
    })

    try {
      const start1 = Date.now()
      const h = await haiku.run('Say: OK')
      const haikuMs = Date.now() - start1

      const start2 = Date.now()
      const s = await sonnet.run('Say: OK')
      const sonnetMs = Date.now() - start2

      assertStreamCompleted(h)
      assertStreamCompleted(s)

      // Both should have usage
      assertHasUsage(h)
      assertHasUsage(s)

      // Haiku should generally be cheaper
      expect(h.usage().costUsd).toBeLessThanOrEqual(s.usage().costUsd)
    } finally {
      await haiku.cleanup()
      await sonnet.cleanup()
    }
    ts = undefined as any // Prevent afterEach cleanup error
  }, 60_000)
})
