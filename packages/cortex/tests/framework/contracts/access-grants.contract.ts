import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { SourceJobStore } from '../../../src/gateway/source-job-store.js'
import { SourceStore } from '../../../src/gateway/source-store.js'
import { createTestGateway, type TestGateway } from '../harness/index.js'

const ReceiptSchema = z.object({
  grantId: z.string().uuid(),
  revision: z.number().int().positive(),
  mutation: z.enum(['created', 'revoked']),
  acceptedAt: z.number().int().nonnegative(),
}).strict()
const GrantSchema = z.object({
  grantId: z.string().uuid(),
  revision: z.number().int().positive(),
  state: z.enum(['active', 'revoked']),
  workspaceId: z.string(),
  profileId: z.string(),
  subjectId: z.string(),
  purpose: z.string(),
  channel: z.string().nullable(),
  resourceKind: z.literal('source_resource'),
  resourceId: z.string().uuid(),
  operation: z.enum(['source_content.read', 'source_content.search']),
  fieldScope: z.object({ mode: z.literal('all') }).strict(),
  rowScope: z.object({ mode: z.literal('all') }).strict(),
  consent: z.discriminatedUnion('state', [
    z.object({ state: z.literal('not_required') }).strict(),
    z.object({ state: z.literal('recorded'), evidenceId: z.string() }).strict(),
  ]),
  autonomyCeiling: z.literal('observe'),
  effectiveAt: z.number().int(),
  expiresAt: z.number().int(),
  issuedBy: z.literal('install_owner'),
  revisionCreatedAt: z.number().int(),
  revokedAt: z.number().int().nullable(),
}).strict()
const CurrentGrantSchema = GrantSchema.extend({
  lifecycle: z.enum(['scheduled', 'effective', 'expired', 'revoked']),
}).strict()
const ContentSchema = z.object({
  resourceId: z.string().uuid(),
  sourceId: z.string().uuid(),
  sourceVersionId: z.string().uuid(),
  sourceRevision: z.number().int().positive(),
  sourceChecksum: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  resourceChecksum: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  freshness: z.literal('current'),
  classification: z.literal('internal'),
  authority: z.literal('supporting_reference'),
  text: z.string(),
  byteStart: z.number().int().nonnegative(),
  byteEnd: z.number().int().positive(),
  byteCount: z.number().int().positive(),
  totalByteCount: z.number().int().positive(),
  observedAt: z.number().int().nonnegative(),
}).strict()
const SearchSchema = z.object({
  resourceId: z.string().uuid(),
  sourceId: z.string().uuid(),
  sourceVersionId: z.string().uuid(),
  sourceRevision: z.number().int().positive(),
  sourceChecksum: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  resourceChecksum: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  freshness: z.literal('current'),
  classification: z.literal('internal'),
  authority: z.literal('supporting_reference'),
  status: z.enum(['complete', 'no_matches']),
  matchMode: z.enum(['exact_utf8', 'ascii_case_insensitive']),
  matches: z.array(z.object({
    evidenceId: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    text: z.string(),
    byteStart: z.number().int().nonnegative(),
    byteEnd: z.number().int().positive(),
    matchByteStart: z.number().int().nonnegative(),
    matchByteEnd: z.number().int().positive(),
  }).strict()).max(20),
  truncated: z.boolean(),
  totalByteCount: z.number().int().positive(),
  observedAt: z.number().int().nonnegative(),
}).strict()

const PROFILE_ID = 'mini'
const VERSION_ID = '11111111-1111-4111-8111-111111111111'
const CONTENT = Buffer.from('first|caf\u00e9|final')

describe('Contract: owner grants and protected source content', () => {
  let gw: TestGateway
  let workspaceId: string
  let target: Awaited<ReturnType<typeof seedPreparedText>>
  let contentToken: string
  let searchToken: string
  let adminToken: string

  beforeAll(async () => {
    gw = await createTestGateway({ disableAuth: false, disableSourceWorker: true })
    workspaceId = gw.state.createWorkspace(gw.tmpDir, 'Access grant contract').id
    target = await seedPreparedText()
    contentToken = await issue(
      'content-client', ['source_content.read'], 'person.synthetic-1',
    )
    searchToken = await issue(
      'search-client', ['source_content.search'], 'person.synthetic-1',
    )
    adminToken = await issue('admin-client', [
      'access_grants.create', 'access_grants.list',
      'access_grants.read', 'access_grants.revoke',
    ])
  })

  afterAll(async () => {
    await gw.stop()
  })

  it('creates and exactly replays only a minimal owner receipt', async () => {
    const key = '22222222-2222-4222-8222-222222222222'
    const create = () => fetch(
      `${gw.baseUrl}/api/v1/source-resources/${target.resourceId}/access-grants`,
      {
        method: 'POST',
        headers: ownerHeaders(key),
        body: JSON.stringify(grantInput('person.receipt-only')),
      },
    )
    const response = await create()
    expect(response.status).toBe(201)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const raw = await response.text()
    const receipt = ReceiptSchema.parse(JSON.parse(raw))
    expect(receipt).toMatchObject({ revision: 1, mutation: 'created' })
    expect(Object.keys(JSON.parse(raw))).toEqual([
      'grantId', 'revision', 'mutation', 'acceptedAt',
    ])
    expect(raw).not.toContain('person.synthetic-1')
    expect(raw).not.toContain('consent.synthetic-1')
    expect(raw).not.toContain('sources/')

    const replay = await create()
    expect(replay.status).toBe(201)
    expect(replay.headers.get('idempotency-replayed')).toBe('true')
    expect(ReceiptSchema.parse(await replay.json())).toEqual(receipt)

    const conflict = await fetch(
      `${gw.baseUrl}/api/v1/source-resources/${target.resourceId}/access-grants`,
      {
        method: 'POST',
        headers: ownerHeaders(key),
        body: JSON.stringify(grantInput('person.different-input')),
      },
    )
    expect(conflict.status).toBe(409)
    await expect(conflict.json()).resolves.toMatchObject({ error: 'idempotency_conflict' })

    const detail = await fetch(`${gw.baseUrl}/api/v1/access-grants/${receipt.grantId}`, {
      headers: ownerHeaders(),
    })
    expect(detail.status).toBe(200)
    expect(GrantSchema.parse(await detail.json())).toMatchObject({
      grantId: receipt.grantId,
      workspaceId,
      profileId: PROFILE_ID,
      subjectId: 'person.receipt-only',
      resourceId: target.resourceId,
      operation: 'source_content.read',
      autonomyCeiling: 'observe',
    })

    const list = await fetch(`${gw.baseUrl}/api/v1/access-grants?limit=1`, {
      headers: ownerHeaders(),
    })
    expect(list.status).toBe(200)
    const page = z.object({
      items: z.array(CurrentGrantSchema),
      nextCursor: z.string().uuid().nullable(),
    }).strict().parse(await list.json())
    expect(page.items).toHaveLength(1)
    expect(page.items[0]?.grantId).toBe(receipt.grantId)
  })

  it('requires both delegated route authority and the matching live grant', async () => {
    const key = '33333333-3333-4333-8333-333333333333'
    const created = ReceiptSchema.parse(await (await fetch(
      `${gw.baseUrl}/api/v1/source-resources/${target.resourceId}/access-grants`,
      {
        method: 'POST', headers: ownerHeaders(key), body: JSON.stringify(grantInput()),
      },
    )).json())
    const request = () => fetch(
      `${gw.baseUrl}/api/v1/source-resources/${target.resourceId}/content`,
      {
        method: 'POST',
        headers: delegatedHeaders(contentToken),
        body: JSON.stringify({
          consent: { state: 'recorded', evidenceId: 'consent.synthetic-1' },
          byteStart: 6,
          byteEnd: 11,
        }),
      },
    )
    const content = await request()
    expect(content.status).toBe(200)
    const raw = await content.text()
    expect(ContentSchema.parse(JSON.parse(raw))).toMatchObject({
      resourceId: target.resourceId,
      sourceId: target.sourceId,
      sourceVersionId: VERSION_ID,
      text: 'caf\u00e9',
      byteStart: 6,
      byteEnd: 11,
    })
    expect(raw).not.toContain('sources/')
    expect(raw).not.toContain('policy.test')

    const oversized = await fetch(
      `${gw.baseUrl}/api/v1/source-resources/${target.resourceId}/content`,
      {
        method: 'POST',
        headers: delegatedHeaders(contentToken),
        body: JSON.stringify({
          consent: { state: 'recorded', evidenceId: 'consent.synthetic-1' },
          byteStart: 0,
          byteEnd: 65_537,
        }),
      },
    )
    expect(oversized.status).toBe(413)
    await expect(oversized.json()).resolves.toMatchObject({
      error: 'source_content_range_too_large',
    })

    const noRouteAuthority = await fetch(
      `${gw.baseUrl}/api/v1/source-resources/${target.resourceId}/content`,
      {
        method: 'POST',
        headers: delegatedHeaders(adminToken),
        body: JSON.stringify({
          consent: { state: 'recorded', evidenceId: 'consent.synthetic-1' },
          byteStart: 0,
          byteEnd: 1,
        }),
      },
    )
    expect(noRouteAuthority.status).toBe(403)

    const ownerBypass = await fetch(
      `${gw.baseUrl}/api/v1/source-resources/${target.resourceId}/content`,
      {
        method: 'POST', headers: ownerHeaders(),
        body: JSON.stringify({
          consent: { state: 'recorded', evidenceId: 'consent.synthetic-1' },
          byteStart: 0, byteEnd: 1,
        }),
      },
    )
    expect(ownerBypass.status).toBe(403)

    const injectedSubject = await fetch(
      `${gw.baseUrl}/api/v1/source-resources/${target.resourceId}/content`,
      {
        method: 'POST', headers: delegatedHeaders(contentToken),
        body: JSON.stringify({
          subjectId: 'person.synthetic-other',
          consent: { state: 'recorded', evidenceId: 'consent.synthetic-1' },
          byteStart: 0, byteEnd: 1,
        }),
      },
    )
    expect(injectedSubject.status).toBe(400)
    await expect(injectedSubject.json()).resolves.toMatchObject({
      error: 'source_content_request_invalid',
    })

    const otherSubjectToken = await issue(
      'content-client-other-subject', ['source_content.read'], 'person.synthetic-other',
    )
    const wrongSubject = await fetch(
      `${gw.baseUrl}/api/v1/source-resources/${target.resourceId}/content`,
      {
        method: 'POST', headers: delegatedHeaders(otherSubjectToken),
        body: JSON.stringify({
          consent: { state: 'recorded', evidenceId: 'consent.synthetic-1' },
          byteStart: 0, byteEnd: 1,
        }),
      },
    )
    expect(wrongSubject.status).toBe(404)
    await expect(wrongSubject.json()).resolves.toMatchObject({
      error: 'source_content_unavailable',
    })

    const revokeKey = '44444444-4444-4444-8444-444444444444'
    const revoke = () => fetch(
      `${gw.baseUrl}/api/v1/access-grants/${created.grantId}/revoke`,
      {
        method: 'POST', headers: ownerHeaders(revokeKey),
        body: JSON.stringify({ expectedRevision: 1 }),
      },
    )
    const revokedResponse = await revoke()
    expect(revokedResponse.status).toBe(200)
    const revoked = ReceiptSchema.parse(await revokedResponse.json())
    expect(revoked).toMatchObject({
      grantId: created.grantId, revision: 2, mutation: 'revoked',
    })
    const replay = await revoke()
    expect(replay.headers.get('idempotency-replayed')).toBe('true')
    expect(ReceiptSchema.parse(await replay.json())).toEqual(revoked)
    expect((await request()).status).toBe(404)

    const stale = await fetch(
      `${gw.baseUrl}/api/v1/access-grants/${created.grantId}/revoke`,
      {
        method: 'POST',
        headers: ownerHeaders('45454545-4545-4545-8545-454545454545'),
        body: JSON.stringify({ expectedRevision: 1 }),
      },
    )
    expect(stale.status).toBe(409)
    await expect(stale.json()).resolves.toMatchObject({
      error: 'access_grant_revision_conflict',
      actualRevision: 2,
    })
  })

  it('keeps administration owner-only even when a delegated token advertises it', async () => {
    const delegatedCreate = await fetch(
      `${gw.baseUrl}/api/v1/source-resources/${target.resourceId}/access-grants`,
      {
        method: 'POST',
        headers: { ...delegatedHeaders(adminToken), 'Idempotency-Key': randomUUID() },
        body: JSON.stringify(grantInput()),
      },
    )
    expect(delegatedCreate.status).toBe(403)
    await expect(delegatedCreate.json()).resolves.toMatchObject({ error: 'owner_required' })
    expect((await fetch(`${gw.baseUrl}/api/v1/access-grants`, {
      headers: delegatedHeaders(adminToken),
    })).status).toBe(403)
  })

  it('admits only purpose and channel values that a delegated principal can represent', async () => {
    const base = {
      ...grantInput('person.synthetic-boundaries'),
      purpose: 'p'.repeat(64),
      channel: 'c'.repeat(64),
    }
    const accepted = await fetch(
      `${gw.baseUrl}/api/v1/source-resources/${target.resourceId}/access-grants`,
      {
        method: 'POST',
        headers: ownerHeaders('46464646-4646-4646-8646-464646464646'),
        body: JSON.stringify(base),
      },
    )
    expect(accepted.status).toBe(201)

    for (const [key, body] of [
      ['47474747-4747-4747-8747-474747474747', { ...base, purpose: 'p'.repeat(65) }],
      ['48484848-4848-4848-8848-484848484848', { ...base, channel: 'c'.repeat(65) }],
    ] as const) {
      const response = await fetch(
        `${gw.baseUrl}/api/v1/source-resources/${target.resourceId}/access-grants`,
        {
          method: 'POST', headers: ownerHeaders(key), body: JSON.stringify(body),
        },
      )
      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toMatchObject({ error: 'access_grant_invalid' })
    }
  })

  it('rejects malformed consent evidence structurally across grant, read, and search routes', async () => {
    const invalidConsent = { state: 'recorded', evidenceId: 'invalid evidence' }
    const unknownResourceId = '49494949-4949-4949-8949-494949494949'
    const grant = await fetch(
      `${gw.baseUrl}/api/v1/source-resources/${unknownResourceId}/access-grants`,
      {
        method: 'POST',
        headers: ownerHeaders('50505050-5050-4050-8050-505050505050'),
        body: JSON.stringify({ ...grantInput(), consent: invalidConsent }),
      },
    )
    expect(grant.status).toBe(400)
    await expect(grant.json()).resolves.toMatchObject({ error: 'access_grant_invalid' })

    const read = await fetch(
      `${gw.baseUrl}/api/v1/source-resources/${target.resourceId}/content`,
      {
        method: 'POST',
        headers: delegatedHeaders(contentToken),
        body: JSON.stringify({
          consent: invalidConsent,
          byteStart: 0,
          byteEnd: 1,
        }),
      },
    )
    expect(read.status).toBe(400)
    await expect(read.json()).resolves.toMatchObject({
      error: 'source_content_request_invalid',
    })

    const search = await fetch(
      `${gw.baseUrl}/api/v1/source-resources/${target.resourceId}/content/search`,
      {
        method: 'POST',
        headers: delegatedHeaders(searchToken),
        body: JSON.stringify({
          consent: invalidConsent,
          query: 'first',
          matchMode: 'exact_utf8',
          maxMatches: 1,
          contextBytes: 0,
        }),
      },
    )
    expect(search.status).toBe(400)
    await expect(search.json()).resolves.toMatchObject({
      error: 'source_content_search_request_invalid',
    })

    const injectedSubject = await fetch(
      `${gw.baseUrl}/api/v1/source-resources/${target.resourceId}/content/search`,
      {
        method: 'POST',
        headers: delegatedHeaders(searchToken),
        body: JSON.stringify({
          subjectId: 'person.synthetic-other',
          consent: { state: 'recorded', evidenceId: 'consent.synthetic-1' },
          query: 'first',
          matchMode: 'exact_utf8',
          maxMatches: 1,
          contextBytes: 0,
        }),
      },
    )
    expect(injectedSubject.status).toBe(400)
    await expect(injectedSubject.json()).resolves.toMatchObject({
      error: 'source_content_search_request_invalid',
    })
  })

  it('keeps search authority separate, returns evidence, and revokes it without revoking read', async () => {
    const subjectId = 'person.synthetic-search'
    const subjectReadToken = await issue(
      'content-client-search-subject', ['source_content.read'], subjectId,
    )
    const subjectSearchToken = await issue(
      'search-client-search-subject', ['source_content.search'], subjectId,
    )
    const readGrant = ReceiptSchema.parse(await (await fetch(
      `${gw.baseUrl}/api/v1/source-resources/${target.resourceId}/access-grants`,
      {
        method: 'POST',
        headers: ownerHeaders('56565656-5656-4656-8656-565656565656'),
        body: JSON.stringify(grantInput(subjectId)),
      },
    )).json())
    const searchGrantResponse = await fetch(
      `${gw.baseUrl}/api/v1/source-resources/${target.resourceId}/access-grants`,
      {
        method: 'POST',
        headers: ownerHeaders('57575757-5757-4757-8757-575757575757'),
        body: JSON.stringify({
          ...grantInput(subjectId), operation: 'source_content.search',
        }),
      },
    )
    expect(searchGrantResponse.status).toBe(201)
    const searchGrant = ReceiptSchema.parse(await searchGrantResponse.json())

    const search = () => fetch(
      `${gw.baseUrl}/api/v1/source-resources/${target.resourceId}/content/search`,
      {
        method: 'POST', headers: delegatedHeaders(subjectSearchToken),
        body: JSON.stringify({
          consent: { state: 'recorded', evidenceId: 'consent.synthetic-1' },
          query: 'CAFÉ', matchMode: 'ascii_case_insensitive',
          maxMatches: 20, contextBytes: 2,
        }),
      },
    )
    const invalidAscii = await search()
    expect(invalidAscii.status).toBe(400)
    await expect(invalidAscii.json()).resolves.toMatchObject({
      error: 'source_content_search_request_invalid',
    })

    const resultResponse = await fetch(
      `${gw.baseUrl}/api/v1/source-resources/${target.resourceId}/content/search`,
      {
        method: 'POST', headers: delegatedHeaders(subjectSearchToken),
        body: JSON.stringify({
          consent: { state: 'recorded', evidenceId: 'consent.synthetic-1' },
          query: 'café', matchMode: 'exact_utf8', maxMatches: 20, contextBytes: 2,
        }),
      },
    )
    expect(resultResponse.status).toBe(200)
    expect(SearchSchema.parse(await resultResponse.json())).toMatchObject({
      status: 'complete',
      matches: [{ matchByteStart: 6, matchByteEnd: 11, text: 't|café|f' }],
    })

    const otherSubjectSearchToken = await issue(
      'search-client-other-subject', ['source_content.search'], 'person.synthetic-other',
    )
    const crossSubject = await fetch(
      `${gw.baseUrl}/api/v1/source-resources/${target.resourceId}/content/search`,
      {
        method: 'POST',
        headers: delegatedHeaders(otherSubjectSearchToken),
        body: JSON.stringify({
          consent: { state: 'recorded', evidenceId: 'consent.synthetic-1' },
          query: 'café', matchMode: 'exact_utf8', maxMatches: 20, contextBytes: 2,
        }),
      },
    )
    expect(crossSubject.status).toBe(404)
    await expect(crossSubject.json()).resolves.toMatchObject({
      error: 'source_content_unavailable',
    })

    const wrongRoute = await fetch(
      `${gw.baseUrl}/api/v1/source-resources/${target.resourceId}/content/search`,
      {
        method: 'POST', headers: delegatedHeaders(subjectReadToken),
        body: JSON.stringify({
          consent: { state: 'recorded', evidenceId: 'consent.synthetic-1' },
          query: 'café', matchMode: 'exact_utf8', maxMatches: 20, contextBytes: 2,
        }),
      },
    )
    expect(wrongRoute.status).toBe(403)

    const revoke = await fetch(
      `${gw.baseUrl}/api/v1/access-grants/${searchGrant.grantId}/revoke`,
      {
        method: 'POST',
        headers: ownerHeaders('58585858-5858-4858-8858-585858585858'),
        body: JSON.stringify({ expectedRevision: 1 }),
      },
    )
    expect(revoke.status).toBe(200)

    const deniedSearch = await fetch(
      `${gw.baseUrl}/api/v1/source-resources/${target.resourceId}/content/search`,
      {
        method: 'POST', headers: delegatedHeaders(subjectSearchToken),
        body: JSON.stringify({
          consent: { state: 'recorded', evidenceId: 'consent.synthetic-1' },
          query: 'first', matchMode: 'exact_utf8', maxMatches: 20, contextBytes: 0,
        }),
      },
    )
    expect(deniedSearch.status).toBe(404)

    const read = await fetch(
      `${gw.baseUrl}/api/v1/source-resources/${target.resourceId}/content`,
      {
        method: 'POST', headers: delegatedHeaders(subjectReadToken),
        body: JSON.stringify({
          consent: { state: 'recorded', evidenceId: 'consent.synthetic-1' },
          byteStart: 0, byteEnd: 5,
        }),
      },
    )
    expect(read.status).toBe(200)
    expect(ContentSchema.parse(await read.json())).toMatchObject({ text: 'first' })
    expect(readGrant.grantId).not.toBe(searchGrant.grantId)
  })

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

  function grantInput(subjectId = 'person.synthetic-1') {
    return {
      subjectId,
      purpose: 'customer_support',
      channel: 'web.primary',
      consent: { state: 'recorded', evidenceId: 'consent.synthetic-1' },
      ttlSeconds: 60,
    }
  }

  async function issue(
    delegateId: string,
    operations: readonly string[],
    subjectId?: string,
  ): Promise<string> {
    const response = await fetch(`${gw.baseUrl}/api/v1/auth/delegations`, {
      method: 'POST',
      headers: ownerHeaders(),
      body: JSON.stringify({
        delegateId, workspaceId, profileId: PROFILE_ID, subjectId,
        purpose: 'customer_support', channel: 'web.primary', operations,
      }),
    })
    expect(response.status).toBe(201)
    return ((await response.json()) as { token: string }).token
  }

  async function seedPreparedText(): Promise<{
    sourceId: string
    resourceId: string
  }> {
    const source = new SourceStore(gw.state.rawDbHandle).create({
      workspaceId,
      profileId: PROFILE_ID,
      kind: 'file',
      label: 'Synthetic protected source',
      classification: 'internal',
      authority: 'supporting_reference',
      audiencePolicyRef: 'audience.policy.test',
      sensitivityPolicyRef: 'sensitivity.policy.test',
      purposePolicyRef: 'purpose.policy.test',
      retentionPolicyRef: 'retention.policy.test',
      freshnessPolicyRef: 'freshness.policy.test',
    }, 10)
    const objectKey = `sources/${source.sourceId}/versions/${VERSION_ID}/original`
    const digest = `sha256:${createHash('sha256').update(CONTENT).digest('hex')}`
    gw.state.rawDbHandle.prepare(`
      INSERT INTO source_versions (
        source_version_id, source_id, checksum, verified_media_type,
        byte_count, object_key, inspection_state, created_at
      ) VALUES (?, ?, ?, 'text/plain', ?, ?, 'complete', 20)
    `).run(VERSION_ID, source.sourceId, digest, CONTENT.length, objectKey)
    gw.state.rawDbHandle.prepare(`
      UPDATE runtime_sources SET registration_state = 'registered',
        current_version_id = ?, inspection_state = 'complete',
        freshness_state = 'fresh', updated_at = 20
      WHERE source_id = ?
    `).run(VERSION_ID, source.sourceId)
    const jobs = new SourceJobStore(gw.state.rawDbHandle)
    const job = jobs.enqueuePreparation({
      workspaceId, profileId: PROFILE_ID,
      sourceId: source.sourceId, sourceVersionId: VERSION_ID,
    }, 30)
    const claim = jobs.claimNext('access-grant-contract-worker', 40)!
    for (const checkpoint of [1, 2, 3]) {
      expect(jobs.advanceCheckpoint(
        job.jobId, claim.claimToken, checkpoint - 1, checkpoint, 40 + checkpoint,
      )).toBe('advanced')
    }
    expect(jobs.finishPreparation(
      job.jobId, claim.claimToken, 'succeeded', 'preparation_complete', 50,
    )).toBe('finished')
    const objectPath = join(gw.tmpDir, 'data', 'source-storage', objectKey)
    await mkdir(dirname(objectPath), { recursive: true })
    await writeFile(objectPath, CONTENT, { mode: 0o600 })
    return { sourceId: source.sourceId, resourceId: claim.resourceId! }
  }
})

describe('Contract: grant administration requires authenticated mode', () => {
  let gw: TestGateway

  beforeAll(async () => {
    gw = await createTestGateway({ disableAuth: true, disableSourceWorker: true })
  })

  afterAll(async () => {
    await gw.stop()
  })

  it('rejects owner grant administration when authentication is disabled', async () => {
    const response = await fetch(`${gw.baseUrl}/api/v1/access-grants`)
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ error: 'auth_required' })
  })
})
