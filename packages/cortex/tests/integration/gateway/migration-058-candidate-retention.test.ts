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

describe('migration 058 candidate retention evidence', () => {
  it('backfills the current v57 deployment into append-only activation history', () => {
    dir = mkdtempSync(join(tmpdir(), 'candidate-retention-migration-'))
    const path = join(dir, 'ownware.db')
    const old = new Database(path)
    runMigrationsSafely(old, path, MIGRATIONS.filter((migration) => migration.version <= 57))
    const candidateId = `sha256:${'a'.repeat(64)}`
    old.prepare(`
      INSERT INTO profile_candidates (
        candidate_id, profile_id, state, attempt_id, file_count, total_bytes,
        code, created_at, updated_at
      ) VALUES (?, 'portable', 'ready', NULL, 1, 20, NULL, 100, 100)
    `).run(candidateId)
    old.prepare(`
      INSERT INTO profile_candidate_activations (
        profile_id, candidate_id, deployment_revision, routing_state,
        health, health_observed_at, updated_at
      ) VALUES ('portable', ?, 4, 'paused', 'unknown', NULL, 120)
    `).run(candidateId)
    old.close()

    const upgraded = new CortexDatabase(path)
    expect(upgraded.rawMainHandle.prepare(`
      SELECT profile_id, deployment_revision, candidate_id, activated_at
      FROM profile_candidate_activation_history
    `).get()).toEqual({
      profile_id: 'portable', deployment_revision: 4,
      candidate_id: candidateId, activated_at: 120,
    })
    expect(upgraded.rawMainHandle.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'profile_candidate_deletions'
    `).pluck().get()).toBe('profile_candidate_deletions')
    upgraded.close()
  })
})
