import { randomBytes, randomUUID } from 'node:crypto'
import { Client } from 'pg'

interface DisposablePostgreSqlDatabase {
  readonly name: string
  readonly url: string
  readonly adminUrl: string
  readonly createRole: (kind: 'migration' | 'runtime') => Promise<{
    readonly name: string
    readonly url: string
  }>
  readonly transferOwnershipTo: (role: string) => Promise<void>
  readonly close: () => Promise<void>
}

const DEFAULT_CLEANUP_TIMEOUT_MS = 2_000
const DEFAULT_CATALOG_CLEANUP_TIMEOUT_MS = 10_000
const CLEANUP_RETRY_MS = 10
const DROP_ATTEMPT_TIMEOUT_MS = 100
const DATABASE_LIFECYCLE_LOCK_NAMESPACE = 1_398_031_360
const DATABASE_LIFECYCLE_LOCK_KEY = 11

interface DisposablePostgreSqlDatabaseOptions {
  readonly ownerRole?: string
  /** Test-only override for proving bounded active-session cleanup behavior. */
  readonly cleanupTimeoutMs?: number
}

function identifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function withDatabase(connection: string, database: string): string {
  const url = new URL(connection)
  url.pathname = `/${database}`
  return url.toString()
}

function withRole(connection: string, database: string, role: string, password: string): string {
  const url = new URL(withDatabase(connection, database))
  url.username = role
  url.password = password
  return url.toString()
}

export function configuredPostgreSqlTestUrl(): string | undefined {
  const value = process.env.OWNWARE_TEST_POSTGRES_URL
  return value === undefined || value.trim() === '' ? undefined : value
}

export async function createDisposablePostgreSqlDatabase(
  adminUrl: string,
  options: DisposablePostgreSqlDatabaseOptions = {},
): Promise<DisposablePostgreSqlDatabase> {
  const cleanupTimeoutMs = options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS
  if (!Number.isSafeInteger(cleanupTimeoutMs) || cleanupTimeoutMs < 1) {
    throw new TypeError('Disposable PostgreSQL cleanup timeout is invalid.')
  }
  const suffix = randomUUID().replaceAll('-', '').slice(0, 20)
  const name = `ownware_test_${suffix}`
  const roles: string[] = []
  const admin = new Client({ connectionString: adminUrl, ssl: false })
  try {
    await admin.connect()
    await admin.query('SELECT pg_advisory_lock($1, $2)', [
      DATABASE_LIFECYCLE_LOCK_NAMESPACE,
      DATABASE_LIFECYCLE_LOCK_KEY,
    ])
    const owner = options.ownerRole === undefined
      ? ''
      : ` OWNER ${identifier(options.ownerRole)}`
    await admin.query(`CREATE DATABASE ${identifier(name)}${owner}`)
  } catch {
    await admin.end().catch(() => {})
    throw new Error('Disposable PostgreSQL database setup failed.')
  }
  await admin.end()

  return {
    name,
    url: withDatabase(adminUrl, name),
    adminUrl,
    async createRole(kind) {
      const role = `ownware_${kind}_${suffix}`
      const password = randomBytes(24).toString('base64url')
      const client = new Client({ connectionString: adminUrl, ssl: false })
      try {
        await client.connect()
        await client.query('SELECT pg_advisory_lock($1, $2)', [
          DATABASE_LIFECYCLE_LOCK_NAMESPACE,
          DATABASE_LIFECYCLE_LOCK_KEY,
        ])
        await client.query(
          `CREATE ROLE ${identifier(role)} LOGIN PASSWORD ${literal(password)}`,
        )
        roles.push(role)
        await client.query(`GRANT CONNECT ON DATABASE ${identifier(name)} TO ${identifier(role)}`)
      } catch {
        throw new Error('Disposable PostgreSQL role setup failed.')
      } finally {
        await client.end().catch(() => {})
      }
      return { name: role, url: withRole(adminUrl, name, role, password) }
    },
    async transferOwnershipTo(role) {
      if (!roles.includes(role)) throw new Error('Unknown disposable PostgreSQL role.')
      const client = new Client({ connectionString: adminUrl, ssl: false })
      try {
        await client.connect()
        await client.query('SELECT pg_advisory_lock($1, $2)', [
          DATABASE_LIFECYCLE_LOCK_NAMESPACE,
          DATABASE_LIFECYCLE_LOCK_KEY,
        ])
        await client.query(`ALTER DATABASE ${identifier(name)} OWNER TO ${identifier(role)}`)
      } catch {
        throw new Error('Disposable PostgreSQL ownership setup failed.')
      } finally {
        await client.end().catch(() => {})
      }
    },
    async close() {
      const client = new Client({ connectionString: adminUrl, ssl: false })
      try {
        await client.connect()
        // CREATE/DROP DATABASE contend on cluster-wide catalog authority even
        // for different target databases. Serialize only that test lifecycle
        // DDL across Vitest workers; repository work remains fully concurrent.
        await client.query('SELECT pg_advisory_lock($1, $2)', [
          DATABASE_LIFECYCLE_LOCK_NAMESPACE,
          DATABASE_LIFECYCLE_LOCK_KEY,
        ])
        await client.query(`SET statement_timeout = ${Math.min(
          cleanupTimeoutMs,
          DROP_ATTEMPT_TIMEOUT_MS,
        )}`)
        const startedAt = Date.now()
        const sessionDeadline = startedAt + cleanupTimeoutMs
        // A target with zero sessions can still wait behind PostgreSQL's
        // cluster-wide catalog cleanup under a wide parallel matrix. That is
        // not a leaked customer/test connection, so give serialized catalog
        // DDL its own bound without weakening the explicit leak timeout.
        const catalogTimeoutMs = Math.max(
          cleanupTimeoutMs,
          DEFAULT_CATALOG_CLEANUP_TIMEOUT_MS,
        )
        const catalogDeadline = startedAt + catalogTimeoutMs
        while (true) {
          try {
            // A clean test closes every client first. Never force-kill a socket:
            // node-postgres may deliver that fatal event after its pool teardown,
            // turning successful parallel files into an unhandled-error failure.
            await client.query(`DROP DATABASE IF EXISTS ${identifier(name)}`)
            break
          } catch (error) {
            const code = typeof error === 'object' && error !== null && 'code' in error
              ? String((error as { readonly code?: unknown }).code ?? '')
              : ''
            if (code !== '55006' && code !== '57014') {
              throw new Error('Disposable PostgreSQL database cleanup failed.')
            }
            const active = await client.query<{ readonly count: string }>(`
              SELECT COUNT(*)::text AS count
              FROM pg_catalog.pg_stat_activity
              WHERE datname = $1 AND pid <> pg_backend_pid()
            `, [name])
            const count = Number(active.rows[0]?.count ?? Number.NaN)
            const observed = Number.isSafeInteger(count) && count >= 0 ? count : 'unknown'
            const activeSessionBlocked = typeof observed === 'number' && observed > 0
            const deadline = activeSessionBlocked ? sessionDeadline : catalogDeadline
            if (Date.now() >= deadline) {
              const timeoutMs = activeSessionBlocked ? cleanupTimeoutMs : catalogTimeoutMs
              throw new Error(
                `Disposable PostgreSQL database cleanup remained blocked for ` +
                `${timeoutMs} ms; observed ${observed} active session(s).`,
              )
            }
            await new Promise((resolve) => setTimeout(resolve, CLEANUP_RETRY_MS))
          }
        }
        for (const role of roles.reverse()) {
          await client.query(`DROP ROLE IF EXISTS ${identifier(role)}`)
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith(
          'Disposable PostgreSQL database cleanup',
        )) {
          throw error
        }
        throw new Error('Disposable PostgreSQL database cleanup failed.')
      } finally {
        await client.end().catch(() => {})
      }
    },
  }
}
