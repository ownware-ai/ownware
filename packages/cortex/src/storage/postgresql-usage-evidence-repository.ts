import { randomUUID } from 'node:crypto'
import type { PostgreSqlRootRepositoryContext } from './postgresql-adapter.js'
import {
  repositoryCall,
  safeInteger,
  withPostgreSqlTransaction,
  type PostgreSqlQueryClient,
} from './postgresql-repository.js'
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
  readonly duration_ms: unknown | null
  readonly success: boolean
  readonly recorded_at: string
  readonly observation_id: string
  readonly observation_seq: unknown
  readonly classification: string
  readonly amount_usd: unknown | null
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
  FROM ownware.provider_usage_facts usage
  JOIN ownware.provider_usage_cost_observations cost ON cost.usage_id = usage.id
`

const LATEST_SELECT = `
  ${BASE_SELECT}
  AND cost.observation_seq = (
    SELECT MAX(latest.observation_seq)
    FROM ownware.provider_usage_cost_observations latest
    WHERE latest.usage_id = usage.id
  )
`

function clauses(options: UsageEvidenceListOptions): {
  readonly sql: string
  readonly params: unknown[]
} {
  const where: string[] = []
  const params: unknown[] = []
  const add = (clause: (placeholder: string) => string, value: unknown): void => {
    params.push(value)
    where.push(clause(`$${params.length}`))
  }
  if (options.from !== undefined) add(p => `usage.occurred_at >= ${p}`, options.from)
  if (options.until !== undefined) add(p => `usage.occurred_at < ${p}`, options.until)
  if (options.profileId !== undefined) add(p => `usage.profile_id = ${p}`, options.profileId)
  if (options.threadId !== undefined) add(p => `usage.thread_id = ${p}`, options.threadId)
  if (options.classification !== undefined) {
    add(p => `cost.classification = ${p}`, options.classification)
  }
  return { sql: where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`, params }
}

async function latestEntry(client: PostgreSqlQueryClient, id: string) {
  const result = await client.query<UsageRow>(`${LATEST_SELECT} WHERE usage.id = $1`, [id])
  const row = result.rows[0]
  return row === undefined ? null : entryFromStorage(row)
}

async function insertSnapshot(
  client: PostgreSqlQueryClient,
  normalized: ReturnType<typeof normalizeUsageEvidenceRecord>,
  recordedAt: string,
): Promise<void> {
  if (
    normalized.pricebook === null ||
    normalized.pricebookPayload === null ||
    normalized.pricebookHash === null
  ) return
  await client.query(`
    INSERT INTO ownware.provider_pricebook_snapshots (
      entry_id, version, payload_json, payload_sha256, recorded_at
    ) VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (entry_id, version) DO NOTHING
  `, [
    normalized.pricebook.id,
    normalized.pricebook.version,
    normalized.pricebookPayload,
    normalized.pricebookHash,
    recordedAt,
  ])
  const result = await client.query<PriceSnapshotRow>(`
    SELECT payload_json, payload_sha256, recorded_at
    FROM ownware.provider_pricebook_snapshots
    WHERE entry_id = $1 AND version = $2
  `, [normalized.pricebook.id, normalized.pricebook.version])
  const existing = result.rows[0]
  if (
    existing === undefined ||
    existing.payload_json !== normalized.pricebookPayload ||
    existing.payload_sha256 !== normalized.pricebookHash
  ) throw new UsageEvidenceIntegrityError('snapshot_conflict')
}

async function insertObservation(
  client: PostgreSqlQueryClient,
  usageId: string,
  sequence: number,
  cost: ReturnType<typeof normalizeUsageEvidenceRecord>['entry']['cost'],
  recordedAt: string,
): Promise<void> {
  await client.query(`
    INSERT INTO ownware.provider_usage_cost_observations (
      id, usage_id, observation_seq, classification, amount_usd, currency,
      pricebook_entry_id, pricebook_version, observed_at, reconciled_at, recorded_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
  `, [
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
  ])
}

export function createPostgreSqlUsageEvidenceRepository(
  context: PostgreSqlRootRepositoryContext,
): UsageEvidenceRepository {
  return {
    async record(entryInput, pricebookInput) {
      const normalized = normalizeUsageEvidenceRecord(entryInput, pricebookInput, 'initial')
      return repositoryCall(context, 'usage_evidence', 'record', 'write_failed', async () =>
        withPostgreSqlTransaction(context.pool, async client => {
          const recordedAt = new Date().toISOString()
          await insertSnapshot(client, normalized, recordedAt)
          const entry = normalized.entry
          await client.query(`
            INSERT INTO ownware.provider_usage_facts (
              id, occurred_at, thread_id, profile_id, provider_family_id,
              provider_route_id, model_route_id, connection_id, wire_model_id,
              service_tier, context_tier, region, billing_kind, tokens_json,
              units_json, provider_facts_json, duration_ms, success, recorded_at
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
              $11, $12, $13, $14, $15, $16, $17, $18, $19
            )
          `, [
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
            entry.success,
            recordedAt,
          ])
          await insertObservation(client, entry.id, 1, entry.cost, recordedAt)
          return entry
        }))
    },

    async appendCostObservation(usageId, costInput, pricebookInput) {
      return repositoryCall(
        context,
        'usage_evidence',
        'append_cost_observation',
        'write_failed',
        async () => withPostgreSqlTransaction(context.pool, async client => {
          const lock = await client.query<{ readonly id: string }>(`
            SELECT id FROM ownware.provider_usage_facts WHERE id = $1 FOR UPDATE
          `, [usageId])
          if (lock.rows[0] === undefined) throw new UsageEvidenceNotFoundError()
          const prior = await latestEntry(client, usageId)
          if (prior === null) throw new UsageEvidenceNotFoundError()
          const normalized = normalizeUsageCostObservation(
            factFromEntry(prior),
            costInput,
            pricebookInput,
          )
          const recordedAt = new Date().toISOString()
          await insertSnapshot(client, normalized, recordedAt)
          const sequenceResult = await client.query<{ readonly sequence: unknown }>(`
            SELECT COALESCE(MAX(observation_seq), 0) + 1 AS sequence
            FROM ownware.provider_usage_cost_observations WHERE usage_id = $1
          `, [usageId])
          const sequence = safeInteger(sequenceResult.rows[0]?.sequence)
          await insertObservation(client, usageId, sequence, normalized.entry.cost, recordedAt)
          return normalized.entry
        }),
      )
    },

    async get(id) {
      return repositoryCall(context, 'usage_evidence', 'get', 'read_failed', client =>
        latestEntry(client, id))
    },

    async list(options = {}) {
      return repositoryCall(context, 'usage_evidence', 'list', 'read_failed', async client => {
        const filter = clauses(options)
        const limit = Math.max(1, Math.min(options.limit ?? 100, 1_000))
        const result = await client.query<UsageRow>(`${LATEST_SELECT} ${filter.sql}
          ORDER BY usage.occurred_at DESC, usage.id DESC LIMIT $${filter.params.length + 1}
        `, [...filter.params, limit])
        return result.rows.map(entryFromStorage)
      })
    },

    async summary(options = {}) {
      return repositoryCall(context, 'usage_evidence', 'summary', 'read_failed', async client => {
        const filter = clauses(options)
        const result = await client.query<UsageRow>(`${LATEST_SELECT} ${filter.sql}
          ORDER BY usage.occurred_at DESC, usage.id DESC
        `, filter.params)
        return summarizeUsageEntries(result.rows.map(entryFromStorage))
      })
    },

    async exportEvidence() {
      return repositoryCall(context, 'usage_evidence', 'export', 'read_failed', async client => {
        const result = await client.query<UsageRow>(`${BASE_SELECT}
          ORDER BY usage.occurred_at ASC, usage.id ASC, cost.observation_seq ASC
        `)
        const entries: UsageEvidenceExportEntry[] = []
        const byId = new Map<string, {
          readonly fact: ReturnType<typeof factFromEntry>
          readonly recordedAt: string
          costObservations: UsageCostObservationEvidence[]
        }>()
        for (const row of result.rows) {
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
            sequence: safeInteger(row.observation_seq),
            cost: costFromStorage(row),
            recordedAt: row.observation_recorded_at,
          })
        }
        const snapshots = await client.query<PriceSnapshotRow>(`
          SELECT payload_json, payload_sha256, recorded_at
          FROM ownware.provider_pricebook_snapshots ORDER BY entry_id ASC, version ASC
        `)
        const pricebookSnapshots: PricebookSnapshotEvidence[] = snapshots.rows.map(row => ({
          entry: parsePriceSnapshot(row.payload_json, row.payload_sha256),
          recordedAt: row.recorded_at,
        }))
        return { entries, pricebookSnapshots }
      })
    },

    async getPriceSnapshot(entryId, version) {
      return repositoryCall(
        context,
        'usage_evidence',
        'get_price_snapshot',
        'read_failed',
        async client => {
          const result = await client.query<PriceSnapshotRow>(`
            SELECT payload_json, payload_sha256, recorded_at
            FROM ownware.provider_pricebook_snapshots WHERE entry_id = $1 AND version = $2
          `, [entryId, version])
          const row = result.rows[0]
          return row === undefined
            ? null
            : parsePriceSnapshot(row.payload_json, row.payload_sha256)
        },
      )
    },
  }
}
