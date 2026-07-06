/**
 * Unit tests — CredentialHITL.
 *
 * Mirrors the shape of Loom's HumanInTheLoop tests. Covers:
 *   - request/respond round-trip.
 *   - request/deny round-trip.
 *   - timeout-based deny.
 *   - pending-count reporting.
 *   - duplicate requestId rejected loudly.
 *   - denyAll / dispose cleanup.
 *   - respond/deny on unknown ids is a no-op (false return).
 */

import { describe, it, expect } from 'vitest'
import type { CredentialHandle } from '@ownware/loom'
import { CredentialHITL, type PendingCredentialRequest } from '../../../src/credential/hitl.js'

function makeRequest(requestId: string, overrides: Partial<PendingCredentialRequest> = {}): PendingCredentialRequest {
  return {
    requestId,
    label: 'Admin JWT',
    hint: 'devtools > localStorage',
    usage: 'bypass admin auth',
    placement: { type: 'env', variableName: 'ADMIN_JWT' },
    isRequired: true,
    createdAt: Date.now(),
    ...overrides,
  }
}

function makeHandle(credentialId = 'runtime_t_ADMIN_JWT'): CredentialHandle {
  return {
    credentialId,
    label: 'Admin JWT',
    placement: { type: 'env', variableName: 'ADMIN_JWT' },
    storedAt: Date.now(),
  }
}

describe('CredentialHITL', () => {
  it('resolves the Promise when respond is called', async () => {
    const hitl = new CredentialHITL({ timeoutMs: 10_000 })
    const handle = makeHandle()
    const pending = hitl.request(makeRequest('r1'))
    expect(hitl.pendingCount).toBe(1)

    hitl.respond('r1', handle)
    expect(await pending).toBe(handle)
    expect(hitl.pendingCount).toBe(0)
  })

  it('resolves null when deny is called', async () => {
    const hitl = new CredentialHITL({ timeoutMs: 10_000 })
    const pending = hitl.request(makeRequest('r1'))
    hitl.deny('r1')
    expect(await pending).toBeNull()
    expect(hitl.pendingCount).toBe(0)
  })

  it('resolves null on timeout', async () => {
    const hitl = new CredentialHITL({ timeoutMs: 30 })
    const result = await hitl.request(makeRequest('r1'))
    expect(result).toBeNull()
    expect(hitl.pendingCount).toBe(0)
  })

  it('rejects a duplicate requestId (programmer-bug surfacing)', async () => {
    const hitl = new CredentialHITL({ timeoutMs: 10_000 })
    const first = hitl.request(makeRequest('r1'))
    await expect(hitl.request(makeRequest('r1'))).rejects.toThrow(/duplicate requestId/)
    // Clean up the original to release the timer.
    hitl.deny('r1')
    await first
  })

  it('respond/deny on unknown id returns false without throwing', () => {
    const hitl = new CredentialHITL()
    expect(hitl.respond('missing', makeHandle())).toBe(false)
    expect(hitl.deny('missing')).toBe(false)
  })

  it('respond after deny is a no-op (no double-resolve)', async () => {
    const hitl = new CredentialHITL({ timeoutMs: 10_000 })
    const pending = hitl.request(makeRequest('r1'))
    expect(hitl.deny('r1')).toBe(true)
    expect(await pending).toBeNull()
    expect(hitl.respond('r1', makeHandle())).toBe(false)
  })

  it('listPending exposes pending requests (metadata only, no value)', () => {
    const hitl = new CredentialHITL({ timeoutMs: 10_000 })
    void hitl.request(makeRequest('r1'))
    void hitl.request(makeRequest('r2', { label: 'DB URL' }))
    const list = hitl.listPending()
    expect(list).toHaveLength(2)
    const labels = list.map(p => p.label).sort()
    expect(labels).toEqual(['Admin JWT', 'DB URL'])
    // Not a field — and must not be.
    for (const entry of list) {
      expect((entry as unknown as { value?: unknown }).value).toBeUndefined()
    }
    hitl.dispose()
  })

  it('denyAll resolves every pending request and returns count', async () => {
    const hitl = new CredentialHITL({ timeoutMs: 10_000 })
    const a = hitl.request(makeRequest('r1'))
    const b = hitl.request(makeRequest('r2'))
    expect(hitl.pendingCount).toBe(2)
    expect(hitl.denyAll()).toBe(2)
    expect(await a).toBeNull()
    expect(await b).toBeNull()
    expect(hitl.pendingCount).toBe(0)
  })

  it('dispose releases all pending requests', async () => {
    const hitl = new CredentialHITL({ timeoutMs: 10_000 })
    const a = hitl.request(makeRequest('r1'))
    hitl.dispose()
    expect(await a).toBeNull()
  })

  it('getPending returns the request shape without the resolver', () => {
    const hitl = new CredentialHITL({ timeoutMs: 10_000 })
    void hitl.request(makeRequest('r1', { label: 'X' }))
    const pending = hitl.getPending('r1')
    expect(pending?.label).toBe('X')
    expect(pending?.requestId).toBe('r1')
    hitl.deny('r1')
  })
})
