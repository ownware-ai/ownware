import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CortexDatabase } from '../../../../src/gateway/db/database.js'
import { ConnectorConnectionsStore } from '../../../../src/connector/connections/store.js'
import { ConnectionPoller } from '../../../../src/connector/completion/poller.js'
import { createConnectorStatusBus, type ConnectorStatusBus, type ConnectorStatusEvent } from '../../../../src/connector/status-bus.js'
import type { ConnectionCompletionListener, ConnectionCheckResult } from '../../../../src/connector/completion/types.js'

let tmpDir: string
let db: CortexDatabase
let store: ConnectorConnectionsStore
let bus: ConnectorStatusBus
let events: ConnectorStatusEvent[]

beforeEach(() => {
  vi.useFakeTimers()
  tmpDir = mkdtempSync(join(tmpdir(), 'cortex-poller-'))
  db = new CortexDatabase(join(tmpDir, 'main.db'), join(tmpDir, 'fx.db'))
  store = new ConnectorConnectionsStore(db.rawMainHandle)
  bus = createConnectorStatusBus()
  events = []
  bus.subscribe(e => events.push(e))
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(tmpDir, { recursive: true, force: true })
})

function mkListener(
  impl: (id: string, meta: Record<string, unknown> | null) => Promise<ConnectionCheckResult>,
  source = 'composio',
): ConnectionCompletionListener {
  return { source, checkStatus: async (id, meta) => impl(id, meta) }
}

describe('ConnectionPoller', () => {
  it('ready result marks row and emits one event', async () => {
    const poller = new ConnectionPoller(store, bus, { initialDelayMs: 100, maxDurationMs: 60_000 })
    store.upsertPending({ connectionId: 'c', connectorId: 'notion', source: 'composio', entityId: 'cortex-default-user' })
    poller.register('c', mkListener(async () => ({ status: 'ready', completedMetadata: { tok: 'x' } })))
    await vi.advanceTimersByTimeAsync(150)
    expect(store.findByConnectionId('c')?.status).toBe('ready')
    expect(store.findByConnectionId('c')?.metadata).toMatchObject({ tok: 'x' })
    expect(events).toHaveLength(1)
    expect(events[0]!.status).toBe('ready')
    expect(events[0]!.source).toBe('composio')
  })

  it('pending then ready: poller backs off then resolves', async () => {
    const poller = new ConnectionPoller(store, bus, { initialDelayMs: 100, backoffMultiplier: 2, maxDelayMs: 5_000, maxDurationMs: 60_000 })
    store.upsertPending({ connectionId: 'c', connectorId: 'x', source: 'composio', entityId: 'cortex-default-user' })
    let attempt = 0
    poller.register('c', mkListener(async () => {
      attempt++
      return attempt < 3 ? { status: 'pending' } : { status: 'ready' }
    }))
    await vi.advanceTimersByTimeAsync(100) // attempt 1 → pending, next delay 200
    await vi.advanceTimersByTimeAsync(200) // attempt 2 → pending, next delay 400
    await vi.advanceTimersByTimeAsync(400) // attempt 3 → ready
    expect(attempt).toBe(3)
    expect(store.findByConnectionId('c')?.status).toBe('ready')
  })

  it('failed result marks row with reason', async () => {
    const poller = new ConnectionPoller(store, bus, { initialDelayMs: 50, maxDurationMs: 60_000 })
    store.upsertPending({ connectionId: 'c', connectorId: 'x', source: 'composio', entityId: 'cortex-default-user' })
    poller.register('c', mkListener(async () => ({ status: 'failed', errorReason: 'user denied' })))
    await vi.advanceTimersByTimeAsync(60)
    expect(store.findByConnectionId('c')?.status).toBe('failed')
    expect(store.findByConnectionId('c')?.errorReason).toBe('user denied')
    expect(events[0]!.status).toBe('error')
  })

  it('listener throw is caught, row is marked failed, poller does not crash', async () => {
    const poller = new ConnectionPoller(store, bus, { initialDelayMs: 50, maxDurationMs: 60_000 })
    store.upsertPending({ connectionId: 'c', connectorId: 'x', source: 'composio', entityId: 'cortex-default-user' })
    poller.register('c', mkListener(async () => { throw new Error('boom') }))
    await vi.advanceTimersByTimeAsync(60)
    const row = store.findByConnectionId('c')
    expect(row?.status).toBe('failed')
    expect(row?.errorReason).toBe('boom')
    expect(poller.activeCount).toBe(0)
  })

  it('maxDurationMs elapsed → marked expired', async () => {
    const poller = new ConnectionPoller(store, bus, { initialDelayMs: 50, maxDelayMs: 50, maxDurationMs: 200 })
    store.upsertPending({ connectionId: 'c', connectorId: 'x', source: 'composio', entityId: 'cortex-default-user' })
    poller.register('c', mkListener(async () => ({ status: 'pending' })))
    // Advance well past budget.
    await vi.advanceTimersByTimeAsync(500)
    expect(store.findByConnectionId('c')?.status).toBe('expired')
  })

  it('register is idempotent for an already-active id', () => {
    const poller = new ConnectionPoller(store, bus, { initialDelayMs: 10_000 })
    store.upsertPending({ connectionId: 'c', connectorId: 'x', source: 'composio', entityId: 'cortex-default-user' })
    poller.register('c', mkListener(async () => ({ status: 'pending' })))
    poller.register('c', mkListener(async () => ({ status: 'pending' })))
    expect(poller.activeCount).toBe(1)
  })

  it('cancel aborts and removes state', async () => {
    const poller = new ConnectionPoller(store, bus, { initialDelayMs: 1000 })
    store.upsertPending({ connectionId: 'c', connectorId: 'x', source: 'composio', entityId: 'cortex-default-user' })
    poller.register('c', mkListener(async () => ({ status: 'pending' })))
    expect(poller.activeCount).toBe(1)
    poller.cancel('c')
    expect(poller.activeCount).toBe(0)
    expect(poller.isActive('c')).toBe(false)
  })

  it('register on unknown connectionId throws', () => {
    const poller = new ConnectionPoller(store, bus)
    expect(() =>
      poller.register('ghost', mkListener(async () => ({ status: 'pending' }))),
    ).toThrow(/unknown connectionId/)
  })

  it('register on a ready row is a no-op', () => {
    const poller = new ConnectionPoller(store, bus, { initialDelayMs: 1000 })
    store.upsertPending({ connectionId: 'c', connectorId: 'x', source: 'composio', entityId: 'cortex-default-user' })
    store.markReady({ connectionId: 'c' })
    poller.register('c', mkListener(async () => ({ status: 'pending' })))
    expect(poller.activeCount).toBe(0)
  })

  it('backoff caps at maxDelayMs', async () => {
    const poller = new ConnectionPoller(store, bus, {
      initialDelayMs: 100,
      backoffMultiplier: 10,
      maxDelayMs: 500,
      maxDurationMs: 60_000,
    })
    store.upsertPending({ connectionId: 'c', connectorId: 'x', source: 'composio', entityId: 'cortex-default-user' })
    let attempts = 0
    poller.register('c', mkListener(async () => {
      attempts++
      return { status: 'pending' }
    }))
    await vi.advanceTimersByTimeAsync(100)  // 1
    await vi.advanceTimersByTimeAsync(500)  // 2 (capped)
    await vi.advanceTimersByTimeAsync(500)  // 3 (capped)
    expect(attempts).toBe(3)
  })
})
