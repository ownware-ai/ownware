import { Client } from 'pg'
import { describe, expect, it } from 'vitest'
import {
  PostgreSqlStorageAdapter,
  type PostgreSqlRepositoryFactories,
  type PostgreSqlRootRepositoryContext,
  type PostgreSqlTransactionRepositoryContext,
} from '../../../src/storage/postgresql-adapter.js'
import { validateStoragePlan, type ValidatedPostgreSqlPlan } from '../../../src/storage/config.js'
import {
  StorageRepositoryError,
  StorageTransactionError,
  type StorageTransactionOptions,
} from '../../../src/storage/contracts.js'
import {
  repositoryCall,
  withPostgreSqlTransaction,
} from '../../../src/storage/postgresql-repository.js'
import {
  configuredPostgreSqlTestUrl,
  createDisposablePostgreSqlDatabase,
} from '../../storage/postgresql-test-database.js'

const TEST_URL = configuredPostgreSqlTestUrl()
const describePostgreSql = TEST_URL === undefined ? describe.skip : describe

const READ_COMMITTED: StorageTransactionOptions = {
  mode: 'write',
  isolation: 'read-committed',
  retry: 'never',
}

const SERIALIZABLE: StorageTransactionOptions = {
  mode: 'write',
  isolation: 'serializable',
  retry: 'never',
}

interface PoolUse {
  readonly borrowed: number
  readonly waiting: number
}

interface ProbeRootRepositories {
  reset(): Promise<void>
  values(): Promise<readonly number[]>
  loseRepositoryTransaction(terminate: (pid: number) => Promise<void>): Promise<void>
  poolUse(): PoolUse
}

interface ProbeTransactionRepositories {
  increment(id: number): Promise<void>
  read(id: number): Promise<number>
  set(id: number, value: number): Promise<void>
  insertCommitProbe(id: string): Promise<void>
  backendPid(): Promise<number>
  sleep(seconds: number): Promise<void>
}

function plan(
  url: string,
  shutdownTimeoutMs = 5_000,
  statementTimeoutMs = 5_000,
): ValidatedPostgreSqlPlan {
  const validated = validateStoragePlan({
    storage: {
      kind: 'postgresql',
      runtimeConnection: { source: 'provider', resolve: () => url },
      tls: { mode: 'disable', allowInsecureLoopback: true },
      pool: {
        maxConnections: 6,
        statementTimeoutMs,
        lockTimeoutMs: 5_000,
        shutdownTimeoutMs,
      },
    },
  }, '/unused.db')
  if (validated.kind !== 'postgresql') throw new Error('Expected PostgreSQL plan.')
  return validated
}

function rootRepositories(
  context: PostgreSqlRootRepositoryContext,
): ProbeRootRepositories {
  return {
    reset: () => repositoryCall(
      context,
      'gateway_diagnostics',
      'transaction_probe_reset',
      'write_failed',
      async (client) => {
        await client.query('UPDATE ownware.sto11_transaction_probe SET value = 0')
      },
    ),
    values: () => repositoryCall(
      context,
      'gateway_diagnostics',
      'transaction_probe_values',
      'read_failed',
      async (client) => {
        const result = await client.query<{ readonly value: number }>(
          'SELECT value FROM ownware.sto11_transaction_probe ORDER BY id',
        )
        return result.rows.map((row) => Number(row.value))
      },
    ),
    loseRepositoryTransaction: (terminate) => repositoryCall(
      context,
      'gateway_diagnostics',
      'transaction_probe_repository_connection_loss',
      'write_failed',
      async () => withPostgreSqlTransaction(context.pool, async (client) => {
        await client.query(
          'UPDATE ownware.sto11_transaction_probe SET value = value + 1 WHERE id = 2',
        )
        const result = await client.query<{ readonly pid: number }>(
          'SELECT pg_backend_pid() AS pid',
        )
        const sleeping = observeExpectedFailure(client.query('SELECT pg_sleep(5)'))
        await terminate(Number(result.rows[0]?.pid))
        await sleeping
      }),
    ),
    poolUse: () => {
      context.assertActive()
      return {
        borrowed: context.pool.totalCount - context.pool.idleCount,
        waiting: context.pool.waitingCount,
      }
    },
  }
}

function transactionRepositories(
  context: PostgreSqlTransactionRepositoryContext,
): ProbeTransactionRepositories {
  const call = <T>(operation: string, run: () => Promise<T>): Promise<T> => repositoryCall(
    context,
    'gateway_diagnostics',
    operation,
    operation.includes('read') || operation.includes('pid') ? 'read_failed' : 'write_failed',
    run,
  )
  return {
    increment: (id) => call('transaction_probe_increment', async () => {
      await context.client.query(
        'UPDATE ownware.sto11_transaction_probe SET value = value + 1 WHERE id = $1',
        [id],
      )
    }),
    read: (id) => call('transaction_probe_read', async () => {
      const result = await context.client.query<{ readonly value: number }>(
        'SELECT value FROM ownware.sto11_transaction_probe WHERE id = $1',
        [id],
      )
      return Number(result.rows[0]?.value)
    }),
    set: (id, value) => call('transaction_probe_set', async () => {
      await context.client.query(
        'UPDATE ownware.sto11_transaction_probe SET value = $2 WHERE id = $1',
        [id, value],
      )
    }),
    insertCommitProbe: (id) => call('transaction_probe_commit_insert', async () => {
      await context.client.query(
        'INSERT INTO ownware.sto11_commit_probe (id) VALUES ($1)',
        [id],
      )
    }),
    backendPid: () => call('transaction_probe_pid', async () => {
      const result = await context.client.query<{ readonly pid: number }>(
        'SELECT pg_backend_pid() AS pid',
      )
      return Number(result.rows[0]?.pid)
    }),
    sleep: (seconds) => call('transaction_probe_sleep', async () => {
      await context.client.query('SELECT pg_sleep($1)', [seconds])
    }),
  }
}

function barrier(parties: number): () => Promise<void> {
  let arrivals = 0
  let release!: () => void
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  return async () => {
    arrivals += 1
    if (arrivals === parties) release()
    await released
  }
}

async function waitForLockWait(client: Client, pid: number): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const result = await client.query<{ readonly waiting: boolean }>(
      `SELECT COALESCE(wait_event_type = 'Lock', false) AS waiting
         FROM pg_stat_activity
        WHERE pid = $1`,
      [pid],
    )
    if (result.rows[0]?.waiting === true) return
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('PostgreSQL contender did not reach the lock wait boundary.')
}

async function waitForPgSleep(client: Client, pid: number): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const result = await client.query<{ readonly sleeping: boolean }>(
      `SELECT COALESCE(state = 'active' AND wait_event = 'PgSleep', false) AS sleeping
         FROM pg_stat_activity
        WHERE pid = $1`,
      [pid],
    )
    if (result.rows[0]?.sleeping === true) return
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('PostgreSQL transaction did not reach the query cancellation boundary.')
}

async function waitForCommitSleep(client: Client, pid: number): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const result = await client.query<{ readonly committing: boolean }>(
      `SELECT COALESCE(state = 'active' AND wait_event = 'PgSleep'
        AND query = 'COMMIT', false) AS committing
         FROM pg_stat_activity
        WHERE pid = $1`,
      [pid],
    )
    if (result.rows[0]?.committing === true) return
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('PostgreSQL transaction did not reach the delayed commit boundary.')
}

async function waitForSessionGone(client: Client, pid: number): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const result = await client.query('SELECT 1 FROM pg_stat_activity WHERE pid = $1', [pid])
    if (result.rowCount === 0) return
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('PostgreSQL transaction session did not close after forced pool release.')
}

function expectPoolReturned(repositories: ProbeRootRepositories): void {
  expect(repositories.poolUse()).toEqual({ borrowed: 0, waiting: 0 })
}

function observeExpectedFailure<T>(promise: Promise<T>): Promise<T> {
  void promise.catch(() => {})
  return promise
}

describePostgreSql('PostgreSQL transaction concurrency and recovery', () => {
  it('recovers savepoints and full rollbacks without leaking a pool client', async () => {
    const database = await createDisposablePostgreSqlDatabase(TEST_URL!)
    const storage = new PostgreSqlStorageAdapter({
      plan: plan(database.url),
      repositories: {
        createRoot: rootRepositories,
        createTransaction: transactionRepositories,
      },
    })
    const setup = new Client({ connectionString: database.url, ssl: false })
    try {
      await storage.initialize()
      await setup.connect()
      await setup.query(
        `CREATE TABLE ownware.sto11_transaction_probe (
          id integer PRIMARY KEY,
          value integer NOT NULL
        )`,
      )
      await setup.query('INSERT INTO ownware.sto11_transaction_probe VALUES (1, 0), (2, 0)')

      await storage.transaction(READ_COMMITTED, async (tx) => {
        await tx.repositories.increment(1)
        await expect(tx.savepoint(async (nested) => {
          await nested.repositories.increment(2)
          throw new Error('savepoint sentinel')
        })).rejects.toThrow('savepoint sentinel')
        await tx.repositories.increment(1)
      })
      expect(await storage.repositories.values()).toEqual([2, 0])
      expectPoolReturned(storage.repositories)

      await expect(storage.transaction(READ_COMMITTED, async (tx) => {
        await tx.repositories.increment(1)
        throw new Error('rollback sentinel')
      })).rejects.toThrow('rollback sentinel')
      expect(await storage.repositories.values()).toEqual([2, 0])
      expectPoolReturned(storage.repositories)
    } finally {
      await setup.end().catch(() => {})
      await storage.close().catch(() => {})
      await database.close()
    }
  })

  it('never replays callbacks after deadlock or serializable conflict', async () => {
    const database = await createDisposablePostgreSqlDatabase(TEST_URL!)
    const storage = new PostgreSqlStorageAdapter({
      plan: plan(database.url),
      repositories: {
        createRoot: rootRepositories,
        createTransaction: transactionRepositories,
      },
    })
    const setup = new Client({ connectionString: database.url, ssl: false })
    try {
      await storage.initialize()
      await setup.connect()
      await setup.query(
        `CREATE TABLE ownware.sto11_transaction_probe (
          id integer PRIMARY KEY,
          value integer NOT NULL
        )`,
      )
      await setup.query('INSERT INTO ownware.sto11_transaction_probe VALUES (1, 0), (2, 0)')

      const deadlockBarrier = barrier(2)
      const deadlockCallbacks = [0, 0]
      const deadlock = await Promise.allSettled([
        storage.transaction(READ_COMMITTED, async (tx) => {
          deadlockCallbacks[0] += 1
          await tx.repositories.increment(1)
          await deadlockBarrier()
          await tx.repositories.increment(2)
        }),
        storage.transaction(READ_COMMITTED, async (tx) => {
          deadlockCallbacks[1] += 1
          await tx.repositories.increment(2)
          await deadlockBarrier()
          await tx.repositories.increment(1)
        }),
      ])
      expect(deadlock.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      const deadlockFailure = deadlock.find((result) => result.status === 'rejected')
      expect(deadlockFailure?.status === 'rejected' ? deadlockFailure.reason : null)
        .toEqual(expect.objectContaining({ retryable: true }))
      expect(deadlockCallbacks).toEqual([1, 1])
      expect(await storage.repositories.values()).toEqual([1, 1])
      expectPoolReturned(storage.repositories)

      await storage.repositories.reset()
      const serializationBarrier = barrier(2)
      const serializationCallbacks = [0, 0]
      const serialized = await Promise.allSettled([
        storage.transaction(SERIALIZABLE, async (tx) => {
          serializationCallbacks[0] += 1
          const value = await tx.repositories.read(1)
          await serializationBarrier()
          await tx.repositories.set(1, value + 1)
        }),
        storage.transaction(SERIALIZABLE, async (tx) => {
          serializationCallbacks[1] += 1
          const value = await tx.repositories.read(1)
          await serializationBarrier()
          await tx.repositories.set(1, value + 1)
        }),
      ])
      expect(serialized.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      const serializationFailure = serialized.find((result) => result.status === 'rejected')
      const serializationError = serializationFailure?.status === 'rejected'
        ? serializationFailure.reason
        : null
      expect(
        serializationError instanceof StorageRepositoryError ||
          serializationError instanceof StorageTransactionError,
      ).toBe(true)
      expect(serializationError).toEqual(expect.objectContaining({ retryable: true }))
      expect(serializationCallbacks).toEqual([1, 1])
      expect(await storage.repositories.values()).toEqual([1, 0])
      expectPoolReturned(storage.repositories)
    } finally {
      await setup.end().catch(() => {})
      await storage.close().catch(() => {})
      await database.close()
    }
  })

  it('recovers after query cancellation and termination of a lock holder', async () => {
    const database = await createDisposablePostgreSqlDatabase(TEST_URL!)
    const storage = new PostgreSqlStorageAdapter({
      plan: plan(database.url),
      repositories: {
        createRoot: rootRepositories,
        createTransaction: transactionRepositories,
      },
    })
    const control = new Client({ connectionString: database.url, ssl: false })
    try {
      await storage.initialize()
      await control.connect()
      await control.query(
        `CREATE TABLE ownware.sto11_transaction_probe (
          id integer PRIMARY KEY,
          value integer NOT NULL
        )`,
      )
      await control.query('INSERT INTO ownware.sto11_transaction_probe VALUES (1, 0), (2, 0)')

      let cancelPid!: (pid: number) => void
      const cancelPidReady = new Promise<number>((resolve) => {
        cancelPid = resolve
      })
      const cancelled = observeExpectedFailure(storage.transaction(READ_COMMITTED, async (tx) => {
        await tx.repositories.increment(1)
        cancelPid(await tx.repositories.backendPid())
        await tx.repositories.sleep(5)
      }))
      const cancelledPid = await cancelPidReady
      await waitForPgSleep(control, cancelledPid)
      expect((await control.query<{ readonly cancelled: boolean }>(
        'SELECT pg_cancel_backend($1) AS cancelled',
        [cancelledPid],
      )).rows[0]?.cancelled).toBe(true)
      await expect(cancelled).rejects.toEqual(expect.objectContaining({ retryable: true }))
      expect(await storage.repositories.values()).toEqual([0, 0])
      expectPoolReturned(storage.repositories)

      let holderPid!: (pid: number) => void
      const holderPidReady = new Promise<number>((resolve) => {
        holderPid = resolve
      })
      const holder = observeExpectedFailure(storage.transaction(READ_COMMITTED, async (tx) => {
        await tx.repositories.increment(1)
        holderPid(await tx.repositories.backendPid())
        await tx.repositories.sleep(5)
      }))
      const lockedPid = await holderPidReady

      let contenderPid!: (pid: number) => void
      const contenderPidReady = new Promise<number>((resolve) => {
        contenderPid = resolve
      })
      const contender = storage.transaction(READ_COMMITTED, async (tx) => {
        contenderPid(await tx.repositories.backendPid())
        await tx.repositories.increment(1)
      })
      const waitingPid = await contenderPidReady
      await waitForLockWait(control, waitingPid)
      expect((await control.query<{ readonly terminated: boolean }>(
        'SELECT pg_terminate_backend($1) AS terminated',
        [lockedPid],
      )).rows[0]?.terminated).toBe(true)

      await expect(holder).rejects.toEqual(expect.objectContaining({ retryable: true }))
      await expect(contender).resolves.toBeUndefined()
      expect(await storage.repositories.values()).toEqual([1, 0])
      expectPoolReturned(storage.repositories)

      await expect(storage.repositories.loseRepositoryTransaction(async (pid) => {
        expect((await control.query<{ readonly terminated: boolean }>(
          'SELECT pg_terminate_backend($1) AS terminated',
          [pid],
        )).rows[0]?.terminated).toBe(true)
      })).rejects.toEqual(expect.objectContaining({
        name: 'StorageRepositoryError',
        retryable: true,
      }))
      expect(await storage.repositories.values()).toEqual([1, 0])
      expectPoolReturned(storage.repositories)
      expect(await storage.health()).toEqual(expect.objectContaining({
        kind: 'postgresql',
        state: expect.stringMatching(/^(ready|degraded)$/),
      }))
    } finally {
      await control.end().catch(() => {})
      await storage.close().catch(() => {})
      await database.close()
    }
  })

  it('fails safely when the backend is terminated inside the commit phase', async () => {
    const database = await createDisposablePostgreSqlDatabase(TEST_URL!)
    const storage = new PostgreSqlStorageAdapter({
      plan: plan(database.url),
      repositories: {
        createRoot: rootRepositories,
        createTransaction: transactionRepositories,
      },
    })
    const control = new Client({ connectionString: database.url, ssl: false })
    try {
      await storage.initialize()
      await control.connect()
      await control.query(
        `CREATE TABLE ownware.sto11_transaction_probe (
          id integer PRIMARY KEY,
          value integer NOT NULL
        )`,
      )
      await control.query('INSERT INTO ownware.sto11_transaction_probe VALUES (1, 0), (2, 0)')
      await control.query('CREATE TABLE ownware.sto11_commit_probe (id text PRIMARY KEY)')
      await control.query(`
        CREATE FUNCTION ownware.sto11_delay_commit() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          PERFORM pg_sleep(5);
          RETURN NEW;
        END
        $$
      `)
      await control.query(`
        CREATE CONSTRAINT TRIGGER sto11_delay_commit
        AFTER INSERT ON ownware.sto11_commit_probe
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION ownware.sto11_delay_commit()
      `)

      let commitPid!: (pid: number) => void
      const commitPidReady = new Promise<number>((resolve) => {
        commitPid = resolve
      })
      const committing = observeExpectedFailure(storage.transaction(READ_COMMITTED, async (tx) => {
        commitPid(await tx.repositories.backendPid())
        await tx.repositories.insertCommitProbe('must-not-commit')
      }))
      const pid = await commitPidReady
      await waitForCommitSleep(control, pid)
      expect((await control.query<{ readonly terminated: boolean }>(
        'SELECT pg_terminate_backend($1) AS terminated',
        [pid],
      )).rows[0]?.terminated).toBe(true)

      await expect(committing).rejects.toEqual(expect.objectContaining({
        name: 'StorageTransactionError',
        code: 'transaction_commit_failed',
        phase: 'commit',
        retryable: true,
        callbackInvoked: true,
      }))
      expect((await control.query<{ readonly count: string }>(
        'SELECT count(*)::text AS count FROM ownware.sto11_commit_probe',
      )).rows[0]?.count).toBe('0')
      expectPoolReturned(storage.repositories)

      await control.query('ALTER TABLE ownware.sto11_commit_probe DISABLE TRIGGER sto11_delay_commit')
      await storage.transaction(READ_COMMITTED, async (tx) => {
        await tx.repositories.insertCommitProbe('retry-commits-on-fresh-client')
      })
      expect((await control.query<{ readonly count: string }>(
        'SELECT count(*)::text AS count FROM ownware.sto11_commit_probe',
      )).rows[0]?.count).toBe('1')
      expectPoolReturned(storage.repositories)
    } finally {
      await control.end().catch(() => {})
      await storage.close().catch(() => {})
      await database.close()
    }
  })

  it('does not double-release a transaction client forced closed by shutdown timeout', async () => {
    const database = await createDisposablePostgreSqlDatabase(TEST_URL!)
    const storage = new PostgreSqlStorageAdapter({
      plan: plan(database.url, 25, 250),
      repositories: {
        createRoot: rootRepositories,
        createTransaction: transactionRepositories,
      },
    })
    const control = new Client({ connectionString: database.url, ssl: false })
    try {
      await storage.initialize()
      await control.connect()
      await control.query(`
        CREATE TABLE ownware.sto11_transaction_probe (
          id integer PRIMARY KEY,
          value integer NOT NULL
        )
      `)
      await control.query('INSERT INTO ownware.sto11_transaction_probe VALUES (1, 0), (2, 0)')

      let runningPid!: (pid: number) => void
      const runningPidReady = new Promise<number>((resolve) => {
        runningPid = resolve
      })
      const running = observeExpectedFailure(storage.transaction(READ_COMMITTED, async (tx) => {
        runningPid(await tx.repositories.backendPid())
        // Long enough to exceed the 25 ms adapter shutdown bound, but shorter
        // than the disposable database's honest two-second cleanup wait.
        await tx.repositories.sleep(1)
      }))
      const pid = await runningPidReady
      await waitForPgSleep(control, pid)

      await expect(storage.close()).resolves.toBeUndefined()
      await expect(running).rejects.toEqual(expect.objectContaining({
        name: 'StorageTransactionError',
        code: 'transaction_rollback_failed',
        phase: 'rollback',
        retryable: false,
        callbackInvoked: true,
      }))
      expect(storage.lifecycleState).toBe('closed')
      await waitForSessionGone(control, pid)
      const remaining = await control.query<{
        readonly pid: number
        readonly application_name: string
        readonly state: string
        readonly query: string
      }>(`
        SELECT pid, application_name, state, query FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
      `)
      expect(remaining.rows).toEqual([])
    } finally {
      await control.end().catch(() => {})
      await storage.close().catch(() => {})
      await database.close()
    }
  })
})
