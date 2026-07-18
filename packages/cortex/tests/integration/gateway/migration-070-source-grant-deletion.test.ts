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

describe('migration 070 source grant deletion coupling', () => {
  it('preserves existing inventory and adds only closed grant deletion metadata', () => {
    dir = mkdtempSync(join(tmpdir(), 'source-grant-deletion-migration-'))
    const path = join(dir, 'ownware.db')
    const old = new Database(path)
    old.pragma('foreign_keys = ON')
    runMigrationsSafely(old, path, MIGRATIONS.filter((migration) => migration.version <= 69))
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
        ?, 'workspace-a', 'mini', 'file', 'Migration source', 'internal',
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
    old.prepare(`
      INSERT INTO source_deletion_tombstones (
        job_id, workspace_id, profile_id, source_id, state, source_revision,
        immutable_originals, upload_staging, placed_candidates, derived_resources,
        data_views, search_indexes, source_jobs, idempotency_replays,
        retrieval_cache_entries, created_at, terminal_at
      ) VALUES (
        '44444444-4444-4444-8444-444444444444', 'workspace-a', 'mini',
        '55555555-5555-4555-8555-555555555555', 'deleted', 2,
        1, 0, 0, 0, 0, 0, 0, 0, 0, 10, 20
      )
    `).run()
    old.close()

    const upgraded = new CortexDatabase(path)
    const db = upgraded.rawMainHandle
    expect(db.prepare(`
      SELECT artifact_kind, artifact_id, state FROM source_deletion_inventory
      WHERE job_id = ?
    `).get(jobId)).toEqual({
      artifact_kind: 'retrieval_cache',
      artifact_id: '33333333-3333-4333-8333-333333333333',
      state: 'pending',
    })
    expect(() => db.prepare(`
      INSERT INTO source_deletion_inventory (
        job_id, artifact_kind, artifact_id, state, created_at, updated_at, terminal_at
      ) VALUES (?, 'access_grant_revocation', ?, 'pending', 20, 20, NULL)
    `).run(jobId, '66666666-6666-4666-8666-666666666666')).not.toThrow()
    expect(() => db.prepare(`
      INSERT INTO source_deletion_inventory (
        job_id, artifact_kind, artifact_id, state, created_at, updated_at, terminal_at
      ) VALUES (?, 'grant_mutation_replay', ?, 'pending', 20, 20, NULL)
    `).run(jobId, '77777777-7777-4777-8777-777777777777')).not.toThrow()
    expect(() => db.prepare(`
      INSERT INTO source_deletion_inventory (
        job_id, artifact_kind, artifact_id, state, created_at, updated_at, terminal_at
      ) VALUES (?, 'grant_secret', ?, 'pending', 20, 20, NULL)
    `).run(jobId, '88888888-8888-4888-8888-888888888888')).toThrow()
    expect(db.prepare(`
      SELECT access_grant_revocations, grant_mutation_replays
      FROM source_deletion_tombstones
      WHERE job_id = '44444444-4444-4444-8444-444444444444'
    `).get()).toEqual({ access_grant_revocations: 0, grant_mutation_replays: 0 })
    expect(tableColumns(db, 'run_idempotency')).toContain('source_mutation_kind')
    expect(db.prepare(`
      SELECT version, name FROM _migrations WHERE version = 70
    `).get()).toEqual({ version: 70, name: '070_source_grant_deletion_coupling' })
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.at(-1)!.version)
    expect(db.pragma('foreign_key_check')).toEqual([])
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok')
    expect(auditMigrations(MIGRATIONS)).toEqual([])
    upgraded.close()
  })

  it('creates the closed grant artifact and source-mutation constraints on a fresh database', () => {
    dir = mkdtempSync(join(tmpdir(), 'source-grant-deletion-fresh-'))
    const database = new CortexDatabase(join(dir, 'ownware.db'))
    const db = database.rawMainHandle
    const inventorySql = (db.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'table' AND name = 'source_deletion_inventory'
    `).get() as { sql: string }).sql
    expect(inventorySql).toContain("'access_grant_revocation'")
    expect(inventorySql).toContain("'grant_mutation_replay'")
    expect(tableColumns(db, 'source_deletion_tombstones')).toEqual(expect.arrayContaining([
      'access_grant_revocations', 'grant_mutation_replays',
    ]))
    const mutationColumn = (db.prepare('PRAGMA table_info(run_idempotency)').all() as Array<{
      name: string
    }>).find((column) => column.name === 'source_mutation_kind')
    expect(mutationColumn).toBeDefined()
    expect(db.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'index' AND name = 'idx_run_idempotency_source_mutation'
    `).get()).toBeDefined()
    expect(() => db.prepare(`
      INSERT INTO run_idempotency (
        id, principal_key, operation, idempotency_key, request_salt,
        request_digest, state, lease_owner, status_code, result_json,
        created_at, updated_at, expires_at, source_mutation_kind
      ) VALUES (
        '99999999-9999-4999-8999-999999999999', 'owner', 'private.mutation',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'salt', 'digest', 'in_progress',
        'lease', NULL, NULL, 1, 1, 2, 'access_grant'
      )
    `).run()).toThrow()
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.at(-1)!.version)
    expect(db.pragma('foreign_key_check')).toEqual([])
    database.close()
  })
})

function tableColumns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .map((column) => column.name)
}
