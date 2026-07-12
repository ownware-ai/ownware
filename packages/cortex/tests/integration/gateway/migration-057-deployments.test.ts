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

describe('migration 057 profile deployment state', () => {
  it('preserves a v56 active candidate as revision one with unknown health', () => {
    dir = mkdtempSync(join(tmpdir(), 'candidate-deployment-migration-'))
    const path = join(dir, 'ownware.db')
    const old = new Database(path)
    runMigrationsSafely(old, path, MIGRATIONS.filter((migration) => migration.version <= 56))
    const candidateId = `sha256:${'a'.repeat(64)}`
    old.prepare(`
      INSERT INTO profile_candidates (
        candidate_id, profile_id, state, attempt_id, file_count, total_bytes,
        code, created_at, updated_at
      ) VALUES (?, 'portable', 'ready', NULL, 1, 20, NULL, 100, 100)
    `).run(candidateId)
    old.prepare(`
      INSERT INTO profile_candidate_activations (profile_id, candidate_id, updated_at)
      VALUES ('portable', ?, 100)
    `).run(candidateId)
    old.close()

    const upgraded = new CortexDatabase(path)
    const store = new CandidateStore(upgraded.rawMainHandle)
    expect(store.getActive('portable')).toEqual({
      profileId: 'portable', candidateId, deploymentRevision: 1,
      routingState: 'active', health: 'unknown', healthObservedAt: null,
      updatedAt: 100,
    })
    upgraded.close()
  })
})
