import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { appendFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { OwnwareGateway } from '../../../src/gateway/server.js'
import { createTestGateway } from '../../framework/harness/gateway.js'

let cleanupDir: string | undefined
let restarted: OwnwareGateway | undefined

afterEach(async () => {
  await restarted?.stop()
  restarted = undefined
  if (cleanupDir) await rm(cleanupDir, { recursive: true, force: true })
  cleanupDir = undefined
})

describe('source upload across a real Gateway restart', () => {
  it('resumes at the durable chunk offset and completes one immutable version', async () => {
    const gateway = await createTestGateway({ disableAuth: false })
    cleanupDir = gateway.tmpDir
    const workspaceId = gateway.state.createWorkspace(gateway.tmpDir, 'Restart upload').id
    const issued = await gateway.client.post('/api/v1/auth/delegations', {
      delegateId: 'restart-upload-client',
      workspaceId,
      profileId: 'mini',
      purpose: 'customer-support',
      operations: [
        'sources.register', 'sources.read', 'source_uploads.create',
        'source_uploads.write', 'source_uploads.complete',
      ],
    })
    const token = (issued.body as { token: string }).token
    const allBytes = Buffer.from('restart-safe immutable source')
    const checksum = `sha256:${createHash('sha256').update(allBytes).digest('hex')}`
    const registered = await fetch(`${gateway.baseUrl}/api/v1/sources`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': '73737373-abab-4737-8737-737373737373',
      },
      body: JSON.stringify({
        kind: 'file', label: 'Restart upload', classification: 'internal',
        authority: 'supporting_reference', audiencePolicyRef: 'audience.support',
        sensitivityPolicyRef: 'sensitivity.internal', purposePolicyRef: 'purpose.support',
        retentionPolicyRef: 'retention.standard', freshnessPolicyRef: 'freshness.monthly',
      }),
    })
    const sourceId = (await registered.json() as { sourceId: string }).sourceId
    const created = await fetch(`${gateway.baseUrl}/api/v1/sources/${sourceId}/upload-sessions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': '74747474-abab-4747-8747-747474747474',
      },
      body: JSON.stringify({
        expectedBytes: allBytes.length, expectedChecksum: checksum,
        declaredMediaType: 'text/plain', filename: 'restart.txt',
      }),
    })
    const uploadId = (await created.json() as { uploadId: string }).uploadId
    const write = (baseUrl: string, offset: number, chunk: Buffer) => fetch(
      `${baseUrl}/api/v1/source-uploads/${uploadId}`,
      {
        method: 'PATCH',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/offset+octet-stream',
          'upload-offset': String(offset),
          'upload-chunk-checksum': `sha256:${createHash('sha256').update(chunk).digest('hex')}`,
        },
        body: chunk,
      },
    )
    const first = allBytes.subarray(0, 12)
    expect((await write(gateway.baseUrl, 0, first)).status).toBe(200)
    await gateway.stop({ cleanup: false })

    const stagingPath = join(
      cleanupDir, 'data', 'source-storage', 'staging', `${uploadId}.part`,
    )
    await appendFile(stagingPath, Buffer.from('uncheckpointed-crash-residue'))
    expect((await stat(stagingPath)).size).toBeGreaterThan(first.length)

    restarted = new OwnwareGateway({
      port: 0,
      profilesDir: join(cleanupDir, 'profiles'),
      dataDir: join(cleanupDir, 'data'),
      dbPath: join(cleanupDir, 'test.db'),
      tls: false,
      disableAuth: false,
    })
    await restarted.start()
    expect((await stat(stagingPath)).size).toBe(first.length)
    const baseUrl = `http://127.0.0.1:${restarted.port}`
    const second = allBytes.subarray(first.length)
    const resumed = await write(baseUrl, first.length, second)
    expect(resumed.status).toBe(200)
    await expect(resumed.json()).resolves.toMatchObject({ offset: allBytes.length, chunkCount: 2 })

    const completed = await fetch(`${baseUrl}/api/v1/source-uploads/${uploadId}/complete`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` },
    })
    expect(completed.status).toBe(201)
    const version = await completed.json() as { sourceVersionId: string }
    const manifest = await fetch(`${baseUrl}/api/v1/sources/${sourceId}`, {
      headers: { authorization: `Bearer ${token}` },
    })
    await expect(manifest.json()).resolves.toMatchObject({
      currentVersionId: version.sourceVersionId,
      health: { registration: 'registered', freshness: 'fresh' },
    })
  }, 20_000)

  it('retains the captured refresh fence and actual conflict truth across restart', async () => {
    const gateway = await createTestGateway({ disableAuth: false })
    cleanupDir = gateway.tmpDir
    const workspaceId = gateway.state.createWorkspace(gateway.tmpDir, 'Restart refresh').id
    const issued = await gateway.client.post('/api/v1/auth/delegations', {
      delegateId: 'restart-refresh-client',
      workspaceId,
      profileId: 'mini',
      purpose: 'customer-support',
      operations: [
        'sources.register', 'sources.read', 'source_uploads.create',
        'source_uploads.write', 'source_uploads.complete',
      ],
    })
    const token = (issued.body as { token: string }).token
    const registered = await fetch(`${gateway.baseUrl}/api/v1/sources`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': '75757575-abab-4757-8757-757575757575',
      },
      body: JSON.stringify({
        kind: 'file', label: 'Restart refresh', classification: 'internal',
        authority: 'supporting_reference', audiencePolicyRef: 'audience.support',
        sensitivityPolicyRef: 'sensitivity.internal', purposePolicyRef: 'purpose.support',
        retentionPolicyRef: 'retention.standard', freshnessPolicyRef: 'freshness.monthly',
      }),
    })
    const sourceId = (await registered.json() as { sourceId: string }).sourceId
    const prepare = async (idempotencyKey: string, content: string) => {
      const bytes = Buffer.from(content)
      const checksum = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
      const created = await fetch(
        `${gateway.baseUrl}/api/v1/sources/${sourceId}/upload-sessions`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            'idempotency-key': idempotencyKey,
          },
          body: JSON.stringify({
            expectedBytes: bytes.length, expectedChecksum: checksum,
            declaredMediaType: 'text/plain', filename: 'refresh.txt',
          }),
        },
      )
      const uploadId = (await created.json() as { uploadId: string }).uploadId
      const written = await fetch(`${gateway.baseUrl}/api/v1/source-uploads/${uploadId}`, {
        method: 'PATCH',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/offset+octet-stream',
          'upload-offset': '0',
          'upload-chunk-checksum': checksum,
        },
        body: bytes,
      })
      expect(written.status).toBe(200)
      return uploadId
    }
    const staleUpload = await prepare(
      '76767676-abab-4767-8767-767676767676', 'stale restart candidate',
    )
    const newerUpload = await prepare(
      '77777777-abab-4777-8777-777777777777', 'newer restart candidate',
    )
    const newer = await fetch(
      `${gateway.baseUrl}/api/v1/source-uploads/${newerUpload}/complete`,
      { method: 'POST', headers: { authorization: `Bearer ${token}` } },
    )
    expect(newer.status).toBe(201)
    const newerVersion = await newer.json() as { sourceVersionId: string }
    await gateway.stop({ cleanup: false })

    restarted = new OwnwareGateway({
      port: 0,
      profilesDir: join(cleanupDir, 'profiles'),
      dataDir: join(cleanupDir, 'data'),
      dbPath: join(cleanupDir, 'test.db'),
      tls: false,
      disableAuth: false,
    })
    await restarted.start()
    const baseUrl = `http://127.0.0.1:${restarted.port}`
    const stale = await fetch(`${baseUrl}/api/v1/source-uploads/${staleUpload}/complete`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` },
    })
    expect(stale.status).toBe(409)
    await expect(stale.json()).resolves.toMatchObject({
      error: 'source_upload_refresh_conflict',
      actualRevision: 2,
      actualCurrentVersionId: newerVersion.sourceVersionId,
    })
    const manifest = await fetch(`${baseUrl}/api/v1/sources/${sourceId}`, {
      headers: { authorization: `Bearer ${token}` },
    })
    await expect(manifest.json()).resolves.toMatchObject({
      revision: 2,
      currentVersionId: newerVersion.sourceVersionId,
      health: { inspection: 'not_started', preparation: 'not_requested' },
    })
  }, 20_000)
})
