/**
 * ComposioReconciler — periodic vendor-side health check.
 *
 * Covers four guarantees:
 *   1. Vendor ACTIVE → updates `last_verified_at` and emits no event
 *      (the bus dedupes ready-to-ready).
 *   2. Vendor INACTIVE / EXPIRED / FAILED → marks the local row
 *      `failed` and emits `auth_error`.
 *   3. Vendor returns no record → emits `stale` on first miss; after
 *      `staleToleranceMs` of continuous staleness, escalates to
 *      `auth_error` and marks local row `failed`.
 *   4. Errors don't update `last_verified_at`. A failed
 *      `listConnectedAccounts` returns `{ status: 'error' }` and
 *      leaves all timestamps untouched.
 *
 * Uses the real ConnectorConnectionsStore + ConnectorStatusBus wired
 * against an in-memory SQLite via CortexDatabase. Composio client is
 * stubbed because vendor calls are the only thing the test cares to
 * simulate.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CortexDatabase } from '../../../../src/gateway/db/database.js'
import { ConnectorConnectionsStore } from '../../../../src/connector/connections/store.js'
import { ConnectorStatusBus } from '../../../../src/connector/status-bus.js'
import type {
  ComposioClient,
  ComposioConnectedAccount,
  ComposioConnectedAccountStatus,
} from '../../../../src/connector/composio/client.js'
import { ComposioReconciler } from '../../../../src/connector/composio/reconciler.js'

// ── Test infra ──────────────────────────────────────────────────────────

function makeAccount(
  slug: string,
  status: ComposioConnectedAccountStatus,
  id?: string,
): ComposioConnectedAccount {
  return {
    id: id ?? `conn-${slug}`,
    toolkit: { slug },
    auth_config: { id: `ac-${slug}`, is_composio_managed: true, is_disabled: false },
    status,
  } as ComposioConnectedAccount
}

interface StubClientHandle {
  client: ComposioClient
  /** Number of times `listConnectedAccounts` has been called. */
  callCount: number
  /** Replace the next page response. */
  setItems(items: ComposioConnectedAccount[]): void
  /** Force the next call to throw. */
  setThrows(err: Error | null): void
}

function makeStubClient(initialItems: ComposioConnectedAccount[] = []): StubClientHandle {
  let items: ComposioConnectedAccount[] = initialItems
  let throwNext: Error | null = null
  const handle: StubClientHandle = {
    client: {
      async listConnectedAccounts() {
        handle.callCount++
        if (throwNext !== null) {
          const err = throwNext
          throwNext = null
          throw err
        }
        return { items, next_cursor: null }
      },
    } as unknown as ComposioClient,
    callCount: 0,
    setItems(next) { items = next },
    setThrows(err) { throwNext = err },
  }
  return handle
}

interface CapturedEvent {
  connectorId: string
  source: string
  status: string
  previousStatus: string | null
  reason?: string
}

function capture(bus: ConnectorStatusBus): {
  events: CapturedEvent[]
  unsubscribe: () => void
} {
  const events: CapturedEvent[] = []
  const unsubscribe = bus.subscribe((ev) => {
    events.push({
      connectorId: ev.connectorId,
      source: ev.source,
      status: ev.status,
      previousStatus: ev.previousStatus,
      ...(ev.reason !== undefined ? { reason: ev.reason } : {}),
    })
  })
  return { events, unsubscribe }
}

// ── Fixture ─────────────────────────────────────────────────────────────

const USER_ID = 'user-1'

let tmpDir: string
let db: CortexDatabase
let connections: ConnectorConnectionsStore
let statusBus: ConnectorStatusBus

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cortex-reconcile-'))
  db = new CortexDatabase(join(tmpDir, 'main.db'), join(tmpDir, 'fx.db'))
  connections = new ConnectorConnectionsStore(db.rawMainHandle)
  statusBus = new ConnectorStatusBus()
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

function seedReady(slug: string, connectionId?: string): string {
  const id = connectionId ?? `conn-${slug}`
  connections.upsertPending({
    connectionId: id,
    connectorId: slug,
    source: 'composio',
    entityId: USER_ID,
    vendorAccountId: id,
  })
  connections.markReady({ connectionId: id, vendorAccountId: id })
  return id
}

// ── Scenarios ───────────────────────────────────────────────────────────

describe('ComposioReconciler', () => {
  it('returns ok with zero counts when there are no local ready rows', async () => {
    const handle = makeStubClient([])
    const reconciler = new ComposioReconciler({
      client: handle.client,
      connections,
      statusBus,
      defaultUserId: USER_ID,
    })

    const result = await reconciler.reconcileNow()

    expect(result.status).toBe('ok')
    expect(result.checked).toBe(0)
    expect(result.verified).toBe(0)
    expect(result.markedAuthError).toBe(0)
    expect(result.markedStale).toBe(0)
    // Critical: do NOT call vendor API when there's nothing to check.
    expect(handle.callCount).toBe(0)
  })

  it('verifies an ACTIVE row: writes last_verified_at and emits ready', async () => {
    seedReady('gmail')

    const handle = makeStubClient([makeAccount('gmail', 'ACTIVE')])
    const { events, unsubscribe } = capture(statusBus)
    const fakeNow = 1_700_000_000_000
    const reconciler = new ComposioReconciler({
      client: handle.client,
      connections,
      statusBus,
      defaultUserId: USER_ID,
      now: () => fakeNow,
    })

    const result = await reconciler.reconcileNow()
    unsubscribe()

    expect(result.status).toBe('ok')
    expect(result.verified).toBe(1)
    expect(result.markedAuthError).toBe(0)
    expect(result.markedStale).toBe(0)

    const row = connections.findActive('gmail', 'composio', USER_ID)
    expect(row?.status).toBe('ready')
    expect(row?.lastVerifiedAt).toBe(fakeNow)

    // One emit for the ready confirmation. Pre-cache, the bus has no
    // prior status, so the first ready→ready isn't deduped.
    expect(events).toEqual([
      expect.objectContaining({
        connectorId: 'gmail',
        source: 'composio',
        status: 'ready',
        previousStatus: null,
      }),
    ])
  })

  it('flips to auth_error when vendor reports INACTIVE', async () => {
    seedReady('gmail')

    const handle = makeStubClient([makeAccount('gmail', 'INACTIVE')])
    const { events, unsubscribe } = capture(statusBus)
    const reconciler = new ComposioReconciler({
      client: handle.client,
      connections,
      statusBus,
      defaultUserId: USER_ID,
    })

    const result = await reconciler.reconcileNow()
    unsubscribe()

    expect(result.markedAuthError).toBe(1)
    expect(result.verified).toBe(0)

    // Local row promoted to terminal `failed` so the assembler stops
    // surfacing this connector as ready to the agent.
    const row = connections.findByConnectionId('conn-gmail')
    expect(row?.status).toBe('failed')
    expect(row?.errorReason).toContain('INACTIVE')

    expect(events).toEqual([
      expect.objectContaining({
        connectorId: 'gmail',
        status: 'auth_error',
        reason: 'Vendor reports INACTIVE',
      }),
    ])
  })

  it('flips to auth_error for EXPIRED and FAILED vendor statuses', async () => {
    seedReady('slack', 'conn-slack')
    seedReady('notion', 'conn-notion')

    const handle = makeStubClient([
      makeAccount('slack', 'EXPIRED', 'conn-slack'),
      makeAccount('notion', 'FAILED', 'conn-notion'),
    ])
    const { events, unsubscribe } = capture(statusBus)
    const reconciler = new ComposioReconciler({
      client: handle.client,
      connections,
      statusBus,
      defaultUserId: USER_ID,
    })

    await reconciler.reconcileNow()
    unsubscribe()

    expect(events.map(e => ({ id: e.connectorId, status: e.status }))).toEqual(
      expect.arrayContaining([
        { id: 'slack', status: 'auth_error' },
        { id: 'notion', status: 'auth_error' },
      ]),
    )
  })

  it('emits stale on first vendor miss and does not flip local state', async () => {
    seedReady('gmail')

    // Vendor returns NO account for `conn-gmail`. Could be a transient
    // page-walk hiccup or a real disappearance; we don't know yet.
    const handle = makeStubClient([])
    const { events, unsubscribe } = capture(statusBus)
    const reconciler = new ComposioReconciler({
      client: handle.client,
      connections,
      statusBus,
      defaultUserId: USER_ID,
      staleToleranceMs: 60_000,
    })

    const result = await reconciler.reconcileNow()
    unsubscribe()

    expect(result.markedStale).toBe(1)
    expect(result.markedAuthError).toBe(0)

    // Local row stays `ready` — we never preempt-fail on a single
    // missed probe.
    const row = connections.findActive('gmail', 'composio', USER_ID)
    expect(row?.status).toBe('ready')

    expect(events).toEqual([
      expect.objectContaining({
        connectorId: 'gmail',
        status: 'stale',
        reason: 'Vendor returned no record for this connection',
      }),
    ])
  })

  it('escalates stale → auth_error after staleToleranceMs of continuous misses', async () => {
    seedReady('gmail')

    const handle = makeStubClient([])
    const { events, unsubscribe } = capture(statusBus)
    let now = 1_700_000_000_000
    const reconciler = new ComposioReconciler({
      client: handle.client,
      connections,
      statusBus,
      defaultUserId: USER_ID,
      staleToleranceMs: 60_000,
      now: () => now,
    })

    // Tick 1: stale.
    await reconciler.reconcileNow()
    // Tick 2 within tolerance: still stale (no escalation).
    now += 30_000
    await reconciler.reconcileNow()
    // Tick 3 past tolerance: escalate to auth_error.
    now += 31_000
    await reconciler.reconcileNow()
    unsubscribe()

    const statuses = events.map((e) => e.status)
    // First two ticks: stale (the bus dedupes the second since the
    // cached last-status is already stale).
    expect(statuses.filter((s) => s === 'stale').length).toBeGreaterThanOrEqual(1)
    // Last tick: auth_error.
    expect(statuses).toContain('auth_error')

    const row = connections.findByConnectionId('conn-gmail')
    expect(row?.status).toBe('failed')
    expect(row?.errorReason).toContain('Vendor no longer reports')
  })

  it('returns to ready when vendor confirms ACTIVE after a stale streak', async () => {
    seedReady('gmail')

    const handle = makeStubClient([])
    const reconciler = new ComposioReconciler({
      client: handle.client,
      connections,
      statusBus,
      defaultUserId: USER_ID,
      staleToleranceMs: 60_000,
    })

    // First tick: stale.
    await reconciler.reconcileNow()
    // Second tick: vendor returns ACTIVE — recovery.
    handle.setItems([makeAccount('gmail', 'ACTIVE')])
    const { events, unsubscribe } = capture(statusBus)
    const result = await reconciler.reconcileNow()
    unsubscribe()

    expect(result.verified).toBe(1)
    expect(events.map(e => e.status)).toContain('ready')

    const row = connections.findActive('gmail', 'composio', USER_ID)
    expect(row?.status).toBe('ready')
  })

  it('returns error and leaves last_verified_at untouched when vendor throws', async () => {
    const connectionId = seedReady('gmail')

    const handle = makeStubClient([])
    handle.setThrows(new Error('network down'))
    const { events, unsubscribe } = capture(statusBus)
    const reconciler = new ComposioReconciler({
      client: handle.client,
      connections,
      statusBus,
      defaultUserId: USER_ID,
      log: () => undefined, // silence error log for clean test output
    })

    const result = await reconciler.reconcileNow()
    unsubscribe()

    expect(result.status).toBe('error')
    expect(result.reason).toContain('network down')
    expect(result.verified).toBe(0)
    expect(result.markedAuthError).toBe(0)

    const row = connections.findByConnectionId(connectionId)
    expect(row?.lastVerifiedAt).toBeNull()
    expect(events).toEqual([])
  })

  it('start() / stop() schedules and clears the interval', async () => {
    const handle = makeStubClient([])
    const reconciler = new ComposioReconciler({
      client: handle.client,
      connections,
      statusBus,
      defaultUserId: USER_ID,
      intervalMs: 1000,
    })

    reconciler.start()
    reconciler.stop()
    reconciler.stop() // idempotent — must not throw

    // After stop, calling reconcileNow() must still work (the
    // scheduler is independent of the synchronous probe path).
    const result = await reconciler.reconcileNow()
    expect(result.status).toBe('ok')
  })

  it('coalesces concurrent reconcileNow() calls', async () => {
    seedReady('gmail')

    let resolveCall: (() => void) | null = null
    const blocker = new Promise<void>((resolve) => { resolveCall = resolve })
    let callCount = 0
    const client: ComposioClient = {
      async listConnectedAccounts() {
        callCount++
        await blocker
        return { items: [makeAccount('gmail', 'ACTIVE')], next_cursor: null }
      },
    } as unknown as ComposioClient
    const reconciler = new ComposioReconciler({
      client,
      connections,
      statusBus,
      defaultUserId: USER_ID,
    })

    const p1 = reconciler.reconcileNow()
    const p2 = reconciler.reconcileNow()
    expect(p1).toBe(p2)

    resolveCall!()
    await Promise.all([p1, p2])
    // Despite two concurrent callers, the vendor API is hit exactly once.
    expect(callCount).toBe(1)
  })
})
