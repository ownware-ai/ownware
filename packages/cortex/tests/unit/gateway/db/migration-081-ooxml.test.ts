import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MIGRATIONS } from '../../../../src/gateway/db/schema.js'
import { runMigrationsSafely } from '../../../../src/gateway/db/migration-safety.js'
import { SourceStore } from '../../../../src/gateway/source-store.js'

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const CHECKSUM = `sha256:${'a'.repeat(64)}`
const VERSION_ID = '11111111-1111-4111-8111-111111111111'
const JOB_ID = '22222222-2222-4222-8222-222222222222'
const UPLOAD_ID = '33333333-3333-4333-8333-333333333333'

/**
 * Migration 081 rebuilds two foreign-key PARENT tables to widen their
 * media-type CHECKs (SQLite cannot widen a CHECK in place). This proves the
 * property the destructive/disableForeignKeys acknowledgements claim: every
 * pre-existing row survives, every child row still references its parent,
 * and only then do the new OOXML types become insertable.
 */
describe('migration 081 — OOXML media types', () => {
  let dir: string
  let dbPath: string
  let db: Database.Database

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cortex-mig081-'))
    dbPath = join(dir, 'ownware.db')
    db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('rebuilds both parent tables with rows and child references intact', () => {
    // A database exactly as migration 080 left it, with real rows in both
    // rebuilt tables AND in children that reference them.
    runMigrationsSafely(db, dbPath, MIGRATIONS.filter((m) => m.version <= 80))
    const { sourceId } = new SourceStore(db).create({
      workspaceId: 'workspace-a',
      profileId: 'mini',
      kind: 'file',
      label: 'Pre-migration source',
      classification: 'internal',
      authority: 'supporting_reference',
      audiencePolicyRef: 'audience.test',
      sensitivityPolicyRef: 'sensitivity.test',
      purposePolicyRef: 'purpose.test',
      retentionPolicyRef: 'retention.test',
      freshnessPolicyRef: 'freshness.test',
    }, 10)
    db.prepare(`
      INSERT INTO source_versions (
        source_version_id, source_id, checksum, verified_media_type,
        byte_count, object_key, inspection_state, created_at
      ) VALUES (?, ?, ?, 'application/pdf', 5, ?, 'complete', 20)
    `).run(VERSION_ID, sourceId, CHECKSUM, `sources/${sourceId}/versions/${VERSION_ID}/original`)
    db.prepare(`
      INSERT INTO source_jobs (
        job_id, workspace_id, profile_id, source_id, source_version_id,
        operation, implementation_version, source_revision, state,
        checkpoint, outcome_code, created_at, updated_at, terminal_at
      ) VALUES (?, 'workspace-a', 'mini', ?, ?, 'inspect_format', 'inspect_format.v1', 1,
        'succeeded', 4, 'inspection_complete', 21, 22, 22)
    `).run(JOB_ID, sourceId, VERSION_ID)
    db.prepare(`
      INSERT INTO source_upload_sessions (
        upload_id, source_id, workspace_id, profile_id, principal_key, state,
        expected_bytes, expected_checksum, declared_media_type, filename,
        completed_version_id, expires_at, created_at, updated_at
      ) VALUES (?, ?, 'workspace-a', 'mini', 'principal-a', 'completed',
        5, ?, 'application/pdf', 'before.pdf', ?, 100, 30, 31)
    `).run(UPLOAD_ID, sourceId, CHECKSUM, VERSION_ID)
    db.prepare(`
      INSERT INTO source_upload_chunks (
        upload_id, chunk_index, start_offset, byte_count, checksum, accepted_at
      ) VALUES (?, 0, 0, 5, ?, 30)
    `).run(UPLOAD_ID, CHECKSUM)

    // The rebuild under test.
    runMigrationsSafely(db, dbPath, MIGRATIONS)

    // Every pre-existing row survived, and every child still points at a
    // live parent — the property the acknowledgements claim.
    expect(db.prepare('SELECT COUNT(*) AS n FROM source_versions').get()).toEqual({ n: 1 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM source_jobs').get()).toEqual({ n: 1 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM source_upload_sessions').get()).toEqual({ n: 1 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM source_upload_chunks').get()).toEqual({ n: 1 })
    expect(db.pragma('foreign_key_check')).toEqual([])

    // Children reference the rebuilt tables by NAME, not a renamed ghost.
    const chunkSql = String(
      (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'source_upload_chunks'").get() as {
        sql: string
      }).sql,
    )
    expect(chunkSql).toContain('source_upload_sessions')
    expect(chunkSql).not.toContain('_new')

    // The widened CHECK admits the OOXML types…
    db.prepare(`
      INSERT INTO source_versions (
        source_version_id, source_id, checksum, verified_media_type,
        byte_count, object_key, inspection_state, created_at
      ) VALUES ('44444444-4444-4444-8444-444444444444', ?, ?, ?, 7, ?, 'not_started', 40)
    `).run(sourceId, `sha256:${'b'.repeat(64)}`, DOCX, `sources/${sourceId}/versions/x/original`)
    // …and still refuses a type nobody verified.
    expect(() =>
      db.prepare(`
        INSERT INTO source_versions (
          source_version_id, source_id, checksum, verified_media_type,
          byte_count, object_key, inspection_state, created_at
        ) VALUES ('55555555-5555-4555-8555-555555555555', ?, ?, 'application/zip', 7, ?, 'not_started', 41)
      `).run(sourceId, `sha256:${'c'.repeat(64)}`, `sources/${sourceId}/versions/y/original`),
    ).toThrow(/CHECK/)
  })
})
