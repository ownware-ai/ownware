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

describe('migration 066 source quota reservations', () => {
  it('transfers only verified completed upload reservations', () => {
    dir = mkdtempSync(join(tmpdir(), 'source-quota-migration-'))
    const path = join(dir, 'ownware.db')
    const old = new Database(path)
    runMigrationsSafely(old, path, MIGRATIONS.filter((migration) => migration.version <= 65))
    old.prepare(`
      INSERT INTO runtime_sources (
        source_id, workspace_id, profile_id, kind, label, classification,
        authority, audience_policy_ref, sensitivity_policy_ref,
        purpose_policy_ref, retention_policy_ref, freshness_policy_ref,
        revision, current_version_id, registration_state, inspection_state,
        preparation_state, access_state, freshness_state, conflict_state,
        deletion_state, created_at, updated_at
      ) VALUES (
        '11111111-1111-4111-8111-111111111111', 'workspace-a', 'mini', 'file',
        'Quota source', 'internal', 'supporting_reference', 'audience.test',
        'sensitivity.test', 'purpose.test', 'retention.test', 'freshness.test',
        2, '22222222-2222-4222-8222-222222222222', 'registered', 'not_started',
        'not_requested', 'available', 'fresh', 'none', 'active', 10, 20
      )
    `).run()
    const checksum = `sha256:${'a'.repeat(64)}`
    old.prepare(`
      INSERT INTO source_versions (
        source_version_id, source_id, checksum, verified_media_type,
        byte_count, object_key, inspection_state, preparation_state, created_at
      ) VALUES (
        '22222222-2222-4222-8222-222222222222',
        '11111111-1111-4111-8111-111111111111', ?, 'text/plain', 4,
        'sources/11111111-1111-4111-8111-111111111111/versions/22222222-2222-4222-8222-222222222222/original',
        'not_started', 'not_requested', 20
      )
    `).run(checksum)
    const insert = old.prepare(`
      INSERT INTO source_upload_sessions (
        upload_id, source_id, workspace_id, profile_id, principal_key, state,
        expected_bytes, expected_checksum, declared_media_type, filename,
        durable_offset, chunk_count, max_chunk_bytes, max_chunks,
        pending_version_id, completed_version_id, code, expires_at,
        created_at, updated_at, base_source_revision, base_current_version_id
      ) VALUES (
        @uploadId, '11111111-1111-4111-8111-111111111111', 'workspace-a', 'mini',
        'delegate', @state, @expectedBytes, @expectedChecksum, 'text/plain',
        'synthetic.txt', @expectedBytes, 1, 1048576, 64,
        @pendingVersionId, @completedVersionId, @code, 1000, 100, 200, 1, NULL
      )
    `)
    insert.run({
      uploadId: '33333333-3333-4333-8333-333333333333',
      state: 'completed', expectedBytes: 4, expectedChecksum: checksum,
      pendingVersionId: '22222222-2222-4222-8222-222222222222',
      completedVersionId: '22222222-2222-4222-8222-222222222222', code: null,
    })
    insert.run({
      uploadId: '44444444-4444-4444-8444-444444444444',
      state: 'completed', expectedBytes: 4,
      expectedChecksum: `sha256:${'b'.repeat(64)}`,
      pendingVersionId: '22222222-2222-4222-8222-222222222222',
      completedVersionId: '22222222-2222-4222-8222-222222222222', code: null,
    })
    insert.run({
      uploadId: '55555555-5555-4555-8555-555555555555',
      state: 'failed', expectedBytes: 3, expectedChecksum: `sha256:${'c'.repeat(64)}`,
      pendingVersionId: null, completedVersionId: null, code: 'verification_failed',
    })
    old.close()

    const upgraded = new CortexDatabase(path)
    expect(upgraded.rawMainHandle.prepare(`
      SELECT upload_id, byte_reservation_released_at
      FROM source_upload_sessions ORDER BY upload_id
    `).all()).toEqual([
      {
        upload_id: '33333333-3333-4333-8333-333333333333',
        byte_reservation_released_at: 200,
      },
      {
        upload_id: '44444444-4444-4444-8444-444444444444',
        byte_reservation_released_at: null,
      },
      {
        upload_id: '55555555-5555-4555-8555-555555555555',
        byte_reservation_released_at: null,
      },
    ])
    expect(upgraded.rawMainHandle.pragma('user_version', { simple: true })).toBe(MIGRATIONS.at(-1)!.version)
    upgraded.close()
  })
})
