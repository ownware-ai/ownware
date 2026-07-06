/**
 * BoardEventBus — process-wide fan-out for board mutations.
 *
 * Shape + discipline follows `tasks/event-bus.ts` (which in turn follows
 * `connector/status-bus.ts`) so every event stream in the gateway uses
 * the same primitives. Single-process scope; a multi-process deployment
 * would swap this for Redis/NATS, out of scope for v1.
 *
 * A board is the top rung of the work ladder (todo → plan → BOARD): a
 * goal + approach + ordered SLICES the agent works one-by-one, plus
 * FINDINGS logged mid-build.
 */

import { EventEmitter } from 'node:events'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Status enums — validated in TS before any DB write (the enforce-at-the-
// app-layer pattern shared with tasks.status / messages.role).
// ---------------------------------------------------------------------------

/** Board lifecycle (see mock 10 — the switcher + state gallery). */
export const BoardStatusSchema = z.enum([
  'draft', // forming / drafted but not yet approved
  'awaiting', // draft ready, waiting on the user's approval
  'running', // approved, executing slice-by-slice
  'paused', // stopped mid-way; resumable, never expires
  'done', // every slice verified
  'archived', // discarded by the user
])
export type BoardStatusWire = z.infer<typeof BoardStatusSchema>

/** Per-slice execution status. */
export const SliceStatusSchema = z.enum([
  'queued',
  'running',
  'done',
  'failed',
  'skipped',
])
export type SliceStatusWire = z.infer<typeof SliceStatusSchema>

/** A finding is a bug/note logged mid-build. */
export const FindingStatusSchema = z.enum(['open', 'deferred', 'resolved'])
export type FindingStatusWire = z.infer<typeof FindingStatusSchema>

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export const BoardSliceDtoSchema = z.object({
  id: z.string().min(1),
  boardId: z.string().min(1),
  title: z.string().min(1),
  /** Short one-line subtitle shown under the title. */
  summary: z.string(),
  /** The slice's own mini-plan / approach (markdown-ish freeform). */
  plan: z.string(),
  /** How this slice proves itself — the per-product evidence verb/result. */
  evidence: z.string(),
  status: SliceStatusSchema,
  order: z.number().int().nonnegative(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
})
export type BoardSliceDto = z.infer<typeof BoardSliceDtoSchema>

export const BoardFindingDtoSchema = z.object({
  id: z.string().min(1),
  boardId: z.string().min(1),
  /** The slice this was found in, when known. Soft link (nulls on re-draft). */
  sliceId: z.string().min(1).nullable(),
  title: z.string().min(1),
  detail: z.string(),
  status: FindingStatusSchema,
  order: z.number().int().nonnegative(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
})
export type BoardFindingDto = z.infer<typeof BoardFindingDtoSchema>

export const BoardDtoSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  /** Chat that drafted this board, when known (nulls if that thread dies). */
  originThreadId: z.string().min(1).nullable(),
  slug: z.string().min(1),
  title: z.string().min(1),
  goal: z.string(),
  approach: z.string(),
  status: BoardStatusSchema,
  slices: z.array(BoardSliceDtoSchema),
  findings: z.array(BoardFindingDtoSchema),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
})
export type BoardDto = z.infer<typeof BoardDtoSchema>

/** Lightweight row for the Board switcher list (no slices/findings bodies). */
export const BoardSummaryDtoSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  slug: z.string().min(1),
  title: z.string().min(1),
  status: BoardStatusSchema,
  sliceCount: z.number().int().nonnegative(),
  doneCount: z.number().int().nonnegative(),
  updatedAt: z.string().min(1),
})
export type BoardSummaryDto = z.infer<typeof BoardSummaryDtoSchema>

// ---------------------------------------------------------------------------
// Event
// ---------------------------------------------------------------------------

export const BoardUpdatedEventSchema = z.object({
  type: z.literal('board.updated'),
  workspaceId: z.string().min(1),
  boardId: z.string().min(1),
  /** Full board snapshot — subscribers (SSE) decide what to forward. */
  board: BoardDtoSchema,
  at: z.string().min(1),
})
export type BoardUpdatedEvent = z.infer<typeof BoardUpdatedEventSchema>

// ---------------------------------------------------------------------------
// Bus
// ---------------------------------------------------------------------------

export type BoardEventListener = (event: BoardUpdatedEvent) => void
export type Unsubscribe = () => void

const EVENT_NAME = 'board.updated'

export class BoardEventBus {
  private readonly emitter = new EventEmitter()

  constructor() {
    this.emitter.setMaxListeners(200)
  }

  emit(event: BoardUpdatedEvent): void {
    // Validate at the boundary so an upstream mistake surfaces here
    // rather than in every subscriber.
    const validated = BoardUpdatedEventSchema.parse(event)
    this.emitter.emit(EVENT_NAME, validated)
  }

  subscribe(listener: BoardEventListener): Unsubscribe {
    this.emitter.on(EVENT_NAME, listener)
    let unsubscribed = false
    return () => {
      if (unsubscribed) return
      unsubscribed = true
      this.emitter.off(EVENT_NAME, listener)
    }
  }
}
