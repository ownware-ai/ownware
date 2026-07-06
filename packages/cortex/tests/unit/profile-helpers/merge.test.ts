/**
 * Unit tests for `deepMergePartial` — the JSON Merge Patch helper that
 * backs `PUT /api/v1/profiles/:id`. These tests pin the RFC 7396
 * semantics so future refactors can't silently change the contract.
 */

import { describe, it, expect } from 'vitest'
import { deepMergePartial } from '../../../src/profile/merge.js'

describe('deepMergePartial', () => {
  it('adds a new key at the root', () => {
    const out = deepMergePartial({ a: 1 }, { b: 2 })
    expect(out).toEqual({ a: 1, b: 2 })
  })

  it('overrides a primitive with patch value', () => {
    const out = deepMergePartial({ a: 1 }, { a: 2 })
    expect(out).toEqual({ a: 2 })
  })

  it('preserves sibling keys in nested objects (the F-15 case)', () => {
    const base = {
      security: {
        level: 'standard',
        permissionMode: 'ask',
        hitlTimeoutMs: 1_800_000,
        zones: { enabled: true, maxAutoZone: 'workspace' },
      },
    }
    const patch = { security: { level: 'strict' } }
    const out = deepMergePartial(base, patch)
    expect(out).toEqual({
      security: {
        level: 'strict',
        permissionMode: 'ask',
        hitlTimeoutMs: 1_800_000,
        zones: { enabled: true, maxAutoZone: 'workspace' },
      },
    })
  })

  it('merges recursively across multiple levels', () => {
    const base = { a: { b: { c: 1, d: 2 } } }
    const patch = { a: { b: { c: 99 } } }
    expect(deepMergePartial(base, patch)).toEqual({ a: { b: { c: 99, d: 2 } } })
  })

  it('replaces arrays wholesale (does NOT element-merge)', () => {
    const out = deepMergePartial({ tools: ['a', 'b'] }, { tools: ['c'] })
    expect(out).toEqual({ tools: ['c'] })
  })

  it('replaces an empty array with a non-empty one', () => {
    const out = deepMergePartial({ tags: [] }, { tags: ['x'] })
    expect(out).toEqual({ tags: ['x'] })
  })

  it('replaces a non-empty array with an empty one', () => {
    const out = deepMergePartial({ tags: ['x'] }, { tags: [] })
    expect(out).toEqual({ tags: [] })
  })

  it('deletes a key when patch value is null (RFC 7396)', () => {
    const out = deepMergePartial({ a: 1, b: 2 }, { a: null })
    expect(out).toEqual({ b: 2 })
    expect('a' in out).toBe(false)
  })

  it('ignores undefined patch values (keeps base)', () => {
    const out = deepMergePartial({ a: 1 }, { a: undefined })
    expect(out).toEqual({ a: 1 })
  })

  it('treats type mismatch as patch-wins (object → array)', () => {
    const out = deepMergePartial({ x: { nested: 1 } }, { x: ['replaced'] })
    expect(out).toEqual({ x: ['replaced'] })
  })

  it('treats type mismatch as patch-wins (array → object)', () => {
    const out = deepMergePartial({ x: [1, 2] }, { x: { a: 1 } })
    expect(out).toEqual({ x: { a: 1 } })
  })

  it('treats type mismatch as patch-wins (primitive → object)', () => {
    const out = deepMergePartial({ x: 'str' }, { x: { a: 1 } })
    expect(out).toEqual({ x: { a: 1 } })
  })

  it('does not mutate the base input', () => {
    const base = { security: { level: 'standard' } }
    const snapshot = JSON.parse(JSON.stringify(base))
    deepMergePartial(base, { security: { level: 'strict' } })
    expect(base).toEqual(snapshot)
  })

  it('does not mutate the patch input', () => {
    const patch = { security: { level: 'strict' } }
    const snapshot = JSON.parse(JSON.stringify(patch))
    deepMergePartial({ security: { level: 'standard' } }, patch)
    expect(patch).toEqual(snapshot)
  })

  it('returns a fresh object when patch is empty', () => {
    const base = { a: 1 }
    const out = deepMergePartial(base, {})
    expect(out).toEqual({ a: 1 })
    expect(out).not.toBe(base)
  })

  it('handles empty base', () => {
    const out = deepMergePartial({}, { a: 1, b: { c: 2 } })
    expect(out).toEqual({ a: 1, b: { c: 2 } })
  })

  it('null in a nested patch deletes the nested key, not the parent', () => {
    const base = { security: { level: 'standard', permissionMode: 'ask' } }
    const patch = { security: { permissionMode: null } }
    const out = deepMergePartial(base, patch)
    expect(out).toEqual({ security: { level: 'standard' } })
    expect('permissionMode' in (out['security'] as object)).toBe(false)
  })

  it('treats a class instance as an opaque value (replace, do not recurse)', () => {
    class Box { constructor(public readonly v: number) {} }
    const base = { x: { a: 1 } }
    const patch = { x: new Box(7) }
    const out = deepMergePartial(base, patch)
    expect(out['x']).toBeInstanceOf(Box)
  })

  it('merges deeply without losing data on a realistic profile config', () => {
    const base = {
      name: 'legal',
      model: 'anthropic:claude-sonnet-4-20250514',
      security: {
        level: 'standard',
        permissionMode: 'ask',
        sandbox: { enabled: false, provider: 'local' },
        zones: { enabled: true, maxAutoZone: 'workspace', overrides: [] },
        hitlTimeoutMs: 1_800_000,
      },
      tools: { preset: 'coding', deny: ['shell_execute'] },
    }
    const patch = {
      security: { level: 'strict', zones: { maxAutoZone: 'safe' } },
    }
    const out = deepMergePartial(base, patch)
    expect(out).toEqual({
      name: 'legal',
      model: 'anthropic:claude-sonnet-4-20250514',
      security: {
        level: 'strict',
        permissionMode: 'ask',
        sandbox: { enabled: false, provider: 'local' },
        zones: { enabled: true, maxAutoZone: 'safe', overrides: [] },
        hitlTimeoutMs: 1_800_000,
      },
      tools: { preset: 'coding', deny: ['shell_execute'] },
    })
  })
})
