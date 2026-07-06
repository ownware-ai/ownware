/**
 * Contract: workspace product wiring (T6 default-profile seed + T7 Zod).
 *
 *   • POST /api/v1/workspaces seeds `lastProfileId` from the product manifest
 *     (default product → defaultProfileId) so a fresh workspace lands on a
 *     real agent instead of null.
 *   • PUT /api/v1/workspaces/:id validates `activeProducts` against the
 *     canonical catalog (unknown slug → 400, empty → 400) via Zod.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestGateway, type TestGateway } from '../harness/index.js'

interface WsResp {
  readonly id: string
  readonly lastProfileId: string | null
  readonly activeProducts: readonly string[]
}

async function freshDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'cortex-ws-prod-'))
}

describe('Contract: workspace product wiring', () => {
  let gw: TestGateway

  beforeAll(async () => {
    gw = await createTestGateway()
  })

  afterAll(async () => {
    await gw.stop()
  })

  it('POST /workspaces seeds lastProfileId from the manifest default (T6)', async () => {
    const path = await freshDir()
    const r = await gw.client.post<WsResp>('/api/v1/workspaces', { path, name: 'Seed WS' })
    expect(r.status).toBe(201)
    // New workspace defaults to product 'ownware', whose default profile is 'ownware'.
    expect(r.body.activeProducts).toEqual(['ownware'])
    expect(r.body.lastProfileId).toBe('ownware')
  })

  it('PUT /workspaces accepts known product slugs (T7)', async () => {
    const path = await freshDir()
    const created = await gw.client.post<WsResp>('/api/v1/workspaces', { path })
    const r = await gw.client.put<WsResp>(`/api/v1/workspaces/${created.body.id}`, {
      activeProducts: ['ownware', 'ownware-design'],
    })
    expect(r.status).toBe(200)
    expect(r.body.activeProducts).toEqual(['ownware', 'ownware-design'])
  })

  it('PUT /workspaces rejects an unknown product slug (T7 → 400)', async () => {
    const path = await freshDir()
    const created = await gw.client.post<WsResp>('/api/v1/workspaces', { path })
    const r = await gw.client.put(`/api/v1/workspaces/${created.body.id}`, {
      activeProducts: ['ownware', 'ownware-trade'],
    })
    expect(r.status).toBe(400)
    expect(JSON.stringify(r.body)).toContain('unknown product')
  })

  it('PUT /workspaces rejects an empty activeProducts array (T7 → 400)', async () => {
    const path = await freshDir()
    const created = await gw.client.post<WsResp>('/api/v1/workspaces', { path })
    const r = await gw.client.put(`/api/v1/workspaces/${created.body.id}`, {
      activeProducts: [],
    })
    expect(r.status).toBe(400)
  })
})
