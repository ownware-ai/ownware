/**
 * Contract: Product catalog validation + profile-policy enforcement.
 *
 * Covers the boundary guards added in the product-model-cleanup work:
 *   • POST /api/v1/profiles validates `productId` against the canonical
 *     catalog (unknown slug → 400) and enforces `profilePolicy` (closed
 *     product → 403).
 *   • POST /api/v1/profiles/:id/duplicate cannot fork a profile that lives
 *     in a closed product (→ 403).
 *
 * These are the kernel-side enforcement that the old client-side
 * "display-only" policy never had.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestGateway, type TestGateway } from '../harness/index.js'

describe('Contract: Product policy enforcement', () => {
  let gw: TestGateway

  beforeAll(async () => {
    gw = await createTestGateway({
      profiles: [
        // A profile seeded INTO a closed product, to test the fork gate.
        { name: 'closed-design-agent', productId: 'ownware-design' },
        // A profile in the open product, to prove forking IS allowed there.
        { name: 'open-ownware-agent', productId: 'ownware' },
      ],
    })
  })

  afterAll(async () => {
    await gw.stop()
  })

  // ── create: catalog validation ──────────────────────────────────────────

  it('POST /profiles accepts a known OPEN product (201)', async () => {
    const r = await gw.client.post('/api/v1/profiles', {
      name: 'custom-open-1',
      productId: 'ownware',
      description: 'a custom profile in the open product',
    })
    expect(r.status).toBe(201)
  })

  it('POST /profiles rejects an UNKNOWN product (400)', async () => {
    const r = await gw.client.post('/api/v1/profiles', {
      name: 'custom-unknown-1',
      productId: 'ownware-trade',
      description: 'targets a product that does not exist',
    })
    expect(r.status).toBe(400)
    expect(JSON.stringify(r.body)).toContain('Unknown product')
  })

  it('POST /profiles still rejects a missing productId (400)', async () => {
    const r = await gw.client.post('/api/v1/profiles', {
      name: 'custom-noproduct-1',
      description: 'no productId at all',
    })
    expect(r.status).toBe(400)
  })

  // ── create: policy enforcement ──────────────────────────────────────────

  it('POST /profiles rejects a CLOSED product (403)', async () => {
    const r = await gw.client.post('/api/v1/profiles', {
      name: 'custom-design-1',
      productId: 'ownware-design',
      description: 'should be blocked — closed product',
    })
    expect(r.status).toBe(403)
    expect(JSON.stringify(r.body)).toContain('does not accept custom profiles')
  })

  it('POST /profiles rejects the coming-soon CLOSED product too (403)', async () => {
    const r = await gw.client.post('/api/v1/profiles', {
      name: 'custom-marketing-1',
      productId: 'ownware-marketing',
    })
    expect(r.status).toBe(403)
  })

  // ── duplicate / fork: policy enforcement ────────────────────────────────

  it('POST /profiles/:id/duplicate is blocked for a CLOSED-product source (403)', async () => {
    const r = await gw.client.post(
      '/api/v1/profiles/closed-design-agent/duplicate',
      { name: 'forked-design' },
    )
    expect(r.status).toBe(403)
    expect(JSON.stringify(r.body)).toContain('does not accept custom profiles')
  })

  it('POST /profiles/:id/duplicate is allowed for an OPEN-product source (201)', async () => {
    const r = await gw.client.post(
      '/api/v1/profiles/open-ownware-agent/duplicate',
      { name: 'forked-open' },
    )
    expect(r.status).toBe(201)
  })
})
