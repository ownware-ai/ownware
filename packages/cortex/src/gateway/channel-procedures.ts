/**
 * Channel procedures (CC1) — the coded state machines behind "connect a
 * channel". A procedure is an ordered list of steps; the model only decides
 * WHEN to start one and narrates. Two step kinds:
 *
 *   - work: runs code (provider calls, vault writes, self-tests), streams
 *     work lines, appends receipts, and carries non-secret state forward.
 *   - gate: a CONSENT GATE. The job parks (`waiting_for_input`) until the
 *     person decides through the existing pause/resume mechanic — the
 *     engine never invents a second approval channel, it just holds the
 *     durable gate state that the run-side front-end re-presents. A
 *     decline leaves state unchanged and ends the procedure honestly
 *     (never a silent partial setup). A timeout never implies approval —
 *     an unanswered gate parks indefinitely until decided or cancelled.
 *
 * Checkpoint = index of the next step to run. Steps must be IDEMPOTENT to
 * re-run from their start (a crash mid-step re-executes that step), and
 * must finish within the claim lease unless they renew it.
 *
 * SECRETS: params/state/gate payloads never carry credential values —
 * tokens go provider → engine → vault; only ids/handles ride the job row.
 */

export interface ChannelGateSpec {
  /** Stable id within the procedure (re-presented after restarts). */
  readonly id: string
  /** The decision card title, e.g. `Connect 0400 555 210 to Rosa?`. */
  readonly title: string
  /** What WILL happen if approved (the ✓ lines). */
  readonly included: readonly string[]
  /** What will NOT happen / is out of scope (the — lines). */
  readonly excluded: readonly string[]
  /** Honest consequence of declining ("no WhatsApp yet; nothing else changes"). */
  readonly onDecline: string
}

export interface ChannelGateDecision {
  readonly gateId: string
  readonly action: 'approve' | 'deny'
  /** Who decided (safe identity, never a token). */
  readonly actor: string
  readonly decidedAt: number
}

export interface ChannelProcedureContext {
  readonly jobId: string
  readonly profileId: string
  readonly channelKind: string
  readonly channelId: string | null
  /** Enqueue parameters (non-secret, immutable). */
  readonly params: Readonly<Record<string, unknown>>
  /**
   * Non-secret state carried between steps; mutations persist atomically
   * with the step's checkpoint advance (a crashed step re-runs with the
   * state as of its start).
   */
  readonly state: Record<string, unknown>
  /** Stream a work line (`✓ Checked the number · 2s`). */
  workLine(title: string, detail?: string): void
  /** Append a permanent receipt (see ChannelJobStore.appendReceipt). */
  receipt(input: ProcedureReceiptInput): void
  /** True when a cancel was requested — long steps should stop early. */
  cancelRequested(): boolean
  /** Extend the claim lease before/inside a slow provider call. */
  renewLease(): boolean
}

export interface ProcedureReceiptInput {
  readonly kind: string
  readonly title: string
  readonly body: Readonly<Record<string, unknown>>
}

export type ChannelProcedureStep =
  | {
      readonly kind: 'work'
      readonly name: string
      run(ctx: ChannelProcedureContext): Promise<void>
    }
  | {
      readonly kind: 'gate'
      readonly name: string
      /** Build the decision card from the state gathered so far. */
      gate(ctx: ChannelProcedureContext): ChannelGateSpec
    }

export interface ChannelProcedure {
  /** e.g. `connect_whatsapp` — lowercase [a-z0-9_], max 64. */
  readonly operation: string
  readonly channelKind: string
  readonly steps: readonly ChannelProcedureStep[]
}

/**
 * A step throws this to signal a TRANSIENT failure — the job defers and a
 * later attempt re-runs the step (until attempts are exhausted).
 */
export class TransientStepError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number = 5_000,
  ) {
    super(message)
    this.name = 'TransientStepError'
  }
}

/**
 * A step throws this to signal a PERMANENT failure — the job finishes as
 * failed with the given outcome code (lowercase [a-z0-9_]).
 */
export class ProcedureStepError extends Error {
  constructor(
    readonly outcomeCode: string,
    message?: string,
  ) {
    super(message ?? outcomeCode)
    this.name = 'ProcedureStepError'
  }
}

const OPERATION_SHAPE = /^[a-z0-9_]{1,64}$/

export class ChannelProcedureRegistry {
  private readonly procedures = new Map<string, ChannelProcedure>()

  register(procedure: ChannelProcedure): void {
    if (!OPERATION_SHAPE.test(procedure.operation)) {
      throw new TypeError(`Channel procedure operation is invalid: ${procedure.operation}`)
    }
    if (procedure.steps.length < 1 || procedure.steps.length > 64) {
      throw new RangeError(`Channel procedure needs 1–64 steps: ${procedure.operation}`)
    }
    const gateIds = new Set<string>()
    for (const step of procedure.steps) {
      if (step.kind !== 'gate') continue
      // Gate ids must be stable AND unique — a decision must never be
      // attributable to the wrong gate.
      const id = `${procedure.operation}:${step.name}`
      if (gateIds.has(id)) throw new TypeError(`Duplicate gate step name: ${id}`)
      gateIds.add(id)
    }
    if (this.procedures.has(procedure.operation)) {
      throw new Error(`Channel procedure already registered: ${procedure.operation}`)
    }
    this.procedures.set(procedure.operation, procedure)
  }

  get(operation: string): ChannelProcedure | null {
    return this.procedures.get(operation) ?? null
  }

  get size(): number {
    return this.procedures.size
  }
}

/** The stable id a gate step is addressed by (spec.id must use this). */
export function gateStepId(operation: string, stepName: string): string {
  return `${operation}:${stepName}`
}
