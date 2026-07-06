/**
 * Types + Zod schemas for the per-profile scheduling vertical
 * ("Ownware Calendar"). Enums are validated at the boundary and
 * re-parsed on DB read so a corrupt row surfaces loudly instead of
 * silently mis-routing (same discipline as `tasks`/`memories`).
 *
 * A schedule runs ONE profile on a cadence as a normal single-agent
 * run — it is NOT the team kernel. All instants are epoch milliseconds.
 */

import { z } from 'zod'
import type { SafetyLevel } from './safety.js'

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const CadenceKindSchema = z.enum([
  'once',
  'interval',
  'daily',
  'weekly',
  'weekdays',
  'cron',
])
export type CadenceKind = z.infer<typeof CadenceKindSchema>

/** How a run missed while Ownware was closed is handled on reopen. */
export const CatchUpPolicySchema = z.enum([
  'catch-up', // run it once when reopened (default)
  'skip', // don't run late; wait for the next scheduled slot
  'window', // catch up only if missed by < catch_up_window_ms
])
export type CatchUpPolicy = z.infer<typeof CatchUpPolicySchema>

export const OverlapPolicySchema = z.enum(['skip-if-running', 'allow'])
export type OverlapPolicy = z.infer<typeof OverlapPolicySchema>

/** When a scheduled run notifies the user (the create dialog's "Tell me"). */
export const DeliveryModeSchema = z.enum([
  'on-activity', // drafted / needs-approval / failed (default); quiet on empty days
  'every-run', // tell me each time, even with nothing new
  'silent', // never notify; just log
])
export type DeliveryMode = z.infer<typeof DeliveryModeSchema>
export const DEFAULT_DELIVERY_MODE: DeliveryMode = 'on-activity'

/** Where a scheduled run's result is pushed (Slice 8 outbound delivery).
 *  The kinds mirror shuttle's `ChannelKind` — validated here so a bad value
 *  can't reach the DB; the sink (an in-process ChannelRunner) enforces that
 *  a channel of this kind is actually connected at delivery time. */
export const DeliverChannelSchema = z.enum(['slack', 'telegram', 'discord', 'whatsapp', 'sms'])
export type DeliverChannel = z.infer<typeof DeliverChannelSchema>

export const ScheduleDeliverToSchema = z
  .object({
    channel: DeliverChannelSchema,
    /** Platform-native destination: Slack channel/DM id, Telegram chat id, phone number, … */
    target: z.string().min(1),
  })
  .strict()
export type ScheduleDeliverTo = z.infer<typeof ScheduleDeliverToSchema>

export const ScheduleStateSchema = z.enum([
  'scheduled',
  'paused',
  'completed', // a one-off that has fired
  'error',
])
export type ScheduleState = z.infer<typeof ScheduleStateSchema>

/** Honest run outcomes — never collapse a failure into a fake "fine". */
export const RunStatusSchema = z.enum([
  'running', // dispatched, in-flight (not yet terminal)
  'succeeded',
  'ran-empty', // ran fine, nothing to report (a first-class success)
  'needs-approval', // finished, but holding ≥1 draft for the user to approve (8d)
  'failed-to-run',
  'failed-to-deliver',
  'skipped',
])
export type RunStatus = z.infer<typeof RunStatusSchema>

export const DeliveryStatusSchema = z.enum([
  'delivered',
  'not-delivered',
  'unknown',
  'not-requested',
])
export type DeliveryStatus = z.infer<typeof DeliveryStatusSchema>

/** Pre-authorized tool envelope for unattended runs (wired in a later slice). */
export interface ToolEnvelope {
  readonly autoRun?: readonly string[]
  readonly autoDeny?: readonly string[]
  readonly notifyAndPause?: readonly string[]
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

export interface ScheduleDto {
  readonly id: string
  readonly profileId: string
  readonly workspaceId: string | null
  readonly name: string
  readonly prompt: string
  readonly model: string | null
  readonly cadenceKind: CadenceKind
  readonly cadenceExpr: string
  readonly cadenceDisplay: string
  readonly timezone: string
  readonly catchUpPolicy: CatchUpPolicy
  readonly catchUpWindowMs: number | null
  readonly overlapPolicy: OverlapPolicy
  readonly skipWeekends: boolean
  readonly skipHolidays: boolean
  readonly toolEnvelope: ToolEnvelope | null
  /** Unattended tool boundary (Slice 8b). Defaults to 'draft-approval'. */
  readonly safetyLevel: SafetyLevel
  /** When to notify (Slice 8e). Defaults to 'on-activity'. */
  readonly deliveryMode: DeliveryMode
  /** Suppress notifications on a nothing-to-report run (Slice 8e). Default true. */
  readonly quietOnEmpty: boolean
  /** Outbound destination (Slice 8). NULL = no channel push (in-app only). */
  readonly deliver: ScheduleDeliverTo | null
  readonly enabled: boolean
  readonly state: ScheduleState
  /** Durable scheduling cursor (epoch ms). NULL = nothing scheduled. */
  readonly nextRunAt: number | null
  readonly lastRunAt: number | null
  readonly lastRunId: string | null
  readonly createdAt: number
  readonly updatedAt: number
}

export interface CreateScheduleInput {
  readonly profileId: string
  readonly name: string
  readonly prompt: string
  readonly cadenceKind: CadenceKind
  readonly cadenceExpr: string
  readonly cadenceDisplay: string
  readonly timezone: string
  readonly workspaceId?: string | null
  readonly model?: string | null
  readonly catchUpPolicy?: CatchUpPolicy
  readonly catchUpWindowMs?: number | null
  readonly overlapPolicy?: OverlapPolicy
  readonly skipWeekends?: boolean
  readonly skipHolidays?: boolean
  readonly toolEnvelope?: ToolEnvelope | null
  /** Unattended tool boundary (Slice 8b). Omitted → 'draft-approval' (safe). */
  readonly safetyLevel?: SafetyLevel
  /** When to notify (Slice 8e). Omitted → 'on-activity'. */
  readonly deliveryMode?: DeliveryMode
  /** Suppress empty-run notifications (Slice 8e). Omitted → true. */
  readonly quietOnEmpty?: boolean
  /** Outbound destination (Slice 8). Omitted/null = no channel push. */
  readonly deliver?: ScheduleDeliverTo | null
  readonly enabled?: boolean
  /** Caller-supplied first fire time. Cadence→next_run math lands in a later slice. */
  readonly nextRunAt?: number | null
}

export interface UpdateSchedulePatch {
  readonly name?: string
  readonly prompt?: string
  readonly model?: string | null
  readonly cadenceKind?: CadenceKind
  readonly cadenceExpr?: string
  readonly cadenceDisplay?: string
  readonly timezone?: string
  readonly catchUpPolicy?: CatchUpPolicy
  readonly catchUpWindowMs?: number | null
  readonly overlapPolicy?: OverlapPolicy
  readonly skipWeekends?: boolean
  readonly skipHolidays?: boolean
  readonly toolEnvelope?: ToolEnvelope | null
  /** Unattended tool boundary (Slice 8b). */
  readonly safetyLevel?: SafetyLevel
  /** When to notify (Slice 8e). */
  readonly deliveryMode?: DeliveryMode
  readonly quietOnEmpty?: boolean
  /** Outbound destination (Slice 8). `null` clears it. */
  readonly deliver?: ScheduleDeliverTo | null
  readonly enabled?: boolean
  readonly state?: ScheduleState
}

/** The at-most-once cursor write (engine-only; advance BEFORE firing). */
export interface AdvanceScheduleInput {
  readonly nextRunAt: number | null
  readonly lastRunAt?: number | null
  readonly lastRunId?: string | null
  readonly state?: ScheduleState
}

// ---------------------------------------------------------------------------
// Schedule run (history ledger)
// ---------------------------------------------------------------------------

export interface ScheduleRunDto {
  readonly id: string
  readonly scheduleId: string
  readonly threadId: string | null
  readonly scheduledFor: number
  readonly startedAt: number | null
  readonly finishedAt: number | null
  readonly runStatus: RunStatus
  readonly skipReason: string | null
  readonly wasCatchUp: boolean
  readonly errorCategory: string | null
  readonly errorMessage: string | null
  readonly deliveryStatus: DeliveryStatus
  readonly idempotencyKey: string | null
  readonly createdAt: number
}

/** A run enriched with its schedule's display fields — for a cross-schedule
 *  "recent runs" / "live now" agenda that can render without N extra lookups. */
export interface RecentRunDto extends ScheduleRunDto {
  readonly scheduleName: string
  readonly profileId: string
}

export interface RecordRunInput {
  readonly scheduleId: string
  readonly scheduledFor: number
  readonly runStatus: RunStatus
  readonly threadId?: string | null
  readonly startedAt?: number | null
  readonly finishedAt?: number | null
  readonly skipReason?: string | null
  readonly wasCatchUp?: boolean
  readonly errorCategory?: string | null
  readonly errorMessage?: string | null
  readonly deliveryStatus?: DeliveryStatus
  readonly idempotencyKey?: string | null
}

export interface UpdateRunPatch {
  readonly threadId?: string | null
  readonly startedAt?: number | null
  readonly finishedAt?: number | null
  readonly runStatus?: RunStatus
  readonly skipReason?: string | null
  readonly errorCategory?: string | null
  readonly errorMessage?: string | null
  readonly deliveryStatus?: DeliveryStatus
}
