/**
 * Contract: Profiles endpoints
 *
 * GET /api/v1/profiles
 * GET /api/v1/profiles/:profileId
 * POST /api/v1/profiles
 * PUT /api/v1/profiles/:profileId
 * POST /api/v1/profiles/:profileId/reload
 * POST /api/v1/profiles/:profileId/files
 * GET /api/v1/profiles/:profileId/files
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { z } from 'zod'
import { createTestGateway, type TestGateway } from '../harness/index.js'
import { ProfileSummaryPermissiveSchema, ApiErrorSchema } from '../harness/schema-validator.js'

describe('Contract: Profiles', () => {
  let gw: TestGateway

  beforeAll(async () => {
    gw = await createTestGateway({
      profiles: [
        { name: 'contract-coder', description: 'Coder for contract tests', model: 'anthropic:claude-sonnet-4-20250514' },
        { name: 'contract-haiku', description: 'Haiku for contract tests', model: 'anthropic:claude-haiku-4-5-20251001' },
      ],
    })
  })

  afterAll(async () => {
    await gw.stop()
  })

  it('GET /profiles returns array of ProfileSummary', async () => {
    const r = await gw.client.get('/api/v1/profiles', z.array(ProfileSummaryPermissiveSchema))
    expect(r.status).toBe(200)
    expect(r.body.length).toBeGreaterThanOrEqual(3) // mini + 2 seeded
  })

  it('every profile has required fields', async () => {
    const r = await gw.client.get<unknown[]>('/api/v1/profiles')
    expect(r.status).toBe(200)
    for (const p of r.body as Array<Record<string, unknown>>) {
      expect(p['id']).toBeDefined()
      expect(p['name']).toBeDefined()
      expect(p['model']).toBeDefined()
      expect(typeof p['toolCount']).toBe('number')
      expect(typeof p['hasSkills']).toBe('boolean')
      expect(typeof p['hasMcp']).toBe('boolean')
    }
  })

  it('GET /profiles/:id returns ProfileDetail with config + soulMd', async () => {
    const r = await gw.client.get<Record<string, unknown>>('/api/v1/profiles/contract-coder')
    expect(r.status).toBe(200)
    expect(r.body['id']).toBe('contract-coder')
    expect(r.body['config']).toBeDefined()
    expect('soulMd' in r.body).toBe(true)
    expect('agentsMd' in r.body).toBe(true)
    expect(Array.isArray(r.body['skills'])).toBe(true)
    expect(typeof r.body['path']).toBe('string')
  })

  it('GET /profiles/:id returns 404 for non-existent profile', async () => {
    const r = await gw.client.get('/api/v1/profiles/nonexistent', ApiErrorSchema)
    expect(r.status).toBe(404)
    expect(r.body.error).toBeDefined()
    expect(r.body.message).toBeDefined()
  })

  it('POST /profiles/:id/reload returns 200 for existing profile', async () => {
    const r = await gw.client.post('/api/v1/profiles/contract-coder/reload')
    expect([200, 201]).toContain(r.status)
  })

  it('POST /profiles/:id/files writes a soul.md', async () => {
    const r = await gw.client.post('/api/v1/profiles/contract-coder/files', {
      type: 'soul_md',
      content: 'You are a helpful coder for contract tests.',
    })
    expect([200, 201]).toContain(r.status)

    // Verify it was saved
    const detail = await gw.client.get<{ soulMd: string }>('/api/v1/profiles/contract-coder')
    expect(detail.body.soulMd).toContain('contract tests')
  })

  it('GET /profiles/:id/files lists files', async () => {
    const r = await gw.client.get('/api/v1/profiles/contract-coder/files')
    expect(r.status).toBe(200)
  })
})
