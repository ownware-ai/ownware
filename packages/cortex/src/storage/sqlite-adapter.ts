import { AsyncLocalStorage } from 'node:async_hooks'
import { CortexDatabase } from '../gateway/db/database.js'
import type {
  StorageAdapter,
  StorageHealth,
  StorageLifecycleState,
  StorageTransactionOptions,
  TransactionStorage,
} from './contracts.js'
import { StorageLifecycleError, StorageTransactionError } from './contracts.js'
import type { SqliteDatabase } from './sqlite-driver.js'

export interface SqliteRootRepositoryContext {
  readonly database: SqliteDatabase
  /** Transitional bridge for the existing synchronous GatewayState surface. */
  readonly legacyDatabase: CortexDatabase
  /** Every adapter-native root operation must call this before database work. */
  assertActive(): void
}

export interface SqliteTransactionRepositoryContext {
  readonly database: SqliteDatabase
  /** Every transaction-repository operation must call this before database work. */
  assertActive(): void
}

export interface SqliteRepositoryFactories<
  R extends object,
  TransactionR extends object,
> {
  createRoot(context: SqliteRootRepositoryContext): R
  createTransaction(context: SqliteTransactionRepositoryContext): TransactionR
}

export interface SqliteStorageAdapterOptions<
  R extends object,
  TransactionR extends object,
> {
  readonly dbPath?: string
  /**
   * `eager` preserves the current pre-1.0 constructor-time SQLite failure
   * contract. `on-initialize` is the final lifecycle shape used by tests and
   * future non-legacy construction paths.
   */
  readonly openMode: 'eager' | 'on-initialize'
  readonly repositories: SqliteRepositoryFactories<R, TransactionR>
}

interface Scope {
  active: boolean
}

interface ExclusiveRelease {
  resolve(): void
}

/**
 * SQLite lifecycle and transaction owner.
 *
 * better-sqlite3 remains synchronous internally. Async callbacks are supported
 * by explicit BEGIN/COMMIT and a per-adapter queue; they are never passed to
 * better-sqlite3's synchronous `transaction()` helper. Adapter-native root
 * repository contexts carry mandatory operation guards: root operations fail
 * closed while the transaction is open, and transaction operations expire at
 * commit/rollback. Repository factories must call the supplied guard at every
 * operation boundary; their shared contract tests prove that discipline. The
 * legacy CortexDatabase bridge is intentionally outside that guarantee until
 * its callers are ported.
 */
export class SqliteStorageAdapter<
  R extends object,
  TransactionR extends object,
> implements StorageAdapter<R, TransactionR> {
  readonly kind = 'sqlite' as const
  private state: StorageLifecycleState = 'new'
  private database: CortexDatabase | null = null
  private rootRepositories: R | null = null
  private initializePromise: Promise<void> | null = null
  private closePromise: Promise<void> | null = null
  private closeRequested = false
  private transactionTail: Promise<void> = Promise.resolve()
  private pendingTransactions = 0
  private transactionActive = false
  private savepointSequence = 0
  private readonly transactionContext = new AsyncLocalStorage<boolean>()

  constructor(private readonly options: SqliteStorageAdapterOptions<R, TransactionR>) {
    if (options.openMode === 'eager') this.openSynchronously()
  }

  get lifecycleState(): StorageLifecycleState {
    return this.state
  }

  get repositories(): R {
    if (this.state !== 'ready' || this.rootRepositories === null) {
      return this.fail('repository_unavailable')
    }
    return this.rootRepositories
  }

  /** Compatibility bridge only; new repositories belong in the factories. */
  get legacyDatabase(): CortexDatabase {
    if (this.state !== 'ready' || this.database === null) {
      return this.fail('repository_unavailable')
    }
    return this.database
  }

  initialize(): Promise<void> {
    if (this.state === 'ready') return Promise.resolve()
    if (this.state === 'initializing' && this.initializePromise !== null) {
      return this.initializePromise
    }
    if (this.state === 'closing' || this.state === 'closed') {
      return Promise.reject(this.error('initialize_after_close'))
    }
    if (this.state === 'failed') {
      return Promise.reject(this.error('initialize_after_failure'))
    }

    this.state = 'initializing'
    this.initializePromise = (async () => {
      // Make initialize genuinely asynchronous and give an immediate close a
      // deterministic cancellation point before SQLite is opened.
      await Promise.resolve()
      if (this.closeRequested) throw this.error('initialize_cancelled')
      this.openSynchronously()
    })().catch((error: unknown) => {
      if (!this.closeRequested) this.state = 'failed'
      throw error
    })
    return this.initializePromise
  }

  async health(): Promise<StorageHealth> {
    if (this.state !== 'ready' || this.database === null) {
      return {
        kind: 'sqlite',
        state: 'unavailable',
        schemaVersion: 0,
        code: `lifecycle_${this.state}`,
      }
    }
    const started = performance.now()
    try {
      this.database.rawMainHandle.prepare('SELECT 1').get()
      const schemaVersion = this.database.rawMainHandle.pragma(
        'user_version',
        { simple: true },
      ) as number
      return {
        kind: 'sqlite',
        state: 'ready',
        schemaVersion,
        latencyMs: Math.max(0, performance.now() - started),
      }
    } catch {
      return {
        kind: 'sqlite',
        state: 'unavailable',
        schemaVersion: 0,
        code: 'sqlite_health_failed',
      }
    }
  }

  transaction<T>(
    options: StorageTransactionOptions,
    fn: (tx: TransactionStorage<TransactionR>) => Promise<T>,
  ): Promise<T> {
    if (!this.validTransactionOptions(options)) {
      return Promise.reject(this.error('transaction_options_invalid'))
    }
    if (this.transactionContext.getStore() === true) {
      return Promise.reject(this.error('nested_transaction_requires_savepoint'))
    }
    if (this.state !== 'ready' || this.database === null) {
      return Promise.reject(this.error('transaction_unavailable'))
    }
    this.pendingTransactions += 1
    return this.runExclusive(async () => {
      if (this.state !== 'ready' || this.database === null) {
        return this.fail('transaction_unavailable')
      }
      const raw = this.database.rawMainHandle
      this.transactionActive = true
      const scope: Scope = { active: true }
      try {
        try {
          // SQLite provides serializable isolation. A requested
          // read-committed transaction therefore receives stronger isolation,
          // never a weaker emulation.
          raw.exec(options.mode === 'write' ? 'BEGIN IMMEDIATE' : 'BEGIN')
        } catch (error) {
          throw this.transactionError('begin', error, false)
        }
        let transaction: TransactionStorage<TransactionR>
        try {
          transaction = this.createTransaction(raw, scope)
        } catch (error) {
          try {
            if (raw.inTransaction) raw.exec('ROLLBACK')
          } catch (rollbackError) {
            this.state = 'failed'
            throw this.transactionError('rollback', rollbackError, false)
          }
          throw error
        }
        let result: T
        try {
          result = await this.transactionContext.run(
            true,
            async () => fn(transaction),
          )
        } catch (error) {
          try {
            if (raw.inTransaction) raw.exec('ROLLBACK')
          } catch (rollbackError) {
            this.state = 'failed'
            throw this.transactionError('rollback', rollbackError, true)
          }
          throw error
        }
        try {
          raw.exec('COMMIT')
        } catch (error) {
          try {
            if (raw.inTransaction) raw.exec('ROLLBACK')
          } catch (rollbackError) {
            this.state = 'failed'
            throw this.transactionError('rollback', rollbackError, true)
          }
          throw this.transactionError('commit', error, true)
        }
        return result
      } finally {
        scope.active = false
        this.transactionActive = false
      }
    }).finally(() => {
      this.pendingTransactions -= 1
    })
  }

  close(): Promise<void> {
    if (this.closePromise !== null) return this.closePromise
    this.closeRequested = true
    this.closePromise = this.closeAfterPendingWork()
    return this.closePromise
  }

  /**
   * Temporary synchronous close for existing direct GatewayState users.
   * It refuses rather than abandoning an initializing or queued transaction.
   */
  closeSynchronouslyForLegacyCaller(): void {
    if (this.state === 'closed') return
    if (this.state === 'initializing' || this.pendingTransactions > 0) {
      return this.fail('synchronous_close_while_busy')
    }
    this.closeRequested = true
    this.state = 'closing'
    this.closeDatabase()
    this.state = 'closed'
  }

  private openSynchronously(): void {
    if (this.state !== 'new' && this.state !== 'initializing') {
      return this.fail('repository_unavailable')
    }
    let opened: CortexDatabase | null = null
    try {
      opened = new CortexDatabase(this.options.dbPath)
      this.database = opened
      const raw = opened.rawMainHandle
      this.rootRepositories = this.options.repositories.createRoot({
        database: raw,
        legacyDatabase: opened,
        assertActive: () => this.assertRootActive(),
      })
      this.state = 'ready'
    } catch (error) {
      try { opened?.close() } catch { /* original open/factory failure wins */ }
      this.database = null
      this.rootRepositories = null
      this.state = 'failed'
      throw error
    }
  }

  private createTransaction(
    database: SqliteDatabase,
    scope: Scope,
  ): TransactionStorage<TransactionR> {
    const repositories = this.options.repositories.createTransaction({
      database,
      assertActive: () => {
        if (!scope.active || !database.open) {
          return this.fail('transaction_scope_expired')
        }
      },
    })
    return {
      repositories,
      savepoint: async <T>(
        fn: (nested: TransactionStorage<TransactionR>) => Promise<T>,
      ): Promise<T> => {
        if (!scope.active || !database.open) {
          return this.fail('transaction_scope_expired')
        }
        const name = `ownware_storage_${this.savepointSequence++}`
        database.exec(`SAVEPOINT ${name}`)
        const nestedScope: Scope = { active: true }
        let nestedCallbackInvoked = false
        try {
          const nested = this.createTransaction(database, nestedScope)
          nestedCallbackInvoked = true
          const result = await fn(nested)
          database.exec(`RELEASE SAVEPOINT ${name}`)
          return result
        } catch (error) {
          try {
            database.exec(`ROLLBACK TO SAVEPOINT ${name}`)
            database.exec(`RELEASE SAVEPOINT ${name}`)
          } catch (rollbackError) {
            this.state = 'failed'
            throw this.transactionError('rollback', rollbackError, nestedCallbackInvoked)
          }
          throw error
        } finally {
          nestedScope.active = false
        }
      },
    }
  }

  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const predecessor = this.transactionTail
    let release: ExclusiveRelease | undefined
    this.transactionTail = new Promise<void>((resolve) => {
      release = { resolve }
    })
    return (async () => {
      await predecessor
      try {
        return await fn()
      } finally {
        release!.resolve()
      }
    })()
  }

  private async closeAfterPendingWork(): Promise<void> {
    if (this.state === 'closed') return
    if (this.state === 'initializing' && this.initializePromise !== null) {
      try { await this.initializePromise } catch { /* close owns cleanup */ }
    }
    if (this.state === 'ready') this.state = 'closing'
    await this.transactionTail
    this.closeDatabase()
    this.state = 'closed'
  }

  private closeDatabase(): void {
    const database = this.database
    this.database = null
    this.rootRepositories = null
    if (database?.rawMainHandle.open) database.close()
  }

  private assertRootActive(): void {
    if (this.state !== 'ready' || this.database === null) {
      return this.fail('repository_unavailable')
    }
    if (this.transactionActive) return this.fail('root_access_during_transaction')
  }

  private validTransactionOptions(options: StorageTransactionOptions): boolean {
    return options !== null && typeof options === 'object' &&
      (options.mode === 'read' || options.mode === 'write') &&
      (options.isolation === 'read-committed' || options.isolation === 'serializable') &&
      options.retry === 'never'
  }

  private transactionError(
    phase: 'begin' | 'commit' | 'rollback',
    error: unknown,
    callbackInvoked: boolean,
  ): StorageTransactionError {
    const nativeCode = error !== null && typeof error === 'object' &&
      'code' in error && typeof error.code === 'string'
      ? error.code
      : undefined
    const busy = phase === 'begin' &&
      (nativeCode === 'SQLITE_BUSY' || nativeCode === 'SQLITE_LOCKED')
    return new StorageTransactionError(
      busy
        ? 'transaction_busy'
        : phase === 'begin'
          ? 'transaction_begin_failed'
          : phase === 'commit'
            ? 'transaction_commit_failed'
            : 'transaction_rollback_failed',
      'sqlite',
      phase,
      busy,
      callbackInvoked,
    )
  }

  private error(code: ConstructorParameters<typeof StorageLifecycleError>[0]): StorageLifecycleError {
    return new StorageLifecycleError(code, 'sqlite', this.state)
  }

  private fail(code: ConstructorParameters<typeof StorageLifecycleError>[0]): never {
    throw this.error(code)
  }
}
