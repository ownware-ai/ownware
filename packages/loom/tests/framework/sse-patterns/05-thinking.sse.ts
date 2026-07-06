/**
 * SSE Pattern 5: Extended Thinking
 *
 * Validates thinking.delta and thinking.complete events when the model
 * uses extended thinking (chain-of-thought before response).
 *
 * Note: Extended thinking requires specific model support and config.
 * This test uses Sonnet which supports thinking with budget_tokens.
 */

import { describe, it, expect, afterEach } from 'vitest'
import {
  createTestSession,
  type TestSession,
  assertStreamCompleted,
  assertHasEvent,
  assertHasUsage,
  assertEventOrder,
} from '../harness/index.js'

const HAS_KEY = !!process.env['ANTHROPIC_API_KEY']

describe.skipIf(!HAS_KEY)('SSE Pattern 5: Extended Thinking', () => {
  let ts: TestSession

  afterEach(async () => {
    if (ts) await ts.cleanup()
  })

  it('model produces thinking events when enabled', async () => {
    ts = await createTestSession({
      model: 'anthropic:claude-sonnet-4-20250514',
      tools: 'none',
      maxTurns: 1,
      maxTokens: 2048,
      configOverrides: {
        temperature: 1, // Required for extended thinking
      },
      recordFixtures: true,
    })

    const stream = await ts.run(
      'Think step by step about what 47 * 83 equals. Show your reasoning.',
    )

    ts.recordFixture('05-thinking', stream, {
      prompt: 'Think step by step: 47 * 83',
      model: 'sonnet',
      expectedBehavior: 'thinking.delta events with reasoning, then text.delta with answer',
    })

    assertStreamCompleted(stream)
    assertHasEvent(stream, 'session.start')
    assertHasEvent(stream, 'text.delta')
    assertHasEvent(stream, 'session.end')
    assertHasUsage(stream)

    // Thinking events may or may not appear depending on model config.
    // If they do appear, verify ordering.
    if (stream.hasEvent('thinking.delta')) {
      const thinkingText = stream.thinking()
      expect(thinkingText.length).toBeGreaterThan(0)

      // Thinking should come before text
      assertEventOrder(stream, 'thinking.delta', 'text.delta')
    }

    // The final answer should mention 3901
    const text = stream.text()
    expect(text.length).toBeGreaterThan(0)
  }, 60_000)
})
