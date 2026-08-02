import {
  StorageConfigurationError,
  type GatewayOptions,
  type GatewayStorageSelection,
  type PostgreSqlConnectionSource,
  type PostgreSqlPoolOptions,
  type PostgreSqlStorageOptions,
  type PostgreSqlTlsOptions,
  type SqliteStorageOptions,
  type StorageConfigurationErrorCode,
  type StoragePlanSummary,
} from '../../../src/index.js'
import {
  StorageConfigurationError as UmbrellaStorageConfigurationError,
  type GatewayOptions as UmbrellaGatewayOptions,
  type GatewayStorageSelection as UmbrellaGatewayStorageSelection,
  type PostgreSqlConnectionSource as UmbrellaPostgreSqlConnectionSource,
  type PostgreSqlPoolOptions as UmbrellaPostgreSqlPoolOptions,
  type PostgreSqlStorageOptions as UmbrellaPostgreSqlStorageOptions,
  type PostgreSqlTlsOptions as UmbrellaPostgreSqlTlsOptions,
  type SqliteStorageOptions as UmbrellaSqliteStorageOptions,
  type StorageConfigurationErrorCode as UmbrellaStorageConfigurationErrorCode,
  type StoragePlanSummary as UmbrellaStoragePlanSummary,
} from '../../../../ownware/src/index.js'

export const defaultGateway = {
  profilesDir: '/profiles',
} satisfies GatewayOptions

export const legacySqliteGateway = {
  profilesDir: '/profiles',
  dbPath: '/data/ownware.db',
} satisfies GatewayOptions

export const explicitSqlite: SqliteStorageOptions = {
  kind: 'sqlite',
  path: '/data/ownware.db',
}

export const connectionSource: PostgreSqlConnectionSource = {
  source: 'environment',
  variable: 'OWNWARE_POSTGRES_URL',
}

export const pool: PostgreSqlPoolOptions = { maxConnections: 12 }
export const tls: PostgreSqlTlsOptions = { mode: 'verify-full' }
export const postgres: PostgreSqlStorageOptions = {
  kind: 'postgresql',
  runtimeConnection: connectionSource,
  tls,
  pool,
}

export const postgresSelection: GatewayStorageSelection = { storage: postgres }
export const postgresGateway: GatewayOptions = {
  profilesDir: '/profiles',
  storage: postgres,
}
export const error = new StorageConfigurationError('selection_conflict')
export const errorCode: StorageConfigurationErrorCode = error.code
export const summary: StoragePlanSummary = {
  kind: 'sqlite',
  location: 'file',
}

export const umbrellaGateway: UmbrellaGatewayOptions = postgresGateway
export const umbrellaSelection: UmbrellaGatewayStorageSelection = postgresSelection
export const umbrellaSqlite: UmbrellaSqliteStorageOptions = explicitSqlite
export const umbrellaConnection: UmbrellaPostgreSqlConnectionSource = connectionSource
export const umbrellaPool: UmbrellaPostgreSqlPoolOptions = pool
export const umbrellaTls: UmbrellaPostgreSqlTlsOptions = tls
export const umbrellaPostgres: UmbrellaPostgreSqlStorageOptions = postgres
export const umbrellaError = new UmbrellaStorageConfigurationError('selection_conflict')
export const umbrellaErrorCode: UmbrellaStorageConfigurationErrorCode = errorCode
export const umbrellaSummary: UmbrellaStoragePlanSummary = summary

// @ts-expect-error dbPath and explicit storage select two durable authorities.
export const conflictingGateway: GatewayOptions = { profilesDir: '/profiles', dbPath: '/legacy.db', storage: { kind: 'sqlite' } }

// @ts-expect-error the umbrella package preserves the same exclusive selection.
export const conflictingUmbrellaGateway: UmbrellaGatewayOptions = { profilesDir: '/profiles', dbPath: '/legacy.db', storage: { kind: 'sqlite' } }

// @ts-expect-error unknown adapter kinds are not part of the public union.
export const unknownAdapter: GatewayOptions = { profilesDir: '/profiles', storage: { kind: 'mysql' } }

// @ts-expect-error adapter options reject unknown fields.
export const unknownSqliteField: GatewayOptions = { profilesDir: '/profiles', storage: { kind: 'sqlite', unexpected: true } }

