import { describe, expect, it, vi } from 'vitest'
import {
  StorageConfigurationError,
  inspectStoragePlan,
  resolvePostgreSqlConnection,
  validateStoragePlan,
  type GatewayStorageSelection,
} from '../../../src/storage/config.js'

function postgres(
  overrides: Readonly<Record<string, unknown>> = {},
): GatewayStorageSelection {
  return {
    storage: {
      kind: 'postgresql',
      runtimeConnection: { source: 'environment' },
      tls: { mode: 'verify-full' },
      ...overrides,
    },
  } as GatewayStorageSelection
}

function capture(fn: () => unknown): StorageConfigurationError {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(StorageConfigurationError)
    return error as StorageConfigurationError
  }
  throw new Error('Expected storage configuration to fail.')
}

describe('storage configuration', () => {
  it('preserves default, dbPath and explicit SQLite selection', () => {
    expect(validateStoragePlan({}, '/default/ownware.db')).toEqual({
      kind: 'sqlite',
      path: '/default/ownware.db',
      summary: { kind: 'sqlite', location: 'file' },
    })
    expect(validateStoragePlan({ dbPath: '/legacy.db' }, '/default.db')).toEqual({
      kind: 'sqlite',
      path: '/legacy.db',
      summary: { kind: 'sqlite', location: 'file' },
    })
    expect(validateStoragePlan({ storage: { kind: 'sqlite', path: '/explicit.db' } }, '/d.db'))
      .toEqual({
        kind: 'sqlite',
        path: '/explicit.db',
        summary: { kind: 'sqlite', location: 'file' },
      })
  })

  it('creates a redacted PostgreSQL plan without resolving connection material', () => {
    const resolve = vi.fn(async () => 'postgresql://operator:secret-canary@db/db')
    const plan = inspectStoragePlan(postgres({
      runtimeConnection: { source: 'provider', resolve },
      migrationConnection: {
        source: 'environment',
        variable: 'OWNWARE_POSTGRES_MIGRATION_URL',
      },
      pool: { maxConnections: 17, statementTimeoutMs: 42_000 },
    }))

    expect(resolve).not.toHaveBeenCalled()
    expect(plan).toEqual({
      kind: 'postgresql',
      location: 'tenant-postgresql',
      connectionSource: 'provider',
      migrationConnectionSource: 'environment',
      tls: 'verify-full',
      schema: 'ownware',
      pool: {
        maxConnections: 17,
        connectionTimeoutMs: 5_000,
        idleTimeoutMs: 30_000,
        statementTimeoutMs: 42_000,
        lockTimeoutMs: 5_000,
        migrationTimeoutMs: 120_000,
        shutdownTimeoutMs: 5_000,
      },
    })
    expect(JSON.stringify(plan)).not.toContain('secret-canary')
    expect(JSON.stringify(plan)).not.toContain('OWNWARE_POSTGRES_MIGRATION_URL')
  })

  it.each([
    [{ storage: { kind: 'mysql' } }, 'adapter_unknown'],
    [{ dbPath: '/a.db', storage: { kind: 'sqlite' } }, 'selection_conflict'],
    [{ storage: { kind: 'sqlite', path: '/a.db', extra: true } }, 'sqlite_field_unknown'],
    [postgres({ connectionString: 'postgresql://secret@host/db' }), 'postgresql_field_unknown'],
    [postgres({ runtimeConnection: { source: 'environment', variable: 'lowercase' } }),
      'postgresql_environment_variable_invalid'],
    [postgres({ runtimeConnection: { source: 'provider', resolve: 'nope' } }),
      'postgresql_connection_provider_invalid'],
    [postgres({ tls: { mode: 'require' } }), 'postgresql_tls_mode_unknown'],
    [postgres({ tls: { mode: 'disable' } }), 'postgresql_insecure_loopback_ack_required'],
    [postgres({ pool: { maxConnections: 101 } }), 'postgresql_pool_limit_exceeded'],
    [postgres({ pool: { statementTimeoutMs: 0 } }), 'postgresql_pool_invalid'],
    [postgres({ pool: { unknown: 1 } }), 'postgresql_pool_invalid'],
  ] as const)('fails closed for invalid input %#', (input, code) => {
    expect(capture(() => inspectStoragePlan(input as never)).code).toBe(code)
  })

  it('does not retain caller mutations in a validated plan', () => {
    const input = {
      storage: {
        kind: 'postgresql',
        runtimeConnection: { source: 'environment', variable: 'OWNWARE_POSTGRES_URL' },
        tls: { mode: 'verify-full', ca: { source: 'file', path: '/test/ca.pem' } },
        pool: { maxConnections: 12 },
      },
    } as const
    const validated = validateStoragePlan(input, '/unused.db')
    ;(input.storage.pool as { maxConnections: number }).maxConnections = 99

    expect(validated.kind).toBe('postgresql')
    if (validated.kind === 'postgresql') {
      expect(validated.pool.maxConnections).toBe(12)
    }
  })
})

describe('PostgreSQL connection resolution', () => {
  it('resolves the default environment reference without exposing the secret', async () => {
    const secret = 'postgresql://runtime:p%40ss@db.example.test:5432/ownware_tenant'
    const connection = await resolvePostgreSqlConnection(
      { source: 'environment' },
      { mode: 'verify-full' },
      { OWNWARE_POSTGRES_URL: secret },
    )
    expect(connection).toEqual({
      connectionString: secret,
      host: 'db.example.test',
      database: 'ownware_tenant',
      user: 'runtime',
    })
  })

  it.each([
    ['postgresql://u:secret-canary@remote.example/db?sslmode=require',
      { mode: 'verify-full' }, 'postgresql_connection_tls_conflict'],
    ['postgresql://u:secret-canary@remote.example/db',
      { mode: 'disable', allowInsecureLoopback: true }, 'postgresql_connection_not_loopback'],
    ['postgresql://remote.example/db',
      { mode: 'verify-full' }, 'postgresql_connection_invalid'],
    ['mysql://u:secret-canary@localhost/db',
      { mode: 'verify-full' }, 'postgresql_connection_invalid'],
  ] as const)('fails URL policy without reflecting connection material %#', async (
    secret,
    tls,
    code,
  ) => {
    let caught: unknown
    try {
      await resolvePostgreSqlConnection(
        { source: 'provider', resolve: () => secret },
        tls,
      )
    } catch (error) {
      caught = error
    }
    expect(caught).toEqual(expect.objectContaining({ code }))
    expect(String(caught)).not.toContain(secret)
    expect(JSON.stringify(caught)).not.toContain('secret-canary')
  })

  it.each([
    'postgresql://u:p@localhost/db',
    'postgresql://u:p@127.99.2.3/db',
    'postgresql://u:p@[::1]/db',
  ])('permits explicitly acknowledged literal loopback plaintext: %s', async (secret) => {
    await expect(resolvePostgreSqlConnection(
      { source: 'provider', resolve: () => secret },
      { mode: 'disable', allowInsecureLoopback: true },
    )).resolves.toEqual(expect.objectContaining({ connectionString: secret }))
  })

  it('turns provider exceptions and absent environment values into content-free failures', async () => {
    const canary = 'postgresql://u:secret-canary@host/db'
    await expect(resolvePostgreSqlConnection(
      { source: 'provider', resolve: () => { throw new Error(canary) } },
      { mode: 'verify-full' },
    )).rejects.toEqual(expect.objectContaining({
      code: 'postgresql_connection_resolution_failed',
    }))
    await expect(resolvePostgreSqlConnection(
      { source: 'environment', variable: 'MISSING_POSTGRES_URL' },
      { mode: 'verify-full' },
      {},
    )).rejects.toEqual(expect.objectContaining({ code: 'postgresql_connection_missing' }))
  })
})
