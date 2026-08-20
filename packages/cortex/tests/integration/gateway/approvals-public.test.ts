import { afterEach, describe, expect, it } from 'vitest'
import { createTestGateway, type TestGateway } from '../../framework/harness/index.js'

/**
 * P1 promotion: the approvals inbox enters the public contract. The rows
 * carry held drafts verbatim, which is exactly why the owner-only boundary
 * is the load-bearing case here.
 */

const PROFILE = 'approvals-public'

let gateway: TestGateway | undefined

afterEach(async () => {
  await gateway?.stop()
  gateway = undefined
})

describe('approvals (public)', () => {
  it('advertises the capabilities and serves an empty inbox honestly', async () => {
    gateway = await createTestGateway({ profiles: [{ name: PROFILE, tools: { preset: 'none' } }] })
    const caps = (await gateway.client.get('/api/v1/capabilities')).body as {
      capabilities: ReadonlyArray<{ id: string }>
    }
    const ids = new Set(caps.capabilities.map((c) => c.id))
    expect(ids.has('approvals.read')).toBe(true)
    expect(ids.has('approvals.decide')).toBe(true)

    const inbox = await gateway.client.get('/api/v1/approvals')
    expect(inbox.status).toBe(200)
    expect((inbox.body as { approvals: unknown[] }).approvals).toEqual([])
    const count = await gateway.client.get('/api/v1/approvals/count')
    expect((count.body as { count: number }).count).toBe(0)
  })

  it('refuses every approval surface to a delegated principal', async () => {
    gateway = await createTestGateway({
      disableAuth: false,
      profiles: [{ name: PROFILE, tools: { preset: 'none' } }],
    })
    const workspaceId = (await gateway.state.createWorkspace(gateway.tmpDir, 'Appr')).id
    const issued = await gateway.client.post('/api/v1/auth/delegations', {
      delegateId: 'browser-appr',
      workspaceId,
      profileId: PROFILE,
      subjectId: 'subject-a',
      purpose: 'support',
      channel: 'web',
      operations: ['approvals.read', 'approvals.decide'],
    })
    const token = (issued.body as { token: string }).token
    // Held drafts are the owner's unsent outbound actions.
    for (const [method, path] of [
      ['GET', '/api/v1/approvals'],
      ['GET', '/api/v1/approvals/count'],
      ['POST', '/api/v1/approvals/any-id/approve'],
      ['POST', '/api/v1/approvals/any-id/discard'],
    ] as const) {
      const response = await fetch(`${gateway.baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(response.status, `${method} ${path}`).toBe(403)
    }
  })
})
