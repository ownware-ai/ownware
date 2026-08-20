import { afterEach, describe, expect, it } from 'vitest'
import { createTestGateway, type TestGateway } from '../../framework/harness/index.js'

const PROFILE = 'credentials-public'

let gateway: TestGateway | undefined

afterEach(async () => {
  await gateway?.stop()
  gateway = undefined
})

describe('credentials inventory (public, read-only)', () => {
  it('lists metadata with a masked hint and never a value', async () => {
    gateway = await createTestGateway({ profiles: [{ name: PROFILE, tools: { preset: 'none' } }] })
    const created = await gateway.client.post('/api/v1/credentials', {
      name: 'Attio API key',
      category: 'tool',
      authType: 'api-key',
      variableName: 'ATTIO_API_KEY',
      value: 'sk-canary-verysecret-0123456789abcdef',
    })
    expect(created.status).toBe(201)

    const listed = await gateway.client.get('/api/v1/credentials')
    expect(listed.status).toBe(200)
    const raw = JSON.stringify(listed.body)
    // The load-bearing assertion: the canary must not appear ANYWHERE in the
    // listing — not as a value field, not inside the hint.
    expect(raw).not.toContain('verysecret')
    expect(raw).not.toContain('sk-canary-verysecret')
    const rows = (listed.body as { credentials: Array<Record<string, unknown>> }).credentials
    expect(rows).toHaveLength(1)
    expect(rows[0]).not.toHaveProperty('value')
    expect(typeof rows[0]!['hint']).toBe('string')
  })

  it('refuses the inventory to a delegated principal', async () => {
    gateway = await createTestGateway({
      disableAuth: false,
      profiles: [{ name: PROFILE, tools: { preset: 'none' } }],
    })
    const workspaceId = (await gateway.state.createWorkspace(gateway.tmpDir, 'Cred')).id
    const issued = await gateway.client.post('/api/v1/auth/delegations', {
      delegateId: 'browser-cred',
      workspaceId,
      profileId: PROFILE,
      subjectId: 'subject-a',
      purpose: 'support',
      channel: 'web',
      operations: ['credentials.read'],
    })
    const token = (issued.body as { token: string }).token
    const denied = await fetch(`${gateway.baseUrl}/api/v1/credentials`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(denied.status).toBe(403)
    // And reveal — unpublished — is refused too, not merely undocumented.
    const revealDenied = await fetch(`${gateway.baseUrl}/api/v1/credentials/any/reveal`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
    expect([403, 404]).toContain(revealDenied.status)
    expect(revealDenied.status).toBe(403)
  })
})
