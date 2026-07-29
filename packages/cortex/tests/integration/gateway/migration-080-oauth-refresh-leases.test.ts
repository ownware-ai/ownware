import Database from 'better-sqlite3'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  auditMigrations,
  runMigrationsSafely,
} from '../../../src/gateway/db/migration-safety.js'
import { MIGRATIONS } from '../../../src/gateway/db/schema.js'

describe('migration 080 OAuth refresh leases', () => {
  it('upgrades a v79 database with a content-free lease table', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'oauth-refresh-migration-'))
    const path = join(directory, 'ownware.db')
    const db = new Database(path)
    try {
      runMigrationsSafely(
        db,
        path,
        MIGRATIONS.filter(migration => migration.version <= 79),
      )
      expect(db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'oauth_refresh_leases'
      `).get()).toBeUndefined()

      runMigrationsSafely(
        db,
        path,
        MIGRATIONS.filter(migration => migration.version <= 80),
      )

      expect(db.pragma('user_version', { simple: true })).toBe(80)
      expect(auditMigrations(MIGRATIONS)).toEqual([])
      const columns = db.prepare(
        'PRAGMA table_info(oauth_refresh_leases)',
      ).all() as Array<{ name: string }>
      expect(columns.map(column => column.name)).toEqual([
        'credential_id',
        'owner_id',
        'generation',
        'expires_at',
        'updated_at',
      ])
      expect(columns.map(column => column.name)).not.toEqual(
        expect.arrayContaining([
          'token',
          'access_token',
          'refresh_token',
          'account_id',
          'metadata',
          'payload',
        ]),
      )
    } finally {
      db.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
