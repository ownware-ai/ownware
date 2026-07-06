/**
 * Integration test — Reminder injector wired through Session + loop.
 *
 * Proves the contract that closes Phase 1 of the general-agent
 * foundation:
 *   1. When a `ReminderInjector` is wired to a Session and an event
 *      is emitted before the next turn, the rendered
 *      `<system-reminder>` tag appears in the wire request to the
 *      provider — attached to the last user-side message.
 *   2. The session's stored message history is NOT mutated; only the
 *      request payload carries the reminders.
 *   3. The injector queue is cleared after the request is sent
 *      (next turn does not re-attach the same reminder).
 *   4. Sessions without a reminder injector behave identically to
 *      pre-Phase-1 — no behaviour change for unconfigured callers.
 *
 * Uses the shared mock provider; no API key required.
 */

import { describe, it, expect } from 'vitest'

import { Session } from '../../../src/core/session.js'
import { createDefaultConfig } from '../../../src/core/config.js'
import {
  ReminderInjector,
  createDefaultRegistry,
} from '../../../src/reminders/index.js'
import { createMockProvider } from '../../helpers/mock-provider.js'

import type { Message, ContentBlock } from '../../../src/messages/types.js'

const MODEL = 'mock:test'

function buildSession(opts: { reminders?: ReminderInjector; persistentReminder?: string }) {
  const provider = createMockProvider({ summaryResponse: 'OK' })
  const config = createDefaultConfig(MODEL)
  const session = new Session({
    config,
    provider,
    tools: [],
    compaction: null,
    ...(opts.reminders ? { reminders: opts.reminders } : {}),
    ...(opts.persistentReminder ? { persistentReminder: opts.persistentReminder } : {}),
  })
  return { provider, session }
}

function findUserContent(messages: readonly Message[]): string | ContentBlock[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m && m.role === 'user') return m.content
  }
  throw new Error('no user message in request payload')
}

function flattenText(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content
  return content
    .map(b => (b.type === 'text' ? b.text : ''))
    .join('\n')
}

describe('Session + ReminderInjector — wire integration', () => {
  it('attaches rendered <system-reminder> tags to the last user message in the wire request', async () => {
    const injector = new ReminderInjector(createDefaultRegistry())
    const { provider, session } = buildSession({ reminders: injector })

    injector.emit({ type: 'mode.entered', modeName: 'plan' })
    injector.emit({ type: 'budget.warn', used: 800, total: 1000, currency: 'tokens' })

    const stream = session.submitMessage('hello')
    while (true) {
      const next = await stream.next()
      if (next.done) break
    }

    expect(provider.streamRequests).toHaveLength(1)
    const userContent = findUserContent(provider.streamRequests[0]!.messages)
    const flat = flattenText(userContent)

    expect(flat).toContain('hello')
    expect(flat).toContain('<system-reminder>')
    expect(flat).toContain('Mode active: plan')
    expect(flat).toContain('800 of 1000 tokens')
  })

  it('drains the queue after the request — next turn carries no stale reminders', async () => {
    const injector = new ReminderInjector(createDefaultRegistry())
    const { provider, session } = buildSession({ reminders: injector })

    injector.emit({ type: 'mode.entered', modeName: 'plan' })
    const first = session.submitMessage('first')
    while (true) {
      const next = await first.next()
      if (next.done) break
    }
    expect(injector.size).toBe(0)

    const second = session.submitMessage('second')
    while (true) {
      const next = await second.next()
      if (next.done) break
    }

    expect(provider.streamRequests).toHaveLength(2)
    const flatSecond = flattenText(findUserContent(provider.streamRequests[1]!.messages))
    expect(flatSecond).not.toContain('<system-reminder>')
    expect(flatSecond).toContain('second')
  })

  it('does not mutate the session\'s stored message history', async () => {
    const injector = new ReminderInjector(createDefaultRegistry())
    const { session } = buildSession({ reminders: injector })

    injector.emit({ type: 'task.nudge' })
    const stream = session.submitMessage('do work')
    while (true) {
      const next = await stream.next()
      if (next.done) break
    }

    const messages = session.getMessages()
    const userMsg = messages.find(m => m.role === 'user')
    expect(userMsg).toBeDefined()
    const flat = flattenText(userMsg!.content)
    expect(flat).not.toContain('<system-reminder>')
    expect(flat).toBe('do work')
  })

  it('skips attachment when the queue is empty (request unchanged)', async () => {
    const injector = new ReminderInjector(createDefaultRegistry())
    const { provider, session } = buildSession({ reminders: injector })

    const stream = session.submitMessage('quiet')
    while (true) {
      const next = await stream.next()
      if (next.done) break
    }

    const flat = flattenText(findUserContent(provider.streamRequests[0]!.messages))
    expect(flat).not.toContain('<system-reminder>')
    expect(flat).toContain('quiet')
  })

  it('sessions without a reminder injector behave identically to before — regression guard', async () => {
    const { provider, session } = buildSession({})
    const stream = session.submitMessage('no reminders here')
    while (true) {
      const next = await stream.next()
      if (next.done) break
    }

    const flat = flattenText(findUserContent(provider.streamRequests[0]!.messages))
    expect(flat).not.toContain('<system-reminder>')
    expect(flat).toContain('no reminders here')
  })
})

describe('Session + persistentReminder — domain-neutral pin', () => {
  it('injects the configured string on EVERY turn as a <system-reminder>', async () => {
    const PIN = 'Must end with VERDICT: PASS, FAIL, or PARTIAL.'
    const { provider, session } = buildSession({ persistentReminder: PIN })

    // Three turns — same pin must appear on each request.
    for (const userText of ['turn-one', 'turn-two', 'turn-three']) {
      const stream = session.submitMessage(userText)
      while (true) {
        const next = await stream.next()
        if (next.done) break
      }
    }

    expect(provider.streamRequests).toHaveLength(3)
    for (let i = 0; i < 3; i++) {
      const flat = flattenText(findUserContent(provider.streamRequests[i]!.messages))
      expect(flat).toContain('<system-reminder>')
      expect(flat).toContain(PIN)
    }
  })

  it('does not mutate the session\'s stored message history', async () => {
    const PIN = 'Pin text — not for storage.'
    const { session } = buildSession({ persistentReminder: PIN })
    const stream = session.submitMessage('hello')
    while (true) {
      const next = await stream.next()
      if (next.done) break
    }

    const stored = session.getMessages()
    const userMsg = stored.find(m => m.role === 'user')
    expect(userMsg).toBeDefined()
    const flat = flattenText(userMsg!.content)
    expect(flat).not.toContain('<system-reminder>')
    expect(flat).not.toContain(PIN)
    expect(flat).toBe('hello')
  })

  it('coexists with the reminder injector — both appear on the same turn', async () => {
    const PIN = 'Persistent guarantee.'
    const injector = new ReminderInjector(createDefaultRegistry())
    const { provider, session } = buildSession({ reminders: injector, persistentReminder: PIN })

    injector.emit({ type: 'mode.entered', modeName: 'plan' })
    const stream = session.submitMessage('hi')
    while (true) {
      const next = await stream.next()
      if (next.done) break
    }

    const flat = flattenText(findUserContent(provider.streamRequests[0]!.messages))
    expect(flat).toContain(PIN)               // persistent
    expect(flat).toContain('Mode active: plan') // event-driven
  })

  it('treats an empty/whitespace-only string as not-set (regression guard)', async () => {
    const { provider, session } = buildSession({ persistentReminder: '   ' })
    const stream = session.submitMessage('quiet turn')
    while (true) {
      const next = await stream.next()
      if (next.done) break
    }

    const flat = flattenText(findUserContent(provider.streamRequests[0]!.messages))
    expect(flat).not.toContain('<system-reminder>')
    expect(flat).toContain('quiet turn')
  })
})
