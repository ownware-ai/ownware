import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  OfflineTransferError,
  OwnwareGateway,
  PostgreSqlTransferPreflightError,
  SqliteTransferFindingsError,
  SqliteTransferPreflightError,
  StorageConfigurationError,
  preflightPostgreSqlTransferTarget,
  preflightSqliteTransferSource,
  transferOfflineSqliteToPostgreSql,
  type GatewayOptions,
  type StorageConfigurationErrorCode,
} from '../../../src/index.js'

describe('public gateway storage configuration', () => {
  let root: string
  const gateways: OwnwareGateway[] = []

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ownware-public-storage-config-'))
  })

  afterEach(async () => {
    for (const gateway of gateways.reverse()) {
      await gateway.stop().catch(() => {})
    }
    await rm(root, { recursive: true, force: true })
  })

  function base(name: string): GatewayOptions {
    return {
      port: 0,
      tls: false,
      profilesDir: join(root, 'profiles'),
      dataDir: join(root, name),
      disableRateLimit: true,
      disableAccessLog: true,
      disableSourceWorker: true,
    }
  }

  function track(options: GatewayOptions): OwnwareGateway {
    const gateway = new OwnwareGateway(options)
    gateways.push(gateway)
    return gateway
  }

  function captureConfigurationError(
    options: unknown,
    expectedCode: StorageConfigurationErrorCode,
  ): void {
    let caught: unknown
    try {
      track(options as GatewayOptions)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(StorageConfigurationError)
    expect(caught).toMatchObject({ code: expectedCode })
  }

  it('keeps default, legacy dbPath and explicit SQLite valid through the public constructor', () => {
    const defaultGateway = track(base('default-sqlite'))
    const legacyPath = join(root, 'legacy.sqlite')
    const legacyGateway = track({
      ...base('legacy-sqlite'),
      dbPath: legacyPath,
    })
    const explicitPath = join(root, 'explicit.sqlite')
    const explicitGateway = track({
      ...base('explicit-sqlite'),
      storage: { kind: 'sqlite', path: explicitPath },
    })

    expect(defaultGateway.state.storageKind).toBe('sqlite')
    expect(defaultGateway.state.storageLifecycleState).toBe('ready')
    expect(existsSync(join(root, 'default-sqlite', 'ownware.db'))).toBe(true)
    expect(legacyGateway.state.storageKind).toBe('sqlite')
    expect(legacyGateway.state.storageLifecycleState).toBe('ready')
    expect(existsSync(legacyPath)).toBe(true)
    expect(explicitGateway.state.storageKind).toBe('sqlite')
    expect(explicitGateway.state.storageLifecycleState).toBe('ready')
    expect(existsSync(explicitPath)).toBe(true)
  })

  it('accepts PostgreSQL without resolving provider connection material in the constructor', () => {
    const resolve = vi.fn(() => 'postgresql://runtime:secret-canary@localhost/ownware')
    const gateway = track({
      ...base('postgresql'),
      storage: {
        kind: 'postgresql',
        runtimeConnection: { source: 'provider', resolve },
        tls: { mode: 'disable', allowInsecureLoopback: true },
      },
    })

    expect(gateway.state.storageKind).toBe('postgresql')
    expect(gateway.state.storageLifecycleState).toBe('new')
    expect(resolve).not.toHaveBeenCalled()
  })

  it('exports the complete offline transfer workflow from the public surface', () => {
    expect(preflightSqliteTransferSource).toBeTypeOf('function')
    expect(preflightPostgreSqlTransferTarget).toBeTypeOf('function')
    expect(transferOfflineSqliteToPostgreSql).toBeTypeOf('function')
    expect(SqliteTransferPreflightError.prototype).toBeInstanceOf(Error)
    expect(SqliteTransferFindingsError.prototype).toBeInstanceOf(Error)
    expect(PostgreSqlTransferPreflightError.prototype).toBeInstanceOf(Error)
    expect(OfflineTransferError.prototype).toBeInstanceOf(Error)
  })

  it('resolves a PostgreSQL provider only when startup initializes storage', async () => {
    const resolve = vi.fn(() => 'not-a-postgresql-url')
    const gateway = track({
      ...base('lazy-provider'),
      storage: {
        kind: 'postgresql',
        runtimeConnection: { source: 'provider', resolve },
        tls: { mode: 'verify-full' },
      },
    })

    expect(resolve).not.toHaveBeenCalled()
    await expect(gateway.start()).rejects.toMatchObject({
      code: 'postgresql_connection_invalid',
    })
    expect(resolve).toHaveBeenCalledOnce()
    expect(gateway.port).toBe(0)
    expect(gateway.state.storageLifecycleState).toBe('closed')
  })

  it('rejects conflicting authorities and unknown adapter shapes before serving', () => {
    const signalCounts = {
      sigterm: process.listenerCount('SIGTERM'),
      sigint: process.listenerCount('SIGINT'),
    }
    const common = base('invalid')

    captureConfigurationError({
      ...common,
      dbPath: join(root, 'legacy.sqlite'),
      storage: { kind: 'sqlite' },
    }, 'selection_conflict')
    captureConfigurationError({
      ...common,
      storage: { kind: 'mysql' },
    }, 'adapter_unknown')
    captureConfigurationError({
      ...common,
      storage: { kind: 'sqlite', unexpected: true },
    }, 'sqlite_field_unknown')
    captureConfigurationError({
      ...common,
      storage: {
        kind: 'postgresql',
        runtimeConnection: { source: 'environment' },
        tls: { mode: 'verify-full' },
        unexpected: true,
      },
    }, 'postgresql_field_unknown')

    expect(process.listenerCount('SIGTERM')).toBe(signalCounts.sigterm)
    expect(process.listenerCount('SIGINT')).toBe(signalCounts.sigint)
  })
})
