import type {
  SourceDeletionClaim,
  SourceDeletionInventoryEntry,
  SourceDeletionStore,
} from './source-deletion-store.js'
import { SOURCE_JOB_LEASE_MS } from './source-job-store.js'

export const SOURCE_DELETION_POLL_MS = 250

export interface SourceDeletionByteRemover {
  removeUploadArtifacts(uploadId: string): Promise<void>
  uploadArtifactsAbsent(uploadId: string): Promise<boolean>
  removeVersionArtifacts(sourceId: string, versionId: string): Promise<void>
  versionArtifactsAbsent(sourceId: string, versionId: string): Promise<boolean>
}

export interface SourceDeletionWorkerOptions {
  readonly workerId: string
}

export class SourceDeletionWorker {
  private active = false
  private timer: NodeJS.Timeout | null = null
  private drainPromise: Promise<number> | null = null

  constructor(
    private readonly deletions: SourceDeletionStore,
    private readonly bytes: SourceDeletionByteRemover,
    private readonly options: SourceDeletionWorkerOptions,
  ) {}

  start(): void {
    if (this.active) return
    this.active = true
    this.schedule(0)
  }

  wake(): void {
    if (this.active) this.schedule(0)
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

  async runOne(fixedNow?: number): Promise<boolean> {
    const currentTime = fixedNow === undefined ? () => Date.now() : () => fixedNow
    if (this.deletions.confirmNextCancellation(currentTime())) return true
    const recovery = this.deletions.recoverExpiredClaims(currentTime())
    if (recovery.requeued > 0 || recovery.partial > 0) return true
    const claim = this.deletions.claimNext(this.options.workerId, currentTime())
    if (!claim) return false
    await this.execute(claim, currentTime)
    return true
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
        if (this.active) this.schedule(SOURCE_DELETION_POLL_MS)
      })
    }, delayMs)
    this.timer.unref()
  }

  private async execute(
    claim: SourceDeletionClaim,
    currentTime: () => number,
  ): Promise<void> {
    const heartbeat = setInterval(() => {
      try {
        this.deletions.renewClaim(claim.jobId, claim.claimToken)
      } catch {
        // The next durable mutation observes the lease truth.
      }
    }, Math.floor(SOURCE_JOB_LEASE_MS / 3))
    heartbeat.unref()
    try {
      await this.executeClaim(claim, currentTime)
    } finally {
      clearInterval(heartbeat)
    }
  }

  private async executeClaim(
    claim: SourceDeletionClaim,
    currentTime: () => number,
  ): Promise<void> {
    let checkpoint = claim.checkpoint
    if (checkpoint === 0) {
      if (this.deletions.startDestruction(
        claim.jobId, claim.claimToken, currentTime(),
      ) !== 'advanced') return
      checkpoint = 1
    }

    const inventory = this.deletions.getInventoryEntries(claim.jobId)
    for (const artifact of inventory) {
      if (artifact.state === 'verified_absent') continue
      if (!this.deletions.renewClaim(
        claim.jobId, claim.claimToken, currentTime(),
      )) return
      try {
        const requested = await this.removeArtifact(claim, artifact, currentTime())
        if (requested && this.deletions.markArtifact(
          claim.jobId,
          claim.claimToken,
          artifact.kind,
          artifact.id,
          'removed',
          currentTime(),
        ) !== 'advanced') return
      } catch {
        // Verification, not the remove request, determines the durable result.
      }
    }

    if (checkpoint < 2) {
      if (this.deletions.advanceCheckpoint(
        claim.jobId, claim.claimToken, 1, 2, currentTime(),
      ) !== 'advanced') return
      checkpoint = 2
    }

    for (const artifact of this.deletions.getInventoryEntries(claim.jobId)) {
      if (artifact.state === 'verified_absent') continue
      if (!this.deletions.renewClaim(
        claim.jobId, claim.claimToken, currentTime(),
      )) return
      let absent = false
      try {
        absent = await this.verifyArtifact(claim, artifact, currentTime())
      } catch {
        absent = false
      }
      if (this.deletions.markArtifact(
        claim.jobId,
        claim.claimToken,
        artifact.kind,
        artifact.id,
        absent ? 'verified_absent' : 'failed',
        currentTime(),
      ) !== 'advanced') return
    }

    if (checkpoint < 3) {
      if (this.deletions.advanceCheckpoint(
        claim.jobId, claim.claimToken, 2, 3, currentTime(),
      ) !== 'advanced') return
    }
    this.deletions.finish(claim.jobId, claim.claimToken, currentTime())
  }

  private async removeArtifact(
    claim: SourceDeletionClaim,
    artifact: SourceDeletionInventoryEntry,
    now: number,
  ): Promise<boolean> {
    switch (artifact.kind) {
      case 'immutable_original':
      case 'placed_candidate':
        if (!this.deletions.versionLocatorMatches(
          claim.jobId, artifact.kind, artifact.id,
        )) return false
        await this.bytes.removeVersionArtifacts(claim.sourceId, artifact.id)
        return true
      case 'upload_staging':
        await this.bytes.removeUploadArtifacts(artifact.id)
        return this.deletions.removeControlArtifact(
          claim.jobId, claim.claimToken, artifact.kind, artifact.id, now,
        )
      case 'derived_resource':
      case 'source_job':
      case 'idempotency_replay':
      case 'grant_mutation_replay':
        return this.deletions.removeControlArtifact(
          claim.jobId, claim.claimToken, artifact.kind, artifact.id, now,
        )
      case 'access_grant_revocation':
        return this.deletions.ensureGrantRevoked(claim.jobId, artifact.id, now)
      case 'data_view':
      case 'search_index':
      case 'retrieval_cache':
        return false
    }
  }

  private async verifyArtifact(
    claim: SourceDeletionClaim,
    artifact: SourceDeletionInventoryEntry,
    now: number,
  ): Promise<boolean> {
    switch (artifact.kind) {
      case 'immutable_original':
      case 'placed_candidate':
        if (!this.deletions.versionLocatorMatches(
          claim.jobId, artifact.kind, artifact.id,
        )) return false
        return await this.bytes.versionArtifactsAbsent(claim.sourceId, artifact.id) &&
          this.deletions.controlArtifactAbsent(artifact.kind, artifact.id)
      case 'upload_staging': {
        if (!await this.bytes.uploadArtifactsAbsent(artifact.id)) return false
        if (!this.deletions.controlArtifactAbsent(artifact.kind, artifact.id)) {
          this.deletions.removeControlArtifact(
            claim.jobId, claim.claimToken, artifact.kind, artifact.id, now,
          )
        }
        return this.deletions.controlArtifactAbsent(artifact.kind, artifact.id)
      }
      case 'derived_resource':
      case 'source_job':
      case 'idempotency_replay':
      case 'grant_mutation_replay':
        return this.deletions.controlArtifactAbsent(artifact.kind, artifact.id)
      case 'access_grant_revocation':
        return this.deletions.grantRevocationEffective(claim.jobId, artifact.id)
      case 'data_view':
      case 'search_index':
      case 'retrieval_cache':
        return false
    }
  }
}
