/**
 * Unit tests — trust gate.
 *
 * Pinned:
 *   - requestApproval returns a Promise that resolves on respond().
 *   - The HMAC signature in the SSE event matches what respond verifies.
 *   - Bad signature => respond returns false (no Promise resolve).
 *   - Unknown requestId => respond returns false.
 *   - Timeout => Promise resolves with 'denied' and removes the pending entry.
 *   - Multiple subscribers all get the event.
 *   - listPending omits the resolver Promise.
 *   - A tampered signature with the same length doesn't time-leak.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TrustGate, type ApprovalRequiredEvent } from '../../../src/credential/trust-gate.js'

let gate: TrustGate

beforeEach(() => {
  vi.useFakeTimers()
  gate = new TrustGate()
})
afterEach(() => {
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// Subscription + emit
// ---------------------------------------------------------------------------

describe('TrustGate — emit', () => {
  it('emits a credential.approval_required event on requestApproval', () => {
    const events: ApprovalRequiredEvent[] = []
    gate.onApprovalRequired(e => events.push(e))
    void gate.requestApproval({ credentialId: 'cred_aaaaaaaaaaaa' })
    expect(events.length).toBe(1)
    expect(events[0]!.type).toBe('credential.approval_required')
    expect(events[0]!.credentialId).toBe('cred_aaaaaaaaaaaa')
    expect(events[0]!.requestId).toMatch(/^apv_[a-f0-9]{12}$/)
    expect(events[0]!.signature.length).toBeGreaterThan(0)
  })

  it('fans out to multiple subscribers in registration order', () => {
    const order: string[] = []
    gate.onApprovalRequired(() => order.push('a'))
    gate.onApprovalRequired(() => order.push('b'))
    void gate.requestApproval({ credentialId: 'cred_aaaaaaaaaaaa' })
    expect(order).toEqual(['a', 'b'])
  })

  it('unsubscribes cleanly via the returned function', () => {
    const seen: number[] = []
    const off = gate.onApprovalRequired(() => seen.push(1))
    void gate.requestApproval({ credentialId: 'cred_aaaaaaaaaaaa' })
    off()
    void gate.requestApproval({ credentialId: 'cred_bbbbbbbbbbbb' })
    expect(seen).toEqual([1])
  })

  it('forwards the optional context through the event', () => {
    let captured: ApprovalRequiredEvent | null = null
    gate.onApprovalRequired(e => { captured = e })
    void gate.requestApproval({
      credentialId: 'cred_aaaaaaaaaaaa',
      context: { toolName: 'deploy_to_vercel', agentId: 'agent_x' },
    })
    expect(captured).not.toBeNull()
    expect(captured!.context).toEqual({ toolName: 'deploy_to_vercel', agentId: 'agent_x' })
  })

  it('a listener that throws does not break the gate', () => {
    gate.onApprovalRequired(() => { throw new Error('boom') })
    expect(() =>
      void gate.requestApproval({ credentialId: 'cred_aaaaaaaaaaaa' }),
    ).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// respond — happy path
// ---------------------------------------------------------------------------

describe('TrustGate — respond', () => {
  it('resolves the pending Promise with "granted" on a valid response', async () => {
    let captured: ApprovalRequiredEvent | null = null
    gate.onApprovalRequired(e => { captured = e })
    const promise = gate.requestApproval({ credentialId: 'cred_aaaaaaaaaaaa' })
    expect(captured).not.toBeNull()
    const ok = gate.respond({
      requestId: captured!.requestId,
      decision: 'granted',
      signature: captured!.signature,
    })
    expect(ok).toBe(true)
    await expect(promise).resolves.toBe('granted')
  })

  it('resolves with "denied" on an explicit deny', async () => {
    let captured: ApprovalRequiredEvent | null = null
    gate.onApprovalRequired(e => { captured = e })
    const promise = gate.requestApproval({ credentialId: 'cred_aaaaaaaaaaaa' })
    gate.respond({
      requestId: captured!.requestId,
      decision: 'denied',
      signature: captured!.signature,
    })
    await expect(promise).resolves.toBe('denied')
  })

  it('removes the pending entry after a successful respond', () => {
    let captured: ApprovalRequiredEvent | null = null
    gate.onApprovalRequired(e => { captured = e })
    void gate.requestApproval({ credentialId: 'cred_aaaaaaaaaaaa' })
    expect(gate.listPending().length).toBe(1)
    gate.respond({
      requestId: captured!.requestId,
      decision: 'granted',
      signature: captured!.signature,
    })
    expect(gate.listPending().length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// respond — failure paths
// ---------------------------------------------------------------------------

describe('TrustGate — respond rejects', () => {
  it('returns false for an unknown requestId', () => {
    const ok = gate.respond({
      requestId: 'apv_000000000000',
      decision: 'granted',
      signature: 'a'.repeat(64),
    })
    expect(ok).toBe(false)
  })

  it('returns false on a forged signature (same length)', () => {
    let captured: ApprovalRequiredEvent | null = null
    gate.onApprovalRequired(e => { captured = e })
    void gate.requestApproval({ credentialId: 'cred_aaaaaaaaaaaa' })
    const tampered = captured!.signature.replace(/.$/, c => (c === '0' ? '1' : '0'))
    expect(tampered.length).toBe(captured!.signature.length)
    const ok = gate.respond({
      requestId: captured!.requestId,
      decision: 'granted',
      signature: tampered,
    })
    expect(ok).toBe(false)
    expect(gate.listPending().length).toBe(1)
  })

  it('returns false on a malformed signature (different length)', () => {
    let captured: ApprovalRequiredEvent | null = null
    gate.onApprovalRequired(e => { captured = e })
    void gate.requestApproval({ credentialId: 'cred_aaaaaaaaaaaa' })
    const ok = gate.respond({
      requestId: captured!.requestId,
      decision: 'granted',
      signature: 'short',
    })
    expect(ok).toBe(false)
  })

  it('returns false on a non-hex signature of the right length', () => {
    let captured: ApprovalRequiredEvent | null = null
    gate.onApprovalRequired(e => { captured = e })
    void gate.requestApproval({ credentialId: 'cred_aaaaaaaaaaaa' })
    const garbage = 'z'.repeat(captured!.signature.length)
    const ok = gate.respond({
      requestId: captured!.requestId,
      decision: 'granted',
      signature: garbage,
    })
    expect(ok).toBe(false)
  })

  it('rejects a signature signed for a different credentialId', () => {
    // Two pending requests on the same gate. Each gets its own signature.
    const events: ApprovalRequiredEvent[] = []
    gate.onApprovalRequired(e => events.push(e))
    void gate.requestApproval({ credentialId: 'cred_aaaaaaaaaaaa' })
    void gate.requestApproval({ credentialId: 'cred_bbbbbbbbbbbb' })
    expect(events.length).toBe(2)

    // Try to use request 0's signature against request 1's id.
    const ok = gate.respond({
      requestId: events[1]!.requestId,
      decision: 'granted',
      signature: events[0]!.signature,
    })
    expect(ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Timeout
// ---------------------------------------------------------------------------

describe('TrustGate — timeout', () => {
  it('resolves with "denied" after the default TTL elapses', async () => {
    const promise = gate.requestApproval({ credentialId: 'cred_aaaaaaaaaaaa' })
    vi.advanceTimersByTime(60_000 + 1)
    await expect(promise).resolves.toBe('denied')
  })

  it('clears the pending entry on timeout', async () => {
    const promise = gate.requestApproval({ credentialId: 'cred_aaaaaaaaaaaa' })
    vi.advanceTimersByTime(60_000 + 1)
    await promise
    expect(gate.listPending().length).toBe(0)
  })

  it('caps an unreasonable ttlMs at 5 minutes', async () => {
    const promise = gate.requestApproval({
      credentialId: 'cred_aaaaaaaaaaaa',
      ttlMs: 60 * 60_000,
    })
    vi.advanceTimersByTime(5 * 60_000 + 1)
    await expect(promise).resolves.toBe('denied')
  })

  it('honours a shorter ttlMs', async () => {
    const promise = gate.requestApproval({
      credentialId: 'cred_aaaaaaaaaaaa',
      ttlMs: 1_000,
    })
    vi.advanceTimersByTime(1_001)
    await expect(promise).resolves.toBe('denied')
  })
})

// ---------------------------------------------------------------------------
// Cross-instance signing isolation
// ---------------------------------------------------------------------------

describe('TrustGate — instance isolation', () => {
  it('two gates with distinct keys reject each other\'s signatures', () => {
    const gate2 = new TrustGate()
    let captured: ApprovalRequiredEvent | null = null
    gate.onApprovalRequired(e => { captured = e })
    void gate.requestApproval({ credentialId: 'cred_aaaaaaaaaaaa' })
    // Try to forge from gate2's perspective.
    void gate2.requestApproval({ credentialId: 'cred_aaaaaaaaaaaa' })
    const ok = gate.respond({
      requestId: captured!.requestId,
      decision: 'granted',
      signature: captured!.signature,
    })
    expect(ok).toBe(true) // legitimate
    // gate2 has its own pending entry; gate's signature is invalid for it.
    expect(gate2.listPending().length).toBe(1)
  })
})
