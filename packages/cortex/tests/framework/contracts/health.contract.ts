/**
 * Contract: Health & Meta endpoints
 *
 * GET /api/v1/health
 * GET /api/v1/app/version
 * GET /api/v1/connectivity
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestGateway, type TestGateway } from '../harness/index.js'

describe('Contract: Health & Meta', () => {
  let gw: TestGateway

  beforeAll(async () => {
    gw = await createTestGateway()
  })

  afterAll(async () => {
    await gw.stop()
  })

  it('GET /health returns 200 with status field', async () => {
    const r = await gw.client.get<{ status: string }>('/api/v1/health')
    expect(r.status).toBe(200)
    expect(typeof r.body.status).toBe('string')
  })

  it('GET /app/version returns version info', async () => {
    const r = await gw.client.get<{ version: string }>('/api/v1/app/version')
    expect(r.status).toBe(200)
    expect(typeof r.body.version).toBe('string')
  })

  it('GET /connectivity returns connectivity status', async () => {
    const r = await gw.client.get('/api/v1/connectivity')
    expect(r.status).toBe(200)
  })
})
