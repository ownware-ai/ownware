/**
 * Unit Tests — Hook Registry
 */

import { describe, it, expect } from 'vitest'

import { HookRegistry } from '../../../src/hooks/registry.js'
import type { HookSpec } from '../../../src/hooks/types.js'

function fnHook(name: string): HookSpec {
  return { type: 'fn', name, fn: async () => ({ continue: true }) }
}

describe('HookRegistry', () => {
  it('stores hooks by event in registration order', () => {
    const reg = new HookRegistry()
    const a = fnHook('a')
    const b = fnHook('b')

    reg.register('tool.pre', a).register('tool.pre', b)

    expect(reg.for('tool.pre')).toEqual([a, b])
  })

  it('keeps event bindings isolated', () => {
    const reg = new HookRegistry()
    const pre = fnHook('pre')
    const post = fnHook('post')

    reg.register('tool.pre', pre).register('tool.post', post)

    expect(reg.for('tool.pre')).toEqual([pre])
    expect(reg.for('tool.post')).toEqual([post])
  })

  it('returns an empty array for unbound events', () => {
    const reg = new HookRegistry()
    expect(reg.for('session.start')).toEqual([])
    expect(reg.has('session.start')).toBe(false)
  })

  it('reports has + size correctly', () => {
    const reg = new HookRegistry()
    expect(reg.size).toBe(0)
    reg.register('tool.pre', fnHook('a'))
    reg.register('tool.post', fnHook('b'))
    reg.register('tool.post', fnHook('c'))
    expect(reg.size).toBe(3)
    expect(reg.has('tool.pre')).toBe(true)
    expect(reg.has('user.prompt.submit')).toBe(false)
  })

  it('clear() drops every binding', () => {
    const reg = new HookRegistry()
    reg.register('tool.pre', fnHook('a'))
    reg.register('tool.post', fnHook('b'))

    reg.clear()

    expect(reg.size).toBe(0)
    expect(reg.for('tool.pre')).toEqual([])
    expect(reg.for('tool.post')).toEqual([])
  })
})
