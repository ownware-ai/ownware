import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createTestGateway, type TestGateway } from '../harness/index.js'

const SourceManifestSchema = z.object({
  sourceId: z.string().uuid(),
  kind: z.enum([
    'file', 'text', 'visual', 'structured_export',
    'cloud_document', 'connected_snapshot', 'supported_other',
  ]),
  label: z.string(),
  classification: z.enum(['public', 'internal', 'confidential', 'restricted']),
  authority: z.enum(['source_of_record', 'supporting_reference', 'example', 'excluded']),
  audiencePolicyRef: z.string(),
  sensitivityPolicyRef: z.string(),
  purposePolicyRef: z.string(),
  retentionPolicyRef: z.string(),
  freshnessPolicyRef: z.string(),
  revision: z.literal(1),
  currentVersionId: z.null(),
  health: z.object({
    registration: z.literal('pending'),
    inspection: z.literal('not_started'),
    preparation: z.literal('not_requested'),
    access: z.literal('available'),
    freshness: z.literal('unknown'),
    conflict: z.literal('none'),
    deletion: z.literal('active'),
  }).strict(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
}).strict()

const SourceListSchema = z.object({
  items: z.array(SourceManifestSchema),
  nextCursor: z.string().uuid().nullable(),
}).strict()

describe('Contract: scoped source registration', () => {
  let gw: TestGateway
  let token: string
  let workspaceId: string

  beforeAll(async () => {
    gw = await createTestGateway({
      disableAuth: false,
      profiles: [{ name: 'other', tools: { preset: 'none' } }],
    })
    workspaceId = gw.state.createWorkspace(gw.tmpDir, 'Source contract').id
    const issued = await gw.client.post('/api/v1/auth/delegations', {
      delegateId: 'source-contract-client',
      workspaceId,
      profileId: 'mini',
      purpose: 'customer-support',
      operations: ['sources.register', 'sources.list', 'sources.read'],
    })
    token = (issued.body as { token: string }).token
  })

  afterAll(async () => {
    await gw.stop()
  })

  it('registers only safe metadata in the verified principal scope', async () => {
    const response = await fetch(`${gw.baseUrl}/api/v1/sources`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': '41414141-abab-4414-8414-414141414141',
      },
      body: JSON.stringify({
        kind: 'file',
        label: 'Approved support guide',
        classification: 'internal',
        authority: 'supporting_reference',
        audiencePolicyRef: 'audience.support-team',
        sensitivityPolicyRef: 'sensitivity.internal',
        purposePolicyRef: 'purpose.customer-support',
        retentionPolicyRef: 'retention.standard',
        freshnessPolicyRef: 'freshness.monthly',
      }),
    })
    const raw = await response.text()

    expect(response.status).toBe(202)
    expect(SourceManifestSchema.parse(JSON.parse(raw))).toMatchObject({
      kind: 'file',
      label: 'Approved support guide',
      revision: 1,
      currentVersionId: null,
    })
    expect(raw).not.toContain(gw.tmpDir)
    expect(raw).not.toContain('/Users/')
    expect(raw).not.toContain('sqlite')
    expect(raw).not.toContain('content')
    expect(raw).not.toContain('storage')
  })

  it('lists and reads safe manifests through bounded scoped routes', async () => {
    const registered = await fetch(`${gw.baseUrl}/api/v1/sources`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': '42424242-abab-4424-8424-424242424242',
      },
      body: JSON.stringify({
        kind: 'text',
        label: 'Support escalation policy',
        classification: 'confidential',
        authority: 'source_of_record',
        audiencePolicyRef: 'audience.support-team',
        sensitivityPolicyRef: 'sensitivity.confidential',
        purposePolicyRef: 'purpose.customer-support',
        retentionPolicyRef: 'retention.standard',
        freshnessPolicyRef: 'freshness.weekly',
      }),
    })
    const source = SourceManifestSchema.parse(await registered.json())

    const listed = await fetch(`${gw.baseUrl}/api/v1/sources?limit=10`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(listed.status).toBe(200)
    expect(SourceListSchema.parse(await listed.json()).items).toEqual(
      expect.arrayContaining([expect.objectContaining({ sourceId: source.sourceId })]),
    )

    const detail = await fetch(`${gw.baseUrl}/api/v1/sources/${source.sourceId}`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(detail.status).toBe(200)
    expect(SourceManifestSchema.parse(await detail.json())).toEqual(source)
  })

  it('replays one logical registration, rejects conflicts, and never merges separate sources', async () => {
    const body = {
      kind: 'file',
      label: 'Same bytes may have different authority',
      classification: 'internal',
      authority: 'example',
      audiencePolicyRef: 'audience.support-team',
      sensitivityPolicyRef: 'sensitivity.internal',
      purposePolicyRef: 'purpose.customer-support',
      retentionPolicyRef: 'retention.standard',
      freshnessPolicyRef: 'freshness.monthly',
    }
    const register = (key: string, input: object = body) => fetch(`${gw.baseUrl}/api/v1/sources`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      body: JSON.stringify(input),
    })

    const firstResponse = await register('43434343-abab-4434-8434-434343434343')
    const first = SourceManifestSchema.parse(await firstResponse.json())
    const replayResponse = await register('43434343-abab-4434-8434-434343434343')
    expect(replayResponse.status).toBe(202)
    expect(replayResponse.headers.get('idempotency-replayed')).toBe('true')
    expect(SourceManifestSchema.parse(await replayResponse.json()).sourceId).toBe(first.sourceId)

    const conflict = await register(
      '43434343-abab-4434-8434-434343434343',
      { ...body, label: 'Changed meaning' },
    )
    expect(conflict.status).toBe(409)
    await expect(conflict.json()).resolves.toMatchObject({ error: 'idempotency_conflict' })

    const separateResponse = await register('44444444-abab-4444-8444-444444444444')
    const separate = SourceManifestSchema.parse(await separateResponse.json())
    expect(separate.sourceId).not.toBe(first.sourceId)
  })

  it('rejects unsafe labels and any authority, path, URL, or byte smuggling fields', async () => {
    const base = {
      kind: 'file',
      label: 'Safe source label',
      classification: 'internal',
      authority: 'supporting_reference',
      audiencePolicyRef: 'audience.support-team',
      sensitivityPolicyRef: 'sensitivity.internal',
      purposePolicyRef: 'purpose.customer-support',
      retentionPolicyRef: 'retention.standard',
      freshnessPolicyRef: 'freshness.monthly',
    }
    const invalidInputs = [
      { ...base, label: 'unsafe\nlabel' },
      { ...base, workspaceId: 'another-workspace' },
      { ...base, path: '/private/source.txt' },
      { ...base, url: 'https://example.invalid/private' },
      { ...base, contentBase64: Buffer.from('private bytes').toString('base64') },
      { ...base, kind: 'arbitrary_url' },
    ]

    for (const [index, input] of invalidInputs.entries()) {
      const response = await fetch(`${gw.baseUrl}/api/v1/sources`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'idempotency-key': `45454545-abab-4454-8454-4545454545${String(index).padStart(2, '0')}`,
        },
        body: JSON.stringify(input),
      })
      const raw = await response.text()
      expect(response.status, `input ${index}`).toBe(400)
      expect(JSON.parse(raw)).toMatchObject({ error: 'source_registration_invalid' })
      expect(raw).not.toContain('/private/source.txt')
      expect(raw).not.toContain('private bytes')
    }
  })

  it('makes cross-workspace and cross-profile sources indistinguishable from absence', async () => {
    const created = await fetch(`${gw.baseUrl}/api/v1/sources`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': '46464646-abab-4464-8464-464646464646',
      },
      body: JSON.stringify({
        kind: 'file',
        label: 'Private scope canary label',
        classification: 'restricted',
        authority: 'source_of_record',
        audiencePolicyRef: 'audience.support-team',
        sensitivityPolicyRef: 'sensitivity.restricted',
        purposePolicyRef: 'purpose.customer-support',
        retentionPolicyRef: 'retention.standard',
        freshnessPolicyRef: 'freshness.daily',
      }),
    })
    const source = SourceManifestSchema.parse(await created.json())
    const otherWorkspaceId = gw.state.createWorkspace(`${gw.tmpDir}/other-workspace`, 'Other').id
    const issue = async (scopeWorkspaceId: string, profileId: string, delegateId: string) => {
      const response = await gw.client.post('/api/v1/auth/delegations', {
        delegateId,
        workspaceId: scopeWorkspaceId,
        profileId,
        purpose: 'customer-support',
        operations: ['sources.list', 'sources.read'],
      })
      return (response.body as { token: string }).token
    }
    const otherWorkspaceToken = await issue(otherWorkspaceId, 'mini', 'other-workspace-client')
    const otherProfileToken = await issue(workspaceId, 'other', 'other-profile-client')

    for (const deniedToken of [otherWorkspaceToken, otherProfileToken]) {
      const detail = await fetch(`${gw.baseUrl}/api/v1/sources/${source.sourceId}`, {
        headers: { authorization: `Bearer ${deniedToken}` },
      })
      const raw = await detail.text()
      expect(detail.status).toBe(404)
      expect(JSON.parse(raw)).toMatchObject({
        error: 'source_not_found',
        message: 'Source not found.',
        category: 'not_found',
      })
      expect(raw).not.toContain('Private scope canary label')

      const listed = await fetch(`${gw.baseUrl}/api/v1/sources`, {
        headers: { authorization: `Bearer ${deniedToken}` },
      })
      expect(SourceListSchema.parse(await listed.json())).toEqual({ items: [], nextCursor: null })
    }
  })

  it('starts empty and paginates a scoped catalog without merging equal metadata', async () => {
    const pageWorkspaceId = gw.state.createWorkspace(`${gw.tmpDir}/page-workspace`, 'Page scope').id
    const issued = await gw.client.post('/api/v1/auth/delegations', {
      delegateId: 'source-page-client',
      workspaceId: pageWorkspaceId,
      profileId: 'mini',
      purpose: 'customer-support',
      operations: ['sources.register', 'sources.list'],
    })
    const pageToken = (issued.body as { token: string }).token
    const list = (cursor?: string) => fetch(
      `${gw.baseUrl}/api/v1/sources?limit=1${cursor ? `&cursor=${cursor}` : ''}`,
      { headers: { authorization: `Bearer ${pageToken}` } },
    )
    expect(SourceListSchema.parse(await (await list()).json())).toEqual({
      items: [], nextCursor: null,
    })

    const body = {
      kind: 'text',
      label: 'Equal metadata stays separate',
      classification: 'internal',
      authority: 'example',
      audiencePolicyRef: 'audience.support-team',
      sensitivityPolicyRef: 'sensitivity.internal',
      purposePolicyRef: 'purpose.customer-support',
      retentionPolicyRef: 'retention.standard',
      freshnessPolicyRef: 'freshness.monthly',
    }
    const createdIds: string[] = []
    for (const key of [
      '48484848-abab-4484-8484-484848484848',
      '49494949-abab-4494-8494-494949494949',
    ]) {
      const response = await fetch(`${gw.baseUrl}/api/v1/sources`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${pageToken}`,
          'content-type': 'application/json',
          'idempotency-key': key,
        },
        body: JSON.stringify(body),
      })
      createdIds.push(SourceManifestSchema.parse(await response.json()).sourceId)
    }

    const firstPage = SourceListSchema.parse(await (await list()).json())
    expect(firstPage.items).toHaveLength(1)
    expect(firstPage.nextCursor).not.toBeNull()
    const secondPage = SourceListSchema.parse(await (await list(firstPage.nextCursor!)).json())
    expect(secondPage.items).toHaveLength(1)
    expect(secondPage.nextCursor).toBeNull()
    expect([...firstPage.items, ...secondPage.items].map((item) => item.sourceId).sort())
      .toEqual(createdIds.sort())
  })

  it('rejects unscoped owner access and invalid list authority or bounds', async () => {
    const ownerList = await fetch(`${gw.baseUrl}/api/v1/sources`, {
      headers: { authorization: `Bearer ${gw.token}` },
    })
    expect(ownerList.status).toBe(403)
    await expect(ownerList.json()).resolves.toMatchObject({
      error: 'source_scoped_principal_required',
    })

    for (const query of ['limit=0', 'limit=101', 'limit=1.5', 'cursor=not-a-source',
      'workspaceId=browser-supplied']) {
      const response = await fetch(`${gw.baseUrl}/api/v1/sources?${query}`, {
        headers: { authorization: `Bearer ${token}` },
      })
      expect(response.status, query).toBe(400)
      await expect(response.json()).resolves.toMatchObject({ error: 'source_list_invalid' })
    }
  })
})
