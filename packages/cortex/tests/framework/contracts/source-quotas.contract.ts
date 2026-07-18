import { afterEach, describe, expect, it } from 'vitest'
import { createTestGateway, type TestGateway } from '../harness/index.js'
import type { SourceQuotaLimits } from '../../../src/gateway/source-quota-policy.js'

const LIMITS: SourceQuotaLimits = {
  workspace: {
    maxSourceRegistrations: 2,
    maxRetainedAndReservedBytes: 8,
    maxActiveUploadSessions: 2,
    maxNonterminalJobs: 2,
    maxDerivedResources: 2,
  },
  profile: {
    maxSourceRegistrations: 1,
    maxRetainedAndReservedBytes: 4,
    maxActiveUploadSessions: 2,
    maxNonterminalJobs: 1,
    maxDerivedResources: 1,
  },
}

let gateway: TestGateway | undefined

afterEach(async () => {
  await gateway?.stop()
  gateway = undefined
})

describe('Contract: transactional source quotas', () => {
  it('rejects registration growth safely without poisoning the retry key', async () => {
    gateway = await createTestGateway({ disableAuth: false, sourceQuotaLimits: LIMITS })
    const workspaceId = gateway.state.createWorkspace(gateway.tmpDir, 'Source quota').id
    const token = await issue(workspaceId, ['sources.register', 'sources.read'])
    const register = (key: string, label: string) => fetch(`${gateway!.baseUrl}/api/v1/sources`, {
      method: 'POST',
      headers: auth(token, key),
      body: JSON.stringify(sourceInput(label)),
    })
    const attempts = [
      { key: '30303030-abab-4030-8030-303030303030', label: 'First source' },
      { key: '31313131-abab-4131-8131-313131313131', label: 'Second source' },
    ]
    const responses = await Promise.all(
      attempts.map((attempt) => register(attempt.key, attempt.label)),
    )
    expect(responses.map((response) => response.status).sort()).toEqual([202, 409])
    const acceptedIndex = responses.findIndex((response) => response.status === 202)
    const deniedIndex = acceptedIndex === 0 ? 1 : 0
    const accepted = await responses[acceptedIndex]!.json() as { sourceId: string }
    const deniedBody = await responses[deniedIndex]!.json()
    expect(deniedBody).toEqual(expect.objectContaining({
      error: 'source_quota_exceeded',
      message: 'Source quota does not allow this operation.',
      category: 'invalid_request',
      resourceClass: 'source_registrations',
      correlationId: expect.any(String),
    }))
    await expect((await fetch(`${gateway.baseUrl}/api/v1/sources/${accepted.sourceId}`, {
      headers: { authorization: `Bearer ${token}` },
    })).json()).resolves.toMatchObject({ sourceId: accepted.sourceId })

    const deniedKey = attempts[deniedIndex]!.key
    const denied = await register(deniedKey, attempts[deniedIndex]!.label)
    expect(denied.status).toBe(409)
    await expect(denied.json()).resolves.toMatchObject({
      error: 'source_quota_exceeded', resourceClass: 'source_registrations',
    })
    expect(gateway.state.rawDbHandle.prepare(`
      SELECT COUNT(*) AS count FROM run_idempotency WHERE idempotency_key = ?
    `).get(deniedKey)).toEqual({ count: 0 })
  })

  it('counts active upload bytes as reservations before any chunk is written', async () => {
    gateway = await createTestGateway({ disableAuth: false, sourceQuotaLimits: LIMITS })
    const workspaceId = gateway.state.createWorkspace(gateway.tmpDir, 'Upload quota').id
    const token = await issue(workspaceId, ['sources.register', 'source_uploads.create'])
    const registered = await fetch(`${gateway.baseUrl}/api/v1/sources`, {
      method: 'POST',
      headers: auth(token, '32323232-abab-4232-8232-323232323232'),
      body: JSON.stringify(sourceInput('Upload source')),
    })
    const sourceId = (await registered.json() as { sourceId: string }).sourceId
    const createUpload = (key: string, expectedBytes: number) => fetch(
      `${gateway!.baseUrl}/api/v1/sources/${sourceId}/upload-sessions`,
      {
        method: 'POST',
        headers: auth(token, key),
        body: JSON.stringify({
          expectedBytes,
          expectedChecksum: `sha256:${'a'.repeat(64)}`,
          declaredMediaType: 'text/plain',
          filename: 'synthetic.txt',
        }),
      },
    )
    expect((await createUpload('33333333-abab-4333-8333-333333333333', 4)).status).toBe(201)
    const denied = await createUpload('34343434-abab-4434-8434-343434343434', 1)
    expect(denied.status).toBe(409)
    await expect(denied.json()).resolves.toMatchObject({
      error: 'source_quota_exceeded', resourceClass: 'source_storage_bytes',
    })
    expect(gateway.state.rawDbHandle.prepare(`
      SELECT COUNT(*) AS count FROM source_upload_sessions WHERE source_id = ?
    `).get(sourceId)).toEqual({ count: 1 })
  })
})

async function issue(workspaceId: string, operations: readonly string[]): Promise<string> {
  const issued = await gateway!.client.post('/api/v1/auth/delegations', {
    delegateId: 'source-quota-client', workspaceId, profileId: 'mini',
    purpose: 'source-quota-contract', operations,
  })
  return (issued.body as { token: string }).token
}

function auth(token: string, idempotencyKey: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    'idempotency-key': idempotencyKey,
  }
}

function sourceInput(label: string): Record<string, string> {
  return {
    kind: 'file', label, classification: 'internal', authority: 'supporting_reference',
    audiencePolicyRef: 'audience.test', sensitivityPolicyRef: 'sensitivity.test',
    purposePolicyRef: 'purpose.test', retentionPolicyRef: 'retention.test',
    freshnessPolicyRef: 'freshness.test',
  }
}
