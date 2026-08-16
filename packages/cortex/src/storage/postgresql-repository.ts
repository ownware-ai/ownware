import {
  PostgreSqlStorageError,
  StorageLifecycleError,
  StorageRepositoryError,
  type StorageRepositoryDomain,
  type StorageRepositoryErrorCode,
} from './contracts.js'
import type {
  PostgreSqlRootRepositoryContext,
  PostgreSqlTransactionRepositoryContext,
} from './postgresql-adapter.js'
import type { PostgreSqlPool, PostgreSqlPoolClient } from './postgresql-driver.js'
import {
  normalizePostgreSqlTextKeyLogicalValue,
  normalizeStorageValue,
} from './value-codec.js'

export type PostgreSqlRepositoryContext =
  | PostgreSqlRootRepositoryContext
  | PostgreSqlTransactionRepositoryContext

export type PostgreSqlQueryClient = PostgreSqlPool | PostgreSqlPoolClient

export function queryClient(context: PostgreSqlRepositoryContext): PostgreSqlQueryClient {
  return 'pool' in context ? context.pool : context.client
}

function retryable(code: string): boolean {
  return code === '40001' || code === '40P01' || code === '55P03' || code === '57014' ||
    code.startsWith('08') || code === '57P01' || code === '57P02' || code === '57P03'
}

function connectionLost(code: string): boolean {
  return code.startsWith('08') || code === '57P01' || code === '57P02' || code === '57P03'
}

const PRESERVED_DOMAIN_ERRORS = new Set([
  'AccessGrantStoreError',
  'ChannelJobConflictError',
  'CodexThreadReferenceStoreError',
  'ConnectionInventoryCursorNotFoundError',
  'EgressReceiptStoreError',
  'EffectReceiptStoreError',
  'EffectReversalStoreError',
  'PrincipalAuthError',
  'PluginGrantConflictError',
  'PluginMigrationConflictError',
  'PluginVersionConflictError',
  'PluginVersionNotFoundError',
  'ProfileRunNotAcceptingError',
  'SkillActivationReceiptError',
  'SourceDataViewUnavailableError',
  'SourceDeletionPlanError',
  'SourceJobTargetNotFoundError',
  'SourcePreparationNotReadyError',
  'SourceQuotaExceededError',
  'SourceUploadRefreshConflictError',
  'SourceUploadTargetNotFoundError',
  'UsageEvidenceIntegrityError',
  'UsageEvidenceNotFoundError',
])

export async function repositoryCall<T>(
  context: PostgreSqlRepositoryContext,
  domain: StorageRepositoryDomain,
  operation: string,
  code: StorageRepositoryErrorCode,
  fn: (client: PostgreSqlQueryClient) => Promise<T>,
): Promise<T> {
  try {
    context.assertActive()
    return await fn(queryClient(context))
  } catch (error) {
    if (
      error instanceof StorageLifecycleError ||
      error instanceof StorageRepositoryError ||
      error instanceof PostgreSqlStorageError ||
      error instanceof TypeError ||
      error instanceof RangeError ||
      (error instanceof Error && PRESERVED_DOMAIN_ERRORS.has(error.name))
    ) {
      throw error
    }
    const driverCode = typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { readonly code?: unknown }).code ?? '')
      : ''
    throw new StorageRepositoryError(
      code,
      'postgresql',
      domain,
      operation,
      retryable(driverCode),
    )
  }
}

export function safeInteger(value: unknown): number {
  return normalizeStorageValue('safe-integer', value) as number
}

export function nullableSafeInteger(value: unknown): number | null {
  return value === null ? null : safeInteger(value)
}

/**
 * PostgreSQL text cannot contain NUL, while existing SQLite continuity keys
 * intentionally use NUL as an unambiguous component separator. Encode the
 * complete UTF-8 byte string (not just NUL-bearing values) so the mapping is
 * injective and cannot collide with an unencoded caller value.
 */
export function encodePostgreSqlTextKey(value: string): string {
  const logical = normalizePostgreSqlTextKeyLogicalValue(value)
  return `owp1:${Buffer.from(logical, 'utf8').toString('base64url')}`
}

/** Strict inverse used only by canonical transfer verification. */
export function decodePostgreSqlTextKey(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('owp1:')) {
    throw new TypeError('PostgreSQL text key is invalid.')
  }
  const encoded = value.slice('owp1:'.length)
  if (!/^[A-Za-z0-9_-]*$/.test(encoded) || encoded.length % 4 === 1) {
    throw new TypeError('PostgreSQL text key is invalid.')
  }
  const bytes = Buffer.from(encoded, 'base64url')
  if (bytes.toString('base64url') !== encoded) {
    throw new TypeError('PostgreSQL text key is invalid.')
  }
  let decoded: string
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new TypeError('PostgreSQL text key is invalid.')
  }
  return normalizePostgreSqlTextKeyLogicalValue(decoded)
}

export function finiteNumber(value: unknown): number {
  if (typeof value === 'string') return Number(value)
  return normalizeStorageValue('finite-real', value) as number
}

export async function withPostgreSqlTransaction<T>(
  pool: PostgreSqlPool,
  fn: (client: PostgreSqlPoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  let discardClient = false
  const onClientError = (): void => {
    // Do not retain or log a driver error that may contain tenant material.
    discardClient = true
  }
  client.on('error', onClientError)
  try {
    await client.query('BEGIN')
    try {
      const value = await fn(client)
      await client.query('COMMIT')
      return value
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { readonly code?: unknown }).code ?? '')
        : ''
      discardClient ||= connectionLost(code)
      await client.query('ROLLBACK').catch((rollbackError: unknown) => {
        discardClient = true
        const rollbackCode = typeof rollbackError === 'object' && rollbackError !== null &&
            'code' in rollbackError
          ? String((rollbackError as { readonly code?: unknown }).code ?? '')
          : ''
        discardClient ||= connectionLost(rollbackCode)
      })
      throw error
    }
  } finally {
    client.off('error', onClientError)
    client.release(discardClient)
  }
}
