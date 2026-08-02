import type { SourceDataViewStore } from '../gateway/source-data-view-store.js'
import type { SourceDeletionStore } from '../gateway/source-deletion-store.js'
import type { SourceJobStore } from '../gateway/source-job-store.js'
import type { SourceQuotaLimits } from '../gateway/source-quota-policy.js'
import type { SourceStore } from '../gateway/source-store.js'
import type { SourceUploadStore } from '../gateway/source-upload-store.js'

type AsyncMethods<T extends object> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never
}

type SourceStorePort = Pick<SourceStore,
  | 'create'
  | 'getScoped'
  | 'listScoped'
>

type SourceUploadStorePort = Pick<SourceUploadStore,
  | 'create'
  | 'listOpenCheckpoints'
  | 'getScoped'
  | 'getCurrentSourceIdentity'
  | 'findChunk'
  | 'advanceChunk'
  | 'beginCompletion'
  | 'finishCompletion'
  | 'getCompletedVersion'
  | 'getVersionScoped'
  | 'markFailed'
  | 'markFailedAfterVerifiedCleanup'
>

type SourceJobStorePort = Pick<SourceJobStore,
  | 'enqueue'
  | 'enqueuePreparation'
  | 'getScoped'
  | 'hasTargetScoped'
  | 'claimNext'
  | 'getClaimedInspectionTarget'
  | 'getClaimedPreparationTarget'
  | 'advanceCheckpoint'
  | 'recoverExpiredClaims'
  | 'requestCancel'
  | 'confirmNextUnclaimedCancellation'
  | 'confirmCancelled'
  | 'deferUntil'
  | 'finish'
  | 'finishInspection'
  | 'finishPreparation'
  | 'getResourceScoped'
>

type SourceDataViewStorePort = Pick<SourceDataViewStore,
  | 'enqueue'
  | 'getJobScoped'
  | 'requestCancel'
  | 'claimNext'
  | 'claimNextCancellation'
  | 'getClaimedTarget'
  | 'renewClaim'
  | 'advanceCheckpoint'
  | 'publish'
  | 'deferUntil'
  | 'finishFailed'
  | 'confirmCancelled'
  | 'fenceUnpublishedArtifactCleanup'
  | 'recoverExpiredClaims'
  | 'getViewScoped'
  | 'getProtectedSelectionTargetScoped'
  | 'getPrivateArtifact'
>

type SourceDeletionStorePort = Pick<SourceDeletionStore,
  | 'plan'
  | 'getScoped'
  | 'getPublicByJobScoped'
  | 'getPublicBySourceScoped'
  | 'getInventory'
  | 'getInventoryEntries'
  | 'versionLocatorMatches'
  | 'dataViewLocator'
  | 'claimNext'
  | 'startDestruction'
  | 'renewClaim'
  | 'advanceCheckpoint'
  | 'markArtifact'
  | 'removeControlArtifact'
  | 'controlArtifactAbsent'
  | 'removeRetrievalCacheArtifact'
  | 'retrievalCacheArtifactAbsent'
  | 'finish'
  | 'retryPartial'
  | 'retryPartialScoped'
  | 'recoverExpiredClaims'
  | 'confirmNextCancellation'
  | 'requestCancellation'
  | 'confirmCancellation'
  | 'ensureGrantRevoked'
  | 'grantRevocationEffective'
>

export type SourceRepository = AsyncMethods<SourceStorePort>
export type SourceUploadRepository = AsyncMethods<SourceUploadStorePort>
export type SourceJobRepository = AsyncMethods<SourceJobStorePort>
export type SourceDataViewRepository = AsyncMethods<SourceDataViewStorePort>
export type SourceDeletionRepository = AsyncMethods<SourceDeletionStorePort>

export interface SourceRepositories {
  readonly sources: SourceRepository
  readonly uploads: SourceUploadRepository
  readonly jobs: SourceJobRepository
  readonly dataViews: SourceDataViewRepository
  readonly deletions: SourceDeletionRepository
  readonly quotaLimits: SourceQuotaLimits
}
