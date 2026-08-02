/**
 * ChannelJobWorker (CC1) — executes channel procedures from the durable
 * store, one step at a time, restart-safe. Cloned from the source-job
 * worker shape (poll loop, claim → execute → finish/defer, cancellation
 * confirmation), with the procedure registry supplying the steps and the
 * gate mechanic pausing execution:
 *
 *   - work step: renew lease, run, persist state atomically with the
 *     checkpoint advance. TransientStepError → defer (costs an attempt);
 *     ProcedureStepError → finish failed with its code; anything else →
 *     transient with the same attempt budget.
 *   - gate step: an approve decision recorded by the store is consumed
 *     (advance past the gate); otherwise the job parks and the worker
 *     moves on. Declines never reach the worker — the store ends the job
 *     at decision time.
 *
 * A job whose operation has no registered procedure fails honestly
 * (`procedure_unknown`) instead of sitting in the queue forever.
 */

import type {
  ChannelJobClaim,
} from './channel-job-store.js'
import type { ChannelJobRepository } from '../storage/platform-repositories.js'
import {
  ChannelProcedureRegistry,
  gateStepId,
  ProcedureStepError,
  TransientStepError,
  type ChannelProcedureContext,
} from './channel-procedures.js'

export const CHANNEL_JOB_POLL_MS = 250
export const CHANNEL_JOB_RETRY_MS = 5_000

export interface ChannelJobWorkerOptions {
  readonly workerId: string
}

export class ChannelJobWorker {
  private active = false
  private timer: NodeJS.Timeout | null = null
  private drainPromise: Promise<number> | null = null

  constructor(
    private readonly jobs: ChannelJobRepository,
    private readonly procedures: ChannelProcedureRegistry,
    private readonly options: ChannelJobWorkerOptions,
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
        if (this.active) this.schedule(CHANNEL_JOB_POLL_MS)
      })
    }, delayMs)
    this.timer.unref()
  }

  async runOne(fixedNow?: number): Promise<boolean> {
    const currentTime = fixedNow === undefined ? () => Date.now() : () => fixedNow
    if (await this.jobs.confirmNextUnclaimedCancellation(currentTime())) return true
    const claim = await this.jobs.claimNext(this.options.workerId, currentTime())
    if (!claim) return false
    await this.execute(claim, currentTime)
    return true
  }

  private async execute(
    claim: ChannelJobClaim,
    currentTime: () => number,
  ): Promise<void> {
    const procedure = this.procedures.get(claim.operation)
    if (!procedure) {
      await this.finishFailed(claim, 'procedure_unknown', currentTime())
      return
    }
    if (claim.stepCount !== procedure.steps.length) {
      // The registered procedure changed shape since this job was enqueued —
      // running a different machine against old checkpoints would be a lie.
      await this.finishFailed(claim, 'procedure_shape_changed', currentTime())
      return
    }

    const state = claim.state
    let checkpoint = claim.checkpoint

    while (checkpoint < procedure.steps.length) {
      const step = procedure.steps[checkpoint]!
      if (await this.jobs.renewLease(claim.jobId, claim.claimToken, currentTime()) !== 'ok') {
        await this.confirmCancellation(claim, currentTime())
        return
      }

      if (step.kind === 'gate') {
        const gateId = gateStepId(claim.operation, step.name)
        if (claim.gateResponse?.gateId === gateId) {
          const consumed = await this.jobs.consumeGateResponse(
            claim.jobId, claim.claimToken, checkpoint, gateId, currentTime(),
          )
          if (consumed !== 'advanced') {
            await this.confirmCancellation(claim, currentTime())
            return
          }
          checkpoint += 1
          continue
        }
        const spec = step.gate(this.buildContext(claim, state, currentTime))
        if (spec.id !== gateId) {
          await this.finishFailed(claim, 'gate_id_mismatch', currentTime())
          return
        }
        const parked = await this.jobs.parkForGate(
          claim.jobId, claim.claimToken, spec, currentTime(),
        )
        if (parked !== 'parked') await this.confirmCancellation(claim, currentTime())
        return
      }

      try {
        await step.run(this.buildContext(claim, state, currentTime))
      } catch (error) {
        await this.handleStepFailure(claim, error, currentTime())
        return
      }
      const advanced = await this.jobs.advanceCheckpoint(
        claim.jobId, claim.claimToken, checkpoint, state, currentTime(),
      )
      if (advanced !== 'advanced') {
        await this.confirmCancellation(claim, currentTime())
        return
      }
      checkpoint += 1
    }

    const finished = await this.jobs.finish(
      claim.jobId, claim.claimToken, 'succeeded', 'procedure_complete', currentTime(),
    )
    if (finished !== 'finished') await this.confirmCancellation(claim, currentTime())
  }

  private buildContext(
    claim: ChannelJobClaim,
    state: Record<string, unknown>,
    currentTime: () => number,
  ): ChannelProcedureContext {
    return {
      jobId: claim.jobId,
      profileId: claim.profileId,
      channelKind: claim.channelKind,
      channelId: claim.channelId,
      params: claim.params,
      state,
      workLine: async (title, detail): Promise<void> => {
        await this.jobs.appendWorkLine(
          claim.jobId, claim.claimToken, title, detail, currentTime(),
        )
      },
      receipt: async (input): Promise<void> => {
        await this.jobs.appendReceipt({
          jobId: claim.jobId,
          profileId: claim.profileId,
          channelKind: claim.channelKind,
          ...(claim.channelId ? { channelId: claim.channelId } : {}),
          ...input,
        }, currentTime())
      },
      cancelRequested: async (): Promise<boolean> =>
        (await this.jobs.get(claim.jobId))?.state === 'cancel_requested',
      renewLease: async (): Promise<boolean> =>
        await this.jobs.renewLease(claim.jobId, claim.claimToken, currentTime()) === 'ok',
    }
  }

  private async handleStepFailure(
    claim: ChannelJobClaim,
    error: unknown,
    now: number,
  ): Promise<void> {
    if (error instanceof ProcedureStepError) {
      await this.finishFailed(claim, error.outcomeCode, now)
      return
    }
    const retryAfterMs = error instanceof TransientStepError
      ? error.retryAfterMs
      : CHANNEL_JOB_RETRY_MS
    const deferred = await this.jobs.deferUntil(
      claim.jobId, claim.claimToken, now + retryAfterMs, now,
    )
    if (deferred === 'attempts_exhausted') {
      await this.finishFailed(claim, 'attempts_exhausted', now)
    } else if (deferred !== 'deferred') {
      await this.confirmCancellation(claim, now)
    }
  }

  private async finishFailed(claim: ChannelJobClaim, code: string, now: number): Promise<void> {
    const finished = await this.jobs.finish(claim.jobId, claim.claimToken, 'failed', code, now)
    if (finished !== 'finished') await this.confirmCancellation(claim, now)
  }

  private async confirmCancellation(claim: ChannelJobClaim, now: number): Promise<void> {
    await this.jobs.confirmCancelled(claim.jobId, claim.claimToken, now)
  }
}
