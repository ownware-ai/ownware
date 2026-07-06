/**
 * Contract: Settings + Providers + Onboarding + Session endpoints
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestGateway, type TestGateway } from '../harness/index.js'
import { ApiErrorSchema } from '../harness/schema-validator.js'

describe('Contract: Settings', () => {
  let gw: TestGateway

  beforeAll(async () => {
    gw = await createTestGateway()
  })

  afterAll(async () => {
    await gw.stop()
  })

  it('GET /settings returns grouped object', async () => {
    const r = await gw.client.get<Record<string, unknown>>('/api/v1/settings')
    expect(r.status).toBe(200)
    expect(typeof r.body).toBe('object')
  })

  it('PUT /settings/:section saves string values', async () => {
    const r = await gw.client.put('/api/v1/settings/appearance', {
      theme: 'dark',
      fontSize: '14',
    })
    expect(r.status).toBe(200)

    // Read back
    const get = await gw.client.get<Record<string, Record<string, string>>>('/api/v1/settings')
    expect(get.body['appearance']?.['theme']).toBe('dark')
  })

  it('PUT /settings/:section returns 400 for non-string values', async () => {
    const r = await gw.client.put('/api/v1/settings/appearance', {
      fontSize: 14, // number, not string
    })
    expect(r.status).toBeGreaterThanOrEqual(400)
  })

  it('PUT /settings/:section returns 400 for empty body', async () => {
    const r = await gw.client.put('/api/v1/settings/appearance', {})
    expect(r.status).toBeGreaterThanOrEqual(400)
  })

  it('settings persist across multiple writes', async () => {
    await gw.client.put('/api/v1/settings/defaults', { model: 'anthropic:claude-haiku-4-5-20251001' })
    await gw.client.put('/api/v1/settings/defaults', { lang: 'en' })

    const r = await gw.client.get<Record<string, Record<string, string>>>('/api/v1/settings')
    expect(r.body['defaults']?.['model']).toBe('anthropic:claude-haiku-4-5-20251001')
    expect(r.body['defaults']?.['lang']).toBe('en')
  })
})
