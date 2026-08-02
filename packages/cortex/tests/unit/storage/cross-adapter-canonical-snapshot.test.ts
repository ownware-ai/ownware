import { mkdtempSync, rmSync } from 'node:fs'
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
import {
  postgreSqlCatalogMatchesCurrentV83,
} from '../../../src/storage/postgresql-catalog-certification.js'
import { canonicalPostgreSqlTransferSnapshot } from '../../../src/storage/postgresql-canonical-snapshot.js'
import { validateStoragePlan, type ValidatedPostgreSqlPlan } from '../../../src/storage/config.js'
import { encodePostgreSqlTextKey } from '../../../src/storage/postgresql-repository.js'
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

function plan(url: string): ValidatedPostgreSqlPlan {
  const selected = validateStoragePlan({
    storage: {
      kind: 'postgresql',
      runtimeConnection: { source: 'provider', resolve: () => url },
      tls: { mode: 'disable', allowInsecureLoopback: true },
    },
  }, '/unused.db')
  if (selected.kind !== 'postgresql') throw new Error('Expected PostgreSQL plan.')
  return selected
}

describePostgreSql('cross-adapter canonical transfer snapshot', () => {
  it('proves equal logical content across adapter-specific physical representations', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ownware-cross-adapter-snapshot-'))
    const sqlitePath = join(dir, 'source.sqlite')
    const sqlite = new Database(sqlitePath)
    sqlite.pragma('foreign_keys = ON')
    runMigrationsSafely(sqlite, sqlitePath, MIGRATIONS)

    const database = await createDisposablePostgreSqlDatabase(TEST_URL!)
    const adapter = new PostgreSqlStorageAdapter({
      plan: plan(database.url),
      repositories: EMPTY_FACTORIES,
    })
    const postgresql = new Client({ connectionString: database.url, ssl: false })
    try {
      await adapter.initialize()
      await adapter.close()
      await postgresql.connect()
      await expect(postgreSqlCatalogMatchesCurrentV83(postgresql)).resolves.toBe(true)

      const instant = '2026-08-02T03:04:05.678Z'
      const principal = 'delegated\0workspace-a\0profile-a'
      sqlite.prepare(`
        INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
      `).run('state-key', 'state-value', instant)
      await postgresql.query(`
        INSERT INTO ownware.app_state (key, value, updated_at) VALUES ($1, $2, $3)
      `, ['state-key', 'state-value', instant])

      sqlite.prepare(`
        INSERT INTO threads (
          id, profile_id, title, status, message_count, total_tokens,
          total_cost, model, pinned, metadata, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'thread-a', 'profile-a', 'Canonical thread', 'active', 1, 3,
        0.125, 'provider:model-a', 1, null, instant, instant,
      )
      await postgresql.query(`
        INSERT INTO ownware.threads (
          id, profile_id, title, status, message_count, total_tokens,
          total_cost, model, pinned, metadata, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10, $11, $12
        )
      `, [
        'thread-a', 'profile-a', 'Canonical thread', 'active', 1, 3,
        0.125, 'provider:model-a', true, null, instant, instant,
      ])

      sqlite.prepare(`
        INSERT INTO messages (
          id, thread_id, role, content, tools, sub_agents, permissions,
          attachments, thinking, usage_input, usage_output, created_at, parts,
          credentials, model, usage_cache_read, usage_cache_creation, message_seq
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?
        )
      `).run(
        'message-a', 'thread-a', 'assistant', 'Complete', null, null, null,
        null, null, 1, 2, instant,
        '{"z":[1,2],"a":{"y":true,"x":null}}',
        null, 'provider:model-a', 0, 0, 1,
      )
      await postgresql.query(`
        INSERT INTO ownware.messages (
          id, thread_id, role, content, tools, sub_agents, permissions,
          attachments, thinking, usage_input, usage_output, created_at, parts,
          credentials, model, usage_cache_read, usage_cache_creation, message_seq
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11, $12, $13,
          $14, $15, $16, $17, $18
        )
      `, [
        'message-a', 'thread-a', 'assistant', 'Complete', null, null, null,
        null, null, 1, 2, instant,
        '{ "a": { "x": null, "y": true }, "z": [1.0, 2e0] }',
        null, 'provider:model-a', 0, 0, 1,
      ])

      sqlite.prepare(`
        INSERT INTO run_idempotency (
          id, principal_key, operation, idempotency_key, request_salt,
          request_digest, state, lease_owner, status_code, result_json,
          created_at, updated_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'request-a', principal, 'run', 'key-a', 'salt-a', 'digest-a',
        'completed', 'owner-a', 200, '{"ok":true,"count":1}', 1n, 2n, 3n,
      )
      await postgresql.query(`
        INSERT INTO ownware.run_idempotency (
          id, principal_key, operation, idempotency_key, request_salt,
          request_digest, state, lease_owner, status_code, result_json,
          created_at, updated_at, expires_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11, $12, $13
        )
      `, [
        'request-a', encodePostgreSqlTextKey(principal), 'run', 'key-a',
        'salt-a', 'digest-a', 'completed', 'owner-a', 200,
        '{ "count": 1e0, "ok": true }', '1', '2', '3',
      ])

      sqlite.close()
      const sqliteReceipt = preflightSqliteTransferSource(sqlitePath)
      const postgresqlReceipt = await canonicalPostgreSqlTransferSnapshot(postgresql)

      expect(postgresqlReceipt).toEqual({
        schemaVersion: sqliteReceipt.schemaVersion,
        logicalColumnCount: sqliteReceipt.logicalColumnCount,
        logicalColumnDigest: sqliteReceipt.logicalColumnDigest,
        tableCount: sqliteReceipt.tableCount,
        rowCount: sqliteReceipt.rowCount,
        cellCount: sqliteReceipt.cellCount,
        contentDigest: sqliteReceipt.contentDigest,
        tables: sqliteReceipt.tables,
      })
      expect(postgresqlReceipt).toMatchObject({
        schemaVersion: 83,
        logicalColumnCount: 690,
        tableCount: 58,
        rowCount: 4,
      })
    } finally {
      if (sqlite.open) sqlite.close()
      await postgresql.end().catch(() => {})
      await adapter.close().catch(() => {})
      await database.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
