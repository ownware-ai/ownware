import { afterEach, describe, expect, it } from 'vitest'
import { createTestGateway, type TestGateway } from '../../framework/harness/index.js'

/**
 * P1 promotion: the memory family enters the public contract. Covers the
 * owner-only boundary, capability discovery and one full pin-edit-forget
 * lifecycle plus the About You record.
 */

const PROFILE = 'memories-public'

let gateway: TestGateway | undefined

afterEach(async () => {
  await gateway?.stop()
  gateway = undefined
})

describe('memories (public)', () => {
  it('advertises all four capabilities', async () => {
    gateway = await createTestGateway({ profiles: [{ name: PROFILE, tools: { preset: 'none' } }] })
    const body = (await gateway.client.get('/api/v1/capabilities')).body as {
      capabilities: ReadonlyArray<{ id: string }>
    }
    const ids = new Set(body.capabilities.map((c) => c.id))
    for (const id of ['memories.read', 'memories.manage', 'user_identity.read', 'user_identity.manage']) {
      expect(ids.has(id), id).toBe(true)
    }
  })

  it('pins, edits and forgets a memory, preserving the real source', async () => {
    gateway = await createTestGateway({ profiles: [{ name: PROFILE, tools: { preset: 'none' } }] })
    const created = await gateway.client.post(`/api/v1/profiles/${PROFILE}/memories`, {
      profileId: PROFILE,
      content: 'Prefers totals in AUD',
      kind: 'preference',
      pinned: true,
    })
    expect(created.status).toBe(201)
    const memory = (created.body as { memory: { id: string; source: string } }).memory
    // Provenance is the point: a user pin is user_pinned, never "learned".
    expect(memory.source).toBe('user_pinned')

    const edited = await fetch(`${gateway.baseUrl}/api/v1/memories/${memory.id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${gateway.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'Prefers totals in AUD, GST inclusive' }),
    })
    expect(edited.status).toBe(200)

    const listed = await gateway.client.get(`/api/v1/profiles/${PROFILE}/memories`)
    expect((listed.body as { total: number }).total).toBe(1)

    const forgotten = await fetch(`${gateway.baseUrl}/api/v1/memories/${memory.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${gateway.token}` },
    })
    expect(forgotten.status).toBe(200)
    const after = await gateway.client.get(`/api/v1/profiles/${PROFILE}/memories`)
    expect((after.body as { total: number }).total).toBe(0)
  })

  it('stores and returns the About You record', async () => {
    gateway = await createTestGateway({ profiles: [{ name: PROFILE, tools: { preset: 'none' } }] })
    const put = await fetch(`${gateway.baseUrl}/api/v1/user/identity`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${gateway.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Tarique', timezone: 'Australia/Sydney' }),
    })
    expect(put.status).toBe(200)
    const got = await gateway.client.get('/api/v1/user/identity')
    expect((got.body as { identity: { name: string; timezone: string } }).identity)
      .toMatchObject({ name: 'Tarique', timezone: 'Australia/Sydney' })
  })

  it('refuses every memory surface to a delegated principal', async () => {
    gateway = await createTestGateway({
      disableAuth: false,
      profiles: [{ name: PROFILE, tools: { preset: 'none' } }],
    })
    const workspaceId = (await gateway.state.createWorkspace(gateway.tmpDir, 'Mem')).id
    const issued = await gateway.client.post('/api/v1/auth/delegations', {
      delegateId: 'browser-mem',
      workspaceId,
      profileId: PROFILE,
      subjectId: 'subject-a',
      purpose: 'support',
      channel: 'web',
      operations: ['memories.read', 'user_identity.read'],
    })
    const token = (issued.body as { token: string }).token
    // What the agent knows about its OWNER is never a delegated surface.
    for (const path of [
      `/api/v1/profiles/${PROFILE}/memories`,
      `/api/v1/profiles/${PROFILE}/memories/proposals`,
      '/api/v1/user/identity',
    ]) {
      const response = await fetch(`${gateway.baseUrl}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(response.status, path).toBe(403)
    }
  })
})
