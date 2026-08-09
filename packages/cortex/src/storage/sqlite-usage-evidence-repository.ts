import { randomUUID } from 'node:crypto'
import type { SqliteDatabase } from './sqlite-driver.js'
import {
  StorageLifecycleError,
  StorageRepositoryError,
} from './contracts.js'
import {
  UsageEvidenceIntegrityError,
  UsageEvidenceNotFoundError,
  costFromStorage,
  entryFromStorage,
  factFromEntry,
  normalizeUsageCostObservation,
  normalizeUsageEvidenceRecord,
  parsePriceSnapshot,
  summarizeUsageEntries,
  type PricebookSnapshotEvidence,
  type UsageCostObservationEvidence,
  type UsageEvidenceExportEntry,
  type UsageEvidenceListOptions,
  type UsageEvidenceRepository,
} from './usage-evidence-repository.js'

interface UsageRow {
  readonly id: string
  readonly occurred_at: string
  readonly thread_id: string | null
  readonly profile_id: string | null
  readonly provider_family_id: string
  readonly provider_route_id: string
  readonly model_route_id: string
  readonly connection_id: string | null
  readonly wire_model_id: string
  readonly service_tier: string | null
  readonly context_tier: string | null
  readonly region: string | null
  readonly billing_kind: string
  readonly tokens_json: string
  readonly units_json: string
  readonly provider_facts_json: string
  readonly duration_ms: number | null
  readonly success: number
  readonly recorded_at: string
  readonly observation_id: string
  readonly observation_seq: number
  readonly classification: string
  readonly amount_usd: number | null
  readonly currency: string
  readonly pricebook_entry_id: string | null
  readonly pricebook_version: string | null
  readonly observed_at: string
  readonly reconciled_at: string | null
  readonly observation_recorded_at: string
}

interface PriceSnapshotRow {
  readonly payload_json: string
  readonly payload_sha256: string
  readonly recorded_at: string
}

const BASE_SELECT = `
  SELECT
    usage.*,
    cost.id AS observation_id,
    cost.observation_seq,
    cost.classification,
    cost.amount_usd,
    cost.currency,
    cost.pricebook_entry_id,
    cost.pricebook_version,
    cost.observed_at,
    cost.reconciled_at,
    cost.recorded_at AS observation_recorded_at
  FROM provider_usage_facts usage
  JOIN provider_usage_cost_observations cost ON cost.usage_id = usage.id
`

const LATEST_SELECT = `
  ${BASE_SELECT}
  AND cost.observation_seq = (
    SELECT MAX(latest.observation_seq)
    FROM provider_usage_cost_observations latest
    WHERE latest.usage_id = usage.id
  )
`

function call<T>(
  context: SqliteUsageEvidenceRepositoryContext,
  operation: string,
  code: 'read_failed' | 'write_failed',
  fn: (db: SqliteDatabase) => T,
): T {
  try {
    context.assertActive()
    return fn(context.database)
  } catch (error) {
    if (
      error instanceof StorageLifecycleError ||
      error instanceof StorageRepositoryError ||
      error instanceof UsageEvidenceNotFoundError ||
      error instanceof UsageEvidenceIntegrityError ||
      error instanceof TypeError ||
      error instanceof RangeError ||
      (error instanceof Error && error.name === 'ZodError')
    ) {
      throw error
    }
    const sqliteCode = typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { readonly code?: unknown }).code ?? '')
      : ''
    throw new StorageRepositoryError(
      code,
      'sqlite',
      'usage_evidence',
      operation,
      sqliteCode === 'SQLITE_BUSY' || sqliteCode === 'SQLITE_LOCKED',
    )
  }
}

function clauses(options: UsageEvidenceListOptions): {
  readonly sql: string
  readonly params: unknown[]
} {
  const where: string[] = []
  const params: unknown[] = []
  if (options.from !== undefined) {
    where.push('usage.occurred_at >= ?')
    params.push(options.from)
  }
  if (options.until !== undefined) {
    where.push('usage.occurred_at < ?')
    params.push(options.until)
  }
  if (options.profileId !== undefined) {
    where.push('usage.profile_id = ?')
    params.push(options.profileId)
  }
  if (options.threadId !== undefined) {
    where.push('usage.thread_id = ?')
    params.push(options.threadId)
  }
  if (options.classification !== undefined) {
    where.push('cost.classification = ?')
    params.push(options.classification)
  }
  return { sql: where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`, params }
}

function latestEntry(db: SqliteDatabase, id: string) {
  const row = db.prepare(`${LATEST_SELECT} WHERE usage.id = ?`)
    .get(id) as UsageRow | undefined
  return row === undefined ? null : entryFromStorage(row)
}

function insertSnapshot(
  db: SqliteDatabase,
  normalized: ReturnType<typeof normalizeUsageEvidenceRecord>,
  recordedAt: string,
): void {
  if (
    normalized.pricebook === null ||
    normalized.pricebookPayload === null ||
    normalized.pricebookHash === null
  ) return
  const existing = db.prepare(`
    SELECT payload_json, payload_sha256, recorded_at
    FROM provider_pricebook_snapshots
    WHERE entry_id = ? AND version = ?
  `).get(normalized.pricebook.id, normalized.pricebook.version) as PriceSnapshotRow | undefined
  if (existing !== undefined) {
    if (
      existing.payload_json !== normalized.pricebookPayload ||
      existing.payload_sha256 !== normalized.pricebookHash
    ) throw new UsageEvidenceIntegrityError('snapshot_conflict')
    return
  }
  db.prepare(`
    INSERT INTO provider_pricebook_snapshots (
      entry_id, version, payload_json, payload_sha256, recorded_at
    ) VALUES (?, ?, ?, ?, ?)
  `).run(
    normalized.pricebook.id,
    normalized.pricebook.version,
    normalized.pricebookPayload,
    normalized.pricebookHash,
    recordedAt,
  )
}

function insertObservation(
  db: SqliteDatabase,
  usageId: string,
  sequence: number,
  cost: ReturnType<typeof costFromStorage> | ReturnType<typeof normalizeUsageEvidenceRecord>['entry']['cost'],
  recordedAt: string,
): void {
  db.prepare(`
    INSERT INTO provider_usage_cost_observations (
      id, usage_id, observation_seq, classification, amount_usd, currency,
      pricebook_entry_id, pricebook_version, observed_at, reconciled_at, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `usage_cost:${randomUUID()}`,
    usageId,
    sequence,
    cost.classification,
    cost.amountUsd,
    cost.currency,
    cost.pricebookEntryId ?? null,
    cost.pricebookVersion ?? null,
    cost.observedAt,
    cost.reconciledAt ?? null,
    recordedAt,
  )
}

export function createSqliteUsageEvidenceRepository(
  context: SqliteUsageEvidenceRepositoryContext,
): UsageEvidenceRepository {
  return {
    async record(entryInput, pricebookInput) {
      const normalized = normalizeUsageEvidenceRecord(entryInput, pricebookInput, 'initial')
      return call(context, 'record', 'write_failed', db => db.transaction(() => {
        const recordedAt = new Date().toISOString()
        insertSnapshot(db, normalized, recordedAt)
        const entry = normalized.entry
        db.prepare(`
          INSERT INTO provider_usage_facts (
            id, occurred_at, thread_id, profile_id, provider_family_id,
            provider_route_id, model_route_id, connection_id, wire_model_id,
            service_tier, context_tier, region, billing_kind, tokens_json,
            units_json, provider_facts_json, duration_ms, success, recorded_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          entry.id,
          entry.occurredAt,
          entry.threadId ?? null,
          entry.profileId ?? null,
          entry.providerFamilyId,
          entry.providerRouteId,
          entry.modelRouteId,
          entry.connectionId ?? null,
          entry.wireModelId,
          entry.serviceTier ?? null,
          entry.contextTier ?? null,
          entry.region ?? null,
          entry.billingKind,
          JSON.stringify(entry.tokens),
          JSON.stringify(entry.units),
          JSON.stringify(entry.providerFacts),
          entry.durationMs ?? null,
          entry.success ? 1 : 0,
          recordedAt,
        )
        insertObservation(db, entry.id, 1, entry.cost, recordedAt)
        return entry
      })())
    },

    async appendCostObservation(usageId, costInput, pricebookInput) {
      return call(context, 'append_cost_observation', 'write_failed', db => db.transaction(() => {
        const prior = latestEntry(db, usageId)
        if (prior === null) throw new UsageEvidenceNotFoundError()
        const normalized = normalizeUsageCostObservation(
          factFromEntry(prior),
          costInput,
          pricebookInput,
        )
        const recordedAt = new Date().toISOString()
        insertSnapshot(db, normalized, recordedAt)
        const sequenceRow = db.prepare(`
          SELECT COALESCE(MAX(observation_seq), 0) + 1 AS sequence
          FROM provider_usage_cost_observations WHERE usage_id = ?
        `).get(usageId) as { readonly sequence: number }
        insertObservation(db, usageId, sequenceRow.sequence, normalized.entry.cost, recordedAt)
        return normalized.entry
      })())
    },

    async get(id) {
      return call(context, 'get', 'read_failed', db => latestEntry(db, id))
    },

    async list(options = {}) {
      return call(context, 'list', 'read_failed', db => {
        const filter = clauses(options)
        const limit = Math.max(1, Math.min(options.limit ?? 100, 1_000))
        const rows = db.prepare(`${LATEST_SELECT} ${filter.sql}
          ORDER BY usage.occurred_at DESC, usage.id DESC LIMIT ?
        `).all(...filter.params, limit) as UsageRow[]
        return rows.map(entryFromStorage)
      })
    },

    async summary(options = {}) {
      return call(context, 'summary', 'read_failed', db => {
        const filter = clauses(options)
        const rows = db.prepare(`${LATEST_SELECT} ${filter.sql}
          ORDER BY usage.occurred_at DESC, usage.id DESC
        `).all(...filter.params) as UsageRow[]
        return summarizeUsageEntries(rows.map(entryFromStorage))
      })
    },

    async exportEvidence() {
      return call(context, 'export', 'read_failed', db => {
        const rows = db.prepare(`${BASE_SELECT}
          ORDER BY usage.occurred_at ASC, usage.id ASC, cost.observation_seq ASC
        `).all() as UsageRow[]
        const entries: UsageEvidenceExportEntry[] = []
        const byId = new Map<string, {
          readonly fact: ReturnType<typeof factFromEntry>
          readonly recordedAt: string
          costObservations: UsageCostObservationEvidence[]
        }>()
        for (const row of rows) {
          const mapped = entryFromStorage(row)
          let target = byId.get(mapped.id)
          if (target === undefined) {
            target = {
              fact: factFromEntry(mapped),
              recordedAt: row.recorded_at,
              costObservations: [],
            }
            byId.set(mapped.id, target)
            entries.push(target)
          }
          target.costObservations.push({
            id: row.observation_id,
            sequence: row.observation_seq,
            cost: costFromStorage(row),
            recordedAt: row.observation_recorded_at,
          })
        }
        const snapshotRows = db.prepare(`
          SELECT payload_json, payload_sha256, recorded_at
          FROM provider_pricebook_snapshots ORDER BY entry_id ASC, version ASC
        `).all() as PriceSnapshotRow[]
        const pricebookSnapshots: PricebookSnapshotEvidence[] = snapshotRows.map(row => ({
          entry: parsePriceSnapshot(row.payload_json, row.payload_sha256),
          recordedAt: row.recorded_at,
        }))
        return { entries, pricebookSnapshots }
      })
    },

    async getPriceSnapshot(entryId, version) {
      return call(context, 'get_price_snapshot', 'read_failed', db => {
        const row = db.prepare(`
          SELECT payload_json, payload_sha256, recorded_at
          FROM provider_pricebook_snapshots WHERE entry_id = ? AND version = ?
        `).get(entryId, version) as PriceSnapshotRow | undefined
        return row === undefined ? null : parsePriceSnapshot(row.payload_json, row.payload_sha256)
      })
    },
  }
}
interface SqliteUsageEvidenceRepositoryContext {
  readonly database: SqliteDatabase
  assertActive(): void
}
