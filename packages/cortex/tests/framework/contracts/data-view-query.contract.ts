import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { csvDataViewOrdinalId } from '../../../src/gateway/csv-data-view.js'
import { SourceByteStore } from '../../../src/gateway/source-byte-store.js'
import { SourceDataViewStore } from '../../../src/gateway/source-data-view-store.js'
import { SourceStore } from '../../../src/gateway/source-store.js'
import { createTestGateway, type TestGateway } from '../harness/index.js'

const ReceiptSchema = z.object({
  grantId: z.string().uuid(),
  revision: z.literal(1),
  mutation: z.literal('created'),
  acceptedAt: z.number().int().nonnegative(),
}).strict()

const DataViewGrantSchema = z.object({
  grantId: z.string().uuid(),
  revision: z.literal(1),
  state: z.literal('active'),
  workspaceId: z.string(),
  profileId: z.string(),
  subjectId: z.string(),
  purpose: z.string(),
  channel: z.string().nullable(),
  resourceKind: z.literal('source_data_view'),
  resourceId: z.string().uuid(),
  operation: z.literal('source_data_views.query'),
  fieldScope: z.object({
    mode: z.literal('list'), ids: z.array(z.string()).min(1).max(256),
  }).strict(),
  rowScope: z.object({
    mode: z.literal('list'), ids: z.array(z.string()).min(1).max(256),
  }).strict(),
  consent: z.object({ state: z.literal('not_required') }).strict(),
  autonomyCeiling: z.literal('observe'),
  effectiveAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
  issuedBy: z.literal('install_owner'),
  revisionCreatedAt: z.number().int().nonnegative(),
  revokedAt: z.null(),
}).strict()

const QueryResultSchema = z.object({
  dataViewId: z.string().uuid(),
  sourceId: z.string().uuid(),
  sourceVersionId: z.string().uuid(),
  sourceRevision: z.number().int().positive(),
  sourceChecksum: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  artifactChecksum: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  freshness: z.literal('current'),
  classification: z.literal('internal'),
  authority: z.literal('supporting_reference'),
  implementationVersion: z.literal('csv_data_view_selection.v1'),
  rowOffset: z.number().int().nonnegative(),
  requestedRowCount: z.number().int().positive(),
  returnedRowCount: z.number().int().nonnegative(),
  totalRowCount: z.number().int().positive(),
  complete: z.boolean(),
  fields: z.array(z.object({
    fieldId: z.string().regex(/^field\.[0-9a-f]{32}$/),
    ordinal: z.number().int().nonnegative(),
    label: z.string(),
  }).strict()).min(1).max(32),
  rows: z.array(z.object({
    rowId: z.string().regex(/^row\.[0-9a-f]{32}$/),
    ordinal: z.number().int().nonnegative(),
    values: z.array(z.string()),
  }).strict()).max(256),
  observedAt: z.number().int().nonnegative(),
}).strict()

const PROFILE_ID = 'mini'
const VERSION_ID = '11111111-1111-4111-8111-111111111111'
const CSV = Buffer.from('name,plan,secret\nAda,basic,alpha\nBob,pro,beta\nCy,team,gamma')

describe('Contract: exact Data View query grants', () => {
  let gw: TestGateway
  let workspaceId: string
  let target: Awaited<ReturnType<typeof seedDataView>>

  beforeAll(async () => {
    gw = await createTestGateway({ disableAuth: false, disableSourceWorker: true })
    workspaceId = gw.state.createWorkspace(gw.tmpDir, 'Data View query contract').id
    target = await seedDataView()
  })

  afterAll(async () => {
    await gw.stop()
  })

  it('admits and replays only an exact owner-authorized field and row window', async () => {
    const idempotencyKey = '22222222-2222-4222-8222-222222222222'
    const create = () => fetch(
      `${gw.baseUrl}/api/v1/source-data-views/${target.dataViewId}/access-grants`,
      {
        method: 'POST',
        headers: ownerHeaders(idempotencyKey),
        body: JSON.stringify({
          subjectId: 'person.synthetic-1',
          purpose: 'customer_support',
          channel: 'web.primary',
          consent: { state: 'not_required' },
          ttlSeconds: 60,
          fieldIds: [target.fieldIds[1]!],
          rowOffset: 1,
          rowCount: 2,
        }),
      },
    )

    const response = await create()
    expect(response.status).toBe(201)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const receipt = ReceiptSchema.parse(await response.json())

    const replay = await create()
    expect(replay.status).toBe(201)
    expect(replay.headers.get('idempotency-replayed')).toBe('true')
    expect(ReceiptSchema.parse(await replay.json())).toEqual(receipt)

    const detail = await fetch(`${gw.baseUrl}/api/v1/access-grants/${receipt.grantId}`, {
      headers: ownerHeaders(),
    })
    expect(detail.status).toBe(200)
    expect(DataViewGrantSchema.parse(await detail.json())).toMatchObject({
      workspaceId,
      profileId: PROFILE_ID,
      subjectId: 'person.synthetic-1',
      resourceId: target.dataViewId,
      fieldScope: { ids: [target.fieldIds[1]!] },
      rowScope: {
        ids: [
          csvDataViewOrdinalId('row', VERSION_ID, 1),
          csvDataViewOrdinalId('row', VERSION_ID, 2),
        ].sort(),
      },
    })
  })

  it('rejects broad, malformed, duplicate, and out-of-view grant scopes without admission', async () => {
    const base = {
      subjectId: 'person.synthetic-invalid',
      purpose: 'customer_support',
      channel: 'web.primary',
      consent: { state: 'not_required' },
      ttlSeconds: 60,
      fieldIds: [target.fieldIds[0]!],
      rowOffset: 0,
      rowCount: 1,
    }
    const attempts = [
      {
        key: '33333333-3333-4333-8333-333333333331',
        body: { ...base, fieldIds: Array(257).fill(target.fieldIds[0]!) },
        status: 413,
        error: 'access_grant_scope_limit_exceeded',
      },
      {
        key: '33333333-3333-4333-8333-333333333332',
        body: { ...base, rowCount: 257 },
        status: 413,
        error: 'access_grant_scope_limit_exceeded',
      },
      {
        key: '33333333-3333-4333-8333-333333333333',
        body: { ...base, fieldIds: [target.fieldIds[0]!, target.fieldIds[0]!] },
        status: 400,
        error: 'access_grant_invalid',
      },
      {
        key: '33333333-3333-4333-8333-333333333334',
        body: { ...base, rowOffset: 2, rowCount: 2 },
        status: 400,
        error: 'access_grant_invalid',
      },
      {
        key: '33333333-3333-4333-8333-333333333335',
        body: { ...base, operation: 'source_content.read' },
        status: 400,
        error: 'access_grant_invalid',
      },
    ]

    for (const attempt of attempts) {
      const response = await fetch(
        `${gw.baseUrl}/api/v1/source-data-views/${target.dataViewId}/access-grants`,
        {
          method: 'POST',
          headers: ownerHeaders(attempt.key),
          body: JSON.stringify(attempt.body),
        },
      )
      expect(response.status).toBe(attempt.status)
      await expect(response.json()).resolves.toMatchObject({ error: attempt.error })
    }
  })

  it('admits only purpose and channel values that a delegated principal can represent', async () => {
    const base = {
      subjectId: 'person.synthetic-boundaries',
      purpose: 'p'.repeat(64),
      channel: 'c'.repeat(64),
      consent: { state: 'not_required' },
      ttlSeconds: 60,
      fieldIds: [target.fieldIds[0]!],
      rowOffset: 0,
      rowCount: 1,
    }
    const accepted = await fetch(
      `${gw.baseUrl}/api/v1/source-data-views/${target.dataViewId}/access-grants`,
      {
        method: 'POST',
        headers: ownerHeaders('66666666-6666-4666-8666-666666666661'),
        body: JSON.stringify(base),
      },
    )
    expect(accepted.status).toBe(201)

    for (const [key, body] of [
      ['66666666-6666-4666-8666-666666666662', { ...base, purpose: 'p'.repeat(65) }],
      ['66666666-6666-4666-8666-666666666663', { ...base, channel: 'c'.repeat(65) }],
    ] as const) {
      const response = await fetch(
        `${gw.baseUrl}/api/v1/source-data-views/${target.dataViewId}/access-grants`,
        {
          method: 'POST', headers: ownerHeaders(key), body: JSON.stringify(body),
        },
      )
      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toMatchObject({
        error: 'access_grant_invalid',
      })
    }
  })

  it('rejects a row offset outside the published Data View maximum before lookup', async () => {
    const unknownDataViewId = '77777777-7777-4777-8777-777777777777'
    const grant = await fetch(
      `${gw.baseUrl}/api/v1/source-data-views/${unknownDataViewId}/access-grants`,
      {
        method: 'POST',
        headers: ownerHeaders('77777777-7777-4777-8777-777777777771'),
        body: JSON.stringify({
          subjectId: 'person.synthetic-offset',
          purpose: 'customer_support',
          channel: 'web.primary',
          consent: { state: 'not_required' },
          ttlSeconds: 60,
          fieldIds: [target.fieldIds[0]!],
          rowOffset: 100_000,
          rowCount: 1,
        }),
      },
    )
    expect(grant.status).toBe(400)
    await expect(grant.json()).resolves.toMatchObject({ error: 'access_grant_invalid' })

    const token = await issueQueryDelegation(
      'query.offset-boundary', 'person.synthetic-offset',
    )
    const query = await fetch(
      `${gw.baseUrl}/api/v1/source-data-views/${target.dataViewId}/query`,
      {
        method: 'POST',
        headers: delegatedHeaders(token),
        body: JSON.stringify({
          consent: { state: 'not_required' },
          fieldIds: [target.fieldIds[0]!],
          rowOffset: 100_000,
          rowCount: 1,
        }),
      },
    )
    expect(query.status).toBe(400)
    await expect(query.json()).resolves.toMatchObject({
      error: 'source_data_view_query_invalid',
    })
  })

  it('validates opaque consent evidence structurally and preserves its 128-character boundary', async () => {
    const evidenceId = `e${'a'.repeat(127)}`
    const subjectId = 'person.synthetic-consent-boundary'
    const grant = await fetch(
      `${gw.baseUrl}/api/v1/source-data-views/${target.dataViewId}/access-grants`,
      {
        method: 'POST',
        headers: ownerHeaders('88888888-8888-4888-8888-888888888881'),
        body: JSON.stringify({
          subjectId,
          purpose: 'customer_support',
          channel: 'web.primary',
          consent: { state: 'recorded', evidenceId },
          ttlSeconds: 60,
          fieldIds: [target.fieldIds[0]!],
          rowOffset: 0,
          rowCount: 1,
        }),
      },
    )
    expect(grant.status).toBe(201)
    const token = await issueQueryDelegation('query.consent-boundary', subjectId)
    const validQuery = await fetch(
      `${gw.baseUrl}/api/v1/source-data-views/${target.dataViewId}/query`,
      {
        method: 'POST',
        headers: delegatedHeaders(token),
        body: JSON.stringify({
          consent: { state: 'recorded', evidenceId },
          fieldIds: [target.fieldIds[0]!],
          rowOffset: 0,
          rowCount: 1,
        }),
      },
    )
    expect(validQuery.status).toBe(200)

    const invalidQuery = await fetch(
      `${gw.baseUrl}/api/v1/source-data-views/${target.dataViewId}/query`,
      {
        method: 'POST',
        headers: delegatedHeaders(token),
        body: JSON.stringify({
          consent: { state: 'recorded', evidenceId: 'invalid evidence' },
          fieldIds: [target.fieldIds[0]!],
          rowOffset: 0,
          rowCount: 1,
        }),
      },
    )
    expect(invalidQuery.status).toBe(400)
    await expect(invalidQuery.json()).resolves.toMatchObject({
      error: 'source_data_view_query_invalid',
    })

    const unknownDataViewId = '88888888-8888-4888-8888-888888888882'
    const invalidGrant = await fetch(
      `${gw.baseUrl}/api/v1/source-data-views/${unknownDataViewId}/access-grants`,
      {
        method: 'POST',
        headers: ownerHeaders('88888888-8888-4888-8888-888888888883'),
        body: JSON.stringify({
          subjectId,
          purpose: 'customer_support',
          channel: 'web.primary',
          consent: { state: 'recorded', evidenceId: 'invalid evidence' },
          ttlSeconds: 60,
          fieldIds: [target.fieldIds[0]!],
          rowOffset: 0,
          rowCount: 1,
        }),
      },
    )
    expect(invalidGrant.status).toBe(400)
    await expect(invalidGrant.json()).resolves.toMatchObject({
      error: 'access_grant_invalid',
    })
  })

  it('requires delegated subject authority and releases only the exact granted cells', async () => {
    const subjectId = 'person.synthetic-query'
    const receipt = ReceiptSchema.parse(await (await fetch(
      `${gw.baseUrl}/api/v1/source-data-views/${target.dataViewId}/access-grants`,
      {
        method: 'POST',
        headers: ownerHeaders('44444444-4444-4444-8444-444444444441'),
        body: JSON.stringify({
          subjectId,
          purpose: 'customer_support',
          channel: 'web.primary',
          consent: { state: 'not_required' },
          ttlSeconds: 60,
          fieldIds: [target.fieldIds[1]!],
          rowOffset: 1,
          rowCount: 2,
        }),
      },
    )).json())
    const token = await issueQueryDelegation('query.transport', subjectId)
    const query = (body: Record<string, unknown> = {
      consent: { state: 'not_required' },
      fieldIds: [target.fieldIds[1]!],
      rowOffset: 1,
      rowCount: 10,
    }) => fetch(`${gw.baseUrl}/api/v1/source-data-views/${target.dataViewId}/query`, {
      method: 'POST',
      headers: delegatedHeaders(token),
      body: JSON.stringify(body),
    })

    const response = await query()
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const raw = await response.text()
    expect(QueryResultSchema.parse(JSON.parse(raw))).toMatchObject({
      dataViewId: target.dataViewId,
      sourceId: target.sourceId,
      sourceVersionId: VERSION_ID,
      rowOffset: 1,
      requestedRowCount: 10,
      returnedRowCount: 2,
      totalRowCount: 3,
      complete: true,
      fields: [{ fieldId: target.fieldIds[1]!, label: 'plan' }],
      rows: [
        { ordinal: 1, values: ['pro'] },
        { ordinal: 2, values: ['team'] },
      ],
    })
    for (const withheld of ['alpha', 'beta', 'gamma', 'privateObjectKey', 'sources/']) {
      expect(raw).not.toContain(withheld)
    }

    const injectedSubject = await query({
      subjectId,
      consent: { state: 'not_required' },
      fieldIds: [target.fieldIds[1]!],
      rowOffset: 1,
      rowCount: 1,
    })
    expect(injectedSubject.status).toBe(400)
    const injectedRaw = await injectedSubject.text()
    expect(injectedRaw).toContain('source_data_view_query_invalid')
    expect(injectedRaw).not.toContain('pro')

    const revoke = await fetch(
      `${gw.baseUrl}/api/v1/access-grants/${receipt.grantId}/revoke`,
      {
        method: 'POST',
        headers: ownerHeaders('44444444-4444-4444-8444-444444444442'),
        body: JSON.stringify({ expectedRevision: 1 }),
      },
    )
    expect(revoke.status).toBe(200)
    const denied = await query()
    expect(denied.status).toBe(404)
    const deniedRaw = await denied.text()
    expect(deniedRaw).toContain('source_data_view_unavailable')
    expect(deniedRaw).not.toContain('pro')
  })

  it('returns no cells for missing route authority, wrong subject, or invalid query scope', async () => {
    const subjectId = 'person.synthetic-denials'
    const createGrant = await fetch(
      `${gw.baseUrl}/api/v1/source-data-views/${target.dataViewId}/access-grants`,
      {
        method: 'POST',
        headers: ownerHeaders('55555555-5555-4555-8555-555555555551'),
        body: JSON.stringify({
          subjectId,
          purpose: 'customer_support',
          channel: 'web.primary',
          consent: { state: 'not_required' },
          ttlSeconds: 60,
          fieldIds: [target.fieldIds[0]!],
          rowOffset: 0,
          rowCount: 1,
        }),
      },
    )
    expect(createGrant.status).toBe(201)
    const token = await issueQueryDelegation('query.denials', subjectId)
    const wrongSubject = await issueQueryDelegation(
      'query.wrong-subject', 'person.synthetic-other',
    )
    const noRouteAuthority = await issueDelegation(
      'query.no-authority', subjectId, ['source_data_views.read'],
    )
    const request = (authorization: string, body: Record<string, unknown>, suffix = '') =>
      fetch(`${gw.baseUrl}/api/v1/source-data-views/${target.dataViewId}/query${suffix}`, {
        method: 'POST',
        headers: delegatedHeaders(authorization),
        body: JSON.stringify(body),
      })
    const validBody = {
      consent: { state: 'not_required' },
      fieldIds: [target.fieldIds[0]!],
      rowOffset: 0,
      rowCount: 1,
    }
    const attempts = [
      { response: await request(noRouteAuthority, validBody), status: 403 },
      { response: await request(wrongSubject, validBody), status: 404 },
      { response: await request(token, { ...validBody, rowCount: 257 }), status: 413 },
      {
        response: await request(token, {
          ...validBody, fieldIds: Array(33).fill(target.fieldIds[0]!),
        }),
        status: 413,
      },
      {
        response: await request(token, {
          ...validBody, fieldIds: [target.fieldIds[0]!, target.fieldIds[0]!],
        }),
        status: 400,
      },
      { response: await request(token, validBody, '?filter=secret'), status: 400 },
    ]
    for (const attempt of attempts) {
      expect(attempt.response.status).toBe(attempt.status)
      const raw = await attempt.response.text()
      expect(raw).not.toContain('Ada')
      expect(raw).not.toContain('alpha')
    }

    const ownerBypass = await fetch(
      `${gw.baseUrl}/api/v1/source-data-views/${target.dataViewId}/query`,
      {
        method: 'POST',
        headers: ownerHeaders(),
        body: JSON.stringify(validBody),
      },
    )
    expect(ownerBypass.status).toBe(403)
  })

  async function seedDataView(): Promise<{
    readonly dataViewId: string
    readonly sourceId: string
    readonly fieldIds: readonly string[]
  }> {
    const source = new SourceStore(gw.state.rawDbHandle).create({
      workspaceId,
      profileId: PROFILE_ID,
      kind: 'structured_export',
      label: 'Synthetic Data View',
      classification: 'internal',
      authority: 'supporting_reference',
      audiencePolicyRef: 'audience.policy.test',
      sensitivityPolicyRef: 'sensitivity.policy.test',
      purposePolicyRef: 'purpose.policy.test',
      retentionPolicyRef: 'retention.policy.test',
      freshnessPolicyRef: 'freshness.policy.test',
    }, 10)
    const checksum = `sha256:${createHash('sha256').update(CSV).digest('hex')}`
    const objectKey = `sources/${source.sourceId}/versions/${VERSION_ID}/original`
    gw.state.rawDbHandle.prepare(`
      INSERT INTO source_versions (
        source_version_id, source_id, checksum, verified_media_type, byte_count,
        object_key, inspection_state, preparation_state, created_at
      ) VALUES (?, ?, ?, 'text/plain', ?, ?, 'complete', 'not_requested', 20)
    `).run(VERSION_ID, source.sourceId, checksum, CSV.length, objectKey)
    gw.state.rawDbHandle.prepare(`
      UPDATE runtime_sources SET registration_state = 'registered',
        current_version_id = ?, inspection_state = 'complete',
        freshness_state = 'fresh', updated_at = 20
      WHERE source_id = ?
    `).run(VERSION_ID, source.sourceId)
    const storage = new SourceByteStore(join(gw.tmpDir, 'data', 'source-storage'))
    const objectPath = join(gw.tmpDir, 'data', 'source-storage', objectKey)
    await mkdir(dirname(objectPath), { recursive: true })
    await writeFile(objectPath, CSV, { mode: 0o600 })
    const views = new SourceDataViewStore(gw.state.rawDbHandle)
    const job = views.enqueue({
      workspaceId, profileId: PROFILE_ID,
      sourceId: source.sourceId, sourceVersionId: VERSION_ID,
    }, 30)
    const claim = views.claimNext('data-view-contract-worker', 40)!
    const claimed = views.getClaimedTarget(job.jobId, claim.claimToken, 41)!
    expect(views.advanceCheckpoint(job.jobId, claim.claimToken, 0, 1, 42)).toBe('advanced')
    const artifact = await storage.prepareCsvDataViewArtifact(claimed)
    expect(views.advanceCheckpoint(job.jobId, claim.claimToken, 1, 2, 43)).toBe('advanced')
    expect(views.advanceCheckpoint(job.jobId, claim.claimToken, 2, 3, 44)).toBe('advanced')
    expect(views.publish(job.jobId, claim.claimToken, artifact, 45)).toBe('finished')
    const manifest = views.getViewScoped(claim.dataViewId, workspaceId, PROFILE_ID)!
    return {
      dataViewId: manifest.dataViewId,
      sourceId: manifest.sourceId,
      fieldIds: manifest.fields.map((field) => field.fieldId),
    }
  }

  function ownerHeaders(idempotencyKey?: string): Record<string, string> {
    return {
      Authorization: `Bearer ${gw.token}`,
      'Content-Type': 'application/json',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    }
  }

  function delegatedHeaders(token: string): Record<string, string> {
    return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  }

  async function issueQueryDelegation(delegateId: string, subjectId: string): Promise<string> {
    return issueDelegation(delegateId, subjectId, ['source_data_views.query'])
  }

  async function issueDelegation(
    delegateId: string,
    subjectId: string,
    operations: readonly string[],
  ): Promise<string> {
    const response = await fetch(`${gw.baseUrl}/api/v1/auth/delegations`, {
      method: 'POST',
      headers: ownerHeaders(),
      body: JSON.stringify({
        delegateId,
        subjectId,
        workspaceId,
        profileId: PROFILE_ID,
        purpose: 'customer_support',
        channel: 'web.primary',
        operations,
      }),
    })
    expect(response.status).toBe(201)
    return ((await response.json()) as { token: string }).token
  }
})
