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

describe('run idempotency across a real Gateway restart', () => {
  it('replays the original thread without appending another run', async () => {
    const firstGateway = await createTestGateway()
    cleanupDir = firstGateway.tmpDir
    const key = '33333333-3333-4333-8333-333333333333'
    const body = { profileId: 'mini', prompt: 'restart-safe logical turn' }
    const firstResponse = await fetch(`${firstGateway.baseUrl}/api/v1/run`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${firstGateway.token}`,
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      body: JSON.stringify(body),
    })
    expect(firstResponse.status).toBe(200)
    const first = await firstResponse.json() as { threadId: string }
    await firstGateway.stop({ cleanup: false })

    restarted = new OwnwareGateway({
      port: 0,
      profilesDir: join(cleanupDir, 'profiles'),
      dataDir: join(cleanupDir, 'data'),
      dbPath: join(cleanupDir, 'test.db'),
      tls: false,
    })
    await restarted.start()
    const replayResponse = await fetch(`http://127.0.0.1:${restarted.port}/api/v1/run`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${restarted.token}`,
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      body: JSON.stringify(body),
    })
    expect(replayResponse.status).toBe(200)
    expect(replayResponse.headers.get('idempotency-replayed')).toBe('true')
    expect(await replayResponse.json()).toMatchObject({ threadId: first.threadId })
    expect(restarted.state.listThreads(undefined, { limit: 10_000 }).items).toHaveLength(1)
  }, 20_000)
})
