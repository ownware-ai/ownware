import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CandidateStore } from '../../../src/gateway/candidate-store.js'
import { CortexDatabase } from '../../../src/gateway/db/database.js'
import { runMigrationsSafely } from '../../../src/gateway/db/migration-safety.js'
import { MIGRATIONS } from '../../../src/gateway/db/schema.js'

let dir = ''

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

describe('migration 056 candidate activation and run pin', () => {
  it('preserves a v55 ready candidate and makes it activatable', () => {
    dir = mkdtempSync(join(tmpdir(), 'candidate-activation-migration-'))
    const path = join(dir, 'ownware.db')
    const old = new Database(path)
    runMigrationsSafely(old, path, MIGRATIONS.filter((migration) => migration.version <= 55))
    const candidateId = `sha256:${'a'.repeat(64)}`
    old.prepare(`
      INSERT INTO profile_candidates (
        candidate_id, profile_id, state, attempt_id, file_count, total_bytes,
        code, created_at, updated_at
      ) VALUES (?, 'portable', 'ready', NULL, 1, 20, NULL, 100, 100)
    `).run(candidateId)
    old.close()

    const upgraded = new CortexDatabase(path)
    const store = new CandidateStore(upgraded.rawMainHandle)
    expect(store.get(candidateId)).toMatchObject({ state: 'ready', profileId: 'portable' })
    expect(store.compareAndSetActive({
      profileId: 'portable', candidateId, expectedActiveCandidateId: null,
    })).toMatchObject({ status: 'activated', activeCandidateId: candidateId })
    const runColumns = upgraded.rawMainHandle.prepare('PRAGMA table_info(gateway_runs)')
      .all() as Array<{ name: string }>
    expect(runColumns.some((column) => column.name === 'candidate_id')).toBe(true)
    upgraded.close()
  })
})
