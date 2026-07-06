/**
 * End-to-end test: a pre-021 connection survives the migration and
 * executes successfully WITHOUT the user reconnecting.
 *
 * Simulates the exact production scenario the user hit:
 *
 *   1. Months ago: connection was made. The buggy code stored
 *      entity_id=null on the row, composioConnectedAccountId in metadata,
 *      and Composio's user_id is whatever the buggy code sent (we
 *      treat it as unknown — the resolver doesn't need it because
 *      connectedAccountId is unambiguous).
 *   2. Migration 019 healed entity_id null → 'cortex-default-user'.
 *   3. Migration 021 backfilled vendor_account_id from
 *      metadata.composioConnectedAccountId.
 *   4. Today: tool execution must succeed. The resolver routes through
 *      vendor_account_id (frozen, vendor-side correct) — never the
 *      migrated entity_id.
 *
 * If this test fails, the architectural fix isn't sufficient and a
 * real customer with old connections would still see "user ID does
 * not match" errors after the migration. The test exists exactly to
 * prove this scenario is closed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CortexDatabase } from '../../../../src/gateway/db/database.js'
import { ConnectorConnectionsStore } from '../../../../src/connector/connections/store.js'
import { ComposioIdentityResolver } from '../../../../src/connector/identity/resolver.js'

let tmpDir: string
let db: CortexDatabase
let connections: ConnectorConnectionsStore

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cortex-identity-e2e-'))
  db = new CortexDatabase(join(tmpDir, 'main.db'), join(tmpDir, 'fx.db'))
  connections = new ConnectorConnectionsStore(db.rawMainHandle)
})

afterEach(() => {
  db.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('Legacy connection survives identity rename — E2E', () => {
  it('a pre-021-style row (vendor_account_id only via metadata-backfill) executes correctly', () => {
    // ── Step 1: simulate a row that's already been through migrations
    //    019 (entity_id NULL → cortex-default-user) and 021 (vendor_account_id
    //    backfilled from metadata.composioConnectedAccountId).
    //
    // Production scenario: this is exactly what the user's GoogleSheets
    // row looked like after both migrations applied to their existing
    // database. We seed via raw SQL because the Store API enforces
    // newer invariants — we want to assert recovery from older state.
    db.rawMainHandle.prepare(`
      INSERT INTO connector_connections (
        connection_id, connector_id, source, entity_id, status,
        initiated_at, completed_at, last_polled_at, expires_at,
        error_reason, metadata_json, auth_config_id,
        vendor_account_id, vendor_user_id
      ) VALUES (
        'ca_legacy_sheets', 'googlesheets', 'composio',
        'cortex-default-user', 'ready',
        ?, ?, NULL, NULL, NULL,
        '{"composioConnectedAccountId":"ca_legacy_sheets"}',
        'ac_legacy',
        'ca_legacy_sheets',
        NULL
      )
    `).run(Date.now() - 100, Date.now() - 50)

    // ── Step 2: read the row through the store (production read path).
    const found = connections.findActive('googlesheets', 'composio', 'cortex-default-user')
    expect(found).not.toBeNull()
    expect(found!.vendorAccountId).toBe('ca_legacy_sheets')
    expect(found!.vendorUserId).toBeNull()  // legacy row, never recorded

    // ── Step 3: resolver returns the unambiguous pointer. NEVER falls
    //    back to entity_id — even though entity_id is set, the resolver
    //    must use vendor_account_id.
    const resolver = new ComposioIdentityResolver()
    const identity = resolver.resolveExecuteIdentity(found!)

    expect(identity.connectedAccountId).toBe('ca_legacy_sheets')
    expect(identity.vendorUserId).toBeUndefined()  // critical: would cause Composio mismatch
  })

  it('the same row, after a hypothetical multi-user migration of entity_id, still executes', () => {
    db.rawMainHandle.prepare(`
      INSERT INTO connector_connections (
        connection_id, connector_id, source, entity_id, status,
        initiated_at, completed_at, last_polled_at, expires_at,
        error_reason, metadata_json, auth_config_id,
        vendor_account_id, vendor_user_id
      ) VALUES (
        'ca_legacy_sheets', 'googlesheets', 'composio',
        'cortex-default-user', 'ready',
        ?, ?, NULL, NULL, NULL,
        '{"composioConnectedAccountId":"ca_legacy_sheets"}',
        'ac_legacy',
        'ca_legacy_sheets',
        NULL
      )
    `).run(Date.now() - 100, Date.now() - 50)

    // Simulate multi-user: a future migration moves entity_id from
    // 'cortex-default-user' to a real per-user id.
    db.rawMainHandle.prepare(`
      UPDATE connector_connections SET entity_id = 'user_42' WHERE connection_id = ?
    `).run('ca_legacy_sheets')

    // Read row under the NEW entity_id. This is what the future code
    // would do. The resolver must STILL return the frozen vendor pointer
    // regardless of how entity_id moved.
    const row = connections.findByConnectionId('ca_legacy_sheets')
    expect(row).not.toBeNull()
    expect(row!.entityId).toBe('user_42')

    const resolver = new ComposioIdentityResolver()
    const identity = resolver.resolveExecuteIdentity(row!)

    expect(identity.connectedAccountId).toBe('ca_legacy_sheets')
    // entity_id changed completely — the frozen vendor pointer didn't.
    expect(identity.connectedAccountId).not.toBe(row!.entityId)
  })

  it('migration 021 actually backfills existing rows', () => {
    // Confirm migration 021's backfill clause fires on an arbitrary
    // composio row that has metadata but no vendor_account_id column
    // value (simulating: row created pre-021, migration just ran).
    //
    // We can't run migration 021 in isolation here — CortexDatabase
    // applies all migrations on construction. Instead, we exercise
    // the BACKFILL CLAUSE directly to prove its semantics are right.
    db.rawMainHandle.prepare(`
      INSERT INTO connector_connections (
        connection_id, connector_id, source, entity_id, status,
        initiated_at,
        metadata_json
      ) VALUES (
        'ca_pre021', 'gmail', 'composio',
        'cortex-default-user', 'ready',
        ?,
        '{"composioConnectedAccountId":"ca_pre021"}'
      )
    `).run(Date.now())

    // Initially vendor_account_id is null because the INSERT didn't set it.
    let found = connections.findByConnectionId('ca_pre021')
    expect(found!.vendorAccountId).toBeNull()

    // Run the migration's backfill clause directly. Same SQL as
    // migration 021. If this changes, the migration changes too.
    db.rawMainHandle.exec(`
      UPDATE connector_connections
         SET vendor_account_id = json_extract(metadata_json, '$.composioConnectedAccountId')
       WHERE source = 'composio'
         AND status IN ('ready', 'pending')
         AND json_extract(metadata_json, '$.composioConnectedAccountId') IS NOT NULL
    `)

    found = connections.findByConnectionId('ca_pre021')
    expect(found!.vendorAccountId).toBe('ca_pre021')

    // Resolver gives the right thing post-backfill.
    const identity = new ComposioIdentityResolver().resolveExecuteIdentity(found!)
    expect(identity.connectedAccountId).toBe('ca_pre021')
  })
})

describe('New connection (post-021) — full happy path', () => {
  it('upsertPending → markReady captures vendor identity at both hops', () => {
    // Production connect flow: handler upsertPending with vendorAccountId
    // and vendorUserId; listener later markReady with the same fields.
    connections.upsertPending({
      connectionId: 'ca_new',
      connectorId: 'slack',
      source: 'composio',
      entityId: 'cortex-default-user',
      vendorAccountId: 'ca_new',
      vendorUserId: 'cortex-default-user',
      authConfigId: 'ac_slack',
      metadata: {
        authorizationUrl: 'https://oauth/slack/redirect',
        userId: 'cortex-default-user',
      },
    })

    let row = connections.findByConnectionId('ca_new')
    expect(row!.vendorAccountId).toBe('ca_new')
    expect(row!.vendorUserId).toBe('cortex-default-user')

    connections.markReady({
      connectionId: 'ca_new',
      vendorAccountId: 'ca_new',
      vendorUserId: 'real-vendor-side-user-from-poll',
      metadata: { reconciled: false },
    })

    row = connections.findByConnectionId('ca_new')
    expect(row!.status).toBe('ready')
    expect(row!.vendorAccountId).toBe('ca_new')
    // markReady's COALESCE logic preserves the original (already-known)
    // vendorUserId rather than overwriting — vendor-side identity is
    // append-only-if-null. Both writers (upsertPending + markReady)
    // converge on the value the connect handler captured first.
    expect(row!.vendorUserId).toBe('cortex-default-user')

    // Resolver does the right thing. Per resolver.ts (2026-04-28+):
    // universal-emit — every vendor-frozen identity field present on
    // the row is sent. Both fields share trust level (vendor-frozen
    // at connect-time) and emitting both survives any future Composio
    // cross-check tightening.
    const identity = new ComposioIdentityResolver().resolveExecuteIdentity(row!)
    expect(identity.connectedAccountId).toBe('ca_new')
    expect(identity.vendorUserId).toBe('cortex-default-user')
  })
})
