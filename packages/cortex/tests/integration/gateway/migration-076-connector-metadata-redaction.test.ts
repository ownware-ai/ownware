import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CortexDatabase } from '../../../src/gateway/db/database.js'
import {
  auditMigrations,
  runMigrationsSafely,
} from '../../../src/gateway/db/migration-safety.js'
import { MIGRATIONS } from '../../../src/gateway/db/schema.js'

let dir = ''

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

describe('migration 076 connector metadata redaction', () => {
  it('removes legacy metadata and expires pending attempts that cannot resume', () => {
    dir = mkdtempSync(join(tmpdir(), 'connector-metadata-redaction-'))
    const path = join(dir, 'ownware.db')
    const old = new Database(path)
    runMigrationsSafely(old, path, MIGRATIONS.filter((migration) => migration.version <= 75))

    const secretCanary = 'legacy-link-secret-never-retain'
    const identityCanary = 'legacy-install-identity-never-retain'
    const insert = old.prepare(`
      INSERT INTO connector_connections (
        connection_id, connector_id, source, entity_id, status,
        initiated_at, completed_at, expires_at, error_reason, metadata_json,
        auth_config_id, vendor_account_id, vendor_user_id
      ) VALUES (?, ?, 'composio', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    insert.run(
      'pending_legacy',
      'gmail',
      'install-current',
      'pending',
      1_750_000_000_000,
      null,
      1_950_000_000_000,
      null,
      JSON.stringify({
        authorizationUrl: 'https://synthetic.example.test/authorize',
        linkToken: secretCanary,
        userId: identityCanary,
      }),
      'auth_pending',
      'vendor_pending',
      'vendor-user-pending',
    )
    insert.run(
      'ready_legacy',
      'slack',
      'install-current',
      'ready',
      1_750_000_000_100,
      1_750_000_000_200,
      null,
      null,
      JSON.stringify({ accessToken: secretCanary, userId: identityCanary }),
      'auth_ready',
      'vendor_ready',
      'vendor-user-ready',
    )
    insert.run(
      'failed_legacy',
      'notion',
      'install-current',
      'failed',
      1_750_000_000_300,
      1_750_000_000_400,
      null,
      'User denied access.',
      JSON.stringify({ refreshToken: secretCanary }),
      'auth_failed',
      'vendor_failed',
      'vendor-user-failed',
    )
    insert.run(
      'expired_legacy',
      'github',
      'install-current',
      'expired',
      1_750_000_000_500,
      1_750_000_000_600,
      1_750_000_000_550,
      'Connection attempt timed out.',
      JSON.stringify({ linkToken: secretCanary }),
      'auth_expired',
      'vendor_expired',
      'vendor-user-expired',
    )
    old.close()

    const upgraded = new CortexDatabase(path)
    const rows = upgraded.rawMainHandle.prepare(`
      SELECT connection_id, status, completed_at, error_reason, metadata_json,
             auth_config_id, vendor_account_id, vendor_user_id
      FROM connector_connections
      ORDER BY connection_id
    `).all() as Array<Record<string, unknown>>

    expect(JSON.stringify(rows)).not.toContain(secretCanary)
    expect(JSON.stringify(rows)).not.toContain(identityCanary)
    expect(rows.every((row) => row.metadata_json === null)).toBe(true)
    expect(rows.find((row) => row.connection_id === 'pending_legacy')).toEqual(
      expect.objectContaining({
        status: 'expired',
        completed_at: expect.any(Number),
        error_reason: 'Connection attempt expired during a security upgrade. Please reconnect.',
        auth_config_id: 'auth_pending',
        vendor_account_id: 'vendor_pending',
        vendor_user_id: 'vendor-user-pending',
      }),
    )
    expect(rows.find((row) => row.connection_id === 'ready_legacy')).toEqual(
      expect.objectContaining({ status: 'ready', completed_at: 1_750_000_000_200 }),
    )
    expect(rows.find((row) => row.connection_id === 'failed_legacy')).toEqual(
      expect.objectContaining({ status: 'failed', error_reason: 'User denied access.' }),
    )
    expect(rows.find((row) => row.connection_id === 'expired_legacy')).toEqual(
      expect.objectContaining({ status: 'expired', error_reason: 'Connection attempt timed out.' }),
    )
    expect(upgraded.rawMainHandle.pragma('foreign_key_check')).toEqual([])
    expect(upgraded.rawMainHandle.pragma('integrity_check', { simple: true })).toBe('ok')
    expect(upgraded.rawMainHandle.pragma('user_version', { simple: true }))
      .toBe(MIGRATIONS.at(-1)!.version)
    expect(auditMigrations(MIGRATIONS)).toEqual([])
    upgraded.close()
  })
})
