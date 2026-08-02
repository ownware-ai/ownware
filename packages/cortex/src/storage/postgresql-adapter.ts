import { AsyncLocalStorage } from 'node:async_hooks'
import { readFile } from 'node:fs/promises'
import {
  PostgreSqlStorageError,
  StorageLifecycleError,
  StorageTransactionError,
  type StorageAdapter,
  type StorageHealth,
  type StorageLifecycleErrorCode,
  type StorageLifecycleState,
  type StorageTransactionOptions,
  type TransactionStorage,
} from './contracts.js'
import {
  resolvePostgreSqlConnection,
  StorageConfigurationError,
  type PostgreSqlConnectionSource,
  type ResolvedPostgreSqlConnection,
  type ValidatedPostgreSqlPlan,
} from './config.js'
import {
  loadPostgreSqlDriver,
  type PostgreSqlClient,
  type PostgreSqlClientConfig,
  type PostgreSqlDriver,
  type PostgreSqlPool,
  type PostgreSqlPoolClient,
  type PostgreSqlPoolConfig,
} from './postgresql-driver.js'
import {
  POSTGRESQL_MIGRATION_MANIFEST,
  applyPostgreSqlMigrationManifest,
  postgreSqlMigrationFingerprint,
  validatePostgreSqlMigrationManifest,
  type PostgreSqlMigrationHistoryRow,
  type PostgreSqlMigrationManifest,
} from './postgresql-migrations.js'

export interface PostgreSqlRootRepositoryContext {
  readonly pool: PostgreSqlPool
  /** Every adapter-native root operation must call this before database work. */
  assertActive(): void
}

export interface PostgreSqlTransactionRepositoryContext {
  readonly client: PostgreSqlPoolClient
  /** Every transaction-repository operation must call this before database work. */
  assertActive(): void
}

export interface PostgreSqlRepositoryFactories<R extends object, TransactionR extends object> {
  createRoot(context: PostgreSqlRootRepositoryContext): R
  createTransaction(context: PostgreSqlTransactionRepositoryContext): TransactionR
}

export interface PostgreSqlStorageAdapterOptions<R extends object, TransactionR extends object> {
  readonly plan: ValidatedPostgreSqlPlan
  readonly repositories: PostgreSqlRepositoryFactories<R, TransactionR>
  /** Test seam. Production always uses the lazy optional-peer loader. */
  readonly loadDriver?: () => Promise<PostgreSqlDriver>
  /** Test seam for environment-owned connection references. */
  readonly environment?: Readonly<Record<string, string | undefined>>
  /**
   * Internal immutable dialect manifest. Production uses the compiled manifest;
   * compatibility tests supply older/newer binary manifests through this seam.
   */
  readonly migrationManifest?: PostgreSqlMigrationManifest
}

interface ConnectionFactsRow {
  readonly version: string
  readonly database: string
  readonly user_name: string
  readonly ssl: boolean
}

interface SchemaRow {
  readonly owner_name: string
  readonly object_count: string
  readonly migration_table_exists: boolean
}

interface RuntimePrivilegeRow {
  readonly schema_usage: boolean
  readonly tables_allowed: boolean
  readonly sequences_allowed: boolean
}

interface Scope {
  active: boolean
}

const MIGRATION_LOCK_NAMESPACE = 1_335_664_962
const MIGRATION_LOCK_KEY = 0

/** Minimum current minor releases certified on 2026-08-02. */
const MINIMUM_POSTGRESQL_VERSION: Readonly<Record<number, number>> = Object.freeze({
  16: 160_014,
  17: 170_010,
  18: 180_004,
})

/** Exact server-version support predicate used by connection preflight. */
export function isSupportedPostgreSqlVersion(version: number): boolean {
  if (!Number.isSafeInteger(version)) return false
  const major = Math.floor(version / 10_000)
  const minimum = MINIMUM_POSTGRESQL_VERSION[major]
  return minimum !== undefined && version >= minimum && version < (major + 1) * 10_000
}

function pgCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { readonly code?: unknown }).code ?? '')
    : ''
}

function retryableConnectionCode(code: string): boolean {
  return code.startsWith('08') || code === '57P01' || code === '57P02' || code === '57P03'
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function validTransactionOptions(options: StorageTransactionOptions): boolean {
  return (options.mode === 'read' || options.mode === 'write') &&
    (options.isolation === 'read-committed' || options.isolation === 'serializable') &&
    options.retry === 'never'
}

async function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * PostgreSQL lifecycle, migration and transaction owner.
 *
 * One dedicated migration client holds the advisory lock and transaction.
 * Runtime work uses one pool. Neither raw client nor connection material is
 * exposed beyond adapter-owned repository contexts.
 */
export class PostgreSqlStorageAdapter<
  R extends object,
  TransactionR extends object,
> implements StorageAdapter<R, TransactionR> {
  readonly kind = 'postgresql' as const
  private state: StorageLifecycleState = 'new'
  private rootRepositories: R | null = null
  private pool: PostgreSqlPool | null = null
  private initializePromise: Promise<void> | null = null
  private closePromise: Promise<void> | null = null
  private closeRequested = false
  private initializingClient: PostgreSqlClient | null = null
  private readonly activeTransactionClients = new Set<PostgreSqlPoolClient>()
  private readonly transactionContext = new AsyncLocalStorage<boolean>()
  private savepointSequence = 0
  private backgroundPoolError = false
  private readonly initializationAbort = new AbortController()
  private readonly onPoolError = (): void => {
    // The driver error is intentionally not logged or retained.
    this.backgroundPoolError = true
  }

  constructor(private readonly options: PostgreSqlStorageAdapterOptions<R, TransactionR>) {}

  get lifecycleState(): StorageLifecycleState {
    return this.state
  }

  get repositories(): R {
    if (this.state !== 'ready' || this.rootRepositories === null) {
      return this.failLifecycle('repository_unavailable')
    }
    return this.rootRepositories
  }

  initialize(): Promise<void> {
    if (this.state === 'ready') return Promise.resolve()
    if (this.state === 'initializing' && this.initializePromise !== null) {
      return this.initializePromise
    }
    if (this.state === 'closing' || this.state === 'closed') {
      return Promise.reject(this.lifecycleError('initialize_after_close'))
    }
    if (this.state === 'failed') {
      return Promise.reject(this.lifecycleError('initialize_after_failure'))
    }

    this.state = 'initializing'
    this.initializePromise = this.initializeInternal().catch(async (error: unknown) => {
      await this.disposePool(false)
      if (!this.closeRequested) this.state = 'failed'
      throw error
    })
    return this.initializePromise
  }

  private async initializeInternal(): Promise<void> {
    await Promise.resolve()
    this.assertInitializationActive()
    validatePostgreSqlMigrationManifest(this.migrationManifest)
    const driver = await (this.options.loadDriver ?? loadPostgreSqlDriver)()
    this.assertInitializationActive()

    const runtime = await this.resolveConnection(this.options.plan.runtimeConnection)
    const migration = this.options.plan.migrationConnection === undefined ||
      this.options.plan.migrationConnection === this.options.plan.runtimeConnection
      ? runtime
      : await this.resolveConnection(this.options.plan.migrationConnection)
    const ssl = await this.createSslConfiguration()
    this.assertInitializationActive()

    await this.runMigrations(driver, migration, runtime.user, ssl)
    this.assertInitializationActive()
    await this.openRuntimePool(driver, runtime, ssl)
    this.assertInitializationActive()

    const pool = this.pool
    if (pool === null) throw new PostgreSqlStorageError('connection_failed', 'runtime', true)
    this.rootRepositories = this.options.repositories.createRoot({
      pool,
      assertActive: () => {
        if (this.transactionContext.getStore() === true) {
          throw this.lifecycleError('root_access_during_transaction')
        }
        if (this.state !== 'ready') throw this.lifecycleError('repository_unavailable')
      },
    })
    this.state = 'ready'
  }

  private async resolveConnection(
    source: PostgreSqlConnectionSource,
  ): Promise<ResolvedPostgreSqlConnection> {
    const resolved = await bounded(
      resolvePostgreSqlConnection(
        source,
        this.options.plan.tls,
        this.options.environment ?? process.env,
        this.initializationAbort.signal,
      ),
      this.options.plan.pool.connectionTimeoutMs,
    )
    if (resolved === undefined) {
      throw new StorageConfigurationError('postgresql_connection_resolution_timeout')
    }
    return resolved
  }

  private async createSslConfiguration(): Promise<PostgreSqlClientConfig['ssl']> {
    const tls = this.options.plan.tls
    if (tls.mode === 'disable') return false
    if (tls.ca === undefined || tls.ca.source === 'system') {
      return { rejectUnauthorized: true }
    }
    let ca: Buffer
    try {
      ca = await readFile(tls.ca.path)
    } catch {
      throw new PostgreSqlStorageError('ca_unreadable', 'configuration', false)
    }
    return { rejectUnauthorized: true, ca }
  }

  private clientConfig(
    connection: ResolvedPostgreSqlConnection,
    ssl: PostgreSqlClientConfig['ssl'],
    applicationName: string,
    migration: boolean,
  ): PostgreSqlClientConfig {
    return {
      connectionString: connection.connectionString,
      ssl,
      application_name: applicationName,
      connectionTimeoutMillis: this.options.plan.pool.connectionTimeoutMs,
      statement_timeout: migration
        ? this.options.plan.pool.migrationTimeoutMs
        : this.options.plan.pool.statementTimeoutMs,
      lock_timeout: this.options.plan.pool.lockTimeoutMs,
      query_timeout: migration
        ? this.options.plan.pool.migrationTimeoutMs
        : this.options.plan.pool.statementTimeoutMs,
    }
  }

  private async runMigrations(
    driver: PostgreSqlDriver,
    migration: ResolvedPostgreSqlConnection,
    runtimeUser: string,
    ssl: PostgreSqlClientConfig['ssl'],
  ): Promise<void> {
    const client = new driver.Client(this.clientConfig(
      migration,
      ssl,
      'ownware-storage-migration',
      true,
    ))
    this.initializingClient = client
    let transactionOpen = false
    let connectionDropped = false
    const onError = (): void => { connectionDropped = true }
    client.on('error', onError)
    try {
      try {
        await client.connect()
      } catch (error) {
        throw new PostgreSqlStorageError(
          'connection_failed',
          'migration',
          retryableConnectionCode(pgCode(error)),
        )
      }
      this.assertInitializationActive()
      await client.query('BEGIN')
      transactionOpen = true
      await client.query(`SET LOCAL statement_timeout = '${this.options.plan.pool.migrationTimeoutMs}ms'`)
      await client.query(`SET LOCAL lock_timeout = '${this.options.plan.pool.lockTimeoutMs}ms'`)
      try {
        await client.query('SELECT pg_advisory_xact_lock($1, $2)', [
          MIGRATION_LOCK_NAMESPACE,
          MIGRATION_LOCK_KEY,
        ])
      } catch (error) {
        const code = pgCode(error)
        if (code === '55P03' || code === '57014') {
          throw new PostgreSqlStorageError('migration_lock_timeout', 'migration', true)
        }
        throw error
      }
      this.assertInitializationActive()
      await this.assertConnectionFacts(client, migration, 'migration')
      await this.ensureSchemaAndMigrations(client, runtimeUser)
      await client.query('COMMIT')
      transactionOpen = false
    } catch (error) {
      if (transactionOpen) await client.query('ROLLBACK').catch(() => {})
      if (error instanceof PostgreSqlStorageError || error instanceof StorageLifecycleError) {
        throw error
      }
      const code = pgCode(error)
      if (code === '42501' || code === '42704') {
        throw new PostgreSqlStorageError('migration_permission_denied', 'migration', false)
      }
      throw new PostgreSqlStorageError(
        connectionDropped || retryableConnectionCode(code)
          ? 'connection_dropped'
          : 'migration_failed',
        'migration',
        connectionDropped || retryableConnectionCode(code),
      )
    } finally {
      client.off('error', onError)
      await client.end().catch(() => {})
      if (this.initializingClient === client) this.initializingClient = null
    }
  }

  private async assertConnectionFacts(
    client: Pick<PostgreSqlClient | PostgreSqlPoolClient, 'query'>,
    expected: ResolvedPostgreSqlConnection,
    phase: 'migration' | 'runtime',
  ): Promise<void> {
    const result = await client.query<ConnectionFactsRow>(`
      SELECT
        current_setting('server_version_num') AS version,
        current_database() AS database,
        current_user AS user_name,
        COALESCE((
          SELECT ssl FROM pg_catalog.pg_stat_ssl WHERE pid = pg_backend_pid()
        ), false) AS ssl
    `)
    const facts = result.rows[0]
    if (facts === undefined) {
      throw new PostgreSqlStorageError('connection_failed', phase, true)
    }
    const version = Number(facts.version)
    if (!isSupportedPostgreSqlVersion(version)) {
      throw new PostgreSqlStorageError('server_version_unsupported', phase, false)
    }
    if (facts.database !== expected.database || facts.user_name !== expected.user) {
      throw new PostgreSqlStorageError('database_mismatch', phase, false)
    }
    if (this.options.plan.tls.mode === 'verify-full' && !facts.ssl) {
      throw new PostgreSqlStorageError('tls_required', phase, false)
    }
    if (this.options.plan.tls.mode === 'disable' && facts.ssl) {
      throw new PostgreSqlStorageError('tls_unexpected', phase, false)
    }
  }

  private get migrationManifest(): PostgreSqlMigrationManifest {
    return this.options.migrationManifest ?? POSTGRESQL_MIGRATION_MANIFEST
  }

  private async ensureSchemaAndMigrations(
    client: PostgreSqlClient,
    runtimeUser: string,
  ): Promise<void> {
    const result = await client.query<SchemaRow>(`
      SELECT
        pg_catalog.pg_get_userbyid(namespace.nspowner) AS owner_name,
        (SELECT count(*)::text FROM pg_catalog.pg_class AS relation
          WHERE relation.relnamespace = namespace.oid) AS object_count,
        pg_catalog.to_regclass('ownware._migrations') IS NOT NULL AS migration_table_exists
      FROM pg_catalog.pg_namespace AS namespace
      WHERE namespace.nspname = 'ownware'
    `)
    let schema = result.rows[0]
    if (schema === undefined) {
      await client.query('CREATE SCHEMA ownware AUTHORIZATION CURRENT_USER')
      schema = {
        owner_name: '',
        object_count: '0',
        migration_table_exists: false,
      }
    } else if (schema.owner_name === '') {
      throw new PostgreSqlStorageError('schema_owner_mismatch', 'migration', false)
    }

    // The current migration connection must own the fixed schema. PostgreSQL
    // has no safe general ALTER path for an ambiguously owned installation.
    const owner = await client.query<{ readonly owns_schema: boolean }>(`
      SELECT pg_catalog.pg_get_userbyid(namespace.nspowner) = current_user AS owns_schema
      FROM pg_catalog.pg_namespace AS namespace WHERE namespace.nspname = 'ownware'
    `)
    if (owner.rows[0]?.owns_schema !== true) {
      throw new PostgreSqlStorageError('schema_owner_mismatch', 'migration', false)
    }

    await client.query('SET LOCAL search_path TO ownware, pg_catalog')
    if (!schema.migration_table_exists) {
      if (Number(schema.object_count) !== 0) {
        throw new PostgreSqlStorageError('schema_unrecognized', 'migration', false)
      }
      await applyPostgreSqlMigrationManifest(client, this.migrationManifest, null)
    } else {
      const history = await client.query<PostgreSqlMigrationHistoryRow>(`
        SELECT version::text, name, fingerprint
        FROM ownware._migrations ORDER BY version
      `)
      await applyPostgreSqlMigrationManifest(client, this.migrationManifest, history.rows)
    }
    await this.grantRuntimePrivileges(client, runtimeUser)
  }

  private async grantRuntimePrivileges(client: PostgreSqlClient, runtimeUser: string): Promise<void> {
    const current = await client.query<{ readonly user_name: string }>('SELECT current_user AS user_name')
    if (current.rows[0]?.user_name === runtimeUser) return
    const role = quoteIdentifier(runtimeUser)
    await client.query(`GRANT USAGE ON SCHEMA ownware TO ${role}`)
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ownware TO ${role}`)
    await client.query(`REVOKE INSERT, UPDATE, DELETE ON TABLE ownware._migrations FROM ${role}`)
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ownware TO ${role}`)
    await client.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ownware TO ${role}`)
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ownware GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`)
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ownware GRANT USAGE, SELECT ON SEQUENCES TO ${role}`)
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA ownware GRANT EXECUTE ON FUNCTIONS TO ${role}`)
  }

  private async openRuntimePool(
    driver: PostgreSqlDriver,
    runtime: ResolvedPostgreSqlConnection,
    ssl: PostgreSqlClientConfig['ssl'],
  ): Promise<void> {
    const config: PostgreSqlPoolConfig = {
      ...this.clientConfig(runtime, ssl, 'ownware-storage-runtime', false),
      max: this.options.plan.pool.maxConnections,
      idleTimeoutMillis: this.options.plan.pool.idleTimeoutMs,
      allowExitOnIdle: false,
    }
    const pool = new driver.Pool(config)
    pool.on('error', this.onPoolError)
    this.pool = pool
    let client: PostgreSqlPoolClient | null = null
    try {
      client = await pool.connect()
      await this.assertConnectionFacts(client, runtime, 'runtime')
      if (!await this.migrationManifest.verifyCurrentSchema(client)) {
        throw new PostgreSqlStorageError('schema_manifest_mismatch', 'runtime', false)
      }
      const privilege = await client.query<RuntimePrivilegeRow>(`
        SELECT
          has_schema_privilege(current_user, 'ownware', 'USAGE') AS schema_usage,
          NOT EXISTS (
            SELECT 1 FROM pg_catalog.pg_class AS relation
            JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
            WHERE namespace.nspname = 'ownware' AND relation.relkind = 'r'
              AND NOT (
                has_table_privilege(current_user, relation.oid, 'SELECT')
                AND (
                  relation.relname = '_migrations'
                  OR (
                    has_table_privilege(current_user, relation.oid, 'INSERT')
                    AND has_table_privilege(current_user, relation.oid, 'UPDATE')
                    AND has_table_privilege(current_user, relation.oid, 'DELETE')
                  )
                )
              )
          ) AS tables_allowed,
          NOT EXISTS (
            SELECT 1 FROM pg_catalog.pg_class AS relation
            JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
            WHERE namespace.nspname = 'ownware' AND relation.relkind = 'S'
              AND NOT has_sequence_privilege(current_user, relation.oid, 'USAGE')
          ) AS sequences_allowed
      `)
      const row = privilege.rows[0]
      if (
        row === undefined || !row.schema_usage ||
        !row.tables_allowed || !row.sequences_allowed
      ) {
        throw new PostgreSqlStorageError('runtime_permission_denied', 'runtime', false)
      }
    } catch (error) {
      if (error instanceof PostgreSqlStorageError) throw error
      const code = pgCode(error)
      if (code === '42501') {
        throw new PostgreSqlStorageError('runtime_permission_denied', 'runtime', false)
      }
      throw new PostgreSqlStorageError(
        'connection_failed',
        'runtime',
        retryableConnectionCode(code),
      )
    } finally {
      client?.release()
    }
  }

  async health(): Promise<StorageHealth> {
    const pool = this.pool
    if (this.state !== 'ready' || pool === null) {
      return {
        kind: 'postgresql',
        state: 'unavailable',
        schemaVersion: 0,
        code: `lifecycle_${this.state}`,
      }
    }
    const started = performance.now()
    try {
      const head = this.migrationManifest.migrations.at(-1)
      if (head === undefined) throw new Error('unrecognized')
      const result = await pool.query<{ readonly version: string }>(`
        SELECT version::text FROM ownware._migrations
        WHERE version = $1 AND name = $2 AND fingerprint = $3
          AND (SELECT count(*) FROM ownware._migrations) = $4
          AND NOT EXISTS (
            SELECT 1 FROM ownware._migrations WHERE version > $1
          )
      `, [
        head.version,
        head.name,
        postgreSqlMigrationFingerprint(head),
        this.migrationManifest.migrations.length,
      ])
      if (result.rows[0] === undefined) throw new Error('unrecognized')
      const degraded = this.backgroundPoolError
      this.backgroundPoolError = false
      return {
        kind: 'postgresql',
        state: degraded ? 'degraded' : 'ready',
        schemaVersion: Number(result.rows[0].version),
        latencyMs: Math.max(0, performance.now() - started),
        ...(degraded ? { code: 'postgresql_background_connection_recovered' } : {}),
      }
    } catch {
      return {
        kind: 'postgresql',
        state: 'unavailable',
        schemaVersion: 0,
        code: 'postgresql_health_failed',
      }
    }
  }

  async transaction<T>(
    options: StorageTransactionOptions,
    fn: (tx: TransactionStorage<TransactionR>) => Promise<T>,
  ): Promise<T> {
    if (!validTransactionOptions(options)) {
      throw this.lifecycleError('transaction_options_invalid')
    }
    if (this.transactionContext.getStore() === true) {
      throw this.lifecycleError('nested_transaction_requires_savepoint')
    }
    const pool = this.pool
    if (this.state !== 'ready' || pool === null) {
      throw this.lifecycleError('transaction_unavailable')
    }
    let client: PostgreSqlPoolClient
    try {
      client = await pool.connect()
    } catch (error) {
      throw new StorageTransactionError(
        'transaction_begin_failed',
        'postgresql',
        'begin',
        retryableConnectionCode(pgCode(error)),
        false,
      )
    }
    this.activeTransactionClients.add(client)
    let clientConnectionLost = false
    let discardClient = false
    const onClientError = (): void => {
      // Keep only the authoritative connection-state signal; never retain or log
      // the driver error because it may contain tenant connection material.
      clientConnectionLost = true
      discardClient = true
    }
    client.on('error', onClientError)
    const scope: Scope = { active: true }
    let callbackInvoked = false
    try {
      const isolation = options.isolation === 'serializable' ? 'SERIALIZABLE' : 'READ COMMITTED'
      const access = options.mode === 'read' ? 'READ ONLY' : 'READ WRITE'
      try {
        await client.query(`BEGIN ISOLATION LEVEL ${isolation} ${access}`)
      } catch (error) {
        discardClient ||= retryableConnectionCode(pgCode(error))
        throw new StorageTransactionError(
          'transaction_begin_failed',
          'postgresql',
          'begin',
          retryableConnectionCode(pgCode(error)),
          false,
        )
      }
      let value: T
      try {
        const transaction = this.createTransaction(client, scope)
        callbackInvoked = true
        value = await this.transactionContext.run(true, async () => fn(transaction))
      } catch (error) {
        try {
          await client.query('ROLLBACK')
        } catch (rollbackError) {
          discardClient = true
          throw new StorageTransactionError(
            'transaction_rollback_failed',
            'postgresql',
            'rollback',
            clientConnectionLost || retryableConnectionCode(pgCode(rollbackError)),
            true,
          )
        }
        throw error
      }
      try {
        await client.query('COMMIT')
      } catch (error) {
        const commitCode = pgCode(error)
        discardClient ||= retryableConnectionCode(commitCode)
        await client.query('ROLLBACK').catch(() => { discardClient = true })
        throw new StorageTransactionError(
          'transaction_commit_failed',
          'postgresql',
          'commit',
          clientConnectionLost || commitCode === '40001' ||
            retryableConnectionCode(commitCode),
          true,
        )
      }
      return value
    } finally {
      scope.active = false
      const ownsClient = this.activeTransactionClients.delete(client)
      client.off('error', onClientError)
      // A broken transaction connection must not return to the pool.
      if (ownsClient) {
        client.release(
          discardClient || this.state !== 'ready' ||
            (callbackInvoked && this.closeRequested),
        )
      }
    }
  }

  private createTransaction(
    client: PostgreSqlPoolClient,
    scope: Scope,
  ): TransactionStorage<TransactionR> {
    const assertActive = (): void => {
      if (!scope.active) throw this.lifecycleError('transaction_scope_expired')
    }
    const repositories = this.options.repositories.createTransaction({ client, assertActive })
    return {
      repositories,
      savepoint: async <T>(fn: (nested: TransactionStorage<TransactionR>) => Promise<T>) => {
        assertActive()
        const name = `ownware_sp_${++this.savepointSequence}`
        await client.query(`SAVEPOINT ${name}`)
        const nestedScope: Scope = { active: true }
        const nested = this.createTransaction(client, nestedScope)
        try {
          const value = await fn(nested)
          await client.query(`RELEASE SAVEPOINT ${name}`)
          return value
        } catch (error) {
          await client.query(`ROLLBACK TO SAVEPOINT ${name}`)
          await client.query(`RELEASE SAVEPOINT ${name}`)
          throw error
        } finally {
          nestedScope.active = false
        }
      },
    }
  }

  close(): Promise<void> {
    if (this.state === 'closed') return Promise.resolve()
    if (this.closePromise !== null) return this.closePromise
    this.closeRequested = true
    this.initializationAbort.abort()
    this.state = 'closing'
    this.closePromise = this.closeInternal()
    return this.closePromise
  }

  private async closeInternal(): Promise<void> {
    const initializing = this.initializingClient
    if (initializing !== null) {
      await bounded(
        initializing.end().catch(() => {}),
        this.options.plan.pool.shutdownTimeoutMs,
      )
    }
    let initializationStopped = true
    if (this.initializePromise !== null) {
      initializationStopped = await bounded(
        this.initializePromise.then(() => true, () => true),
        this.options.plan.pool.shutdownTimeoutMs,
      ) === true
    }
    const completed = await this.disposePool(true)
    this.rootRepositories = null
    this.state = 'closed'
    if (!completed || !initializationStopped) {
      throw new PostgreSqlStorageError('shutdown_timeout', 'shutdown', true)
    }
  }

  private async disposePool(enforceTimeout: boolean): Promise<boolean> {
    const pool = this.pool
    if (pool === null) return true
    this.pool = null
    pool.off('error', this.onPoolError)
    const ending = pool.end().then(() => true, () => true)
    if (!enforceTimeout) {
      await ending
      return true
    }
    const first = await bounded(ending, this.options.plan.pool.shutdownTimeoutMs)
    if (first === true) return true
    for (const client of this.activeTransactionClients) client.release(true)
    this.activeTransactionClients.clear()
    return await bounded(ending, 1_000) === true
  }

  private assertInitializationActive(): void {
    if (this.closeRequested) throw this.lifecycleError('initialize_cancelled')
  }

  private lifecycleError(code: StorageLifecycleErrorCode): StorageLifecycleError {
    return new StorageLifecycleError(code, 'postgresql', this.state)
  }

  private failLifecycle(code: StorageLifecycleErrorCode): never {
    throw this.lifecycleError(code)
  }
}
