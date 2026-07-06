/**
 * Journey 02: Profile lifecycle
 *
 * Mirrors the Profiles screen flow:
 *   1. Create a profile via POST /profiles
 *   2. Verify it appears in GET /profiles
 *   3. Add SOUL.md, AGENTS.md
 *   4. Update model via PUT
 *   5. Set metadata (icon, color, category)
 *   6. Reload from disk
 *   7. Verify all changes persisted
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestGateway, type TestGateway } from '../harness/index.js'

describe('Journey: 02 Profile Lifecycle', () => {
  let gw: TestGateway
  const profileId = 'lifecycle-coder'

  beforeAll(async () => {
    gw = await createTestGateway()
  })

  afterAll(async () => {
    await gw.stop()
  })

  it('Step 1: POST /profiles creates new profile', async () => {
    const r = await gw.client.post<Record<string, unknown>>('/api/v1/profiles', {
      name: profileId,
      description: 'Profile for journey 02 test',
      model: 'anthropic:claude-sonnet-4-20250514',
      // productId is required since slice-08 — 'ownware' is the only open product.
      productId: 'ownware',
    })
    expect([200, 201]).toContain(r.status)
    expect(r.body['id']).toBeDefined()
  })

  it('Step 2: New profile appears in GET /profiles', async () => {
    const r = await gw.client.get<Array<{ id: string; name: string }>>('/api/v1/profiles')
    expect(r.body.some(p => p.name === profileId || p.id === profileId)).toBe(true)
  })

  it('Step 3: POST /profiles/:id/files adds SOUL.md', async () => {
    const r = await gw.client.post(`/api/v1/profiles/${profileId}/files`, {
      type: 'soul_md',
      content: 'You are a senior coder. Use TypeScript best practices.',
    })
    expect([200, 201]).toContain(r.status)

    const detail = await gw.client.get<{ soulMd: string }>(`/api/v1/profiles/${profileId}`)
    expect(detail.body.soulMd).toContain('senior coder')
  })

  it('Step 4: POST /profiles/:id/files adds AGENTS.md', async () => {
    const r = await gw.client.post(`/api/v1/profiles/${profileId}/files`, {
      type: 'agents_md',
      content: 'User prefers functional style. Likes Zod for validation.',
    })
    expect([200, 201]).toContain(r.status)

    const detail = await gw.client.get<{ agentsMd: string }>(`/api/v1/profiles/${profileId}`)
    expect(detail.body.agentsMd).toContain('functional style')
  })

  it('Step 5: setProfileMetadata stores icon, color, category', () => {
    gw.state.setProfileMetadata(profileId, {
      icon: 'code',
      color: '#7C5CFC',
      category: 'Development',
    })
    const meta = gw.state.getProfileMetadata(profileId)
    expect(meta?.icon).toBe('code')
    expect(meta?.color).toBe('#7C5CFC')
    expect(meta?.category).toBe('Development')
  })

  it('Step 6: POST /profiles/:id/reload picks up disk changes', async () => {
    const r = await gw.client.post(`/api/v1/profiles/${profileId}/reload`)
    expect([200, 201]).toContain(r.status)
  })

  it('Step 7: Profile detail reflects all changes', async () => {
    const r = await gw.client.get<{ soulMd: string; agentsMd: string; config: Record<string, unknown> }>(
      `/api/v1/profiles/${profileId}`,
    )
    expect(r.body.soulMd).toContain('senior coder')
    expect(r.body.agentsMd).toContain('functional style')
    expect(r.body.config).toBeDefined()
  })

  it('Step 8: Profile usage stats start at zero', () => {
    const meta = gw.state.getProfileMetadata(profileId)
    expect(meta?.useCount).toBe(0)
    expect(meta?.totalCost).toBe(0)
    expect(meta?.lastUsedAt).toBeNull()
  })

  it('Step 9: incrementProfileUsage updates stats', () => {
    gw.state.incrementProfileUsage(profileId, 0.05)
    gw.state.incrementProfileUsage(profileId, 0.10)
    const meta = gw.state.getProfileMetadata(profileId)!
    expect(meta.useCount).toBe(2)
    expect(meta.totalCost).toBeCloseTo(0.15)
    expect(meta.lastUsedAt).not.toBeNull()
  })
})
