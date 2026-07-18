import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CortexDatabase } from '../../../src/gateway/db/database.js'
import { auditMigrations, runMigrationsSafely } from '../../../src/gateway/db/migration-safety.js'
import { MIGRATIONS } from '../../../src/gateway/db/schema.js'

let dir = ''

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

describe('migration 069 versioned access grants', () => {
  it('additively creates only bounded provider-neutral grant metadata', () => {
    dir = mkdtempSync(join(tmpdir(), 'access-grant-migration-'))
    const path = join(dir, 'ownware.db')
    const old = new Database(path)
    old.pragma('foreign_keys = ON')
    runMigrationsSafely(old, path, MIGRATIONS.filter((migration) => migration.version <= 68))
    old.prepare(`
      INSERT INTO source_deletion_tombstones (
        job_id, workspace_id, profile_id, source_id, state, source_revision,
        immutable_originals, upload_staging, placed_candidates, derived_resources,
        data_views, search_indexes, source_jobs, idempotency_replays,
        retrieval_cache_entries, created_at, terminal_at
      ) VALUES (
        '11111111-1111-4111-8111-111111111111', 'workspace.test', 'assistant',
        '22222222-2222-4222-8222-222222222222', 'deleted', 2,
        1, 0, 0, 0, 0, 0, 0, 0, 0, 100, 200
      )
    `).run()
    old.close()

    const upgraded = new CortexDatabase(path)
    const db = upgraded.rawMainHandle
    expect(tableColumns(db, 'access_grants')).toEqual([
      'grant_id', 'workspace_id', 'profile_id', 'current_revision', 'created_at',
    ])
    const revisionColumns = tableColumns(db, 'access_grant_revisions')
    expect(revisionColumns).toEqual([
      'grant_id', 'revision', 'workspace_id', 'profile_id', 'state', 'subject_id',
      'purpose', 'channel', 'resource_kind', 'resource_id', 'operation',
      'field_scope_mode', 'field_ids_json', 'row_scope_mode', 'row_ids_json',
      'consent_state', 'consent_evidence_id', 'autonomy_ceiling', 'effective_at',
      'expires_at', 'issued_by', 'revision_created_at', 'revoked_at',
    ])
    expect(revisionColumns).not.toEqual(expect.arrayContaining([
      'secret', 'token', 'credential', 'content', 'value', 'tool_input',
      'request_json', 'result_json', 'path', 'object_key',
    ]))
    expect(db.prepare(`
      SELECT state, source_id FROM source_deletion_tombstones
    `).get()).toEqual({
      state: 'deleted',
      source_id: '22222222-2222-4222-8222-222222222222',
    })
    expect(db.prepare(`
      SELECT version, name FROM _migrations WHERE version = 69
    `).get()).toEqual({ version: 69, name: '069_versioned_access_grants' })
    db.exec('BEGIN')
    db.prepare(`
      INSERT INTO access_grants (
        grant_id, workspace_id, profile_id, current_revision, created_at
      ) VALUES (
        '33333333-3333-4333-8333-333333333333',
        'workspace.test', 'assistant', 1, 300
      )
    `).run()
    expect(() => db.exec('COMMIT')).toThrow('FOREIGN KEY constraint failed')
    db.exec('ROLLBACK')
    expect(db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND name LIKE 'access_grant%'
      ORDER BY name
    `).all()).toEqual([
      { name: 'access_grant_revisions_no_delete' },
      { name: 'access_grant_revisions_no_update' },
      { name: 'access_grants_monotonic_head' },
      { name: 'access_grants_no_delete' },
    ])
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.at(-1)!.version)
    expect(db.pragma('foreign_key_check')).toEqual([])
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok')
    expect(auditMigrations(MIGRATIONS)).toEqual([])
    upgraded.close()
  })
})

function tableColumns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .map((column) => column.name)
}
