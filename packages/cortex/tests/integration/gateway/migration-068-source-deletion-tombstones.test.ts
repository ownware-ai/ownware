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

describe('migration 068 source deletion tombstones', () => {
  it('additively creates one closed content-free tombstone store', () => {
    dir = mkdtempSync(join(tmpdir(), 'source-deletion-tombstone-migration-'))
    const path = join(dir, 'ownware.db')
    const old = new Database(path)
    old.pragma('foreign_keys = ON')
    runMigrationsSafely(old, path, MIGRATIONS.filter((migration) => migration.version <= 67))
    const sourceId = '11111111-1111-4111-8111-111111111111'
    const jobId = '22222222-2222-4222-8222-222222222222'
    old.prepare(`
      INSERT INTO runtime_sources (
        source_id, workspace_id, profile_id, kind, label, classification,
        authority, audience_policy_ref, sensitivity_policy_ref, purpose_policy_ref,
        retention_policy_ref, freshness_policy_ref, revision, current_version_id,
        registration_state, inspection_state, preparation_state, access_state,
        freshness_state, conflict_state, deletion_state, created_at, updated_at
      ) VALUES (
        ?, 'workspace-a', 'mini', 'file', 'Migration deletion source', 'internal',
        'supporting_reference', 'audience.test', 'sensitivity.test', 'purpose.test',
        'retention.test', 'freshness.test', 2, NULL, 'pending', 'not_started',
        'not_requested', 'available', 'unknown', 'none', 'frozen', 10, 20
      )
    `).run(sourceId)
    old.prepare(`
      INSERT INTO source_jobs (
        job_id, workspace_id, profile_id, source_id, source_version_id,
        operation, implementation_version, source_revision, resource_id,
        state, attempt, max_attempts, checkpoint, claim_token, claimed_by,
        lease_expires_at, retry_after, cancel_requested_at, outcome_code,
        created_at, updated_at, terminal_at
      ) VALUES (
        ?, 'workspace-a', 'mini', ?, NULL, 'delete_source', 'source_deletion.v1',
        2, NULL, 'queued', 0, 3, 0, NULL, NULL, NULL, NULL, NULL, NULL,
        20, 20, NULL
      )
    `).run(jobId, sourceId)
    old.prepare(`
      INSERT INTO source_deletion_plans (
        job_id, workspace_id, profile_id, source_id, source_revision,
        inventory_state, inventory_completed_at, created_at, updated_at
      ) VALUES (?, 'workspace-a', 'mini', ?, 2, 'complete', 20, 20, 20)
    `).run(jobId, sourceId)
    old.prepare(`
      INSERT INTO source_deletion_inventory (
        job_id, artifact_kind, artifact_id, state, created_at, updated_at, terminal_at
      ) VALUES (?, 'retrieval_cache', '33333333-3333-4333-8333-333333333333',
        'pending', 20, 20, NULL)
    `).run(jobId)
    old.close()

    const upgraded = new CortexDatabase(path)
    const db = upgraded.rawMainHandle
    const columns = (db.prepare('PRAGMA table_info(source_deletion_tombstones)').all() as Array<{
      name: string
    }>).map((column) => column.name)
    expect(columns).toEqual([
      'job_id', 'workspace_id', 'profile_id', 'source_id', 'state', 'source_revision',
      'immutable_originals', 'upload_staging', 'placed_candidates',
      'derived_resources', 'data_views', 'search_indexes', 'source_jobs',
      'idempotency_replays', 'retrieval_cache_entries', 'created_at', 'terminal_at',
      'access_grant_revocations', 'grant_mutation_replays',
    ])
    expect(columns).not.toEqual(expect.arrayContaining([
      'label', 'classification', 'authority', 'policy', 'path', 'object_key',
      'content', 'bytes', 'checksum', 'result_json', 'claim_token',
    ]))
    expect(db.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'index' AND name = 'idx_source_deletion_tombstones_scope'
    `).get()).toEqual({
      sql: 'CREATE INDEX idx_source_deletion_tombstones_scope\n        ON source_deletion_tombstones(workspace_id, profile_id, source_id)',
    })
    expect(db.prepare(`
      SELECT version, name FROM _migrations WHERE version = 68
    `).get()).toEqual({ version: 68, name: '068_source_deletion_tombstones' })
    expect(db.prepare(`
      SELECT p.job_id, p.source_id, p.inventory_state, j.state
      FROM source_deletion_plans p JOIN source_jobs j ON j.job_id = p.job_id
    `).get()).toEqual({
      job_id: jobId,
      source_id: sourceId,
      inventory_state: 'complete',
      state: 'queued',
    })
    expect(db.prepare(`
      SELECT artifact_kind, artifact_id, state FROM source_deletion_inventory
      WHERE job_id = ?
    `).get(jobId)).toEqual({
      artifact_kind: 'retrieval_cache',
      artifact_id: '33333333-3333-4333-8333-333333333333',
      state: 'pending',
    })
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.at(-1)!.version)
    expect(db.pragma('foreign_key_check')).toEqual([])
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok')
    expect(auditMigrations(MIGRATIONS)).toEqual([])
    upgraded.close()
  })
})
