import { afterEach, describe, expect, it } from 'vitest'
import { rm } from 'node:fs/promises'
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

describe('source registration across a real Gateway restart', () => {
  it('replays one registration and retains scoped safe reads', async () => {
    const gateway = await createTestGateway({ disableAuth: false })
    cleanupDir = gateway.tmpDir
    const workspaceId = gateway.state.createWorkspace(gateway.tmpDir, 'Restart source').id
    const issued = await gateway.client.post('/api/v1/auth/delegations', {
      delegateId: 'restart-source-client',
      workspaceId,
      profileId: 'mini',
      purpose: 'customer-support',
      operations: ['sources.register', 'sources.list', 'sources.read'],
    })
    const delegatedToken = (issued.body as { token: string }).token
    const key = '47474747-abab-4474-8474-474747474747'
    const body = {
      kind: 'file',
      label: 'Restart-safe source',
      classification: 'internal',
      authority: 'supporting_reference',
      audiencePolicyRef: 'audience.support-team',
      sensitivityPolicyRef: 'sensitivity.internal',
      purposePolicyRef: 'purpose.customer-support',
      retentionPolicyRef: 'retention.standard',
      freshnessPolicyRef: 'freshness.monthly',
    }
    const register = (baseUrl: string) => fetch(`${baseUrl}/api/v1/sources`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${delegatedToken}`,
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      body: JSON.stringify(body),
    })
    const firstResponse = await register(gateway.baseUrl)
    expect(firstResponse.status).toBe(202)
    const first = await firstResponse.json() as { sourceId: string }
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
    const replay = await register(baseUrl)
    expect(replay.status).toBe(202)
    expect(replay.headers.get('idempotency-replayed')).toBe('true')
    await expect(replay.json()).resolves.toMatchObject({ sourceId: first.sourceId })

    const detail = await fetch(`${baseUrl}/api/v1/sources/${first.sourceId}`, {
      headers: { authorization: `Bearer ${delegatedToken}` },
    })
    expect(detail.status).toBe(200)
    await expect(detail.json()).resolves.toMatchObject({
      sourceId: first.sourceId,
      currentVersionId: null,
      health: { registration: 'pending', freshness: 'unknown' },
    })
    const listed = await fetch(`${baseUrl}/api/v1/sources`, {
      headers: { authorization: `Bearer ${delegatedToken}` },
    })
    await expect(listed.json()).resolves.toMatchObject({
      items: [{ sourceId: first.sourceId }],
      nextCursor: null,
    })
  }, 20_000)
})
