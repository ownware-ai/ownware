import { createHash } from 'node:crypto'
import {
  PricebookEntrySchema,
  UsageCostSchema,
  UsageLedgerEntrySchema,
  type CostClassification,
  type PricebookEntry,
  type UsageLedgerEntry,
} from '../provider-hub/schema.js'

export interface UsageEvidenceListOptions {
  readonly from?: string
  readonly until?: string
  readonly profileId?: string
  readonly threadId?: string
  readonly classification?: CostClassification
  readonly limit?: number
}

export interface UsageEvidenceSummary {
  readonly observations: Record<CostClassification, {
    readonly requestCount: number
    readonly amountUsd: number | null
  }>
  readonly tokens: {
    readonly inputTextTokens: number
    readonly outputTextTokens: number
    readonly cacheReadTokens: number
    readonly cacheWriteTokens: number
    readonly reasoningTokens: number
  }
}

export type UsageEvidenceFact = Omit<UsageLedgerEntry, 'cost'>

export interface UsageCostObservationEvidence {
  readonly id: string
  /** Adapter-assigned append order. Caller timestamps never decide latest. */
  readonly sequence: number
  readonly cost: UsageLedgerEntry['cost']
  readonly recordedAt: string
}

export interface UsageEvidenceExportEntry {
  readonly fact: UsageEvidenceFact
  readonly recordedAt: string
  readonly costObservations: readonly UsageCostObservationEvidence[]
}

export interface PricebookSnapshotEvidence {
  readonly entry: PricebookEntry
  readonly recordedAt: string
}

export interface UsageEvidenceExport {
  readonly entries: readonly UsageEvidenceExportEntry[]
  readonly pricebookSnapshots: readonly PricebookSnapshotEvidence[]
}

export interface UsageEvidenceRepository {
  record(entry: UsageLedgerEntry, pricebook?: PricebookEntry): Promise<UsageLedgerEntry>
  appendCostObservation(
    usageId: string,
    cost: UsageLedgerEntry['cost'],
    pricebook?: PricebookEntry,
  ): Promise<UsageLedgerEntry>
  get(id: string): Promise<UsageLedgerEntry | null>
  list(options?: UsageEvidenceListOptions): Promise<readonly UsageLedgerEntry[]>
  summary(
    options?: Omit<UsageEvidenceListOptions, 'classification' | 'limit'>,
  ): Promise<UsageEvidenceSummary>
  exportEvidence(): Promise<UsageEvidenceExport>
  getPriceSnapshot(entryId: string, version: string): Promise<PricebookEntry | null>
}

/** Content-free domain failure: the caller's identifier is never reflected. */
export class UsageEvidenceNotFoundError extends Error {
  override readonly name = 'UsageEvidenceNotFoundError'
  constructor() {
    super('Provider usage evidence was not found.')
  }
}

/** Content-free immutable-snapshot or stored-evidence integrity failure. */
export class UsageEvidenceIntegrityError extends Error {
  override readonly name = 'UsageEvidenceIntegrityError'
  constructor(readonly code: 'snapshot_conflict' | 'snapshot_corrupt') {
    super(`Provider usage evidence failed its integrity check (${code}).`)
  }
}

export interface NormalizedUsageEvidenceRecord {
  readonly entry: UsageLedgerEntry
  readonly pricebook: PricebookEntry | null
  readonly pricebookPayload: string | null
  readonly pricebookHash: string | null
}

export function normalizeUsageEvidenceRecord(
  entryInput: UsageLedgerEntry,
  pricebookInput?: PricebookEntry,
  mode: 'initial' | 'observation' = 'observation',
): NormalizedUsageEvidenceRecord {
  const entry = UsageLedgerEntrySchema.parse(entryInput)
  if (mode === 'initial') assertInitialBillingClassification(entry)
  const pricebook = validatePriceSnapshot(entry.cost, pricebookInput)
  const pricebookPayload = pricebook === null ? null : canonicalJson(pricebook)
  return {
    entry,
    pricebook,
    pricebookPayload,
    pricebookHash: pricebookPayload === null ? null : sha256(pricebookPayload),
  }
}

function assertInitialBillingClassification(entry: UsageLedgerEntry): void {
  const expected = entry.billingKind === 'subscription'
    ? 'subscription'
    : entry.billingKind === 'local'
      ? 'local'
      : null
  if (expected !== null && entry.cost.classification !== expected) {
    throw new TypeError('Initial usage cost classification conflicts with route billing.')
  }
}

export function normalizeUsageCostObservation(
  fact: UsageEvidenceFact,
  costInput: UsageLedgerEntry['cost'],
  pricebookInput?: PricebookEntry,
): NormalizedUsageEvidenceRecord {
  const cost = UsageCostSchema.parse(costInput)
  return normalizeUsageEvidenceRecord({ ...fact, cost }, pricebookInput)
}

export function parsePriceSnapshot(payload: string, expectedHash: string): PricebookEntry {
  if (sha256(payload) !== expectedHash) {
    throw new UsageEvidenceIntegrityError('snapshot_corrupt')
  }
  return PricebookEntrySchema.parse(JSON.parse(payload) as unknown)
}

export function costFromStorage(row: {
  readonly classification: unknown
  readonly amount_usd: unknown
  readonly currency: unknown
  readonly pricebook_entry_id: string | null
  readonly pricebook_version: string | null
  readonly observed_at: unknown
  readonly reconciled_at: string | null
}): UsageLedgerEntry['cost'] {
  return UsageCostSchema.parse({
    classification: row.classification,
    amountUsd: row.amount_usd === null ? null : Number(row.amount_usd),
    currency: row.currency,
    ...(row.pricebook_entry_id === null ? {} : { pricebookEntryId: row.pricebook_entry_id }),
    ...(row.pricebook_version === null ? {} : { pricebookVersion: row.pricebook_version }),
    observedAt: row.observed_at,
    ...(row.reconciled_at === null ? {} : { reconciledAt: row.reconciled_at }),
  })
}

export function entryFromStorage(row: {
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
  readonly success: unknown
  readonly classification: unknown
  readonly amount_usd: unknown
  readonly currency: unknown
  readonly pricebook_entry_id: string | null
  readonly pricebook_version: string | null
  readonly observed_at: unknown
  readonly reconciled_at: string | null
}): UsageLedgerEntry {
  return UsageLedgerEntrySchema.parse({
    id: row.id,
    occurredAt: row.occurred_at,
    ...(row.thread_id === null ? {} : { threadId: row.thread_id }),
    ...(row.profile_id === null ? {} : { profileId: row.profile_id }),
    providerFamilyId: row.provider_family_id,
    providerRouteId: row.provider_route_id,
    modelRouteId: row.model_route_id,
    ...(row.connection_id === null ? {} : { connectionId: row.connection_id }),
    wireModelId: row.wire_model_id,
    ...(row.service_tier === null ? {} : { serviceTier: row.service_tier }),
    ...(row.context_tier === null ? {} : { contextTier: row.context_tier }),
    ...(row.region === null ? {} : { region: row.region }),
    billingKind: row.billing_kind,
    tokens: JSON.parse(row.tokens_json) as unknown,
    units: JSON.parse(row.units_json) as unknown,
    cost: costFromStorage(row),
    providerFacts: JSON.parse(row.provider_facts_json) as unknown,
    ...(row.duration_ms === null ? {} : { durationMs: Number(row.duration_ms) }),
    success: row.success === true || row.success === 1 || row.success === 1n,
  })
}

export function factFromEntry(entry: UsageLedgerEntry): UsageEvidenceFact {
  const { cost: _cost, ...fact } = entry
  return fact
}

export const USAGE_COST_CLASSIFICATIONS: readonly CostClassification[] = Object.freeze([
  'estimated',
  'provider_reported',
  'reconciled',
  'subscription',
  'local',
  'unknown',
])

export function summarizeUsageEntries(
  entries: readonly UsageLedgerEntry[],
): UsageEvidenceSummary {
  const observations = Object.fromEntries(USAGE_COST_CLASSIFICATIONS.map(classification => [
    classification,
    { requestCount: 0, amountUsd: null },
  ])) as Record<CostClassification, { requestCount: number; amountUsd: number | null }>
  const tokens = {
    inputTextTokens: 0,
    outputTextTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  }
  for (const entry of entries) {
    const bucket = observations[entry.cost.classification]
    bucket.requestCount += 1
    if (entry.cost.amountUsd !== null) {
      bucket.amountUsd = (bucket.amountUsd ?? 0) + entry.cost.amountUsd
    }
    tokens.inputTextTokens += entry.tokens.inputTextTokens ?? 0
    tokens.outputTextTokens += entry.tokens.outputTextTokens ?? 0
    tokens.cacheReadTokens += entry.tokens.cacheReadTokens ?? 0
    tokens.cacheWriteTokens += entry.tokens.cacheWriteTokens ?? 0
    tokens.reasoningTokens += entry.tokens.reasoningTokens ?? 0
  }
  return { observations, tokens }
}

function validatePriceSnapshot(
  cost: UsageLedgerEntry['cost'],
  pricebookInput?: PricebookEntry,
): PricebookEntry | null {
  if (cost.classification !== 'estimated') {
    if (pricebookInput !== undefined) throw new TypeError('Unexpected pricebook snapshot.')
    return null
  }
  if (pricebookInput === undefined) throw new TypeError('Estimated cost requires price evidence.')
  const pricebook = PricebookEntrySchema.parse(pricebookInput)
  if (pricebook.id !== cost.pricebookEntryId || pricebook.version !== cost.pricebookVersion) {
    throw new TypeError('Estimated cost price evidence does not match its reference.')
  }
  return pricebook
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Evidence contains a non-finite number.')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => (
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`
    )).join(',')}}`
  }
  throw new TypeError('Evidence contains an unsupported value.')
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}
