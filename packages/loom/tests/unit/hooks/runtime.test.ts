/**
 * Unit Tests — Hook Runtime
 *
 * Covers: ordering, blocking, reminder emission, error handling,
 * timeout enforcement (via fn hook), and the no-hooks fast path.
 */

import { describe, it, expect } from 'vitest'

import { HookRegistry } from '../../../src/hooks/registry.js'
import { HookRuntime } from '../../../src/hooks/runtime.js'
import {
  ReminderInjector,
  ReminderRegistry,
} from '../../../src/reminders/index.js'
import { defineTemplate } from '../../../src/reminders/types.js'
import type { HookContext, HookSpec } from '../../../src/hooks/types.js'

function buildReminders() {
  const reg = new ReminderRegistry()
  reg.register(
    defineTemplate({
      id: 'test.hook.blocked',
      eventType: 'hook.blocked',
      suppressible: false,
      render: (e) => `BLOCK ${e.hookName}: ${e.reason}`,
    }),
  )
  reg.register(
    defineTemplate({
      id: 'test.hook.success',
      eventType: 'hook.success',
      suppressible: true,
      render: (e) => `OK ${e.hookName}: ${e.output}`,
    }),
  )
  reg.register(
    defineTemplate({
      id: 'test.hook.context',
      eventType: 'hook.context',
      suppressible: true,
      render: (e) => `CTX ${e.hookName}: ${e.context}`,
    }),
  )
  return new ReminderInjector(reg)
}

function fnHook(name: string, fn: HookSpec & { type: 'fn' }['fn']): HookSpec {
  return { type: 'fn', name, fn }
}

const TOOL_PRE_CTX: HookContext = {
  event: 'tool.pre',
  turnIndex: 0,
  toolName: 'shell',
  toolInput: { cmd: 'ls' },
}

describe('HookRuntime', () => {
  it('returns continue:true when no hooks are bound', async () => {
    const runtime = new HookRuntime({ registry: new HookRegistry() })
    const result = await runtime.run(TOOL_PRE_CTX)
    expect(result).toEqual({ continue: true })
  })

  it('runs a single fn hook and returns its allow result', async () => {
    const reg = new HookRegistry()
    reg.register('tool.pre', fnHook('a', async () => ({ continue: true })))
    const runtime = new HookRuntime({ registry: reg })

    expect(await runtime.run(TOOL_PRE_CTX)).toEqual({ continue: true })
  })

  it('blocks the chain when a hook returns continue:false', async () => {
    const reg = new HookRegistry()
    let secondCalled = false
    reg.register('tool.pre', fnHook('blocker', async () => ({ continue: false, reason: 'no shell' })))
    reg.register('tool.pre', fnHook('after', async () => {
      secondCalled = true
      return { continue: true }
    }))
    const runtime = new HookRuntime({ registry: reg })

    const result = await runtime.run(TOOL_PRE_CTX)

    expect(result).toEqual({
      continue: false,
      blockedHook: 'blocker',
      blockedReason: 'no shell',
    })
    expect(secondCalled).toBe(false)
  })

  it('emits hook.blocked on the injector when blocking', async () => {
    const reminders = buildReminders()
    const reg = new HookRegistry()
    reg.register('tool.pre', fnHook('blocker', async () => ({ continue: false, reason: 'no shell' })))
    const runtime = new HookRuntime({ registry: reg, reminders })

    await runtime.run(TOOL_PRE_CTX)

    const out = reminders.drain({ turnIndex: 0 })
    expect(out).toHaveLength(1)
    expect(out[0]).toContain('BLOCK blocker: no shell')
  })

  it('emits hook.success when output is provided', async () => {
    const reminders = buildReminders()
    const reg = new HookRegistry()
    reg.register('tool.pre', fnHook('logger', async () => ({ continue: true, output: 'all good' })))
    const runtime = new HookRuntime({ registry: reg, reminders })

    await runtime.run(TOOL_PRE_CTX)

    const out = reminders.drain({ turnIndex: 0 })
    expect(out).toHaveLength(1)
    expect(out[0]).toContain('OK logger: all good')
  })

  it('emits hook.context only when additionalContext is non-empty', async () => {
    const reminders = buildReminders()
    const reg = new HookRegistry()
    reg.register('tool.pre', fnHook('ctx-empty', async () => ({ continue: true, additionalContext: '   ' })))
    reg.register('tool.pre', fnHook('ctx-full', async () => ({ continue: true, additionalContext: 'remember X' })))
    const runtime = new HookRuntime({ registry: reg, reminders })

    await runtime.run(TOOL_PRE_CTX)

    const out = reminders.drain({ turnIndex: 0 })
    expect(out).toHaveLength(1)
    expect(out[0]).toContain('CTX ctx-full: remember X')
  })

  it('omitting continue means allow', async () => {
    const reg = new HookRegistry()
    reg.register('tool.pre', fnHook('quiet', async () => ({})))
    const runtime = new HookRuntime({ registry: reg })

    expect(await runtime.run(TOOL_PRE_CTX)).toEqual({ continue: true })
  })

  it('catches a thrown fn hook and converts it to a block', async () => {
    const reg = new HookRegistry()
    reg.register('tool.pre', fnHook('boom', async () => {
      throw new Error('kaboom')
    }))
    const runtime = new HookRuntime({ registry: reg })

    const result = await runtime.run(TOOL_PRE_CTX)
    expect(result.continue).toBe(false)
    expect(result.blockedHook).toBe('boom')
    expect(result.blockedReason).toBe('kaboom')
  })

  it('honors fn hook timeoutMs and converts to a block', async () => {
    const reg = new HookRegistry()
    reg.register('tool.pre', {
      type: 'fn',
      name: 'slow',
      timeoutMs: 25,
      fn: () => new Promise((resolve) => setTimeout(() => resolve({ continue: true }), 200)),
    })
    const runtime = new HookRuntime({ registry: reg })

    const result = await runtime.run(TOOL_PRE_CTX)
    expect(result.continue).toBe(false)
    expect(result.blockedReason).toMatch(/timed out/i)
  })

  it('has(event) returns true iff at least one hook is bound', () => {
    const reg = new HookRegistry()
    const runtime = new HookRuntime({ registry: reg })
    expect(runtime.has('tool.pre')).toBe(false)
    reg.register('tool.pre', fnHook('a', async () => ({ continue: true })))
    expect(runtime.has('tool.pre')).toBe(true)
  })
})
