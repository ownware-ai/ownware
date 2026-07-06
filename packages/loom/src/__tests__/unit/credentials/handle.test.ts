/**
 * Unit tests — opaque CredentialHandle.
 *
 * The handle is deliberately small. The tests here exist to:
 *   - lock in the brand check (a plain string isn't a handle),
 *   - lock in the construction guard (`unsafeCreateHandle` rejects
 *     empty input),
 *   - lock in the type-guard's narrow shape check.
 *
 * Anything else (the token format, lookup behaviour) belongs in the
 * gateway resolver tests, not here — loom never inspects the token.
 */

import { describe, it, expect } from 'vitest'
import {
  isOpaqueCredentialHandle,
  unsafeCreateHandle,
} from '../../../credentials/handle.js'

describe('OpaqueCredentialHandle — construction', () => {
  it('produces a handle with the supplied token', () => {
    const handle = unsafeCreateHandle('abc123')
    expect(handle.token).toBe('abc123')
  })

  it('throws on an empty token', () => {
    expect(() => unsafeCreateHandle('')).toThrow()
  })

  it('throws on a non-string token', () => {
    expect(() => unsafeCreateHandle(undefined as unknown as string)).toThrow()
    expect(() => unsafeCreateHandle(123 as unknown as string)).toThrow()
  })
})

describe('isOpaqueCredentialHandle — type guard', () => {
  it('accepts a real handle', () => {
    expect(isOpaqueCredentialHandle(unsafeCreateHandle('x'))).toBe(true)
  })

  it('rejects null', () => {
    expect(isOpaqueCredentialHandle(null)).toBe(false)
  })

  it('rejects an empty object', () => {
    expect(isOpaqueCredentialHandle({})).toBe(false)
  })

  it('rejects an object with a non-string token', () => {
    expect(isOpaqueCredentialHandle({ token: 123 })).toBe(false)
  })

  it('rejects an object with an empty-string token', () => {
    expect(isOpaqueCredentialHandle({ token: '' })).toBe(false)
  })

  it('rejects a bare string', () => {
    expect(isOpaqueCredentialHandle('abc123')).toBe(false)
  })

  it('accepts an object that has token plus extra fields (forward-compat)', () => {
    expect(isOpaqueCredentialHandle({ token: 'x', extra: 1 })).toBe(true)
  })
})

describe('OpaqueCredentialHandle — serialization discipline', () => {
  it('JSON.stringify drops the brand symbol (no handle leakage in network payloads)', () => {
    const handle = unsafeCreateHandle('abc123')
    const json = JSON.stringify(handle)
    // Brand is `undefined` at runtime which JSON.stringify drops by
    // contract, so a serialised handle ONLY carries the token. Loom's
    // boundary parsers only care about the token.
    expect(JSON.parse(json)).toEqual({ token: 'abc123' })
  })
})
