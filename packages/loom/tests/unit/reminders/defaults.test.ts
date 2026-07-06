/**
 * Unit Tests — Default Reminder Templates
 */

import { describe, it, expect } from 'vitest'

import {
  defaultTemplates,
  createDefaultRegistry,
} from '../../../src/reminders/defaults.js'
import { ReminderInjector } from '../../../src/reminders/injector.js'
import type { ReminderEvent, ReminderEventType } from '../../../src/reminders/types.js'

const ALL_EVENT_TYPES: readonly ReminderEventType[] = [
  'mode.entered',
  'mode.exited',
  'hook.success',
  'hook.blocked',
  'hook.context',
  'compaction.done',
  'budget.warn',
  'mcp.empty',
  'tool.denied',
  'fs.modified',
  'task.nudge',
  'session.continued',
  'skills.previously-invoked',
]

describe('defaultTemplates', () => {
  it('covers every reminder event type', () => {
    const covered = new Set(defaultTemplates.map(t => t.eventType))
    for (const type of ALL_EVENT_TYPES) {
      expect(covered.has(type)).toBe(true)
    }
  })

  it('has unique template ids', () => {
    const ids = defaultTemplates.map(t => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('marks load-bearing templates as non-suppressible', () => {
    const nonSuppressible = defaultTemplates.filter(t => !t.suppressible).map(t => t.id)
    expect(nonSuppressible).toEqual(
      expect.arrayContaining([
        'reminders.mode.entered',
        'reminders.mode.exited',
        'reminders.hook.blocked',
        'reminders.tool.denied',
      ]),
    )
  })
})

describe('createDefaultRegistry', () => {
  it('registers every default template', () => {
    const registry = createDefaultRegistry()
    expect(registry.size).toBe(defaultTemplates.length)
    for (const tpl of defaultTemplates) {
      expect(registry.has(tpl.id)).toBe(true)
    }
  })

  it('renders sensible bodies for representative events end-to-end', () => {
    const registry = createDefaultRegistry()
    const injector = new ReminderInjector(registry)

    const events: readonly ReminderEvent[] = [
      { type: 'mode.entered', modeName: 'plan' },
      { type: 'mode.exited', modeName: 'plan', outcome: 'approved' },
      { type: 'hook.success', hookName: 'lint', output: 'no issues' },
      { type: 'hook.blocked', hookName: 'pre-commit', reason: 'tests failed' },
      { type: 'hook.context', hookName: 'env-check', context: 'NODE_ENV=production' },
      { type: 'compaction.done', preTokens: 10000, postTokens: 4000 },
      { type: 'budget.warn', used: 800, total: 1000, currency: 'tokens' },
      { type: 'mcp.empty', server: 'docs', uri: 'doc://x' },
      { type: 'tool.denied', toolName: 'shell', reason: 'permission denied' },
      { type: 'fs.modified', path: '/tmp/foo.ts', source: 'linter' },
      { type: 'task.nudge' },
      { type: 'session.continued', newCwd: '/work/repo' },
    ]
    for (const e of events) injector.emit(e)

    const out = injector.drain({ turnIndex: 0 })

    expect(out).toHaveLength(events.length)
    for (const block of out) {
      expect(block.startsWith('<system-reminder>')).toBe(true)
      expect(block.endsWith('</system-reminder>')).toBe(true)
    }
    expect(out[0]).toContain('Mode active: plan')
    expect(out[1]).toContain('Mode exited: plan (approved)')
    expect(out[2]).toContain('Hook "lint" completed')
    expect(out[2]).toContain('no issues')
    expect(out[3]).toContain('blocked the action: tests failed')
    expect(out[4]).toContain('Additional context from hook "env-check"')
    expect(out[5]).toContain('10000 → 4000 tokens')
    expect(out[6]).toContain('800 of 1000 tokens')
    expect(out[7]).toContain('docs:doc://x')
    expect(out[8]).toContain('"shell" was denied')
    expect(out[9]).toContain('externally (linter)')
    expect(out[10]).toContain('3+ distinct steps')
    expect(out[11]).toContain('/work/repo')
  })

  it('drops empty hook.context payloads', () => {
    const registry = createDefaultRegistry()
    const injector = new ReminderInjector(registry)

    injector.emit({ type: 'hook.context', hookName: 'noop', context: '   ' })

    expect(injector.drain({ turnIndex: 0 })).toEqual([])
  })

  it('renders skills.previously-invoked with the skill name list', () => {
    const registry = createDefaultRegistry()
    const injector = new ReminderInjector(registry)

    injector.emit({ type: 'skills.previously-invoked', skills: ['simplify', 'review'] })

    const out = injector.drain({ turnIndex: 0 })
    expect(out).toHaveLength(1)
    expect(out[0]).toContain('`simplify`')
    expect(out[0]).toContain('`review`')
    expect(out[0]).toContain('do NOT re-execute their setup actions')
  })

  it('drops skills.previously-invoked when the skills list is empty', () => {
    const registry = createDefaultRegistry()
    const injector = new ReminderInjector(registry)

    injector.emit({ type: 'skills.previously-invoked', skills: [] })

    expect(injector.drain({ turnIndex: 0 })).toEqual([])
  })
})
