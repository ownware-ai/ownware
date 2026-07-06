/**
 * SSE Pattern 1: Text Streaming
 *
 * The simplest pattern — model produces text, no tools.
 * Validates the fundamental event lifecycle:
 *   session.start → turn.start → text.delta+ → text.complete → turn.end → session.end
 */

import { describe, it, afterEach } from 'vitest'
import {
  createTestSession,
  type TestSession,
  assertStreamCompleted,
  assertHasEvent,
  assertNoEvent,
  assertEventCount,
  assertTextContains,
  assertHasUsage,
  assertEventOrder,
} from '../harness/index.js'

const HAS_KEY = !!process.env['ANTHROPIC_API_KEY']

describe.skipIf(!HAS_KEY)('SSE Pattern 1: Text Streaming', () => {
  let ts: TestSession

  afterEach(async () => {
    if (ts) await ts.cleanup()
  })

  it('single turn text response has correct event lifecycle', async () => {
    ts = await createTestSession({
      tools: 'none',
      maxTurns: 1,
      maxTokens: 256,
      recordFixtures: true,
    })

    const stream = await ts.run('Say exactly: THE QUICK BROWN FOX')

    ts.recordFixture('01-text-streaming', stream, {
      prompt: 'Say exactly: THE QUICK BROWN FOX',
      model: 'haiku',
      expectedBehavior: 'text.delta events accumulate to response containing THE QUICK BROWN FOX',
    })

    // Lifecycle
    assertStreamCompleted(stream)
    assertHasEvent(stream, 'session.start')
    assertHasEvent(stream, 'session.end')
    assertHasEvent(stream, 'turn.start')
    assertHasEvent(stream, 'turn.end')
    assertHasEvent(stream, 'text.delta')

    // Exactly one turn
    assertEventCount(stream, 'turn.start', 1)
    assertEventCount(stream, 'turn.end', 1)
    assertEventCount(stream, 'session.start', 1)
    assertEventCount(stream, 'session.end', 1)

    // No tool or agent events
    assertNoEvent(stream, 'tool.call.start')
    assertNoEvent(stream, 'tool.call.end')
    assertNoEvent(stream, 'agent.spawn')
    assertNoEvent(stream, 'permission.request')

    // Event ordering
    assertEventOrder(stream, 'session.start', 'turn.start')
    assertEventOrder(stream, 'turn.start', 'text.delta')
    assertEventOrder(stream, 'text.delta', 'turn.end')
    assertEventOrder(stream, 'turn.end', 'session.end')

    // Content
    assertTextContains(stream, 'QUICK BROWN FOX')

    // Multiple text.delta events (streaming produces chunks)
    const deltaCount = stream.eventCounts()['text.delta'] ?? 0
    // At least 1 delta (Anthropic usually sends several)
    expect(deltaCount).toBeGreaterThanOrEqual(1)

    // Usage
    assertHasUsage(stream)
    const usage = stream.usage()
    expect(usage.costUsd).toBeGreaterThan(0)

    // Session end reason should be 'end_turn'
    expect(stream.endReason()).toBe('end_turn')
  }, 30_000)

  it('empty-ish response still has correct structure', async () => {
    ts = await createTestSession({
      tools: 'none',
      maxTurns: 1,
      maxTokens: 32,
    })

    const stream = await ts.run('Reply with just the word: OK')

    assertStreamCompleted(stream)
    assertHasEvent(stream, 'session.start')
    assertHasEvent(stream, 'text.delta')
    assertHasEvent(stream, 'session.end')
    assertHasUsage(stream)

    const text = stream.text()
    expect(text.length).toBeGreaterThan(0)
  }, 30_000)

  it('result object matches event stream data', async () => {
    ts = await createTestSession({
      tools: 'none',
      maxTurns: 1,
      maxTokens: 128,
    })

    const stream = await ts.run('Count from 1 to 5.')

    assertStreamCompleted(stream)

    // The LoopResult should match what the events tell us
    const result = stream.result!
    expect(result.reason).toBe('end_turn')
    expect(result.turnCount).toBe(1)
    expect(result.totalUsage.inputTokens).toBeGreaterThan(0)
    expect(result.totalUsage.outputTokens).toBeGreaterThan(0)
    expect(result.messages.length).toBeGreaterThanOrEqual(2) // user + assistant
  }, 30_000)
})
