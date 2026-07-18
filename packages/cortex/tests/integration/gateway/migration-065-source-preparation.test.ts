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

describe('migration 065 source preparation lineage', () => {
  it('preserves inspection jobs and adds no content or placement columns', () => {
    dir = mkdtempSync(join(tmpdir(), 'source-preparation-migration-'))
    const path = join(dir, 'ownware.db')
    const old = new Database(path)
    runMigrationsSafely(old, path, MIGRATIONS.filter((migration) => migration.version <= 64))
    old.prepare(`
      INSERT INTO runtime_sources (
        source_id, workspace_id, profile_id, kind, label, classification,
        authority, audience_policy_ref, sensitivity_policy_ref,
        purpose_policy_ref, retention_policy_ref, freshness_policy_ref,
        revision, current_version_id, registration_state, inspection_state,
        preparation_state, access_state, freshness_state, conflict_state,
        deletion_state, created_at, updated_at
      ) VALUES (
        '11111111-1111-4111-8111-111111111111', 'workspace-a', 'mini', 'text',
        'Migrated text', 'internal', 'supporting_reference', 'audience.test',
        'sensitivity.test', 'purpose.test', 'retention.test', 'freshness.test',
        2, '22222222-2222-4222-8222-222222222222', 'registered', 'complete',
        'not_requested', 'available', 'fresh', 'none', 'active', 10, 20
      )
    `).run()
    old.prepare(`
      INSERT INTO source_versions (
        source_version_id, source_id, checksum, verified_media_type,
        byte_count, object_key, inspection_state, created_at
      ) VALUES (
        '22222222-2222-4222-8222-222222222222',
        '11111111-1111-4111-8111-111111111111', ?, 'text/plain', 4,
        'sources/11111111-1111-4111-8111-111111111111/versions/22222222-2222-4222-8222-222222222222/original',
        'complete', 20
      )
    `).run(`sha256:${'a'.repeat(64)}`)
    old.prepare(`
      INSERT INTO source_jobs (
        job_id, workspace_id, profile_id, source_id, source_version_id,
        operation, state, attempt, max_attempts, checkpoint, claim_token,
        claimed_by, lease_expires_at, retry_after, cancel_requested_at,
        outcome_code, created_at, updated_at, terminal_at
      ) VALUES (
        '33333333-3333-4333-8333-333333333333', 'workspace-a', 'mini',
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222', 'inspect_format', 'succeeded',
        1, 3, 4, NULL, NULL, NULL, NULL, NULL, 'inspection_complete', 30, 40, 40
      )
    `).run()
    old.close()

    const upgraded = new CortexDatabase(path)
    expect(upgraded.rawMainHandle.prepare(`
      SELECT operation, implementation_version, resource_id, state
      FROM source_jobs
    `).get()).toEqual({
      operation: 'inspect_format',
      implementation_version: 'inspect_format.v1',
      resource_id: null,
      state: 'succeeded',
    })
    expect(upgraded.rawMainHandle.prepare(`
      SELECT preparation_state FROM source_versions
      WHERE source_version_id = '22222222-2222-4222-8222-222222222222'
    `).get()).toEqual({ preparation_state: 'not_requested' })
    const resourceColumns = upgraded.rawMainHandle.prepare(
      'PRAGMA table_info(source_derived_resources)',
    ).all() as Array<{ name: string }>
    expect(resourceColumns.map((column) => column.name)).toEqual([
      'resource_id', 'job_id', 'workspace_id', 'profile_id', 'source_id',
      'source_version_id', 'kind', 'operation', 'implementation_version',
      'source_revision', 'source_checksum', 'resource_checksum', 'byte_start',
      'byte_end', 'byte_count', 'classification', 'authority',
      'audience_policy_ref', 'sensitivity_policy_ref', 'purpose_policy_ref',
      'retention_policy_ref', 'freshness_policy_ref', 'coverage', 'freshness',
      'created_at', 'stale_at',
    ])
    expect(resourceColumns.map((column) => column.name)).not.toEqual(
      expect.arrayContaining(['content', 'bytes', 'object_key', 'path', 'parser_output', 'error']),
    )
    expect(upgraded.rawMainHandle.pragma('user_version', { simple: true })).toBe(MIGRATIONS.at(-1)!.version)
    upgraded.close()
  })
})
