import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { registerProvider, unregisterProvider, type ProviderAdapter } from '@ownware/loom'
import { createTestGateway, type TestGateway } from '../harness/gateway.js'

const RunSnapshotSchema = z.object({
  runId: z.string().uuid(),
  threadId: z.string().min(1),
  workspaceId: z.string().nullable(),
  profileId: z.string().min(1),
  candidateId: z.string().regex(/^sha256:[0-9a-f]{64}$/).nullable(),
  model: z.string().min(1),
  timeoutMs: z.number().int().positive(),
  status: z.enum([
    'accepted', 'running', 'waiting', 'cancel_requested',
    'succeeded', 'failed', 'cancelled', 'timed_out', 'indeterminate',
  ]),
  terminal: z.boolean(),
  outcomeKnown: z.boolean(),
  acceptedAt: z.number().int(),
  startedAt: z.number().int().nullable(),
  updatedAt: z.number().int(),
  terminalAt: z.number().int().nullable(),
  cancelRequestedAt: z.number().int().nullable(),
  startSeq: z.number().int().nonnegative(),
  endSeq: z.number().int().nonnegative().nullable(),
  earliestRetainedCursor: z.number().int().nonnegative().nullable(),
  code: z.string().nullable(),
}).strict()

describe('Contract: immutable run snapshots', () => {
  let gateway: TestGateway

  beforeEach(async () => {
    registerProvider({ name: 'snapshottest' } as unknown as ProviderAdapter)
    gateway = await createTestGateway({
      disableAuth: false,
      profiles: [{ name: 'snapshot-test', model: 'snapshottest:model', tools: { preset: 'none' } }],
    })
  })

  afterEach(async () => {
    await gateway.stop()
    unregisterProvider('snapshottest')
  })

  it('returns an immutable run ID with an independently addressable safe snapshot', async () => {
    const started = await fetch(`${gateway.baseUrl}/api/v1/run`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${gateway.token}`,
        'content-type': 'application/json',
        'idempotency-key': '44444444-4444-4444-8444-444444444444',
      },
      body: JSON.stringify({ profileId: 'snapshot-test', prompt: 'first bounded run' }),
    })
    expect(started.status).toBe(200)
    const startBody = z.object({
      runId: z.string().uuid(),
      threadId: z.string().min(1),
    }).passthrough().parse(await started.json())

    const response = await fetch(`${gateway.baseUrl}/api/v1/runs/${startBody.runId}`, {
      headers: { authorization: `Bearer ${gateway.token}` },
    })
    expect(response.status).toBe(200)
    const snapshot = RunSnapshotSchema.parse(await response.json())
    expect(snapshot).toMatchObject({
      runId: startBody.runId,
      threadId: startBody.threadId,
      workspaceId: null,
      profileId: 'snapshot-test',
      candidateId: null,
      timeoutMs: 30 * 60 * 1000,
      startSeq: 0,
      earliestRetainedCursor: 0,
    })
  })

  it('gives two turns on one thread distinct run IDs and event bounds', async () => {
    const start = async (input: Record<string, unknown>, key: string) => {
      const response = await fetch(`${gateway.baseUrl}/api/v1/run`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${gateway.token}`,
          'content-type': 'application/json',
          'idempotency-key': key,
        },
        body: JSON.stringify(input),
      })
      expect(response.status).toBe(200)
      return z.object({ runId: z.string().uuid(), threadId: z.string() })
        .passthrough().parse(await response.json())
    }
    const waitForTerminal = async (runId: string): Promise<z.infer<typeof RunSnapshotSchema>> => {
      const deadline = Date.now() + 8_000
      while (Date.now() < deadline) {
        const response = await fetch(`${gateway.baseUrl}/api/v1/runs/${runId}`, {
          headers: { authorization: `Bearer ${gateway.token}` },
        })
        const snapshot = RunSnapshotSchema.parse(await response.json())
        if (snapshot.terminal) return snapshot
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      throw new Error(`run ${runId} did not become terminal`)
    }

    const first = await start(
      { profileId: 'snapshot-test', prompt: 'turn one' },
      '55555555-5555-4555-8555-555555555555',
    )
    const firstSnapshot = await waitForTerminal(first.runId)
    const second = await start(
      { profileId: 'snapshot-test', prompt: 'turn two', threadId: first.threadId },
      '66666666-6666-4666-8666-666666666666',
    )
    const secondSnapshot = await waitForTerminal(second.runId)

    expect(second.threadId).toBe(first.threadId)
    expect(second.runId).not.toBe(first.runId)
    expect(secondSnapshot.threadId).toBe(firstSnapshot.threadId)
    expect(firstSnapshot.endSeq).not.toBeNull()
    expect(secondSnapshot.startSeq).toBeGreaterThanOrEqual(firstSnapshot.endSeq!)
  })

  it('replays only one terminal run interval and rejects invalid or mismatched cursors', async () => {
    const thread = gateway.state.createThread('mini', 'bounded event replay')
    gateway.state.eventIngestor.ingestParentEvent(thread.id, {
      type: 'text.delta', text: 'old reply', turnIndex: 0,
    } as never)
    gateway.state.eventIngestor.ingestParentEvent(thread.id, {
      type: 'turn.end', stopReason: 'end_turn', turnIndex: 0,
    } as never)
    const first = gateway.gateway.runStore.create({
      threadId: thread.id,
      profileId: 'mini',
      model: 'test:model',
      timeoutMs: 1_000,
      startSeq: 0,
    })
    gateway.gateway.runStore.markTerminal(first.runId, 'succeeded', { endSeq: 2 })

    const second = gateway.gateway.runStore.create({
      threadId: thread.id,
      profileId: 'mini',
      model: 'test:model',
      timeoutMs: 1_000,
      startSeq: 2,
    })
    gateway.state.eventIngestor.ingestParentEvent(thread.id, {
      type: 'user.message', text: 'new turn', attachments: null, timestamp: Date.now(),
    } as never)
    gateway.state.eventIngestor.ingestParentEvent(thread.id, {
      type: 'text.delta', text: 'new reply', turnIndex: 1,
    } as never)
    gateway.state.eventIngestor.ingestParentEvent(thread.id, {
      type: 'turn.end', stopReason: 'end_turn', turnIndex: 1,
    } as never)
    gateway.gateway.runStore.markTerminal(second.runId, 'succeeded', { endSeq: 5 })

    const replay = await fetch(
      `${gateway.baseUrl}/api/v1/runs/${second.runId}/events?since=2`,
      { headers: { authorization: `Bearer ${gateway.token}` } },
    )
    expect(replay.status).toBe(200)
    const body = await replay.text()
    expect(body).toContain('"seq":3')
    expect(body).toContain('"seq":5')
    expect(body).not.toContain('"seq":1')
    expect(body).not.toContain('"seq":2')

    const invalid = await fetch(
      `${gateway.baseUrl}/api/v1/runs/${second.runId}/events?since=garbage`,
      { headers: { authorization: `Bearer ${gateway.token}` } },
    )
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({ error: 'cursor_invalid' })

    const mismatched = await fetch(
      `${gateway.baseUrl}/api/v1/runs/${second.runId}/events?since=0`,
      { headers: { authorization: `Bearer ${gateway.token}` } },
    )
    expect(mismatched.status).toBe(409)
    expect(await mismatched.json()).toMatchObject({ error: 'cursor_mismatch' })

    gateway.state.pruneAgentEvents(thread.id)
    const prunedSnapshot = await fetch(`${gateway.baseUrl}/api/v1/runs/${second.runId}`, {
      headers: { authorization: `Bearer ${gateway.token}` },
    })
    expect(await prunedSnapshot.json()).toMatchObject({ earliestRetainedCursor: null })
    const expired = await fetch(
      `${gateway.baseUrl}/api/v1/runs/${second.runId}/events?since=2`,
      { headers: { authorization: `Bearer ${gateway.token}` } },
    )
    expect(expired.status).toBe(410)
    expect(await expired.json()).toMatchObject({ error: 'cursor_expired' })
  })
})
