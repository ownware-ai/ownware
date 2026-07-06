/**
 * Unit Test — foundation-hardening B4: cross-provider context-overflow
 * recovery.
 *
 * Two bugs, both surfaced on long OpenAI / Google / OpenRouter sessions:
 *
 *  1. The reactive-compaction trigger keyed ONLY on `error.isPromptTooLong`,
 *     whose substrings ('prompt is too long' / 'maximum context length') are
 *     Anthropic-specific. The classifier (`classifyByBody`) correctly builds a
 *     `ContextWindowExceededError` for OpenAI's `context_length_exceeded` and
 *     Google's "exceeded the model's context", but that error's message
 *     doesn't match those substrings → `isPromptTooLong` is false → reactive
 *     compaction was skipped and the user got a hard error on the FIRST
 *     overflow.
 *
 *  2. The trigger was gated on `!state.hasAttemptedCompaction`, so once
 *     proactive compaction had already run this turn, a still-overflowing
 *     call could NOT trigger reactive compaction — the second overflow was
 *     fatal. Long sessions (where overflow happens) are exactly the ones that
 *     have already compacted.
 *
 * Post-fix: the trigger matches the typed `ContextWindowExceededError` (any
 * provider) AND is bounded by a per-turn counter (MAX_COMPACTION_RECOVERY)
 * rather than a one-shot flag.
 */

import { describe, it, expect } from 'vitest'
import { loop, type LoopParams } from '../../../src/core/loop.js'
import { createDefaultConfig } from '../../../src/core/config.js'
import { createMockProvider } from '../../helpers/mock-provider.js'
import { userMsg } from '../../helpers/fixtures.js'
import { ContextWindowExceededError } from '../../../src/core/errors.js'
import type { LoomEvent, SessionEndEvent } from '../../../src/core/events.js'
import type { Message } from '../../../src/messages/types.js'
import type { CompactionManager } from '../../../src/compaction/manager.js'

async function collectLoop(params: LoopParams) {
  const events: LoomEvent[] = []
  const gen = loop(params)
  let next = await gen.next()
  while (!next.done) {
    events.push(next.value)
    next = await gen.next()
  }
  return { events, result: next.value }
}

function makeParams(overrides: Partial<LoopParams> = {}): LoopParams {
  return {
    messages: [userMsg('Hi')],
    systemPrompt: 'You are a test assistant.',
    provider: createMockProvider({ summaryResponse: 'Hello!' }),
    tools: [],
    config: createDefaultConfig('mock:test-model'),
    compaction: null,
    checkpoint: null,
    checkPermission: async () => 'allow' as const,
    requestApproval: async () => true,
    ...overrides,
  }
}

/** A compaction stub: `proactive` controls whether compactIfNeeded fires; */
/* forceCompact always shrinks to the last message and counts its calls. */
function makeCompaction(proactive: boolean): { compaction: CompactionManager; forceCalls: () => number } {
  let forceCalls = 0
  const result = (messages: Message[]) => ({
    strategy: 'truncate' as const,
    preTokenCount: 1000,
    postTokenCount: 100,
    messages: messages.slice(-1),
  })
  const compaction = {
    compactIfNeeded: async (messages: Message[]) => (proactive ? result(messages) : null),
    forceCompact: async (messages: Message[]) => {
      forceCalls++
      return result(messages)
    },
  } as unknown as CompactionManager
  return { compaction, forceCalls: () => forceCalls }
}

// An OpenAI code-form overflow whose message contains NEITHER Anthropic
// substring — so `isPromptTooLong` is false and only the typed-error match
// can catch it.
function overflowProvider() {
  return createMockProvider({
    failOnStreamCall: 1,
    streamError: new ContextWindowExceededError('context_length_exceeded', 'openai'),
    summaryResponse: 'Recovered after compaction.',
  })
}

function recoveryEvent(events: LoomEvent[]) {
  return events.find((e): e is Extract<LoomEvent, { type: 'recovery' }> => e.type === 'recovery')
}

describe('B4 — cross-provider context-overflow recovery', () => {
  it('a typed ContextWindowExceededError (non-Anthropic wording) triggers reactive compaction and recovers', async () => {
    const { compaction, forceCalls } = makeCompaction(false) // no proactive
    const { events, result } = await collectLoop(
      makeParams({ provider: overflowProvider(), compaction }),
    )

    // Reactive compaction fired despite isPromptTooLong being false.
    const recovery = recoveryEvent(events)
    expect(recovery).toBeDefined()
    expect(recovery!.reason).toBe('prompt_too_long')
    expect(forceCalls()).toBe(1)

    // The turn recovered to a clean end_turn instead of a hard error.
    expect(result.reason).toBe('end_turn')
    const end = events.find(e => e.type === 'session.end') as SessionEndEvent
    expect(end.reason).toBe('end_turn')
  })

  it('a second overflow after proactive compaction still recovers (not fatal)', async () => {
    // Proactive compaction runs this turn (sets hasAttemptedCompaction), then
    // the call still overflows. The old `!hasAttemptedCompaction` gate would
    // make this fatal; the per-turn counter lets it recover.
    const { compaction, forceCalls } = makeCompaction(true) // proactive fires
    const { events, result } = await collectLoop(
      makeParams({ provider: overflowProvider(), compaction }),
    )

    expect(recoveryEvent(events)).toBeDefined()
    expect(forceCalls()).toBe(1)
    expect(result.reason).toBe('end_turn')
  })
})
