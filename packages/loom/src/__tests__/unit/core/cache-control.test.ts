/**
 * Unit tests for the cache-control marker primitives.
 *
 * Covers the pure `buildCacheMarker` function and the constant
 * `DEFAULT_CACHE_PROFILE`. Everything downstream in the loop funnels
 * through these, so the shape the function returns is the shape the
 * provider sees on the wire.
 *
 * Invariants pinned here:
 *   - Default marker carries NO `ttl` field (`'5m'` is the provider
 *     default; emitting it explicitly is cosmetic noise that would
 *     pollute request diffs).
 *   - `ttl: '1h'` produces a marker with the extended tier attached.
 *   - Nullish profiles behave identically to the default.
 */

import { describe, it, expect } from 'vitest'
import {
  buildCacheMarker,
  DEFAULT_CACHE_PROFILE,
} from '../../../core/cache-control.js'

describe('DEFAULT_CACHE_PROFILE', () => {
  it('has ttl="5m" (the provider default tier)', () => {
    expect(DEFAULT_CACHE_PROFILE.ttl).toBe('5m')
  })

  it('is frozen — callers cannot mutate the shared default', () => {
    // Mutating a shared default would cause spooky cross-session effects
    // the moment two sessions run concurrently. Object.freeze catches it.
    expect(Object.isFrozen(DEFAULT_CACHE_PROFILE)).toBe(true)
  })
})

describe('buildCacheMarker', () => {
  it('undefined profile → bare ephemeral marker (no ttl field)', () => {
    const marker = buildCacheMarker(undefined)
    expect(marker).toEqual({ type: 'ephemeral' })
    // Explicit: the field must be absent, not present-with-undefined.
    expect('ttl' in marker).toBe(false)
  })

  it('null profile → bare ephemeral marker', () => {
    const marker = buildCacheMarker(null)
    expect(marker).toEqual({ type: 'ephemeral' })
    expect('ttl' in marker).toBe(false)
  })

  it('{ ttl: "5m" } → bare ephemeral marker (stripped to avoid redundancy)', () => {
    // Emitting `ttl: '5m'` is semantically identical to omitting the
    // field — it is the provider default. Stripping keeps the wire shape
    // minimal so diffs during debugging show only meaningful changes.
    const marker = buildCacheMarker({ ttl: '5m' })
    expect(marker).toEqual({ type: 'ephemeral' })
    expect('ttl' in marker).toBe(false)
  })

  it('{ ttl: "1h" } → ephemeral marker with ttl="1h"', () => {
    const marker = buildCacheMarker({ ttl: '1h' })
    expect(marker).toEqual({ type: 'ephemeral', ttl: '1h' })
  })

  it('empty object {} → bare ephemeral marker (ttl absent, default assumed)', () => {
    const marker = buildCacheMarker({})
    expect(marker).toEqual({ type: 'ephemeral' })
    expect('ttl' in marker).toBe(false)
  })

  it('returns a fresh object each call (callers can attach it to many blocks)', () => {
    // The loop emits the same marker on multiple blocks per request and
    // in the message-marker helper. If buildCacheMarker returned a shared
    // singleton, later mutation by a caller would corrupt every other
    // block. Separate objects per call is cheap insurance against that.
    const a = buildCacheMarker({ ttl: '1h' })
    const b = buildCacheMarker({ ttl: '1h' })
    expect(a).not.toBe(b)
    expect(a).toEqual(b)
  })
})
