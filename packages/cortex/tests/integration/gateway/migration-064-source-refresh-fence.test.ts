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

describe('migration 064 source refresh fence', () => {
  it('captures safe legacy bases and closes sessions already stale at upgrade', () => {
    dir = mkdtempSync(join(tmpdir(), 'source-refresh-migration-'))
    const path = join(dir, 'ownware.db')
    const old = new Database(path)
    runMigrationsSafely(old, path, MIGRATIONS.filter((migration) => migration.version <= 63))
    old.prepare(`
      INSERT INTO runtime_sources (
        source_id, workspace_id, profile_id, kind, label, classification,
        authority, audience_policy_ref, sensitivity_policy_ref,
        purpose_policy_ref, retention_policy_ref, freshness_policy_ref,
        revision, current_version_id, registration_state, inspection_state,
        preparation_state, access_state, freshness_state, conflict_state,
        deletion_state, created_at, updated_at
      ) VALUES (
        '11111111-1111-4111-8111-111111111111', 'workspace-a', 'mini',
        'text', 'Migrated source', 'internal', 'supporting_reference',
        'audience.test', 'sensitivity.test', 'purpose.test', 'retention.test',
        'freshness.test', 3, '22222222-2222-4222-8222-222222222222',
        'registered', 'complete', 'ready', 'available', 'fresh', 'none',
        'active', 100, 300
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
        'complete', 150
      )
    `).run(`sha256:${'a'.repeat(64)}`)
    for (const fixture of [
      { id: '33333333-3333-4333-8333-333333333333', createdAt: 400 },
      { id: '44444444-4444-4444-8444-444444444444', createdAt: 200 },
    ]) {
      old.prepare(`
        INSERT INTO source_upload_sessions (
          upload_id, source_id, workspace_id, profile_id, principal_key, state,
          expected_bytes, expected_checksum, declared_media_type, filename,
          durable_offset, chunk_count, max_chunk_bytes, max_chunks,
          pending_version_id, completed_version_id, code,
          expires_at, created_at, updated_at
        ) VALUES (?, '11111111-1111-4111-8111-111111111111', 'workspace-a',
          'mini', 'delegated-test', 'open', 4, ?, 'text/plain', 'synthetic.txt',
          0, 0, 1048576, 64, NULL, NULL, NULL, ?, ?, ?)
      `).run(
        fixture.id,
        `sha256:${'b'.repeat(64)}`,
        fixture.createdAt + 900_000,
        fixture.createdAt,
        fixture.createdAt,
      )
    }
    old.close()

    const upgraded = new CortexDatabase(path)
    const columns = upgraded.rawMainHandle.prepare(
      'PRAGMA table_info(source_upload_sessions)',
    ).all() as Array<{ name: string }>
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'base_source_revision', 'base_current_version_id',
    ]))
    const rows = upgraded.rawMainHandle.prepare(`
      SELECT upload_id, state, code, base_source_revision, base_current_version_id
      FROM source_upload_sessions ORDER BY upload_id
    `).all()
    expect(rows).toEqual([
      {
        upload_id: '33333333-3333-4333-8333-333333333333',
        state: 'open',
        code: null,
        base_source_revision: 3,
        base_current_version_id: '22222222-2222-4222-8222-222222222222',
      },
      {
        upload_id: '44444444-4444-4444-8444-444444444444',
        state: 'failed',
        code: 'source_refresh_fence_unavailable',
        base_source_revision: 3,
        base_current_version_id: '22222222-2222-4222-8222-222222222222',
      },
    ])
    expect(upgraded.rawMainHandle.pragma('user_version', { simple: true })).toBe(MIGRATIONS.at(-1)!.version)
    upgraded.close()
  })
})
