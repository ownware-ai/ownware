import { afterEach, describe, expect, it } from 'vitest'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { OwnwareGateway } from '../../../src/gateway/server.js'
import { createTestGateway } from '../../framework/harness/gateway.js'

function file(path: string, content: string): { path: string; contentBase64: string } {
  return { path, contentBase64: Buffer.from(content).toString('base64') }
}

let restarted: OwnwareGateway | undefined
let cleanupDir: string | undefined

afterEach(async () => {
  await restarted?.stop()
  restarted = undefined
  if (cleanupDir) await rm(cleanupDir, { recursive: true, force: true })
  cleanupDir = undefined
})

describe('candidate staging across a real Gateway restart', () => {
  it('re-verifies stored bytes and preserves verified deletion across restart', async () => {
    const gateway = await createTestGateway({ disableAuth: false })
    cleanupDir = gateway.tmpDir
    const files = [file('agent.json', '{"name":"mini"}')]
    const request = async (baseUrl: string, token: string, candidateId?: string) => {
      const route = candidateId ? 'stage' : 'validate'
      const response = await fetch(`${baseUrl}/api/v1/candidates/${route}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(candidateId ? { candidateId, files } : { files }),
      })
      return { status: response.status, body: await response.json() as Record<string, unknown> }
    }
    const validated = await request(gateway.baseUrl, gateway.token)
    const candidateId = validated.body['candidateId'] as string
    await expect(request(gateway.baseUrl, gateway.token, candidateId)).resolves.toMatchObject({
      status: 200,
      body: { state: 'ready', idempotent: false },
    })
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
    await expect(request(baseUrl, restarted.token, candidateId)).resolves.toMatchObject({
      status: 200,
      body: { candidateId, state: 'ready', ready: true, idempotent: true },
    })
    const deleted = await fetch(`${baseUrl}/api/v1/profile-candidates/${encodeURIComponent(candidateId)}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${restarted.token}` },
    })
    expect(deleted.status).toBe(200)
    await expect(deleted.json()).resolves.toMatchObject({ state: 'deleted', deleted: true })
    await restarted.stop({ cleanup: false })

    restarted = new OwnwareGateway({
      port: 0,
      profilesDir: join(cleanupDir, 'profiles'),
      dataDir: join(cleanupDir, 'data'),
      dbPath: join(cleanupDir, 'test.db'),
      tls: false,
      disableAuth: false,
    })
    await restarted.start()
    const persisted = await fetch(
      `http://127.0.0.1:${restarted.port}/api/v1/profile-candidates/${encodeURIComponent(candidateId)}`,
      { headers: { authorization: `Bearer ${restarted.token}` } },
    )
    expect(persisted.status).toBe(200)
    await expect(persisted.json()).resolves.toMatchObject({
      candidateId, state: 'deleted', ready: false, deletionEligible: false,
    })
  })

  it('persists A to B activation and rolls back to A after restart', async () => {
    const gateway = await createTestGateway({ disableAuth: false })
    cleanupDir = gateway.tmpDir
    const prepare = async (description: string): Promise<string> => {
      const files = [file('agent.json', JSON.stringify({ name: 'mini', description }))]
      const validation = await fetch(`${gateway.baseUrl}/api/v1/candidates/validate`, {
        method: 'POST',
        headers: { authorization: `Bearer ${gateway.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ files }),
      })
      const candidateId = (await validation.json() as { candidateId: string }).candidateId
      const stage = await fetch(`${gateway.baseUrl}/api/v1/candidates/stage`, {
        method: 'POST',
        headers: { authorization: `Bearer ${gateway.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ candidateId, files }),
      })
      expect(stage.status).toBe(200)
      return candidateId
    }
    const first = await prepare('candidate-a')
    const second = await prepare('candidate-b')
    const activate = async (candidateId: string, expected: string | null) => fetch(
      `${gateway.baseUrl}/api/v1/candidates/activate`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${gateway.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          profileId: 'mini', candidateId, expectedActiveCandidateId: expected,
        }),
      },
    )
    expect((await activate(first, null)).status).toBe(200)
    expect((await activate(second, first)).status).toBe(200)
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
    const rollback = await fetch(
      `http://127.0.0.1:${restarted.port}/api/v1/candidates/rollback`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${restarted.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          profileId: 'mini',
          candidateId: first,
          expectedActiveCandidateId: second,
        }),
      },
    )
    expect(rollback.status).toBe(200)
    await expect(rollback.json()).resolves.toMatchObject({
      state: 'rolled_back',
      changed: true,
      previousCandidateId: second,
      activeCandidateId: first,
      deploymentRevision: 3,
    })

    const pause = await fetch(
      `http://127.0.0.1:${restarted.port}/api/v1/profiles/mini/pause`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${restarted.token}`,
          'content-type': 'application/json',
          'idempotency-key': '12121212-abab-4212-8212-121212121212',
        },
        body: JSON.stringify({ expectedDeploymentRevision: 3 }),
      },
    )
    expect(pause.status).toBe(200)
    await expect(pause.json()).resolves.toMatchObject({
      routingState: 'paused', deploymentRevision: 4,
    })
    await restarted.stop({ cleanup: false })

    restarted = new OwnwareGateway({
      port: 0,
      profilesDir: join(cleanupDir, 'profiles'),
      dataDir: join(cleanupDir, 'data'),
      dbPath: join(cleanupDir, 'test.db'),
      tls: false,
      disableAuth: false,
    })
    await restarted.start()
    const afterPauseRestart = `http://127.0.0.1:${restarted.port}`
    const blocked = await fetch(`${afterPauseRestart}/api/v1/run`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${restarted.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ profileId: 'mini', prompt: 'blocked after restart' }),
    })
    expect(blocked.status).toBe(409)
    await expect(blocked.json()).resolves.toMatchObject({
      error: 'profile_paused', deploymentRevision: 4,
    })

    const resume = await fetch(`${afterPauseRestart}/api/v1/profiles/mini/resume`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${restarted.token}`,
        'content-type': 'application/json',
        'idempotency-key': '34343434-cdcd-4434-8434-343434343434',
      },
      body: JSON.stringify({ expectedDeploymentRevision: 4 }),
    })
    expect(resume.status).toBe(200)
    await expect(resume.json()).resolves.toMatchObject({
      routingState: 'active', deploymentRevision: 5, health: 'healthy',
    })
  })
})
