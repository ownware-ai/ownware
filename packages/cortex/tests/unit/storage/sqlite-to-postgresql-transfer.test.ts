import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { Client } from 'pg'
import { describe, expect, it } from 'vitest'
import { runMigrationsSafely } from '../../../src/gateway/db/migration-safety.js'
import { MIGRATIONS } from '../../../src/gateway/db/schema.js'
import {
  PostgreSqlStorageAdapter,
  type PostgreSqlRepositoryFactories,
} from '../../../src/storage/postgresql-adapter.js'
import { canonicalPostgreSqlTransferSnapshot } from '../../../src/storage/postgresql-canonical-snapshot.js'
import { validateStoragePlan, type ValidatedPostgreSqlPlan } from '../../../src/storage/config.js'
import { decodePostgreSqlTextKey } from '../../../src/storage/postgresql-repository.js'
import {
  PostgreSqlTransferPreflightError,
  preflightPostgreSqlTransferTarget,
} from '../../../src/storage/postgresql-transfer-preflight.js'
import {
  OfflineTransferError,
  transferOfflineSqliteToPostgreSql,
  type OfflineTransferProgress,
} from '../../../src/storage/sqlite-to-postgresql-transfer.js'
import { preflightSqliteTransferSource } from '../../../src/storage/sqlite-transfer-preflight.js'
import {
  configuredPostgreSqlTestUrl,
  createDisposablePostgreSqlDatabase,
} from '../../storage/postgresql-test-database.js'

const TEST_URL = configuredPostgreSqlTestUrl()
const describePostgreSql = TEST_URL === undefined ? describe.skip : describe
const EMPTY_FACTORIES: PostgreSqlRepositoryFactories<object, object> = {
  createRoot: () => ({}),
  createTransaction: () => ({}),
}

function plan(runtimeUrl: string, migrationUrl?: string): ValidatedPostgreSqlPlan {
  const selected = validateStoragePlan({
    storage: {
      kind: 'postgresql',
      runtimeConnection: { source: 'provider', resolve: () => runtimeUrl },
      ...(migrationUrl === undefined
        ? {}
        : {
            migrationConnection: {
              source: 'provider' as const,
              resolve: () => migrationUrl,
            },
          }),
      tls: { mode: 'disable', allowInsecureLoopback: true },
    },
  }, '/unused.db')
  if (selected.kind !== 'postgresql') throw new Error('Expected PostgreSQL plan.')
  return selected
}

function fileDigest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function createSource(path: string, appRows = 0): void {
  const sqlite = new Database(path)
  sqlite.pragma('foreign_keys = ON')
  runMigrationsSafely(sqlite, path, MIGRATIONS)
  const insert = sqlite.prepare('INSERT INTO app_state (key, value) VALUES (?, ?)')
  const populate = sqlite.transaction(() => {
    for (let index = 0; index < appRows; index += 1) {
      insert.run(`key-${String(index).padStart(4, '0')}`, `value-${index}`)
    }
  })
  populate()
  sqlite.close()
}

async function createTarget() {
  const database = await createDisposablePostgreSqlDatabase(TEST_URL!)
  const adapter = new PostgreSqlStorageAdapter({
    plan: plan(database.url),
    repositories: EMPTY_FACTORIES,
  })
  await adapter.initialize()
  await adapter.close()
  const migration = new Client({ connectionString: database.url, ssl: false })
  const runtime = new Client({ connectionString: database.url, ssl: false })
  await migration.connect()
  await runtime.connect()
  return { database, migration, runtime }
}

describePostgreSql('offline SQLite-to-PostgreSQL transfer', () => {
  it('copies one writer-fenced snapshot, preserves encrypted bytes, and verifies before cutover', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ownware-offline-transfer-'))
    const sourcePath = join(dir, 'source.sqlite')
    createSource(sourcePath, 300)
    const ciphertext = 'v2:001122:334455:customer-ciphertext-canary'
    const principal = 'delegated\0workspace-a\0profile-a'
    const sqlite = new Database(sourcePath)
    sqlite.prepare(`
      INSERT INTO credentials (
        id, name, category, auth_type, encrypted_value, hint, granted_scopes,
        trust, source, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'credential-a', 'API credential', 'api_key', 'bearer', ciphertext,
      '...tail', '["read"]', 'medium', 'user', 'ready',
      '2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z',
    )
    sqlite.prepare(`
      INSERT INTO run_idempotency (
        id, principal_key, operation, idempotency_key, request_salt,
        request_digest, state, lease_owner, created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'in_progress', ?, ?, ?, ?)
    `).run(
      'request-a', principal, 'run', 'key-a', 'salt-a', 'digest-a',
      'owner-a', 1n, 2n, 3n,
    )
    sqlite.pragma('foreign_keys = ON')
    sqlite.exec('BEGIN')
    sqlite.prepare(`
      INSERT INTO access_grants (
        grant_id, workspace_id, profile_id, current_revision, created_at
      ) VALUES (?, ?, ?, 1, ?)
    `).run('00000000-0000-4000-8000-000000000014', 'workspace-a', 'profile-a', 1n)
    sqlite.prepare(`
      INSERT INTO access_grant_revisions (
        grant_id, revision, workspace_id, profile_id, state, subject_id,
        purpose, channel, resource_kind, resource_id, operation,
        field_scope_mode, field_ids_json, row_scope_mode, row_ids_json,
        consent_state, consent_evidence_id, autonomy_ceiling, effective_at,
        expires_at, issued_by, revision_created_at, revoked_at
      ) VALUES (
        ?, 1, ?, ?, 'active', ?, ?, ?, ?, ?, ?,
        'all', '[]', 'all', '[]', 'not_required', NULL, 'observe', ?, ?, ?, ?, NULL
      )
    `).run(
      '00000000-0000-4000-8000-000000000014', 'workspace-a', 'profile-a',
      'subject-a', 'transfer', 'web.primary', 'source', 'resource-a',
      'source.read', 1n, 2n, 'owner', 1n,
    )
    sqlite.exec('COMMIT')
    sqlite.close()

    const beforeFile = fileDigest(sourcePath)
    const source = preflightSqliteTransferSource(sourcePath)
    const target = await createTarget()
    const progress: OfflineTransferProgress[] = []
    try {
      const expectedTarget = await preflightPostgreSqlTransferTarget(
        target.migration,
        target.runtime,
      )
      let competingWriterCode: string | undefined
      const receipt = await transferOfflineSqliteToPostgreSql({
        sourcePath,
        expectedSource: source,
        expectedTarget,
        targetMigration: target.migration,
        targetRuntime: target.runtime,
        onProgress(event) {
          progress.push(event)
          if (event.phase !== 'source_fenced') return
          const contender = new Database(sourcePath, { timeout: 1 })
          try {
            contender.prepare('INSERT INTO app_state (key, value) VALUES (?, ?)')
              .run('competing-writer', 'must-not-commit')
          } catch (error) {
            competingWriterCode = typeof error === 'object' && error !== null && 'code' in error
              ? String((error as { readonly code?: unknown }).code)
              : 'unknown'
          } finally {
            contender.close()
          }
        },
      })

      expect(receipt).toMatchObject({
        status: 'ready-for-explicit-cutover',
        sourceAuthority: 'sqlite-immediate-transaction',
        sourceRemainsAuthoritative: true,
        targetCommitted: true,
        targetVerified: true,
        cutoverAutomatic: false,
        rollbackMode: 'reuse-unchanged-sqlite-before-target-runtime-writes',
        schemaVersion: 86,
        tableCount: 66,
        rowCount: 304,
      })
      expect(receipt.contentDigest).toBe(source.contentDigest)
      expect(competingWriterCode).toBe('SQLITE_BUSY')
      expect(progress.filter((event) => (
        event.phase === 'batch_copied' && event.table === 'app_state'
      ))).toHaveLength(3)
      expect(progress.at(-1)).toEqual({ phase: 'target_verified_after_commit' })
      expect(JSON.stringify({ receipt, progress })).not.toContain(ciphertext)

      const credential = await target.runtime.query<{
        readonly encrypted_value: string
      }>('SELECT encrypted_value FROM ownware.credentials WHERE id = $1', ['credential-a'])
      expect(credential.rows[0]?.encrypted_value).toBe(ciphertext)
      const key = await target.runtime.query<{ readonly principal_key: string }>(
        'SELECT principal_key FROM ownware.run_idempotency WHERE id = $1',
        ['request-a'],
      )
      expect(decodePostgreSqlTextKey(key.rows[0]?.principal_key)).toBe(principal)

      const committed = await canonicalPostgreSqlTransferSnapshot(target.runtime)
      expect(committed.contentDigest).toBe(source.contentDigest)
      expect(preflightSqliteTransferSource(sourcePath)).toEqual(source)
      expect(fileDigest(sourcePath)).toBe(beforeFile)
      const reopenedSource = new Database(sourcePath, { readonly: true })
      expect(reopenedSource.prepare(
        'SELECT 1 FROM app_state WHERE key = ?'
      ).get('competing-writer')).toBeUndefined()
      reopenedSource.close()
      await expect(preflightPostgreSqlTransferTarget(
        target.migration,
        target.runtime,
      )).rejects.toMatchObject<Partial<PostgreSqlTransferPreflightError>>({
        code: 'target_not_empty',
      })
    } finally {
      await target.migration.end().catch(() => {})
      await target.runtime.end().catch(() => {})
      await target.database.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('copies with separate migration ownership and least-privilege runtime reads', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ownware-offline-transfer-split-'))
    const sourcePath = join(dir, 'source.sqlite')
    createSource(sourcePath, 1)
    const source = preflightSqliteTransferSource(sourcePath)
    const database = await createDisposablePostgreSqlDatabase(TEST_URL!)
    const migrationRole = await database.createRole('migration')
    const runtimeRole = await database.createRole('runtime')
    await database.transferOwnershipTo(migrationRole.name)
    const initializer = new PostgreSqlStorageAdapter({
      plan: plan(runtimeRole.url, migrationRole.url),
      repositories: EMPTY_FACTORIES,
    })
    const migration = new Client({ connectionString: migrationRole.url, ssl: false })
    const runtime = new Client({ connectionString: runtimeRole.url, ssl: false })
    try {
      await initializer.initialize()
      await initializer.close()
      await migration.connect()
      await runtime.connect()
      const expectedTarget = await preflightPostgreSqlTransferTarget(migration, runtime)
      expect(expectedTarget.runtimeAuthority).toBe('separate-least-privilege')
      await expect(transferOfflineSqliteToPostgreSql({
        sourcePath,
        expectedSource: source,
        expectedTarget,
        targetMigration: migration,
        targetRuntime: runtime,
      })).resolves.toMatchObject({
        status: 'ready-for-explicit-cutover',
        rowCount: 1,
        targetVerified: true,
      })
      await expect(canonicalPostgreSqlTransferSnapshot(runtime)).resolves
        .toMatchObject({ contentDigest: source.contentDigest })
      await expect(runtime.query(
        'INSERT INTO ownware.app_state (key, value) VALUES ($1, $2)',
        ['runtime-must-not-write-history', 'value'],
      )).resolves.toBeDefined()
      await expect(runtime.query(
        'INSERT INTO ownware._migrations (version, name, fingerprint) VALUES (999, $1, $2)',
        ['forbidden', 'forbidden'],
      )).rejects.toMatchObject({ code: '42501' })
    } finally {
      await migration.end().catch(() => {})
      await runtime.end().catch(() => {})
      await initializer.close().catch(() => {})
      await database.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rolls the complete target transaction back when cancelled after a copied batch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ownware-offline-transfer-cancel-'))
    const sourcePath = join(dir, 'source.sqlite')
    createSource(sourcePath, 300)
    const source = preflightSqliteTransferSource(sourcePath)
    const beforeFile = fileDigest(sourcePath)
    const target = await createTarget()
    const abort = new AbortController()
    try {
      const expectedTarget = await preflightPostgreSqlTransferTarget(
        target.migration,
        target.runtime,
      )
      await expect(transferOfflineSqliteToPostgreSql({
        sourcePath,
        expectedSource: source,
        expectedTarget,
        targetMigration: target.migration,
        targetRuntime: target.runtime,
        signal: abort.signal,
        onProgress(event) {
          if (event.phase === 'batch_copied' && event.table === 'app_state') abort.abort()
        },
      })).rejects.toMatchObject<Partial<OfflineTransferError>>({ code: 'cancelled' })

      await expect(preflightPostgreSqlTransferTarget(
        target.migration,
        target.runtime,
      )).resolves.toMatchObject({ state: 'schema_current_empty_ready' })
      expect(preflightSqliteTransferSource(sourcePath)).toEqual(source)
      expect(fileDigest(sourcePath)).toBe(beforeFile)

      await expect(transferOfflineSqliteToPostgreSql({
        sourcePath,
        expectedSource: source,
        expectedTarget,
        targetMigration: target.migration,
        targetRuntime: target.runtime,
      })).resolves.toMatchObject({
        status: 'ready-for-explicit-cutover',
        rowCount: 300,
        targetCommitted: true,
        targetVerified: true,
      })
      expect(preflightSqliteTransferSource(sourcePath)).toEqual(source)
      expect(fileDigest(sourcePath)).toBe(beforeFile)
    } finally {
      await target.migration.end().catch(() => {})
      await target.runtime.end().catch(() => {})
      await target.database.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses when another SQLite writer already owns the source fence', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ownware-offline-transfer-fence-'))
    const sourcePath = join(dir, 'source.sqlite')
    createSource(sourcePath, 1)
    const source = preflightSqliteTransferSource(sourcePath)
    const target = await createTarget()
    const writer = new Database(sourcePath)
    writer.exec('BEGIN IMMEDIATE')
    try {
      const expectedTarget = await preflightPostgreSqlTransferTarget(
        target.migration,
        target.runtime,
      )
      await expect(transferOfflineSqliteToPostgreSql({
        sourcePath,
        expectedSource: source,
        expectedTarget,
        targetMigration: target.migration,
        targetRuntime: target.runtime,
        sourceFenceTimeoutMs: 10,
      })).rejects.toMatchObject<Partial<OfflineTransferError>>({
        code: 'source_fence_unavailable',
      })
      await expect(preflightPostgreSqlTransferTarget(
        target.migration,
        target.runtime,
      )).resolves.toMatchObject({ state: 'schema_current_empty_ready' })
      expect(preflightSqliteTransferSource(sourcePath)).toEqual(source)
    } finally {
      if (writer.inTransaction) writer.exec('ROLLBACK')
      writer.close()
      await target.migration.end().catch(() => {})
      await target.runtime.end().catch(() => {})
      await target.database.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('leaves no partial rows when the target backend dies mid-table', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ownware-offline-transfer-kill-'))
    const sourcePath = join(dir, 'source.sqlite')
    createSource(sourcePath, 1_000)
    const source = preflightSqliteTransferSource(sourcePath)
    const beforeFile = fileDigest(sourcePath)
    const target = await createTarget()
    const killer = new Client({ connectionString: target.database.url, ssl: false })
    await killer.connect()
    const backend = await target.migration.query<{ readonly pid: number }>(
      'SELECT pg_backend_pid() AS pid',
    )
    const pid = backend.rows[0]!.pid
    let kill: Promise<unknown> | undefined
    // A terminated backend also raises a client-level error event after the
    // in-flight query rejects. The transfer result, not EventEmitter process
    // behavior, is the authority under test.
    target.migration.on('error', () => {})
    try {
      const expectedTarget = await preflightPostgreSqlTransferTarget(
        target.migration,
        target.runtime,
      )
      await expect(transferOfflineSqliteToPostgreSql({
        sourcePath,
        expectedSource: source,
        expectedTarget,
        targetMigration: target.migration,
        targetRuntime: target.runtime,
        onProgress(event) {
          if (
            kill === undefined && event.phase === 'batch_copied' &&
            event.table === 'app_state'
          ) {
            kill = killer.query('SELECT pg_terminate_backend($1)', [pid])
          }
        },
      })).rejects.toMatchObject<Partial<OfflineTransferError>>({
        code: 'target_rollback_unconfirmed',
      })
      await kill

      const recoveryMigration = new Client({
        connectionString: target.database.url,
        ssl: false,
      })
      await recoveryMigration.connect()
      try {
        await expect(preflightPostgreSqlTransferTarget(
          recoveryMigration,
          target.runtime,
        )).resolves.toMatchObject({ state: 'schema_current_empty_ready' })
      } finally {
        await recoveryMigration.end()
      }
      expect(preflightSqliteTransferSource(sourcePath)).toEqual(source)
      expect(fileDigest(sourcePath)).toBe(beforeFile)
    } finally {
      await killer.end().catch(() => {})
      await target.migration.end().catch(() => {})
      await target.runtime.end().catch(() => {})
      await target.database.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses a changed source before starting a target write transaction', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ownware-offline-transfer-source-change-'))
    const sourcePath = join(dir, 'source.sqlite')
    createSource(sourcePath)
    const source = preflightSqliteTransferSource(sourcePath)
    const sqlite = new Database(sourcePath)
    sqlite.prepare('INSERT INTO app_state (key, value) VALUES (?, ?)')
      .run('customer-secret-key', 'customer-secret-value')
    sqlite.close()
    const target = await createTarget()
    try {
      const expectedTarget = await preflightPostgreSqlTransferTarget(
        target.migration,
        target.runtime,
      )
      let error: unknown
      try {
        await transferOfflineSqliteToPostgreSql({
          sourcePath,
          expectedSource: source,
          expectedTarget,
          targetMigration: target.migration,
          targetRuntime: target.runtime,
        })
      } catch (caught) {
        error = caught
      }
      expect(error).toMatchObject<Partial<OfflineTransferError>>({ code: 'source_changed' })
      expect(String(error)).not.toContain('customer-secret')
      await expect(preflightPostgreSqlTransferTarget(
        target.migration,
        target.runtime,
      )).resolves.toMatchObject({ state: 'schema_current_empty_ready' })
    } finally {
      await target.migration.end().catch(() => {})
      await target.runtime.end().catch(() => {})
      await target.database.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('never truncates or adopts a target that became non-empty after preflight', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ownware-offline-transfer-target-change-'))
    const sourcePath = join(dir, 'source.sqlite')
    createSource(sourcePath, 1)
    const source = preflightSqliteTransferSource(sourcePath)
    const target = await createTarget()
    try {
      const expectedTarget = await preflightPostgreSqlTransferTarget(
        target.migration,
        target.runtime,
      )
      await target.runtime.query(
        'INSERT INTO ownware.app_state (key, value) VALUES ($1, $2)',
        ['existing-target-row', 'must-survive'],
      )
      await expect(transferOfflineSqliteToPostgreSql({
        sourcePath,
        expectedSource: source,
        expectedTarget,
        targetMigration: target.migration,
        targetRuntime: target.runtime,
      })).rejects.toMatchObject<Partial<OfflineTransferError>>({ code: 'target_not_ready' })
      const rows = await target.runtime.query<{ readonly value: string }>(
        'SELECT value FROM ownware.app_state WHERE key = $1',
        ['existing-target-row'],
      )
      expect(rows.rows).toEqual([{ value: 'must-survive' }])
      expect(preflightSqliteTransferSource(sourcePath)).toEqual(source)
    } finally {
      await target.migration.end().catch(() => {})
      await target.runtime.end().catch(() => {})
      await target.database.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
