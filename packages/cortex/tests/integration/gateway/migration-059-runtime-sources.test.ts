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

describe('migration 059 runtime sources', () => {
  it('additively upgrades v58 with scoped source control metadata only', () => {
    dir = mkdtempSync(join(tmpdir(), 'runtime-source-migration-'))
    const path = join(dir, 'ownware.db')
    const old = new Database(path)
    runMigrationsSafely(old, path, MIGRATIONS.filter((migration) => migration.version <= 58))
    old.close()

    const upgraded = new CortexDatabase(path)
    const columns = upgraded.rawMainHandle.prepare('PRAGMA table_info(runtime_sources)')
      .all() as Array<{ name: string }>
    expect(columns.map((column) => column.name)).toEqual([
      'source_id', 'workspace_id', 'profile_id', 'kind', 'label',
      'classification', 'authority', 'audience_policy_ref',
      'sensitivity_policy_ref', 'purpose_policy_ref', 'retention_policy_ref',
      'freshness_policy_ref', 'revision', 'current_version_id',
      'registration_state', 'inspection_state', 'preparation_state',
      'access_state', 'freshness_state', 'conflict_state', 'deletion_state',
      'created_at', 'updated_at',
    ])
    expect(columns.map((column) => column.name)).not.toEqual(
      expect.arrayContaining(['path', 'url', 'content', 'bytes', 'storage_locator']),
    )
    expect(upgraded.rawMainHandle.pragma('user_version', { simple: true }))
      .toBe(MIGRATIONS.at(-1)!.version)
    upgraded.close()
  })
})
