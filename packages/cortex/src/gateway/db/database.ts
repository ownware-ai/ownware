/**
 * Cortex Database
 *
 * SQLite-backed persistence for the gateway.
 * Location: ~/.ownware/ownware.db
 *
 * The filename keeps the `ownware.db` name on purpose — it's a
 * kernel-internal artifact and renaming it serves no user-facing
 * brand goal. The data dir name (`.ownware`) is the brand surface.
 *
 * Features:
 * - Automatic migration on startup
 * - WAL mode for concurrent reads during writes
 * - Prepared statements for performance
 * - Clean interface matching GatewayState
 */

import Database from 'better-sqlite3'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { mkdirSync } from 'node:fs'
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import { MIGRATIONS } from './schema.js'
import { openDatabaseSafely } from './migration-safety.js'
import { DEFAULT_DATA_DIR_NAME } from '../../constants.js'
import type {
  Thread,
  ThreadMessage,
  Workspace,
  WorkspaceDetail,
  MCPServerRecord,
  DashboardStats,
  DashboardProfileEntry,
  DashboardWorkspaceEntry,
  LocalProfile,
  UserSettings,
  ProfileMetadata,
  WorkspacePane,
  PaneConfig,
  PaneMetadata,
  PaneZone,
  AppState,
  AuditLogEntry,
  PaginatedResult,
  UsageBucket,
  DashboardRange,
  DashboardKPIs,
  DashboardKPICard,
  ProfileBreakdownRow,
  RecentActivityRow,
  Design,
} from '../types.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Lazy so `OWNWARE_DATA_DIR` is honored — same contract as the gateway
 *  (`server.ts`: `opts.dataDir ?? OWNWARE_DATA_DIR ?? ~/.ownware`). */
function defaultDbPath(): string {
  const dataDir = process.env['OWNWARE_DATA_DIR'] ?? join(homedir(), DEFAULT_DATA_DIR_NAME)
  return join(dataDir, 'ownware.db')
}

// ---------------------------------------------------------------------------
// CortexDatabase
// ---------------------------------------------------------------------------

export class CortexDatabase {
  private readonly db: Database.Database

  // Pre-prepared statements for the streaming hot path (production-
  // perf audit Slice D, 2026-05-18). Before this, every text.delta
  // event during a chat stream re-called `db.prepare(...)` for both
  // the seq lookup and the insert — even though better-sqlite3
  // caches internally, the lookup is still measurable at 30–50
  // events/sec sustained. Preparing once at construct time keeps the
  // hot path to one transaction + two `.get()` / `.run()` calls.
  private readonly agentEventSeqStmt: Database.Statement
  private readonly agentEventInsertStmt: Database.Statement
  /**
   * Reusable transaction wrapper for `appendAgentEvent`. `db.transaction`
   * returns a closure — we want one closure for the lifetime of the
   * database, not one per call.
   */
  private readonly appendAgentEventTx: (params: {
    threadId: string
    agentId: string
    parentAgentId: string | null
    type: string
    payloadJson: string
    createdAt: number
  }) => number

  constructor(dbPath?: string) {
    const path = dbPath ?? defaultDbPath()

    // Ensure directory exists
    mkdirSync(join(path, '..'), { recursive: true })

    // Open + configure + migrate, with two safety nets (see migration-safety.ts
    // and MIGRATION-POLICY.md): a bad migration auto-restores its pre-update
    // snapshot, and a CORRUPT file on disk auto-recovers from the latest backup
    // instead of being misread as a fresh DB. Throws MigrationSafetyError (with
    // a user-facing message, data left intact) only when recovery is impossible.
    this.db = openDatabaseSafely(
      path,
      (db) => {
        // Performance settings — applied to every freshly-opened handle,
        // including the one re-opened after a corruption restore.
        db.pragma('journal_mode = WAL')
        db.pragma('synchronous = NORMAL')
        db.pragma('foreign_keys = ON')
        db.pragma('busy_timeout = 5000')
      },
      MIGRATIONS,
    )

    // Prepare hot-path statements (must come AFTER migrations, since
    // they reference `agent_events` which is created by a migration).
    this.agentEventSeqStmt = this.db.prepare(
      'SELECT COALESCE(MAX(seq), 0) as max_seq FROM agent_events WHERE thread_id = ? AND agent_id = ?',
    )
    this.agentEventInsertStmt = this.db.prepare(
      'INSERT INTO agent_events (thread_id, agent_id, parent_agent_id, seq, type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    this.appendAgentEventTx = this.db.transaction((params: {
      threadId: string
      agentId: string
      parentAgentId: string | null
      type: string
      payloadJson: string
      createdAt: number
    }): number => {
      const row = this.agentEventSeqStmt.get(
        params.threadId,
        params.agentId,
      ) as { max_seq: number }
      const seq = row.max_seq + 1
      this.agentEventInsertStmt.run(
        params.threadId,
        params.agentId,
        params.parentAgentId,
        seq,
        params.type,
        params.payloadJson,
        params.createdAt,
      )
      return seq
    })
  }

  // ── Thread CRUD ──────────────────────────────────────────────────────

  createThread(profileId: string, title?: string, workspaceId?: string): Thread {
    const id = `thread_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
    const now = new Date().toISOString()

    this.db.prepare(`
      INSERT INTO threads (id, profile_id, workspace_id, title, status, message_count, total_tokens, total_cost, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'active', 0, 0, 0, ?, ?)
    `).run(id, profileId, workspaceId ?? null, title ?? null, now, now)

    // Update workspace_profiles junction if workspace is specified
    if (workspaceId) {
      this.db.prepare(`
        INSERT INTO workspace_profiles (workspace_id, profile_id, thread_count, last_used_at)
        VALUES (?, ?, 1, ?)
        ON CONFLICT(workspace_id, profile_id) DO UPDATE SET
          thread_count = thread_count + 1,
          last_used_at = excluded.last_used_at
      `).run(workspaceId, profileId, now)
    }

    return {
      id,
      profileId,
      workspaceId: workspaceId ?? null,
      title: title ?? null,
      status: 'active',
      messageCount: 0,
      totalTokens: 0,
      totalCost: 0,
      // null = "no override yet, use the profile's default model".
      // The first run on this thread will UPDATE this column with the
      // dispatched model so reload + future turns see the user's
      // explicit choice. NEVER inherit profile.model at create time —
      // doing so would freeze the thread to the model the profile had
      // at creation, not its current default.
      model: null,
      lastMessagePreview: null,
      createdAt: now,
      updatedAt: now,
    }
  }

  getThread(id: string): Thread | undefined {
    const row = this.db.prepare('SELECT * FROM threads WHERE id = ?').get(id) as ThreadRow | undefined
    return row ? mapThread(row) : undefined
  }

  listThreads(profileId?: string, opts?: { limit?: number; offset?: number }): PaginatedResult<Thread> {
    const limit = Math.min(opts?.limit ?? 50, 200)
    const offset = opts?.offset ?? 0

    const total = profileId
      ? (this.db.prepare('SELECT COUNT(*) as c FROM threads WHERE profile_id = ?').get(profileId) as { c: number }).c
      : (this.db.prepare('SELECT COUNT(*) as c FROM threads').get() as { c: number }).c

    const rows = profileId
      ? (this.db.prepare(
          'SELECT * FROM threads WHERE profile_id = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?',
        ).all(profileId, limit, offset) as ThreadRow[])
      : (this.db.prepare(
          'SELECT * FROM threads ORDER BY updated_at DESC LIMIT ? OFFSET ?',
        ).all(limit, offset) as ThreadRow[])

    return { items: rows.map(mapThread), total, offset, limit }
  }

  updateThread(
    id: string,
    updates: Partial<Pick<Thread, 'title' | 'status' | 'messageCount' | 'totalTokens' | 'totalCost'>>,
  ): Thread | undefined {
    const thread = this.getThread(id)
    if (!thread) return undefined

    const now = new Date().toISOString()
    const title = updates.title !== undefined ? updates.title : thread.title
    const status = updates.status !== undefined ? updates.status : thread.status
    const messageCount = updates.messageCount !== undefined ? updates.messageCount : thread.messageCount
    const totalTokens = updates.totalTokens !== undefined ? updates.totalTokens : thread.totalTokens
    const totalCost = updates.totalCost !== undefined ? updates.totalCost : thread.totalCost

    this.db.prepare(`
      UPDATE threads SET title = ?, status = ?, message_count = ?, total_tokens = ?, total_cost = ?, updated_at = ?
      WHERE id = ?
    `).run(title, status, messageCount, totalTokens, totalCost, now, id)

    return this.getThread(id)
  }

  /**
   * Persist the thread's "current model" — the canonical model id last
   * dispatched on this thread. Read by the client's model picker on tab
   * load to show the user's last brain pick across reloads.
   *
   * Idempotent and atomic. No-op when the thread doesn't exist (the
   * caller already validated the threadId via the run path; a missing
   * row here would be a programming error, not user-visible state).
   *
   * Why a focused method instead of folding into `updateThread`: the
   * other thread fields (title, status, totals) are run-output state.
   * `model` is run-INPUT state — what the user wants the next turn to
   * use. Different lifecycle, different writers, different tests.
   * Keeping them apart avoids accidental cross-writes.
   */
  setThreadModel(id: string, model: string): void {
    this.db.prepare(`
      UPDATE threads SET model = ?, updated_at = datetime('now') WHERE id = ?
    `).run(model, id)
  }

  /**
   * Mark all threads with status='active' as 'completed'. Called once
   * at gateway boot to recover orphaned threads from a previous crash
   * — no in-memory runtime survives a restart, so any 'active' thread
   * is guaranteed to have no running loop. Returns the count of rows
   * updated.
   */
  recoverOrphanedThreads(): number {
    const result = this.db.prepare(
      `UPDATE threads SET status = 'completed', updated_at = datetime('now')
       WHERE status = 'active'`,
    ).run()
    return result.changes
  }

  deleteThread(id: string): boolean {
    // workspace_panes stores chat-pane → thread linkage inside
    // config_json (no FK column), so deleting a thread doesn't
    // cascade. Drop chat panes that reference this thread first so
    // the UI can never render a ghost pane for a thread that no
    // longer exists.
    return this.db.transaction(() => {
      this.db.prepare(`
        DELETE FROM workspace_panes
        WHERE kind = 'chat'
          AND json_extract(config_json, '$.threadId') = ?
      `).run(id)
      const result = this.db.prepare(
        'DELETE FROM threads WHERE id = ?',
      ).run(id)
      return result.changes > 0
    })()
  }

  // ── Message CRUD ──────────────────────────────────────────────────────

  addMessage(threadId: string, msg: ThreadMessage): void {
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO messages (id, thread_id, role, content, tools, sub_agents, permissions, attachments, thinking, usage_input, usage_output, usage_cache_read, usage_cache_creation, created_at, parts, credentials, model)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        msg.id,
        threadId,
        msg.role,
        msg.content,
        msg.tools ? JSON.stringify(msg.tools) : null,
        msg.subAgents ? JSON.stringify(msg.subAgents) : null,
        msg.permissions ? JSON.stringify(msg.permissions) : null,
        msg.attachments ? JSON.stringify(msg.attachments) : null,
        msg.thinking ?? null,
        msg.usage?.inputTokens ?? null,
        msg.usage?.outputTokens ?? null,
        // Cache fields (migration 027). NULL when usage isn't reported
        // (user/system rows) or when the caller didn't supply them
        // (pre-update callers — distinguishes from genuine "0 cache
        // tokens this turn", which writes 0 not NULL).
        msg.usage?.cacheReadTokens ?? null,
        msg.usage?.cacheCreationTokens ?? null,
        msg.timestamp,
        msg.parts ? JSON.stringify(msg.parts) : null,
        msg.credentials ? JSON.stringify(msg.credentials) : null,
        msg.model ?? null,
      )

      // Atomically increment message_count and update last_message_preview + updated_at
      const preview = msg.content.slice(0, 200) || null
      this.db.prepare(`
        UPDATE threads
        SET message_count = message_count + 1,
            last_message_preview = ?,
            updated_at = datetime('now')
        WHERE id = ?
      `).run(preview, threadId)
    })()
  }

  getMessages(threadId: string): ThreadMessage[] {
    const rows = this.db.prepare(
      'SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at ASC',
    ).all(threadId) as MessageRow[]
    return rows.map(mapMessage)
  }

  /**
   * Back-patch a sub-agent's status inside the message row's `sub_agents`
   * JSON column. Finds the most recent message in the thread whose
   * `sub_agents` array contains a record with the given `agentId`, then
   * replaces that record with the updated one.
   *
   * Returns true if a row was patched, false if no matching message found.
   */
  patchMessageSubAgent(threadId: string, agentId: string, patch: {
    status: 'running' | 'completed' | 'error'
    result?: string
    durationMs?: number
    toolCount?: number
    turnCount?: number
  }): boolean {
    const rows = this.db.prepare(
      `SELECT id, sub_agents FROM messages
       WHERE thread_id = ? AND sub_agents IS NOT NULL
       ORDER BY created_at DESC`,
    ).all(threadId) as Array<{ id: string; sub_agents: string }>

    for (const row of rows) {
      let agents: Array<Record<string, unknown>>
      try {
        agents = JSON.parse(row.sub_agents)
      } catch {
        continue
      }
      const idx = agents.findIndex((a) => a.agentId === agentId)
      if (idx === -1) continue

      agents[idx] = { ...agents[idx], ...patch }
      this.db.prepare(
        'UPDATE messages SET sub_agents = ? WHERE id = ?',
      ).run(JSON.stringify(agents), row.id)
      return true
    }
    return false
  }

  // ── Agent events (append-only log, per-(thread, agent) monotonic seq) ──

  /**
   * Append an event to the (thread_id, agent_id) stream.
   *
   * Atomic: assigns the next seq number inside a transaction so two
   * concurrent ingestors on the same agent can't collide. Returns the
   * assigned seq so the caller can publish it to the bus.
   *
   * `payload` is the full LoomEvent as JSON — the type column is a
   * denormalized copy of payload.type so we can filter without parsing.
   */
  appendAgentEvent(params: {
    threadId: string
    agentId: string
    parentAgentId: string | null
    type: string
    payload: unknown
  }): number {
    // Hot path: at 30–50 text.delta/sec during a streaming chat,
    // every microsecond matters. The transaction wrapper and both
    // statements are pre-prepared in the constructor; this method
    // only stringifies the payload and dispatches.
    return this.appendAgentEventTx({
      threadId: params.threadId,
      agentId: params.agentId,
      parentAgentId: params.parentAgentId,
      type: params.type,
      payloadJson: JSON.stringify(params.payload),
      createdAt: Date.now(),
    })
  }

  /**
   * List events for a specific agent's stream.
   *
   * `since` is exclusive — pass the last seq the client has seen, or 0 to
   * start from the beginning. Returns at most `limit` events in ascending
   * seq order. Used by the SSE replay path.
   */
  listAgentEvents(params: {
    threadId: string
    agentId: string
    since?: number
    limit?: number
  }): Array<{ seq: number; type: string; payload: unknown; createdAt: number; parentAgentId: string | null }> {
    const since = params.since ?? 0
    const limit = params.limit ?? 10_000
    const rows = this.db.prepare(`
      SELECT seq, type, payload, created_at, parent_agent_id
      FROM agent_events
      WHERE thread_id = ? AND agent_id = ? AND seq > ?
      ORDER BY seq ASC
      LIMIT ?
    `).all(params.threadId, params.agentId, since, limit) as Array<{
      seq: number
      type: string
      payload: string
      created_at: number
      parent_agent_id: string | null
    }>
    return rows.map(r => ({
      seq: r.seq,
      type: r.type,
      payload: JSON.parse(r.payload),
      createdAt: r.created_at,
      parentAgentId: r.parent_agent_id,
    }))
  }

  /** Latest seq number for an agent's stream (0 if no events). */
  getAgentEventMaxSeq(threadId: string, agentId: string): number {
    const row = this.db.prepare(
      'SELECT COALESCE(MAX(seq), 0) as max_seq FROM agent_events WHERE thread_id = ? AND agent_id = ?',
    ).get(threadId, agentId) as { max_seq: number }
    return row.max_seq
  }

  /**
   * Highest seq of a `turn.end` event on the agent's stream, or 0 if no
   * turn has ever closed. The client uses this as the SSE `?since` cursor
   * after a tab-switch reconnect: replaying from the last closed turn
   * boundary lets the reducer rebuild any in-flight turn (turn.start +
   * deltas + open tool calls) that has not yet hit `turn.end`.
   *
   * Without this cursor, a reconnect with `?since=maxSeq` would skip
   * the turn.start that opened the in-flight exchange and the live
   * deltas that follow would land on a closed reducer state.
   */
  getLastTurnEndSeq(threadId: string, agentId: string): number {
    const row = this.db.prepare(`
      SELECT COALESCE(MAX(seq), 0) as max_seq
      FROM agent_events
      WHERE thread_id = ? AND agent_id = ? AND type = 'turn.end'
    `).get(threadId, agentId) as { max_seq: number }
    return row.max_seq
  }

  /**
   * True iff at least one event of the given type exists for this agent.
   * Constant-time lookup — used by the SSE idle timer to check for a
   * terminal `agent.complete` without scanning the agent's full log.
   */
  hasAgentEventOfType(threadId: string, agentId: string, type: string): boolean {
    const row = this.db.prepare(`
      SELECT 1 as found
      FROM agent_events
      WHERE thread_id = ? AND agent_id = ? AND type = ?
      LIMIT 1
    `).get(threadId, agentId, type) as { found: number } | undefined
    return row !== undefined
  }

  /** List distinct agent_ids that have events on this thread. */
  listAgentsForThread(threadId: string): Array<{ agentId: string; parentAgentId: string | null; eventCount: number }> {
    const rows = this.db.prepare(`
      SELECT agent_id, MAX(parent_agent_id) as parent_agent_id, COUNT(*) as event_count
      FROM agent_events
      WHERE thread_id = ?
      GROUP BY agent_id
    `).all(threadId) as Array<{ agent_id: string; parent_agent_id: string | null; event_count: number }>
    return rows.map(r => ({
      agentId: r.agent_id,
      parentAgentId: r.parent_agent_id,
      eventCount: r.event_count,
    }))
  }

  // ── Retention (agent_events pruning) ─────────────────────────────────
  //
  // The messages table is the durable-forever source of truth for thread
  // UI (see gateway/CLAUDE.md). agent_events is retained only while it's
  // useful: active runs + recent terminal runs. These helpers implement
  // the two queries the retention module needs.

  /**
   * Thread IDs whose status is terminal (`completed` or `error`) and
   * whose `updated_at` is older than the supplied cutoff. These are the
   * only threads whose agent_events rows may be pruned.
   *
   * `updated_at` is stored as SQLite datetime text, so the comparison is
   * a lexicographic string compare — works as long as `cutoffIso` is
   * a valid SQLite datetime string (ISO 8601 UTC).
   */
  listTerminalThreadsOlderThan(cutoffIso: string): string[] {
    const rows = this.db.prepare(`
      SELECT id FROM threads
      WHERE status IN ('completed', 'error')
        AND updated_at < ?
    `).all(cutoffIso) as Array<{ id: string }>
    return rows.map(r => r.id)
  }

  /**
   * Retention candidates for Slice 2+ semantics: threads whose most
   * recent root-agent event is older than `cutoffMs` (milliseconds
   * since epoch), regardless of `thread.status`. Used after the
   * status-at-run-start change (see the 2026-04-22 stream audit
   * CRITICAL-2 finding) where 'active' can validly span idle gaps
   * between turns.
   *
   * Safety: a quiescent thread (no root events in N days) has either
   * completed cleanly and hasn't been revisited, or stalled and been
   * abandoned. Either way its raw event log is safe to drop — the
   * `messages` snapshot keeps the chat history intact, sub-agent
   * transcripts survive (their agent_id != 'root'), and the thread
   * row itself is never touched. The live-subscriber guard in
   * `runRetentionOnce` still applies.
   *
   * Threads with zero root-agent rows are excluded — there is nothing
   * to prune and returning them would waste a per-thread SQL round-
   * trip in the retention loop.
   *
   * `agent_events.created_at` is stored as INTEGER (ms epoch) —
   * comparisons here are numeric, not lexicographic.
   */
  listThreadsWithQuietRootAgent(cutoffMs: number): string[] {
    const rows = this.db.prepare(`
      SELECT thread_id AS id
      FROM agent_events
      WHERE agent_id = 'root'
      GROUP BY thread_id
      HAVING MAX(created_at) < ?
    `).all(cutoffMs) as Array<{ id: string }>
    return rows.map(r => r.id)
  }

  /**
   * Delete root-agent agent_events rows for a single thread. Returns
   * the number of rows deleted so retention can report aggregate stats.
   *
   * Scope: ONLY rows whose `agent_id = 'root'`. Sub-agent transcripts
   * (per-helper streams) survive retention so the "View thread" modal
   * keeps working on archived threads — this is the safety rail that
   * lets us turn retention on without a sub-agent UX cliff.
   *
   * The root stream carries the consolidated parent timeline (text,
   * tools, agent.spawn/complete lifecycle markers, permissions, etc.)
   * which is fully reconstructible from `messages`. Sub-agent streams
   * carry their own internal events that have no equivalent snapshot
   * yet — pruning them would lose history with no way back.
   *
   * Scoped per-thread so the retention driver can check per-thread
   * preconditions (no live subscriber, etc.) between prunes. Bulk
   * deletion by date alone would bypass those checks.
   */
  pruneAgentEvents(threadId: string): number {
    const result = this.db.prepare(
      "DELETE FROM agent_events WHERE thread_id = ? AND agent_id = 'root'",
    ).run(threadId)
    return result.changes
  }

  /** Total rows currently in agent_events. Observability helper. */
  countAgentEvents(): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) as n FROM agent_events',
    ).get() as { n: number }
    return row.n
  }

  // ── Usage tracking ──────────────────────────────────────────────────

  addUsageRecord(record: {
    threadId?: string
    profileId: string
    model: string
    provider: string
    inputTokens: number
    outputTokens: number
    costUsd: number
    durationMs?: number
    success?: boolean
  }): void {
    const id = `usage_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
    const totalTokens = record.inputTokens + record.outputTokens

    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO usage_records (id, thread_id, profile_id, model, provider, input_tokens, output_tokens, total_tokens, cost_usd, duration_ms, success)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        record.threadId ?? null,
        record.profileId,
        record.model,
        record.provider,
        record.inputTokens,
        record.outputTokens,
        totalTokens,
        record.costUsd,
        record.durationMs ?? null,
        record.success !== undefined ? (record.success ? 1 : 0) : 1,
      )

      // Propagate token/cost totals up to the thread (if bound to one)
      if (record.threadId) {
        this.db.prepare(`
          UPDATE threads
          SET total_tokens = total_tokens + ?,
              total_cost   = total_cost + ?,
              updated_at   = datetime('now')
          WHERE id = ?
        `).run(totalTokens, record.costUsd, record.threadId)
      }
    })()
  }

  getUsageSummary(profileId?: string): { totalTokens: number; totalCost: number; requestCount: number } {
    const query = profileId
      ? 'SELECT COALESCE(SUM(total_tokens), 0) as tokens, COALESCE(SUM(cost_usd), 0) as cost, COUNT(*) as count FROM usage_records WHERE profile_id = ?'
      : 'SELECT COALESCE(SUM(total_tokens), 0) as tokens, COALESCE(SUM(cost_usd), 0) as cost, COUNT(*) as count FROM usage_records'

    const row = (profileId
      ? this.db.prepare(query).get(profileId)
      : this.db.prepare(query).get()
    ) as { tokens: number; cost: number; count: number }

    return { totalTokens: row.tokens, totalCost: row.cost, requestCount: row.count }
  }

  // ── Workspace CRUD ───────────────────────────────────────────────────

  createWorkspace(path: string, name?: string): Workspace {
    const id = `ws_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
    const now = new Date().toISOString()
    const wsName = name ?? path.split('/').filter(Boolean).pop() ?? 'workspace'

    // active_products: the column DEFAULT ('["ownware"]') backfills
    // the new row — no need to set it in the INSERT. Migration 032.
    this.db.prepare(`
      INSERT INTO workspaces (id, name, path, status, pinned, last_opened_at, created_at, updated_at)
      VALUES (?, ?, ?, 'active', 0, ?, ?, ?)
    `).run(id, wsName, path, now, now, now)

    return {
      id, name: wsName, path, status: 'active',
      lastProfileId: null, pinned: false, tabCount: 0,
      activeProducts: ['ownware'],
      lastOpenedAt: now, createdAt: now, updatedAt: now,
    }
  }

  getWorkspace(id: string): Workspace | undefined {
    const row = this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as WorkspaceRow | undefined
    return row ? mapWorkspace(row) : undefined
  }

  getWorkspaceByPath(path: string): Workspace | undefined {
    const row = this.db.prepare('SELECT * FROM workspaces WHERE path = ?').get(path) as WorkspaceRow | undefined
    return row ? mapWorkspace(row) : undefined
  }

  listWorkspaces(status?: 'active' | 'archived', opts?: { limit?: number; offset?: number }): PaginatedResult<Workspace> {
    const limit = Math.min(opts?.limit ?? 50, 200)
    const offset = opts?.offset ?? 0

    const total = status
      ? (this.db.prepare('SELECT COUNT(*) as c FROM workspaces WHERE status = ?').get(status) as { c: number }).c
      : (this.db.prepare('SELECT COUNT(*) as c FROM workspaces').get() as { c: number }).c

    // Subquery counts open chat panes per workspace so the sidebar
    // can show a real number instead of the hardcoded 0 it used to
    // display. Wave 1b.9: rewritten to read workspace_panes (chat
    // kind in tabs zone) since workspace_tabs is gone. Field name
    // `tab_count` kept stable so callers don't break — the user-
    // facing concept is still "tabs."
    const query = `
      SELECT w.*,
        (SELECT COUNT(*) FROM workspace_panes wp
          WHERE wp.workspace_id = w.id
            AND wp.zone = 'tabs'
            AND wp.kind = 'chat') AS tab_count
      FROM workspaces w
      ${status != null ? 'WHERE w.status = ?' : ''}
      ORDER BY w.pinned DESC, w.last_opened_at DESC
      LIMIT ? OFFSET ?
    `
    const args = status != null ? [status, limit, offset] : [limit, offset]
    const rows = this.db.prepare(query).all(...args) as Array<WorkspaceRow & { tab_count: number }>

    return { items: rows.map(mapWorkspace), total, offset, limit }
  }

  getWorkspaceDetail(id: string): WorkspaceDetail | undefined {
    const ws = this.getWorkspace(id)
    if (!ws) return undefined

    const profiles = (this.db.prepare(
      'SELECT * FROM workspace_profiles WHERE workspace_id = ? ORDER BY last_used_at DESC',
    ).all(id) as { workspace_id: string; profile_id: string; thread_count: number; last_used_at: string }[])
      .map(r => ({ profileId: r.profile_id, threadCount: r.thread_count, lastUsedAt: r.last_used_at }))

    const activeThreads = (this.db.prepare(
      'SELECT COUNT(*) as c FROM threads WHERE workspace_id = ? AND status = ?',
    ).get(id, 'active') as { c: number }).c

    const totalThreads = (this.db.prepare(
      'SELECT COUNT(*) as c FROM threads WHERE workspace_id = ?',
    ).get(id) as { c: number }).c

    return { ...ws, profiles, activeThreads, totalThreads }
  }

  updateWorkspace(
    id: string,
    updates: {
      name?: string
      pinned?: boolean
      status?: string
      lastProfileId?: string
      activeProducts?: readonly string[]
    },
  ): Workspace | undefined {
    const ws = this.getWorkspace(id)
    if (!ws) return undefined
    const now = new Date().toISOString()

    // active_products is non-empty by contract — caller-side validation
    // (gateway handlers / Zod) is responsible for rejecting empty
    // arrays. Persist the existing value if the caller didn't pass one.
    const nextActiveProducts = updates.activeProducts ?? ws.activeProducts

    this.db.prepare(`
      UPDATE workspaces SET
        name = ?, pinned = ?, status = ?, last_profile_id = ?,
        active_products = ?, last_opened_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      updates.name ?? ws.name,
      updates.pinned !== undefined ? (updates.pinned ? 1 : 0) : (ws.pinned ? 1 : 0),
      updates.status ?? ws.status,
      updates.lastProfileId ?? ws.lastProfileId,
      JSON.stringify(nextActiveProducts),
      now, now, id,
    )
    return this.getWorkspace(id)
  }

  deleteWorkspace(id: string): boolean {
    const result = this.db.prepare('DELETE FROM workspaces WHERE id = ?').run(id)
    return result.changes > 0
  }

  touchWorkspace(id: string): void {
    this.db.prepare('UPDATE workspaces SET last_opened_at = datetime(\'now\'), updated_at = datetime(\'now\') WHERE id = ?').run(id)
  }

  listThreadsByWorkspace(workspaceId: string): Thread[] {
    return (this.db.prepare(
      'SELECT * FROM threads WHERE workspace_id = ? ORDER BY updated_at DESC',
    ).all(workspaceId) as ThreadRow[]).map(mapThread)
  }

  // ── MCP Server CRUD ────────────────────────────────────────────────

  createMCPServer(server: {
    id: string; name: string; transport: string;
    url?: string; command?: string; args?: readonly string[];
    env?: Record<string, string>;
    headers?: Record<string, string>; registryId?: string;
  }): MCPServerRecord {
    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO mcp_servers (id, name, transport, url, command, args, env, headers, registry_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'configured', ?, ?)
    `).run(
      server.id, server.name, server.transport,
      server.url ?? null, server.command ?? null,
      server.args ? JSON.stringify(server.args) : null,
      server.env ? JSON.stringify(server.env) : null,
      server.headers ? JSON.stringify(server.headers) : null,
      server.registryId ?? null, now, now,
    )
    return this.getMCPServer(server.id)!
  }

  getMCPServer(id: string): MCPServerRecord | undefined {
    const row = this.db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as MCPServerRow | undefined
    if (!row) return undefined
    const profileIds = (this.db.prepare(
      'SELECT profile_id FROM profile_mcp_servers WHERE server_id = ?',
    ).all(id) as { profile_id: string }[]).map(r => r.profile_id)
    return mapMCPServer(row, profileIds)
  }

  listMCPServers(opts?: { limit?: number; offset?: number }): PaginatedResult<MCPServerRecord> {
    const limit = Math.min(opts?.limit ?? 50, 200)
    const offset = opts?.offset ?? 0

    const total = (this.db.prepare('SELECT COUNT(*) as c FROM mcp_servers').get() as { c: number }).c

    // Single JOIN query replaces the previous N+1 pattern.
    // GROUP_CONCAT aggregates profile_ids into a comma-separated string.
    const rows = this.db.prepare(`
      SELECT s.*, GROUP_CONCAT(ps.profile_id) AS profile_ids
      FROM mcp_servers s
      LEFT JOIN profile_mcp_servers ps ON ps.server_id = s.id
      GROUP BY s.id
      ORDER BY s.name ASC
      LIMIT ? OFFSET ?
    `).all(limit, offset) as (MCPServerRow & { profile_ids: string | null })[]

    const items = rows.map(row => {
      const profileIds = row.profile_ids ? row.profile_ids.split(',') : []
      return mapMCPServer(row, profileIds)
    })

    return { items, total, offset, limit }
  }

  updateMCPServer(id: string, updates: {
    name?: string; status?: string; toolCount?: number; error?: string | null; toolsJson?: string | null;
  }): MCPServerRecord | undefined {
    const row = this.db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as MCPServerRow | undefined
    if (!row) return undefined
    this.db.prepare(`
      UPDATE mcp_servers SET name = ?, status = ?, tool_count = ?, error = ?, tools_json = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      updates.name ?? row.name,
      updates.status ?? row.status,
      updates.toolCount !== undefined ? updates.toolCount : row.tool_count,
      updates.error !== undefined ? updates.error : row.error,
      updates.toolsJson !== undefined ? updates.toolsJson : row.tools_json,
      id,
    )
    return this.getMCPServer(id)
  }

  deleteMCPServer(id: string): boolean {
    return this.db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id).changes > 0
  }

  assignServerToProfile(serverId: string, profileId: string): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO profile_mcp_servers (profile_id, server_id) VALUES (?, ?)
    `).run(profileId, serverId)
  }

  removeServerFromProfile(serverId: string, profileId: string): boolean {
    return this.db.prepare(
      'DELETE FROM profile_mcp_servers WHERE server_id = ? AND profile_id = ?',
    ).run(serverId, profileId).changes > 0
  }

  getServersForProfile(profileId: string): MCPServerRecord[] {
    const rows = this.db.prepare(`
      SELECT s.* FROM mcp_servers s
      INNER JOIN profile_mcp_servers ps ON s.id = ps.server_id
      WHERE ps.profile_id = ?
      ORDER BY s.name ASC
    `).all(profileId) as MCPServerRow[]
    return rows.map(row => mapMCPServer(row, [profileId]))
  }

  // ── Dashboard Stats ────────────────────────────────────────────────

  getDashboardStats(): DashboardStats {
    const today = new Date().toISOString().split('T')[0]
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0]

    const todayRow = this.db.prepare(`
      SELECT COUNT(*) as runs, COALESCE(SUM(total_tokens), 0) as tokens, COALESCE(SUM(cost_usd), 0) as cost
      FROM usage_records WHERE created_at >= ?
    `).get(today) as { runs: number; tokens: number; cost: number }

    const weekRow = this.db.prepare(`
      SELECT COALESCE(SUM(cost_usd), 0) as cost FROM usage_records WHERE created_at >= ?
    `).get(weekAgo) as { cost: number }

    const wsCount = (this.db.prepare(
      'SELECT COUNT(*) as c FROM workspaces WHERE status = ?',
    ).get('active') as { c: number }).c

    // By profile (this week)
    const profileRows = this.db.prepare(`
      SELECT profile_id, COUNT(*) as runs, COALESCE(SUM(cost_usd), 0) as cost
      FROM usage_records WHERE created_at >= ?
      GROUP BY profile_id ORDER BY runs DESC
    `).all(weekAgo) as { profile_id: string; runs: number; cost: number }[]

    const totalRuns = profileRows.reduce((s, r) => s + r.runs, 0) || 1
    const byProfile: DashboardProfileEntry[] = profileRows.map(r => ({
      profileId: r.profile_id,
      runCount: r.runs,
      runPercent: Math.round((r.runs / totalRuns) * 100),
      weekCost: r.cost,
    }))

    // By workspace (this week) — INNER JOIN to skip orphaned threads
    const wsRows = this.db.prepare(`
      SELECT w.id as workspace_id, w.name, COUNT(DISTINCT t.id) as threads, COALESCE(SUM(u.cost_usd), 0) as cost
      FROM workspaces w
      INNER JOIN threads t ON t.workspace_id = w.id
      LEFT JOIN usage_records u ON u.thread_id = t.id AND u.created_at >= ?
      WHERE w.status = 'active'
      GROUP BY w.id ORDER BY threads DESC
    `).all(weekAgo) as { workspace_id: string; name: string; threads: number; cost: number }[]

    const byWorkspace: DashboardWorkspaceEntry[] = wsRows.map(r => ({
      workspaceId: r.workspace_id,
      workspaceName: r.name,
      threadCount: r.threads,
      weekCost: r.cost,
    }))

    return {
      activeAgents: 0, // filled by gateway from in-memory runtime state
      todayRuns: todayRow.runs,
      todayTokens: todayRow.tokens,
      todayCost: todayRow.cost,
      weekCost: weekRow.cost,
      workspaceCount: wsCount,
      byProfile,
      byWorkspace,
    }
  }

  // ── Dashboard time-series & KPI queries ────────────────────────────

  /**
   * Return daily usage buckets for the given range.
   * Days with no data are filled with zeros.
   */
  getUsageTimeSeries(range: DashboardRange = '7d'): UsageBucket[] {
    const { days, hours } = rangeToConfig(range)
    const now = new Date()

    if (hours !== null) {
      // Hourly buckets for 24h
      const cutoff = new Date(now.getTime() - hours * 3600 * 1000).toISOString()
      const dbRows = this.db.prepare(`
        SELECT strftime('%Y-%m-%dT%H:00:00', created_at) AS date,
               COALESCE(SUM(total_tokens), 0) AS tokens,
               COALESCE(SUM(cost_usd), 0)     AS cost,
               COUNT(*)                         AS runs
        FROM usage_records
        WHERE created_at >= ?
        GROUP BY strftime('%Y-%m-%dT%H', created_at)
        ORDER BY date ASC
      `).all(cutoff) as { date: string; tokens: number; cost: number; runs: number }[]

      const map = new Map(dbRows.map(r => [r.date.slice(0, 13), r]))
      const buckets: UsageBucket[] = []
      for (let h = hours - 1; h >= 0; h--) {
        const d = new Date(now.getTime() - h * 3600 * 1000)
        const key = d.toISOString().slice(0, 13)
        const label = `${d.toISOString().slice(0, 10)}T${d.toISOString().slice(11, 13)}:00:00`
        const row = map.get(key)
        buckets.push({ date: label, tokens: row?.tokens ?? 0, cost: row?.cost ?? 0, runs: row?.runs ?? 0 })
      }
      return buckets
    }

    // Daily buckets for multi-day ranges
    const cutoff = new Date(now.getTime() - days! * 86400 * 1000).toISOString().split('T')[0]!
    const dbRows = this.db.prepare(`
      SELECT strftime('%Y-%m-%d', created_at) AS date,
             COALESCE(SUM(total_tokens), 0) AS tokens,
             COALESCE(SUM(cost_usd), 0)     AS cost,
             COUNT(*)                         AS runs
      FROM usage_records
      WHERE date(created_at) >= ?
      GROUP BY strftime('%Y-%m-%d', created_at)
      ORDER BY date ASC
    `).all(cutoff) as { date: string; tokens: number; cost: number; runs: number }[]

    const map = new Map(dbRows.map(r => [r.date, r]))
    const buckets: UsageBucket[] = []
    for (let d = days! - 1; d >= 0; d--) {
      const day = new Date(now.getTime() - d * 86400 * 1000).toISOString().split('T')[0]!
      const row = map.get(day)
      buckets.push({ date: day, tokens: row?.tokens ?? 0, cost: row?.cost ?? 0, runs: row?.runs ?? 0 })
    }
    return buckets
  }

  /**
   * Return KPI cards (tokens, cost, runs, avg duration) with delta vs previous
   * period and 12-point sparklines.
   */
  getKPIs(range: DashboardRange = '7d'): DashboardKPIs {
    const { days, hours } = rangeToConfig(range)
    const periodMs = hours !== null ? hours * 3600 * 1000 : days! * 86400 * 1000
    const now = Date.now()
    const currentCutoff = new Date(now - periodMs).toISOString()
    const prevCutoff = new Date(now - periodMs * 2).toISOString()

    const current = this.db.prepare(`
      SELECT COALESCE(SUM(total_tokens), 0) AS tokens,
             COALESCE(SUM(cost_usd), 0)     AS cost,
             COUNT(*)                         AS runs,
             COALESCE(AVG(duration_ms), 0)   AS avg_duration
      FROM usage_records WHERE created_at >= ?
    `).get(currentCutoff) as { tokens: number; cost: number; runs: number; avg_duration: number }

    const previous = this.db.prepare(`
      SELECT COALESCE(SUM(total_tokens), 0) AS tokens,
             COALESCE(SUM(cost_usd), 0)     AS cost,
             COUNT(*)                         AS runs,
             COALESCE(AVG(duration_ms), 0)   AS avg_duration
      FROM usage_records WHERE created_at >= ? AND created_at < ?
    `).get(prevCutoff, currentCutoff) as { tokens: number; cost: number; runs: number; avg_duration: number }

    // 12-point sparkline — divide current range into 12 equal buckets
    const bucketMs = Math.floor(periodMs / 12)
    const sparklineRows = this.db.prepare(`
      SELECT created_at, total_tokens, cost_usd, duration_ms FROM usage_records WHERE created_at >= ?
    `).all(currentCutoff) as { created_at: string; total_tokens: number; cost_usd: number; duration_ms: number | null }[]

    const tokenSpark = new Array<number>(12).fill(0)
    const costSpark = new Array<number>(12).fill(0)
    const runSpark = new Array<number>(12).fill(0)
    const durationSums = new Array<number>(12).fill(0)
    const durationCounts = new Array<number>(12).fill(0)
    for (const row of sparklineRows) {
      const age = now - new Date(row.created_at).getTime()
      const idx = Math.min(11, Math.floor((periodMs - age) / bucketMs))
      if (idx >= 0) {
        tokenSpark[idx]! += row.total_tokens
        costSpark[idx]! += row.cost_usd
        runSpark[idx]! += 1
        if (row.duration_ms !== null) {
          durationSums[idx]! += row.duration_ms
          durationCounts[idx]! += 1
        }
      }
    }
    const durationSpark = durationSums.map((sum, i) =>
      durationCounts[i]! > 0 ? Math.round(sum / durationCounts[i]!) : 0
    )

    const pct = (curr: number, prev: number): number | null => {
      if (prev === 0) return null
      return Math.round(((curr - prev) / prev) * 100 * 10) / 10
    }

    const cards: DashboardKPICard[] = [
      { label: 'Tokens', value: current.tokens, unit: 'tokens', delta: pct(current.tokens, previous.tokens), sparkline: tokenSpark },
      { label: 'Cost', value: Math.round(current.cost * 10000) / 10000, unit: 'USD', delta: pct(current.cost, previous.cost), sparkline: costSpark },
      { label: 'Runs', value: current.runs, unit: 'runs', delta: pct(current.runs, previous.runs), sparkline: runSpark },
      { label: 'Avg Duration', value: Math.round(current.avg_duration), unit: 'ms', delta: pct(current.avg_duration, previous.avg_duration), sparkline: durationSpark },
    ]

    return { range, cards }
  }

  /** Per-profile aggregated stats including avg duration and success rate. */
  getProfileBreakdown(): ProfileBreakdownRow[] {
    const rows = this.db.prepare(`
      SELECT profile_id,
             COUNT(*)                                                       AS runs,
             COALESCE(SUM(total_tokens), 0)                                AS tokens,
             COALESCE(SUM(cost_usd), 0)                                    AS cost,
             AVG(CASE WHEN duration_ms IS NOT NULL THEN duration_ms END)   AS avg_duration,
             COALESCE(AVG(CASE WHEN success = 1 THEN 1.0 ELSE 0.0 END), 1) AS success_rate
      FROM usage_records
      GROUP BY profile_id
      ORDER BY runs DESC
    `).all() as {
      profile_id: string
      runs: number
      tokens: number
      cost: number
      avg_duration: number | null
      success_rate: number
    }[]

    return rows.map(r => ({
      profileId: r.profile_id,
      runs: r.runs,
      tokens: r.tokens,
      cost: r.cost,
      avgDurationMs: r.avg_duration !== null ? Math.round(r.avg_duration) : null,
      successRate: r.success_rate,
    }))
  }

  /** Return the most recent N usage records, ordered newest first. */
  getRecentActivity(limit: number = 20): RecentActivityRow[] {
    const rows = this.db.prepare(`
      SELECT id, profile_id, thread_id, model, total_tokens, cost_usd, duration_ms, success, created_at
      FROM usage_records
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit) as {
      id: string
      profile_id: string
      thread_id: string | null
      model: string
      total_tokens: number
      cost_usd: number
      duration_ms: number | null
      success: number
      created_at: string
    }[]

    return rows.map(r => ({
      id: r.id,
      profileId: r.profile_id,
      threadId: r.thread_id,
      model: r.model,
      totalTokens: r.total_tokens,
      costUsd: r.cost_usd,
      durationMs: r.duration_ms,
      success: r.success === 1,
      createdAt: r.created_at,
    }))
  }

  /**
   * Increment use_count and total_cost on profile_metadata for a given profile.
   * Upserts the row if it doesn't exist yet.
   */
  incrementProfileUsage(profileId: string, cost: number): void {
    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO profile_metadata (profile_id, use_count, total_cost, last_used_at, updated_at)
      VALUES (?, 1, ?, ?, ?)
      ON CONFLICT(profile_id) DO UPDATE SET
        use_count    = use_count + 1,
        total_cost   = total_cost + excluded.total_cost,
        last_used_at = excluded.last_used_at,
        updated_at   = excluded.updated_at
    `).run(profileId, cost, now, now)
  }

  // ── Local Profile CRUD ───────────────────────────────────────────────

  createLocalProfile(displayName: string, avatarUrl?: string): LocalProfile {
    const id = `lp_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO local_profile (id, display_name, avatar_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, displayName, avatarUrl ?? null, now, now)
    return { id, displayName, avatarUrl: avatarUrl ?? null, createdAt: now, updatedAt: now }
  }

  getLocalProfile(): LocalProfile | undefined {
    const row = this.db.prepare('SELECT * FROM local_profile LIMIT 1').get() as LocalProfileRow | undefined
    return row ? mapLocalProfile(row) : undefined
  }

  updateLocalProfile(id: string, updates: { displayName?: string; avatarUrl?: string | null }): LocalProfile | undefined {
    const row = this.db.prepare('SELECT * FROM local_profile WHERE id = ?').get(id) as LocalProfileRow | undefined
    if (!row) return undefined
    const now = new Date().toISOString()
    this.db.prepare(`
      UPDATE local_profile SET display_name = ?, avatar_url = ?, updated_at = ? WHERE id = ?
    `).run(
      updates.displayName ?? row.display_name,
      updates.avatarUrl !== undefined ? updates.avatarUrl : row.avatar_url,
      now, id,
    )
    return this.getLocalProfile()
  }

  // ── User Settings CRUD ─────────────────────────────────────────────

  getSetting(key: string): UserSettings | undefined {
    const row = this.db.prepare('SELECT * FROM user_settings WHERE key = ?').get(key) as SettingsRow | undefined
    return row ? mapSettings(row) : undefined
  }

  setSetting(key: string, value: string): UserSettings {
    const id = `set_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO user_settings (id, key, value, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(id, key, value, now)
    return this.getSetting(key)!
  }

  getAllSettings(): UserSettings[] {
    const rows = this.db.prepare('SELECT * FROM user_settings ORDER BY key ASC').all() as SettingsRow[]
    return rows.map(mapSettings)
  }

  deleteSetting(key: string): boolean {
    return this.db.prepare('DELETE FROM user_settings WHERE key = ?').run(key).changes > 0
  }

  // ── Profile Metadata CRUD ──────────────────────────────────────────

  getProfileMetadata(profileId: string): ProfileMetadata | undefined {
    const row = this.db.prepare('SELECT * FROM profile_metadata WHERE profile_id = ?').get(profileId) as ProfileMetadataRow | undefined
    return row ? mapProfileMetadata(row) : undefined
  }

  setProfileMetadata(profileId: string, updates: { icon?: string | null; color?: string | null; category?: string | null }): ProfileMetadata {
    const now = new Date().toISOString()
    const existing = this.getProfileMetadata(profileId)

    this.db.prepare(`
      INSERT INTO profile_metadata (profile_id, icon, color, category, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(profile_id) DO UPDATE SET
        icon = excluded.icon, color = excluded.color,
        category = excluded.category, updated_at = excluded.updated_at
    `).run(
      profileId,
      updates.icon !== undefined ? updates.icon : (existing?.icon ?? null),
      updates.color !== undefined ? updates.color : (existing?.color ?? null),
      updates.category !== undefined ? updates.category : (existing?.category ?? null),
      now,
    )

    return this.getProfileMetadata(profileId)!
  }

  listProfileMetadata(): ProfileMetadata[] {
    const rows = this.db.prepare('SELECT * FROM profile_metadata ORDER BY profile_id ASC').all() as ProfileMetadataRow[]
    return rows.map(mapProfileMetadata)
  }

  // ── Workspace Tabs CRUD ────────────────────────────────────────────

  // ── Workspace Panes CRUD ────────────────────────────────────────────
  //
  // The pane substrate (migration 024) supersedes workspace_tabs.
  // Every right-hand surface in a workspace — chat tabs, agent-opened
  // viewers, side-panel tools — is a typed pane row here. See
  // `gateway/types.ts` for wire types.
  //
  // Validation contract: `config` and `metadata` arrive pre-validated
  // (handler runs Zod before calling). The DB layer trusts them and
  // serializes verbatim to JSON. The denormalized columns (`pinned`,
  // `scoped_chat_id`, `opened_by`, `subagent_id`) are kept in sync
  // with `metadata_json` so partial unique indices and "show me sub-
  // agent's panes" queries stay efficient — the JSON remains the
  // source of truth for reads.

  /**
   * Create a workspace pane.
   *
   * Idempotent on chat panes: when `config.kind === 'chat'`, looks up
   * any existing pane in the same workspace pointing at the same
   * `config.threadId` and returns it (optionally focusing it). Mirrors
   * `createWorkspaceTab`'s reopen path so opening a chat from history
   * stays a single round-trip.
   *
   * Position defaults to end-of-zone. `focused` defaults to `true`
   * for `zone: 'tabs'` (matches today's open-tab UX) and `false` for
   * `zone: 'side'` (side panels are toggled, not auto-focused).
   * When focused, the prior focused pane in the same zone is cleared
   * in the same transaction so the partial unique index never fires.
   *
   * Title defaults to a kind-derived label when not supplied.
   */
  createWorkspacePane(
    workspaceId: string,
    pane: {
      readonly config: PaneConfig
      readonly metadata: PaneMetadata
      readonly zone: PaneZone
      readonly title?: string
      readonly position?: number
      readonly focused?: boolean
    },
  ): WorkspacePane {
    return this.db.transaction(() => {
      // Idempotency: chat panes are unique on (workspaceId, threadId).
      if (pane.config.kind === 'chat') {
        const existing = this.db.prepare(`
          SELECT * FROM workspace_panes
          WHERE workspace_id = ?
            AND kind = 'chat'
            AND json_extract(config_json, '$.threadId') = ?
        `).get(workspaceId, pane.config.threadId) as WorkspacePaneRow | undefined
        if (existing) {
          if (pane.focused === true) {
            this.focusWorkspacePaneUnsafe(
              workspaceId,
              existing.zone as PaneZone,
              existing.id,
            )
          }
          const refreshed = this.db.prepare(
            'SELECT * FROM workspace_panes WHERE id = ?',
          ).get(existing.id) as WorkspacePaneRow
          return mapWorkspacePane(refreshed)
        }
      }

      const id = `pane_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
      const now = new Date().toISOString()

      const position = pane.position ?? (
        (this.db.prepare(`
          SELECT COALESCE(MAX(position), -1) + 1 AS p
          FROM workspace_panes
          WHERE workspace_id = ? AND zone = ?
        `).get(workspaceId, pane.zone) as { p: number }).p
      )

      // New panes auto-focus by default in their zone (rip-dockview
      // Phase F). The pre-rip behaviour only auto-focused tabs-zone
      // panes — that aligned with Dockview's "active panel" being
      // independent from server focus, so side panes stayed
      // unfocused-on-create to avoid fighting the UI library. Post-
      // rip, the side panel is single-slot AND server-focus-driven:
      // the visible side pane is the focused one. Auto-focusing on
      // create means the agent's "open this for the user" intent
      // produces an immediate "the user sees it" result without any
      // extra round-trip. Callers that want the opposite pass
      // `focused: false` explicitly.
      const wantFocus = pane.focused ?? true
      if (wantFocus) {
        this.db.prepare(`
          UPDATE workspace_panes SET focused = 0
          WHERE workspace_id = ? AND zone = ? AND focused = 1
        `).run(workspaceId, pane.zone)
      }

      const title = pane.title ?? defaultPaneTitle(pane.config)

      this.db.prepare(`
        INSERT INTO workspace_panes (
          id, workspace_id, kind, zone, title,
          config_json, metadata_json,
          position, focused, pinned,
          scoped_chat_id, group_id,
          opened_by, subagent_id, opened_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, workspaceId, pane.config.kind, pane.zone, title,
        JSON.stringify(pane.config),
        JSON.stringify(pane.metadata),
        position,
        wantFocus ? 1 : 0,
        pane.metadata.pinned ? 1 : 0,
        pane.metadata.scopedToChatId ?? null,
        null,
        pane.metadata.openedBy,
        pane.metadata.subagentId ?? null,
        now,
      )

      const inserted = this.db.prepare(
        'SELECT * FROM workspace_panes WHERE id = ?',
      ).get(id) as WorkspacePaneRow
      return mapWorkspacePane(inserted)
    })()
  }

  /** Ordered by zone then position. */
  getWorkspacePanes(workspaceId: string): WorkspacePane[] {
    const rows = this.db.prepare(`
      SELECT * FROM workspace_panes
      WHERE workspace_id = ?
      ORDER BY zone ASC, position ASC
    `).all(workspaceId) as WorkspacePaneRow[]
    return rows.map(mapWorkspacePane)
  }

  getWorkspacePane(paneId: string): WorkspacePane | undefined {
    const row = this.db.prepare(
      'SELECT * FROM workspace_panes WHERE id = ?',
    ).get(paneId) as WorkspacePaneRow | undefined
    return row ? mapWorkspacePane(row) : undefined
  }

  /**
   * Patch a pane.
   *
   * `config` / `metadata` are REPLACEMENT — caller (handler) reads
   * current and merges any wire-side partial before calling. Focus
   * changes go through {@link focusWorkspacePane}; pass `null` to
   * `scopedChatId` or `groupId` to clear them.
   *
   * When `metadata` is replaced, the denormalized columns
   * (`pinned` / `scoped_chat_id` / `opened_by` / `subagent_id`) are
   * recomputed from the new metadata so indices stay accurate.
   */
  updateWorkspacePane(
    paneId: string,
    updates: {
      readonly title?: string
      readonly position?: number
      readonly pinned?: boolean
      readonly scopedChatId?: string | null
      readonly groupId?: string | null
      readonly config?: PaneConfig
      readonly metadata?: PaneMetadata
    },
  ): WorkspacePane | undefined {
    return this.db.transaction(() => {
      const row = this.db.prepare(
        'SELECT * FROM workspace_panes WHERE id = ?',
      ).get(paneId) as WorkspacePaneRow | undefined
      if (!row) return undefined

      const newConfig = updates.config
      const newConfigJson = newConfig !== undefined
        ? JSON.stringify(newConfig)
        : row.config_json
      const newKind = newConfig?.kind ?? row.kind

      const newMetadata = updates.metadata ?? null
      const newMetadataJson = newMetadata !== null
        ? JSON.stringify(newMetadata)
        : row.metadata_json

      // Denormalized columns: derive from new metadata when supplied,
      // otherwise honour explicit per-field overrides
      // (`pinned`/`scopedChatId`), otherwise keep current.
      const newPinned = newMetadata?.pinned
        ?? updates.pinned
        ?? (row.pinned === 1)
      const newScopedChat = newMetadata !== null
        ? (newMetadata.scopedToChatId ?? null)
        : (updates.scopedChatId !== undefined
            ? updates.scopedChatId
            : row.scoped_chat_id)
      const newOpenedBy = newMetadata?.openedBy ?? row.opened_by
      const newSubagent = newMetadata !== null
        ? (newMetadata.subagentId ?? null)
        : row.subagent_id
      const newGroupId = updates.groupId !== undefined
        ? updates.groupId
        : row.group_id

      this.db.prepare(`
        UPDATE workspace_panes
        SET title = ?, position = ?, kind = ?,
            config_json = ?, metadata_json = ?,
            pinned = ?, scoped_chat_id = ?, group_id = ?,
            opened_by = ?, subagent_id = ?
        WHERE id = ?
      `).run(
        updates.title ?? row.title,
        updates.position ?? row.position,
        newKind,
        newConfigJson,
        newMetadataJson,
        newPinned ? 1 : 0,
        newScopedChat,
        newGroupId,
        newOpenedBy,
        newSubagent,
        paneId,
      )

      const updated = this.db.prepare(
        'SELECT * FROM workspace_panes WHERE id = ?',
      ).get(paneId) as WorkspacePaneRow
      return mapWorkspacePane(updated)
    })()
  }

  /**
   * Make a pane the focused one in its zone. Transactional so the
   * `idx_workspace_panes_one_focused` partial unique index can never
   * catch two rows.
   */
  focusWorkspacePane(paneId: string): WorkspacePane | undefined {
    return this.db.transaction(() => {
      const row = this.db.prepare(
        'SELECT * FROM workspace_panes WHERE id = ?',
      ).get(paneId) as WorkspacePaneRow | undefined
      if (!row) return undefined
      this.focusWorkspacePaneUnsafe(row.workspace_id, row.zone as PaneZone, paneId)
      const updated = this.db.prepare(
        'SELECT * FROM workspace_panes WHERE id = ?',
      ).get(paneId) as WorkspacePaneRow
      return mapWorkspacePane(updated)
    })()
  }

  /**
   * Inner focus helper — assumes a surrounding transaction. Never
   * call from outside this class.
   */
  private focusWorkspacePaneUnsafe(
    workspaceId: string,
    zone: PaneZone,
    paneId: string,
  ): void {
    this.db.prepare(`
      UPDATE workspace_panes SET focused = 0
      WHERE workspace_id = ? AND zone = ? AND focused = 1 AND id != ?
    `).run(workspaceId, zone, paneId)
    this.db.prepare(
      'UPDATE workspace_panes SET focused = 1 WHERE id = ?',
    ).run(paneId)
  }

  /**
   * Reorder panes within a zone. All `ids` must belong to
   * (workspaceId, zone) — validated before any mutation. Positions
   * are assigned `0..ids.length - 1` in the order given.
   *
   * Throws on any unknown / mismatched id so caller bugs surface
   * loudly instead of silently corrupting layout.
   */
  reorderWorkspacePanes(
    workspaceId: string,
    zone: PaneZone,
    ids: readonly string[],
  ): WorkspacePane[] {
    return this.db.transaction(() => {
      if (ids.length === 0) {
        const rows = this.db.prepare(`
          SELECT * FROM workspace_panes
          WHERE workspace_id = ? AND zone = ?
          ORDER BY position ASC
        `).all(workspaceId, zone) as WorkspacePaneRow[]
        return rows.map(mapWorkspacePane)
      }

      const placeholders = ids.map(() => '?').join(',')
      const found = this.db.prepare(`
        SELECT id FROM workspace_panes
        WHERE workspace_id = ? AND zone = ? AND id IN (${placeholders})
      `).all(workspaceId, zone, ...ids) as { id: string }[]
      if (found.length !== ids.length) {
        const known = new Set(found.map((r) => r.id))
        const missing = ids.filter((id) => !known.has(id))
        throw new Error(
          `reorderWorkspacePanes: pane id(s) not in (workspaceId=${workspaceId}, zone=${zone}): ${missing.join(', ')}`,
        )
      }

      ids.forEach((id, i) => {
        this.db.prepare(
          'UPDATE workspace_panes SET position = ? WHERE id = ?',
        ).run(i, id)
      })

      const rows = this.db.prepare(`
        SELECT * FROM workspace_panes
        WHERE workspace_id = ? AND zone = ?
        ORDER BY position ASC
      `).all(workspaceId, zone) as WorkspacePaneRow[]
      return rows.map(mapWorkspacePane)
    })()
  }

  /**
   * Close a pane.
   *
   * If it was focused, picks a neighbour in the same zone (next
   * higher position, or previous if it was the last) and focuses it.
   * Position values in the affected zone are re-normalised to stay
   * contiguous.
   *
   * Returns metadata about the close so callers update UI without an
   * extra round-trip.
   */
  deleteWorkspacePane(paneId: string): {
    readonly closed: boolean
    readonly workspaceId: string | null
    readonly zone: PaneZone | null
    readonly nextFocusedPaneId: string | null
  } {
    return this.db.transaction(() => {
      const row = this.db.prepare(
        'SELECT * FROM workspace_panes WHERE id = ?',
      ).get(paneId) as WorkspacePaneRow | undefined
      if (!row) {
        return { closed: false, workspaceId: null, zone: null, nextFocusedPaneId: null }
      }

      const wasFocused = row.focused === 1
      const workspaceId = row.workspace_id
      const zone = row.zone as PaneZone
      const position = row.position
      const isChat = row.kind === 'chat'

      // Cascade — when the deleted pane is a chat pane, every pane in
      // this workspace that scopes to it (metadata.scopedToChatId =
      // paneId) is conceptually a child of this conversation's session
      // and must die with it. Leaving orphans would let agent-opened
      // viewers from a closed conversation leak into other tabs once
      // someone re-pointed `scoped_chat_id` (impossible today) or
      // re-used the same paneId (also impossible — random hex). The
      // strict cascade matters more for the gateway state machine: the
      // child rows still satisfy every NOT NULL constraint after the
      // parent disappears, so without an explicit cascade they'd just
      // sit there forever as un-reachable rows. Wave 3b of the
      // workspace-tab-architecture work.
      const cascadedRows: ReadonlyArray<{ id: string; zone: string; focused: number }> = isChat
        ? (this.db.prepare(
            'SELECT id, zone, focused FROM workspace_panes WHERE workspace_id = ? AND scoped_chat_id = ?',
          ).all(workspaceId, paneId) as Array<{ id: string; zone: string; focused: number }>)
        : []

      // Pick the neighbour BEFORE any deletes so the original
      // position-proximity rule works against the un-mutated row set.
      // Exclude the pane we're closing AND every cascade victim so we
      // never refocus onto a row that's about to disappear.
      const excludeIds = [paneId, ...cascadedRows.map((r) => r.id)]
      const excludePlaceholders = excludeIds.map(() => '?').join(',')
      const neighbour = wasFocused
        ? (this.db.prepare(`
            SELECT id FROM workspace_panes
            WHERE workspace_id = ? AND zone = ?
              AND id NOT IN (${excludePlaceholders})
            ORDER BY
              CASE WHEN position >= ? THEN 0 ELSE 1 END,
              CASE WHEN position >= ? THEN position ELSE -position END
            LIMIT 1
          `).get(workspaceId, zone, ...excludeIds, position, position) as { id: string } | undefined)
        : undefined

      // Execute deletes — cascade first, then the target.
      if (cascadedRows.length > 0) {
        this.db.prepare(
          'DELETE FROM workspace_panes WHERE workspace_id = ? AND scoped_chat_id = ?',
        ).run(workspaceId, paneId)
      }
      this.db.prepare('DELETE FROM workspace_panes WHERE id = ?').run(paneId)

      // Repack positions in every zone we removed rows from. The
      // pre-cascade code path used a `position - 1` shift that assumed
      // exactly one row removed per zone; with cascade the side zone
      // can drop multiple rows at once, so a full repack is the
      // correct, kind-agnostic primitive. The repack is idempotent
      // even when only one row was removed (the simple case).
      const affectedZones = new Set<PaneZone>([zone])
      for (const r of cascadedRows) affectedZones.add(r.zone as PaneZone)
      const selectInZone = this.db.prepare(
        'SELECT id FROM workspace_panes WHERE workspace_id = ? AND zone = ? ORDER BY position ASC',
      )
      const setPosition = this.db.prepare(
        'UPDATE workspace_panes SET position = ? WHERE id = ?',
      )
      for (const z of affectedZones) {
        const remaining = selectInZone.all(workspaceId, z) as Array<{ id: string }>
        for (let i = 0; i < remaining.length; i += 1) {
          setPosition.run(i, remaining[i]!.id)
        }
      }

      // Refocus the main pane's zone to the pre-picked neighbour.
      let nextFocusedPaneId: string | null = null
      if (wasFocused && neighbour !== undefined) {
        this.focusWorkspacePaneUnsafe(workspaceId, zone, neighbour.id)
        nextFocusedPaneId = neighbour.id
      }

      // Cascaded zones whose focused row got deleted need a
      // replacement focus, otherwise the partial unique index leaves
      // the zone with no focused pane and the side-panel picker has
      // nothing to select. Pick the first remaining row in the zone.
      for (const r of cascadedRows) {
        if (r.focused !== 1) continue
        const rzone = r.zone as PaneZone
        if (rzone === zone) continue // already handled by main-pane block
        const stillFocused = this.db.prepare(
          'SELECT 1 FROM workspace_panes WHERE workspace_id = ? AND zone = ? AND focused = 1',
        ).get(workspaceId, rzone)
        if (stillFocused) continue
        const fallback = this.db.prepare(
          'SELECT id FROM workspace_panes WHERE workspace_id = ? AND zone = ? ORDER BY position ASC LIMIT 1',
        ).get(workspaceId, rzone) as { id: string } | undefined
        if (fallback !== undefined) {
          this.focusWorkspacePaneUnsafe(workspaceId, rzone, fallback.id)
        }
      }

      return { closed: true, workspaceId, zone, nextFocusedPaneId }
    })()
  }

  // ── Workspace pane layout (Dockview serialized JSON) ───────────────

  /**
   * Read the Dockview-serialized layout for a workspace's tabs zone.
   * Returns `null` when no layout has been stored yet.
   */
  getWorkspacePaneLayout(workspaceId: string): string | null {
    const row = this.getAppState(workspacePaneLayoutKey(workspaceId))
    return row?.value ?? null
  }

  /**
   * Persist the Dockview-serialized layout for a workspace's tabs
   * zone. Opaque to the gateway — Dockview owns the format.
   */
  setWorkspacePaneLayout(workspaceId: string, layout: string): void {
    this.setAppState(workspacePaneLayoutKey(workspaceId), layout)
  }

  /**
   * Read the user-chosen side-track width (px) for a workspace, set
   * via the `<WorkspaceShellSplitter>` drag handle. Returns `null`
   * when the user hasn't dragged it — the client falls back to the
   * computed `columnCount * 560` formula in that case.
   *
   * Stored as a string in `app_state` (same KV the layout uses),
   * parsed on read. Invalid stored values surface as `null` rather
   * than throw — the worst case is the user re-drags.
   */
  getWorkspaceSideTrackWidth(workspaceId: string): number | null {
    const row = this.getAppState(workspaceSideTrackWidthKey(workspaceId))
    if (row === undefined) return null
    const parsed = Number.parseInt(row.value, 10)
    if (!Number.isFinite(parsed) || parsed <= 0) return null
    return parsed
  }

  /**
   * Persist the user-chosen side-track width. The validator at the
   * wire boundary clamps to `[1, 5000]`; this method trusts that.
   */
  setWorkspaceSideTrackWidth(workspaceId: string, widthPx: number): void {
    this.setAppState(workspaceSideTrackWidthKey(workspaceId), String(widthPx))
  }

  /**
   * History: every thread in a workspace, plus a `hasOpenTab` flag
   * so the drawer can render "Reopen" vs "Focus" affordances.
   */
  listWorkspaceHistory(
    workspaceId: string,
    opts?: { search?: string; limit?: number; offset?: number },
  ): {
    items: Array<Thread & { hasOpenTab: boolean; openTabId: string | null }>
    total: number
  } {
    const limit = Math.min(opts?.limit ?? 50, 200)
    const offset = opts?.offset ?? 0
    const search = opts?.search?.trim()

    const hasSearch = search !== undefined && search.length > 0
    const likeParam = hasSearch ? `%${search.toLowerCase()}%` : null

    const whereParts = [
      't.workspace_id = ?',
    ]
    const whereArgs: unknown[] = [workspaceId]
    if (hasSearch) {
      whereParts.push("(LOWER(COALESCE(t.title, '')) LIKE ? OR LOWER(COALESCE(t.last_message_preview, '')) LIKE ?)")
      whereArgs.push(likeParam, likeParam)
    }
    const whereClause = whereParts.join(' AND ')

    const total = (this.db.prepare(
      `SELECT COUNT(*) as c FROM threads t WHERE ${whereClause}`,
    ).get(...whereArgs) as { c: number }).c

    // Wave 1b.9: workspace_tabs is gone. The "is this thread already
    // open" check now reads the canonical pane store: a chat-kind
    // pane in the tabs zone whose config.threadId matches. We expose
    // the resulting pane id as `open_tab_id` to keep the wire field
    // name backwards-compatible — the JSON shape of WorkspaceHistoryEntry
    // doesn't change. The client only reads `hasOpenTab` in the JSX; the
    // id is informational.
    const rows = this.db.prepare(`
      SELECT t.*, wp.id AS open_tab_id
      FROM threads t
      LEFT JOIN workspace_panes wp
        ON wp.workspace_id = t.workspace_id
       AND wp.kind = 'chat'
       AND json_extract(wp.config_json, '$.threadId') = t.id
      WHERE ${whereClause}
      ORDER BY t.updated_at DESC
      LIMIT ? OFFSET ?
    `).all(...whereArgs, limit, offset) as Array<ThreadRow & { open_tab_id: string | null }>

    const items = rows.map(row => ({
      ...mapThread(row),
      hasOpenTab: row.open_tab_id !== null,
      openTabId: row.open_tab_id,
    }))
    return { items, total }
  }

  // ── App State CRUD ─────────────────────────────────────────────────

  getAppState(key: string): AppState | undefined {
    const row = this.db.prepare('SELECT * FROM app_state WHERE key = ?').get(key) as AppStateRow | undefined
    return row ? mapAppState(row) : undefined
  }

  setAppState(key: string, value: string): AppState {
    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO app_state (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, value, now)
    return this.getAppState(key)!
  }

  deleteAppState(key: string): boolean {
    return this.db.prepare('DELETE FROM app_state WHERE key = ?').run(key).changes > 0
  }

  // ── Audit Log ──────────────────────────────────────────────────────

  addAuditLog(entry: { action: string; entityType: string; entityId?: string; detail?: string; ipAddress?: string }): AuditLogEntry {
    const id = `audit_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO audit_log (id, action, entity_type, entity_id, detail, ip_address, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, entry.action, entry.entityType, entry.entityId ?? null, entry.detail ?? null, entry.ipAddress ?? null, now)

    return { id, action: entry.action, entityType: entry.entityType, entityId: entry.entityId ?? null, detail: entry.detail ?? null, ipAddress: entry.ipAddress ?? null, createdAt: now }
  }

  listAuditLog(limit: number = 100): AuditLogEntry[] {
    const rows = this.db.prepare(
      'SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?',
    ).all(limit) as AuditLogRow[]
    return rows.map(mapAuditLog)
  }

  // ── Storage stats ───────────────────────────────────────────────────

  getStorageStats(): { threadCount: number; messageCount: number; usageRecordCount: number } {
    const threads = (this.db.prepare('SELECT COUNT(*) as c FROM threads').get() as { c: number }).c
    const messages = (this.db.prepare('SELECT COUNT(*) as c FROM messages').get() as { c: number }).c
    const usage = (this.db.prepare('SELECT COUNT(*) as c FROM usage_records').get() as { c: number }).c
    return { threadCount: threads, messageCount: messages, usageRecordCount: usage }
  }

  /** Get the database file path for size stats. */
  get dbPath(): string {
    return this.db.name
  }

  /**
   * Escape-hatch accessor for the raw main-db handle.
   *
   * The connector module attaches its own table-specific stores
   * (`connector_connections`, future vendor catalogues we own). Each
   * store encapsulates CRUD for its table and
   * accepts a `Database.Database` handle so it can be unit-tested
   * against a fresh temp db without needing the full `CortexDatabase`.
   *
   * Not intended for general use — callers that want thread/workspace/
   * MCP state go through the named methods above. This is the single
   * documented seam for "I own my own table and need the handle".
   */
  get rawMainHandle(): Database.Database {
    return this.db
  }

  /** Export all user data for data portability. */
  exportAllData(): {
    threads: Thread[]
    messages: Record<string, ThreadMessage[]>
    workspaces: Workspace[]
    settings: UserSettings[]
    usage: { totalTokens: number; totalCost: number; recordCount: number }
  } {
    const threads = (this.db.prepare('SELECT * FROM threads ORDER BY created_at DESC').all() as ThreadRow[]).map(mapThread)

    const messages: Record<string, ThreadMessage[]> = {}
    for (const thread of threads) {
      messages[thread.id] = this.getMessages(thread.id)
    }

    const workspaces = (this.db.prepare('SELECT * FROM workspaces ORDER BY created_at DESC').all() as WorkspaceRow[]).map(mapWorkspace)

    let settings: UserSettings[] = []
    try {
      settings = this.getAllSettings()
    } catch {
      // Settings table may not exist in older DBs
    }

    const usageSummary = this.getUsageSummary()

    return {
      threads,
      messages,
      workspaces,
      settings,
      usage: {
        totalTokens: usageSummary.totalTokens,
        totalCost: usageSummary.totalCost,
        recordCount: usageSummary.requestCount,
      },
    }
  }

  // ── Utility ──────────────────────────────────────────────────────────

  get threadCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM threads').get() as { count: number }
    return row.count
  }

  // ── Designs (Ownware Design — per-design metadata) ─────────────────
  //
  // Slice 7a (2026-05-24). New tables `designs` + `thread_designs`
  // (migration 033). Per root CLAUDE.md Principle 22 (new concerns get
  // new verticals): these are Design-PRODUCT-scoped, NOT generic
  // "child_workspaces." Threads table untouched. Coder never queries
  // these.

  createDesign(
    workspaceId: string,
    slug: string,
    kind: Design['kind'],
    opts?: {
      readonly name?: string | undefined
      readonly templateSource?: string | undefined
    },
  ): Design {
    const id = `dsn_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
    const now = new Date().toISOString()
    const name = opts?.name ?? null
    const templateSource = opts?.templateSource ?? null
    this.db.prepare(`
      INSERT INTO designs (id, workspace_id, slug, kind, name, template_source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, workspaceId, slug, kind, name, templateSource, now, now)
    return { id, workspaceId, slug, kind, name, templateSource, createdAt: now, updatedAt: now }
  }

  getDesign(id: string): Design | undefined {
    const row = this.db.prepare('SELECT * FROM designs WHERE id = ?').get(id) as DesignRow | undefined
    return row ? mapDesign(row) : undefined
  }

  /**
   * Update a design's mutable fields. Returns the updated row, or
   * `undefined` if the design id doesn't exist.
   *
   * Slug renames are slice B1.6 (2026-05-27). When `slug` changes, the
   * design's workspace row also has its `path` rewritten to the new
   * slug folder in the same transaction — the (design row + workspace
   * row) pair stays consistent without a half-committed gap.
   *
   * Filesystem-side `fs.rename` is the caller's responsibility (the
   * handler). DB and FS cannot share a single atomic boundary, so the
   * handler does FS-first → DB-second + a best-effort FS-rollback if
   * the DB write throws. See `gateway/handlers/designs.ts`.
   */
  updateDesign(
    id: string,
    updates: {
      readonly name?: string | null
      readonly slug?: string
      /** New absolute workspace path. Required when slug changes;
       *  ignored otherwise. The caller computes this from
       *  `buildDesignFolderPath(parentPath, newSlug)` so the slug ↔
       *  path invariant stays in one place. */
      readonly newWorkspacePath?: string
      /** Canvas kind switch — metadata-only column update; agent
       *  re-reads `<design-metadata>.kind` from the systemPromptAppend
       *  on the next turn. Slice B1.7 (2026-05-27). */
      readonly kind?: Design['kind']
      /** Template switch — metadata-only column update;
       *  `useSendDesignMessage` re-reads `design.templateSource` on
       *  next turn and re-bakes `<template-reference>`. `null` clears
       *  the pin. Slice B1.9 (2026-05-27). */
      readonly templateSource?: string | null
    },
  ): Design | undefined {
    const existing = this.getDesign(id)
    if (!existing) return undefined
    const now = new Date().toISOString()

    const txn = this.db.transaction(() => {
      const nextName =
        updates.name === undefined ? existing.name : updates.name
      const nextSlug = updates.slug ?? existing.slug
      const nextKind = updates.kind ?? existing.kind
      const nextTemplateSource =
        updates.templateSource === undefined
          ? existing.templateSource
          : updates.templateSource

      this.db.prepare(`
        UPDATE designs SET name = ?, slug = ?, kind = ?, template_source = ?, updated_at = ?
        WHERE id = ?
      `).run(nextName, nextSlug, nextKind, nextTemplateSource, now, id)

      if (
        updates.slug !== undefined &&
        updates.slug !== existing.slug &&
        updates.newWorkspacePath !== undefined
      ) {
        this.db.prepare(`
          UPDATE workspaces SET path = ?, updated_at = ?
          WHERE id = ?
        `).run(updates.newWorkspacePath, now, existing.workspaceId)
      }
    })
    txn()

    return this.getDesign(id)
  }

  getDesignBySlug(workspaceId: string, slug: string): Design | undefined {
    const row = this.db
      .prepare('SELECT * FROM designs WHERE workspace_id = ? AND slug = ?')
      .get(workspaceId, slug) as DesignRow | undefined
    return row ? mapDesign(row) : undefined
  }

  /** Designs that live under the given parent workspace, newest-updated
   *  first.
   *
   *  Each design has its OWN cortex workspace at
   *  `<parent.path>/.ownware/app/ownware-design/<slug>/` (D-A16), and the
   *  design row's `workspace_id` points at THAT per-design folder
   *  workspace — never the parent. (Pointing it at the parent makes every
   *  design-file endpoint walk the parent and leak every sibling design's
   *  files plus the parent project's own files.) So "designs in a
   *  workspace" means "designs whose folder workspace path is nested under
   *  the parent's path." We match on the path-nesting convention rather
   *  than a stored parent id, so no schema column is needed; the same
   *  nesting convention already powers the sidebar's `isHiddenWorkspacePath`
   *  filter. Designs created before this fix (whose `workspace_id` was the
   *  parent, so their path is NOT nested) no longer list here — that's
   *  intended; those rows were the leak. */
  listDesignsForWorkspace(workspaceId: string): readonly Design[] {
    const parent = this.db
      .prepare('SELECT path FROM workspaces WHERE id = ?')
      .get(workspaceId) as { path: string } | undefined
    if (!parent) return []
    // Escape LIKE metacharacters so a literal '%' or '_' in a folder
    // name can't widen the match. Trailing '/%' keeps the parent itself
    // (exact path) out of its own design list.
    const prefix = parent.path.replace(/[\\%_]/g, (c) => `\\${c}`) + '/%'
    const rows = this.db
      .prepare(
        `SELECT d.* FROM designs d
         JOIN workspaces w ON w.id = d.workspace_id
         WHERE w.path LIKE ? ESCAPE '\\'
         ORDER BY d.updated_at DESC`,
      )
      .all(prefix) as DesignRow[]
    return rows.map(mapDesign)
  }

  /** Bind a thread to a design. Idempotent — re-binding the same thread
   *  to the same design is a no-op; re-binding to a different design
   *  replaces the link (PRIMARY KEY on thread_id enforces one design per
   *  thread). Throws if either id doesn't exist (FK violation). */
  linkThreadToDesign(threadId: string, designId: string): void {
    this.db.prepare(`
      INSERT INTO thread_designs (thread_id, design_id, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT (thread_id) DO UPDATE SET
        design_id = excluded.design_id,
        created_at = excluded.created_at
    `).run(threadId, designId, new Date().toISOString())
  }

  /** Resolve the design (if any) that a thread belongs to. Returns
   *  undefined when the thread is not linked to a design (e.g. Coder
   *  threads, which never link). */
  getDesignForThread(threadId: string): Design | undefined {
    const row = this.db.prepare(`
      SELECT d.*
      FROM designs d
      JOIN thread_designs td ON td.design_id = d.id
      WHERE td.thread_id = ?
    `).get(threadId) as DesignRow | undefined
    return row ? mapDesign(row) : undefined
  }

  /** Resolve the threads linked to a design, most-recent-first. Used
   *  by the chip switcher (`GET /api/v1/designs/:designId/thread`) to
   *  pick a thread to navigate to when the user picks a different
   *  design from the dropdown. A single design can host multiple
   *  threads (no UNIQUE on `design_id`); the most-recently-linked
   *  thread is the natural "active" one for switching. Returns the
   *  thread IDs only — callers don't need the join rows. */
  getThreadsForDesign(designId: string): readonly string[] {
    const rows = this.db
      .prepare(
        `SELECT thread_id FROM thread_designs
         WHERE design_id = ?
         ORDER BY created_at DESC`,
      )
      .all(designId) as ReadonlyArray<{ thread_id: string }>
    return rows.map((r) => r.thread_id)
  }

  /** Unbind a thread from its design (if any). Idempotent — returns
   *  false if there was nothing to unlink. */
  unlinkThreadFromDesign(threadId: string): boolean {
    const res = this.db
      .prepare('DELETE FROM thread_designs WHERE thread_id = ?')
      .run(threadId)
    return res.changes > 0
  }

  /** Bind a Builder thread to the agent (slug) it is editing — the durable
   *  half of edit-by-talking (mirrors linkThreadToDesign). ON CONFLICT
   *  replaces (PRIMARY KEY on thread_id → one edited agent per thread).
   *  `profileSlug` is the registry key, NOT a FK (profiles live on disk). The
   *  client re-injects the edit context per turn from this binding; cortex
   *  just stores it (product-agnostic passthrough). */
  linkThreadToEdit(threadId: string, profileSlug: string): void {
    this.db.prepare(`
      INSERT INTO thread_edits (thread_id, profile_slug, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT (thread_id) DO UPDATE SET
        profile_slug = excluded.profile_slug,
        created_at = excluded.created_at
    `).run(threadId, profileSlug, new Date().toISOString())
  }

  /** Resolve the agent slug a Builder thread is editing, or undefined when the
   *  thread isn't an edit thread. The client reads this on reopen to re-enter
   *  edit mode + keep re-injecting the binding context. */
  getEditForThread(threadId: string): string | undefined {
    const row = this.db
      .prepare('SELECT profile_slug FROM thread_edits WHERE thread_id = ?')
      .get(threadId) as { profile_slug: string } | undefined
    return row?.profile_slug
  }

  /** Thread ids that have edited this agent (slug), most-recently-bound first.
   *  An agent can have many edit conversations over time; this backs the edit
   *  thread switcher + resume-latest. Mirrors getThreadsForDesign. */
  getThreadsForEdit(profileSlug: string): readonly string[] {
    const rows = this.db
      .prepare(
        `SELECT thread_id FROM thread_edits
         WHERE profile_slug = ?
         ORDER BY created_at DESC`,
      )
      .all(profileSlug) as ReadonlyArray<{ thread_id: string }>
    return rows.map((r) => r.thread_id)
  }

  /** Delete a design and cascade to its thread_designs links. The
   *  underlying threads themselves are NOT touched (they keep their
   *  conversation history; they just lose their design link). */
  deleteDesign(id: string): boolean {
    const res = this.db.prepare('DELETE FROM designs WHERE id = ?').run(id)
    return res.changes > 0
  }

  close(): void {
    this.db.close()
  }
}

// ---------------------------------------------------------------------------
// Row types (raw SQLite rows)
// ---------------------------------------------------------------------------

interface ThreadRow {
  id: string
  profile_id: string
  workspace_id: string | null
  title: string | null
  status: string
  message_count: number
  total_tokens: number
  total_cost: number
  model: string | null
  pinned: number
  metadata: string | null
  last_message_preview: string | null
  created_at: string
  updated_at: string
}

interface LocalProfileRow {
  id: string
  display_name: string
  avatar_url: string | null
  created_at: string
  updated_at: string
}

interface SettingsRow {
  id: string
  key: string
  value: string
  updated_at: string
}

interface ProfileMetadataRow {
  profile_id: string
  icon: string | null
  color: string | null
  category: string | null
  // Added by migration 5
  use_count?: number
  total_cost?: number
  last_used_at?: string | null
  updated_at: string
}

interface WorkspacePaneRow {
  id: string
  workspace_id: string
  kind: string
  zone: string
  title: string
  config_json: string
  metadata_json: string
  position: number
  focused: number
  pinned: number
  scoped_chat_id: string | null
  group_id: string | null
  opened_by: string
  subagent_id: string | null
  opened_at: string
}

interface AppStateRow {
  key: string
  value: string
  updated_at: string
}

interface AuditLogRow {
  id: string
  action: string
  entity_type: string
  entity_id: string | null
  detail: string | null
  ip_address: string | null
  created_at: string
}

interface WorkspaceRow {
  id: string
  name: string
  path: string
  status: string
  last_profile_id: string | null
  pinned: number
  metadata: string | null
  /**
   * JSON-encoded string[] of product slugs enabled in this workspace
   * (migration 032). NOT NULL with a server default of '["ownware"]'
   * — legacy rows backfill at ADD COLUMN time. Parsed via
   * `parseActiveProducts` to a `readonly string[]`; never narrowed
   * against a closed enum (see D-36).
   */
  active_products: string
  last_opened_at: string
  created_at: string
  updated_at: string
}

interface MCPServerRow {
  id: string
  name: string
  transport: string
  url: string | null
  command: string | null
  args: string | null
  /** JSON-encoded Record<string,string> of declared env names (stdio). */
  env: string | null
  headers: string | null
  registry_id: string | null
  tool_count: number | null
  tools_json: string | null
  status: string
  error: string | null
  created_at: string
  updated_at: string
}

interface MessageRow {
  id: string
  thread_id: string
  role: string
  content: string
  tools: string | null
  sub_agents: string | null
  permissions: string | null
  attachments: string | null
  thinking: string | null
  usage_input: number | null
  usage_output: number | null
  /**
   * Cached-prefix tokens reported by the model for this turn (migration 027).
   * Anthropic returns this as `cache_read_input_tokens`; OpenAI returns it
   * as `prompt_tokens_details.cached_tokens`. The client's context-fill
   * indicator sums it back into `inputTokens` because the model's context
   * window is filled by ALL processed tokens, not just the cache-miss
   * portion. NULL for pre-027 rows and roles that have no model usage.
   */
  usage_cache_read: number | null
  /**
   * Cache-write tokens reported by the model (Anthropic only; OpenAI does
   * not bill cache writes separately and reports 0). Migration 027.
   */
  usage_cache_creation: number | null
  created_at: string
  /**
   * Canonical model id that produced this row (assistant turns) —
   * `null` for user / system / pre-migration-020 rows. Frozen at
   * INSERT; never UPDATEd. See migration 020 docstring for invariants.
   */
  model: string | null
  /**
   * Ordered turn timeline (JSON-encoded MessagePart[]) — null for rows
   * written before migration 012, and intentionally null for roles that
   * don't need a timeline (user/system/error).
   */
  parts: string | null
  /**
   * JSON-encoded CredentialRecord[] — null for rows written before
   * migration 013 and for assistant turns that emitted no credential
   * HITL. Nullable to match `permissions` / `sub_agents`.
   */
  credentials: string | null
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

function mapThread(row: ThreadRow): Thread {
  return {
    id: row.id,
    profileId: row.profile_id,
    workspaceId: row.workspace_id,
    title: row.title,
    status: row.status as Thread['status'],
    messageCount: row.message_count,
    totalTokens: row.total_tokens,
    totalCost: row.total_cost,
    // Last-dispatched canonical model id (or null = "use profile
    // default"). The dropdown reads this on tab load to remember the
    // user's last brain pick across reload. Pre-existing in the schema
    // (migration 001 line 39) but until now it was never surfaced —
    // mapThread dropped it on the floor.
    model: row.model,
    lastMessagePreview: row.last_message_preview ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapLocalProfile(row: LocalProfileRow): LocalProfile {
  return {
    id: row.id,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapSettings(row: SettingsRow): UserSettings {
  return {
    id: row.id,
    key: row.key,
    value: row.value,
    updatedAt: row.updated_at,
  }
}

function mapProfileMetadata(row: ProfileMetadataRow): ProfileMetadata {
  return {
    profileId: row.profile_id,
    icon: row.icon,
    color: row.color,
    category: row.category,
    useCount: row.use_count ?? 0,
    totalCost: row.total_cost ?? 0,
    lastUsedAt: row.last_used_at ?? null,
    updatedAt: row.updated_at,
  }
}

function mapWorkspacePane(row: WorkspacePaneRow): WorkspacePane {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    kind: row.kind as WorkspacePane['kind'],
    zone: row.zone as PaneZone,
    title: row.title,
    config: JSON.parse(row.config_json) as PaneConfig,
    metadata: JSON.parse(row.metadata_json) as PaneMetadata,
    position: row.position,
    focused: row.focused === 1,
    groupId: row.group_id,
    openedAt: row.opened_at,
  }
}

function workspacePaneLayoutKey(workspaceId: string): string {
  return `cx.workspace.${workspaceId}.tabsLayout`
}

function workspaceSideTrackWidthKey(workspaceId: string): string {
  return `cx.workspace.${workspaceId}.sideTrackWidth`
}

/**
 * Default pane title derived from a typed config — used when the
 * caller doesn't supply one. Kept narrow on purpose: human-friendly
 * but generic, so the handler can override with a more meaningful
 * label (file basename, agent-supplied title, etc).
 */
function defaultPaneTitle(config: PaneConfig): string {
  switch (config.kind) {
    case 'chat': return 'Chat'
    case 'markdown': return 'Markdown'
    case 'code': return config.filename ?? 'Snippet'
    case 'image': return 'Image'
    case 'url': {
      try { return new URL(config.source.url).hostname } catch { return 'URL' }
    }
    case 'html': return 'HTML'
    case 'mermaid': return 'Diagram'
    case 'pdf': return 'PDF'
    case 'video': return 'Video'
    case 'audio': return 'Audio'
    case 'csv': return 'Table'
    case 'diff': return 'Diff'
    case 'txt': return 'Text'
    case 'json': return 'JSON'
    case 'terminal': return 'Output'
    case 'files': return 'Files'
    case 'tasks': return 'Tasks'
    case 'plan': return 'Plan'
    case 'chrome': {
      try { return new URL(config.url).hostname } catch { return 'Browser' }
    }
    case '3d': return '3D'
    case 'notebook': return 'Notebook'
    case 'scratchpad': return 'Scratchpad'
  }
}

function mapAppState(row: AppStateRow): AppState {
  return {
    key: row.key,
    value: row.value,
    updatedAt: row.updated_at,
  }
}

function mapAuditLog(row: AuditLogRow): AuditLogEntry {
  return {
    id: row.id,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    detail: row.detail,
    ipAddress: row.ip_address,
    createdAt: row.created_at,
  }
}

// ---------------------------------------------------------------------------
// Dashboard helpers
// ---------------------------------------------------------------------------

function rangeToConfig(range: DashboardRange): { days: number | null; hours: number | null } {
  switch (range) {
    case '24h': return { days: null, hours: 24 }
    case '7d':  return { days: 7,    hours: null }
    case '30d': return { days: 30,   hours: null }
    case '90d': return { days: 90,   hours: null }
  }
}

// ---------------------------------------------------------------------------
// Encryption helpers (AES-256-GCM)
// ---------------------------------------------------------------------------

const ALGORITHM = 'aes-256-gcm' as const
const IV_LENGTH = 16

export function encryptValue(plaintext: string, key: Buffer): { encrypted: string; iv: string; authTag: string } {
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  let encrypted = cipher.update(plaintext, 'utf-8', 'hex')
  encrypted += cipher.final('hex')
  const authTag = cipher.getAuthTag().toString('hex')
  return { encrypted, iv: iv.toString('hex'), authTag }
}

export function decryptValue(encrypted: string, ivHex: string, authTagHex: string, key: Buffer): string {
  const iv = Buffer.from(ivHex, 'hex')
  const authTag = Buffer.from(authTagHex, 'hex')
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)
  let decrypted = decipher.update(encrypted, 'hex', 'utf-8')
  decrypted += decipher.final('utf-8')
  return decrypted
}

export function generateEncryptionKey(): Buffer {
  return randomBytes(32)
}

function mapWorkspace(row: WorkspaceRow & { tab_count?: number }): Workspace {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    status: row.status as Workspace['status'],
    lastProfileId: row.last_profile_id,
    pinned: row.pinned === 1,
    tabCount: row.tab_count ?? 0,
    activeProducts: parseActiveProducts(row.active_products),
    lastOpenedAt: row.last_opened_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

interface DesignRow {
  id: string
  workspace_id: string
  slug: string
  kind: string
  name: string | null
  template_source: string | null
  created_at: string
  updated_at: string
}

function mapDesign(row: DesignRow): Design {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    slug: row.slug,
    kind: row.kind as Design['kind'],
    name: row.name,
    templateSource: row.template_source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Decode `workspaces.active_products` (JSON-encoded TEXT) to a typed
 * `readonly string[]`. Falls back to `['ownware']` if the column is
 * missing, malformed, empty, or non-array — keeping a workspace
 * usable rather than crashing the gateway. Matches the surrounding
 * defensive JSON.parse pattern used by sub_agents / config_json /
 * tools_metadata in this file.
 */
function parseActiveProducts(raw: string | null | undefined): readonly string[] {
  if (raw == null || raw === '') return ['ownware']
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return ['ownware']
    const slugs = parsed.filter((x): x is string => typeof x === 'string' && x.length > 0)
    return slugs.length > 0 ? slugs : ['ownware']
  } catch {
    return ['ownware']
  }
}

function mapMCPServer(row: MCPServerRow, profileIds: string[]): MCPServerRecord {
  let toolsMetadata: MCPServerRecord['toolsMetadata'] = null
  if (row.tools_json != null) {
    try {
      toolsMetadata = JSON.parse(row.tools_json)
    } catch {
      toolsMetadata = null
    }
  }

  return {
    id: row.id,
    name: row.name,
    transport: row.transport as MCPServerRecord['transport'],
    url: row.url,
    command: row.command,
    args: row.args ? JSON.parse(row.args) : [],
    env: row.env ? JSON.parse(row.env) : {},
    headers: row.headers ? JSON.parse(row.headers) : {},
    registryId: row.registry_id,
    toolCount: row.tool_count,
    toolsMetadata,
    status: row.status as MCPServerRecord['status'],
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    profileIds,
  }
}

function mapMessage(row: MessageRow): ThreadMessage {
  return {
    id: row.id,
    role: row.role as ThreadMessage['role'],
    content: row.content,
    tools: row.tools ? JSON.parse(row.tools) : undefined,
    subAgents: row.sub_agents ? JSON.parse(row.sub_agents) : undefined,
    permissions: row.permissions ? JSON.parse(row.permissions) : undefined,
    credentials: row.credentials ? JSON.parse(row.credentials) : undefined,
    attachments: row.attachments ? JSON.parse(row.attachments) : undefined,
    thinking: row.thinking ?? undefined,
    usage: row.usage_input != null ? {
      inputTokens: row.usage_input,
      outputTokens: row.usage_output ?? 0,
      // Cache fields (migration 027). Pre-027 rows return NULL; emit
      // `undefined` so the wire shape matches a row that never reported
      // cache usage. Post-027 rows that genuinely processed 0 cache
      // tokens write a literal 0 — preserved exactly.
      ...(row.usage_cache_read != null ? { cacheReadTokens: row.usage_cache_read } : {}),
      ...(row.usage_cache_creation != null ? { cacheCreationTokens: row.usage_cache_creation } : {}),
    } : undefined,
    timestamp: row.created_at,
    parts: row.parts ? JSON.parse(row.parts) : undefined,
    // Per-message model attribution (migration 020). Null for user /
    // system / pre-feature rows — the renderer falls back to a generic
    // 'agent' label in those cases.
    ...(row.model != null ? { model: row.model } : {}),
  }
}
