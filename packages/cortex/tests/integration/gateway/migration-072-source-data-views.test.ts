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

describe('migration 072 source Data View preparations', () => {
  it('adds content-free durable job/manifests without rebuilding established source jobs', () => {
    dir = mkdtempSync(join(tmpdir(), 'source-data-view-migration-'))
    const path = join(dir, 'ownware.db')
    const old = new Database(path)
    runMigrationsSafely(old, path, MIGRATIONS.filter((migration) => migration.version <= 71))
    const sourceJobsSqlBefore = old.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'source_jobs'
    `).get() as { sql: string }
    old.close()

    const upgraded = new CortexDatabase(path)
    const sourceJobsSqlAfter = upgraded.rawMainHandle.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'source_jobs'
    `).get() as { sql: string }
    expect(sourceJobsSqlAfter.sql).toBe(sourceJobsSqlBefore.sql)
    expect(upgraded.rawMainHandle.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN ('source_data_view_jobs', 'source_data_views')
      ORDER BY name
    `).all()).toEqual([
      { name: 'source_data_view_jobs' },
      { name: 'source_data_views' },
    ])
    const viewColumns = upgraded.rawMainHandle.prepare(
      'PRAGMA table_info(source_data_views)',
    ).all() as Array<{ name: string }>
    expect(viewColumns.map((column) => column.name)).not.toEqual(
      expect.arrayContaining(['content', 'bytes', 'cells', 'rows', 'prompt', 'error']),
    )
    expect(viewColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'private_object_key', 'fields_json', 'source_checksum',
        'artifact_checksum', 'artifact_byte_count', 'freshness',
      ]),
    )
    expect(upgraded.rawMainHandle.pragma('foreign_key_check')).toEqual([])
    expect(upgraded.rawMainHandle.pragma('integrity_check', { simple: true })).toBe('ok')
    expect(upgraded.rawMainHandle.pragma('user_version', { simple: true }))
      .toBe(MIGRATIONS.at(-1)!.version)
    expect(auditMigrations(MIGRATIONS)).toEqual([])
    upgraded.close()
  })
})
