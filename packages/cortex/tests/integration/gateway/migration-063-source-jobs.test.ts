import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CortexDatabase } from '../../../src/gateway/db/database.js'
import { runMigrationsSafely } from '../../../src/gateway/db/migration-safety.js'
import { MIGRATIONS } from '../../../src/gateway/db/schema.js'

let dir = ''

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

describe('migration 063 durable source jobs', () => {
  it('adds scoped bounded job control without source data or raw diagnostics', () => {
    dir = mkdtempSync(join(tmpdir(), 'source-job-migration-'))
    const path = join(dir, 'ownware.db')
    const old = new Database(path)
    runMigrationsSafely(old, path, MIGRATIONS.filter((migration) => migration.version <= 62))
    old.close()

    const upgraded = new CortexDatabase(path)
    const columns = upgraded.rawMainHandle.prepare('PRAGMA table_info(source_jobs)')
      .all() as Array<{ name: string }>
    expect(columns.map((column) => column.name)).toEqual([
      'job_id', 'workspace_id', 'profile_id', 'source_id', 'source_version_id',
      'operation', 'implementation_version', 'source_revision', 'resource_id',
      'state', 'attempt', 'max_attempts', 'checkpoint',
      'claim_token', 'claimed_by', 'lease_expires_at', 'retry_after',
      'cancel_requested_at', 'outcome_code', 'created_at', 'updated_at',
      'terminal_at',
    ])
    expect(columns.map((column) => column.name)).not.toEqual(expect.arrayContaining([
      'path', 'url', 'content', 'bytes', 'parser_output', 'error_message',
      'exception', 'secret',
    ]))
    const foreignKeys = upgraded.rawMainHandle.prepare(
      'PRAGMA foreign_key_list(source_jobs)',
    ).all() as Array<{ table: string; from: string; to: string }>
    expect(foreignKeys).toEqual(expect.arrayContaining([
      expect.objectContaining({
        table: 'runtime_sources', from: 'source_id', to: 'source_id',
      }),
      expect.objectContaining({
        table: 'runtime_sources', from: 'workspace_id', to: 'workspace_id',
      }),
      expect.objectContaining({
        table: 'runtime_sources', from: 'profile_id', to: 'profile_id',
      }),
      expect.objectContaining({
        table: 'source_versions', from: 'source_version_id', to: 'source_version_id',
      }),
      expect.objectContaining({
        table: 'source_versions', from: 'source_id', to: 'source_id',
      }),
    ]))
    expect(upgraded.rawMainHandle.pragma('user_version', { simple: true })).toBe(MIGRATIONS.at(-1)!.version)
    upgraded.close()
  })
})
