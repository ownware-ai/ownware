import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  EgressBlockedError,
  createEgressFetch,
  type EgressMode,
} from '@ownware/loom'
import {
  EgressReceiptStore,
  EgressReceiptStoreError,
  type EgressReceiptRepository,
} from '../../../src/gateway/egress-receipt-store.js'
import { RunEgressControl } from '../../../src/gateway/egress-control.js'
import { GatewayRunStore } from '../../../src/gateway/run-store.js'
import { GatewayState } from '../../../src/gateway/state.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ownware-egress-receipts-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function fixture(mode: EgressMode = 'unrestricted'): Promise<{
  readonly state: GatewayState
  readonly store: EgressReceiptStore
  readonly repository: EgressReceiptRepository
  readonly runId: string
}> {
  const state = new GatewayState(join(dir, 'egress.db'))
  const thread = await state.createThread('egress-test')
  const runs = new GatewayRunStore(state.rawDbHandle, 'egress-test-secret')
  const run = runs.create({
    threadId: thread.id,
    profileId: 'egress-test',
    model: 'test:model',
    egressMode: mode,
    timeoutMs: 60_000,
    startSeq: 0,
  }, 100)
  runs.markRunning(run.runId, 101)
  const store = new EgressReceiptStore(state.rawDbHandle)
  const repository: EgressReceiptRepository = {
    observe: async (input, now) => store.observe(input, now),
    listForRun: async (runId, page) => store.listForRun(runId, page),
    markPendingUnknownForRun: async (runId, reason, now) =>
      store.markPendingUnknownForRun(runId, reason, now),
    reconcileInterrupted: async (reason, now) => store.reconcileInterrupted(reason, now),
  }
  return { state, store, repository, runId: run.runId }
}

describe('immutable egress receipts and local-only authority', () => {
  it('appends idempotent payload-free lifecycle evidence and paginates', async () => {
    const { state, store, runId } = await fixture()
    try {
      const dispatchId = randomUUID()
      const started = store.observe({
        dispatchId,
        runId,
        mode: 'unrestricted',
        sourceKind: 'provider',
        sourceRef: 'openai',
        transport: 'https',
        mediation: 'platform_fetch',
        observationKey: 'dispatch_started',
        destinationOrigin: 'https://api.example.test',
        phase: 'dispatch_started',
        reasonCode: null,
      }, 110)
      expect(store.observe({
        dispatchId,
        runId,
        mode: 'unrestricted',
        sourceKind: 'provider',
        sourceRef: 'openai',
        transport: 'https',
        mediation: 'platform_fetch',
        observationKey: 'dispatch_started',
        destinationOrigin: 'https://api.example.test',
        phase: 'dispatch_started',
        reasonCode: null,
      }, 999)).toEqual(started)
      const observed = store.observe({
        dispatchId,
        runId,
        mode: 'unrestricted',
        sourceKind: 'provider',
        sourceRef: 'openai',
        transport: 'https',
        mediation: 'platform_fetch',
        observationKey: 'response_observed',
        destinationOrigin: 'https://edge.example.test',
        phase: 'response_observed',
        reasonCode: null,
      }, 120)

      const first = store.listForRun(runId, { limit: 1, cursor: null })
      expect(first.items).toEqual([started])
      expect(first.nextCursor).toBe(started.receiptId)
      expect(store.listForRun(runId, { limit: 1, cursor: first.nextCursor }).items)
        .toEqual([observed])
      expect(JSON.stringify([started, observed])).not.toContain('/secret')

      expect(() => state.rawDbHandle.prepare(`
        UPDATE egress_receipts SET phase = 'dispatch_failed' WHERE receipt_id = ?
      `).run(started.receiptId)).toThrow(/immutable/)
      expect(() => state.rawDbHandle.prepare(`
        DELETE FROM egress_dispatches WHERE dispatch_id = ?
      `).run(dispatchId)).toThrow(/immutable/)
    } finally {
      state.close()
    }
  })

  it('rejects conflicting identity, malformed origins and semantic lies', async () => {
    const { state, store, runId } = await fixture()
    try {
      const base = {
        dispatchId: randomUUID(),
        runId,
        mode: 'unrestricted' as const,
        sourceKind: 'provider' as const,
        sourceRef: 'provider',
        transport: 'https' as const,
        mediation: 'platform_fetch' as const,
        observationKey: 'dispatch_started',
        destinationOrigin: 'https://api.example.test',
        phase: 'dispatch_started' as const,
        reasonCode: null,
      }
      store.observe(base)
      expect(() => store.observe({ ...base, sourceRef: 'different' }))
        .toThrowError(expect.objectContaining({ code: 'identity_conflict' }))
      expect(() => store.observe({ ...base, phase: 'dispatch_failed' }))
        .toThrowError(expect.objectContaining({ code: 'observation_conflict' }))

      for (const destinationOrigin of [
        'https://user:secret@example.test',
        'https://example.test/secret',
        'https://example.test?token=secret',
        'https://example.test#secret',
        'https://example.test\nsecret',
      ]) {
        expect(() => store.observe({
          ...base,
          dispatchId: randomUUID(),
          observationKey: randomUUID(),
          destinationOrigin,
        })).toThrowError(EgressReceiptStoreError)
      }
      expect(() => store.observe({
        ...base,
        dispatchId: randomUUID(),
        observationKey: 'false_route',
        transport: 'unknown',
        mediation: 'unknown',
        destinationOrigin: null,
        phase: 'route_unavailable',
        reasonCode: 'local_only_route_unavailable',
      })).toThrowError(expect.objectContaining({ code: 'invalid_input' }))
    } finally {
      state.close()
    }
  })

  it('admits only platform fetch to literal loopback in local-only mode', async () => {
    const { state, store, repository, runId } = await fixture('local-only')
    try {
      const control = new RunEgressControl('local-only', runId, repository)
      await expect(control.beforeDispatch({
        sourceKind: 'provider',
        sourceRef: 'remote',
        transport: 'https',
        destinationOrigin: 'https://api.example.test',
        mediation: 'platform_fetch',
      })).rejects.toBeInstanceOf(EgressBlockedError)
      await expect(control.beforeDispatch({
        sourceKind: 'provider',
        sourceRef: 'dns_alias',
        transport: 'http',
        destinationOrigin: 'http://localhost:11434',
        mediation: 'platform_fetch',
      })).rejects.toBeInstanceOf(EgressBlockedError)
      await expect(control.beforeDispatch({
        sourceKind: 'provider',
        sourceRef: 'custom',
        transport: 'http',
        destinationOrigin: 'http://127.0.0.1:11434',
        mediation: 'custom_fetch',
      })).rejects.toBeInstanceOf(EgressBlockedError)

      const token = await control.beforeDispatch({
        sourceKind: 'provider',
        sourceRef: 'ollama',
        transport: 'http',
        destinationOrigin: 'http://127.0.0.1:11434',
        mediation: 'platform_fetch',
      })
      await control.responseObserved(token, 'http://127.0.0.1:11434')

      const phases = store.listForRun(runId, { limit: 100, cursor: null }).items
      expect(phases.filter(item => item.phase === 'dispatch_blocked')).toHaveLength(3)
      expect(phases.map(item => item.phase)).toEqual([
        'dispatch_blocked',
        'dispatch_blocked',
        'dispatch_blocked',
        'dispatch_started',
        'response_observed',
      ])
    } finally {
      state.close()
    }
  })

  it('blocks a route-changing redirect before replay and records both origins', async () => {
    const { state, store, repository, runId } = await fixture('local-only')
    try {
      let calls = 0
      const fetch = createEgressFetch({
        control: new RunEgressControl('local-only', runId, repository),
        sourceRef: 'ollama',
        mediation: 'platform_fetch',
        fetch: async () => {
          calls += 1
          return new Response(null, {
            status: 307,
            headers: { location: 'https://remote.example.test/v1' },
          })
        },
      })
      await expect(fetch('http://127.0.0.1:11434/v1/chat', {
        method: 'POST',
        body: 'SECRET_BODY_CANARY',
      })).rejects.toMatchObject({ code: 'local_only_redirect' })
      expect(calls).toBe(1)

      const receipts = store.listForRun(runId, { limit: 100, cursor: null }).items
      expect(receipts.map(item => ({
        destination: item.destinationOrigin,
        phase: item.phase,
        reason: item.reasonCode,
      }))).toEqual([
        {
          destination: 'http://127.0.0.1:11434',
          phase: 'dispatch_started',
          reason: null,
        },
        {
          destination: 'https://remote.example.test',
          phase: 'dispatch_blocked',
          reason: 'local_only_redirect',
        },
        {
          destination: 'http://127.0.0.1:11434',
          phase: 'dispatch_failed',
          reason: null,
        },
      ])
      expect(JSON.stringify(receipts)).not.toContain('SECRET_BODY_CANARY')
      expect(receipts[0]?.dispatchId).toBe(receipts[2]?.dispatchId)
      expect(receipts[1]?.dispatchId).not.toBe(receipts[0]?.dispatchId)
    } finally {
      state.close()
    }
  })

  it('reconciles an offline attempt to explicit uncertainty exactly once', async () => {
    const { state, store, repository, runId } = await fixture()
    try {
      const control = new RunEgressControl('unrestricted', runId, repository)
      await control.beforeDispatch({
        sourceKind: 'provider',
        sourceRef: 'offline',
        transport: 'https',
        destinationOrigin: 'https://offline.example.test',
        mediation: 'platform_fetch',
      })
      expect(store.markPendingUnknownForRun(
        runId,
        'run_terminated_after_dispatch',
        200,
      )).toBe(1)
      expect(store.markPendingUnknownForRun(
        runId,
        'run_terminated_after_dispatch',
        201,
      )).toBe(0)
      expect(store.listForRun(runId, { limit: 10, cursor: null }).items.at(-1))
        .toMatchObject({
          phase: 'outcome_unknown',
          reasonCode: 'run_terminated_after_dispatch',
        })
    } finally {
      state.close()
    }
  })
})
