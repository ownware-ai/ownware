import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createTestGateway, type TestGateway } from '../harness/index.js'

const PrincipalSchema = z.object({
  kind: z.literal('delegated'),
  tokenId: z.string().uuid(),
  delegateId: z.string(),
  workspaceId: z.string(),
  profileId: z.string(),
  purpose: z.string(),
  subjectId: z.string().optional(),
  channel: z.string().optional(),
  operations: z.array(z.string()),
  issuedAt: z.number().int(),
  expiresAt: z.number().int(),
}).strict()

const IssueSchema = z.object({
  token: z.string().min(40),
  principal: PrincipalSchema,
}).strict()

const ErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
  category: z.string(),
  correlationId: z.string().uuid(),
}).passthrough()

const RevokeSchema = z.object({
  tokenId: z.string().uuid(),
  revoked: z.literal(true),
}).strict()

describe('Contract: delegated principals', () => {
  let gw: TestGateway
  let workspaceId: string
  let token: string
  let tokenId: string

  beforeAll(async () => {
    gw = await createTestGateway({
      disableAuth: false,
      profiles: [{ name: 'other', tools: { preset: 'none' } }],
    })
    workspaceId = gw.state.createWorkspace(gw.tmpDir, 'Principal contract').id
  })

  afterAll(async () => {
    await gw.stop()
  })

  it('owner issues a bounded token for canonical existing resources', async () => {
    const response = await gw.client.post('/api/v1/auth/delegations', {
      delegateId: 'browser-session-1',
      workspaceId,
      profileId: 'mini',
      purpose: 'customer-support',
      channel: 'web',
      operations: [
        'gateway.capabilities',
        'runs.start',
        'runs.events',
        'runs.resume',
        'runs.abort',
      ],
      ttlSeconds: 900,
    }, IssueSchema)

    expect(response.status).toBe(201)
    token = response.body.token
    tokenId = response.body.principal.tokenId
    expect(response.body.principal).toMatchObject({ workspaceId, profileId: 'mini' })
    expect(response.headers['cache-control']).toBe('no-store')
  })

  it('requires an explicit protected-resource subject and keeps the issue body closed', async () => {
    for (const operation of [
      'source_content.read', 'source_content.search', 'source_data_views.query',
    ]) {
      const withoutSubject = await gw.client.post('/api/v1/auth/delegations', {
        delegateId: 'browser-session-query',
        workspaceId,
        profileId: 'mini',
        purpose: 'customer-support',
        channel: 'web',
        operations: [operation],
      })
      expect(withoutSubject.status).toBe(400)
      expect(ErrorSchema.parse(withoutSubject.body).error).toBe('principal_scope_invalid')
    }

    const issued = await gw.client.post('/api/v1/auth/delegations', {
      delegateId: 'browser-session-query',
      workspaceId,
      profileId: 'mini',
      subjectId: 'customer_42',
      purpose: 'customer-support',
      channel: 'web',
      operations: ['source_data_views.query'],
    }, IssueSchema)
    expect(issued.status).toBe(201)
    expect(issued.body.principal.subjectId).toBe('customer_42')

    const extraAuthority = await gw.client.post('/api/v1/auth/delegations', {
      delegateId: 'browser-session-query',
      workspaceId,
      profileId: 'mini',
      subjectId: 'customer_42',
      purpose: 'customer-support',
      channel: 'web',
      operations: ['source_data_views.query'],
      resourceId: 'must-not-be-accepted-here',
    })
    expect(extraAuthority.status).toBe(400)
    expect(ErrorSchema.parse(extraAuthority.body).error).toBe('invalid_request')
  })

  it('scoped token reads its declared capability and cannot reach an unmarked route', async () => {
    const allowed = await fetch(`${gw.baseUrl}/api/v1/capabilities`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(allowed.status).toBe(200)
    expect(z.object({ contract: z.object({ major: z.literal(1) }) }).passthrough()
      .parse(await allowed.json()).contract.major).toBe(1)

    const denied = await fetch(`${gw.baseUrl}/api/v1/profiles`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(denied.status).toBe(403)
    expect(ErrorSchema.parse(await denied.json()).error).toBe('principal_operation_denied')
  })

  it('denies a different agent before creating a thread or calling a provider', async () => {
    const before = gw.state.listThreads().total
    const response = await fetch(`${gw.baseUrl}/api/v1/run`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        profileId: 'other',
        workspaceId,
        prompt: 'must not run',
      }),
    })

    expect(response.status).toBe(403)
    expect(ErrorSchema.parse(await response.json()).error).toBe('principal_scope_denied')
    expect(gw.state.listThreads().total).toBe(before)
  })

  it('requires a durable key for an otherwise in-scope delegated run', async () => {
    const before = gw.state.listThreads().total
    const response = await fetch(`${gw.baseUrl}/api/v1/run`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ profileId: 'mini', workspaceId, prompt: 'must be fenced' }),
    })
    expect(response.status).toBe(400)
    expect(ErrorSchema.parse(await response.json()).error).toBe('idempotency_key_required')
    expect(gw.state.listThreads().total).toBe(before)
  })

  it('allows scoped events while blocking delegated legacy bulk resume and cross-scope access', async () => {
    const owned = gw.state.createThread('mini', undefined, workspaceId)
    const stream = await fetch(
      `${gw.baseUrl}/api/v1/threads/${owned.id}/agents/root/events?since=0`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
    expect(stream.status).toBe(200)
    await stream.body?.cancel()

    const resume = await fetch(`${gw.baseUrl}/api/v1/threads/${owned.id}/resume`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action: 'deny', requestId: 'missing' }),
    })
    expect(resume.status).toBe(403)
    expect(ErrorSchema.parse(await resume.json()).error).toBe('principal_operation_denied')

    const abort = await fetch(`${gw.baseUrl}/api/v1/threads/${owned.id}/abort`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(abort.status).toBe(403)
    expect(ErrorSchema.parse(await abort.json()).error).toBe('principal_operation_denied')

    const otherWorkspace = gw.state.createWorkspace(`${gw.tmpDir}/other`, 'Other scope')
    const other = gw.state.createThread('mini', undefined, otherWorkspace.id)
    const denied = await fetch(
      `${gw.baseUrl}/api/v1/threads/${other.id}/agents/root/events?since=0`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
    expect(denied.status).toBe(403)
    expect(ErrorSchema.parse(await denied.json()).error).toBe('principal_scope_denied')
  })

  it('owner revocation immediately invalidates the delegated token', async () => {
    const revoked = await gw.client.post(
      `/api/v1/auth/delegations/${tokenId}/revoke`,
      { reason: 'client_removed' },
      RevokeSchema,
    )
    expect(revoked.status).toBe(200)

    const response = await fetch(`${gw.baseUrl}/api/v1/capabilities`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(response.status).toBe(401)
    expect(ErrorSchema.parse(await response.json()).error).toBe('principal_revoked')
  })

  it('refuses HTTP issuance when Gateway authentication is disabled', async () => {
    const local = await createTestGateway({ disableAuth: true })
    try {
      const response = await local.client.post('/api/v1/auth/delegations', {
        delegateId: 'local',
        workspaceId: 'ws_missing',
        profileId: 'mini',
        purpose: 'support',
        operations: ['gateway.capabilities'],
      })
      expect(response.status).toBe(409)
      expect(ErrorSchema.parse(response.body).error).toBe('auth_required')
    } finally {
      await local.stop()
    }
  })
})
