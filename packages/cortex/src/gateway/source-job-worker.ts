import type {
  PrepareCsvDataViewArtifactInput,
  PreparedCsvDataViewArtifact,
  InspectedSourceBytes,
  SourceInspectionLimits,
} from './source-byte-store.js'
import { SourceByteStoreError } from './source-byte-store.js'
import { CsvDataViewError } from './csv-data-view.js'
import type {
  SourceDataViewJobClaim,
  SourceDataViewStore,
} from './source-data-view-store.js'
import { SOURCE_DATA_VIEW_JOB_LEASE_MS } from './source-data-view-store.js'
import type {
  SourceJobClaim,
  SourceJobCheckpointResult,
  SourceJobStore,
} from './source-job-store.js'

export const SOURCE_INSPECTION_MAX_BYTES = 16 * 1024 * 1024
export const SOURCE_INSPECTION_TIMEOUT_MS = 5_000
export const SOURCE_INSPECTION_RETRY_MS = 1_000
export const SOURCE_INSPECTION_POLL_MS = 250
export const SOURCE_PREPARATION_MAX_BYTES = 16 * 1024 * 1024
export const SOURCE_PREPARATION_TIMEOUT_MS = 5_000
export const SOURCE_PREPARATION_MAX_RESOURCES = 1 as const

export interface SourceJobReader {
  inspectPlaced(
    objectKey: string,
    declaredMediaType: 'text/plain' | 'application/pdf',
    limits: SourceInspectionLimits,
  ): Promise<InspectedSourceBytes>
}

export interface SourceDataViewWorkerBytes {
  prepareCsvDataViewArtifact(
    input: PrepareCsvDataViewArtifactInput,
  ): Promise<PreparedCsvDataViewArtifact>
  removeDataViewArtifact(
    sourceId: string,
    sourceVersionId: string,
    dataViewId: string,
  ): Promise<void>
  dataViewArtifactAbsent(
    sourceId: string,
    sourceVersionId: string,
    dataViewId: string,
  ): Promise<boolean>
}

export interface SourceJobWorkerOptions {
  readonly workerId: string
}

export class SourceJobWorker {
  private active = false
  private timer: NodeJS.Timeout | null = null
  private drainPromise: Promise<number> | null = null

  constructor(
    private readonly jobs: SourceJobStore,
    private readonly bytes: SourceJobReader,
    private readonly options: SourceJobWorkerOptions,
    private readonly dataViews?: SourceDataViewStore,
  ) {}

  start(): void {
    if (this.active) return
    this.active = true
    this.schedule(0)
  }

  wake(): void {
    if (!this.active) return
    this.schedule(0)
  }

  async stop(): Promise<void> {
    this.active = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    await this.drainPromise
  }

  async runAvailable(now?: number): Promise<number> {
    let handled = 0
    while (await this.runOne(now)) handled += 1
    return handled
  }

  private schedule(delayMs: number): void {
    if (!this.active) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      if (!this.active || this.drainPromise) return
      this.drainPromise = this.runAvailable().catch(() => 0)
      void this.drainPromise.finally(() => {
        this.drainPromise = null
        if (this.active) this.schedule(SOURCE_INSPECTION_POLL_MS)
      })
    }, delayMs)
    this.timer.unref()
  }

  async runOne(fixedNow?: number): Promise<boolean> {
    const currentTime = fixedNow === undefined ? () => Date.now() : () => fixedNow
    if (this.jobs.confirmNextUnclaimedCancellation(currentTime())) return true
    const claim = this.jobs.claimNext(this.options.workerId, currentTime())
    if (claim) {
      await this.execute(claim, currentTime)
      return true
    }
    if (!this.dataViews || !isDataViewWorkerBytes(this.bytes)) return false
    const cancellation = this.dataViews.claimNextCancellation(
      dataViewWorkerId(this.options.workerId, '-data-view-cancel'), currentTime(),
    )
    if (cancellation) {
      await this.executeDataViewCancellation(cancellation, this.bytes, currentTime)
      return true
    }
    const dataViewClaim = this.dataViews.claimNext(
      dataViewWorkerId(this.options.workerId, '-data-view'), currentTime(),
    )
    if (!dataViewClaim) return false
    await this.executeDataView(dataViewClaim, this.bytes, currentTime)
    return true
  }

  private async executeDataView(
    claim: SourceDataViewJobClaim,
    bytes: SourceJobReader & SourceDataViewWorkerBytes,
    currentTime: () => number,
  ): Promise<void> {
    const heartbeat = setInterval(() => {
      try {
        this.dataViews!.renewClaim(claim.jobId, claim.claimToken)
      } catch {
        // The next durable mutation observes the lease truth.
      }
    }, Math.floor(SOURCE_DATA_VIEW_JOB_LEASE_MS / 3))
    heartbeat.unref()
    try {
      await this.executeDataViewClaim(claim, bytes, currentTime)
    } finally {
      clearInterval(heartbeat)
    }
  }

  private async executeDataViewClaim(
    claim: SourceDataViewJobClaim,
    bytes: SourceJobReader & SourceDataViewWorkerBytes,
    currentTime: () => number,
  ): Promise<void> {
    const store = this.dataViews!
    const target = store.getClaimedTarget(claim.jobId, claim.claimToken, currentTime())
    if (!target) {
      if (await this.cleanupOwnedDataView(claim, bytes, currentTime())) {
        store.confirmCancelled(claim.jobId, claim.claimToken, currentTime())
      }
      return
    }
    if (claim.checkpoint < 1 && store.advanceCheckpoint(
      claim.jobId, claim.claimToken, 0, 1, currentTime(),
    ) !== 'advanced') return

    let artifact: PreparedCsvDataViewArtifact
    try {
      artifact = await bytes.prepareCsvDataViewArtifact(target)
    } catch (error) {
      if (await this.cleanupOwnedDataView(claim, bytes, currentTime()) &&
          store.confirmCancelled(
            claim.jobId, claim.claimToken, currentTime(),
          ) === 'cancelled') return
      this.finishDataViewFailure(claim, error, currentTime())
      return
    }
    if (claim.checkpoint < 2 && store.advanceCheckpoint(
      claim.jobId, claim.claimToken, 1, 2, currentTime(),
    ) !== 'advanced') {
      if (await this.cleanupOwnedDataView(claim, bytes, currentTime())) {
        store.confirmCancelled(claim.jobId, claim.claimToken, currentTime())
      }
      return
    }
    if (claim.checkpoint < 3 && store.advanceCheckpoint(
      claim.jobId, claim.claimToken, 2, 3, currentTime(),
    ) !== 'advanced') {
      if (await this.cleanupOwnedDataView(claim, bytes, currentTime())) {
        store.confirmCancelled(claim.jobId, claim.claimToken, currentTime())
      }
      return
    }
    try {
      const published = store.publish(
        claim.jobId, claim.claimToken, artifact, currentTime(),
      )
      if (published === 'finished') return
      if (await this.cleanupOwnedDataView(claim, bytes, currentTime())) {
        if (store.confirmCancelled(
          claim.jobId, claim.claimToken, currentTime(),
        ) === 'cancelled') return
        store.finishFailed(
          claim.jobId, claim.claimToken, 'data_view_publication_conflict', currentTime(),
        )
      }
    } catch (error) {
      const cleaned = await this.cleanupOwnedDataView(claim, bytes, currentTime())
      if (!cleaned) return
      if (store.confirmCancelled(
        claim.jobId, claim.claimToken, currentTime(),
      ) === 'cancelled') return
      this.finishDataViewFailure(claim, error, currentTime())
    }
  }

  private async executeDataViewCancellation(
    claim: SourceDataViewJobClaim,
    bytes: SourceDataViewWorkerBytes,
    currentTime: () => number,
  ): Promise<void> {
    const heartbeat = setInterval(() => {
      try {
        this.dataViews!.renewClaim(claim.jobId, claim.claimToken)
      } catch {
        // Cleanup and cancellation confirmation remain lease-fenced.
      }
    }, Math.floor(SOURCE_DATA_VIEW_JOB_LEASE_MS / 3))
    heartbeat.unref()
    try {
      if (await this.cleanupOwnedDataView(claim, bytes, currentTime())) {
        this.dataViews!.confirmCancelled(
          claim.jobId, claim.claimToken, currentTime(),
        )
      }
    } finally {
      clearInterval(heartbeat)
    }
  }

  private finishDataViewFailure(
    claim: SourceDataViewJobClaim,
    error: unknown,
    now: number,
  ): void {
    const store = this.dataViews!
    const deterministic = dataViewFailureCode(error)
    if (deterministic) {
      store.finishFailed(claim.jobId, claim.claimToken, deterministic, now)
      return
    }
    if (claim.attempt >= claim.maxAttempts) {
      store.finishFailed(claim.jobId, claim.claimToken, 'data_view_unavailable', now)
      return
    }
    store.deferUntil(
      claim.jobId, claim.claimToken, now + SOURCE_INSPECTION_RETRY_MS, now,
    )
  }

  private async cleanupOwnedDataView(
    claim: SourceDataViewJobClaim,
    bytes: SourceDataViewWorkerBytes,
    now: number,
  ): Promise<boolean> {
    const store = this.dataViews!
    if (!store.fenceUnpublishedArtifactCleanup(
      claim.jobId, claim.claimToken, claim.dataViewId, now,
    )) return false
    try {
      await bytes.removeDataViewArtifact(
        claim.sourceId, claim.sourceVersionId, claim.dataViewId,
      )
      return await bytes.dataViewArtifactAbsent(
        claim.sourceId, claim.sourceVersionId, claim.dataViewId,
      )
    } catch {
      store.finishFailed(
        claim.jobId, claim.claimToken, 'artifact_cleanup_failed', now,
      )
      return false
    }
  }

  private async execute(
    claim: SourceJobClaim,
    currentTime: () => number,
  ): Promise<void> {
    const targetTime = currentTime()
    const target = claim.operation === 'inspect_format'
      ? this.jobs.getClaimedInspectionTarget(claim.jobId, claim.claimToken, targetTime)
      : this.jobs.getClaimedPreparationTarget(claim.jobId, claim.claimToken, targetTime)
    if (!target) {
      this.confirmCancellation(claim, targetTime)
      return
    }
    if (!this.advanceTo(claim, 1, currentTime())) return

    let inspected: InspectedSourceBytes
    try {
      inspected = await this.bytes.inspectPlaced(
        target.objectKey,
        target.verifiedMediaType,
        {
          maxBytes: claim.operation === 'inspect_format'
            ? SOURCE_INSPECTION_MAX_BYTES : SOURCE_PREPARATION_MAX_BYTES,
          timeoutMs: claim.operation === 'inspect_format'
            ? SOURCE_INSPECTION_TIMEOUT_MS : SOURCE_PREPARATION_TIMEOUT_MS,
        },
      )
    } catch (error) {
      this.handleReadFailure(claim, error, currentTime())
      return
    }

    if (inspected.byteCount !== target.expectedByteCount ||
        inspected.checksum !== target.expectedChecksum ||
        inspected.verifiedMediaType !== target.verifiedMediaType) {
      this.finishOrRetry(
        claim, 'failed', 'source_object_mismatch', currentTime(),
      )
      return
    }
    if (!this.advanceTo(claim, 2, currentTime())) return
    if (!this.advanceTo(claim, 3, currentTime())) return
    this.finishOrRetry(
      claim,
      'succeeded',
      claim.operation === 'inspect_format' ? 'inspection_complete' : 'preparation_complete',
      currentTime(),
    )
  }

  private advanceTo(
    claim: SourceJobClaim,
    checkpoint: number,
    now: number,
  ): boolean {
    if (claim.checkpoint >= checkpoint) return true
    const result = this.jobs.advanceCheckpoint(
      claim.jobId,
      claim.claimToken,
      checkpoint - 1,
      checkpoint,
      now,
    )
    if (result !== 'advanced') this.handleLostClaim(claim, result, now)
    return result === 'advanced'
  }

  private handleReadFailure(
    claim: SourceJobClaim,
    error: unknown,
    now: number,
  ): void {
    const code = error instanceof SourceByteStoreError
      ? byteFailureCode(error.code, claim.operation) : null
    if (code) {
      this.finishOrRetry(claim, 'failed', code, now)
      return
    }
    if (claim.attempt >= claim.maxAttempts) {
      this.finishOrRetry(
        claim,
        'failed',
        claim.operation === 'inspect_format'
          ? 'inspection_unavailable' : 'preparation_unavailable',
        now,
      )
      return
    }
    const result = this.jobs.deferUntil(
      claim.jobId,
      claim.claimToken,
      now + SOURCE_INSPECTION_RETRY_MS,
      now,
    )
    if (result !== 'deferred') this.confirmCancellation(claim, now)
  }

  private handleLostClaim(
    claim: SourceJobClaim,
    _result: SourceJobCheckpointResult,
    now: number,
  ): void {
    this.confirmCancellation(claim, now)
  }

  private confirmCancellation(claim: SourceJobClaim, now: number): void {
    this.jobs.confirmCancelled(claim.jobId, claim.claimToken, now)
  }

  private finishOrRetry(
    claim: SourceJobClaim,
    outcome: 'succeeded' | 'partial' | 'failed',
    code: string,
    now: number,
  ): void {
    try {
      const result = claim.operation === 'inspect_format'
        ? this.jobs.finishInspection(claim.jobId, claim.claimToken, outcome, code, now)
        : this.jobs.finishPreparation(claim.jobId, claim.claimToken, outcome, code, now)
      if (result !== 'finished') this.confirmCancellation(claim, now)
    } catch {
      if (claim.attempt >= claim.maxAttempts) {
        try {
          const unavailable = claim.operation === 'inspect_format'
            ? 'inspection_unavailable' : 'preparation_unavailable'
          if (claim.operation === 'inspect_format') {
            this.jobs.finishInspection(
              claim.jobId, claim.claimToken, 'failed', unavailable, now,
            )
          } else {
            this.jobs.finishPreparation(
              claim.jobId, claim.claimToken, 'failed', unavailable, now,
            )
          }
        } catch {
          // The durable lease remains truthful and startup recovery owns it.
        }
        return
      }
      try {
        this.jobs.deferUntil(
          claim.jobId,
          claim.claimToken,
          now + SOURCE_INSPECTION_RETRY_MS,
          now,
        )
      } catch {
        // The durable lease remains truthful and startup recovery owns it.
      }
    }
  }
}

function byteFailureCode(
  code: SourceByteStoreError['code'],
  operation: SourceJobClaim['operation'],
): string | null {
  switch (code) {
    case 'object_missing': return 'source_object_missing'
    case 'inspection_too_large': return 'source_object_oversized'
    case 'inspection_timeout': return operation === 'inspect_format'
      ? 'inspection_timeout' : 'preparation_timeout'
    case 'format_invalid': return 'source_format_invalid'
    case 'storage_inconsistent': return 'source_storage_inconsistent'
    case 'chunk_too_large':
    case 'object_mismatch':
    case 'range_invalid':
    case 'range_too_large':
    case 'search_invalid':
    case 'data_view_invalid':
    case 'data_view_too_large':
    case 'data_view_timeout': return null
  }
}

function isDataViewWorkerBytes(
  bytes: SourceJobReader,
): bytes is SourceJobReader & SourceDataViewWorkerBytes {
  const candidate = bytes as Partial<SourceDataViewWorkerBytes>
  return typeof candidate.prepareCsvDataViewArtifact === 'function' &&
    typeof candidate.removeDataViewArtifact === 'function' &&
    typeof candidate.dataViewArtifactAbsent === 'function'
}

function dataViewWorkerId(base: string, suffix: string): string {
  return `${base.slice(0, 64 - suffix.length)}${suffix}`
}

function dataViewFailureCode(error: unknown): string | null {
  if (error instanceof CsvDataViewError) return error.code
  if (!(error instanceof SourceByteStoreError)) return null
  switch (error.code) {
    case 'object_missing': return 'source_object_missing'
    case 'object_mismatch': return 'source_object_mismatch'
    case 'inspection_too_large': return 'source_object_oversized'
    case 'inspection_timeout': return 'preparation_timeout'
    case 'format_invalid': return 'source_format_invalid'
    case 'storage_inconsistent': return 'source_storage_inconsistent'
    case 'data_view_invalid': return 'data_view_invalid'
    case 'data_view_too_large': return 'data_view_too_large'
    case 'data_view_timeout': return 'preparation_timeout'
    case 'chunk_too_large':
    case 'range_invalid':
    case 'range_too_large':
    case 'search_invalid': return null
  }
}
