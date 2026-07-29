import type { ContentBlock, LoomEvent, Session } from '@ownware/loom'
import type { RuntimeSelection } from './selection.js'

export type RuntimePhase =
  | 'idle'
  | 'running'
  | 'waiting_permission'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'closed'

export type RuntimeOutcome =
  | 'not_started'
  | 'pending'
  | 'succeeded'
  | 'cancelled'
  | 'failed'
  | 'indeterminate'

/**
 * Monotonic evidence about what may already have escaped the runtime.
 *
 * A tool result does not prove whether the tool changed external state, so
 * the Ownware adapter advances only to `effect_possible`. A future tool
 * boundary may emit `effect_confirmed` when it observes the durable effect.
 */
export type RuntimeConsequence =
  | 'none_observed'
  | 'output_observed'
  | 'effect_possible'
  | 'effect_confirmed'

export interface RuntimeStatus {
  readonly phase: RuntimePhase
  readonly outcome: RuntimeOutcome
  readonly consequence: RuntimeConsequence
  readonly lastSequence: number
}

export interface RuntimeStartRequest {
  readonly prompt: string | ContentBlock[]
}

export interface RuntimePermissionDecision {
  readonly requestId: string
  readonly decision: 'approve' | 'deny'
}

export type RuntimePermissionResult =
  | { readonly status: 'delivered' }
  | { readonly status: 'stale' }
  | { readonly status: 'unsupported' }

export type RuntimeCancelReason = 'user' | 'timeout' | 'system'
export type RuntimeCancelResult =
  | { readonly status: 'requested' }
  | { readonly status: 'already_requested' }

export type RuntimeCloseResult =
  | { readonly status: 'closed' }
  | { readonly status: 'timed_out' }
  | { readonly status: 'failed' }

export type RuntimeCompletion =
  | {
      readonly outcome: 'succeeded'
      /** Observable authority that made success knowable to the driver. */
      readonly authority: string
    }
  | {
      readonly outcome: 'cancelled'
      readonly authority: string
      readonly reason: RuntimeCancelReason
    }
  | {
      readonly outcome: 'failed'
      readonly authority: string
      /** Stable, content-free driver classification. */
      readonly code: string
    }
  | {
      readonly outcome: 'indeterminate'
      readonly authority: string
    }

export type RuntimeDriverEvent =
  | {
      readonly kind: 'canonical'
      readonly sourceSequence: number
      readonly event: LoomEvent
      readonly consequence?: RuntimeConsequence
    }
  | {
      readonly kind: 'unknown'
      readonly sourceSequence: number
      /** Stable source method/type only. Raw payload is deliberately excluded. */
      readonly sourceType: string
      readonly observedAt: number
    }

export interface RuntimeEventEnvelope {
  readonly sequence: number
  readonly event: LoomEvent
  readonly consequence: RuntimeConsequence
}

/**
 * The provider/process-facing side of the kernel runtime boundary.
 *
 * Drivers translate their native protocol to canonical Ownware events. They
 * must return a provenance-bearing completion instead of letting an early
 * process exit look successful. Test doubles belong under `tests/`, never in
 * this production module.
 */
export interface RuntimeDriver {
  readonly selection: RuntimeSelection
  start(
    request: RuntimeStartRequest,
  ): AsyncGenerator<RuntimeDriverEvent, RuntimeCompletion>
  answerPermission(
    decision: RuntimePermissionDecision,
  ): Promise<RuntimePermissionResult>
  cancel(reason: RuntimeCancelReason): Promise<void>
  close(): Promise<void>
}

export class RuntimeContractError extends Error {
  public override readonly name = 'RuntimeContractError'

  constructor(
    readonly code:
      | 'runtime_unknown_event'
      | 'runtime_event_order'
      | 'runtime_late_event'
      | 'runtime_outcome_indeterminate'
      | 'runtime_permission_unresolved'
      | 'runtime_driver_completion_missing',
    message: string,
    readonly sourceSequence?: number,
    readonly sourceType?: string,
  ) {
    super(message)
  }
}

export class RuntimeExecutionError extends Error {
  public override readonly name = 'RuntimeExecutionError'
  public readonly code = 'runtime_reported_failure'

  constructor(readonly runtimeCode: string) {
    super(`Runtime reported failure "${runtimeCode}".`)
  }
}

export interface ExecutionRuntime {
  readonly selection: RuntimeSelection
  start(
    request: RuntimeStartRequest,
  ): AsyncGenerator<RuntimeEventEnvelope, RuntimeCompletion>
  answerPermission(
    decision: RuntimePermissionDecision,
  ): Promise<RuntimePermissionResult>
  hasPendingPermission(requestId: string): boolean
  cancel(reason: RuntimeCancelReason): Promise<RuntimeCancelResult>
  status(): RuntimeStatus
  close(timeoutMs?: number): Promise<RuntimeCloseResult>
}

const CONSEQUENCE_RANK: Readonly<Record<RuntimeConsequence, number>> = {
  none_observed: 0,
  output_observed: 1,
  effect_possible: 2,
  effect_confirmed: 3,
}

function greaterConsequence(
  current: RuntimeConsequence,
  observed: RuntimeConsequence,
): RuntimeConsequence {
  return CONSEQUENCE_RANK[observed] > CONSEQUENCE_RANK[current]
    ? observed
    : current
}

function inferConsequence(event: LoomEvent): RuntimeConsequence {
  if (
    event.type === 'text.delta' ||
    event.type === 'text.complete' ||
    event.type === 'thinking.delta' ||
    event.type === 'thinking.complete'
  ) {
    return 'output_observed'
  }
  if (event.type === 'tool.call.end') return 'effect_possible'
  return 'none_observed'
}

function isRuntimeCompletion(value: unknown): value is RuntimeCompletion {
  if (typeof value !== 'object' || value === null) return false
  const outcome = (value as { outcome?: unknown }).outcome
  const authority = (value as { authority?: unknown }).authority
  const validBase = (
    (
      outcome === 'succeeded'
      || outcome === 'cancelled'
      || outcome === 'failed'
      || outcome === 'indeterminate'
    ) &&
    typeof authority === 'string' &&
    authority.length > 0
  )
  return validBase && (
    outcome !== 'failed' ||
    typeof (value as { code?: unknown }).code === 'string'
  )
}

function safeRuntimeLabel(value: string): string {
  return /^[A-Za-z0-9_.:/-]{1,128}$/.test(value)
    ? value
    : 'unrecognized'
}

/**
 * Shared lifecycle guard used by both the built-in Ownware driver and future
 * external drivers. It is deliberately provider-neutral.
 */
export class ManagedExecutionRuntime implements ExecutionRuntime {
  readonly selection: RuntimeSelection
  private snapshot: RuntimeStatus = {
    phase: 'idle',
    outcome: 'not_started',
    consequence: 'none_observed',
    lastSequence: 0,
  }
  private cancelRequested = false
  private closePromise: Promise<RuntimeCloseResult> | undefined
  private readonly pendingPermissions = new Set<string>()

  constructor(private readonly driver: RuntimeDriver) {
    this.selection = driver.selection
  }

  status(): RuntimeStatus {
    return { ...this.snapshot }
  }

  async *start(
    request: RuntimeStartRequest,
  ): AsyncGenerator<RuntimeEventEnvelope, RuntimeCompletion> {
    if (this.snapshot.phase !== 'idle') {
      throw new Error(`Runtime cannot start from phase "${this.snapshot.phase}"`)
    }
    this.snapshot = {
      ...this.snapshot,
      phase: 'running',
      outcome: 'pending',
    }

    const source = this.driver.start(request)
    let terminalObserved = false

    try {
      let result = await source.next()
      while (!result.done) {
        const observed = result.value
        if (observed.sourceSequence <= this.snapshot.lastSequence) {
          throw this.contractFailure(
            'runtime_event_order',
            `Runtime event position ${observed.sourceSequence} did not advance past ` +
              `${this.snapshot.lastSequence}.`,
            observed.sourceSequence,
          )
        }
        if (terminalObserved) {
          throw this.contractFailure(
            'runtime_late_event',
            `Runtime emitted event position ${observed.sourceSequence} after its terminal event.`,
            observed.sourceSequence,
          )
        }

        this.snapshot = {
          ...this.snapshot,
          lastSequence: observed.sourceSequence,
        }

        if (observed.kind === 'unknown') {
          const sourceType = safeRuntimeLabel(observed.sourceType)
          throw this.contractFailure(
            'runtime_unknown_event',
            `Runtime emitted unsupported event type "${sourceType}".`,
            observed.sourceSequence,
            sourceType,
          )
        }

        const consequence = observed.consequence ?? inferConsequence(observed.event)
        if (observed.event.type === 'permission.request') {
          this.pendingPermissions.add(observed.event.requestId)
        } else if (observed.event.type === 'permission.response') {
          this.pendingPermissions.delete(observed.event.requestId)
        }
        this.snapshot = {
          ...this.snapshot,
          phase: observed.event.type === 'permission.request'
            ? 'waiting_permission'
            : observed.event.type === 'permission.response'
              ? 'running'
              : this.snapshot.phase,
          consequence: greaterConsequence(this.snapshot.consequence, consequence),
        }
        terminalObserved = observed.event.type === 'session.end'

        yield {
          sequence: observed.sourceSequence,
          event: observed.event,
          consequence,
        }
        result = await source.next()
      }

      if (!isRuntimeCompletion(result.value)) {
        throw this.contractFailure(
          'runtime_driver_completion_missing',
          'Runtime driver ended without an authoritative completion result.',
        )
      }

      if (result.value.outcome === 'indeterminate') {
        throw this.contractFailure(
          'runtime_outcome_indeterminate',
          'Runtime ended without an authoritative outcome.',
        )
      }

      if (result.value.outcome === 'cancelled') {
        this.snapshot = {
          ...this.snapshot,
          phase: 'completed',
          outcome: 'cancelled',
        }
        return result.value
      }

      if (
        result.value.outcome === 'succeeded' &&
        this.pendingPermissions.size > 0
      ) {
        throw this.contractFailure(
          'runtime_permission_unresolved',
          'Runtime claimed success while a permission request remained unresolved.',
        )
      }

      if (result.value.outcome === 'failed') {
        this.snapshot = {
          ...this.snapshot,
          phase: 'failed',
          outcome: 'failed',
        }
        throw new RuntimeExecutionError(safeRuntimeLabel(result.value.code))
      }

      this.snapshot = {
        ...this.snapshot,
        phase: 'completed',
        outcome: 'succeeded',
      }
      return result.value
    } catch (error) {
      if (
        !(error instanceof RuntimeContractError) &&
        !(error instanceof RuntimeExecutionError)
      ) {
        this.snapshot = {
          ...this.snapshot,
          phase: 'failed',
          outcome: this.snapshot.consequence === 'none_observed'
            ? 'failed'
            : 'indeterminate',
        }
      }
      throw error
    }
  }

  async answerPermission(
    decision: RuntimePermissionDecision,
  ): Promise<RuntimePermissionResult> {
    const result = await this.driver.answerPermission(decision)
    if (result.status === 'delivered' && this.snapshot.phase === 'waiting_permission') {
      this.pendingPermissions.delete(decision.requestId)
      this.snapshot = { ...this.snapshot, phase: 'running' }
    }
    return result
  }

  hasPendingPermission(requestId: string): boolean {
    return this.pendingPermissions.has(requestId)
  }

  async cancel(reason: RuntimeCancelReason): Promise<RuntimeCancelResult> {
    const status: RuntimeCancelResult = this.cancelRequested
      ? { status: 'already_requested' }
      : { status: 'requested' }
    this.cancelRequested = true
    if (
      this.snapshot.phase !== 'completed' &&
      this.snapshot.phase !== 'failed' &&
      this.snapshot.phase !== 'closed'
    ) {
      this.snapshot = {
        ...this.snapshot,
        phase: 'cancelling',
        outcome: 'pending',
      }
    }
    // Repeat the signal intentionally. Cancellation requests are idempotent at
    // the state boundary, while a repeated transport signal helps wake a
    // driver that missed an earlier interrupt.
    await this.driver.cancel(reason)
    return status
  }

  close(timeoutMs = 2_000): Promise<RuntimeCloseResult> {
    if (this.closePromise) return this.closePromise

    this.closePromise = this.closeOnce(timeoutMs)
    return this.closePromise
  }

  private async closeOnce(timeoutMs: number): Promise<RuntimeCloseResult> {
    let timeout: ReturnType<typeof setTimeout> | undefined
    const boundedMs = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : 2_000
    try {
      const result = await Promise.race([
        this.driver.close().then(() => 'closed' as const),
        new Promise<'timed_out'>((resolve) => {
          timeout = setTimeout(() => resolve('timed_out'), boundedMs)
          timeout.unref?.()
        }),
      ])
      if (result === 'timed_out') {
        this.snapshot = {
          ...this.snapshot,
          phase: 'failed',
          outcome: 'indeterminate',
          consequence: greaterConsequence(
            this.snapshot.consequence,
            'effect_possible',
          ),
        }
        return { status: 'timed_out' }
      }
      this.snapshot = { ...this.snapshot, phase: 'closed' }
      return { status: 'closed' }
    } catch {
      this.snapshot = {
        ...this.snapshot,
        phase: 'failed',
        outcome: 'indeterminate',
        consequence: greaterConsequence(
          this.snapshot.consequence,
          'effect_possible',
        ),
      }
      return { status: 'failed' }
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
    }
  }

  private contractFailure(
    code: RuntimeContractError['code'],
    message: string,
    sourceSequence?: number,
    sourceType?: string,
  ): RuntimeContractError {
    this.snapshot = {
      ...this.snapshot,
      phase: 'failed',
      outcome: 'indeterminate',
      consequence: greaterConsequence(
        this.snapshot.consequence,
        'effect_possible',
      ),
    }
    return new RuntimeContractError(
      code,
      message,
      sourceSequence,
      sourceType,
    )
  }
}

export interface OwnwareRuntimeDriverOptions {
  readonly session: Session
  readonly selection: RuntimeSelection
  readonly answerPermission?: (
    decision: RuntimePermissionDecision,
  ) => boolean | Promise<boolean>
  readonly close?: () => void | Promise<void>
}

/**
 * Adapt the existing Ownware session without changing its prompt, event, or
 * cancellation behavior. Clean generator return is the authority for this
 * in-process driver; external drivers must name their own protocol authority.
 */
export function createOwnwareRuntimeDriver(
  options: OwnwareRuntimeDriverOptions,
): RuntimeDriver {
  return {
    selection: options.selection,
    async *start(request) {
      const source = options.session.submitMessage(request.prompt)
      let sequence = 0
      let result = await source.next()
      while (!result.done) {
        yield {
          kind: 'canonical',
          sourceSequence: ++sequence,
          event: result.value,
        }
        result = await source.next()
      }
      return {
        outcome: 'succeeded',
        authority: 'Ownware session generator returned normally',
      }
    },
    async answerPermission(decision) {
      if (!options.answerPermission) return { status: 'unsupported' }
      return await options.answerPermission(decision)
        ? { status: 'delivered' }
        : { status: 'stale' }
    },
    async cancel(reason) {
      options.session.abort(reason)
    },
    async close() {
      await options.close?.()
    },
  }
}
