import { createHash } from 'node:crypto'
import { rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OwnwareGateway } from '../../../src/gateway/server.js'
import { createTestGateway } from '../../framework/harness/gateway.js'

const CSV = Buffer.from(
  'name,plan\nAda,source-lifecycle-private-cell\nBob,standard\n',
)

let cleanupDir: string | undefined
let restarted: OwnwareGateway | undefined

afterEach(async () => {
  await restarted?.stop()
  restarted = undefined
  if (cleanupDir) await rm(cleanupDir, { recursive: true, force: true })
  cleanupDir = undefined
})

describe('storage source lifecycle through the real gateway', () => {
  it('uploads, prepares, queries, restarts, revokes and verifiably deletes', async () => {
    const gateway = await createTestGateway({ disableAuth: false })
    cleanupDir = gateway.tmpDir
    const workspaceId = (await gateway.state.createWorkspace(
      gateway.tmpDir,
      'Storage source lifecycle',
    )).id
    const lifecycleToken = await issue(gateway.baseUrl, gateway.token, {
      delegateId: 'storage-source-lifecycle',
      subjectId: 'person.storage-source-lifecycle',
      workspaceId,
      operations: [
        'sources.register',
        'sources.read',
        'source_uploads.create',
        'source_uploads.write',
        'source_uploads.complete',
        'source_versions.read',
        'source_jobs.create',
        'source_jobs.read',
        'source_preparations.create',
        'source_data_views.read',
        'source_deletions.create',
        'source_deletions.read',
      ],
    })

    const registered = await fetch(`${gateway.baseUrl}/api/v1/sources`, {
      method: 'POST',
      headers: delegatedHeaders(
        lifecycleToken,
        '11111111-0000-4000-8000-000000000001',
      ),
      body: JSON.stringify({
        kind: 'structured_export',
        label: 'Storage lifecycle CSV',
        classification: 'internal',
        authority: 'supporting_reference',
        audiencePolicyRef: 'audience.storage-lifecycle',
        sensitivityPolicyRef: 'sensitivity.storage-lifecycle',
        purposePolicyRef: 'purpose.customer-support',
        retentionPolicyRef: 'retention.storage-lifecycle',
        freshnessPolicyRef: 'freshness.storage-lifecycle',
      }),
    })
    expect(registered.status).toBe(202)
    const sourceId = ((await registered.json()) as { sourceId: string }).sourceId
    const checksum = `sha256:${createHash('sha256').update(CSV).digest('hex')}`

    const uploadCreated = await fetch(
      `${gateway.baseUrl}/api/v1/sources/${sourceId}/upload-sessions`,
      {
        method: 'POST',
        headers: delegatedHeaders(
          lifecycleToken,
          '22222222-0000-4000-8000-000000000002',
        ),
        body: JSON.stringify({
          expectedBytes: CSV.length,
          expectedChecksum: checksum,
          declaredMediaType: 'text/plain',
          filename: 'lifecycle.csv',
        }),
      },
    )
    expect(uploadCreated.status).toBe(201)
    const uploadId = ((await uploadCreated.json()) as { uploadId: string }).uploadId
    const write = await fetch(`${gateway.baseUrl}/api/v1/source-uploads/${uploadId}`, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${lifecycleToken}`,
        'content-type': 'application/offset+octet-stream',
        'upload-offset': '0',
        'upload-chunk-checksum': checksum,
      },
      body: CSV,
    })
    expect(write.status).toBe(200)
    await expect(write.json()).resolves.toMatchObject({
      offset: CSV.length,
      chunkCount: 1,
      replayed: false,
    })

    const completed = await fetch(
      `${gateway.baseUrl}/api/v1/source-uploads/${uploadId}/complete`,
      { method: 'POST', headers: { authorization: `Bearer ${lifecycleToken}` } },
    )
    expect(completed.status).toBe(201)
    const versionId = ((await completed.json()) as { sourceVersionId: string }).sourceVersionId

    const inspection = await fetch(
      `${gateway.baseUrl}/api/v1/sources/${sourceId}/versions/${versionId}/jobs`,
      {
        method: 'POST',
        headers: delegatedHeaders(
          lifecycleToken,
          '33333333-0000-4000-8000-000000000003',
        ),
        body: JSON.stringify({ operation: 'inspect_format' }),
      },
    )
    expect(inspection.status).toBe(202)
    const inspectionId = ((await inspection.json()) as { jobId: string }).jobId
    await expect(waitForJob(gateway.baseUrl, lifecycleToken, inspectionId))
      .resolves.toMatchObject({ state: 'succeeded', outcomeCode: 'inspection_complete' })

    const preparation = await fetch(
      `${gateway.baseUrl}/api/v1/sources/${sourceId}/versions/${versionId}/preparations`,
      {
        method: 'POST',
        headers: delegatedHeaders(
          lifecycleToken,
          '44444444-0000-4000-8000-000000000004',
        ),
        body: JSON.stringify({ operation: 'prepare_data_view' }),
      },
    )
    expect(preparation.status).toBe(202)
    const preparationId = ((await preparation.json()) as { jobId: string }).jobId
    const prepared = await waitForJob(
      gateway.baseUrl,
      lifecycleToken,
      preparationId,
    ) as { state: string; dataViewId: string }
    expect(prepared.state).toBe('succeeded')
    const dataViewId = prepared.dataViewId

    const viewResponse = await fetch(
      `${gateway.baseUrl}/api/v1/source-data-views/${dataViewId}`,
      { headers: { authorization: `Bearer ${lifecycleToken}` } },
    )
    expect(viewResponse.status).toBe(200)
    const view = await viewResponse.json() as {
      fields: ReadonlyArray<{ fieldId: string; label: string }>
    }
    const nameFieldId = view.fields.find(field => field.label === 'name')?.fieldId
    expect(nameFieldId).toMatch(/^field\./)

    const grantCreated = await fetch(
      `${gateway.baseUrl}/api/v1/source-data-views/${dataViewId}/access-grants`,
      {
        method: 'POST',
        headers: ownerHeaders(
          gateway.token,
          '55555555-0000-4000-8000-000000000005',
        ),
        body: JSON.stringify({
          subjectId: 'person.storage-source-lifecycle',
          purpose: 'customer_support',
          channel: 'web.primary',
          consent: { state: 'not_required' },
          ttlSeconds: 600,
          fieldIds: [nameFieldId],
          rowOffset: 0,
          rowCount: 1,
        }),
      },
    )
    expect(grantCreated.status).toBe(201)
    const grantId = ((await grantCreated.json()) as { grantId: string }).grantId
    const queryToken = await issue(gateway.baseUrl, gateway.token, {
      delegateId: 'storage-source-query',
      subjectId: 'person.storage-source-lifecycle',
      workspaceId,
      operations: ['source_data_views.query'],
    })
    const query = (baseUrl: string) => fetch(
      `${baseUrl}/api/v1/source-data-views/${dataViewId}/query`,
      {
        method: 'POST',
        headers: delegatedHeaders(queryToken),
        body: JSON.stringify({
          consent: { state: 'not_required' },
          fieldIds: [nameFieldId],
          rowOffset: 0,
          rowCount: 1,
        }),
      },
    )
    const beforeRestart = await query(gateway.baseUrl)
    expect(beforeRestart.status).toBe(200)
    const beforeBody = await beforeRestart.text()
    expect(beforeBody).toContain('Ada')
    expect(beforeBody).not.toContain('source-lifecycle-private-cell')

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
    const restartedBaseUrl = `http://127.0.0.1:${restarted.port}`
    const afterRestart = await query(restartedBaseUrl)
    expect(afterRestart.status).toBe(200)
    expect(await afterRestart.text()).toContain('Ada')

    const revoked = await fetch(
      `${restartedBaseUrl}/api/v1/access-grants/${grantId}/revoke`,
      {
        method: 'POST',
        headers: ownerHeaders(
          restarted.token,
          '66666666-0000-4000-8000-000000000006',
        ),
        body: JSON.stringify({ expectedRevision: 1 }),
      },
    )
    expect(revoked.status).toBe(200)
    const denied = await query(restartedBaseUrl)
    expect(denied.status).toBe(404)
    expect(await denied.text()).not.toContain('Ada')

    const deletion = await fetch(
      `${restartedBaseUrl}/api/v1/sources/${sourceId}/deletions`,
      {
        method: 'POST',
        headers: delegatedHeaders(
          lifecycleToken,
          '77777777-0000-4000-8000-000000000007',
        ),
        body: JSON.stringify({ expectedRevision: 2 }),
      },
    )
    expect(deletion.status).toBe(202)
    const deletionJobId = ((await deletion.json()) as { jobId: string }).jobId
    const deleted = await waitForDeletion(
      restartedBaseUrl,
      lifecycleToken,
      deletionJobId,
    )
    expect(deleted).toMatchObject({ state: 'deleted' })

    const sourceAfterDelete = await fetch(
      `${restartedBaseUrl}/api/v1/sources/${sourceId}`,
      { headers: { authorization: `Bearer ${lifecycleToken}` } },
    )
    expect(sourceAfterDelete.status).toBe(404)
    const originalPath = join(
      cleanupDir,
      'data',
      'source-storage',
      'sources',
      sourceId,
      'versions',
      versionId,
      'original',
    )
    await expect(stat(originalPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(restarted.state.rawDbHandle.prepare(
      'SELECT COUNT(*) AS count FROM runtime_sources WHERE source_id = ?',
    ).get(sourceId)).toEqual({ count: 0 })
    expect(restarted.state.rawDbHandle.prepare(
      'SELECT COUNT(*) AS count FROM source_deletion_tombstones WHERE source_id = ?',
    ).get(sourceId)).toEqual({ count: 1 })
  }, 30_000)
})

async function issue(
  baseUrl: string,
  ownerToken: string,
  input: {
    readonly delegateId: string
    readonly subjectId: string
    readonly workspaceId: string
    readonly operations: readonly string[]
  },
): Promise<string> {
  const response = await fetch(`${baseUrl}/api/v1/auth/delegations`, {
    method: 'POST',
    headers: ownerHeaders(ownerToken),
    body: JSON.stringify({
      ...input,
      profileId: 'mini',
      purpose: 'customer_support',
      channel: 'web.primary',
    }),
  })
  expect(response.status).toBe(201)
  return ((await response.json()) as { token: string }).token
}

function ownerHeaders(token: string, idempotencyKey?: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
  }
}

function delegatedHeaders(token: string, idempotencyKey?: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
  }
}

async function waitForJob(
  baseUrl: string,
  token: string,
  jobId: string,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/v1/source-jobs/${jobId}`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.status).toBe(200)
    const job = await response.json() as Record<string, unknown>
    if (['succeeded', 'partial', 'failed', 'cancelled'].includes(String(job['state']))) {
      return job
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Source job did not become terminal')
}

async function waitForDeletion(
  baseUrl: string,
  token: string,
  jobId: string,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/v1/source-deletions/${jobId}`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(response.status).toBe(200)
    const deletion = await response.json() as Record<string, unknown>
    if (['deleted', 'partially_deleted', 'cancelled'].includes(String(deletion['state']))) {
      return deletion
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Source deletion did not become terminal')
}
