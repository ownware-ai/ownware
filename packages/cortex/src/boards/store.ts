/**
 * SqliteBoardStore — SQLite-backed board persistence + the read/write
 * helpers the HTTP layer and the `board_write` tool need.
 *
 * Mirrors `tasks/store.ts`:
 *   - `replaceStructure(input)` upserts the board row and atomically
 *     swaps its slice list in ONE transaction (failure-safe: a board
 *     row never has half a slice list). Findings are NOT touched here —
 *     they accumulate during execution via `addFinding`, so a re-draft
 *     keeps the bugs already logged (decision D6).
 *   - `updateSliceStatus` / `setBoardStatus` / `addFinding` /
 *     `updateFindingStatus` are TINY atomic updates — one row, one
 *     event. This is what keeps "fails after N tokens" from losing the
 *     board: the big generation happens once, ongoing changes are small.
 *   - `listForWorkspace` (summaries for the switcher) and `getById` /
 *     `getByWorkspaceSlug` (full board) are read-only, no event.
 *
 * Every mutation emits ONE `board.updated` event (full snapshot) after
 * the transaction commits, so subscribers never see a rolled-back state.
 */

import type Database from 'better-sqlite3'
import type {
  BoardDto,
  BoardEventBus,
  BoardFindingDto,
  BoardSliceDto,
  BoardSummaryDto,
  BoardStatusWire,
  FindingStatusWire,
  SliceStatusWire,
} from './event-bus.js'
import {
  BoardStatusSchema,
  FindingStatusSchema,
  SliceStatusSchema,
} from './event-bus.js'

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

interface BoardRow {
  readonly id: string
  readonly workspace_id: string
  readonly origin_thread_id: string | null
  readonly slug: string
  readonly title: string
  readonly goal: string
  readonly approach: string
  readonly status: string
  readonly created_at: string
  readonly updated_at: string
}

interface SliceRow {
  readonly id: string
  readonly board_id: string
  readonly title: string
  readonly summary: string
  readonly plan: string
  readonly evidence: string
  readonly status: string
  readonly list_order: number
  readonly created_at: string
  readonly updated_at: string
}

interface FindingRow {
  readonly id: string
  readonly board_id: string
  readonly slice_id: string | null
  readonly title: string
  readonly detail: string
  readonly status: string
  readonly list_order: number
  readonly created_at: string
  readonly updated_at: string
}

function sliceRowToDto(row: SliceRow): BoardSliceDto {
  return {
    id: row.id,
    boardId: row.board_id,
    title: row.title,
    summary: row.summary,
    plan: row.plan,
    evidence: row.evidence,
    status: SliceStatusSchema.parse(row.status),
    order: row.list_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function findingRowToDto(row: FindingRow): BoardFindingDto {
  return {
    id: row.id,
    boardId: row.board_id,
    sliceId: row.slice_id,
    title: row.title,
    detail: row.detail,
    status: FindingStatusSchema.parse(row.status),
    order: row.list_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
}

// ---------------------------------------------------------------------------
// Write inputs
// ---------------------------------------------------------------------------

export interface SliceInput {
  readonly title: string
  readonly summary?: string
  readonly plan?: string
  readonly evidence?: string
  readonly status?: SliceStatusWire
}

export interface BoardStructureInput {
  readonly workspaceId: string
  readonly slug: string
  readonly title: string
  readonly goal?: string
  readonly approach?: string
  readonly status?: BoardStatusWire
  readonly originThreadId?: string | null
  readonly slices: ReadonlyArray<SliceInput>
}

export interface FindingInput {
  readonly title: string
  readonly detail?: string
  readonly sliceId?: string | null
  readonly status?: FindingStatusWire
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class SqliteBoardStore {
  private readonly db: Database.Database
  private readonly bus: BoardEventBus

  constructor(db: Database.Database, bus: BoardEventBus) {
    this.db = db
    this.bus = bus
  }

  // ── reads ────────────────────────────────────────────────────────────

  /** Switcher rows for a workspace, newest-updated first. No event. */
  listForWorkspace(workspaceId: string): BoardSummaryDto[] {
    if (workspaceId.length === 0) return []
    const rows = this.db
      .prepare(
        `SELECT b.id, b.workspace_id, b.slug, b.title, b.status, b.updated_at,
                COUNT(s.id)                                            AS slice_count,
                COALESCE(SUM(CASE WHEN s.status = 'done' THEN 1 ELSE 0 END), 0) AS done_count
           FROM boards b
           LEFT JOIN board_slices s ON s.board_id = b.id
          WHERE b.workspace_id = ?
          GROUP BY b.id
          ORDER BY b.updated_at DESC`,
      )
      .all(workspaceId) as ReadonlyArray<{
      id: string
      workspace_id: string
      slug: string
      title: string
      status: string
      updated_at: string
      slice_count: number
      done_count: number
    }>
    return rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspace_id,
      slug: r.slug,
      title: r.title,
      status: BoardStatusSchema.parse(r.status),
      sliceCount: r.slice_count,
      doneCount: r.done_count,
      updatedAt: r.updated_at,
    }))
  }

  /** Full board (with slices + findings), or null. No event. */
  getById(boardId: string): BoardDto | null {
    if (boardId.length === 0) return null
    const row = this.db
      .prepare(`SELECT * FROM boards WHERE id = ?`)
      .get(boardId) as BoardRow | undefined
    return row ? this.hydrate(row) : null
  }

  /** Full board by its (workspace, slug) identity, or null. No event. */
  getByWorkspaceSlug(workspaceId: string, slug: string): BoardDto | null {
    if (workspaceId.length === 0 || slug.length === 0) return null
    const row = this.db
      .prepare(`SELECT * FROM boards WHERE workspace_id = ? AND slug = ?`)
      .get(workspaceId, slug) as BoardRow | undefined
    return row ? this.hydrate(row) : null
  }

  private hydrate(board: BoardRow): BoardDto {
    const slices = (
      this.db
        .prepare(
          `SELECT * FROM board_slices WHERE board_id = ? ORDER BY list_order ASC`,
        )
        .all(board.id) as SliceRow[]
    ).map(sliceRowToDto)
    const findings = (
      this.db
        .prepare(
          `SELECT * FROM board_findings WHERE board_id = ? ORDER BY list_order ASC`,
        )
        .all(board.id) as FindingRow[]
    ).map(findingRowToDto)
    return {
      id: board.id,
      workspaceId: board.workspace_id,
      originThreadId: board.origin_thread_id,
      slug: board.slug,
      title: board.title,
      goal: board.goal,
      approach: board.approach,
      status: BoardStatusSchema.parse(board.status),
      slices,
      findings,
      createdAt: board.created_at,
      updatedAt: board.updated_at,
    }
  }

  // ── structural write (idempotent on workspace+slug) ──────────────────

  /**
   * Upsert a board and replace its slice list in one transaction.
   * Findings are preserved (managed by `addFinding`). Returns the full
   * board and emits one `board.updated`.
   */
  replaceStructure(input: BoardStructureInput): BoardDto {
    const now = new Date().toISOString()
    const status = input.status != null ? BoardStatusSchema.parse(input.status) : undefined

    const txn = this.db.transaction((): string => {
      const existing = this.db
        .prepare(`SELECT id, created_at FROM boards WHERE workspace_id = ? AND slug = ?`)
        .get(input.workspaceId, input.slug) as
        | { id: string; created_at: string }
        | undefined

      const boardId = existing?.id ?? newId('board')

      if (existing == null) {
        this.db
          .prepare(
            `INSERT INTO boards (id, workspace_id, origin_thread_id, slug, title, goal, approach, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            boardId,
            input.workspaceId,
            input.originThreadId ?? null,
            input.slug,
            input.title,
            input.goal ?? '',
            input.approach ?? '',
            status ?? 'draft',
            now,
            now,
          )
      } else {
        // Update meta; keep status unless the caller explicitly set one
        // (status transitions normally go through setBoardStatus).
        this.db
          .prepare(
            `UPDATE boards
                SET title = ?, goal = ?, approach = ?,
                    origin_thread_id = COALESCE(?, origin_thread_id),
                    status = COALESCE(?, status),
                    updated_at = ?
              WHERE id = ?`,
          )
          .run(
            input.title,
            input.goal ?? '',
            input.approach ?? '',
            input.originThreadId ?? null,
            status ?? null,
            now,
            boardId,
          )
        this.db.prepare(`DELETE FROM board_slices WHERE board_id = ?`).run(boardId)
      }

      const insertSlice = this.db.prepare(
        `INSERT INTO board_slices (id, board_id, title, summary, plan, evidence, status, list_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      input.slices.forEach((s, i) => {
        insertSlice.run(
          newId('slice'),
          boardId,
          s.title,
          s.summary ?? '',
          s.plan ?? '',
          s.evidence ?? '',
          s.status != null ? SliceStatusSchema.parse(s.status) : 'queued',
          i,
          now,
          now,
        )
      })
      return boardId
    })

    const boardId = txn()
    return this.emitFresh(boardId)
  }

  // ── atomic updates ───────────────────────────────────────────────────

  /** Flip one slice's status. Returns the refreshed board, or null. */
  updateSliceStatus(
    boardId: string,
    sliceId: string,
    status: SliceStatusWire,
  ): BoardDto | null {
    const validated = SliceStatusSchema.parse(status)
    const now = new Date().toISOString()
    const res = this.db
      .prepare(
        `UPDATE board_slices SET status = ?, updated_at = ? WHERE id = ? AND board_id = ?`,
      )
      .run(validated, now, sliceId, boardId)
    if (res.changes === 0) return null
    this.touch(boardId, now)
    return this.emitFresh(boardId)
  }

  /** Move the board along its lifecycle. Returns the board, or null. */
  setBoardStatus(boardId: string, status: BoardStatusWire): BoardDto | null {
    const validated = BoardStatusSchema.parse(status)
    const now = new Date().toISOString()
    const res = this.db
      .prepare(`UPDATE boards SET status = ?, updated_at = ? WHERE id = ?`)
      .run(validated, now, boardId)
    if (res.changes === 0) return null
    return this.emitFresh(boardId)
  }

  /** Append a finding (bug/note). Returns the refreshed board, or null. */
  addFinding(boardId: string, input: FindingInput): BoardDto | null {
    const board = this.db
      .prepare(`SELECT id FROM boards WHERE id = ?`)
      .get(boardId) as { id: string } | undefined
    if (board == null) return null
    const now = new Date().toISOString()
    const nextOrder = (
      this.db
        .prepare(
          `SELECT COALESCE(MAX(list_order) + 1, 0) AS n FROM board_findings WHERE board_id = ?`,
        )
        .get(boardId) as { n: number }
    ).n
    this.db
      .prepare(
        `INSERT INTO board_findings (id, board_id, slice_id, title, detail, status, list_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId('find'),
        boardId,
        input.sliceId ?? null,
        input.title,
        input.detail ?? '',
        input.status != null ? FindingStatusSchema.parse(input.status) : 'open',
        nextOrder,
        now,
        now,
      )
    this.touch(boardId, now)
    return this.emitFresh(boardId)
  }

  /** Update a finding's status (open → resolved/deferred). */
  updateFindingStatus(
    boardId: string,
    findingId: string,
    status: FindingStatusWire,
  ): BoardDto | null {
    const validated = FindingStatusSchema.parse(status)
    const now = new Date().toISOString()
    const res = this.db
      .prepare(
        `UPDATE board_findings SET status = ?, updated_at = ? WHERE id = ? AND board_id = ?`,
      )
      .run(validated, now, findingId, boardId)
    if (res.changes === 0) return null
    this.touch(boardId, now)
    return this.emitFresh(boardId)
  }

  // ── internals ────────────────────────────────────────────────────────

  private touch(boardId: string, now: string): void {
    this.db.prepare(`UPDATE boards SET updated_at = ? WHERE id = ?`).run(now, boardId)
  }

  /** Re-read the board and emit one event. Throws if the board vanished. */
  private emitFresh(boardId: string): BoardDto {
    const board = this.getById(boardId)
    if (board == null) {
      throw new Error(`Board "${boardId}" not found after write`)
    }
    this.bus.emit({
      type: 'board.updated',
      workspaceId: board.workspaceId,
      boardId: board.id,
      board,
      at: board.updatedAt,
    })
    return board
  }
}
