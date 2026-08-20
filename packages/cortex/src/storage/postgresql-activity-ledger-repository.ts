import {
  ACTIVITY_LEDGER_MAX_LIMIT,
  ActivityLedgerError,
  decodeActivityLedgerCursor,
  type ActivityLedgerCoverage,
  type ActivityLedgerEntry,
  type ActivityLedgerFamily,
  type ActivityLedgerOrigin,
  type ActivityLedgerPage,
  type ActivityLedgerQuery,
  type ActivityLedgerRepository,
} from '../gateway/activity-ledger.js'
import type { RuntimeConsequence } from '../runtime/port.js'
import {
  repositoryCall,
  withPostgreSqlTransaction,
  type PostgreSqlQueryClient,
} from './postgresql-repository.js'
import type { PostgreSqlRootRepositoryContext } from './postgresql-adapter.js'

/**
 * PostgreSQL half of the cross-run ledger read.
 *
 * Mirrors the SQLite implementation statement for statement, including the
 * descending `ledger_seq` order and strict `<` cursor that make a page stable
 * under concurrent appends. Only the placeholder dialect differs.
 */

interface LedgerRow {
  readonly ledger_seq: string
  readonly family: string
  readonly receipt_id: string
  readonly run_id: string
  readonly thread_id: string
  readonly profile_id: string
  readonly workspace_id: string | null
  readonly occurred_at: string
  readonly origin: string
  readonly outcome: string | null
  readonly consequence: string | null
  readonly tool_name: string | null
}

function safeInteger(value: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new ActivityLedgerError('invalid_input')
  return parsed
}

function projectEntry(row: LedgerRow): ActivityLedgerEntry {
  return {
    ledgerSeq: safeInteger(row.ledger_seq),
    family: row.family as ActivityLedgerFamily,
    receiptId: row.receipt_id,
    runId: row.run_id,
    threadId: row.thread_id,
    profileId: row.profile_id,
    workspaceId: row.workspace_id,
    occurredAt: safeInteger(row.occurred_at),
    origin: row.origin as ActivityLedgerOrigin,
    outcome: row.outcome,
    consequence: row.consequence as RuntimeConsequence | null,
    toolName: row.tool_name,
  }
}

const FAMILIES: ReadonlySet<string> = new Set<ActivityLedgerFamily>([
  'effect', 'egress', 'skill_activation', 'reversal', 'permission_decision',
])

export function createPostgreSqlActivityLedgerRepository(
  context: PostgreSqlRootRepositoryContext,
): ActivityLedgerRepository {
  return {
    list(
      query: ActivityLedgerQuery,
      page: { readonly limit: number; readonly cursor: string | null },
    ): Promise<ActivityLedgerPage> {
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

      return repositoryCall(context, 'activity_ledger', 'list', 'read_failed', () =>
        withPostgreSqlTransaction(context.pool, async (client) => {
      const where: string[] = []
      const args: unknown[] = []
      const eq = (column: string, value: string | number | undefined): void => {
        if (value === undefined) return
        args.push(value)
        where.push(`${column} = $${args.length}`)
      }
      eq('profile_id', query.profileId)
      eq('workspace_id', query.workspaceId)
      eq('thread_id', query.threadId)
      eq('run_id', query.runId)
      eq('family', query.family)
      if (query.since !== undefined) {
        args.push(query.since); where.push(`occurred_at >= $${args.length}`)
      }
      if (query.until !== undefined) {
        args.push(query.until); where.push(`occurred_at <= $${args.length}`)
      }
      if (before !== null) {
        args.push(before); where.push(`ledger_seq < $${args.length}`)
      }
      args.push(page.limit + 1)

      const result = await client.query<LedgerRow>(`
        SELECT
          ledger_seq::text, family, receipt_id, run_id, thread_id, profile_id,
          workspace_id, occurred_at::text, origin, outcome, consequence, tool_name
        FROM ownware.activity_ledger
        ${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`}
        ORDER BY ledger_seq DESC
        LIMIT $${args.length}
      `, args)

      const items = result.rows.slice(0, page.limit).map(projectEntry)
      const nextCursor = result.rows.length > page.limit
        ? String(items[items.length - 1]!.ledgerSeq)
        : null
      return { items, nextCursor, coverage: await readCoverage(client) }
        }))
    },

    coverage(): Promise<ActivityLedgerCoverage> {
      return repositoryCall(context, 'activity_ledger', 'coverage', 'read_failed', () =>
        withPostgreSqlTransaction(context.pool, (client) => readCoverage(client)))
    },
  }
}

async function readCoverage(
  client: PostgreSqlQueryClient,
): Promise<ActivityLedgerCoverage> {
  const result = await client.query<{
    readonly reconstructed_through: string
    readonly reconstructed_count: string
    readonly observed_from: string | null
  }>(`
    SELECT
      COALESCE(MAX(ledger_seq) FILTER (WHERE origin = 'backfill'), 0)::text
        AS reconstructed_through,
      COUNT(*) FILTER (WHERE origin = 'backfill')::text AS reconstructed_count,
      MIN(ledger_seq) FILTER (WHERE origin = 'live')::text AS observed_from
    FROM ownware.activity_ledger
  `)
  const row = result.rows[0]
  if (row === undefined) throw new ActivityLedgerError('invalid_input')
  return {
    reconstructedThrough: safeInteger(row.reconstructed_through),
    reconstructedCount: safeInteger(row.reconstructed_count),
    observedFrom: row.observed_from === null ? null : safeInteger(row.observed_from),
  }
}
