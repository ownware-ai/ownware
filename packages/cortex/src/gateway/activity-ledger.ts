import type { RuntimeConsequence } from '../runtime/port.js'
import type { SqliteDatabase } from '../storage/sqlite-driver.js'

/**
 * The cross-run activity ledger — one INDEX over evidence that already exists.
 *
 * Every row locates exactly one authoritative receipt. It never holds a fact
 * that receipt does not already prove, and it is never read as a source of
 * truth: a reader pages the ledger to find receipts, then reads the receipt.
 *
 * A row is appended inside the SAME transaction as the receipt it indexes. If
 * the append fails the receipt write fails with it, so "indexed" and "durable"
 * cannot diverge. Nothing polls, follows or reconciles this table after the
 * fact — a ledger that catches up later cannot prove it is not still behind.
 */

export type ActivityLedgerFamily =
  | 'effect'
  | 'egress'
  | 'skill_activation'
  | 'reversal'
  | 'permission_decision'

export type ActivityLedgerOrigin = 'live' | 'backfill'

export interface ActivityLedgerAppendInput {
  readonly family: ActivityLedgerFamily
  /** The authoritative receipt this row locates. */
  readonly receiptId: string
  readonly runId: string
  readonly occurredAt: number
  /**
   * Bounded, family-owned filter labels. Each family keeps its own vocabulary;
   * an unrecognized value is a label to filter on, never a semantic upgrade.
   */
  readonly outcome?: string | null
  readonly consequence?: RuntimeConsequence | null
  readonly toolName?: string | null
}

export type ActivityLedgerErrorCode =
  | 'invalid_input'
  | 'run_missing'
  | 'cursor_invalid'

/** Stable, content-free failure safe to cross repository adapters. */
export class ActivityLedgerError extends Error {
  override readonly name = 'ActivityLedgerError'

  constructor(readonly code: ActivityLedgerErrorCode) {
    super(`Activity ledger append rejected (${code}).`)
  }
}

interface RunScopeRow {
  readonly thread_id: string
  readonly profile_id: string
  readonly workspace_id: string | null
}

/** Exported so a request handler validates the same vocabulary at its boundary. */
export const ACTIVITY_LEDGER_FAMILIES: ReadonlySet<string> = new Set<ActivityLedgerFamily>([
  'effect',
  'egress',
  'skill_activation',
  'reversal',
  'permission_decision',
])
const FAMILIES = ACTIVITY_LEDGER_FAMILIES

const OUTCOME_PATTERN = /^[a-z_]{1,40}$/
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.:-]{1,160}$/
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/**
 * Shared structural validation for both storage dialects.
 *
 * Exported so the PostgreSQL adapter enforces the identical envelope rather
 * than growing a second, drifting copy of these bounds.
 */
export function validateActivityLedgerInput(input: ActivityLedgerAppendInput): void {
  if (
    !FAMILIES.has(input.family)
    || !UUID_PATTERN.test(input.receiptId)
    || typeof input.runId !== 'string'
    || input.runId.length === 0
    || !Number.isSafeInteger(input.occurredAt)
    || input.occurredAt < 0
    || (input.outcome != null && !OUTCOME_PATTERN.test(input.outcome))
    || (input.toolName != null && !TOOL_NAME_PATTERN.test(input.toolName))
  ) {
    throw new ActivityLedgerError('invalid_input')
  }
}

/**
 * Append one index row inside the caller's already-open transaction.
 *
 * The caller owns the transaction deliberately: this function must commit or
 * roll back with the receipt, and a helper that opened its own transaction
 * could leave an indexed row pointing at a receipt that never landed.
 *
 * Returns the assigned `ledger_seq`.
 */
export function appendActivityLedgerRow(
  db: SqliteDatabase,
  input: ActivityLedgerAppendInput,
): number {
  validateActivityLedgerInput(input)

  // Scope is read from the run rather than supplied by the caller: a caller
  // that could name its own profile could file evidence under another one.
  const scope = db.prepare(`
    SELECT thread_id, profile_id, workspace_id FROM gateway_runs WHERE id = ?
  `).get(input.runId) as RunScopeRow | undefined
  if (scope === undefined) throw new ActivityLedgerError('run_missing')

  // Same discipline as effect_receipts.receipt_seq, widened to the install so
  // one cursor pages every family. Not an identity column: those can commit
  // out of assignment order and hide a row behind a cursor already passed.
  const ledgerSeq = db.prepare(`
    SELECT COALESCE(MAX(ledger_seq), 0) + 1 AS value FROM activity_ledger
  `).pluck().get() as number

  db.prepare(`
    INSERT INTO activity_ledger (
      ledger_seq, family, receipt_id, run_id, thread_id, profile_id,
      workspace_id, occurred_at, origin, outcome, consequence, tool_name
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'live', ?, ?, ?)
  `).run(
    ledgerSeq,
    input.family,
    input.receiptId,
    input.runId,
    scope.thread_id,
    scope.profile_id,
    scope.workspace_id,
    input.occurredAt,
    input.outcome ?? null,
    input.consequence ?? null,
    input.toolName ?? null,
  )

  return ledgerSeq
}

/**
 * What the ledger can and cannot claim about its own ordering.
 *
 * Derived from the rows rather than stored as a second piece of state: a
 * separate watermark table could drift from the rows it describes, and a
 * coverage claim that disagrees with the evidence is worse than none.
 */
export interface ActivityLedgerCoverage {
  /**
   * Highest `ledger_seq` whose order was reconstructed from timestamps during
   * the upgrade backfill. Rows at or below it are ordered by `occurred_at`,
   * NOT by observed append order. 0 when nothing was backfilled.
   */
  readonly reconstructedThrough: number
  /** How many rows carry reconstructed ordering. */
  readonly reconstructedCount: number
  /**
   * Lowest `ledger_seq` observed at append time, or null when no live row
   * exists yet. From here up, sequence order IS append order.
   */
  readonly observedFrom: number | null
}

/**
 * Report the ledger's ordering provenance.
 *
 * A caller rendering a trail must use this to say plainly which part of the
 * order was observed and which was reconstructed. Absence of backfilled rows
 * is a real answer; it is not the same as "the trail is complete", which this
 * ledger never claims — receipts already removed by retention were never
 * available to index.
 */
export function readActivityLedgerCoverage(db: SqliteDatabase): ActivityLedgerCoverage {
  const row = db.prepare(`
    SELECT
      COALESCE(MAX(CASE WHEN origin = 'backfill' THEN ledger_seq END), 0) AS reconstructed_through,
      COUNT(CASE WHEN origin = 'backfill' THEN 1 END) AS reconstructed_count,
      MIN(CASE WHEN origin = 'live' THEN ledger_seq END) AS observed_from
    FROM activity_ledger
  `).get() as {
    readonly reconstructed_through: number
    readonly reconstructed_count: number
    readonly observed_from: number | null
  }
  return {
    reconstructedThrough: row.reconstructed_through,
    reconstructedCount: row.reconstructed_count,
    observedFrom: row.observed_from,
  }
}

// ---------------------------------------------------------------------------
// Cross-run read
// ---------------------------------------------------------------------------

export interface ActivityLedgerEntry {
  readonly ledgerSeq: number
  readonly family: ActivityLedgerFamily
  readonly receiptId: string
  readonly runId: string
  readonly threadId: string
  readonly profileId: string
  readonly workspaceId: string | null
  readonly occurredAt: number
  readonly origin: ActivityLedgerOrigin
  readonly outcome: string | null
  readonly consequence: RuntimeConsequence | null
  readonly toolName: string | null
}

/**
 * Query scope.
 *
 * `profileId` / `workspaceId` are supplied by the AUTHORIZATION layer, not by
 * the caller's query string. A handler must derive them from the principal and
 * refuse a request that names anything outside it, so no filter value can ever
 * widen what a principal may read.
 */
export interface ActivityLedgerQuery {
  readonly profileId?: string
  readonly workspaceId?: string
  readonly threadId?: string
  readonly runId?: string
  readonly family?: ActivityLedgerFamily
  /** Inclusive lower bound on `occurredAt`. */
  readonly since?: number
  /** Inclusive upper bound on `occurredAt`. */
  readonly until?: number
}

export interface ActivityLedgerPage {
  readonly items: readonly ActivityLedgerEntry[]
  /** Pass back as `cursor` for the next page; null when the page is the last. */
  readonly nextCursor: string | null
  /** What this ledger can and cannot claim about its own ordering. */
  readonly coverage: ActivityLedgerCoverage
}

export const ACTIVITY_LEDGER_MAX_LIMIT = 100

interface LedgerStorageRow {
  readonly ledger_seq: number
  readonly family: string
  readonly receipt_id: string
  readonly run_id: string
  readonly thread_id: string
  readonly profile_id: string
  readonly workspace_id: string | null
  readonly occurred_at: number
  readonly origin: string
  readonly outcome: string | null
  readonly consequence: string | null
  readonly tool_name: string | null
}

function projectEntry(row: LedgerStorageRow): ActivityLedgerEntry {
  return {
    ledgerSeq: row.ledger_seq,
    family: row.family as ActivityLedgerFamily,
    receiptId: row.receipt_id,
    runId: row.run_id,
    threadId: row.thread_id,
    profileId: row.profile_id,
    workspaceId: row.workspace_id,
    occurredAt: row.occurred_at,
    origin: row.origin as ActivityLedgerOrigin,
    outcome: row.outcome,
    consequence: row.consequence as RuntimeConsequence | null,
    toolName: row.tool_name,
  }
}

/**
 * Decode a page cursor.
 *
 * The cursor is an opaque decimal `ledger_seq`. It is validated rather than
 * trusted: a malformed or foreign value is rejected, never coerced to 0, which
 * would silently restart the trail at the beginning and look like success.
 */
export function decodeActivityLedgerCursor(cursor: string | null): number | null {
  if (cursor === null) return null
  if (!/^[1-9][0-9]{0,15}$/.test(cursor)) throw new ActivityLedgerError('cursor_invalid')
  const parsed = Number(cursor)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new ActivityLedgerError('cursor_invalid')
  }
  return parsed
}

/**
 * Page the ledger newest-first.
 *
 * Descending `ledger_seq` with a strict `<` cursor is what makes a page stable:
 * appends land at higher sequences, so a concurrent write can never insert
 * itself into a page a reader has already passed, and can never shift a row
 * across a page boundary. Ordering by `occurred_at` instead would do both,
 * because timestamps are supplied and can repeat or move backwards.
 */
export function listActivityLedger(
  db: SqliteDatabase,
  query: ActivityLedgerQuery,
  page: { readonly limit: number; readonly cursor: string | null },
): ActivityLedgerPage {
  if (
    !Number.isSafeInteger(page.limit)
    || page.limit < 1
    || page.limit > ACTIVITY_LEDGER_MAX_LIMIT
  ) {
    throw new ActivityLedgerError('invalid_input')
  }
  if (query.family !== undefined && !FAMILIES.has(query.family)) {
    throw new ActivityLedgerError('invalid_input')
  }
  for (const bound of [query.since, query.until]) {
    if (bound !== undefined && (!Number.isSafeInteger(bound) || bound < 0)) {
      throw new ActivityLedgerError('invalid_input')
    }
  }
  const before = decodeActivityLedgerCursor(page.cursor)

  const where: string[] = []
  const args: unknown[] = []
  const eq = (column: string, value: string | undefined): void => {
    if (value === undefined) return
    where.push(`${column} = ?`)
    args.push(value)
  }
  eq('profile_id', query.profileId)
  eq('workspace_id', query.workspaceId)
  eq('thread_id', query.threadId)
  eq('run_id', query.runId)
  eq('family', query.family)
  if (query.since !== undefined) { where.push('occurred_at >= ?'); args.push(query.since) }
  if (query.until !== undefined) { where.push('occurred_at <= ?'); args.push(query.until) }
  if (before !== null) { where.push('ledger_seq < ?'); args.push(before) }

  // One extra row decides whether another page exists, without a second count
  // query that could disagree with this one under a concurrent append.
  const rows = db.prepare(`
    SELECT * FROM activity_ledger
    ${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`}
    ORDER BY ledger_seq DESC
    LIMIT ?
  `).all(...args, page.limit + 1) as LedgerStorageRow[]

  const items = rows.slice(0, page.limit).map(projectEntry)
  const nextCursor = rows.length > page.limit
    ? String(items[items.length - 1]!.ledgerSeq)
    : null
  return { items, nextCursor, coverage: readActivityLedgerCoverage(db) }
}

/**
 * Dialect-agnostic port for the cross-run read.
 *
 * Appends stay free functions called from inside each receipt's own
 * transaction; only the read needs a port, because a handler must not know
 * which storage adapter is underneath it.
 */
export interface ActivityLedgerRepository {
  list(
    query: ActivityLedgerQuery,
    page: { readonly limit: number; readonly cursor: string | null },
  ): Promise<ActivityLedgerPage>
  coverage(): Promise<ActivityLedgerCoverage>
}

/** SQLite implementation of {@link ActivityLedgerRepository}. */
export function createSqliteActivityLedgerRepository(
  db: SqliteDatabase,
): ActivityLedgerRepository {
  return {
    list: async (query, page) => listActivityLedger(db, query, page),
    coverage: async () => readActivityLedgerCoverage(db),
  }
}
