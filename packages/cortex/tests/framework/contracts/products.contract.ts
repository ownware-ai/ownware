/**
 * Contract: GET /api/v1/products
 *
 * The canonical product catalog, cortex-owned. Verifies the endpoint exists,
 * returns the validated manifest shape (contract fields only), and exposes the
 * v1 product set with correct policies — the data every client builds on.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { z } from 'zod'
import { createTestGateway, type TestGateway } from '../harness/index.js'

const ProductWireSchema = z
  .object({
    slug: z.string().regex(/^[a-z][a-z0-9-]*$/),
    profilePolicy: z.enum(['open', 'closed']),
    defaultProfileId: z.string().min(1),
    status: z.enum(['ready', 'coming-soon']),
  })
  .strict()

describe('Contract: Products catalog', () => {
  let gw: TestGateway

  beforeAll(async () => {
    gw = await createTestGateway()
  })

  afterAll(async () => {
    await gw.stop()
  })

  it('GET /products returns the validated catalog (200)', async () => {
    const r = await gw.client.get('/api/v1/products', z.array(ProductWireSchema))
    expect(r.status).toBe(200)
    expect(r.body.length).toBeGreaterThanOrEqual(4)
  })

  it('exposes the v1 product set in canonical order', async () => {
    const r = await gw.client.get('/api/v1/products', z.array(ProductWireSchema))
    expect(r.body.map((p) => p.slug)).toEqual([
      'ownware',
      // Transitional standalone Coder vertical — shares the ownware-code team
      // with the legacy ownware-coder product (see src/product/manifest.ts).
      'coder',
      'ownware-coder',
      'ownware-design',
      'ownware-marketing',
    ])
  })

  it('declares the correct policy per product', async () => {
    const r = await gw.client.get('/api/v1/products', z.array(ProductWireSchema))
    const bySlug = new Map(r.body.map((p) => [p.slug, p]))
    expect(bySlug.get('ownware')?.profilePolicy).toBe('open')
    expect(bySlug.get('coder')?.profilePolicy).toBe('closed')
    expect(bySlug.get('ownware-coder')?.profilePolicy).toBe('closed')
    expect(bySlug.get('ownware-design')?.profilePolicy).toBe('closed')
    expect(bySlug.get('ownware-marketing')?.profilePolicy).toBe('closed')
  })
})
