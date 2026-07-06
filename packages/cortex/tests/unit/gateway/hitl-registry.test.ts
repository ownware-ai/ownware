/**
 * HITL registry — the contract every Human-In-The-Loop pause plugs
 * into so the gateway's abort path cancels them uniformly.
 *
 * These tests pin the three guarantees the registry must hold for the
 * abort handler to remain correct as HITLs are added:
 *
 *   1. `denyAllHitls` invokes `denyAll()` on every registered HITL,
 *      exactly once, in register order.
 *   2. A HITL whose `denyAll()` throws does NOT prevent subsequent
 *      HITLs from being denied (one bad HITL cannot stall abort).
 *   3. `asHitlLike` surfaces a LIVE `pendingCount` — spreading the
 *      source would capture a one-time snapshot because both real
 *      HITLs expose `pendingCount` as a getter.
 *
 * A failure in any of these re-introduces the "thread stuck running
 * after abort" class of bugs this infrastructure was built to prevent.
 */

import { describe, it, expect } from 'vitest'
import { asHitlLike, denyAllHitls, type HITLLike } from '../../../src/gateway/hitl-registry.js'

describe('asHitlLike', () => {
  it('forwards pendingCount live via a getter (not a one-time copy)', () => {
    let inner = 0
    const source = {
      get pendingCount() { return inner },
      denyAll() { inner = 0 },
    }
    const like = asHitlLike('perm', source)
    inner = 3
    expect(like.pendingCount).toBe(3)
    inner = 7
    expect(like.pendingCount).toBe(7)
  })

  it('forwards denyAll to the underlying source', () => {
    let called = 0
    const source = {
      pendingCount: 2,
      denyAll() { called += 1 },
    }
    const like = asHitlLike('cred', source)
    like.denyAll()
    like.denyAll()
    expect(called).toBe(2)
  })

  it('preserves the name field verbatim', () => {
    const like = asHitlLike('mfa', { pendingCount: 0, denyAll() {} })
    expect(like.name).toBe('mfa')
  })

  it('accepts a source whose denyAll returns a number (e.g. CredentialHITL)', () => {
    // CredentialHITL.denyAll returns the count of denied entries.
    // The HITLLike interface declares `denyAll(): void` — TS accepts
    // the narrower caller expectation; the registry simply ignores
    // the return. This test locks that behaviour in runtime too.
    const source = { pendingCount: 5, denyAll: () => 5 }
    const like = asHitlLike('cred', source)
    expect(() => like.denyAll()).not.toThrow()
  })
})

describe('denyAllHitls', () => {
  function make(name: string): HITLLike & { calls: number } {
    const h = {
      name,
      pendingCount: 0,
      calls: 0,
      denyAll() { this.calls += 1 },
    }
    return h
  }

  it('invokes denyAll exactly once on every registered HITL, in register order', () => {
    const a = make('a')
    const b = make('b')
    const c = make('c')
    const snapshot = denyAllHitls([a, b, c])
    expect(a.calls).toBe(1)
    expect(b.calls).toBe(1)
    expect(c.calls).toBe(1)
    expect(snapshot.map(s => s.name)).toEqual(['a', 'b', 'c'])
  })

  it('captures pendingBefore per HITL BEFORE calling denyAll', () => {
    // The snapshot lets the abort handler log "who was blocking".
    // Reading after denyAll would always report zero; reading before
    // is the useful forensic signal.
    const source = {
      _count: 4,
      denyAll() { this._count = 0 },
      get pendingCount() { return this._count },
    }
    const like = asHitlLike('x', source)
    const snap = denyAllHitls([like])
    expect(snap[0]!.pendingBefore).toBe(4)
    expect(like.pendingCount).toBe(0)
  })

  it('an individual denyAll that throws does not stop subsequent HITLs', () => {
    // If the second HITL (a buggy future one) throws, the third MUST
    // still be denied. Any shortcut here re-opens the "thread stuck
    // running forever" class of bugs.
    const good1 = make('good1')
    const good2 = make('good2')
    const bad: HITLLike = {
      name: 'bad',
      pendingCount: 1,
      denyAll() { throw new Error('intentional') },
    }
    // Capture the error log so the test output stays clean. We only
    // assert the sequencing, not the log shape.
    const originalError = console.error
    console.error = () => {}
    try {
      expect(() => denyAllHitls([good1, bad, good2])).not.toThrow()
    } finally {
      console.error = originalError
    }
    expect(good1.calls).toBe(1)
    expect(good2.calls).toBe(1)
  })

  it('is a no-op on an empty registry', () => {
    expect(() => denyAllHitls([])).not.toThrow()
    expect(denyAllHitls([])).toEqual([])
  })
})
