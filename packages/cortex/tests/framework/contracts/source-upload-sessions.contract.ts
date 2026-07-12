import { createHash } from 'node:crypto'
import { truncate } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createTestGateway, type TestGateway } from '../harness/index.js'

const UploadSessionSchema = z.object({
  uploadId: z.string().uuid(),
  sourceId: z.string().uuid(),
  state: z.literal('open'),
  offset: z.literal(0),
  expectedBytes: z.number().int().positive(),
  expectedChecksum: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  declaredMediaType: z.enum(['text/plain', 'application/pdf']),
  maxChunkBytes: z.literal(1024 * 1024),
  maxChunks: z.literal(64),
  expiresAt: z.number().int().positive(),
  createdAt: z.number().int().positive(),
}).strict()

describe('Contract: source upload sessions', () => {
  let gw: TestGateway
  let token: string
  let sourceId: string

  beforeAll(async () => {
    gw = await createTestGateway({ disableAuth: false })
    const workspaceId = gw.state.createWorkspace(gw.tmpDir, 'Upload session contract').id
    const issued = await gw.client.post('/api/v1/auth/delegations', {
      delegateId: 'source-upload-client',
      workspaceId,
      profileId: 'mini',
      purpose: 'customer-support',
      operations: [
        'sources.register', 'sources.read',
        'source_uploads.create', 'source_uploads.write', 'source_uploads.complete',
        'source_versions.read',
      ],
    })
    token = (issued.body as { token: string }).token
    const registered = await fetch(`${gw.baseUrl}/api/v1/sources`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': '61616161-abab-4616-8616-616161616161',
      },
      body: JSON.stringify({
        kind: 'file',
        label: 'Upload target',
        classification: 'internal',
        authority: 'supporting_reference',
        audiencePolicyRef: 'audience.support-team',
        sensitivityPolicyRef: 'sensitivity.internal',
        purposePolicyRef: 'purpose.customer-support',
        retentionPolicyRef: 'retention.standard',
        freshnessPolicyRef: 'freshness.monthly',
      }),
    })
    sourceId = (await registered.json() as { sourceId: string }).sourceId
  })

  afterAll(async () => {
    await gw.stop()
  })

  it('creates a bounded source-bound session without exposing private placement', async () => {
    const bytes = Buffer.from('approved text')
    const expectedChecksum = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    const response = await fetch(`${gw.baseUrl}/api/v1/sources/${sourceId}/upload-sessions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': '62626262-abab-4626-8626-626262626262',
      },
      body: JSON.stringify({
        expectedBytes: bytes.length,
        expectedChecksum,
        declaredMediaType: 'text/plain',
        filename: 'guide.txt',
      }),
    })
    const raw = await response.text()

    expect(response.status).toBe(201)
    expect(UploadSessionSchema.parse(JSON.parse(raw))).toMatchObject({
      sourceId,
      expectedBytes: bytes.length,
      expectedChecksum,
      declaredMediaType: 'text/plain',
    })
    expect(raw).not.toContain(gw.tmpDir)
    expect(raw).not.toContain('guide.txt')
    expect(raw).not.toContain('storage')
    expect(raw).not.toContain('token')
  })

  it('replays one declaration, conflicts on change, and keeps separate sessions separate', async () => {
    const bytes = Buffer.from('replay text')
    const body = {
      expectedBytes: bytes.length,
      expectedChecksum: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      declaredMediaType: 'text/plain',
      filename: 'replay.txt',
    }
    const create = (key: string, input: object = body) => fetch(
      `${gw.baseUrl}/api/v1/sources/${sourceId}/upload-sessions`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'idempotency-key': key,
        },
        body: JSON.stringify(input),
      },
    )
    const firstResponse = await create('63636363-abab-4636-8636-636363636363')
    const first = UploadSessionSchema.parse(await firstResponse.json())
    const replay = await create('63636363-abab-4636-8636-636363636363')
    expect(replay.status).toBe(201)
    expect(replay.headers.get('idempotency-replayed')).toBe('true')
    expect(UploadSessionSchema.parse(await replay.json()).uploadId).toBe(first.uploadId)

    const conflict = await create(
      '63636363-abab-4636-8636-636363636363',
      { ...body, expectedBytes: body.expectedBytes + 1 },
    )
    expect(conflict.status).toBe(409)
    await expect(conflict.json()).resolves.toMatchObject({ error: 'idempotency_conflict' })

    const separate = UploadSessionSchema.parse(
      await (await create('64646464-abab-4646-8646-646464646464')).json(),
    )
    expect(separate.uploadId).not.toBe(first.uploadId)
  })

  it('rejects unsafe declarations without reflecting private input', async () => {
    const checksum = `sha256:${'a'.repeat(64)}`
    const base = {
      expectedBytes: 12,
      expectedChecksum: checksum,
      declaredMediaType: 'text/plain',
      filename: 'guide.txt',
    }
    const invalid = [
      { ...base, expectedBytes: 0 },
      { ...base, expectedBytes: 16 * 1024 * 1024 + 1 },
      { ...base, expectedChecksum: `sha256:${'A'.repeat(64)}` },
      { ...base, declaredMediaType: 'application/octet-stream' },
      { ...base, filename: '../private.txt' },
      { ...base, filename: 'unsafe\nname.txt' },
      { ...base, path: '/private/source.txt' },
      { ...base, url: 'https://example.invalid/private' },
      { ...base, bytes: 'private-byte-canary' },
      { ...base, workspaceId: 'browser-authority' },
    ]
    for (const [index, input] of invalid.entries()) {
      const response = await fetch(`${gw.baseUrl}/api/v1/sources/${sourceId}/upload-sessions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'idempotency-key': `65656565-abab-4656-8656-6565656565${String(index).padStart(2, '0')}`,
        },
        body: JSON.stringify(input),
      })
      const raw = await response.text()
      expect(response.status, `input ${index}`).toBe(400)
      expect(JSON.parse(raw)).toMatchObject({ error: 'source_upload_session_invalid' })
      expect(raw).not.toContain('/private/source.txt')
      expect(raw).not.toContain('private-byte-canary')
    }
  })

  it('requires a scoped compatible source and discloses no cross-scope label', async () => {
    const otherWorkspace = gw.state.createWorkspace(`${gw.tmpDir}/other-upload`, 'Other upload').id
    const issued = await gw.client.post('/api/v1/auth/delegations', {
      delegateId: 'other-source-upload-client',
      workspaceId: otherWorkspace,
      profileId: 'mini',
      purpose: 'customer-support',
      operations: ['source_uploads.create'],
    })
    const otherToken = (issued.body as { token: string }).token
    const body = {
      expectedBytes: 12,
      expectedChecksum: `sha256:${'a'.repeat(64)}`,
      declaredMediaType: 'text/plain',
      filename: 'private-source-label.txt',
    }
    const denied = await fetch(`${gw.baseUrl}/api/v1/sources/${sourceId}/upload-sessions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${otherToken}`,
        'content-type': 'application/json',
        'idempotency-key': '66666666-abab-4666-8666-666666666666',
      },
      body: JSON.stringify(body),
    })
    const raw = await denied.text()
    expect(denied.status).toBe(404)
    expect(JSON.parse(raw)).toMatchObject({ error: 'source_not_found' })
    expect(raw).not.toContain('private-source-label.txt')

    const owner = await fetch(`${gw.baseUrl}/api/v1/sources/${sourceId}/upload-sessions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${gw.token}`,
        'content-type': 'application/json',
        'idempotency-key': '67676767-abab-4676-8676-676767676767',
      },
      body: JSON.stringify(body),
    })
    expect(owner.status).toBe(403)
    await expect(owner.json()).resolves.toMatchObject({
      error: 'source_scoped_principal_required',
    })
  })

  it('advances one exact chunk and replays identical bytes without appending twice', async () => {
    const bytes = Buffer.from('one exact chunk')
    const checksum = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    const created = await fetch(`${gw.baseUrl}/api/v1/sources/${sourceId}/upload-sessions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': '68686868-abab-4686-8686-686868686868',
      },
      body: JSON.stringify({
        expectedBytes: bytes.length,
        expectedChecksum: checksum,
        declaredMediaType: 'text/plain',
        filename: 'chunk.txt',
      }),
    })
    const session = UploadSessionSchema.parse(await created.json())
    const write = () => fetch(`${gw.baseUrl}/api/v1/source-uploads/${session.uploadId}`, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/offset+octet-stream',
        'upload-offset': '0',
        'upload-chunk-checksum': checksum,
      },
      body: bytes,
    })

    const accepted = await write()
    expect(accepted.status).toBe(200)
    await expect(accepted.json()).resolves.toEqual({
      uploadId: session.uploadId,
      state: 'open',
      offset: bytes.length,
      chunkCount: 1,
      replayed: false,
    })
    const replay = await write()
    expect(replay.status).toBe(200)
    await expect(replay.json()).resolves.toEqual({
      uploadId: session.uploadId,
      state: 'open',
      offset: bytes.length,
      chunkCount: 1,
      replayed: true,
    })
  })

  it('fails closed for expiry, oversized/checksum-invalid chunks, races, and checkpoint failure', async () => {
    const createSession = async (key: string, bytes: Buffer) => UploadSessionSchema.parse(
      await (await fetch(`${gw.baseUrl}/api/v1/sources/${sourceId}/upload-sessions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'idempotency-key': key,
        },
        body: JSON.stringify({
          expectedBytes: bytes.length,
          expectedChecksum: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
          declaredMediaType: 'text/plain',
          filename: 'bounded.txt',
        }),
      })).json(),
    )
    const write = (
      uploadId: string,
      offset: number,
      bytes: Buffer,
      checksum = `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    ) => fetch(`${gw.baseUrl}/api/v1/source-uploads/${uploadId}`, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/offset+octet-stream',
        'upload-offset': String(offset),
        'upload-chunk-checksum': checksum,
      },
      body: bytes,
    })

    const expired = await createSession(
      '75757575-abab-4757-8757-757575757575', Buffer.from('expired'),
    )
    gw.state.rawDbHandle.prepare(`
      UPDATE source_upload_sessions SET expires_at = created_at + 1
      WHERE upload_id = ?
    `).run(expired.uploadId)
    await new Promise((resolve) => setTimeout(resolve, 5))
    const expiredWrite = await write(expired.uploadId, 0, Buffer.from('expired'))
    expect(expiredWrite.status).toBe(409)
    await expect(expiredWrite.json()).resolves.toMatchObject({ error: 'source_upload_expired' })

    const tooLargeBytes = Buffer.alloc(1024 * 1024 + 1, 0x61)
    const tooLarge = await createSession(
      '76767676-abab-4767-8767-767676767676', tooLargeBytes,
    )
    const oversized = await write(tooLarge.uploadId, 0, tooLargeBytes)
    expect(oversized.status).toBe(413)
    await expect(oversized.json()).resolves.toMatchObject({
      error: 'source_upload_chunk_too_large', limitBytes: 1024 * 1024,
    })

    const checksumBytes = Buffer.from('checksum')
    const checksumSession = await createSession(
      '77777777-abab-4777-8777-777777777777', checksumBytes,
    )
    const wrongChecksum = await write(
      checksumSession.uploadId, 0, checksumBytes, `sha256:${'0'.repeat(64)}`,
    )
    expect(wrongChecksum.status).toBe(400)
    await expect(wrongChecksum.json()).resolves.toMatchObject({
      error: 'source_upload_chunk_invalid',
    })

    const raceSession = await createSession(
      '78787878-abab-4787-8787-787878787878', Buffer.from('aabb'),
    )
    const raced = await Promise.all([
      write(raceSession.uploadId, 0, Buffer.from('aa')),
      write(raceSession.uploadId, 0, Buffer.from('bb')),
    ])
    expect(raced.map((response) => response.status).sort()).toEqual([200, 409])

    const inconsistentSession = await createSession(
      '79797979-abab-4797-8797-797979797979', Buffer.from('abcdef'),
    )
    expect((await write(inconsistentSession.uploadId, 0, Buffer.from('abc'))).status).toBe(200)
    await truncate(join(
      gw.tmpDir, 'data', 'source-storage', 'staging', `${inconsistentSession.uploadId}.part`,
    ), 1)
    const inconsistent = await write(inconsistentSession.uploadId, 3, Buffer.from('def'))
    expect(inconsistent.status).toBe(409)
    await expect(inconsistent.json()).resolves.toMatchObject({
      error: 'source_upload_storage_inconsistent',
    })

    const checkpointBytes = Buffer.from('checkpoint')
    const checkpointSession = await createSession(
      '80808080-abab-4808-8808-808080808080', checkpointBytes,
    )
    gw.state.rawDbHandle.exec(`
      CREATE TRIGGER injected_source_upload_checkpoint_failure
      BEFORE UPDATE OF durable_offset ON source_upload_sessions
      WHEN OLD.upload_id = '${checkpointSession.uploadId}'
      BEGIN SELECT RAISE(ABORT, 'injected checkpoint failure'); END
    `)
    try {
      const failed = await write(checkpointSession.uploadId, 0, checkpointBytes)
      expect(failed.status).toBe(500)
      const raw = await failed.text()
      expect(raw).not.toContain('injected checkpoint failure')
    } finally {
      gw.state.rawDbHandle.exec('DROP TRIGGER injected_source_upload_checkpoint_failure')
    }
    const recovered = await write(checkpointSession.uploadId, 0, checkpointBytes)
    expect(recovered.status).toBe(200)
    await expect(recovered.json()).resolves.toMatchObject({
      offset: checkpointBytes.length, chunkCount: 1, replayed: false,
    })
  }, 20_000)

  it('completes exact chunks into one immutable version and replays completion', async () => {
    const allBytes = Buffer.from('approved immutable text')
    const wholeChecksum = `sha256:${createHash('sha256').update(allBytes).digest('hex')}`
    const created = await fetch(`${gw.baseUrl}/api/v1/sources/${sourceId}/upload-sessions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': '69696969-abab-4696-8696-696969696969',
      },
      body: JSON.stringify({
        expectedBytes: allBytes.length,
        expectedChecksum: wholeChecksum,
        declaredMediaType: 'text/plain',
        filename: 'immutable.txt',
      }),
    })
    const session = UploadSessionSchema.parse(await created.json())
    let offset = 0
    for (const chunk of [allBytes.subarray(0, 9), allBytes.subarray(9)]) {
      const chunkChecksum = `sha256:${createHash('sha256').update(chunk).digest('hex')}`
      const response = await fetch(`${gw.baseUrl}/api/v1/source-uploads/${session.uploadId}`, {
        method: 'PATCH',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/offset+octet-stream',
          'upload-offset': String(offset),
          'upload-chunk-checksum': chunkChecksum,
        },
        body: chunk,
      })
      expect(response.status).toBe(200)
      offset += chunk.length
    }

    const complete = () => fetch(
      `${gw.baseUrl}/api/v1/source-uploads/${session.uploadId}/complete`,
      { method: 'POST', headers: { authorization: `Bearer ${token}` } },
    )
    const first = await complete()
    const raw = await first.text()
    expect(first.status).toBe(201)
    const version = z.object({
      sourceVersionId: z.string().uuid(),
      sourceId: z.literal(sourceId),
      checksum: z.literal(wholeChecksum),
      verifiedMediaType: z.literal('text/plain'),
      byteCount: z.literal(allBytes.length),
      inspection: z.literal('not_started'),
      createdAt: z.number().int().positive(),
      replayed: z.literal(false),
    }).strict().parse(JSON.parse(raw))
    expect(raw).not.toContain(gw.tmpDir)
    expect(raw).not.toContain('immutable.txt')
    expect(raw).not.toContain('objectKey')

    const replay = await complete()
    expect(replay.status).toBe(200)
    await expect(replay.json()).resolves.toMatchObject({
      sourceVersionId: version.sourceVersionId,
      sourceId,
      replayed: true,
    })
    const manifest = await fetch(`${gw.baseUrl}/api/v1/sources/${sourceId}`, {
      headers: { authorization: `Bearer ${token}` },
    })
    await expect(manifest.json()).resolves.toMatchObject({
      sourceId,
      currentVersionId: version.sourceVersionId,
      revision: 2,
      health: { registration: 'registered', freshness: 'fresh' },
    })
    const versionDetail = await fetch(
      `${gw.baseUrl}/api/v1/sources/${sourceId}/versions/${version.sourceVersionId}`,
      { headers: { authorization: `Bearer ${token}` } },
    )
    expect(versionDetail.status).toBe(200)
    await expect(versionDetail.json()).resolves.toEqual({
      sourceVersionId: version.sourceVersionId,
      sourceId,
      checksum: wholeChecksum,
      verifiedMediaType: 'text/plain',
      byteCount: allBytes.length,
      inspection: 'not_started',
      createdAt: version.createdAt,
    })
  })

  it('fails closed for offsets, conflicting retries, incomplete data, and spoofed format', async () => {
    const createSession = async (
      key: string,
      bytes: Buffer,
      declaredMediaType: 'text/plain' | 'application/pdf' = 'text/plain',
      expectedChecksum = `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    ) => UploadSessionSchema.parse(await (await fetch(
      `${gw.baseUrl}/api/v1/sources/${sourceId}/upload-sessions`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'idempotency-key': key,
        },
        body: JSON.stringify({
          expectedBytes: bytes.length,
          expectedChecksum,
          declaredMediaType,
          filename: declaredMediaType === 'application/pdf' ? 'source.pdf' : 'source.txt',
        }),
      },
    )).json())
    const write = (uploadId: string, offset: number, bytes: Buffer) => fetch(
      `${gw.baseUrl}/api/v1/source-uploads/${uploadId}`,
      {
        method: 'PATCH',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/offset+octet-stream',
          'upload-offset': String(offset),
          'upload-chunk-checksum': `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        },
        body: bytes,
      },
    )

    const bytes = Buffer.from('offset proof')
    const session = await createSession('70707070-abab-4707-8707-707070707070', bytes)
    const ahead = await write(session.uploadId, 1, bytes)
    expect(ahead.status).toBe(409)
    await expect(ahead.json()).resolves.toMatchObject({
      error: 'source_upload_offset_conflict', expectedOffset: 0,
    })
    expect((await write(session.uploadId, 0, bytes)).status).toBe(200)
    const changed = Buffer.from('other bytes!')
    const conflict = await write(session.uploadId, 0, changed)
    expect(conflict.status).toBe(409)
    await expect(conflict.json()).resolves.toMatchObject({
      error: 'source_upload_offset_conflict', expectedOffset: bytes.length,
    })

    const incompleteBytes = Buffer.from('incomplete')
    const incomplete = await createSession(
      '71717171-abab-4717-8717-717171717171', incompleteBytes,
    )
    expect((await write(incomplete.uploadId, 0, incompleteBytes.subarray(0, 3))).status).toBe(200)
    const incompleteResult = await fetch(
      `${gw.baseUrl}/api/v1/source-uploads/${incomplete.uploadId}/complete`,
      { method: 'POST', headers: { authorization: `Bearer ${token}` } },
    )
    expect(incompleteResult.status).toBe(409)
    await expect(incompleteResult.json()).resolves.toMatchObject({
      error: 'source_upload_incomplete', expectedOffset: 3,
    })

    const fakePdf = Buffer.from('not a pdf document%%EOF')
    const spoofed = await createSession(
      '72727272-abab-4727-8727-727272727272', fakePdf, 'application/pdf',
    )
    expect((await write(spoofed.uploadId, 0, fakePdf)).status).toBe(200)
    const rejected = await fetch(`${gw.baseUrl}/api/v1/source-uploads/${spoofed.uploadId}/complete`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` },
    })
    expect(rejected.status).toBe(422)
    const raw = await rejected.text()
    expect(JSON.parse(raw)).toMatchObject({ error: 'source_upload_verification_failed' })
    expect(raw).not.toContain('not a pdf')
  })
})
