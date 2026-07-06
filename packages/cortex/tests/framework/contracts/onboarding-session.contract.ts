/**
 * Contract: Onboarding + Session endpoints
 *
 * POST /api/v1/onboarding/role
 * POST /api/v1/onboarding/complete
 * GET  /api/v1/session/state
 * POST /api/v1/session/restore
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestGateway, type TestGateway } from '../harness/index.js'

describe('Contract: Onboarding + Session', () => {
  let gw: TestGateway

  beforeAll(async () => {
    gw = await createTestGateway()
  })

  afterAll(async () => {
    await gw.stop()
  })

  it('POST /onboarding/role saves user role', async () => {
    const r = await gw.client.post('/api/v1/onboarding/role', {
      name: 'Test User',
      role: 'developer',
    })
    expect([200, 201]).toContain(r.status)
  })

  it('POST /onboarding/complete marks onboarding done', async () => {
    const r = await gw.client.post('/api/v1/onboarding/complete', {})
    expect([200, 201]).toContain(r.status)
  })

  it('GET /session/state returns session state object', async () => {
    const r = await gw.client.get<Record<string, unknown>>('/api/v1/session/state')
    expect(r.status).toBe(200)
    expect(typeof r.body).toBe('object')
  })

  it('POST /session/restore returns restore counts', async () => {
    // Pre-seed by creating a workspace + saving session
    gw.state.createWorkspace(gw.tmpDir, 'Restore test WS')
    gw.state.saveSessionState()

    const r = await gw.client.post<{ workspaceCount?: number; tabCount?: number }>(
      '/api/v1/session/restore',
      {},
    )
    expect([200, 201]).toContain(r.status)
  })
})
