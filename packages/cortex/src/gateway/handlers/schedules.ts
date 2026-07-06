/**
 * Schedules HTTP handlers — CRUD + pause/resume + run-now + run history
 * for the per-profile scheduling vertical.
 *
 *   POST   /api/v1/schedules                 create
 *   GET    /api/v1/schedules                 list (?profileId=, ?enabledOnly=1)
 *   GET    /api/v1/schedules/:id             get one
 *   PATCH  /api/v1/schedules/:id             edit (also toggles enabled)
 *   DELETE /api/v1/schedules/:id             delete
 *   POST   /api/v1/schedules/:id/pause       enabled=false
 *   POST   /api/v1/schedules/:id/resume      enabled=true
 *   POST   /api/v1/schedules/:id/run-now     fire immediately (manual)
 *   GET    /api/v1/schedules/:id/runs        run history (?limit=)
 *
 * SSE invalidation is intentionally NOT here yet — it lands with the
 * calendar UI (Slice 7) so the channel + its consumer ship together.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { sendError, sendJSON, readJSON } from '../router.js'
import type { SqliteScheduleStore } from '../../schedules/store.js'
import type { ScheduleDto, ScheduleRunDto } from '../../schedules/types.js'
import {
  CadenceKindSchema,
  CatchUpPolicySchema,
  OverlapPolicySchema,
  DeliveryModeSchema,
  ScheduleDeliverToSchema,
} from '../../schedules/types.js'
import { computeNextRun, occurrencesInRange, nextOccurrences } from '../../schedules/cadence.js'
import { SafetyLevelSchema } from '../../schedules/safety.js'

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

const CreateScheduleRequestSchema = z
  .object({
    profileId: z.string().min(1),
    name: z.string().min(1),
    prompt: z.string().min(1),
    cadenceKind: CadenceKindSchema,
    cadenceExpr: z.string().min(1),
    cadenceDisplay: z.string().min(1),
    timezone: z.string().min(1),
    workspaceId: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    catchUpPolicy: CatchUpPolicySchema.optional(),
    catchUpWindowMs: z.number().int().positive().optional(),
    overlapPolicy: OverlapPolicySchema.optional(),
    skipWeekends: z.boolean().optional(),
    skipHolidays: z.boolean().optional(),
    safetyLevel: SafetyLevelSchema.optional(),
    deliveryMode: DeliveryModeSchema.optional(),
    quietOnEmpty: z.boolean().optional(),
    deliver: ScheduleDeliverToSchema.nullable().optional(),
    enabled: z.boolean().optional(),
    nextRunAt: z.number().int().nonnegative().nullable().optional(),
  })
  .strict()
  // A 'window' catch-up needs a window; otherwise it's ambiguous (the
  // engine treats a missing window as "always catch up").
  .refine((d) => d.catchUpPolicy !== 'window' || d.catchUpWindowMs != null, {
    message: "catchUpPolicy 'window' requires a positive catchUpWindowMs",
    path: ['catchUpWindowMs'],
  })

// Live preview of an UNSAVED cadence — the create dialog asks "when would
// this actually run?" before the schedule exists. Only the cadence-shaping
// fields are needed; the rest get neutral defaults.
const PreviewRequestSchema = z
  .object({
    cadenceKind: CadenceKindSchema,
    cadenceExpr: z.string().min(1),
    timezone: z.string().min(1),
    skipWeekends: z.boolean().optional(),
    skipHolidays: z.boolean().optional(),
    count: z.number().int().positive().max(50).optional(),
  })
  .strict()

/** A complete ScheduleDto from preview input, so the cadence math (which
 *  reads a ScheduleDto) runs unchanged. Unused fields get neutral values. */
function previewSchedule(input: {
  readonly cadenceKind: ScheduleDto['cadenceKind']
  readonly cadenceExpr: string
  readonly timezone: string
  readonly skipWeekends?: boolean
  readonly skipHolidays?: boolean
}): ScheduleDto {
  return {
    id: 'preview',
    profileId: '',
    workspaceId: null,
    name: 'preview',
    prompt: '',
    model: null,
    cadenceKind: input.cadenceKind,
    cadenceExpr: input.cadenceExpr,
    cadenceDisplay: '',
    timezone: input.timezone,
    catchUpPolicy: 'catch-up',
    catchUpWindowMs: null,
    overlapPolicy: 'skip-if-running',
    skipWeekends: input.skipWeekends ?? false,
    skipHolidays: input.skipHolidays ?? false,
    toolEnvelope: null,
    safetyLevel: 'draft-approval',
    deliveryMode: 'on-activity',
    quietOnEmpty: true,
    deliver: null,
    enabled: true,
    state: 'scheduled',
    nextRunAt: null,
    lastRunAt: null,
    lastRunId: null,
    createdAt: 0,
    updatedAt: 0,
  }
}

const UpdateScheduleRequestSchema = z
  .object({
    name: z.string().min(1).optional(),
    prompt: z.string().min(1).optional(),
    model: z.string().min(1).nullable().optional(),
    cadenceKind: CadenceKindSchema.optional(),
    cadenceExpr: z.string().min(1).optional(),
    cadenceDisplay: z.string().min(1).optional(),
    timezone: z.string().min(1).optional(),
    catchUpPolicy: CatchUpPolicySchema.optional(),
    catchUpWindowMs: z.number().int().positive().nullable().optional(),
    overlapPolicy: OverlapPolicySchema.optional(),
    skipWeekends: z.boolean().optional(),
    skipHolidays: z.boolean().optional(),
    safetyLevel: SafetyLevelSchema.optional(),
    deliveryMode: DeliveryModeSchema.optional(),
    quietOnEmpty: z.boolean().optional(),
    deliver: ScheduleDeliverToSchema.nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .strict()

export interface ScheduleHandlerDeps {
  readonly store: SqliteScheduleStore
  /** Fire a schedule immediately; null if it doesn't exist. */
  readonly runNow: (scheduleId: string) => Promise<ScheduleRunDto | null>
}

export function createScheduleHandlers(deps: ScheduleHandlerDeps) {
  const { store, runNow } = deps

  // POST /api/v1/schedules
  async function createSchedule(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await readJSON(req)
    const parsed = CreateScheduleRequestSchema.safeParse(raw)
    if (!parsed.success) {
      sendError(res, 400, `Invalid schedule: ${parsed.error.message}`)
      return
    }
    let schedule = store.create(parsed.data)
    // The server owns the cadence math: if the caller didn't pin a first fire
    // time, compute it from the cadence so the schedule is live immediately.
    if (parsed.data.nextRunAt == null && schedule.nextRunAt == null) {
      const next = computeNextRun(schedule, Date.now())
      if (next != null) schedule = store.advance(schedule.id, { nextRunAt: next }) ?? schedule
    }
    sendJSON(res, 201, { schedule })
  }

  // GET /api/v1/schedules?profileId=&enabledOnly=1
  async function listSchedules(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const profileId = url.searchParams.get('profileId') ?? undefined
    const enabledOnly = url.searchParams.get('enabledOnly') === '1'
    const schedules = store.list({
      ...(profileId != null ? { profileId } : {}),
      ...(enabledOnly ? { enabledOnly: true } : {}),
    })
    sendJSON(res, 200, { schedules })
  }

  // GET /api/v1/schedules/:id
  async function getSchedule(
    _req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const schedule = store.get(params['id'] ?? '')
    if (schedule == null) {
      sendError(res, 404, `Schedule "${params['id']}" not found`)
      return
    }
    sendJSON(res, 200, { schedule })
  }

  // PATCH /api/v1/schedules/:id
  async function updateSchedule(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const raw = await readJSON(req)
    const parsed = UpdateScheduleRequestSchema.safeParse(raw)
    if (!parsed.success) {
      sendError(res, 400, `Invalid update: ${parsed.error.message}`)
      return
    }
    const schedule = store.update(params['id'] ?? '', parsed.data)
    if (schedule == null) {
      sendError(res, 404, `Schedule "${params['id']}" not found`)
      return
    }
    sendJSON(res, 200, { schedule })
  }

  // DELETE /api/v1/schedules/:id
  async function deleteSchedule(
    _req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const ok = store.delete(params['id'] ?? '')
    if (!ok) {
      sendError(res, 404, `Schedule "${params['id']}" not found`)
      return
    }
    sendJSON(res, 200, { deleted: true })
  }

  function setEnabled(enabled: boolean) {
    return async (
      _req: IncomingMessage,
      res: ServerResponse,
      params: Record<string, string>,
    ): Promise<void> => {
      const schedule = store.setEnabled(params['id'] ?? '', enabled)
      if (schedule == null) {
        sendError(res, 404, `Schedule "${params['id']}" not found`)
        return
      }
      sendJSON(res, 200, { schedule })
    }
  }

  // POST /api/v1/schedules/:id/run-now
  async function runNowSchedule(
    _req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const run = await runNow(params['id'] ?? '')
    if (run == null) {
      sendError(res, 404, `Schedule "${params['id']}" not found`)
      return
    }
    // 202 — the run is dispatched in the background; watch its thread via SSE.
    sendJSON(res, 202, { run })
  }

  // GET /api/v1/schedules/:id/runs?limit=
  async function listScheduleRuns(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const id = params['id'] ?? ''
    if (store.get(id) == null) {
      sendError(res, 404, `Schedule "${id}" not found`)
      return
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    const limitRaw = Number(url.searchParams.get('limit'))
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 50
    sendJSON(res, 200, { runs: store.listRuns(id, limit) })
  }

  // GET /api/v1/schedules/occurrences?from=&to=&profileId=
  // Every scheduled run that falls in [from, to], flattened across all enabled
  // schedules — the data the calendar grid paints. Literal route; MUST be
  // registered before /schedules/:id or ":id" swallows "occurrences".
  async function listOccurrences(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const fromRaw = url.searchParams.get('from')
    const toRaw = url.searchParams.get('to')
    const from = Number(fromRaw)
    const to = Number(toRaw)
    // Guard the empty/missing case explicitly — Number(null)/Number('') is 0,
    // which would otherwise pass as a valid (but meaningless) window.
    if (
      fromRaw == null ||
      fromRaw === '' ||
      toRaw == null ||
      toRaw === '' ||
      !Number.isFinite(from) ||
      !Number.isFinite(to) ||
      to < from
    ) {
      sendError(res, 400, 'occurrences requires numeric epoch-ms `from` and `to` with to >= from')
      return
    }
    const profileId = url.searchParams.get('profileId') ?? undefined
    const schedules = store.list({
      enabledOnly: true,
      ...(profileId != null ? { profileId } : {}),
    })
    // Per-schedule cap keeps a 1-minute interval from flooding a month view;
    // the grid only needs enough to render dots + an overflow count.
    const PER_SCHEDULE_CAP = 200
    const occurrences: Array<{
      readonly scheduleId: string
      readonly profileId: string
      readonly name: string
      readonly at: number
    }> = []
    for (const s of schedules) {
      for (const at of occurrencesInRange(s, from, to, {}, PER_SCHEDULE_CAP)) {
        occurrences.push({ scheduleId: s.id, profileId: s.profileId, name: s.name, at })
      }
    }
    occurrences.sort((a, b) => a.at - b.at)
    sendJSON(res, 200, { occurrences })
  }

  // GET /api/v1/schedules/runs?limit=&status=running
  // Recent runs across ALL schedules (newest first), enriched with each run's
  // schedule name + profileId — the feed for a cross-schedule agenda / "live
  // now" strip. Literal route; MUST be registered before /schedules/:id.
  async function listRecentRuns(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const limitRaw = Number(url.searchParams.get('limit'))
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50
    const runningOnly = url.searchParams.get('status') === 'running'
    sendJSON(res, 200, { runs: store.listRecentRuns(limit, { runningOnly }) })
  }

  // POST /api/v1/schedules/preview — next N fire times for an unsaved cadence.
  async function previewSchedule_(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await readJSON(req)
    const parsed = PreviewRequestSchema.safeParse(raw)
    if (!parsed.success) {
      sendError(res, 400, `Invalid preview: ${parsed.error.message}`)
      return
    }
    const s = previewSchedule(parsed.data)
    const occurrences = nextOccurrences(s, parsed.data.count ?? 3, Date.now())
    sendJSON(res, 200, { occurrences })
  }

  return {
    createSchedule,
    listSchedules,
    listOccurrences,
    listRecentRuns,
    previewSchedule: previewSchedule_,
    getSchedule,
    updateSchedule,
    deleteSchedule,
    pauseSchedule: setEnabled(false),
    resumeSchedule: setEnabled(true),
    runNowSchedule,
    listScheduleRuns,
  }
}
