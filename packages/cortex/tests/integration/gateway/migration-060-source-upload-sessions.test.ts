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

describe('migrations 060-062 source upload and immutable versions', () => {
  it('adds bounded scoped control, chunk evidence and private version placement metadata', () => {
    dir = mkdtempSync(join(tmpdir(), 'source-upload-migration-'))
    const path = join(dir, 'ownware.db')
    const old = new Database(path)
    runMigrationsSafely(old, path, MIGRATIONS.filter((migration) => migration.version <= 59))
    old.close()

    const upgraded = new CortexDatabase(path)
    const columns = upgraded.rawMainHandle.prepare('PRAGMA table_info(source_upload_sessions)')
      .all() as Array<{ name: string }>
    expect(columns.map((column) => column.name)).toEqual([
      'upload_id', 'source_id', 'workspace_id', 'profile_id', 'principal_key',
      'state', 'expected_bytes', 'expected_checksum', 'declared_media_type',
      'filename', 'durable_offset', 'chunk_count', 'max_chunk_bytes',
      'max_chunks', 'pending_version_id', 'completed_version_id', 'code',
      'expires_at', 'created_at', 'updated_at', 'base_source_revision',
      'base_current_version_id', 'byte_reservation_released_at',
    ])
    expect(columns.map((column) => column.name)).not.toEqual(
      expect.arrayContaining(['path', 'url', 'content', 'bytes', 'token', 'storage_locator']),
    )
    const chunkColumns = upgraded.rawMainHandle.prepare('PRAGMA table_info(source_upload_chunks)')
      .all() as Array<{ name: string }>
    expect(chunkColumns.map((column) => column.name)).toEqual([
      'upload_id', 'chunk_index', 'start_offset', 'byte_count', 'checksum', 'accepted_at',
    ])
    const versionColumns = upgraded.rawMainHandle.prepare('PRAGMA table_info(source_versions)')
      .all() as Array<{ name: string }>
    expect(versionColumns.map((column) => column.name)).toEqual([
      'source_version_id', 'source_id', 'checksum', 'verified_media_type',
      'byte_count', 'object_key', 'inspection_state', 'created_at',
      'preparation_state',
    ])
    expect(upgraded.rawMainHandle.pragma('user_version', { simple: true }))
      .toBe(MIGRATIONS.at(-1)!.version)
    upgraded.close()
  })
})
