import { afterEach, describe, expect, it } from 'vitest'
import { createTestGateway, type TestGateway } from '../../framework/harness/index.js'

/**
 * P1 promotion: GET /api/v1/threads enters the public contract. The cases
 * here are the ones promotion added — scoping, validation, pagination — not
 * the listing itself, which the framework contract already covers.
 */

const PROFILE_A = 'threads-public-a'
const PROFILE_B = 'threads-public-b'

let gateway: TestGateway | undefined

afterEach(async () => {
  await gateway?.stop()
  gateway = undefined
})

describe('GET /api/v1/threads (public)', () => {
  it('pages with validated bounds and no caching', async () => {
    gateway = await createTestGateway({
      profiles: [{ name: PROFILE_A, tools: { preset: 'none' } }],
    })
    for (let index = 0; index < 5; index += 1) {
      await gateway.state.createThread(PROFILE_A, `thread ${index}`)
    }
    const page = await gateway.client.get('/api/v1/threads?limit=2&offset=2')
    expect(page.status).toBe(200)
    expect(page.headers['cache-control']).toBe('no-store')
    expect(page.body).toMatchObject({ total: 5, limit: 2, offset: 2 })
    expect((page.body as { items: unknown[] }).items).toHaveLength(2)
  })

  it('filters by profile without leaking the other profile', async () => {
    gateway = await createTestGateway({
      profiles: [
        { name: PROFILE_A, tools: { preset: 'none' } },
        { name: PROFILE_B, tools: { preset: 'none' } },
      ],
    })
    await gateway.state.createThread(PROFILE_A)
    await gateway.state.createThread(PROFILE_B)
    const page = await gateway.client.get(`/api/v1/threads?profileId=${PROFILE_A}`)
    const items = (page.body as { items: Array<{ profileId: string }> }).items
    expect(items.length).toBeGreaterThan(0)
    expect(items.every((item) => item.profileId === PROFILE_A)).toBe(true)
  })

  it('rejects malformed pagination and unknown parameters', async () => {
    gateway = await createTestGateway({
      profiles: [{ name: PROFILE_A, tools: { preset: 'none' } }],
    })
    for (const query of ['?limit=0', '?limit=201', '?limit=abc', '?offset=-1', '?unexpected=1', '?limit=1&limit=2']) {
      const response = await gateway.client.get(`/api/v1/threads${query}`)
      expect(response.status, `query ${query}`).toBe(400)
    }
  })

  it('refuses a delegated principal instead of returning a filtered page', async () => {
    gateway = await createTestGateway({
      disableAuth: false,
      profiles: [{ name: PROFILE_A, tools: { preset: 'none' } }],
    })
    const workspaceId = (await gateway.state.createWorkspace(gateway.tmpDir, 'Threads')).id
    await gateway.state.createThread(PROFILE_A)
    const issued = await gateway.client.post('/api/v1/auth/delegations', {
      delegateId: 'browser-threads',
      workspaceId,
      profileId: PROFILE_A,
      subjectId: 'subject-a',
      purpose: 'support',
      channel: 'web',
      operations: ['threads.list'],
    })
    const token = (issued.body as { token: string }).token
    const denied = await fetch(`${gateway.baseUrl}/api/v1/threads`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    // Even a delegation naming the operation is refused: enumeration is an
    // owner surface, and an empty filtered page would be a lie by omission.
    expect(denied.status).toBe(403)
  })
})
