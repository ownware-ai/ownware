/**
 * ScheduleRunner — the per-profile scheduling engine.
 *
 * A boot sweep + a periodic tick (~60s, modeled on the gateway retention
 * timer) find due schedules and fire each as a normal single-agent run via
 * the shared `startProfileRun` core. `next_run_at` in SQLite is the durable
 * truth; the timer is only an optimization.
 *
 * Reliability spine (Slice 3):
 *   - advance-before-fire  → at-most-once across a crash (a crash mid-run
 *     drops at most one occurrence rather than replaying).
 *   - collapse-once        → a long-down machine fires ONE catch-up, then
 *     resumes forward — never a backlog burst.
 *   - catch_up_policy      → per schedule: 'catch-up' (default, run once on
 *     reopen) | 'skip' (don't run late) | 'window' (only if recent).
 *   - boot reconcile       → orphaned 'running' runs become failed, not
 *     silently fine.
 *
 * Cadence math here covers `interval` + `once`; daily/weekly/cron land in
 * Slice 5 (this engine does not reschedule them yet — it fires once).
 */

import type { SqliteScheduleStore } from './store.js'
import type { ScheduleDto, ScheduleRunDto, ScheduleState, RunStatus } from './types.js'
import { computeNextRun, graceMs, type CadenceContext } from './cadence.js'
import { DEFAULT_SAFETY_LEVEL, type SafetyLevel } from './safety.js'
import { shouldNotify } from './delivery.js'

const MINUTE_MS = 60_000

/**
 * Honest outcome from a run's terminal RunResult. Only 'completed' is a
 * success — 'aborted'/'error'/unknown are failures (Principle 21: never a
 * false "fine"). The thread status would collapse aborted→completed, so we
 * classify from the run's real verdict instead.
 */
export function classifyOutcome(
  result: { readonly status?: string; readonly error?: string; readonly errorEvent?: string } | undefined,
): {
  readonly runStatus: RunStatus
  readonly errorMessage?: string
} {
  switch (result?.status) {
    case 'completed':
      // HON-1: a run can return 'completed' while the agent's turn ended in
      // an in-band error message (e.g. a provider auth failure recorded as a
      // role:'error' message, not a thrown/aborted run). That is NOT an
      // honest success — classify it as failed-to-run with the real message.
      if (result.errorEvent != null && result.errorEvent.length > 0) {
        return { runStatus: 'failed-to-run', errorMessage: result.errorEvent }
      }
      return { runStatus: 'succeeded' }
    case 'error':
      return { runStatus: 'failed-to-run', errorMessage: result.error ?? 'Run errored' }
    case 'aborted':
      return { runStatus: 'failed-to-run', errorMessage: 'Run was aborted or timed out' }
    default:
      return {
        runStatus: 'failed-to-run',
        errorMessage: `Unexpected run outcome: ${result?.status ?? 'unknown'}`,
      }
  }
}

/**
 * One outbound push of a finished run's result (Slice 8 delivery). The sink
 * is the seam that keeps layering intact: cortex never imports a channel
 * adapter — the host process (e.g. `ownware serve`, which also runs shuttle's
 * ChannelRunner) registers a sink that does the actual `sendText`.
 */
export interface ScheduleDelivery {
  readonly channel: string
  readonly target: string
  readonly text: string
  readonly scheduleId: string
  readonly scheduleName: string
  readonly runId: string
  readonly profileId: string
  readonly runStatus: RunStatus
}
export type ScheduleDeliverySink = (delivery: ScheduleDelivery) => Promise<void>

/** Minimal shape of `startProfileRun` the engine depends on (run.ts). */
export type StartProfileRunFn = (params: {
  readonly profileId?: string
  readonly prompt: string
  readonly model?: string
  readonly workspaceId?: string
  /** Unattended safety envelope — filters the run's tools + forces 'auto' mode. */
  readonly safetyLevel?: SafetyLevel
  /** Scheduling ids so held (draft-approval) tool calls attach to approval rows. */
  readonly approvalScheduleId?: string
  readonly approvalRunId?: string
}) => Promise<{ readonly threadId: string; readonly done: Promise<unknown> }>

export interface ScheduleRunnerDeps {
  readonly store: SqliteScheduleStore
  readonly startProfileRun: StartProfileRunFn
  /** Is a (previous) run on this thread still active? (overlap policy) */
  readonly isRunning: (threadId: string) => boolean
  /** Holiday predicate (used only by schedules with skipHolidays). Default: none. */
  readonly holidays?: (isoDate: string) => boolean
  /** Injectable clock — tests pass a controllable one. Default Date.now. */
  readonly now?: () => number
  /** Tick cadence in ms. Default 60s. */
  readonly tickIntervalMs?: number
  /** Error sink. Default console.error. */
  readonly onError?: (err: unknown, context: string) => void
  /** Count of approvals a finished run parked (8d) → a clean run that held
   *  drafts is classified 'needs-approval' instead of a bare success. Default
   *  none (always 0). */
  readonly pendingApprovalsForRun?: (runId: string) => number
  /** Outbound delivery seam (Slice 8). `finalText` reads the run's final
   *  assistant text (the payload); `sink` is looked up PER DELIVERY so the
   *  host can register it after boot (channels start after the gateway). */
  readonly delivery?: {
    readonly finalText: (threadId: string) => string | null
    readonly sink: () => ScheduleDeliverySink | null
  }
}

export class ScheduleRunner {
  private readonly store: SqliteScheduleStore
  private readonly startProfileRun: StartProfileRunFn
  private readonly isRunning: (threadId: string) => boolean
  private readonly cadenceCtx: CadenceContext
  private readonly now: () => number
  private readonly tickIntervalMs: number
  private readonly onError: (err: unknown, context: string) => void
  private readonly pendingApprovalsForRun?: (runId: string) => number
  private readonly delivery?: ScheduleRunnerDeps['delivery']

  private timer: ReturnType<typeof setInterval> | null = null
  private ticking = false
  private readonly inflight = new Set<Promise<unknown>>()

  constructor(deps: ScheduleRunnerDeps) {
    this.store = deps.store
    this.startProfileRun = deps.startProfileRun
    this.isRunning = deps.isRunning
    this.cadenceCtx = deps.holidays != null ? { isHoliday: deps.holidays } : {}
    this.now = deps.now ?? ((): number => Date.now())
    this.tickIntervalMs = deps.tickIntervalMs ?? MINUTE_MS
    this.onError =
      deps.onError ?? ((err, ctx): void => console.error(`[schedule-runner] ${ctx}:`, err))
    this.pendingApprovalsForRun = deps.pendingApprovalsForRun
    this.delivery = deps.delivery
  }

  /** Start: reconcile orphaned runs, sweep once (boot catch-up), then tick. */
  start(): void {
    try {
      const n = this.store.failInterruptedRuns(this.now())
      if (n > 0) console.warn(`[schedule-runner] reconciled ${n} interrupted run(s) on boot`)
    } catch (err) {
      this.onError(err, 'boot reconcile')
    }
    void this.tickOnce()
    this.timer = setInterval(() => void this.tickOnce(), this.tickIntervalMs)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  stop(): void {
    if (this.timer != null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Await all in-flight dispatches (tests / graceful drain). */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.inflight])
  }

  /**
   * Fire a schedule immediately (manual "Run now") WITHOUT touching its
   * cursor — a one-off extra run that doesn't disturb the cadence. Returns
   * the new run record (thread linked asynchronously once dispatched), or
   * null if the schedule doesn't exist.
   */
  async runNow(scheduleId: string): Promise<ScheduleRunDto | null> {
    const schedule = this.store.get(scheduleId)
    if (schedule == null) return null
    const now = this.now()
    const run = this.store.recordRun({
      scheduleId,
      scheduledFor: now,
      runStatus: 'running',
      startedAt: now,
      wasCatchUp: false,
    })
    const p = this.dispatch(schedule, run.id)
    this.inflight.add(p)
    void p.finally(() => this.inflight.delete(p))
    return run
  }

  /**
   * One sweep: fire every due schedule. Guarded so an overlapping tick (a
   * slow tick still running when the next fires) can't double-sweep. The
   * synchronous advance-before-fire makes each firing's cursor durable
   * before the async run is dispatched.
   */
  async tickOnce(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      const now = this.now()
      for (const schedule of this.store.getDue(now)) {
        try {
          this.fire(schedule, now)
        } catch (err) {
          this.onError(err, `fire schedule ${schedule.id}`)
        }
      }
    } finally {
      this.ticking = false
    }
  }

  // -- internals ------------------------------------------------------------

  private fire(schedule: ScheduleDto, now: number): void {
    const scheduledFor = schedule.nextRunAt
    if (scheduledFor == null) return // defensive — getDue already filtered

    const overdueMs = now - scheduledFor
    const isCatchUp = overdueMs > graceMs(schedule)
    const nextRun = computeNextRun(schedule, now, this.cadenceCtx)
    const nextState: ScheduleState = nextRun == null ? 'completed' : 'scheduled'

    const skip = (reason: string): void => {
      // Atomic: record the skip + advance the cursor in one transaction.
      this.store.recordRunAndAdvance({
        run: {
          scheduleId: schedule.id,
          scheduledFor,
          runStatus: 'skipped',
          skipReason: reason,
          wasCatchUp: isCatchUp,
        },
        scheduleId: schedule.id,
        advance: { nextRunAt: nextRun, lastRunAt: now, state: nextState },
      })
    }

    // 1) Catch-up policy: don't run late if the user chose skip / window.
    if (isCatchUp && schedule.catchUpPolicy === 'skip') {
      skip('asleep-caught-up')
      return
    }
    if (isCatchUp && schedule.catchUpPolicy === 'window') {
      // A missing/invalid window means "always catch up" (Infinity), NOT a
      // silent collapse to skip. Boundary is `>=` so `overdue == window`
      // skips — matching the documented "catch up only if missed < window".
      const win =
        schedule.catchUpWindowMs != null && schedule.catchUpWindowMs > 0
          ? schedule.catchUpWindowMs
          : Number.POSITIVE_INFINITY
      if (overdueMs >= win) {
        skip('asleep-caught-up')
        return
      }
    }

    // 2) Overlap: don't pile a new run on a still-running previous one.
    if (schedule.overlapPolicy === 'skip-if-running' && this.previousRunActive(schedule)) {
      skip('previous-still-running')
      return
    }

    // 3) Record the run + advance the durable cursor in ONE transaction,
    //    BEFORE dispatching (at-most-once across a crash).
    const run = this.store.recordRunAndAdvance({
      run: {
        scheduleId: schedule.id,
        scheduledFor,
        runStatus: 'running',
        startedAt: now,
        wasCatchUp: isCatchUp,
      },
      scheduleId: schedule.id,
      advance: { nextRunAt: nextRun, lastRunAt: now, state: nextState },
    })

    // 4) Dispatch the run in the background; track it for drain().
    const p = this.dispatch(schedule, run.id)
    this.inflight.add(p)
    void p.finally(() => this.inflight.delete(p))
  }

  private async dispatch(schedule: ScheduleDto, runId: string): Promise<void> {
    let threadId: string
    let done: Promise<unknown>
    try {
      const res = await this.startProfileRun({
        profileId: schedule.profileId,
        prompt: schedule.prompt,
        ...(schedule.model != null ? { model: schedule.model } : {}),
        ...(schedule.workspaceId != null ? { workspaceId: schedule.workspaceId } : {}),
        // The user's chosen level (read-only / draft-approval / full-access),
        // falling back to the safe default. Enforced as a tool filter at
        // assembly (run.ts), never a permission prompt — a scheduled run is
        // headless. Safe-by-default: unless the user opts into full-access, no
        // write/send tool is handed to the run.
        safetyLevel: schedule.safetyLevel ?? DEFAULT_SAFETY_LEVEL,
        // Tie any held write/send tool calls (draft-approval) to this run's
        // approval rows (Slice 8d).
        approvalScheduleId: schedule.id,
        approvalRunId: runId,
      })
      threadId = res.threadId
      done = res.done
    } catch (err) {
      this.onError(err, `startProfileRun for schedule ${schedule.id}`)
      const errorMessage = err instanceof Error ? err.message : String(err)
      this.store.updateRun(runId, {
        runStatus: 'failed-to-run',
        finishedAt: this.now(),
        errorMessage,
      })
      // A failure the user asked to hear about still gets pushed ("your
      // morning brief did NOT run") — with no thread, the text is the error.
      await this.maybeDeliver(schedule, runId, null, 'failed-to-run', errorMessage)
      return
    }

    // Link the thread immediately so "click the run → open the thread" and
    // the overlap check work even while the run is still in flight.
    this.store.updateRun(runId, { threadId })

    // The run's REAL terminal verdict comes from the resolved RunResult
    // (status: completed | error | aborted) — NOT the thread status, which
    // collapses aborted→completed. Only 'completed' is an honest success.
    let result: { status?: string; error?: string; errorEvent?: string } | undefined
    try {
      result = (await done) as { status?: string; error?: string; errorEvent?: string }
    } catch (err) {
      this.onError(err, `run ${runId} done`)
      result = undefined
    }
    const outcome = classifyOutcome(result)
    let runStatus = outcome.runStatus
    // A clean completion that parked ≥1 draft is 'needs-approval', not a bare
    // success — the user still has to act on it (Slice 8d). A failure stays a
    // failure regardless of any drafts.
    if (runStatus === 'succeeded' && (this.pendingApprovalsForRun?.(runId) ?? 0) > 0) {
      runStatus = 'needs-approval'
    }
    this.store.updateRun(runId, {
      runStatus,
      finishedAt: this.now(),
      ...(outcome.errorMessage != null ? { errorMessage: outcome.errorMessage } : {}),
    })
    await this.maybeDeliver(schedule, runId, threadId, runStatus, outcome.errorMessage ?? null)
  }

  /**
   * Outbound push of a terminal run (Slice 8). Consumes `shouldNotify` —
   * the honest, non-spammy rule — and records the truth in the ledger:
   *   - no `deliver` on the schedule      → delivery_status stays 'not-requested'
   *   - notify rule says quiet            → 'not-delivered', run status untouched
   *   - no sink running / send failed     → 'not-delivered'; a clean success
   *     escalates to 'failed-to-deliver' (never a fake "fine")
   *   - sent                              → 'delivered'
   */
  private async maybeDeliver(
    schedule: ScheduleDto,
    runId: string,
    threadId: string | null,
    runStatus: RunStatus,
    errorMessage: string | null,
  ): Promise<void> {
    const deliver = schedule.deliver
    if (deliver == null) return

    try {
      const notify = shouldNotify({
        runStatus,
        deliveryMode: schedule.deliveryMode,
        quietOnEmpty: schedule.quietOnEmpty,
      })
      if (!notify) {
        this.store.updateRun(runId, { deliveryStatus: 'not-delivered' })
        return
      }

      const sink = this.delivery?.sink() ?? null
      if (sink == null) {
        this.store.updateRun(runId, {
          deliveryStatus: 'not-delivered',
          ...(runStatus === 'succeeded'
            ? {
                runStatus: 'failed-to-deliver',
                errorMessage:
                  'delivery requested but no channel is running in this process (channels start with `ownware serve`)',
              }
            : {}),
        })
        return
      }

      const text = this.deliveryText(schedule, runId, threadId, runStatus, errorMessage)
      await sink({
        channel: deliver.channel,
        target: deliver.target,
        text,
        scheduleId: schedule.id,
        scheduleName: schedule.name,
        runId,
        profileId: schedule.profileId,
        runStatus,
      })
      this.store.updateRun(runId, { deliveryStatus: 'delivered' })
    } catch (err) {
      this.onError(err, `deliver run ${runId} (${deliver.channel}:${deliver.target})`)
      this.store.updateRun(runId, {
        deliveryStatus: 'not-delivered',
        ...(runStatus === 'succeeded'
          ? {
              runStatus: 'failed-to-deliver',
              errorMessage: err instanceof Error ? err.message : String(err),
            }
          : {}),
      })
    }
  }

  /** The message a channel receives — the agent's real text when there is
   *  one, an honest status line when there isn't. */
  private deliveryText(
    schedule: ScheduleDto,
    runId: string,
    threadId: string | null,
    runStatus: RunStatus,
    errorMessage: string | null,
  ): string {
    const finalText = threadId != null ? (this.delivery?.finalText(threadId) ?? null) : null
    switch (runStatus) {
      case 'succeeded':
        return finalText ?? `"${schedule.name}" ran, but produced no text output.`
      case 'needs-approval': {
        const held = this.pendingApprovalsForRun?.(runId) ?? 0
        const note =
          held > 0
            ? `Holding ${held} action(s) for your approval.`
            : 'Holding action(s) for your approval.'
        return finalText != null ? `${finalText}\n\n${note}` : `"${schedule.name}": ${note}`
      }
      case 'failed-to-run':
        return `"${schedule.name}" failed to run: ${errorMessage ?? 'unknown error'}`
      case 'ran-empty':
        return finalText ?? `"${schedule.name}" ran — nothing to report.`
      default:
        return finalText ?? `"${schedule.name}": ${runStatus}`
    }
  }

  private previousRunActive(schedule: ScheduleDto): boolean {
    if (schedule.lastRunId == null) return false
    const prev = this.store.getRun(schedule.lastRunId)
    if (prev?.threadId == null) return false
    return this.isRunning(prev.threadId)
  }

}
