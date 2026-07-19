/**
 * ConnectorConnectionsStore unit tests.
 *
 * Uses a real temp-file SQLite via CortexDatabase so migrations run
 * end-to-end (same path as production). No mocks.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CortexDatabase } from '../../../../src/gateway/db/database.js'
import {
  ConnectorConnectionsStore,
} from '../../../../src/connector/connections/store.js'

let tmpDir: string
let db: CortexDatabase
let store: ConnectorConnectionsStore

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cortex-connections-'))
  db = new CortexDatabase(join(tmpDir, 'main.db'), join(tmpDir, 'fx.db'))
  store = new ConnectorConnectionsStore(db.rawMainHandle)
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('ConnectorConnectionsStore', () => {
  const sessionMetadata = {
    sessionHandle: 'connection-session.11111111-1111-4111-8111-111111111111',
  } as const

  it('upsertPending creates a pending row with timestamps', () => {
    const row = store.upsertPending({
      connectionId: 'conn_1',
      connectorId: 'notion',
      source: 'composio',
      entityId: 'user_a',
      metadata: sessionMetadata,
    })
    expect(row.status).toBe('pending')
    expect(row.connectorId).toBe('notion')
    expect(row.source).toBe('composio')
    expect(row.entityId).toBe('user_a')
    expect(row.initiatedAt).toBeGreaterThan(0)
    expect(row.completedAt).toBeNull()
    expect(row.metadata).toEqual(sessionMetadata)
  })

  it('upsertPending is idempotent on the same connection_id', () => {
    store.upsertPending({ connectionId: 'c', connectorId: 'x', source: 'composio', entityId: 'cortex-default-user' })
    const again = store.upsertPending({ connectionId: 'c', connectorId: 'x', source: 'composio', entityId: 'cortex-default-user' })
    expect(again.connectionId).toBe('c')
    const all = store.findPending()
    expect(all).toHaveLength(1)
  })

  it('second pending for the same tuple reuses the durable live attempt', () => {
    store.upsertPending({
      connectionId: 'c1', connectorId: 'slack', source: 'composio', entityId: 'u',
      metadata: sessionMetadata,
    })
    const retry = store.upsertPending({ connectionId: 'c2', connectorId: 'slack', source: 'composio', entityId: 'u' })
    expect(retry.connectionId).toBe('c1')
    expect(retry.status).toBe('pending')
    expect(retry.metadata).toEqual(sessionMetadata)
    expect(store.findByConnectionId('c1')).not.toBeNull()
    expect(store.findByConnectionId('c2')).toBeNull()
  })

  it('second pending after a terminal (failed) row COEXISTS — failed history is preserved, fresh attempt succeeds', () => {
    // Partial unique index only governs `('pending','ready')` rows;
    // `failed` history doesn't conflict with a new pending insert, so
    // upsertPending must NOT touch it. The fresh attempt becomes the
    // sole live (pending|ready) row.
    store.upsertPending({ connectionId: 'c1', connectorId: 'slack', source: 'composio', entityId: 'u' })
    store.markFailed({ connectionId: 'c1', reason: 'user rejected' })
    const retry = store.upsertPending({ connectionId: 'c2', connectorId: 'slack', source: 'composio', entityId: 'u' })
    expect(retry.connectionId).toBe('c2')
    expect(retry.status).toBe('pending')
    // c1 (failed) is preserved as history — useful for audit/debug.
    const c1 = store.findByConnectionId('c1')
    expect(c1).not.toBeNull()
    expect(c1!.status).toBe('failed')
    // Only c2 is live; findActive returns the new one.
    expect(store.findActive('slack', 'composio', 'u')?.connectionId).toBe('c2')
  })

  it('second pending after an expired row COEXISTS — expired history is preserved, fresh attempt succeeds', () => {
    // Boot-sweep flips pending → expired when the gateway restarts
    // mid-flow. Expired rows are also outside the partial unique
    // index's WHERE clause, so the fresh attempt slots in beside
    // the old expired row.
    store.upsertPending({
      connectionId: 'c1',
      connectorId: 'slack',
      source: 'composio',
      entityId: 'u',
      expiresAt: Date.now() - 60_000,
    })
    store.expireStaleOnBoot()
    const retry = store.upsertPending({
      connectionId: 'c2',
      connectorId: 'slack',
      source: 'composio',
      entityId: 'u',
    })
    expect(retry.connectionId).toBe('c2')
    expect(retry.status).toBe('pending')
    // c1 (expired) preserved.
    const c1 = store.findByConnectionId('c1')
    expect(c1).not.toBeNull()
    expect(c1!.status).toBe('expired')
    expect(store.findActive('slack', 'composio', 'u')?.connectionId).toBe('c2')
  })

  it('mixed history (expired + pending) preserves both durable rows', () => {
    // Real-world case from 2026-05-26: a user had ONE expired row +
    // ONE pending row for the same tuple. A naive "find any row by
    // tuple, delete it" could pick the harmless expired row and miss
    // the actual conflict. This guards both the unique constraint and the
    // encrypted-session ownership rule by reusing the live pending row.
    store.upsertPending({
      connectionId: 'expired-old',
      connectorId: 'gmail',
      source: 'composio',
      entityId: 'u',
      expiresAt: Date.now() - 60_000,
    })
    store.expireStaleOnBoot()
    store.upsertPending({
      connectionId: 'pending-mid',
      connectorId: 'gmail',
      source: 'composio',
      entityId: 'u',
    })
    // Now (expired-old, pending-mid) both exist for the same tuple.
    const retry = store.upsertPending({
      connectionId: 'pending-new',
      connectorId: 'gmail',
      source: 'composio',
      entityId: 'u',
    })
    expect(retry.connectionId).toBe('pending-mid')
    expect(retry.status).toBe('pending')
    // Expired row UNTOUCHED — that's history.
    const expired = store.findByConnectionId('expired-old')
    expect(expired).not.toBeNull()
    expect(expired!.status).toBe('expired')
    expect(store.findByConnectionId('pending-mid')).not.toBeNull()
    expect(store.findByConnectionId('pending-new')).toBeNull()
    expect(store.findActive('gmail', 'composio', 'u')?.connectionId).toBe('pending-mid')
  })

  it('second upsertPending against an ALREADY-READY row reuses the ready row (never destroys a working connection)', () => {
    store.upsertPending({
      connectionId: 'c1', connectorId: 'slack', source: 'composio', entityId: 'u',
      metadata: sessionMetadata,
    })
    store.markReady({ connectionId: 'c1' })
    const result = store.upsertPending({
      connectionId: 'c2',
      connectorId: 'slack',
      source: 'composio',
      entityId: 'u',
    })
    // Returned row is the original `ready` c1, NOT a fresh c2.
    expect(result.connectionId).toBe('c1')
    expect(result.status).toBe('ready')
    // c2 was never inserted; terminal c1 contains no session metadata.
    expect(store.findByConnectionId('c2')).toBeNull()
    expect(result.metadata).toBeNull()
  })

  it('markReady clears session metadata, preserves completedAt, and is idempotent', () => {
    store.upsertPending({
      connectionId: 'c', connectorId: 'x', source: 'composio',
      entityId: 'cortex-default-user', metadata: sessionMetadata,
    })
    const r1 = store.markReady({ connectionId: 'c', vendorAccountId: 'vendor-c' })
    expect(r1.status).toBe('ready')
    expect(r1.transitioned).toBe(true)
    expect(r1.completedAt).not.toBeNull()
    expect(r1.metadata).toBeNull()
    expect(r1.vendorAccountId).toBe('vendor-c')

    const t1 = r1.completedAt!
    const r2 = store.markReady({ connectionId: 'c', vendorUserId: 'vendor-user' })
    expect(r2.transitioned).toBe(false)
    expect(r2.completedAt).toBe(t1)
    expect(r2.metadata).toBeNull()
    expect(r2.vendorAccountId).toBe('vendor-c')
    expect(r2.vendorUserId).toBe('vendor-user')
  })

  it('markFailed records reason', () => {
    store.upsertPending({
      connectionId: 'c', connectorId: 'x', source: 'composio',
      entityId: 'cortex-default-user', metadata: sessionMetadata,
    })
    const r = store.markFailed({ connectionId: 'c', reason: 'bad creds' })
    expect(r.status).toBe('failed')
    expect(r.transitioned).toBe(true)
    expect(r.errorReason).toBe('bad creds')
    expect(r.metadata).toBeNull()
  })

  it('late completion cannot resurrect a revoked, expired, or failed row', () => {
    for (const [id, terminal] of [
      ['revoked', 'revoked'], ['expired', 'expired'], ['failed', 'failed'],
    ] as const) {
      store.upsertPending({
        connectionId: id, connectorId: id, source: 'composio',
        entityId: 'cortex-default-user', metadata: sessionMetadata,
      })
      if (terminal === 'revoked') store.markRevoked(id, 'owner revoked')
      if (terminal === 'expired') store.markExpired(id, 'timed out')
      if (terminal === 'failed') store.markFailed({ connectionId: id, reason: 'denied' })

      expect(store.markReady({ connectionId: id }).transitioned).toBe(false)
      expect(store.markFailed({ connectionId: id, reason: 'late failure' }).transitioned)
        .toBe(false)
      expect(store.markExpired(id, 'late expiry')?.transitioned).toBe(false)
      expect(store.findByConnectionId(id)?.status)
        .toBe(terminal === 'revoked' ? 'expired' : terminal)
      expect(store.findByConnectionId(id)?.metadata).toBeNull()
    }
  })

  it('reconciliation can demote a ready row without reopening completion CAS', () => {
    store.upsertPending({
      connectionId: 'ready', connectorId: 'x', source: 'composio',
      entityId: 'cortex-default-user', metadata: sessionMetadata,
    })
    store.markReady({ connectionId: 'ready' })
    const result = store.markUnhealthy('ready', 'Vendor disabled the account.')
    expect(result?.transitioned).toBe(true)
    expect(result).toMatchObject({ status: 'failed', metadata: null })
    expect(store.markReady({ connectionId: 'ready' }).transitioned).toBe(false)
  })

  it('markFailed on unknown connection throws', () => {
    expect(() => store.markFailed({ connectionId: 'ghost', reason: 'x' })).toThrow()
  })

  it('markExpired on pending row works; no-op on terminal row', () => {
    store.upsertPending({ connectionId: 'p', connectorId: 'x', source: 'composio', entityId: 'cortex-default-user' })
    const r = store.markExpired('p')
    expect(r?.status).toBe('expired')

    store.upsertPending({ connectionId: 'r', connectorId: 'y', source: 'composio', entityId: 'cortex-default-user' })
    store.markReady({ connectionId: 'r' })
    const still = store.markExpired('r')
    expect(still?.status).toBe('ready')
  })

  it('findActive returns the live (pending|ready) row only', () => {
    store.upsertPending({ connectionId: 'a', connectorId: 'n', source: 'composio', entityId: 'cortex-default-user' })
    expect(store.findActive('n', 'composio', 'cortex-default-user')?.connectionId).toBe('a')
    store.markFailed({ connectionId: 'a', reason: 'x' })
    expect(store.findActive('n', 'composio', 'cortex-default-user')).toBeNull()
  })

  it('expireStaleOnBoot transitions pending rows past expires_at', () => {
    const past = Date.now() - 10_000
    store.upsertPending({ connectionId: 'old', connectorId: 'x', source: 'composio', entityId: 'cortex-default-user', expiresAt: past })
    store.upsertPending({ connectionId: 'fresh', connectorId: 'y', source: 'composio', entityId: 'cortex-default-user', expiresAt: Date.now() + 60_000 })
    const count = store.expireStaleOnBoot()
    expect(count).toBe(1)
    expect(store.findByConnectionId('old')?.status).toBe('expired')
    expect(store.findByConnectionId('old')?.errorReason).toMatch(/gateway restarted/i)
    expect(store.findByConnectionId('fresh')?.status).toBe('pending')
  })

  it('touchPolled updates last_polled_at without changing status', () => {
    store.upsertPending({ connectionId: 'p', connectorId: 'x', source: 'composio', entityId: 'cortex-default-user' })
    store.touchPolled('p', 12345)
    const r = store.findByConnectionId('p')
    expect(r?.lastPolledAt).toBe(12345)
    expect(r?.status).toBe('pending')
  })

  // F4.c-1 (2026-05-16): vendor reconciliation timestamp.
  // Distinct from `last_polled_at` (which fires on every tick) —
  // `last_verified_at` is updated ONLY on a successful vendor probe.
  it('touchVerified updates last_verified_at without changing status', () => {
    store.upsertPending({ connectionId: 'v', connectorId: 'x', source: 'composio', entityId: 'cortex-default-user' })
    store.markReady({ connectionId: 'v' })
    store.touchVerified('v', 67890)
    const r = store.findByConnectionId('v')
    expect(r?.lastVerifiedAt).toBe(67890)
    expect(r?.status).toBe('ready')
  })

  it('lastVerifiedAt defaults to null on fresh rows', () => {
    const row = store.upsertPending({
      connectionId: 'fresh',
      connectorId: 'gmail',
      source: 'composio',
      entityId: 'cortex-default-user',
    })
    expect(row.lastVerifiedAt).toBeNull()
  })

  it('touchVerified does not bump last_polled_at and vice versa', () => {
    store.upsertPending({ connectionId: 'split', connectorId: 'x', source: 'composio', entityId: 'cortex-default-user' })
    store.markReady({ connectionId: 'split' })
    store.touchPolled('split', 100)
    store.touchVerified('split', 200)
    const r = store.findByConnectionId('split')
    expect(r?.lastPolledAt).toBe(100)
    expect(r?.lastVerifiedAt).toBe(200)
  })

  // ── Phase 2b.1: auth_config_id column ──────────────────────────────
  it('upsertPending persists authConfigId when supplied', () => {
    const row = store.upsertPending({
      connectionId: 'ca_1',
      connectorId: 'github',
      source: 'composio',
      entityId: 'cortex-default-user',
      authConfigId: 'ac_managed_1',
    })
    expect(row.authConfigId).toBe('ac_managed_1')
    expect(store.findByConnectionId('ca_1')?.authConfigId).toBe('ac_managed_1')
  })

  it('authConfigId defaults to null when omitted', () => {
    const row = store.upsertPending({
      connectionId: 'ca_2',
      connectorId: 'github',
      source: 'composio',
      entityId: 'cortex-default-user',
    })
    expect(row.authConfigId).toBeNull()
  })

  it('existing rows (pre-2b.1) read authConfigId as null (backward compat)', () => {
    // Simulate a 2a-era insert that bypasses the store (no auth_config_id).
    db.rawMainHandle.prepare(
      `INSERT INTO connector_connections
         (connection_id, connector_id, source, entity_id, status,
          initiated_at, completed_at, last_polled_at, expires_at,
          error_reason, metadata_json)
       VALUES ('legacy_1', 'slack', 'composio', 'cortex-default-user', 'pending', ?, NULL, NULL, NULL, NULL, NULL)`,
    ).run(Date.now())
    const r = store.findByConnectionId('legacy_1')
    expect(r).not.toBeNull()
    expect(r?.authConfigId).toBeNull()
  })

  it('idempotent upsertPending preserves authConfigId across calls', () => {
    store.upsertPending({
      connectionId: 'ca_3', connectorId: 'x', source: 'composio', entityId: 'cortex-default-user', authConfigId: 'ac_x',
    })
    // Second call without authConfigId must not wipe it.
    store.upsertPending({ connectionId: 'ca_3', connectorId: 'x', source: 'composio', entityId: 'cortex-default-user' })
    expect(store.findByConnectionId('ca_3')?.authConfigId).toBe('ac_x')
  })
})
