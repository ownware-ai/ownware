/**
 * Contract: Providers endpoints
 *
 * GET    /api/v1/providers
 * POST   /api/v1/providers
 * POST   /api/v1/providers/validate (NEEDS API KEY)
 * DELETE /api/v1/providers/:provider
 * GET    /api/v1/providers/:provider/key
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestGateway, type TestGateway } from '../harness/index.js'

const HAS_KEY = !!process.env['ANTHROPIC_API_KEY'] && !process.env['ANTHROPIC_API_KEY']!.includes('OWNWARE_TEST_DUMMY')

describe('Contract: Providers', () => {
  let gw: TestGateway

  beforeAll(async () => {
    gw = await createTestGateway()
  })

  afterAll(async () => {
    await gw.stop()
  })

  it('GET /providers returns array', async () => {
    const r = await gw.client.get<unknown[]>('/api/v1/providers')
    expect(r.status).toBe(200)
    expect(Array.isArray(r.body)).toBe(true)
  })

  it('POST /providers saves a key', async () => {
    const r = await gw.client.post<{ provider?: string; keyHint?: string }>('/api/v1/providers', {
      provider: 'anthropic',
      key: 'sk-ant-test12345678901234567890',
    })
    expect([200, 201]).toContain(r.status)
    expect(r.body.provider).toBe('anthropic')
  })

  it('GET /providers lists saved provider', async () => {
    await gw.client.post('/api/v1/providers', {
      provider: 'anthropic',
      key: 'sk-ant-test12345678901234567890',
    })
    const r = await gw.client.get<Array<{ provider: string; keyHint: string }>>('/api/v1/providers')
    const anthropic = r.body.find(p => p.provider === 'anthropic')
    expect(anthropic).toBeDefined()
    expect(typeof anthropic?.keyHint).toBe('string')
  })

  it('DELETE /providers/:provider removes key', async () => {
    await gw.client.post('/api/v1/providers', {
      provider: 'anthropic',
      key: 'sk-ant-test12345678901234567890',
    })
    const del = await gw.client.delete('/api/v1/providers/anthropic')
    expect([200, 204]).toContain(del.status)
  })

  it.skipIf(!HAS_KEY)('POST /providers/validate with real key returns isValid: true', async () => {
    const r = await gw.client.post<{ isValid: boolean }>('/api/v1/providers/validate', {
      provider: 'anthropic',
      key: process.env['ANTHROPIC_API_KEY'],
    })
    expect(r.status).toBe(200)
    expect(r.body.isValid).toBe(true)
  }, 30_000)
})
