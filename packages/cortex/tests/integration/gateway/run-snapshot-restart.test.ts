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

describe('durable run snapshot restart recovery', () => {
  it('reports a prior-process running record as indeterminate, never completed', async () => {
    const first = await createTestGateway({ disableAuth: false })
    cleanupDir = first.tmpDir
    const thread = first.state.createThread('mini', 'crash recovery')
    const record = first.gateway.runStore.create({
      threadId: thread.id,
      profileId: 'mini',
      model: 'anthropic:claude-sonnet-4-20250514',
      timeoutMs: 30 * 60 * 1000,
      startSeq: 0,
    }, 1_750_000_000_000)
    first.gateway.runStore.markRunning(record.runId, 1_750_000_000_100)
    const permission = first.gateway.runStore.recordPermissionRequest({
      runId: record.runId,
      requestId: 'permission_before_restart',
      toolName: 'send_email',
      toolInput: { recipient: 'synthetic@example.test' },
    }, 1_750_000_000_200)
    first.gateway.runStore.markWaiting(record.runId, 1_750_000_000_200)
    expect(first.gateway.runStore.requestCancel(record.runId, 1_750_000_000_300)).toBe('requested')
    await first.stop({ cleanup: false })

    restarted = new OwnwareGateway({
      port: 0,
      profilesDir: join(cleanupDir, 'profiles'),
      dataDir: join(cleanupDir, 'data'),
      dbPath: join(cleanupDir, 'test.db'),
      tls: false,
      disableAuth: false,
    })
    await restarted.start()

    const response = await fetch(
      `http://127.0.0.1:${restarted.port}/api/v1/runs/${record.runId}`,
      { headers: { authorization: `Bearer ${restarted.token}` } },
    )
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      runId: record.runId,
      threadId: thread.id,
      status: 'indeterminate',
      terminal: true,
      outcomeKnown: false,
      code: 'gateway_restarted',
      endSeq: null,
    })

    const staleDecision = await fetch(
      `http://127.0.0.1:${restarted.port}/api/v1/runs/${record.runId}/permissions/${permission.requestId}/decision`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${restarted.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          decision: 'approve',
          operationHash: permission.operationHash,
        }),
      },
    )
    expect(staleDecision.status).toBe(409)
    await expect(staleDecision.json()).resolves.toMatchObject({ error: 'permission_request_stale' })
  })
})
