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

describe('migration 075 delegated principal subjects', () => {
  it('adds the nullable subject column to a fresh database', () => {
    dir = mkdtempSync(join(tmpdir(), 'principal-subject-fresh-'))
    const database = new CortexDatabase(join(dir, 'ownware.db'))
    const columns = database.rawMainHandle
      .prepare('PRAGMA table_info(delegated_principals)')
      .all() as Array<{ name: string; notnull: number }>

    expect(columns.at(-1)).toEqual(expect.objectContaining({
      name: 'subject_id',
      notnull: 0,
    }))
    expect(database.rawMainHandle.pragma('user_version', { simple: true }))
      .toBe(MIGRATIONS.at(-1)!.version)
    expect(auditMigrations(MIGRATIONS)).toEqual([])
    database.close()
  })

  it('preserves subject-less legacy principals while upgrading from v74', () => {
    dir = mkdtempSync(join(tmpdir(), 'principal-subject-upgrade-'))
    const path = join(dir, 'ownware.db')
    const old = new Database(path)
    runMigrationsSafely(old, path, MIGRATIONS.filter((migration) => migration.version <= 74))
    old.prepare(`
      INSERT INTO delegated_principals (
        token_id, delegate_id, workspace_id, profile_id, purpose, channel,
        operations_json, issued_at, expires_at, revoked_at, revoke_reason
      ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, NULL)
    `).run(
      '11111111-1111-4111-8111-111111111111',
      'legacy-client',
      'workspace_1',
      'assistant',
      'support',
      JSON.stringify(['runs.start']),
      1_750_000_000,
      1_750_000_900,
    )
    old.close()

    const upgraded = new CortexDatabase(path)
    expect(upgraded.rawMainHandle.prepare(`
      SELECT delegate_id, subject_id, operations_json
      FROM delegated_principals WHERE token_id = ?
    `).get('11111111-1111-4111-8111-111111111111')).toEqual({
      delegate_id: 'legacy-client',
      subject_id: null,
      operations_json: JSON.stringify(['runs.start']),
    })
    expect(upgraded.rawMainHandle.pragma('foreign_key_check')).toEqual([])
    expect(upgraded.rawMainHandle.pragma('integrity_check', { simple: true })).toBe('ok')
    expect(upgraded.rawMainHandle.pragma('user_version', { simple: true }))
      .toBe(MIGRATIONS.at(-1)!.version)
    expect(auditMigrations(MIGRATIONS)).toEqual([])
    upgraded.close()
  })
})
