import { AccessGrantStoreError } from '../gateway/access-grant-store.js'
import type { EvidenceSearchCache } from '../gateway/evidence-search-cache.js'
import {
  SourceDataViewStore,
  SourceDataViewUnavailableError,
} from '../gateway/source-data-view-store.js'
import {
  SourceDeletionPlanError,
  SourceDeletionStore,
} from '../gateway/source-deletion-store.js'
import {
  SourceJobStore,
  SourceJobTargetNotFoundError,
  SourcePreparationNotReadyError,
} from '../gateway/source-job-store.js'
import {
  DEFAULT_SOURCE_QUOTA_LIMITS,
  SourceQuotaExceededError,
  SourceQuotaPolicy,
  type SourceQuotaLimits,
} from '../gateway/source-quota-policy.js'
import { SourceStore } from '../gateway/source-store.js'
import {
  SourceUploadRefreshConflictError,
  SourceUploadStore,
  SourceUploadTargetNotFoundError,
} from '../gateway/source-upload-store.js'
import {
  StorageLifecycleError,
  StorageRepositoryError,
  type StorageRepositoryDomain,
  type StorageRepositoryErrorCode,
} from './contracts.js'
import type {
  SourceDataViewRepository,
  SourceDeletionRepository,
  SourceJobRepository,
  SourceRepositories,
  SourceRepository,
  SourceUploadRepository,
} from './source-repositories.js'
import type { SqliteRootRepositoryContext } from './sqlite-adapter.js'

export interface SqliteSourceRepositoryOptions {
  readonly quotaLimits?: SourceQuotaLimits
  readonly evidenceSearchCache?: EvidenceSearchCache
}

type AsyncMethods<T extends object> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never
}

function isPreservedDomainError(error: unknown): boolean {
  return error instanceof StorageLifecycleError ||
    error instanceof StorageRepositoryError ||
    error instanceof AccessGrantStoreError ||
    error instanceof SourceQuotaExceededError ||
    error instanceof SourceUploadTargetNotFoundError ||
    error instanceof SourceUploadRefreshConflictError ||
    error instanceof SourceJobTargetNotFoundError ||
    error instanceof SourcePreparationNotReadyError ||
    error instanceof SourceDataViewUnavailableError ||
    error instanceof SourceDeletionPlanError
}

function sqliteCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { readonly code?: unknown }).code ?? '')
    : ''
}

async function repositoryCall<T>(
  assertActive: () => void,
  domain: StorageRepositoryDomain,
  operation: string,
  code: StorageRepositoryErrorCode,
  fn: () => T,
): Promise<Awaited<T>> {
  try {
    assertActive()
    return await fn()
  } catch (error) {
    if (isPreservedDomainError(error)) throw error
    const codeValue = sqliteCode(error)
    throw new StorageRepositoryError(
      code,
      'sqlite',
      domain,
      operation,
      codeValue === 'SQLITE_BUSY' || codeValue === 'SQLITE_LOCKED',
    )
  }
}

function wrapRepository<
  TStore extends object,
  TPort extends object,
>(
  store: TStore,
  assertActive: () => void,
  domain: StorageRepositoryDomain,
  operations: Readonly<Record<keyof TPort, StorageRepositoryErrorCode>>,
): AsyncMethods<TPort> {
  const wrapped: Partial<Record<keyof TPort, unknown>> = {}
  for (const key of Object.keys(operations) as Array<keyof TPort>) {
    const method = store[key as unknown as keyof TStore]
    if (typeof method !== 'function') {
      throw new StorageRepositoryError(
        'read_failed', 'sqlite', domain, String(key), false,
      )
    }
    wrapped[key] = (...args: readonly unknown[]) => repositoryCall(
      assertActive,
      domain,
      String(key),
      operations[key],
      () => Reflect.apply(method, store, args),
    )
  }
  return wrapped as AsyncMethods<TPort>
}

const sourceOperations = {
  create: 'write_failed',
  getScoped: 'read_failed',
  listScoped: 'read_failed',
} as const satisfies Record<keyof SourceRepository, StorageRepositoryErrorCode>

const uploadOperations = {
  create: 'write_failed',
  listOpenCheckpoints: 'read_failed',
  // An open session can expire durably while it is observed.
  getScoped: 'write_failed',
  getCurrentSourceIdentity: 'read_failed',
  findChunk: 'read_failed',
  advanceChunk: 'write_failed',
  beginCompletion: 'write_failed',
  finishCompletion: 'write_failed',
  getCompletedVersion: 'read_failed',
  getVersionScoped: 'read_failed',
  markFailed: 'write_failed',
  markFailedAfterVerifiedCleanup: 'write_failed',
} as const satisfies Record<keyof SourceUploadRepository, StorageRepositoryErrorCode>

const jobOperations = {
  enqueue: 'write_failed',
  enqueuePreparation: 'write_failed',
  getScoped: 'read_failed',
  hasTargetScoped: 'read_failed',
  claimNext: 'write_failed',
  getClaimedInspectionTarget: 'read_failed',
  getClaimedPreparationTarget: 'read_failed',
  advanceCheckpoint: 'write_failed',
  recoverExpiredClaims: 'write_failed',
  requestCancel: 'write_failed',
  confirmNextUnclaimedCancellation: 'write_failed',
  confirmCancelled: 'write_failed',
  deferUntil: 'write_failed',
  finish: 'write_failed',
  finishInspection: 'write_failed',
  finishPreparation: 'write_failed',
  getResourceScoped: 'read_failed',
} as const satisfies Record<keyof SourceJobRepository, StorageRepositoryErrorCode>

const dataViewOperations = {
  enqueue: 'write_failed',
  getJobScoped: 'read_failed',
  requestCancel: 'write_failed',
  claimNext: 'write_failed',
  claimNextCancellation: 'write_failed',
  getClaimedTarget: 'read_failed',
  renewClaim: 'write_failed',
  advanceCheckpoint: 'write_failed',
  publish: 'write_failed',
  deferUntil: 'write_failed',
  finishFailed: 'write_failed',
  confirmCancelled: 'write_failed',
  fenceUnpublishedArtifactCleanup: 'write_failed',
  recoverExpiredClaims: 'write_failed',
  getViewScoped: 'read_failed',
  getProtectedSelectionTargetScoped: 'read_failed',
  getPrivateArtifact: 'read_failed',
} as const satisfies Record<keyof SourceDataViewRepository, StorageRepositoryErrorCode>

const deletionOperations = {
  plan: 'write_failed',
  getScoped: 'read_failed',
  getPublicByJobScoped: 'read_failed',
  getPublicBySourceScoped: 'read_failed',
  getInventory: 'read_failed',
  getInventoryEntries: 'read_failed',
  versionLocatorMatches: 'read_failed',
  dataViewLocator: 'read_failed',
  claimNext: 'write_failed',
  startDestruction: 'write_failed',
  renewClaim: 'write_failed',
  advanceCheckpoint: 'write_failed',
  markArtifact: 'write_failed',
  removeControlArtifact: 'write_failed',
  controlArtifactAbsent: 'read_failed',
  removeRetrievalCacheArtifact: 'write_failed',
  retrievalCacheArtifactAbsent: 'read_failed',
  finish: 'write_failed',
  retryPartial: 'write_failed',
  retryPartialScoped: 'write_failed',
  recoverExpiredClaims: 'write_failed',
  confirmNextCancellation: 'write_failed',
  requestCancellation: 'write_failed',
  confirmCancellation: 'write_failed',
  ensureGrantRevoked: 'write_failed',
  grantRevocationEffective: 'read_failed',
} as const satisfies Record<keyof SourceDeletionRepository, StorageRepositoryErrorCode>

export function createSqliteSourceRepositories(
  context: SqliteRootRepositoryContext,
  options: SqliteSourceRepositoryOptions = {},
): SourceRepositories {
  const { database, assertActive } = context
  const quotaLimits = options.quotaLimits ?? DEFAULT_SOURCE_QUOTA_LIMITS
  const quota = new SourceQuotaPolicy(database, quotaLimits)
  const sources = new SourceStore(database, quota)
  const uploads = new SourceUploadStore(
    database,
    quota,
    options.evidenceSearchCache,
  )
  const jobs = new SourceJobStore(database, quota)
  const dataViews = new SourceDataViewStore(database, quota)
  const deletions = new SourceDeletionStore(database, options.evidenceSearchCache)

  return {
    sources: wrapRepository<typeof sources, SourceRepository>(
      sources, assertActive, 'sources', sourceOperations,
    ),
    uploads: wrapRepository<typeof uploads, SourceUploadRepository>(
      uploads, assertActive, 'source_uploads', uploadOperations,
    ),
    jobs: wrapRepository<typeof jobs, SourceJobRepository>(
      jobs, assertActive, 'source_jobs', jobOperations,
    ),
    dataViews: wrapRepository<typeof dataViews, SourceDataViewRepository>(
      dataViews, assertActive, 'source_data_views', dataViewOperations,
    ),
    deletions: wrapRepository<typeof deletions, SourceDeletionRepository>(
      deletions, assertActive, 'source_deletions', deletionOperations,
    ),
    quotaLimits,
  }
}
