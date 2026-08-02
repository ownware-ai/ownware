import { PostgreSqlStorageError } from './contracts.js'

export type PostgreSqlDriver = Pick<typeof import('pg'), 'Client' | 'Pool'>
export type PostgreSqlClient = import('pg').Client
export type PostgreSqlPool = import('pg').Pool
export type PostgreSqlPoolClient = import('pg').PoolClient
export type PostgreSqlClientConfig = import('pg').ClientConfig
export type PostgreSqlPoolConfig = import('pg').PoolConfig

/**
 * The only production import edge to node-postgres. This function is called
 * only after PostgreSQL is explicitly selected; importing Cortex/SQLite never
 * evaluates the optional peer.
 */
export async function loadPostgreSqlDriver(): Promise<PostgreSqlDriver> {
  let driver: Partial<PostgreSqlDriver>
  try {
    driver = await import('pg')
  } catch {
    throw new PostgreSqlStorageError('driver_missing', 'driver', false)
  }
  if (typeof driver.Client !== 'function' || typeof driver.Pool !== 'function') {
    throw new PostgreSqlStorageError('driver_invalid', 'driver', false)
  }
  return driver as PostgreSqlDriver
}
