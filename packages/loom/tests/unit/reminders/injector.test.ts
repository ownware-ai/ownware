/**
 * Unit Tests — Reminder Injector
 */

import { describe, it, expect } from 'vitest'

import { ReminderRegistry } from '../../../src/reminders/registry.js'
import { ReminderInjector } from '../../../src/reminders/injector.js'
import { defineTemplate } from '../../../src/reminders/types.js'

function buildRegistry() {
  const registry = new ReminderRegistry()
  registry.register(
    defineTemplate({
      id: 'mode.entered.default',
      eventType: 'mode.entered',
      suppressible: false,
      render: (event) => `Mode: ${event.modeName}`,
    }),
  )
  registry.register(
    defineTemplate({
      id: 'budget.warn.default',
      eventType: 'budget.warn',
      suppressible: true,
      render: (event) => `Budget: ${event.used}/${event.total} ${event.currency}`,
    }),
  )
  registry.register(
    defineTemplate({
      id: 'task.nudge.empty',
      eventType: 'task.nudge',
      suppressible: true,
      render: () => '   ', // whitespace-only — should be dropped
    }),
  )
  return registry
}

describe('ReminderInjector', () => {
  describe('emit + drain', () => {
    it('renders a single event into a wrapped <system-reminder> body', () => {
      const injector = new ReminderInjector(buildRegistry())
      injector.emit({ type: 'mode.entered', modeName: 'plan' })

      const out = injector.drain({ turnIndex: 0 })

      expect(out).toEqual([
        '<system-reminder>\nMode: plan\n</system-reminder>',
      ])
    })

    it('renders multiple events in emission order', () => {
      const injector = new ReminderInjector(buildRegistry())
      injector.emit({ type: 'mode.entered', modeName: 'plan' })
      injector.emit({ type: 'budget.warn', used: 1000, total: 4000, currency: 'tokens' })

      const out = injector.drain({ turnIndex: 0 })

      expect(out).toHaveLength(2)
      expect(out[0]).toContain('Mode: plan')
      expect(out[1]).toContain('Budget: 1000/4000 tokens')
    })

    it('returns an empty array when the queue is empty', () => {
      const injector = new ReminderInjector(buildRegistry())
      expect(injector.drain({ turnIndex: 0 })).toEqual([])
    })

    it('clears the queue after draining', () => {
      const injector = new ReminderInjector(buildRegistry())
      injector.emit({ type: 'mode.entered', modeName: 'plan' })

      injector.drain({ turnIndex: 0 })

      expect(injector.size).toBe(0)
      expect(injector.drain({ turnIndex: 1 })).toEqual([])
    })

    it('drops templates that render to whitespace-only output', () => {
      const injector = new ReminderInjector(buildRegistry())
      injector.emit({ type: 'task.nudge' })

      expect(injector.drain({ turnIndex: 0 })).toEqual([])
    })

    it('renders all templates registered for the same event type', () => {
      const registry = buildRegistry()
      registry.register(
        defineTemplate({
          id: 'mode.entered.extra',
          eventType: 'mode.entered',
          suppressible: true,
          render: (event) => `Extra: ${event.modeName}`,
        }),
      )
      const injector = new ReminderInjector(registry)
      injector.emit({ type: 'mode.entered', modeName: 'plan' })

      const out = injector.drain({ turnIndex: 0 })

      expect(out).toHaveLength(2)
      expect(out[0]).toContain('Mode: plan')
      expect(out[1]).toContain('Extra: plan')
    })

    it('silently drops events with no registered template', () => {
      const injector = new ReminderInjector(new ReminderRegistry())
      injector.emit({ type: 'mode.entered', modeName: 'plan' })

      expect(injector.drain({ turnIndex: 0 })).toEqual([])
    })
  })

  describe('suppression', () => {
    it('silences a suppressible template by id', () => {
      const injector = new ReminderInjector(buildRegistry(), {
        suppress: ['budget.warn.default'],
      })
      injector.emit({ type: 'budget.warn', used: 1, total: 10, currency: 'usd' })

      expect(injector.drain({ turnIndex: 0 })).toEqual([])
      expect(injector.isSuppressed('budget.warn.default')).toBe(true)
    })

    it('does NOT silence a non-suppressible template even when its id is in the suppress list', () => {
      const injector = new ReminderInjector(buildRegistry(), {
        suppress: ['mode.entered.default'],
      })
      injector.emit({ type: 'mode.entered', modeName: 'plan' })

      const out = injector.drain({ turnIndex: 0 })
      expect(out).toHaveLength(1)
      expect(out[0]).toContain('Mode: plan')
    })

    it('only suppresses the targeted template; siblings still render', () => {
      const registry = buildRegistry()
      registry.register(
        defineTemplate({
          id: 'budget.warn.extra',
          eventType: 'budget.warn',
          suppressible: true,
          render: (event) => `Extra: ${event.used}`,
        }),
      )
      const injector = new ReminderInjector(registry, {
        suppress: ['budget.warn.default'],
      })
      injector.emit({ type: 'budget.warn', used: 5, total: 10, currency: 'usd' })

      const out = injector.drain({ turnIndex: 0 })
      expect(out).toHaveLength(1)
      expect(out[0]).toContain('Extra: 5')
    })
  })

  describe('pending + clear', () => {
    it('pending() returns a snapshot without draining', () => {
      const injector = new ReminderInjector(buildRegistry())
      injector.emit({ type: 'mode.entered', modeName: 'plan' })
      injector.emit({ type: 'task.nudge' })

      const snapshot = injector.pending()

      expect(snapshot).toHaveLength(2)
      expect(injector.size).toBe(2)
      expect(snapshot[0]?.event.type).toBe('mode.entered')
      expect(snapshot[1]?.event.type).toBe('task.nudge')
    })

    it('pending() entries carry a finite enqueuedAt timestamp', () => {
      const injector = new ReminderInjector(buildRegistry())
      injector.emit({ type: 'task.nudge' })

      const ts = injector.pending()[0]?.enqueuedAt
      expect(typeof ts).toBe('number')
      expect(Number.isFinite(ts)).toBe(true)
    })

    it('clear() empties the queue without rendering', () => {
      const injector = new ReminderInjector(buildRegistry())
      injector.emit({ type: 'mode.entered', modeName: 'plan' })

      injector.clear()

      expect(injector.size).toBe(0)
      expect(injector.drain({ turnIndex: 0 })).toEqual([])
    })
  })
})
