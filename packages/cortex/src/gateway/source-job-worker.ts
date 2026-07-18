import type {
  InspectedSourceBytes,
  SourceInspectionLimits,
} from './source-byte-store.js'
import { SourceByteStoreError } from './source-byte-store.js'
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
    if (!claim) return false
    await this.execute(claim, currentTime)
    return true
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
    case 'search_invalid': return null
  }
}
