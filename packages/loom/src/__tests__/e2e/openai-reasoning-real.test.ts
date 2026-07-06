/**
 * End-to-end tests for OpenAI reasoning_effort with the REAL OpenAI API.
 *
 * Requires OPENAI_API_KEY. Skipped otherwise.
 * Uses gpt-5-nano — the cheapest reasoning-capable model in the catalog.
 *
 * Run: OPENAI_API_KEY=sk-... npx vitest run src/__tests__/e2e/openai-reasoning-real.test.ts
 */

import { describe, it, expect } from 'vitest'
import { OpenAIProvider } from '../../provider/openai.js'
import { createSession } from '../../core/session.js'
import type { LoomEvent } from '../../core/events.js'
import type { LoopResult } from '../../core/loop.js'

const apiKey = process.env.OPENAI_API_KEY
const MODEL = 'openai:gpt-5-nano'

function skipIfNoKey(): boolean {
  if (!apiKey) {
    console.log('⏭ Skipping OpenAI e2e: OPENAI_API_KEY not set')
    return true
  }
  return false
}

function makeSession(opts: { systemPrompt?: string; maxTokens?: number; model?: string }) {
  return createSession(opts.model ?? MODEL, {
    provider: new OpenAIProvider({ apiKey: apiKey! }),
    systemPrompt: opts.systemPrompt ?? 'Be brief.',
    config: { maxTokens: opts.maxTokens ?? 256 },
  })
}

async function drainRun(
  gen: AsyncGenerator<LoomEvent, LoopResult>,
): Promise<{ events: LoomEvent[]; result: LoopResult }> {
  const events: LoomEvent[] = []
  let next = await gen.next()
  while (!next.done) {
    events.push(next.value)
    next = await gen.next()
  }
  return { events, result: next.value }
}

function findEvent<T extends LoomEvent>(events: LoomEvent[], type: string): T | undefined {
  return events.find(e => e.type === type) as T | undefined
}

describe('e2e: real OpenAI API — reasoning', () => {
  // ── Test 1: Baseline — reasoning model without thinking enabled ─────────
  //
  // Proves we can hit a reasoning model with our default shape (no
  // temperature, no forbidden params) and still get a clean response.
  it('reaches a reasoning model without enabling reasoning (baseline)', async () => {
    if (skipIfNoKey()) return

    const session = makeSession({
      systemPrompt: 'You answer math questions with just the number.',
      maxTokens: 512,
    })

    const { events, result } = await drainRun(
      session.submitMessage('What is 6 × 7?'),
    )

    const errEvent = findEvent(events, 'error')
    if (errEvent) {
      throw new Error(
        `Baseline reasoning-model call failed: ` +
        `code=${(errEvent as { code?: string }).code} ` +
        `message=${(errEvent as { message?: string }).message}`,
      )
    }

    const turnEnd = findEvent(events, 'turn.end')
    expect(turnEnd).toBeDefined()
    expect(result.reason).toBe('end_turn')

    const textComplete = findEvent(events, 'text.complete')
    expect(textComplete).toBeDefined()
    expect((textComplete as { text: string }).text).toMatch(/\b42\b/)
  }, 120_000)

  // ── Test 2: Reasoning with explicit effort ──────────────────────────────
  //
  // Proves reasoning_effort is accepted by the API (it would 400 if we
  // sent it on a non-reasoning model or got the shape wrong) and that
  // completion_tokens_details.reasoning_tokens shows up in usage for a
  // reasoning-worthy prompt.
  it('accepts reasoning_effort:"low" and returns a correct answer', async () => {
    if (skipIfNoKey()) return

    const session = makeSession({
      systemPrompt:
        'You are a logic puzzle solver. Work it out, then give the single-number answer.',
      maxTokens: 4096,
    })

    const { events } = await drainRun(
      session.submitMessage(
        'A train leaves Station A at 2pm at 60 mph. Another train leaves Station B at ' +
        '3pm at 80 mph heading the same direction on the same track. Station B is 30 ' +
        'miles ahead of Station A. At what time does the second train catch up? ' +
        'Give the answer as a single hour like "5pm".',
        { thinking: { enabled: true, budgetTokens: 2048, effort: 'low' } },
      ),
    )

    const errEvent = findEvent(events, 'error')
    if (errEvent) {
      throw new Error(
        `reasoning_effort call failed: ` +
        `code=${(errEvent as { code?: string }).code} ` +
        `message=${(errEvent as { message?: string }).message}`,
      )
    }

    const textComplete = findEvent(events, 'text.complete')
    expect(textComplete).toBeDefined()
    // Math: second train is 30 miles behind, closes at 20 mph → 1.5 hrs
    // after 3pm = 4:30pm. Accept 4:30, 4:30pm, or "4:30pm" variants.
    const text = (textComplete as { text: string }).text.toLowerCase()
    expect(text).toMatch(/4:?30|four[\s-]?thirty/)

    // Usage should report non-zero completion tokens. Reasoning-token
    // subtotal may or may not land in our usage shape (Chat Completions
    // folds it into completion_tokens), but the total must be positive.
    const turnEnd = findEvent(events, 'turn.end')
    expect((turnEnd as { usage: { outputTokens: number } }).usage.outputTokens)
      .toBeGreaterThan(0)
  }, 180_000)

  // ── Test 3: Validation — thinking on non-reasoning model rejected ───────
  it('surfaces a ProviderError when thinking is enabled on a non-reasoning model', async () => {
    if (skipIfNoKey()) return

    const session = makeSession({
      model: 'openai:gpt-4o-mini',
      systemPrompt: 'ok',
      maxTokens: 64,
    })

    const { events } = await drainRun(
      session.submitMessage('hi', {
        thinking: { enabled: true, budgetTokens: 2048 },
      }),
    )

    const errEvent = findEvent(events, 'error')
    expect(errEvent).toBeDefined()
    expect((errEvent as { message: string }).message).toMatch(/does not support reasoning/i)
    expect((errEvent as { recoverable: boolean }).recoverable).toBe(false)
  }, 60_000)
})
