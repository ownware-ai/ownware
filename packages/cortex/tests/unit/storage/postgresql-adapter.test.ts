import { describe, expect, it, vi } from 'vitest'
import {
  PostgreSqlStorageAdapter,
  type PostgreSqlRepositoryFactories,
} from '../../../src/storage/postgresql-adapter.js'
import {
  StorageConfigurationError,
  validateStoragePlan,
  type ProviderPostgreSqlConnectionSource,
  type ValidatedPostgreSqlPlan,
} from '../../../src/storage/config.js'
import { PostgreSqlStorageError } from '../../../src/storage/contracts.js'
import type { PostgreSqlDriver } from '../../../src/storage/postgresql-driver.js'
import {
  POSTGRESQL_MIGRATION_MANIFEST,
  type PostgreSqlMigrationManifest,
} from '../../../src/storage/postgresql-migrations.js'

interface EmptyRepositories {}

const EMPTY_FACTORIES: PostgreSqlRepositoryFactories<EmptyRepositories, EmptyRepositories> = {
  createRoot: () => ({}),
  createTransaction: () => ({}),
}

function selected(
  source: ProviderPostgreSqlConnectionSource,
  options: {
    readonly connectionTimeoutMs?: number
    readonly caPath?: string
  } = {},
): ValidatedPostgreSqlPlan {
  const plan = validateStoragePlan({
    storage: {
      kind: 'postgresql',
      runtimeConnection: source,
      tls: options.caPath === undefined
        ? { mode: 'disable', allowInsecureLoopback: true }
        : { mode: 'verify-full', ca: { source: 'file', path: options.caPath } },
      pool: { connectionTimeoutMs: options.connectionTimeoutMs ?? 100 },
    },
  }, '/unused.db')
  if (plan.kind !== 'postgresql') throw new Error('Expected PostgreSQL plan.')
  return plan
}

function unusedDriver(): PostgreSqlDriver {
  class UnexpectedClient {
    constructor() {
      throw new Error('Driver client must not be constructed in this test.')
    }
  }
  class UnexpectedPool {
    constructor() {
      throw new Error('Driver pool must not be constructed in this test.')
    }
  }
  return {
    Client: UnexpectedClient,
    Pool: UnexpectedPool,
  } as unknown as PostgreSqlDriver
}

describe('PostgreSQL adapter pre-connection lifecycle', () => {
  it('refuses an invalid compiled migration manifest before driver or secret resolution', async () => {
    const resolve = vi.fn(() => 'postgresql://user:secret-canary@localhost/db')
    const loadDriver = vi.fn(async () => unusedDriver())
    const invalidManifest: PostgreSqlMigrationManifest = {
      migrations: [
        ...POSTGRESQL_MIGRATION_MANIFEST.migrations,
        {
          version: 84,
          name: '084_gap',
          sql: 'SELECT 1',
          verifyApplied: async () => true,
        },
      ],
      logicalMigrations: [{ version: 84, name: '084_gap' }],
      verifyCurrentSchema: async () => true,
    }
    const storage = new PostgreSqlStorageAdapter({
      plan: selected({ source: 'provider', resolve }),
      repositories: EMPTY_FACTORIES,
      loadDriver,
      migrationManifest: invalidManifest,
    })

    await expect(storage.initialize()).rejects.toEqual(expect.objectContaining({
      code: 'schema_history_diverged',
      phase: 'migration',
      retryable: false,
    }))
    expect(loadDriver).not.toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
    await storage.close()
  })

  it('reports a missing optional peer before resolving tenant connection material', async () => {
    const resolve = vi.fn(() => 'postgresql://user:secret-canary@localhost/db')
    const storage = new PostgreSqlStorageAdapter({
      plan: selected({ source: 'provider', resolve }),
      repositories: EMPTY_FACTORIES,
      loadDriver: async () => {
        throw new PostgreSqlStorageError('driver_missing', 'driver', false)
      },
    })

    await expect(storage.initialize()).rejects.toEqual(expect.objectContaining({
      code: 'driver_missing',
    }))
    expect(resolve).not.toHaveBeenCalled()
    expect(storage.lifecycleState).toBe('failed')
    await storage.close()
    expect(storage.lifecycleState).toBe('closed')
  })

  it('aborts an in-flight provider and closes without constructing a client', async () => {
    let observedSignal: AbortSignal | undefined
    const resolve = vi.fn((signal: AbortSignal) => {
      observedSignal = signal
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('secret-canary')), { once: true })
      })
    })
    const storage = new PostgreSqlStorageAdapter({
      plan: selected({ source: 'provider', resolve }, { connectionTimeoutMs: 5_000 }),
      repositories: EMPTY_FACTORIES,
      loadDriver: async () => unusedDriver(),
    })

    const initializing = storage.initialize()
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledOnce())
    await expect(storage.close()).resolves.toBeUndefined()
    await expect(initializing).rejects.toEqual(expect.objectContaining({
      code: 'postgresql_connection_resolution_failed',
    }))
    expect(observedSignal?.aborted).toBe(true)
    expect(storage.lifecycleState).toBe('closed')
  })

  it('bounds a provider that ignores cancellation', async () => {
    const storage = new PostgreSqlStorageAdapter({
      plan: selected({
        source: 'provider',
        resolve: () => new Promise<string>(() => {}),
      }, { connectionTimeoutMs: 50 }),
      repositories: EMPTY_FACTORIES,
      loadDriver: async () => unusedDriver(),
    })

    let caught: unknown
    try {
      await storage.initialize()
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(StorageConfigurationError)
    expect(caught).toEqual(expect.objectContaining({
      code: 'postgresql_connection_resolution_timeout',
    }))
    await storage.close()
  })

  it('turns CA file failures into a content-free adapter error', async () => {
    const canary = '/definitely-missing/secret-canary/ca.pem'
    const storage = new PostgreSqlStorageAdapter({
      plan: selected({
        source: 'provider',
        resolve: () => 'postgresql://user:secret-canary@remote.example/db',
      }, { caPath: canary }),
      repositories: EMPTY_FACTORIES,
      loadDriver: async () => unusedDriver(),
    })
    let caught: unknown
    try {
      await storage.initialize()
    } catch (error) {
      caught = error
    }
    expect(caught).toEqual(expect.objectContaining({ code: 'ca_unreadable' }))
    expect(String(caught)).not.toContain(canary)
    expect(JSON.stringify(caught)).not.toContain('secret-canary')
    await storage.close()
  })
})
