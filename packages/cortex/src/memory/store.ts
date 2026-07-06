/**
 * SqliteMemoryStore — CRUD + ranking + supersession for the
 * `memories` table. Synchronous (better-sqlite3) and transactional
 * where multi-statement consistency matters.
 *
 * Read path of note: `loadActiveForPrompt(profileId, limit)` is the
 * hot query the assembler runs at every session start. It returns
 * memories ordered by:
 *   1. pinned (user-marked always-load)
 *   2. last_referenced_at (recency of last use; NULLs last)
 *   3. confidence (0–1; user-pinned defaults 1.0)
 *   4. created_at (newest first)
 *
 * The compound index `idx_memories_profile_active` covers exactly
 * this WHERE + ORDER BY shape so the query plans as an index scan
 * with an early LIMIT.
 *
 * Supersession: when a new memory is intended to replace an existing
 * one (UI flag, future contradiction detection), `supersede(oldId,
 * newRow)` flips the old row's status to 'superseded', writes
 * superseded_by → newRow.id, and inserts the new row, all in one
 * transaction. Superseded rows are kept for audit; they never appear
 * in `loadActiveForPrompt` (filtered by `status='active'`).
 */

import type Database from 'better-sqlite3'
import {
  MemoryKindSchema,
  MemoryScopeSchema,
  MemorySourceSchema,
  MemoryStatusSchema,
  type Memory,
  type MemoryKind,
  type MemorySource,
  type MemoryStatus,
} from './schema.js'
import type { MemoryEventBus } from './event-bus.js'

// ---------------------------------------------------------------------------
// Row type (snake_case, mirrors the SQL schema)
// ---------------------------------------------------------------------------

interface MemoryRow {
  readonly id: string
  readonly profile_id: string
  readonly scope: string
  readonly scope_id: string | null
  readonly kind: string
  readonly content: string
  readonly source: string
  readonly source_thread_id: string | null
  readonly source_proposal_id: string | null
  readonly confidence: number
  readonly status: string
  readonly superseded_by: string | null
  readonly pinned: number
  readonly reference_count: number
  readonly last_referenced_at: string | null
  readonly created_at: string
  readonly updated_at: string
}

function rowToMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    profileId: row.profile_id,
    scope: MemoryScopeSchema.parse(row.scope),
    scopeId: row.scope_id,
    kind: MemoryKindSchema.parse(row.kind),
    content: row.content,
    source: MemorySourceSchema.parse(row.source),
    sourceThreadId: row.source_thread_id,
    sourceProposalId: row.source_proposal_id,
    confidence: row.confidence,
    status: MemoryStatusSchema.parse(row.status),
    supersededBy: row.superseded_by,
    pinned: row.pinned !== 0,
    referenceCount: row.reference_count,
    lastReferencedAt: row.last_referenced_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// ---------------------------------------------------------------------------
// IDs
// ---------------------------------------------------------------------------

function newMemoryId(): string {
  return `mem_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`
}

// ---------------------------------------------------------------------------
// Insert input
// ---------------------------------------------------------------------------

export interface CreateMemoryInput {
  readonly profileId: string
  readonly content: string
  readonly kind?: MemoryKind
  readonly source: MemorySource
  readonly sourceThreadId?: string | null
  readonly sourceProposalId?: string | null
  readonly confidence?: number
  readonly pinned?: boolean
}

export interface UpdateMemoryInput {
  readonly content?: string
  readonly kind?: MemoryKind
  readonly pinned?: boolean
  readonly status?: MemoryStatus
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class SqliteMemoryStore {
  private readonly db: Database.Database
  private readonly bus: MemoryEventBus | null

  constructor(db: Database.Database, bus: MemoryEventBus | null = null) {
    this.db = db
    this.bus = bus
  }

  // ── Reads ─────────────────────────────────────────────────────────

  getById(id: string): Memory | null {
    const row = this.db.prepare(`SELECT * FROM memories WHERE id = ?`).get(id) as MemoryRow | undefined
    return row ? rowToMemory(row) : null
  }

  /**
   * Hot read path: ranked top-N active memories for assembler injection.
   * Index `idx_memories_profile_active` covers the order.
   */
  loadActiveForPrompt(profileId: string, limit: number): Memory[] {
    if (limit <= 0) return []
    const rows = this.db.prepare(
      `SELECT * FROM memories
       WHERE profile_id = ? AND status = 'active'
       ORDER BY pinned DESC,
                last_referenced_at IS NULL,           -- 0 first → non-null first
                last_referenced_at DESC,
                confidence DESC,
                created_at DESC
       LIMIT ?`,
    ).all(profileId, limit) as MemoryRow[]
    return rows.map(rowToMemory)
  }

  /**
   * Mark a set of memory IDs as referenced (assembler called these into
   * a prompt). One transaction; emits no event — usage signal updates
   * are intentionally silent so they don't ping the SSE channel for
   * every session start.
   */
  recordReferences(ids: readonly string[]): void {
    if (ids.length === 0) return
    const now = new Date().toISOString()
    const stmt = this.db.prepare(
      `UPDATE memories
       SET reference_count = reference_count + 1,
           last_referenced_at = ?
       WHERE id = ?`,
    )
    const txn = this.db.transaction((rows: readonly string[]) => {
      for (const id of rows) stmt.run(now, id)
    })
    txn(ids)
  }

  listForProfile(
    profileId: string,
    options: {
      status?: MemoryStatus | 'all'
      limit?: number
      offset?: number
    } = {},
  ): Memory[] {
    const status = options.status ?? 'active'
    const limit = options.limit ?? 200
    const offset = options.offset ?? 0
    if (status === 'all') {
      const rows = this.db.prepare(
        `SELECT * FROM memories
         WHERE profile_id = ?
         ORDER BY status = 'active' DESC,
                  pinned DESC,
                  last_referenced_at IS NULL,
                  last_referenced_at DESC,
                  confidence DESC,
                  created_at DESC
         LIMIT ? OFFSET ?`,
      ).all(profileId, limit, offset) as MemoryRow[]
      return rows.map(rowToMemory)
    }
    const rows = this.db.prepare(
      `SELECT * FROM memories
       WHERE profile_id = ? AND status = ?
       ORDER BY pinned DESC,
                last_referenced_at IS NULL,
                last_referenced_at DESC,
                confidence DESC,
                created_at DESC
       LIMIT ? OFFSET ?`,
    ).all(profileId, status, limit, offset) as MemoryRow[]
    return rows.map(rowToMemory)
  }

  countForProfile(profileId: string, status: MemoryStatus | 'all' = 'active'): number {
    if (status === 'all') {
      const row = this.db.prepare(
        `SELECT COUNT(*) AS c FROM memories WHERE profile_id = ?`,
      ).get(profileId) as { c: number }
      return row.c
    }
    const row = this.db.prepare(
      `SELECT COUNT(*) AS c FROM memories WHERE profile_id = ? AND status = ?`,
    ).get(profileId, status) as { c: number }
    return row.c
  }

  // ── Writes ────────────────────────────────────────────────────────

  create(input: CreateMemoryInput): Memory {
    const id = newMemoryId()
    const now = new Date().toISOString()
    const kind = input.kind ?? 'fact'
    const confidence = input.confidence ?? (input.source === 'user_pinned' ? 1.0 : 0.8)
    const pinned = input.pinned ? 1 : 0

    this.db.prepare(
      `INSERT INTO memories (
        id, profile_id, scope, scope_id, kind, content,
        source, source_thread_id, source_proposal_id,
        confidence, status, superseded_by, pinned,
        reference_count, last_referenced_at,
        created_at, updated_at
      ) VALUES (?, ?, 'agent', NULL, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, 0, NULL, ?, ?)`,
    ).run(
      id,
      input.profileId,
      kind,
      input.content,
      input.source,
      input.sourceThreadId ?? null,
      input.sourceProposalId ?? null,
      confidence,
      pinned,
      now,
      now,
    )

    const created = this.getById(id)
    if (!created) {
      throw new Error(`Failed to read back inserted memory ${id}`)
    }

    this.bus?.emit({
      type: 'memory.changed',
      profileId: input.profileId,
      memoryId: id,
      at: now,
    })

    return created
  }

  update(id: string, input: UpdateMemoryInput): Memory | null {
    const existing = this.getById(id)
    if (!existing) return null

    const sets: string[] = []
    const values: unknown[] = []

    if (input.content !== undefined) {
      sets.push('content = ?')
      values.push(input.content)
    }
    if (input.kind !== undefined) {
      sets.push('kind = ?')
      values.push(input.kind)
    }
    if (input.pinned !== undefined) {
      sets.push('pinned = ?')
      values.push(input.pinned ? 1 : 0)
    }
    if (input.status !== undefined) {
      sets.push('status = ?')
      values.push(input.status)
    }

    if (sets.length === 0) return existing

    const now = new Date().toISOString()
    sets.push('updated_at = ?')
    values.push(now)
    values.push(id)

    this.db.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`).run(...values)

    const refreshed = this.getById(id)
    if (refreshed) {
      this.bus?.emit({
        type: 'memory.changed',
        profileId: refreshed.profileId,
        memoryId: id,
        at: now,
      })
    }
    return refreshed
  }

  /**
   * Hard delete. Reserved for legitimate user-driven removal (UI delete
   * button). Aud trail is preserved in `memory.changed` event log via
   * the one-shot emit before the row vanishes.
   */
  remove(id: string): boolean {
    const existing = this.getById(id)
    if (!existing) return false
    this.db.prepare(`DELETE FROM memories WHERE id = ?`).run(id)
    this.bus?.emit({
      type: 'memory.changed',
      profileId: existing.profileId,
      memoryId: id,
      at: new Date().toISOString(),
    })
    return true
  }

  /**
   * Atomic supersession: write a new memory and mark an old one
   * superseded → newId in one transaction. Returns the new memory.
   */
  supersede(oldId: string, newInput: CreateMemoryInput): Memory {
    const newId = newMemoryId()
    const now = new Date().toISOString()
    const kind = newInput.kind ?? 'fact'
    const confidence =
      newInput.confidence ?? (newInput.source === 'user_pinned' ? 1.0 : 0.8)
    const pinned = newInput.pinned ? 1 : 0

    const insertNew = this.db.prepare(
      `INSERT INTO memories (
        id, profile_id, scope, scope_id, kind, content,
        source, source_thread_id, source_proposal_id,
        confidence, status, superseded_by, pinned,
        reference_count, last_referenced_at,
        created_at, updated_at
      ) VALUES (?, ?, 'agent', NULL, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, 0, NULL, ?, ?)`,
    )
    const markOld = this.db.prepare(
      `UPDATE memories
       SET status = 'superseded', superseded_by = ?, updated_at = ?
       WHERE id = ? AND status = 'active'`,
    )

    const txn = this.db.transaction(() => {
      insertNew.run(
        newId,
        newInput.profileId,
        kind,
        newInput.content,
        newInput.source,
        newInput.sourceThreadId ?? null,
        newInput.sourceProposalId ?? null,
        confidence,
        pinned,
        now,
        now,
      )
      markOld.run(newId, now, oldId)
    })
    txn()

    const created = this.getById(newId)
    if (!created) throw new Error(`Failed to read back superseded memory ${newId}`)

    this.bus?.emit({
      type: 'memory.changed',
      profileId: newInput.profileId,
      memoryId: newId,
      at: now,
    })

    return created
  }
}
