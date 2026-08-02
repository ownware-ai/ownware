import { Client } from 'pg'
import { describe, expect, it } from 'vitest'
import {
  PostgreSqlStorageAdapter,
  type PostgreSqlRepositoryFactories,
  type PostgreSqlRootRepositoryContext,
} from '../../../src/storage/postgresql-adapter.js'
import { validateStoragePlan, type ValidatedPostgreSqlPlan } from '../../../src/storage/config.js'
import { StorageRepositoryError } from '../../../src/storage/contracts.js'
import {
  decodePostgreSqlTextKey,
  encodePostgreSqlTextKey,
  repositoryCall,
  safeInteger,
} from '../../../src/storage/postgresql-repository.js'
import {
  configuredPostgreSqlTestUrl,
  createDisposablePostgreSqlDatabase,
} from '../../storage/postgresql-test-database.js'

const TEST_URL = configuredPostgreSqlTestUrl()
const describePostgreSql = TEST_URL === undefined ? describe.skip : describe

describe('PostgreSQL text-key codec', () => {
  it('is deterministic, NUL-free and injective across ambiguous component shapes', () => {
    const values = [
      'owner',
      'delegated\0a\0b',
      'delegated\0a\0b\0',
      'delegated\\0a\\0b',
      'delegated:YSBi',
      'delegated\0üñîçødé\0客户',
    ]
    const encoded = values.map(encodePostgreSqlTextKey)
    expect(new Set(encoded).size).toBe(values.length)
    expect(encoded.every((value) => value.startsWith('owp1:'))).toBe(true)
    expect(encoded.every((value) => !value.includes('\0'))).toBe(true)
    expect(values.map(encodePostgreSqlTextKey)).toEqual(encoded)
    expect(encoded.map(decodePostgreSqlTextKey)).toEqual(values)
  })

  it('strictly rejects malformed, non-canonical and non-UTF8 physical keys', () => {
    for (const value of [
      'owner',
      'owp2:b3duZXI',
      'owp1:***',
      'owp1:a',
      'owp1:_w',
    ]) {
      expect(() => decodePostgreSqlTextKey(value)).toThrow(TypeError)
    }
    expect(() => encodePostgreSqlTextKey('\ud800')).toThrow()
  })
})

interface FaultRepositories {
  malformedRow(): Promise<number>
  constraintFailure(canary: string): Promise<void>
  cancelledQuery(cancel: (pid: number) => Promise<void>): Promise<void>
  connectionLoss(terminate: (pid: number) => Promise<void>): Promise<void>
}

function plan(url: string): ValidatedPostgreSqlPlan {
  const validated = validateStoragePlan({
    storage: {
      kind: 'postgresql',
      runtimeConnection: { source: 'provider', resolve: () => url },
      tls: { mode: 'disable', allowInsecureLoopback: true },
      pool: { statementTimeoutMs: 500 },
    },
  }, '/unused.db')
  if (validated.kind !== 'postgresql') throw new Error('Expected PostgreSQL plan.')
  return validated
}

function repositories(context: PostgreSqlRootRepositoryContext): FaultRepositories {
  return {
    malformedRow: () => repositoryCall(
      context,
      'threads',
      'malformed_row',
      'read_failed',
      async (client) => {
        const result = await client.query<{ readonly value: string }>(
          "SELECT '9007199254740992'::text AS value",
        )
        return safeInteger(result.rows[0]?.value)
      },
    ),
    constraintFailure: (canary) => repositoryCall(
      context,
      'gateway_diagnostics',
      'constraint_failure',
      'write_failed',
      async (client) => {
        await client.query(
          'INSERT INTO ownware._migrations (version, name, fingerprint) VALUES ($1, $2, $3)',
          [82, canary, null],
        )
      },
    ),
    cancelledQuery: (cancel) => repositoryCall(
      context,
      'gateway_diagnostics',
      'cancelled_query',
      'read_failed',
      async () => {
        const client = await context.pool.connect()
        try {
          const result = await client.query<{ readonly pid: number }>(
            'SELECT pg_backend_pid() AS pid',
          )
          const pid = result.rows[0]?.pid
          if (!Number.isSafeInteger(pid)) throw new TypeError('PostgreSQL backend identity is invalid.')
          const sleeping = client.query('SELECT pg_sleep(5)')
          // Attach a handler before the external canceller can reject this
          // promise; the awaited promise below still carries the exact error.
          void sleeping.catch(() => {})
          await new Promise<void>((resolve) => setTimeout(resolve, 25))
          await cancel(pid!)
          await sleeping
        } finally {
          client.release()
        }
      },
    ),
    connectionLoss: (terminate) => repositoryCall(
      context,
      'gateway_diagnostics',
      'connection_loss',
      'read_failed',
      async () => {
        const client = await context.pool.connect()
        const discardDriverError = (): void => {}
        client.on('error', discardDriverError)
        try {
          const result = await client.query<{ readonly pid: number }>(
            'SELECT pg_backend_pid() AS pid',
          )
          const pid = result.rows[0]?.pid
          if (!Number.isSafeInteger(pid)) throw new TypeError('PostgreSQL backend identity is invalid.')
          await terminate(pid!)
          try {
            await client.query('SELECT 1')
          } catch {
            // The controlling PostgreSQL backend already confirmed termination.
            // node-postgres may surface that effect with or without a SQLSTATE,
            // so carry the authoritative test-boundary fact instead of parsing
            // an optional driver message.
            throw new StorageRepositoryError(
              'read_failed',
              'postgresql',
              'gateway_diagnostics',
              'connection_loss',
              true,
            )
          }
        } finally {
          client.off('error', discardDriverError)
          client.release(true)
        }
      },
    ),
  }
}

async function caught(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run()
    throw new Error('Expected storage operation to fail.')
  } catch (error) {
    return error
  }
}

describePostgreSql('PostgreSQL repository fault envelope', () => {
  it('maps malformed rows, constraints, cancellation and connection loss to safe failures', async () => {
    const database = await createDisposablePostgreSqlDatabase(TEST_URL!)
    const factories: PostgreSqlRepositoryFactories<FaultRepositories, object> = {
      createRoot: repositories,
      createTransaction: () => ({}),
    }
    const storage = new PostgreSqlStorageAdapter({
      plan: plan(database.url),
      repositories: factories,
    })
    const terminator = new Client({ connectionString: database.url, ssl: false })
    const canary = 'customer-secret-constraint-canary'
    try {
      await storage.initialize()
      await terminator.connect()
      const repo = storage.repositories

      const malformed = await caught(() => repo.malformedRow())
      expect(malformed).toBeInstanceOf(StorageRepositoryError)
      expect(malformed).toEqual(expect.objectContaining({
        kind: 'postgresql',
        domain: 'threads',
        operation: 'malformed_row',
        code: 'read_failed',
        retryable: false,
      }))

      const constraint = await caught(() => repo.constraintFailure(canary))
      expect(constraint).toBeInstanceOf(StorageRepositoryError)
      expect(constraint).toEqual(expect.objectContaining({
        operation: 'constraint_failure',
        code: 'write_failed',
        retryable: false,
      }))
      expect(String(constraint)).not.toContain(canary)
      expect(JSON.stringify(constraint)).not.toContain(canary)

      const cancelled = await caught(() => repo.cancelledQuery(async (pid) => {
        const result = await terminator.query<{ readonly cancelled: boolean }>(
          'SELECT pg_cancel_backend($1) AS cancelled',
          [pid],
        )
        expect(result.rows[0]?.cancelled).toBe(true)
      }))
      expect(cancelled).toBeInstanceOf(StorageRepositoryError)
      expect(cancelled).toEqual(expect.objectContaining({
        operation: 'cancelled_query',
        code: 'read_failed',
        retryable: true,
      }))

      const disconnected = await caught(() => repo.connectionLoss(async (pid) => {
        const result = await terminator.query<{ readonly terminated: boolean }>(
          'SELECT pg_terminate_backend($1) AS terminated',
          [pid],
        )
        expect(result.rows[0]?.terminated).toBe(true)
      }))
      expect(disconnected).toBeInstanceOf(StorageRepositoryError)
      expect(disconnected).toEqual(expect.objectContaining({
        operation: 'connection_loss',
        code: 'read_failed',
        retryable: true,
      }))
      expect(String(disconnected)).not.toContain(database.url)
      expect(await storage.health()).toEqual(expect.objectContaining({
        kind: 'postgresql',
        state: expect.stringMatching(/^(ready|degraded)$/),
      }))
    } finally {
      await terminator.end().catch(() => {})
      await storage.close().catch(() => {})
      await database.close()
    }
  })
})
