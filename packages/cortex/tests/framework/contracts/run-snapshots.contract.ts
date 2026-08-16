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
  egressMode: z.enum(['unrestricted', 'local-only']),
  timeoutMs: z.number().int().positive(),
  status: z.enum([
    'accepted', 'running', 'waiting', 'cancel_requested',
    'succeeded', 'failed', 'cancelled', 'timed_out', 'indeterminate',
  ]),
  consequence: z.enum([
    'none_observed', 'output_observed', 'effect_possible', 'effect_confirmed',
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

const EffectReceiptSchema = z.object({
  receiptId: z.string().uuid(),
  sequence: z.number().int().positive(),
  effectId: z.string().uuid(),
  runId: z.string().uuid(),
  toolCallId: z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/),
  toolName: z.string().regex(/^[A-Za-z0-9_.:-]{1,160}$/),
  kind: z.enum([
    'intent_observed', 'outcome_observed', 'authority_confirmed', 'reconciliation',
  ]),
  outcome: z.enum(['pending', 'succeeded', 'failed', 'denied', 'unknown']),
  consequence: z.enum([
    'none_observed', 'output_observed', 'effect_possible', 'effect_confirmed',
  ]),
  authorityKind: z.enum(['runtime', 'effect_observer', 'reconciler']),
  authorityRef: z.string().regex(/^[A-Za-z0-9_.:/-]{1,160}$/),
  observedAt: z.number().int().nonnegative(),
}).strict()

const EffectReceiptPageSchema = z.object({
  items: z.array(EffectReceiptSchema).max(100),
  nextCursor: z.string().uuid().nullable(),
}).strict()

const EgressReceiptSchema = z.object({
  receiptId: z.string().uuid(),
  sequence: z.number().int().positive(),
  dispatchId: z.string().uuid(),
  runId: z.string().uuid(),
  mode: z.enum(['unrestricted', 'local-only']),
  sourceKind: z.enum(['provider', 'tool', 'connector', 'browser', 'process', 'runtime']),
  sourceRef: z.string().regex(/^[A-Za-z0-9_.:-]{1,160}$/),
  transport: z.enum(['http', 'https', 'ws', 'wss', 'tcp', 'tls', 'unknown']),
  mediation: z.enum(['platform_fetch', 'custom_fetch', 'uncontained', 'unknown']),
  destinationOrigin: z.string().nullable(),
  phase: z.enum([
    'dispatch_started', 'response_observed', 'dispatch_failed',
    'dispatch_blocked', 'route_unavailable', 'outcome_unknown',
  ]),
  reasonCode: z.enum([
    'local_only_remote_destination', 'local_only_custom_transport',
    'local_only_route_unavailable', 'local_only_redirect', 'route_unavailable',
    'run_terminated_after_dispatch', 'gateway_restarted_after_dispatch',
  ]).nullable(),
  observedAt: z.number().int().nonnegative(),
}).strict()

const EgressReceiptPageSchema = z.object({
  items: z.array(EgressReceiptSchema).max(100),
  nextCursor: z.string().uuid().nullable(),
}).strict()

async function waitForTerminalSnapshot(
  gateway: TestGateway,
  runId: string,
): Promise<z.infer<typeof RunSnapshotSchema>> {
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    const response = await fetch(`${gateway.baseUrl}/api/v1/runs/${runId}`, {
      headers: { authorization: `Bearer ${gateway.token}` },
    })
    expect(response.status).toBe(200)
    const snapshot = RunSnapshotSchema.parse(await response.json())
    if (snapshot.terminal) return snapshot
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Run ${runId} did not become terminal`)
}

describe('Contract: immutable run snapshots', () => {
  let gateway: TestGateway

  beforeEach(async () => {
    registerProvider({ name: 'snapshottest' } as unknown as ProviderAdapter)
    gateway = await createTestGateway({
      disableAuth: false,
      profiles: [
        { name: 'snapshot-test', model: 'snapshottest:model', tools: { preset: 'none' } },
        {
          name: 'snapshot-custom',
          model: 'snapshottest:model',
          tools: { preset: 'none', custom: [{ path: './tools/escape.mjs' }] },
          customTools: {
            'tools/escape.mjs': "throw new Error('secret-canary-module-ran')\n",
          },
        },
      ],
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
      egressMode: 'unrestricted',
      timeoutMs: 30 * 60 * 1000,
      consequence: 'none_observed',
      startSeq: 0,
      earliestRetainedCursor: 0,
    })
  })

  it('fences an exact loopback-owner retry even when authentication is disabled', async () => {
    await gateway.stop()
    gateway = await createTestGateway({
      disableAuth: true,
      profiles: [{ name: 'snapshot-test', model: 'snapshottest:model', tools: { preset: 'none' } }],
    })
    const key = '45454545-4545-4545-8545-454545454545'
    const start = () => fetch(`${gateway.baseUrl}/api/v1/run`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      body: JSON.stringify({ profileId: 'snapshot-test', prompt: 'one provider event' }),
    })

    const first = await start()
    expect(first.status).toBe(200)
    const firstBody = z.object({ runId: z.string().uuid(), threadId: z.string() })
      .passthrough().parse(await first.json())

    const replay = await start()
    expect(replay.status).toBe(200)
    expect(replay.headers.get('idempotency-replayed')).toBe('true')
    await expect(replay.json()).resolves.toMatchObject({
      runId: firstBody.runId,
      threadId: firstBody.threadId,
    })
  })

  it('pages immutable payload-free effect observations with an exact cursor', async () => {
    const thread = await gateway.state.createThread('snapshot-test')
    const run = await gateway.gateway.runStore.create({
      threadId: thread.id,
      profileId: 'snapshot-test',
      model: 'snapshottest:model',
      timeoutMs: 60_000,
      startSeq: 0,
    }, 1_000)
    await gateway.gateway.runStore.markRunning(run.runId, 1_010)
    const receipts = gateway.state.securityRepositories.effectReceipts
    const first = await receipts.observe({
      runId: run.runId,
      toolCallId: 'public_call_1',
      toolName: 'send_message',
      observationKey: 'runtime:1',
      kind: 'intent_observed',
      outcome: 'pending',
      consequence: 'none_observed',
      authorityKind: 'runtime',
      authorityRef: 'runtime.tool_call.start',
      runtimeSequence: 1,
    }, 1_020)
    await receipts.observe({
      runId: run.runId,
      toolCallId: 'public_call_1',
      toolName: 'send_message',
      observationKey: 'runtime:2',
      kind: 'outcome_observed',
      outcome: 'failed',
      consequence: 'effect_possible',
      authorityKind: 'runtime',
      authorityRef: 'runtime.tool_call.end',
      runtimeSequence: 2,
    }, 900)

    const pageResponse = await fetch(
      `${gateway.baseUrl}/api/v1/runs/${run.runId}/effect-receipts?limit=1`,
      { headers: { authorization: `Bearer ${gateway.token}` } },
    )
    expect(pageResponse.status).toBe(200)
    expect(pageResponse.headers.get('cache-control')).toBe('no-store')
    const page = EffectReceiptPageSchema.parse(await pageResponse.json())
    expect(page.items).toEqual([first])
    expect(page.nextCursor).toBe(first.receiptId)
    expect(JSON.stringify(page)).not.toContain('input')
    expect(JSON.stringify(page)).not.toContain('result')

    const nextResponse = await fetch(
      `${gateway.baseUrl}/api/v1/runs/${run.runId}/effect-receipts?limit=1&cursor=${page.nextCursor}`,
      { headers: { authorization: `Bearer ${gateway.token}` } },
    )
    const next = EffectReceiptPageSchema.parse(await nextResponse.json())
    expect(next.items).toHaveLength(1)
    expect(next.items[0]).toMatchObject({
      effectId: first.effectId,
      outcome: 'failed',
      consequence: 'effect_possible',
    })
    expect(next.nextCursor).toBeNull()

    const foreignCursor = await fetch(
      `${gateway.baseUrl}/api/v1/runs/${run.runId}/effect-receipts?cursor=00000000-0000-4000-8000-000000000000`,
      { headers: { authorization: `Bearer ${gateway.token}` } },
    )
    expect(foreignCursor.status).toBe(400)
    expect(await foreignCursor.json()).toMatchObject({
      error: 'effect_receipt_cursor_invalid',
    })
  })

  it('pages immutable payload-free egress observations with an exact cursor', async () => {
    const thread = await gateway.state.createThread('snapshot-test')
    const run = await gateway.gateway.runStore.create({
      threadId: thread.id,
      profileId: 'snapshot-test',
      model: 'snapshottest:model',
      egressMode: 'unrestricted',
      timeoutMs: 60_000,
      startSeq: 0,
    }, 1_000)
    await gateway.gateway.runStore.markRunning(run.runId, 1_010)
    const receipts = gateway.state.securityRepositories.egressReceipts
    const dispatchId = '77777777-7777-4777-8777-777777777777'
    const identity = {
      dispatchId,
      runId: run.runId,
      mode: 'unrestricted' as const,
      sourceKind: 'provider' as const,
      sourceRef: 'snapshottest',
      transport: 'https' as const,
      mediation: 'platform_fetch' as const,
      destinationOrigin: 'https://models.example.test',
    }
    const first = await receipts.observe({
      ...identity,
      observationKey: 'dispatch:started',
      phase: 'dispatch_started',
      reasonCode: null,
    }, 1_020)
    await receipts.observe({
      ...identity,
      observationKey: 'dispatch:response',
      phase: 'response_observed',
      reasonCode: null,
    }, 900)

    const pageResponse = await fetch(
      `${gateway.baseUrl}/api/v1/runs/${run.runId}/egress-receipts?limit=1`,
      { headers: { authorization: `Bearer ${gateway.token}` } },
    )
    expect(pageResponse.status).toBe(200)
    expect(pageResponse.headers.get('cache-control')).toBe('no-store')
    const page = EgressReceiptPageSchema.parse(await pageResponse.json())
    expect(page.items).toEqual([first])
    expect(page.nextCursor).toBe(first.receiptId)
    expect(JSON.stringify(page)).not.toContain('prompt')
    expect(JSON.stringify(page)).not.toContain('secret-canary')

    const nextResponse = await fetch(
      `${gateway.baseUrl}/api/v1/runs/${run.runId}/egress-receipts?limit=1&cursor=${page.nextCursor}`,
      { headers: { authorization: `Bearer ${gateway.token}` } },
    )
    const next = EgressReceiptPageSchema.parse(await nextResponse.json())
    expect(next.items).toHaveLength(1)
    expect(next.items[0]).toMatchObject({ dispatchId, phase: 'response_observed' })
    expect(next.nextCursor).toBeNull()

    const foreignCursor = await fetch(
      `${gateway.baseUrl}/api/v1/runs/${run.runId}/egress-receipts?cursor=00000000-0000-4000-8000-000000000000`,
      { headers: { authorization: `Bearer ${gateway.token}` } },
    )
    expect(foreignCursor.status).toBe(400)
    expect(await foreignCursor.json()).toMatchObject({
      error: 'egress_receipt_cursor_invalid',
    })
  })

  it('enforces request local-only mode before an uncontained provider dispatch', async () => {
    const response = await fetch(`${gateway.baseUrl}/api/v1/run`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${gateway.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        profileId: 'snapshot-test',
        prompt: 'do not dispatch remotely',
        egressMode: 'local-only',
      }),
    })
    expect(response.status).toBe(200)
    const started = z.object({
      runId: z.string().uuid(),
      egressMode: z.literal('local-only'),
    }).passthrough().parse(await response.json())

    const terminal = await waitForTerminalSnapshot(gateway, started.runId)
    expect(terminal).toMatchObject({ egressMode: 'local-only', terminal: true })

    const evidenceResponse = await fetch(
      `${gateway.baseUrl}/api/v1/runs/${started.runId}/egress-receipts`,
      { headers: { authorization: `Bearer ${gateway.token}` } },
    )
    const evidence = EgressReceiptPageSchema.parse(await evidenceResponse.json())
    expect(evidence.items).toContainEqual(expect.objectContaining({
      mode: 'local-only',
      sourceKind: 'provider',
      sourceRef: 'snapshottest',
      transport: 'unknown',
      mediation: 'unknown',
      destinationOrigin: null,
      phase: 'dispatch_blocked',
      reasonCode: 'local_only_route_unavailable',
    }))
  })

  it('rejects custom modules before importing them in local-only mode', async () => {
    const response = await fetch(`${gateway.baseUrl}/api/v1/run`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${gateway.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        profileId: 'snapshot-custom',
        prompt: 'do not initialize uncontained code',
        egressMode: 'local-only',
      }),
    })

    expect(response.status).toBe(422)
    const body = await response.json()
    expect(body).toMatchObject({ error: 'local_only_custom_tools_unsupported' })
    expect(JSON.stringify(body)).not.toContain('secret-canary-module-ran')
  })

  it('requires a new thread when the outbound envelope changes', async () => {
    const firstResponse = await fetch(`${gateway.baseUrl}/api/v1/run`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${gateway.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ profileId: 'snapshot-test', prompt: 'first envelope' }),
    })
    expect(firstResponse.status).toBe(200)
    const first = z.object({
      runId: z.string().uuid(),
      threadId: z.string().min(1),
    }).passthrough().parse(await firstResponse.json())
    await waitForTerminalSnapshot(gateway, first.runId)

    const changed = await fetch(`${gateway.baseUrl}/api/v1/run`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${gateway.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        profileId: 'snapshot-test',
        threadId: first.threadId,
        prompt: 'different envelope',
        egressMode: 'local-only',
      }),
    })
    expect(changed.status).toBe(409)
    expect(await changed.json()).toMatchObject({
      error: 'egress_mode_session_mismatch',
      sessionEgressMode: 'unrestricted',
      requestedEgressMode: 'local-only',
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
    const thread = await gateway.state.createThread('mini', 'bounded event replay')
    await gateway.state.eventIngestor.ingestParentEvent(thread.id, {
      type: 'text.delta', text: 'old reply', turnIndex: 0,
    } as never)
    await gateway.state.eventIngestor.ingestParentEvent(thread.id, {
      type: 'turn.end', stopReason: 'end_turn', turnIndex: 0,
    } as never)
    const first = await gateway.gateway.runStore.create({
      threadId: thread.id,
      profileId: 'mini',
      model: 'test:model',
      timeoutMs: 1_000,
      startSeq: 0,
    })
    await gateway.gateway.runStore.markTerminal(first.runId, 'succeeded', {
      endSeq: 2,
      consequence: 'none_observed',
    })

    const second = await gateway.gateway.runStore.create({
      threadId: thread.id,
      profileId: 'mini',
      model: 'test:model',
      timeoutMs: 1_000,
      startSeq: 2,
    })
    await gateway.state.eventIngestor.ingestParentEvent(thread.id, {
      type: 'user.message', text: 'new turn', attachments: null, timestamp: Date.now(),
    } as never)
    await gateway.state.eventIngestor.ingestParentEvent(thread.id, {
      type: 'text.delta', text: 'new reply', turnIndex: 1,
    } as never)
    await gateway.state.eventIngestor.ingestParentEvent(thread.id, {
      type: 'turn.end', stopReason: 'end_turn', turnIndex: 1,
    } as never)
    await gateway.gateway.runStore.markTerminal(second.runId, 'succeeded', {
      endSeq: 5,
      consequence: 'none_observed',
    })

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

    await gateway.state.pruneAgentEvents(thread.id)
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
