import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OwnwareGateway } from '../../../src/gateway/server.js'
import { SourceJobStore } from '../../../src/gateway/source-job-store.js'
import { SourceStore } from '../../../src/gateway/source-store.js'
import { createTestGateway } from '../../framework/harness/gateway.js'

const VERSION_ID = '91919191-abab-4919-8919-919191919191'
const CREATE_KEY = '92929292-abab-4929-8929-929292929292'
const REVOKE_KEY = '93939393-abab-4939-8939-939393939393'
const BYTES = Buffer.from('restart|protected|content', 'utf8')

let cleanupDir: string | undefined
let running: OwnwareGateway | undefined

afterEach(async () => {
  await running?.stop()
  running = undefined
  if (cleanupDir) await rm(cleanupDir, { recursive: true, force: true })
  cleanupDir = undefined
})

describe('public access grants across real Gateway restarts', () => {
  it('replays minimal create/revoke receipts and enforces persisted live state', async () => {
    const gateway = await createTestGateway({
      disableAuth: false,
      disableSourceWorker: true,
    })
    cleanupDir = gateway.tmpDir
    const workspaceId = gateway.state.createWorkspace(
      gateway.tmpDir,
      'Access grant restart',
    ).id
    const target = await seedPreparedText(gateway, workspaceId)
    const issued = await gateway.client.post('/api/v1/auth/delegations', {
      delegateId: 'access-grant-restart-reader',
      workspaceId,
      profileId: 'mini',
      subjectId: 'person.restart-synthetic',
      purpose: 'customer_support',
      channel: 'web.primary',
      operations: ['source_content.read'],
    })
    const delegatedToken = (issued.body as { token: string }).token
    const createBody = JSON.stringify({
      subjectId: 'person.restart-synthetic',
      purpose: 'customer_support',
      channel: 'web.primary',
      consent: { state: 'not_required' },
      ttlSeconds: 300,
    })
    const create = (instance: OwnwareGateway) => fetch(
      `http://127.0.0.1:${instance.port}/api/v1/source-resources/${target.resourceId}/access-grants`,
      {
        method: 'POST',
        headers: ownerHeaders(instance, CREATE_KEY),
        body: createBody,
      },
    )
    const firstResponse = await create(gateway)
    expect(firstResponse.status).toBe(201)
    const created = await firstResponse.json() as {
      grantId: string
      revision: number
      mutation: string
      acceptedAt: number
    }
    expect(Object.keys(created)).toEqual(['grantId', 'revision', 'mutation', 'acceptedAt'])

    await gateway.stop({ cleanup: false })
    running = await restart(cleanupDir)
    const replay = await create(running)
    expect(replay.status).toBe(201)
    expect(replay.headers.get('idempotency-replayed')).toBe('true')
    expect(await replay.json()).toEqual(created)
    expect((running.state.rawDbHandle.prepare(
      'SELECT COUNT(*) AS count FROM access_grants',
    ).get() as { count: number }).count).toBe(1)

    const content = () => fetch(
      `http://127.0.0.1:${running!.port}/api/v1/source-resources/${target.resourceId}/content`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${delegatedToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          consent: { state: 'not_required' },
          byteStart: 8,
          byteEnd: 17,
        }),
      },
    )
    const read = await content()
    expect(read.status).toBe(200)
    await expect(read.json()).resolves.toMatchObject({ text: 'protected' })

    const revoke = (instance: OwnwareGateway) => fetch(
      `http://127.0.0.1:${instance.port}/api/v1/access-grants/${created.grantId}/revoke`,
      {
        method: 'POST',
        headers: ownerHeaders(instance, REVOKE_KEY),
        body: JSON.stringify({ expectedRevision: 1 }),
      },
    )
    const revokedResponse = await revoke(running)
    expect(revokedResponse.status).toBe(200)
    const revoked = await revokedResponse.json()
    expect(revoked).toMatchObject({
      grantId: created.grantId,
      revision: 2,
      mutation: 'revoked',
    })
    expect((await content()).status).toBe(404)
    running.state.rawDbHandle.prepare(`
      UPDATE runtime_sources SET freshness_state = 'stale'
      WHERE source_id = (
        SELECT source_id FROM source_derived_resources WHERE resource_id = ?
      )
    `).run(target.resourceId)

    await running.stop({ cleanup: false })
    running = await restart(cleanupDir)
    const createReplayAfterInvalidation = await create(running)
    expect(createReplayAfterInvalidation.status).toBe(201)
    expect(createReplayAfterInvalidation.headers.get('idempotency-replayed')).toBe('true')
    expect(await createReplayAfterInvalidation.json()).toEqual(created)
    const revokeReplay = await revoke(running)
    expect(revokeReplay.status).toBe(200)
    expect(revokeReplay.headers.get('idempotency-replayed')).toBe('true')
    expect(await revokeReplay.json()).toEqual(revoked)
    expect((await content()).status).toBe(404)
  }, 20_000)

  it('persists separate search authority and revokes it without revoking read', async () => {
    const gateway = await createTestGateway({
      disableAuth: false,
      disableSourceWorker: true,
    })
    cleanupDir = gateway.tmpDir
    const workspaceId = gateway.state.createWorkspace(
      gateway.tmpDir, 'Search grant restart',
    ).id
    const target = await seedPreparedText(gateway, workspaceId)
    const issued = await gateway.client.post('/api/v1/auth/delegations', {
      delegateId: 'search-grant-restart-client',
      workspaceId,
      profileId: 'mini',
      subjectId: 'person.restart-search',
      purpose: 'customer_support',
      channel: 'web.primary',
      operations: ['source_content.read', 'source_content.search'],
    })
    const token = (issued.body as { token: string }).token
    const common = {
      subjectId: 'person.restart-search',
      purpose: 'customer_support',
      channel: 'web.primary',
      consent: { state: 'not_required' },
      ttlSeconds: 300,
    }
    const createGrant = async (operation: 'source_content.read' | 'source_content.search',
      key: string) => {
      const response = await fetch(
        `${gateway.baseUrl}/api/v1/source-resources/${target.resourceId}/access-grants`,
        {
          method: 'POST', headers: ownerHeaders(gateway, key),
          body: JSON.stringify({ ...common, operation }),
        },
      )
      expect(response.status).toBe(201)
      return await response.json() as { grantId: string; revision: number }
    }
    const readGrant = await createGrant(
      'source_content.read', '94949494-abab-4949-8949-949494949494',
    )
    const searchGrant = await createGrant(
      'source_content.search', '95959595-abab-4959-8959-959595959595',
    )

    await gateway.stop({ cleanup: false })
    running = await restart(cleanupDir)
    const delegatedHeaders = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    }
    const search = () => fetch(
      `http://127.0.0.1:${running!.port}/api/v1/source-resources/${target.resourceId}/content/search`,
      {
        method: 'POST', headers: delegatedHeaders,
        body: JSON.stringify({
          consent: common.consent,
          query: 'PROTECTED', matchMode: 'ascii_case_insensitive',
          maxMatches: 20, contextBytes: 1,
        }),
      },
    )
    const found = await search()
    expect(found.status).toBe(200)
    await expect(found.json()).resolves.toMatchObject({
      status: 'complete', matches: [{ matchByteStart: 8, matchByteEnd: 17 }],
    })

    const revoked = await fetch(
      `http://127.0.0.1:${running.port}/api/v1/access-grants/${searchGrant.grantId}/revoke`,
      {
        method: 'POST',
        headers: ownerHeaders(running, '96969696-abab-4969-8969-969696969696'),
        body: JSON.stringify({ expectedRevision: searchGrant.revision }),
      },
    )
    expect(revoked.status).toBe(200)
    expect((await search()).status).toBe(404)

    const read = await fetch(
      `http://127.0.0.1:${running.port}/api/v1/source-resources/${target.resourceId}/content`,
      {
        method: 'POST', headers: delegatedHeaders,
        body: JSON.stringify({
          consent: common.consent,
          byteStart: 8, byteEnd: 17,
        }),
      },
    )
    expect(read.status).toBe(200)
    await expect(read.json()).resolves.toMatchObject({ text: 'protected' })
    expect(readGrant.grantId).not.toBe(searchGrant.grantId)
  }, 20_000)
})

function ownerHeaders(
  gateway: OwnwareGateway,
  idempotencyKey: string,
): Record<string, string> {
  return {
    Authorization: `Bearer ${gateway.token}`,
    'Content-Type': 'application/json',
    'Idempotency-Key': idempotencyKey,
  }
}

async function restart(rootDir: string): Promise<OwnwareGateway> {
  const gateway = new OwnwareGateway({
    port: 0,
    profilesDir: join(rootDir, 'profiles'),
    dataDir: join(rootDir, 'data'),
    dbPath: join(rootDir, 'test.db'),
    tls: false,
    disableAuth: false,
    disableSourceWorker: true,
  })
  await gateway.start()
  return gateway
}

async function seedPreparedText(
  gateway: Awaited<ReturnType<typeof createTestGateway>>,
  workspaceId: string,
): Promise<{ resourceId: string }> {
  const source = new SourceStore(gateway.state.rawDbHandle).create({
    workspaceId,
    profileId: 'mini',
    kind: 'file',
    label: 'Synthetic restart source',
    classification: 'internal',
    authority: 'supporting_reference',
    audiencePolicyRef: 'audience.test',
    sensitivityPolicyRef: 'sensitivity.test',
    purposePolicyRef: 'purpose.test',
    retentionPolicyRef: 'retention.test',
    freshnessPolicyRef: 'freshness.test',
  })
  const objectKey = `sources/${source.sourceId}/versions/${VERSION_ID}/original`
  const checksum = `sha256:${createHash('sha256').update(BYTES).digest('hex')}`
  gateway.state.rawDbHandle.prepare(`
    INSERT INTO source_versions (
      source_version_id, source_id, checksum, verified_media_type,
      byte_count, object_key, inspection_state, created_at
    ) VALUES (?, ?, ?, 'text/plain', ?, ?, 'complete', ?)
  `).run(VERSION_ID, source.sourceId, checksum, BYTES.length, objectKey, Date.now())
  gateway.state.rawDbHandle.prepare(`
    UPDATE runtime_sources SET registration_state = 'registered',
      current_version_id = ?, inspection_state = 'complete',
      freshness_state = 'fresh', updated_at = ?
    WHERE source_id = ?
  `).run(VERSION_ID, Date.now(), source.sourceId)
  const jobs = new SourceJobStore(gateway.state.rawDbHandle)
  const job = jobs.enqueuePreparation({
    workspaceId,
    profileId: 'mini',
    sourceId: source.sourceId,
    sourceVersionId: VERSION_ID,
  })
  const claim = jobs.claimNext('access-grant-restart-seed')!
  for (const checkpoint of [1, 2, 3]) {
    expect(jobs.advanceCheckpoint(
      job.jobId,
      claim.claimToken,
      checkpoint - 1,
      checkpoint,
    )).toBe('advanced')
  }
  expect(jobs.finishPreparation(
    job.jobId,
    claim.claimToken,
    'succeeded',
    'preparation_complete',
  )).toBe('finished')
  const objectPath = join(gateway.tmpDir, 'data', 'source-storage', objectKey)
  await mkdir(dirname(objectPath), { recursive: true, mode: 0o700 })
  await writeFile(objectPath, BYTES, { mode: 0o600 })
  return { resourceId: claim.resourceId! }
}
