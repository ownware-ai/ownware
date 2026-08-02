import { Client } from 'pg'
import { describe, expect, it } from 'vitest'
import {
  PostgreSqlStorageAdapter,
  type PostgreSqlRepositoryFactories,
} from '../../../src/storage/postgresql-adapter.js'
import {
  PostgreSqlCanonicalSnapshotError,
  canonicalPostgreSqlTransferSnapshot,
} from '../../../src/storage/postgresql-canonical-snapshot.js'
import { validateStoragePlan, type ValidatedPostgreSqlPlan } from '../../../src/storage/config.js'
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

async function initializedDatabase(): Promise<{
  readonly database: Awaited<ReturnType<typeof createDisposablePostgreSqlDatabase>>
  readonly adapter: PostgreSqlStorageAdapter<object, object>
}> {
  const database = await createDisposablePostgreSqlDatabase(TEST_URL!)
  const adapter = new PostgreSqlStorageAdapter({
    plan: plan(database.url),
    repositories: EMPTY_FACTORIES,
  })
  await adapter.initialize()
  await adapter.close()
  return { database, adapter }
}

describePostgreSql('PostgreSQL canonical transfer snapshot', () => {
  it('holds one repeatable-read snapshot while a concurrent writer commits', async () => {
    const { database, adapter } = await initializedDatabase()
    const reader = new Client({ connectionString: database.url, ssl: false })
    const writer = new Client({ connectionString: database.url, ssl: false })
    try {
      await Promise.all([reader.connect(), writer.connect()])
      const rawQuery = reader.query.bind(reader)
      let inserted = false
      const snapshotClient = {
        query: (async (text: string, values?: readonly unknown[]) => {
          const result = await rawQuery(text, values as unknown[] | undefined)
          if (!inserted && /^FETCH FORWARD/.test(text)) {
            inserted = true
            await writer.query(`
              INSERT INTO ownware.app_state (key, value, updated_at)
              VALUES ('late-key', 'late-value', '2026-08-02T00:00:00.000Z')
            `)
          }
          return result
        }) as typeof reader.query,
      }

      const beforeCommitVisibility = await canonicalPostgreSqlTransferSnapshot(snapshotClient)
      expect(inserted).toBe(true)
      expect(beforeCommitVisibility.rowCount).toBe(0)
      expect(beforeCommitVisibility.tables.find((table) => table.table === 'app_state'))
        .toMatchObject({ rowCount: 0 })

      const afterCommitVisibility = await canonicalPostgreSqlTransferSnapshot(reader)
      expect(afterCommitVisibility.rowCount).toBe(1)
      expect(afterCommitVisibility.contentDigest).not.toBe(beforeCommitVisibility.contentDigest)
    } finally {
      await Promise.all([
        reader.end().catch(() => {}),
        writer.end().catch(() => {}),
        adapter.close().catch(() => {}),
      ])
      await database.close()
    }
  })

  it('rejects a malformed physical principal projection without exposing it', async () => {
    const { database, adapter } = await initializedDatabase()
    const client = new Client({ connectionString: database.url, ssl: false })
    const canary = 'customer-secret-canary'
    try {
      await client.connect()
      await client.query(`
        INSERT INTO ownware.run_idempotency (
          id, principal_key, operation, idempotency_key, request_salt,
          request_digest, state, lease_owner, created_at, updated_at, expires_at
        ) VALUES ($1, $2, 'run', 'key-a', 'salt-a', 'digest-a',
          'in_progress', 'owner-a', 1, 2, 3)
      `, ['request-a', canary])

      let error: unknown
      try {
        await canonicalPostgreSqlTransferSnapshot(client)
      } catch (caught) {
        error = caught
      }
      expect(error).toEqual(expect.objectContaining<Partial<PostgreSqlCanonicalSnapshotError>>({
        code: 'row_invalid',
      }))
      expect(String(error)).not.toContain(canary)
      await expect(client.query('SELECT 1 AS usable')).resolves
        .toEqual(expect.objectContaining({ rows: [{ usable: 1 }] }))
    } finally {
      await client.end().catch(() => {})
      await adapter.close().catch(() => {})
      await database.close()
    }
  })
})
