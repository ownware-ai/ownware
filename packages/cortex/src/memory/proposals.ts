/**
 * SqliteMemoryProposalsStore — the approval queue.
 *
 * Writes:
 *   - `propose(...)` — agent's `remember` tool calls land here as
 *     `pending` rows. No memory exists yet.
 *   - `accept(...)` — atomically (a) inserts a new row in `memories`,
 *     (b) flips the proposal to `accepted` (or `edited` when content
 *     changed), and (c) links resolved_memory_id back to the new row.
 *   - `reject(...)` — flips to `rejected`, records optional reason,
 *     never touches `memories`.
 *
 * Reads serve the gateway's pending-approval list (per profile and
 * per thread). A composite index covers each path.
 */

import type Database from 'better-sqlite3'
import {
  MemoryKindSchema,
  ProposalStatusSchema,
  type MemoryKind,
  type MemoryProposal,
  type ProposalStatus,
} from './schema.js'
import type { MemoryEventBus } from './event-bus.js'
import type { SqliteMemoryStore } from './store.js'
import type { Memory } from './schema.js'

// ---------------------------------------------------------------------------
// Row type
// ---------------------------------------------------------------------------

interface ProposalRow {
  readonly id: string
  readonly profile_id: string
  readonly thread_id: string
  readonly proposed_content: string
  readonly proposed_kind: string
  readonly status: string
  readonly resolved_content: string | null
  readonly resolved_memory_id: string | null
  readonly rejection_reason: string | null
  readonly created_at: string
  readonly resolved_at: string | null
}

function rowToProposal(row: ProposalRow): MemoryProposal {
  return {
    id: row.id,
    profileId: row.profile_id,
    threadId: row.thread_id,
    proposedContent: row.proposed_content,
    proposedKind: MemoryKindSchema.parse(row.proposed_kind),
    status: ProposalStatusSchema.parse(row.status),
    resolvedContent: row.resolved_content,
    resolvedMemoryId: row.resolved_memory_id,
    rejectionReason: row.rejection_reason,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  }
}

function newProposalId(): string {
  return `prop_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface ProposeInput {
  readonly profileId: string
  readonly threadId: string
  readonly content: string
  readonly kind?: MemoryKind
}

export interface AcceptInput {
  /** Final content if the user edited it. Defaults to proposed_content. */
  readonly content?: string
  /** Final kind if changed. Defaults to proposed_kind. */
  readonly kind?: MemoryKind
  /** User can pin on accept. */
  readonly pinned?: boolean
}

export class SqliteMemoryProposalsStore {
  private readonly db: Database.Database
  private readonly bus: MemoryEventBus | null
  private readonly memories: SqliteMemoryStore

  constructor(
    db: Database.Database,
    memories: SqliteMemoryStore,
    bus: MemoryEventBus | null = null,
  ) {
    this.db = db
    this.memories = memories
    this.bus = bus
  }

  // ── Reads ─────────────────────────────────────────────────────────

  getById(id: string): MemoryProposal | null {
    const row = this.db.prepare(
      `SELECT * FROM memory_proposals WHERE id = ?`,
    ).get(id) as ProposalRow | undefined
    return row ? rowToProposal(row) : null
  }

  listForProfile(
    profileId: string,
    options: { status?: ProposalStatus | 'all'; limit?: number } = {},
  ): MemoryProposal[] {
    const status = options.status ?? 'pending'
    const limit = options.limit ?? 100
    if (status === 'all') {
      const rows = this.db.prepare(
        `SELECT * FROM memory_proposals
         WHERE profile_id = ?
         ORDER BY status = 'pending' DESC, created_at DESC
         LIMIT ?`,
      ).all(profileId, limit) as ProposalRow[]
      return rows.map(rowToProposal)
    }
    const rows = this.db.prepare(
      `SELECT * FROM memory_proposals
       WHERE profile_id = ? AND status = ?
       ORDER BY created_at DESC
       LIMIT ?`,
    ).all(profileId, status, limit) as ProposalRow[]
    return rows.map(rowToProposal)
  }

  listForThread(
    threadId: string,
    options: { status?: ProposalStatus | 'all'; limit?: number } = {},
  ): MemoryProposal[] {
    const status = options.status ?? 'pending'
    const limit = options.limit ?? 100
    if (status === 'all') {
      const rows = this.db.prepare(
        `SELECT * FROM memory_proposals
         WHERE thread_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      ).all(threadId, limit) as ProposalRow[]
      return rows.map(rowToProposal)
    }
    const rows = this.db.prepare(
      `SELECT * FROM memory_proposals
       WHERE thread_id = ? AND status = ?
       ORDER BY created_at DESC
       LIMIT ?`,
    ).all(threadId, status, limit) as ProposalRow[]
    return rows.map(rowToProposal)
  }

  countPendingForProfile(profileId: string): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS c FROM memory_proposals
       WHERE profile_id = ? AND status = 'pending'`,
    ).get(profileId) as { c: number }
    return row.c
  }

  // ── Writes ────────────────────────────────────────────────────────

  /**
   * Agent proposes a memory. Lands as `pending`, no memory row created.
   * Idempotent against exact-match dupes within the same thread to
   * avoid a confused agent re-proposing the same fact every turn.
   */
  propose(input: ProposeInput): MemoryProposal {
    const trimmed = input.content.trim()
    if (trimmed.length === 0) {
      throw new Error('Proposal content cannot be empty.')
    }

    // Dupe guard: same thread + same content + still pending → return existing.
    const existing = this.db.prepare(
      `SELECT * FROM memory_proposals
       WHERE thread_id = ? AND status = 'pending' AND proposed_content = ?
       ORDER BY created_at DESC
       LIMIT 1`,
    ).get(input.threadId, trimmed) as ProposalRow | undefined
    if (existing) return rowToProposal(existing)

    const id = newProposalId()
    const now = new Date().toISOString()
    const kind = input.kind ?? 'fact'

    this.db.prepare(
      `INSERT INTO memory_proposals (
        id, profile_id, thread_id, proposed_content, proposed_kind,
        status, resolved_content, resolved_memory_id, rejection_reason,
        created_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?, NULL)`,
    ).run(id, input.profileId, input.threadId, trimmed, kind, now)

    const proposal = this.getById(id)
    if (!proposal) throw new Error(`Failed to read back proposal ${id}`)

    this.bus?.emit({
      type: 'memory.proposed',
      profileId: input.profileId,
      threadId: input.threadId,
      proposalId: id,
      at: now,
    })

    return proposal
  }

  /**
   * Atomically:
   *   1. Insert a memories row from the (possibly edited) content.
   *   2. Flip the proposal to 'accepted' or 'edited' (when content changed).
   *   3. Stamp resolved_memory_id and resolved_at.
   *
   * Returns the resolved proposal AND the created memory (caller often
   * needs both — the UI shows the new memory, the audit shows the
   * proposal lineage).
   */
  accept(id: string, edits: AcceptInput): { proposal: MemoryProposal; memory: Memory } | null {
    const existing = this.getById(id)
    if (!existing) return null
    if (existing.status !== 'pending') {
      throw new Error(
        `Cannot accept proposal ${id}: status is "${existing.status}", expected "pending".`,
      )
    }

    const finalContent = (edits.content ?? existing.proposedContent).trim()
    if (finalContent.length === 0) {
      throw new Error('Final content cannot be empty.')
    }
    const finalKind = edits.kind ?? existing.proposedKind
    const wasEdited = finalContent !== existing.proposedContent || finalKind !== existing.proposedKind
    const finalStatus: ProposalStatus = wasEdited ? 'edited' : 'accepted'
    const now = new Date().toISOString()

    let memory!: Memory

    const txn = this.db.transaction(() => {
      memory = this.memories.create({
        profileId: existing.profileId,
        content: finalContent,
        kind: finalKind,
        source: 'agent_proposed',
        sourceThreadId: existing.threadId,
        sourceProposalId: existing.id,
        confidence: edits.pinned ? 1.0 : 0.9,
        pinned: edits.pinned ?? false,
      })
      this.db.prepare(
        `UPDATE memory_proposals
         SET status = ?, resolved_content = ?, resolved_memory_id = ?, resolved_at = ?
         WHERE id = ?`,
      ).run(finalStatus, finalContent, memory.id, now, id)
    })
    txn()

    const refreshed = this.getById(id)
    if (!refreshed) throw new Error(`Proposal ${id} disappeared after accept`)

    this.bus?.emit({
      type: 'memory.proposal.resolved',
      profileId: existing.profileId,
      proposalId: id,
      status: finalStatus,
      at: now,
    })

    return { proposal: refreshed, memory }
  }

  reject(id: string, reason: string | null): MemoryProposal | null {
    const existing = this.getById(id)
    if (!existing) return null
    if (existing.status !== 'pending') {
      throw new Error(
        `Cannot reject proposal ${id}: status is "${existing.status}", expected "pending".`,
      )
    }
    const now = new Date().toISOString()
    this.db.prepare(
      `UPDATE memory_proposals
       SET status = 'rejected', rejection_reason = ?, resolved_at = ?
       WHERE id = ?`,
    ).run(reason ?? null, now, id)

    this.bus?.emit({
      type: 'memory.proposal.resolved',
      profileId: existing.profileId,
      proposalId: id,
      status: 'rejected',
      at: now,
    })

    return this.getById(id)
  }
}
