import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CortexDatabase } from '../../../src/gateway/db/database.js'
import { auditMigrations, runMigrationsSafely } from '../../../src/gateway/db/migration-safety.js'
import { MIGRATIONS } from '../../../src/gateway/db/schema.js'

const SOURCE_ID = '11111111-1111-4111-8111-111111111111'
const VERSION_ID = '22222222-2222-4222-8222-222222222222'
const INSPECTION_JOB_ID = '33333333-3333-4333-8333-333333333333'
const PREPARATION_JOB_ID = '44444444-4444-4444-8444-444444444444'
const RESOURCE_ID = '55555555-5555-4555-8555-555555555555'
const DELETION_JOB_ID = '66666666-6666-4666-8666-666666666666'

let dir = ''

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

describe('migration 067 source deletion plans', () => {
  it('preserves v66 lineage and adds only closed deletion persistence', () => {
    dir = mkdtempSync(join(tmpdir(), 'source-deletion-migration-'))
    const path = join(dir, 'ownware.db')
    const old = new Database(path)
    old.pragma('foreign_keys = ON')
    runMigrationsSafely(old, path, MIGRATIONS.filter((migration) => migration.version <= 66))
    insertSourceFixtures(old)
    insertIdempotencyFixtures(old)
    expect(old.pragma('foreign_key_check')).toEqual([])
    old.close()

    const upgraded = new CortexDatabase(path)
    const db = upgraded.rawMainHandle

    expect(db.prepare(`
      SELECT job_id, source_version_id, operation, implementation_version,
        resource_id, state, outcome_code
      FROM source_jobs ORDER BY job_id
    `).all()).toEqual([
      {
        job_id: INSPECTION_JOB_ID,
        source_version_id: VERSION_ID,
        operation: 'inspect_format',
        implementation_version: 'inspect_format.v1',
        resource_id: null,
        state: 'succeeded',
        outcome_code: 'inspection_complete',
      },
      {
        job_id: PREPARATION_JOB_ID,
        source_version_id: VERSION_ID,
        operation: 'extract_text',
        implementation_version: 'text_extraction.v1',
        resource_id: RESOURCE_ID,
        state: 'succeeded',
        outcome_code: 'preparation_complete',
      },
    ])
    expect(db.prepare(`
      SELECT resource_id, job_id, source_id, source_version_id,
        operation, implementation_version, freshness
      FROM source_derived_resources
    `).get()).toEqual({
      resource_id: RESOURCE_ID,
      job_id: PREPARATION_JOB_ID,
      source_id: SOURCE_ID,
      source_version_id: VERSION_ID,
      operation: 'extract_text',
      implementation_version: 'text_extraction.v1',
      freshness: 'current',
    })

    const jobColumns = db.prepare('PRAGMA table_info(source_jobs)').all() as Array<{
      name: string
      notnull: number
    }>
    expect(jobColumns.map((column) => column.name)).toEqual([
      'job_id', 'workspace_id', 'profile_id', 'source_id', 'source_version_id',
      'operation', 'implementation_version', 'source_revision', 'resource_id',
      'state', 'attempt', 'max_attempts', 'checkpoint', 'claim_token', 'claimed_by',
      'lease_expires_at', 'retry_after', 'cancel_requested_at', 'outcome_code',
      'created_at', 'updated_at', 'terminal_at',
    ])
    expect(jobColumns.find((column) => column.name === 'source_version_id')?.notnull).toBe(0)
    expect(tableColumns(db, 'source_deletion_plans')).toEqual([
      'job_id', 'workspace_id', 'profile_id', 'source_id', 'source_revision',
      'inventory_state', 'inventory_completed_at', 'created_at', 'updated_at',
    ])
    expect(tableColumns(db, 'source_deletion_inventory')).toEqual([
      'job_id', 'artifact_kind', 'artifact_id', 'state', 'created_at', 'updated_at',
      'terminal_at',
    ])
    expect(tableColumns(db, 'source_deletion_inventory')).not.toEqual(expect.arrayContaining([
      'path', 'object_key', 'content', 'bytes', 'checksum', 'source_checksum',
      'resource_checksum', 'result_json',
    ]))

    expect(tableColumns(db, 'run_idempotency')).toEqual([
      'id', 'principal_key', 'operation', 'idempotency_key', 'request_salt',
      'request_digest', 'state', 'lease_owner', 'status_code', 'result_json',
      'created_at', 'updated_at', 'expires_at', 'run_id', 'source_id',
      'source_mutation_kind',
    ])
    const idempotencySourceColumn = db.prepare('PRAGMA table_info(run_idempotency)')
      .all() as Array<{ name: string; notnull: number }>
    expect(idempotencySourceColumn.find((column) => column.name === 'source_id')?.notnull)
      .toBe(0)
    expect(db.prepare('PRAGMA foreign_key_list(run_idempotency)').all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: 'runtime_sources', from: 'source_id', to: 'source_id',
        }),
      ]),
    )
    expect(db.prepare(`
      SELECT id, source_id FROM run_idempotency ORDER BY id
    `).all()).toEqual([
      { id: 'allow-job', source_id: SOURCE_ID },
      { id: 'allow-preparation', source_id: SOURCE_ID },
      { id: 'allow-register', source_id: SOURCE_ID },
      { id: 'allow-upload', source_id: SOURCE_ID },
      { id: 'invalid-missing', source_id: null },
      { id: 'invalid-type', source_id: null },
      { id: 'unrelated', source_id: null },
    ])

    const indexSql = db.prepare(`
      SELECT name, sql FROM sqlite_master
      WHERE type = 'index' AND name IN (
        'idx_run_idempotency_source',
        'idx_source_jobs_version_operation',
        'idx_source_jobs_source_deletion'
      ) ORDER BY name
    `).all()
    expect(indexSql).toEqual([
      {
        name: 'idx_run_idempotency_source',
        sql: 'CREATE INDEX idx_run_idempotency_source\n        ON run_idempotency(source_id) WHERE source_id IS NOT NULL',
      },
      {
        name: 'idx_source_jobs_source_deletion',
        sql: "CREATE UNIQUE INDEX idx_source_jobs_source_deletion\n        ON source_jobs(source_id) WHERE operation = 'delete_source'",
      },
      {
        name: 'idx_source_jobs_version_operation',
        sql: 'CREATE UNIQUE INDEX idx_source_jobs_version_operation\n        ON source_jobs(source_version_id, operation, implementation_version)\n        WHERE source_version_id IS NOT NULL',
      },
    ])

    expect(() => insertJob(db, {
      jobId: DELETION_JOB_ID,
      sourceVersionId: null,
      operation: 'delete_source',
      implementationVersion: 'source_deletion.v1',
      resourceId: null,
    })).not.toThrow()
    expect(() => insertJob(db, {
      jobId: '77777777-7777-4777-8777-777777777777',
      sourceVersionId: null,
      operation: 'delete_source',
      implementationVersion: 'source_deletion.v1',
      resourceId: null,
    })).toThrow()
    expect(() => insertJob(db, {
      jobId: '88888888-8888-4888-8888-888888888888',
      sourceVersionId: VERSION_ID,
      operation: 'delete_source',
      implementationVersion: 'source_deletion.v1',
      resourceId: null,
    })).toThrow()
    expect(() => insertJob(db, {
      jobId: '99999999-9999-4999-8999-999999999999',
      sourceVersionId: null,
      operation: 'inspect_format',
      implementationVersion: 'inspect_format.v1',
      resourceId: null,
    })).toThrow()
    expect(() => insertJob(db, {
      jobId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      sourceVersionId: VERSION_ID,
      operation: 'inspect_format',
      implementationVersion: 'text_extraction.v1',
      resourceId: null,
    })).toThrow()
    expect(() => insertJob(db, {
      jobId: 'abababab-abab-4bab-8bab-abababababab',
      sourceVersionId: VERSION_ID,
      operation: 'inspect_format',
      implementationVersion: 'inspect_format.v1',
      resourceId: null,
    })).toThrow()
    expect(() => insertJob(db, {
      jobId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      sourceVersionId: VERSION_ID,
      operation: 'inspect_format',
      implementationVersion: 'inspect_format.v1',
      resourceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    })).toThrow()
    expect(() => insertJob(db, {
      jobId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      sourceVersionId: VERSION_ID,
      operation: 'extract_text',
      implementationVersion: 'text_extraction.v1',
      resourceId: null,
    })).toThrow()

    db.prepare(`
      INSERT INTO source_deletion_plans (
        job_id, workspace_id, profile_id, source_id, source_revision,
        inventory_state, inventory_completed_at, created_at, updated_at
      ) VALUES (?, 'workspace-a', 'mini', ?, 3, 'pending', NULL, 300, 300)
    `).run(DELETION_JOB_ID, SOURCE_ID)
    db.prepare(`
      INSERT INTO source_deletion_inventory (
        job_id, artifact_kind, artifact_id, state, created_at, updated_at, terminal_at
      ) VALUES (?, 'immutable_original', ?, 'pending', 300, 300, NULL)
    `).run(DELETION_JOB_ID, VERSION_ID)
    expect(() => db.prepare(`
      INSERT INTO source_deletion_inventory (
        job_id, artifact_kind, artifact_id, state, created_at, updated_at, terminal_at
      ) VALUES (?, 'host_path', ?, 'pending', 300, 300, NULL)
    `).run(DELETION_JOB_ID, RESOURCE_ID)).toThrow()

    const derivedForeignKeys = db.prepare(
      'PRAGMA foreign_key_list(source_derived_resources)',
    ).all() as Array<{ table: string }>
    expect(derivedForeignKeys.map((foreignKey) => foreignKey.table)).toContain('source_jobs')
    expect(derivedForeignKeys.map((foreignKey) => foreignKey.table)).not.toContain(
      'source_jobs_v65',
    )
    expect(db.pragma('foreign_key_check')).toEqual([])
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok')
    expect(db.prepare(`
      SELECT version, name FROM _migrations WHERE version = 67
    `).get()).toEqual({ version: 67, name: '067_source_deletion_plans' })
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.at(-1)!.version)
    expect(MIGRATIONS.find((migration) => migration.version === 67)?.destructive?.reason)
      .toContain('copies every row before dropping the old tables')
    expect(auditMigrations(MIGRATIONS)).toEqual([])
    upgraded.close()
  })
})

function tableColumns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .map((column) => column.name)
}

function insertSourceFixtures(db: Database.Database): void {
  db.prepare(`
    INSERT INTO runtime_sources (
      source_id, workspace_id, profile_id, kind, label, classification,
      authority, audience_policy_ref, sensitivity_policy_ref, purpose_policy_ref,
      retention_policy_ref, freshness_policy_ref, revision, current_version_id,
      registration_state, inspection_state, preparation_state, access_state,
      freshness_state, conflict_state, deletion_state, created_at, updated_at
    ) VALUES (
      ?, 'workspace-a', 'mini', 'text', 'Migration source', 'internal',
      'supporting_reference', 'audience.test', 'sensitivity.test', 'purpose.test',
      'retention.test', 'freshness.test', 3, ?, 'registered', 'complete', 'ready',
      'available', 'fresh', 'none', 'active', 100, 200
    )
  `).run(SOURCE_ID, VERSION_ID)
  db.prepare(`
    INSERT INTO source_versions (
      source_version_id, source_id, checksum, verified_media_type, byte_count,
      object_key, inspection_state, preparation_state, created_at
    ) VALUES (?, ?, ?, 'text/plain', 4, ?, 'complete', 'ready', 120)
  `).run(
    VERSION_ID,
    SOURCE_ID,
    `sha256:${'a'.repeat(64)}`,
    `sources/${SOURCE_ID}/versions/${VERSION_ID}/original`,
  )
  insertJob(db, {
    jobId: INSPECTION_JOB_ID,
    sourceVersionId: VERSION_ID,
    operation: 'inspect_format',
    implementationVersion: 'inspect_format.v1',
    resourceId: null,
    terminal: true,
  })
  insertJob(db, {
    jobId: PREPARATION_JOB_ID,
    sourceVersionId: VERSION_ID,
    operation: 'extract_text',
    implementationVersion: 'text_extraction.v1',
    resourceId: RESOURCE_ID,
    terminal: true,
  })
  db.prepare(`
    INSERT INTO source_derived_resources (
      resource_id, job_id, workspace_id, profile_id, source_id, source_version_id,
      kind, operation, implementation_version, source_revision, source_checksum,
      resource_checksum, byte_start, byte_end, byte_count, classification,
      authority, audience_policy_ref, sensitivity_policy_ref, purpose_policy_ref,
      retention_policy_ref, freshness_policy_ref, coverage, freshness, created_at,
      stale_at
    ) VALUES (
      ?, ?, 'workspace-a', 'mini', ?, ?, 'text_extraction', 'extract_text',
      'text_extraction.v1', 3, ?, ?, 0, 4, 4, 'internal', 'supporting_reference',
      'audience.test', 'sensitivity.test', 'purpose.test', 'retention.test',
      'freshness.test', 'complete', 'current', 180, NULL
    )
  `).run(
    RESOURCE_ID,
    PREPARATION_JOB_ID,
    SOURCE_ID,
    VERSION_ID,
    `sha256:${'a'.repeat(64)}`,
    `sha256:${'b'.repeat(64)}`,
  )
}

function insertJob(
  db: Database.Database,
  input: {
    jobId: string
    sourceVersionId: string | null
    operation: string
    implementationVersion: string
    resourceId: string | null
    terminal?: boolean
  },
): void {
  db.prepare(`
    INSERT INTO source_jobs (
      job_id, workspace_id, profile_id, source_id, source_version_id, operation,
      implementation_version, source_revision, resource_id, state, attempt,
      max_attempts, checkpoint, claim_token, claimed_by, lease_expires_at,
      retry_after, cancel_requested_at, outcome_code, created_at, updated_at,
      terminal_at
    ) VALUES (
      ?, 'workspace-a', 'mini', ?, ?, ?, ?, 3, ?, ?, ?, 3, ?,
      NULL, NULL, NULL, NULL, NULL, ?, 150, 200, ?
    )
  `).run(
    input.jobId,
    SOURCE_ID,
    input.sourceVersionId,
    input.operation,
    input.implementationVersion,
    input.resourceId,
    input.terminal ? 'succeeded' : 'queued',
    input.terminal ? 1 : 0,
    input.terminal ? 4 : 0,
    input.terminal
      ? input.operation === 'inspect_format' ? 'inspection_complete' : 'preparation_complete'
      : null,
    input.terminal ? 200 : null,
  )
}

function insertIdempotencyFixtures(db: Database.Database): void {
  const insert = db.prepare(`
    INSERT INTO run_idempotency (
      id, principal_key, operation, idempotency_key, request_salt, request_digest,
      state, lease_owner, status_code, result_json, created_at, updated_at,
      expires_at, run_id
    ) VALUES (?, 'delegate', ?, ?, 'salt', 'digest', 'completed', 'owner', 202, ?,
      100, 200, 1000, NULL)
  `)
  const fixtures = [
    ['allow-register', 'sources.register', '10000000-0000-4000-8000-000000000001',
      { sourceId: SOURCE_ID }],
    ['allow-upload', 'source_uploads.create', '10000000-0000-4000-8000-000000000002',
      { uploadId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', sourceId: SOURCE_ID }],
    ['allow-job', 'source_jobs.create', '10000000-0000-4000-8000-000000000003',
      { jobId: INSPECTION_JOB_ID, sourceId: SOURCE_ID }],
    ['allow-preparation', 'source_preparations.create',
      '10000000-0000-4000-8000-000000000004',
      { jobId: PREPARATION_JOB_ID, sourceId: SOURCE_ID }],
    ['invalid-missing', 'sources.register', '10000000-0000-4000-8000-000000000005',
      { sourceId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }],
    ['invalid-type', 'source_jobs.create', '10000000-0000-4000-8000-000000000006',
      { jobId: INSPECTION_JOB_ID, sourceId: 42 }],
    ['unrelated', 'runs.start', '10000000-0000-4000-8000-000000000007',
      { sourceId: SOURCE_ID }],
  ] as const
  for (const [id, operation, key, result] of fixtures) {
    insert.run(id, operation, key, JSON.stringify(result))
  }
}
