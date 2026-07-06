/**
 * Unit Tests — Session async (proactive) compaction scheduling
 *
 * Verifies the background-compaction pattern:
 *
 *   - After `submitMessage` finishes, if context pressure is approaching
 *     the trigger fraction, compaction is scheduled in the background.
 *   - The next `submitMessage` awaits the in-flight compaction before
 *     pushing the new user message — sequencing the user's turn behind
 *     the previous turn's background work.
 *   - `abort()` cancels: the promise resolves but the result is discarded.
 *   - Failures are silent — the loop's sync compactIfNeeded handles the
 *     next turn instead.
 *   - Newer messages added during the in-flight compaction are NOT lost
 *     — they get spliced onto the end of the compacted history.
 */

import { describe, it, expect, vi } from 'vitest'
import { Session } from '../../../src/core/session.js'
import { createDefaultConfig } from '../../../src/core/config.js'
import type { ProviderAdapter } from '../../../src/provider/types.js'
import type { CompactionManager } from '../../../src/compaction/manager.js'
import type { Message } from '../../../src/messages/types.js'
import type { LoomEvent } from '../../../src/core/events.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProvider(): ProviderAdapter {
  return {
    name: 'mock',
    stream: vi.fn() as unknown as ProviderAdapter['stream'],
    countTokens: vi.fn().mockResolvedValue(100),
    supportsFeature: vi.fn().mockReturnValue(false),
    formatTools: vi.fn().mockReturnValue([]),
  }
}

interface ControlledCompaction {
  manager: CompactionManager
  /** Resolves the in-flight `compactIfNeeded` call with the given result. */
  resolve: (result: { messages: Message[]; preTokenCount: number; postTokenCount: number; strategy: 'truncate' } | null) => void
  /** Rejects the in-flight `compactIfNeeded` call. */
  reject: (error: Error) => void
  /** Number of times compactIfNeeded was called. */
  callCount: () => number
  /** Captured `messages` argument from the most recent call. */
  lastCalledWith: () => Message[] | undefined
}

/**
 * A CompactionManager whose `compactIfNeeded` returns a promise we
 * control externally. Lets tests assert the EXACT sequencing between
 * the user's `submitMessage` and the in-flight background work.
 */
function controlledCompaction(): ControlledCompaction {
  let pendingResolve: ((v: unknown) => void) | null = null
  let pendingReject: ((e: Error) => void) | null = null
  let calls: Message[][] = []

  const manager: CompactionManager = {
    compactIfNeeded: vi.fn().mockImplementation(async (messages: Message[]) => {
      calls.push(messages)
      return new Promise((res, rej) => {
        pendingResolve = res as (v: unknown) => void
        pendingReject = rej
      })
    }),
    forceCompact: vi.fn().mockResolvedValue(null),
  }

  return {
    manager,
    resolve: (result) => {
      pendingResolve?.(result)
    },
    reject: (err) => {
      pendingReject?.(err)
    },
    callCount: () => calls.length,
    lastCalledWith: () => calls[calls.length - 1],
  }
}

/** Build a conversation that's ~75% of a 200K window (above trigger). */
function bigConversation(): Message[] {
  // Each message ~7000 chars ≈ 1750 tokens. 50 messages ≈ 87,500 tokens.
  // That's ~44% of a 200K default window — under the 0.65 default
  // proactive threshold. We need to push higher.
  // 100 messages ≈ 175K tokens ≈ 88% of 200K — above any threshold.
  const messages: Message[] = []
  for (let i = 0; i < 100; i++) {
    if (i % 2 === 0) {
      messages.push({ role: 'user', content: 'x'.repeat(7000) + ` turn ${i}` })
    } else {
      messages.push({
        role: 'assistant',
        content: [{ type: 'text', text: 'y'.repeat(7000) + ` turn ${i}` }],
      })
    }
  }
  return messages
}

/** Build a tiny conversation well below trigger. */
function smallConversation(): Message[] {
  return [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
  ]
}

type SessionPrivate = {
  inFlightCompaction: Promise<void> | null
  compactionCancelled: boolean
  scheduleProactiveCompaction: () => void
  drainInFlightCompaction: () => AsyncGenerator<LoomEvent, void>
}

function asPrivate(s: Session): SessionPrivate {
  return s as unknown as SessionPrivate
}

/**
 * Exhaust the drain generator and return the events it yielded.
 * Tests that previously did `await drainInFlightCompaction()` use this
 * to wait for the in-flight promise AND inspect the shimmer events
 * (compaction.start / compaction.end) the drain synthesizes.
 */
async function collectDrain(s: Session): Promise<LoomEvent[]> {
  const events: LoomEvent[] = []
  for await (const ev of asPrivate(s).drainInFlightCompaction()) {
    events.push(ev)
  }
  return events
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Session — proactive (async) compaction scheduling', () => {
  it('schedules compaction when pressure crosses the proactive trigger', () => {
    const ctrl = controlledCompaction()
    const session = new Session({
      config: createDefaultConfig('test:model'),
      provider: makeProvider(),
      tools: [],
      compaction: ctrl.manager,
      initialMessages: bigConversation(),
    })

    asPrivate(session).scheduleProactiveCompaction()
    expect(asPrivate(session).inFlightCompaction).not.toBeNull()
    expect(ctrl.callCount()).toBe(1)
  })

  it('does NOT schedule compaction when pressure is below the proactive trigger', () => {
    const ctrl = controlledCompaction()
    const session = new Session({
      config: createDefaultConfig('test:model'),
      provider: makeProvider(),
      tools: [],
      compaction: ctrl.manager,
      initialMessages: smallConversation(),
    })

    asPrivate(session).scheduleProactiveCompaction()
    expect(asPrivate(session).inFlightCompaction).toBeNull()
    expect(ctrl.callCount()).toBe(0)
  })

  it('does NOT schedule a second compaction while one is already in flight', () => {
    const ctrl = controlledCompaction()
    const session = new Session({
      config: createDefaultConfig('test:model'),
      provider: makeProvider(),
      tools: [],
      compaction: ctrl.manager,
      initialMessages: bigConversation(),
    })

    asPrivate(session).scheduleProactiveCompaction()
    asPrivate(session).scheduleProactiveCompaction()
    asPrivate(session).scheduleProactiveCompaction()
    expect(ctrl.callCount()).toBe(1)
  })

  it('applies the compacted messages back to the session when it resolves', async () => {
    const ctrl = controlledCompaction()
    const initial = bigConversation()
    const session = new Session({
      config: createDefaultConfig('test:model'),
      provider: makeProvider(),
      tools: [],
      compaction: ctrl.manager,
      initialMessages: initial,
    })

    asPrivate(session).scheduleProactiveCompaction()
    expect(session.getMessages()).toHaveLength(initial.length)

    const compacted: Message[] = [
      { role: 'user', content: 'compacted summary' },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    ]
    ctrl.resolve({
      messages: compacted,
      preTokenCount: 150_000,
      postTokenCount: 1_000,
      strategy: 'truncate',
    })
    await collectDrain(session)

    expect(session.getMessages()).toEqual(compacted)
    expect(asPrivate(session).inFlightCompaction).toBeNull()
  })

  it('splices messages added mid-flight onto the end of the compacted history', async () => {
    const ctrl = controlledCompaction()
    const session = new Session({
      config: createDefaultConfig('test:model'),
      provider: makeProvider(),
      tools: [],
      compaction: ctrl.manager,
      initialMessages: bigConversation(),
    })

    asPrivate(session).scheduleProactiveCompaction()

    // Simulate a user message arriving during the in-flight compaction.
    // (In real code this happens because submitMessage runs the await
    // AT THE TOP — so this scenario only occurs if a caller bypasses
    // submitMessage. The session-state mutation pattern is still well-
    // defined: newer messages on top of compacted.)
    const newMessages = [...session.getMessages(), { role: 'user', content: 'new user turn' } as Message]
    ;(session as unknown as { messages: Message[] }).messages = newMessages

    const compacted: Message[] = [
      { role: 'user', content: 'compacted' },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    ]
    ctrl.resolve({
      messages: compacted,
      preTokenCount: 150_000,
      postTokenCount: 1_000,
      strategy: 'truncate',
    })
    await collectDrain(session)

    const final = session.getMessages()
    expect(final.length).toBe(compacted.length + 1)
    // Last message must be the user's new turn — not lost.
    expect(final[final.length - 1]).toEqual({ role: 'user', content: 'new user turn' })
    // Compacted block must come first.
    expect(final.slice(0, 2)).toEqual(compacted)
  })

  it('discards the result when abort() is called before compaction resolves', async () => {
    const ctrl = controlledCompaction()
    const initial = bigConversation()
    const session = new Session({
      config: createDefaultConfig('test:model'),
      provider: makeProvider(),
      tools: [],
      compaction: ctrl.manager,
      initialMessages: initial,
    })

    asPrivate(session).scheduleProactiveCompaction()
    session.abort()
    expect(asPrivate(session).compactionCancelled).toBe(true)

    ctrl.resolve({
      messages: [{ role: 'user', content: 'compacted ghost' }],
      preTokenCount: 150_000,
      postTokenCount: 100,
      strategy: 'truncate',
    })
    await collectDrain(session)

    // Original messages preserved — compaction result discarded.
    expect(session.getMessages()).toHaveLength(initial.length)
    expect(asPrivate(session).inFlightCompaction).toBeNull()
  })

  it('silently swallows compaction failures — session messages untouched', async () => {
    const ctrl = controlledCompaction()
    const initial = bigConversation()
    const session = new Session({
      config: createDefaultConfig('test:model'),
      provider: makeProvider(),
      tools: [],
      compaction: ctrl.manager,
      initialMessages: initial,
    })

    asPrivate(session).scheduleProactiveCompaction()
    ctrl.reject(new Error('boom — provider went down'))
    await collectDrain(session)

    expect(session.getMessages()).toHaveLength(initial.length)
    expect(asPrivate(session).inFlightCompaction).toBeNull()
  })

  it('drain() is a no-op when no compaction is in flight', async () => {
    const session = new Session({
      config: createDefaultConfig('test:model'),
      provider: makeProvider(),
      tools: [],
    })

    await collectDrain(session)
    expect(asPrivate(session).inFlightCompaction).toBeNull()
  })

  it('compaction = null path is a no-op', () => {
    const session = new Session({
      config: createDefaultConfig('test:model'),
      provider: makeProvider(),
      tools: [],
      compaction: null,
      initialMessages: bigConversation(),
    })

    asPrivate(session).scheduleProactiveCompaction()
    expect(asPrivate(session).inFlightCompaction).toBeNull()
  })

  it('proactive trigger fires BELOW the configured sync trigger', () => {
    // Config sync trigger = 0.80 fraction. Proactive should fire at
    // ~0.65 (sync - 0.15). Build a conversation right between the two.
    const ctrl = controlledCompaction()
    // ~70% of 200K = 140K tokens ≈ 70 turns of 8K chars each
    const messages: Message[] = []
    for (let i = 0; i < 80; i++) {
      messages.push(
        i % 2 === 0
          ? { role: 'user', content: 'x'.repeat(7000) }
          : { role: 'assistant', content: [{ type: 'text', text: 'y'.repeat(7000) }] },
      )
    }

    const config = createDefaultConfig('test:model')
    // Verify the assumption — config defaults to fraction:0.80
    expect(config.compaction.trigger).toEqual({ type: 'fraction', threshold: 0.8 })

    const session = new Session({
      config,
      provider: makeProvider(),
      tools: [],
      compaction: ctrl.manager,
      initialMessages: messages,
    })

    asPrivate(session).scheduleProactiveCompaction()
    expect(ctrl.callCount()).toBe(1)
  })

  // ---------------------------------------------------------------------------
  // Drain shimmer (Option B — chunk #24)
  //
  // When the user submits a new turn before the background proactive
  // compaction has resolved, the drain MUST surface a
  // `compaction.start` / `compaction.end` pair so the UI client's reducer
  // flips `isCompacting=true` and renders the inline shimmer for the
  // duration of the wait. When the background work has already
  // finished by the time the user submits, the drain MUST stay silent
  // — no shimmer for a zero-duration wait, no transcript noise.
  // ---------------------------------------------------------------------------

  it('drain yields compaction.start/.end when the user beats the in-flight promise', async () => {
    const ctrl = controlledCompaction()
    const session = new Session({
      config: createDefaultConfig('test:model'),
      provider: makeProvider(),
      tools: [],
      compaction: ctrl.manager,
      initialMessages: bigConversation(),
    })

    // Schedule background compaction; it is now in flight (the
    // controlled mock parks until we call ctrl.resolve).
    asPrivate(session).scheduleProactiveCompaction()
    expect(asPrivate(session).inFlightCompaction).not.toBeNull()

    // Start the drain — generator yields compaction.start before the
    // await, so we can observe the first event before resolving the
    // background promise.
    const gen = asPrivate(session).drainInFlightCompaction()
    const first = await gen.next()
    expect(first.done).toBe(false)
    expect(first.value).toMatchObject({
      type: 'compaction.start',
      turnIndex: 0,
    })

    // Now resolve the background work with real metadata. The drain
    // resumes inside `await inFlight`, reads the captured numbers, and
    // yields compaction.end with the real pre/post/strategy values.
    ctrl.resolve({
      messages: [
        { role: 'user', content: 'compacted' },
        { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      ],
      preTokenCount: 150_000,
      postTokenCount: 50_000,
      strategy: 'truncate',
    })

    const second = await gen.next()
    expect(second.done).toBe(false)
    expect(second.value).toMatchObject({
      type: 'compaction.end',
      strategy: 'truncate',
      preTokenCount: 150_000,
      postTokenCount: 50_000,
      // (150000 - 50000) / 150000 = 66.66...% → rounded
      savedPercent: 67,
      turnIndex: 0,
    })

    const done = await gen.next()
    expect(done.done).toBe(true)
  })

  it('drain stays silent when no compaction is in flight (background already finished)', async () => {
    const session = new Session({
      config: createDefaultConfig('test:model'),
      provider: makeProvider(),
      tools: [],
    })

    // No scheduleProactiveCompaction → inFlightCompaction is null.
    // Drain must yield zero events (the "common case" Option B targets:
    // background beat the user, no wait, no shimmer).
    const events = await collectDrain(session)
    expect(events).toEqual([])
  })

  it('drain stays silent when proactive compaction finished BEFORE drain runs', async () => {
    const ctrl = controlledCompaction()
    const session = new Session({
      config: createDefaultConfig('test:model'),
      provider: makeProvider(),
      tools: [],
      compaction: ctrl.manager,
      initialMessages: bigConversation(),
    })

    asPrivate(session).scheduleProactiveCompaction()

    // Resolve the promise AND let runProactiveCompaction's finally
    // block reset inFlightCompaction to null — that's the "background
    // beat the user" scenario.
    ctrl.resolve({
      messages: [{ role: 'user', content: 'compacted' }],
      preTokenCount: 150_000,
      postTokenCount: 50_000,
      strategy: 'summarize',
    })
    // Yield to the microtask queue so runProactiveCompaction's
    // resolution + finally block runs and clears inFlightCompaction.
    await new Promise(resolve => setImmediate(resolve))
    expect(asPrivate(session).inFlightCompaction).toBeNull()

    // Now the user submits — the drain sees no in-flight promise and
    // emits nothing. No shimmer, no transcript noise.
    const events = await collectDrain(session)
    expect(events).toEqual([])
  })

  it('drain emits start + end with zeroed numbers when the proactive run failed mid-flight', async () => {
    // When the background compaction throws, runProactiveCompaction
    // sets lastProactiveResult = null. The drain still emits
    // compaction.start (it had to wait — the user saw the shimmer)
    // and compaction.end with zeroed numbers. The user's submitMessage
    // proceeds and the loop's sync compactIfNeeded safety net handles
    // the still-pressured context on the same turn.
    const ctrl = controlledCompaction()
    const session = new Session({
      config: createDefaultConfig('test:model'),
      provider: makeProvider(),
      tools: [],
      compaction: ctrl.manager,
      initialMessages: bigConversation(),
    })

    asPrivate(session).scheduleProactiveCompaction()
    const gen = asPrivate(session).drainInFlightCompaction()
    const first = await gen.next()
    expect((first.value as LoomEvent).type).toBe('compaction.start')

    ctrl.reject(new Error('provider went down'))
    const second = await gen.next()
    expect(second.value).toMatchObject({
      type: 'compaction.end',
      // strategy falls back to 'proactive-drain' marker when no
      // result was captured — keeps the event well-formed without
      // claiming a fake strategy ran.
      strategy: 'proactive-drain',
      preTokenCount: 0,
      postTokenCount: 0,
      savedPercent: 0,
    })
  })

  it('submitMessage yields drain shimmer events through its main generator', async () => {
    // End-to-end: confirm the events flow through submitMessage's
    // AsyncGenerator (the contract the gateway consumes). A UI client's
    // reducer + cortex's session-runner only see events that arrive
    // via `session.submitMessage().next()` — they will NEVER inspect
    // private fields. This test mirrors what cortex sees.
    const ctrl = controlledCompaction()
    const session = new Session({
      config: createDefaultConfig('test:model'),
      provider: {
        ...makeProvider(),
        // Provider stream throws to short-circuit the loop AFTER the
        // drain has had a chance to yield. We only care about events
        // before the loop runs.
        stream: vi.fn().mockImplementation(async function* () {
          throw new Error('halt-loop-after-drain')
        }) as unknown as ProviderAdapter['stream'],
      },
      tools: [],
      compaction: ctrl.manager,
      initialMessages: bigConversation(),
    })

    asPrivate(session).scheduleProactiveCompaction()
    const events: LoomEvent[] = []
    const gen = session.submitMessage('next turn')
    // Pull the first event — it must be compaction.start from the drain,
    // BEFORE the loop runs.
    const first = await gen.next()
    expect(first.done).toBe(false)
    events.push(first.value as LoomEvent)
    expect(first.value).toMatchObject({ type: 'compaction.start' })

    // Resolve the background promise to release the drain.
    ctrl.resolve({
      messages: [{ role: 'user', content: 'compacted' }],
      preTokenCount: 100_000,
      postTokenCount: 30_000,
      strategy: 'truncate',
    })

    const second = await gen.next()
    expect(second.done).toBe(false)
    events.push(second.value as LoomEvent)
    expect(second.value).toMatchObject({
      type: 'compaction.end',
      strategy: 'truncate',
      preTokenCount: 100_000,
      postTokenCount: 30_000,
    })

    // Drain ordering invariant: start comes before end, both in
    // arrival order on the wire.
    const types = events.map(e => e.type)
    expect(types).toEqual(['compaction.start', 'compaction.end'])

    // Drive the generator to completion / failure so vitest doesn't
    // leak an open async iterator into the next test.
    try { await gen.next() } catch { /* loop throws by design */ }
  })
})
