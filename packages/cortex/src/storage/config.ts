import { isIP } from 'node:net'

export interface EnvironmentPostgreSqlConnectionSource {
  readonly source: 'environment'
  /** Default: OWNWARE_POSTGRES_URL. */
  readonly variable?: string
}

export interface ProviderPostgreSqlConnectionSource {
  readonly source: 'provider'
  /** Tenant-owned secret lookup. The returned value is never serialized. */
  readonly resolve: (signal: AbortSignal) => string | Promise<string>
}

export type PostgreSqlConnectionSource =
  | EnvironmentPostgreSqlConnectionSource
  | ProviderPostgreSqlConnectionSource

export type PostgreSqlTlsOptions =
  | {
      readonly mode: 'verify-full'
      readonly ca?:
        | { readonly source: 'system' }
        | { readonly source: 'file'; readonly path: string }
    }
  | {
      readonly mode: 'disable'
      readonly allowInsecureLoopback: true
    }

export interface PostgreSqlPoolOptions {
  readonly maxConnections?: number
  readonly connectionTimeoutMs?: number
  readonly idleTimeoutMs?: number
  readonly statementTimeoutMs?: number
  readonly lockTimeoutMs?: number
  readonly migrationTimeoutMs?: number
  readonly shutdownTimeoutMs?: number
}

export interface PostgreSqlStorageOptions {
  readonly kind: 'postgresql'
  readonly runtimeConnection: PostgreSqlConnectionSource
  /** Defaults to runtimeConnection; a separate, narrower runtime role is recommended. */
  readonly migrationConnection?: PostgreSqlConnectionSource
  readonly tls: PostgreSqlTlsOptions
  readonly pool?: PostgreSqlPoolOptions
}

export interface SqliteStorageOptions {
  readonly kind: 'sqlite'
  readonly path?: string
}

/**
 * Exactly one durable authority may be selected. `dbPath` remains the legacy
 * SQLite compatibility field; it cannot be combined with explicit storage.
 */
export type GatewayStorageSelection =
  | { readonly storage?: undefined; readonly dbPath?: string }
  | { readonly storage: SqliteStorageOptions; readonly dbPath?: never }
  | { readonly storage: PostgreSqlStorageOptions; readonly dbPath?: never }

export interface PostgreSqlPoolPlan {
  readonly maxConnections: number
  readonly connectionTimeoutMs: number
  readonly idleTimeoutMs: number
  readonly statementTimeoutMs: number
  readonly lockTimeoutMs: number
  readonly migrationTimeoutMs: number
  readonly shutdownTimeoutMs: number
}

export type StoragePlanSummary =
  | {
      readonly kind: 'sqlite'
      readonly location: 'file'
    }
  | {
      readonly kind: 'postgresql'
      readonly location: 'tenant-postgresql'
      readonly connectionSource: 'environment' | 'provider'
      readonly migrationConnectionSource: 'runtime' | 'environment' | 'provider'
      readonly tls: 'verify-full' | 'insecure-loopback'
      readonly schema: 'ownware'
      readonly pool: PostgreSqlPoolPlan
    }

export type StorageConfigurationErrorCode =
  | 'selection_invalid'
  | 'selection_conflict'
  | 'sqlite_path_invalid'
  | 'sqlite_field_unknown'
  | 'adapter_invalid'
  | 'adapter_unknown'
  | 'postgresql_field_unknown'
  | 'postgresql_connection_source_invalid'
  | 'postgresql_connection_source_unknown'
  | 'postgresql_environment_variable_invalid'
  | 'postgresql_connection_provider_invalid'
  | 'postgresql_pool_invalid'
  | 'postgresql_pool_limit_exceeded'
  | 'postgresql_tls_invalid'
  | 'postgresql_tls_mode_unknown'
  | 'postgresql_tls_ca_invalid'
  | 'postgresql_tls_ca_unknown'
  | 'postgresql_insecure_loopback_ack_required'
  | 'postgresql_connection_missing'
  | 'postgresql_connection_resolution_failed'
  | 'postgresql_connection_resolution_timeout'
  | 'postgresql_connection_invalid'
  | 'postgresql_connection_tls_conflict'
  | 'postgresql_connection_not_loopback'

/** Content-free configuration failure safe for logs and support receipts. */
export class StorageConfigurationError extends Error {
  override readonly name = 'StorageConfigurationError'

  constructor(readonly code: StorageConfigurationErrorCode) {
    super(`Invalid storage configuration (${code}).`)
  }
}

const DEFAULT_POOL: PostgreSqlPoolPlan = Object.freeze({
  maxConnections: 10,
  connectionTimeoutMs: 5_000,
  idleTimeoutMs: 30_000,
  statementTimeoutMs: 30_000,
  lockTimeoutMs: 5_000,
  migrationTimeoutMs: 120_000,
  shutdownTimeoutMs: 5_000,
})

const POOL_KEYS = [
  'maxConnections',
  'connectionTimeoutMs',
  'idleTimeoutMs',
  'statementTimeoutMs',
  'lockTimeoutMs',
  'migrationTimeoutMs',
  'shutdownTimeoutMs',
] as const

type PoolKey = (typeof POOL_KEYS)[number]

const POOL_MAXIMUMS: Readonly<Record<PoolKey, number>> = Object.freeze({
  maxConnections: 100,
  connectionTimeoutMs: 300_000,
  idleTimeoutMs: 3_600_000,
  statementTimeoutMs: 3_600_000,
  lockTimeoutMs: 300_000,
  migrationTimeoutMs: 600_000,
  shutdownTimeoutMs: 300_000,
})

interface ValidatedSqlitePlan {
  readonly kind: 'sqlite'
  readonly path: string
  readonly summary: Extract<StoragePlanSummary, { readonly kind: 'sqlite' }>
}

export interface ValidatedPostgreSqlPlan {
  readonly kind: 'postgresql'
  readonly runtimeConnection: PostgreSqlConnectionSource
  readonly migrationConnection?: PostgreSqlConnectionSource
  readonly tls: PostgreSqlTlsOptions
  readonly pool: PostgreSqlPoolPlan
  readonly summary: Extract<StoragePlanSummary, { readonly kind: 'postgresql' }>
}

export type ValidatedStoragePlan = ValidatedSqlitePlan | ValidatedPostgreSqlPlan

export interface ResolvedPostgreSqlConnection {
  /** Secret-bearing. Keep adapter-local and never attach to diagnostics. */
  readonly connectionString: string
  /** Non-secret parsed authority facts used by preflight policy. */
  readonly host: string
  readonly database: string
  readonly user: string
}

function fail(code: StorageConfigurationErrorCode): never {
  throw new StorageConfigurationError(code)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assertKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  code: StorageConfigurationErrorCode,
): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail(code)
}

function validatePath(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') return fail('sqlite_path_invalid')
  return value
}

function validateConnectionSource(value: unknown): PostgreSqlConnectionSource {
  if (!isRecord(value) || typeof value.source !== 'string') {
    return fail('postgresql_connection_source_invalid')
  }
  if (value.source === 'environment') {
    assertKeys(value, ['source', 'variable'], 'postgresql_connection_source_invalid')
    if (
      value.variable !== undefined &&
      (typeof value.variable !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(value.variable))
    ) {
      return fail('postgresql_environment_variable_invalid')
    }
    return value.variable === undefined
      ? { source: 'environment' }
      : { source: 'environment', variable: value.variable }
  }
  if (value.source === 'provider') {
    assertKeys(value, ['source', 'resolve'], 'postgresql_connection_source_invalid')
    if (typeof value.resolve !== 'function') {
      return fail('postgresql_connection_provider_invalid')
    }
    return {
      source: 'provider',
      resolve: value.resolve as (signal: AbortSignal) => string | Promise<string>,
    }
  }
  return fail('postgresql_connection_source_unknown')
}

function validateTls(value: unknown): PostgreSqlTlsOptions {
  if (!isRecord(value) || typeof value.mode !== 'string') return fail('postgresql_tls_invalid')
  if (value.mode === 'verify-full') {
    assertKeys(value, ['mode', 'ca'], 'postgresql_tls_invalid')
    if (value.ca === undefined) return { mode: 'verify-full' }
    if (!isRecord(value.ca) || typeof value.ca.source !== 'string') {
      return fail('postgresql_tls_ca_invalid')
    }
    if (value.ca.source === 'system') {
      assertKeys(value.ca, ['source'], 'postgresql_tls_ca_invalid')
      return { mode: 'verify-full', ca: { source: 'system' } }
    }
    if (value.ca.source === 'file') {
      assertKeys(value.ca, ['source', 'path'], 'postgresql_tls_ca_invalid')
      if (typeof value.ca.path !== 'string' || value.ca.path.trim() === '') {
        return fail('postgresql_tls_ca_invalid')
      }
      return { mode: 'verify-full', ca: { source: 'file', path: value.ca.path } }
    }
    return fail('postgresql_tls_ca_unknown')
  }
  if (value.mode === 'disable') {
    assertKeys(value, ['mode', 'allowInsecureLoopback'], 'postgresql_tls_invalid')
    if (value.allowInsecureLoopback !== true) {
      return fail('postgresql_insecure_loopback_ack_required')
    }
    return { mode: 'disable', allowInsecureLoopback: true }
  }
  return fail('postgresql_tls_mode_unknown')
}

function validatePool(value: unknown): PostgreSqlPoolPlan {
  if (value === undefined) return DEFAULT_POOL
  if (!isRecord(value)) return fail('postgresql_pool_invalid')
  assertKeys(value, POOL_KEYS, 'postgresql_pool_invalid')
  const result = { ...DEFAULT_POOL }
  for (const key of POOL_KEYS) {
    const configured = value[key]
    if (configured === undefined) continue
    if (
      typeof configured !== 'number' ||
      !Number.isSafeInteger(configured) ||
      configured <= 0
    ) {
      return fail('postgresql_pool_invalid')
    }
    if (configured > POOL_MAXIMUMS[key]) return fail('postgresql_pool_limit_exceeded')
    result[key] = configured
  }
  return Object.freeze(result)
}

function validateSelectionShape(value: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) return fail('selection_invalid')
  // This function receives the storage-only projection of GatewayOptions.
  assertKeys(value, ['storage', 'dbPath'], 'selection_invalid')
  if (value.storage !== undefined && value.dbPath !== undefined) return fail('selection_conflict')
  return value
}

/**
 * Validate and snapshot the selected authority without resolving any secret.
 * `defaultSqlitePath` is intentionally absent from the public summary.
 */
export function validateStoragePlan(
  selection: GatewayStorageSelection,
  defaultSqlitePath: string,
): ValidatedStoragePlan {
  const value = validateSelectionShape(selection)
  const legacyPath = validatePath(value.dbPath)
  if (value.storage === undefined) {
    return {
      kind: 'sqlite',
      path: legacyPath ?? defaultSqlitePath,
      summary: { kind: 'sqlite', location: 'file' },
    }
  }
  if (!isRecord(value.storage) || typeof value.storage.kind !== 'string') {
    return fail('adapter_invalid')
  }
  if (value.storage.kind === 'sqlite') {
    assertKeys(value.storage, ['kind', 'path'], 'sqlite_field_unknown')
    return {
      kind: 'sqlite',
      path: validatePath(value.storage.path) ?? defaultSqlitePath,
      summary: { kind: 'sqlite', location: 'file' },
    }
  }
  if (value.storage.kind !== 'postgresql') return fail('adapter_unknown')
  assertKeys(
    value.storage,
    ['kind', 'runtimeConnection', 'migrationConnection', 'tls', 'pool'],
    'postgresql_field_unknown',
  )
  const runtimeConnection = validateConnectionSource(value.storage.runtimeConnection)
  const migrationConnection = value.storage.migrationConnection === undefined
    ? undefined
    : validateConnectionSource(value.storage.migrationConnection)
  const tls = validateTls(value.storage.tls)
  const pool = validatePool(value.storage.pool)
  const summary: Extract<StoragePlanSummary, { readonly kind: 'postgresql' }> = {
    kind: 'postgresql',
    location: 'tenant-postgresql',
    connectionSource: runtimeConnection.source,
    migrationConnectionSource: migrationConnection?.source ?? 'runtime',
    tls: tls.mode === 'verify-full' ? 'verify-full' : 'insecure-loopback',
    schema: 'ownware',
    pool,
  }
  return {
    kind: 'postgresql',
    runtimeConnection,
    ...(migrationConnection === undefined ? {} : { migrationConnection }),
    tls,
    pool,
    summary,
  }
}

/** Public, secret-free inspection boundary. Provider callbacks are not invoked. */
export function inspectStoragePlan(selection: GatewayStorageSelection): StoragePlanSummary {
  return validateStoragePlan(selection, '<default-sqlite-path>').summary
}

function isLiteralLoopbackHost(host: string): boolean {
  const normalized = host.startsWith('[') && host.endsWith(']')
    ? host.slice(1, -1).toLowerCase()
    : host.toLowerCase()
  if (normalized === 'localhost') return true
  const ipVersion = isIP(normalized)
  if (ipVersion === 4) {
    const first = Number(normalized.split('.')[0])
    return first === 127
  }
  return ipVersion === 6 && normalized === '::1'
}

/** Resolve one tenant-owned secret and prove the URL/TLS authority policy. */
export async function resolvePostgreSqlConnection(
  source: PostgreSqlConnectionSource,
  tls: PostgreSqlTlsOptions,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  signal: AbortSignal = new AbortController().signal,
): Promise<ResolvedPostgreSqlConnection> {
  let connectionString: unknown
  if (source.source === 'environment') {
    const configured = environment[source.variable ?? 'OWNWARE_POSTGRES_URL']
    if (configured === undefined || configured.trim() === '') {
      return fail('postgresql_connection_missing')
    }
    connectionString = configured
  } else {
    try {
      if (signal.aborted) return fail('postgresql_connection_resolution_failed')
      connectionString = await source.resolve(signal)
      if (signal.aborted) return fail('postgresql_connection_resolution_failed')
    } catch {
      return fail('postgresql_connection_resolution_failed')
    }
  }
  if (typeof connectionString !== 'string' || connectionString.trim() === '') {
    return fail('postgresql_connection_resolution_failed')
  }

  let parsed: URL
  try {
    parsed = new URL(connectionString)
  } catch {
    return fail('postgresql_connection_invalid')
  }
  if (
    (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') ||
    parsed.hostname === '' ||
    parsed.username === '' ||
    parsed.pathname.length <= 1 ||
    parsed.hash !== ''
  ) {
    return fail('postgresql_connection_invalid')
  }
  // Structured TLS is authoritative. URL query options can replace the ssl
  // object or mutate session behavior, so the initial envelope accepts none.
  if ([...parsed.searchParams.keys()].length > 0) {
    return fail('postgresql_connection_tls_conflict')
  }
  if (tls.mode === 'disable' && !isLiteralLoopbackHost(parsed.hostname)) {
    return fail('postgresql_connection_not_loopback')
  }

  return {
    connectionString,
    host: parsed.hostname,
    database: decodeURIComponent(parsed.pathname.slice(1)),
    user: decodeURIComponent(parsed.username),
  }
}
