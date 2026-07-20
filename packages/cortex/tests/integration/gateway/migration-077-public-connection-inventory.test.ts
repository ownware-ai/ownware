import Database from 'better-sqlite3'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  auditMigrations,
  runMigrationsSafely,
} from '../../../src/gateway/db/migration-safety.js'
import { MIGRATIONS } from '../../../src/gateway/db/schema.js'

describe('migration 077 public connection inventory identity', () => {
  const cleanup: string[] = []

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true })))
  })

  it('backfills opaque public ids while hiding ambiguous expired history', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'public-connection-inventory-'))
    cleanup.push(directory)
    const path = join(directory, 'ownware.db')
    const db = new Database(path)
    runMigrationsSafely(db, path, MIGRATIONS.filter((migration) => migration.version <= 76))
    const insert = db.prepare(`
      INSERT INTO connector_connections (
        connection_id, connector_id, source, entity_id, status, initiated_at,
        completed_at, last_polled_at, expires_at, error_reason, metadata_json,
        auth_config_id, vendor_account_id, vendor_user_id, last_verified_at
      ) VALUES (?, ?, 'composio', 'synthetic-owner', ?, ?, ?, NULL, NULL, ?, NULL,
        'auth-config-canary', 'vendor-account-canary', 'vendor-user-canary', NULL)
    `)
    insert.run('vendor-ready-id', 'mail', 'ready', 1_000, 2_000, null)
    insert.run('vendor-failed-id', 'calendar', 'failed', 3_000, 4_000, 'vendor failed')
    insert.run('vendor-expired-id', 'storage', 'expired', 5_000, 6_000, 'unknown history')

    runMigrationsSafely(db, path, MIGRATIONS)

    const rows = db.prepare(`
      SELECT connection_id, public_connection_id, terminal_cause
      FROM connector_connections ORDER BY initiated_at
    `).all() as Array<{
      connection_id: string
      public_connection_id: string
      terminal_cause: string | null
    }>
    expect(rows).toHaveLength(3)
    expect(new Set(rows.map((row) => row.public_connection_id)).size).toBe(3)
    expect(rows.every((row) => /^[0-9a-f-]{36}$/.test(row.public_connection_id))).toBe(true)
    expect(rows.map((row) => row.terminal_cause)).toEqual([
      null, 'failed', 'legacy_hidden',
    ])
    expect(rows.every((row) => row.public_connection_id !== row.connection_id)).toBe(true)
    expect(db.pragma('foreign_key_check')).toEqual([])
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok')
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.at(-1)!.version)
    expect(auditMigrations(MIGRATIONS)).toEqual([])
    db.close()
  })
})
