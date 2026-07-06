/**
 * Unit Tests — Reminder Registry
 */

import { describe, it, expect } from 'vitest'

import { ReminderRegistry } from '../../../src/reminders/registry.js'
import { defineTemplate } from '../../../src/reminders/types.js'

function makeTemplate(id: string, eventType: 'mode.entered' | 'task.nudge' = 'mode.entered') {
  if (eventType === 'task.nudge') {
    return defineTemplate({
      id,
      eventType: 'task.nudge',
      suppressible: true,
      render: () => `nudge:${id}`,
    })
  }
  return defineTemplate({
    id,
    eventType: 'mode.entered',
    suppressible: false,
    render: (event) => `${id}:${event.modeName}`,
  })
}

describe('ReminderRegistry', () => {
  describe('register', () => {
    it('stores a template and indexes it by id and event type', () => {
      const registry = new ReminderRegistry()
      const tpl = makeTemplate('a')

      registry.register(tpl)

      expect(registry.size).toBe(1)
      expect(registry.has('a')).toBe(true)
      expect(registry.templatesFor('mode.entered')).toEqual([tpl])
    })

    it('throws when registering a duplicate id', () => {
      const registry = new ReminderRegistry()
      registry.register(makeTemplate('dup'))

      expect(() => registry.register(makeTemplate('dup'))).toThrow(/dup/)
    })

    it('preserves registration order across multiple templates of the same event type', () => {
      const registry = new ReminderRegistry()
      const a = makeTemplate('a')
      const b = makeTemplate('b')
      const c = makeTemplate('c')

      registry.register(a).register(b).register(c)

      expect(registry.templatesFor('mode.entered')).toEqual([a, b, c])
    })

    it('keeps event types isolated', () => {
      const registry = new ReminderRegistry()
      const m = makeTemplate('m', 'mode.entered')
      const n = makeTemplate('n', 'task.nudge')

      registry.register(m).register(n)

      expect(registry.templatesFor('mode.entered')).toEqual([m])
      expect(registry.templatesFor('task.nudge')).toEqual([n])
    })
  })

  describe('templatesFor', () => {
    it('returns an empty array for an unregistered event type', () => {
      const registry = new ReminderRegistry()
      expect(registry.templatesFor('mcp.empty')).toEqual([])
    })
  })

  describe('unregister', () => {
    it('removes a template by id and returns it', () => {
      const registry = new ReminderRegistry()
      const tpl = makeTemplate('x')
      registry.register(tpl)

      const removed = registry.unregister('x')

      expect(removed).toBe(tpl)
      expect(registry.has('x')).toBe(false)
      expect(registry.templatesFor('mode.entered')).toEqual([])
      expect(registry.size).toBe(0)
    })

    it('returns null when the id is not registered', () => {
      const registry = new ReminderRegistry()
      expect(registry.unregister('nope')).toBeNull()
    })

    it('keeps siblings of the same event type intact', () => {
      const registry = new ReminderRegistry()
      const a = makeTemplate('a')
      const b = makeTemplate('b')
      registry.register(a).register(b)

      registry.unregister('a')

      expect(registry.templatesFor('mode.entered')).toEqual([b])
    })
  })

  describe('all', () => {
    it('returns templates in registration order', () => {
      const registry = new ReminderRegistry()
      const a = makeTemplate('a')
      const b = makeTemplate('b', 'task.nudge')
      const c = makeTemplate('c')

      registry.register(a).register(b).register(c)

      expect(registry.all()).toEqual([a, b, c])
    })
  })

  describe('defineTemplate runtime guard', () => {
    it('throws when render is invoked with a mismatched event type', () => {
      const tpl = defineTemplate({
        id: 'guard.test',
        eventType: 'mode.entered',
        suppressible: false,
        render: () => 'ok',
      })

      expect(() =>
        tpl.render({ type: 'task.nudge' }, { turnIndex: 0 }),
      ).toThrow(/cannot render event of type "task.nudge"/)
    })
  })
})
