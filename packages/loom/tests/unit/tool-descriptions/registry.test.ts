/**
 * Unit Tests — Tool Description Registry
 */

import { describe, it, expect } from 'vitest'

import { ToolDescriptionRegistry } from '../../../src/tools/descriptions/registry.js'
import type { ToolDescription } from '../../../src/tools/descriptions/types.js'

function desc(name: string, overview = `body of ${name}`): ToolDescription {
  return { name, sections: { overview } }
}

describe('ToolDescriptionRegistry', () => {
  it('register + get round-trips by name', () => {
    const reg = new ToolDescriptionRegistry()
    const a = desc('a')
    reg.register(a)
    expect(reg.get('a')).toBe(a)
    expect(reg.has('a')).toBe(true)
    expect(reg.has('missing')).toBe(false)
    expect(reg.size).toBe(1)
  })

  it('registerAll handles a batch in input order', () => {
    const reg = new ToolDescriptionRegistry()
    const all = [desc('a'), desc('b'), desc('c')]
    reg.registerAll(all)
    expect(reg.size).toBe(3)
    expect(reg.list()).toEqual(all)
  })

  it('re-registering the same name overwrites the prior entry', () => {
    const reg = new ToolDescriptionRegistry()
    reg.register(desc('a', 'first'))
    reg.register(desc('a', 'second'))
    expect(reg.size).toBe(1)
    expect(reg.get('a')?.sections.overview).toBe('second')
  })

  it('unregister removes by name and returns the boolean outcome', () => {
    const reg = new ToolDescriptionRegistry()
    reg.register(desc('a'))
    expect(reg.unregister('a')).toBe(true)
    expect(reg.unregister('a')).toBe(false)
    expect(reg.has('a')).toBe(false)
  })

  it('clear empties the registry', () => {
    const reg = new ToolDescriptionRegistry()
    reg.registerAll([desc('a'), desc('b')])
    reg.clear()
    expect(reg.size).toBe(0)
    expect(reg.list()).toEqual([])
  })
})
