import { createHash } from 'node:crypto'
import { ACCESS_GRANT_EVALUATOR_VERSION } from './access-grant-evaluator.js'
import {
  ACCESS_GRANT_OPAQUE_ID_PATTERN,
  type AccessConsent,
  type PreparedTextReadTarget,
} from './access-grant-store.js'
import type { ProtectedSourceSearchResult } from './protected-source-search.js'
import {
  SOURCE_UTF8_SEARCH_MAX_CONTEXT_BYTES,
  SOURCE_UTF8_SEARCH_MAX_MATCHES,
  SOURCE_UTF8_SEARCH_MAX_QUERY_BYTES,
  type SourceUtf8SearchMatchMode,
} from './source-byte-store.js'

export const EVIDENCE_SEARCH_CACHE_MAX_ENTRIES = 128
export const EVIDENCE_SEARCH_CACHE_MAX_RETAINED_BYTES = 4 * 1024 * 1024
export const EVIDENCE_SEARCH_CACHE_MAX_ENTRIES_PER_WORKSPACE = 64
export const EVIDENCE_SEARCH_CACHE_MAX_RETAINED_BYTES_PER_WORKSPACE = 2 * 1024 * 1024
export const EVIDENCE_SEARCH_CACHE_MAX_ENTRIES_PER_PROFILE = 32
export const EVIDENCE_SEARCH_CACHE_MAX_RETAINED_BYTES_PER_PROFILE = 1024 * 1024
export const EVIDENCE_SEARCH_CACHE_TTL_MS = 30_000
export const EVIDENCE_SEARCH_CACHE_KEY_VERSION = 'evidence_search_cache.v1' as const
const EVIDENCE_SEARCH_CACHE_DOMAIN = 'source_evidence_search' as const

export interface EvidenceSearchCacheKey {
  readonly grantId: string
  readonly grantRevision: number
  readonly grantExpiresAt: number
  readonly evaluatorVersion: typeof ACCESS_GRANT_EVALUATOR_VERSION
  readonly workspaceId: string
  readonly profileId: string
  readonly subjectId: string
  readonly purpose: string
  readonly channel: string | null
  readonly consent: AccessConsent
  readonly permissionMode: 'auto' | 'ask' | 'deny' | 'allowlist'
  readonly operation: 'source_content.search'
  readonly resourceId: string
  readonly sourceId: string
  readonly sourceVersionId: string
  readonly sourceRevision: number
  readonly sourceChecksum: string
  readonly resourceChecksum: string
  readonly preparationJobId: string
  readonly objectKey: string
  readonly expectedByteCount: number
  readonly classification: PreparedTextReadTarget['classification']
  readonly authority: PreparedTextReadTarget['authority']
  readonly audiencePolicyRef: string
  readonly sensitivityPolicyRef: string
  readonly purposePolicyRef: string
  readonly retentionPolicyRef: string
  readonly freshnessPolicyRef: string
  readonly query: string
  readonly matchMode: SourceUtf8SearchMatchMode
  readonly maxMatches: number
  readonly contextBytes: number
}

export interface EvidenceSearchCacheLimits {
  readonly maxEntries?: number
  readonly maxRetainedBytes?: number
  readonly maxEntriesPerWorkspace?: number
  readonly maxRetainedBytesPerWorkspace?: number
  readonly maxEntriesPerProfile?: number
  readonly maxRetainedBytesPerProfile?: number
  readonly ttlMs?: number
  readonly clock?: () => number
}

export interface EvidenceSearchCacheInventory {
  readonly entries: number
  readonly retainedBytes: number
}

export interface EvidenceSearchCacheScope {
  readonly workspaceId: string
  readonly profileId: string
}

export interface EvidenceSearchCacheSourceScope extends EvidenceSearchCacheScope {
  readonly sourceId: string
}

export interface EvidenceSearchCacheResourceScope extends EvidenceSearchCacheScope {
  readonly resourceId: string
}

export interface EvidenceSearchCacheGrantScope extends EvidenceSearchCacheScope {
  readonly grantId: string
}

interface CacheEntry {
  readonly key: Readonly<EvidenceSearchCacheKey>
  readonly value: Readonly<ProtectedSourceSearchResult>
  readonly retainedBytes: number
  readonly expiresAt: number
}

export class EvidenceSearchCache {
  private readonly entries = new Map<string, CacheEntry>()
  private readonly maxEntries: number
  private readonly maxRetainedBytes: number
  private readonly maxEntriesPerWorkspace: number
  private readonly maxRetainedBytesPerWorkspace: number
  private readonly maxEntriesPerProfile: number
  private readonly maxRetainedBytesPerProfile: number
  private readonly ttlMs: number
  private readonly clock: () => number
  private retainedBytes = 0

  constructor(limits: EvidenceSearchCacheLimits = {}) {
    this.maxEntries = positiveLimit(limits.maxEntries, EVIDENCE_SEARCH_CACHE_MAX_ENTRIES)
    this.maxRetainedBytes = positiveLimit(
      limits.maxRetainedBytes, EVIDENCE_SEARCH_CACHE_MAX_RETAINED_BYTES,
    )
    this.maxEntriesPerWorkspace = positiveLimit(
      limits.maxEntriesPerWorkspace, EVIDENCE_SEARCH_CACHE_MAX_ENTRIES_PER_WORKSPACE,
    )
    this.maxRetainedBytesPerWorkspace = positiveLimit(
      limits.maxRetainedBytesPerWorkspace,
      EVIDENCE_SEARCH_CACHE_MAX_RETAINED_BYTES_PER_WORKSPACE,
    )
    this.maxEntriesPerProfile = positiveLimit(
      limits.maxEntriesPerProfile, EVIDENCE_SEARCH_CACHE_MAX_ENTRIES_PER_PROFILE,
    )
    this.maxRetainedBytesPerProfile = positiveLimit(
      limits.maxRetainedBytesPerProfile,
      EVIDENCE_SEARCH_CACHE_MAX_RETAINED_BYTES_PER_PROFILE,
    )
    this.ttlMs = positiveLimit(limits.ttlMs, EVIDENCE_SEARCH_CACHE_TTL_MS)
    this.clock = limits.clock ?? Date.now
  }

  get(key: EvidenceSearchCacheKey): Readonly<ProtectedSourceSearchResult> | null {
    const normalized = normalizeKey(key)
    const now = safeNow(this.clock)
    if (now === null) {
      this.clear()
      return null
    }
    this.pruneExpired(now)
    if (!normalized) return null
    const id = serializeKey(normalized)
    const entry = this.entries.get(id)
    if (!entry) return null
    if (!validEntry(entry, normalized, now)) {
      this.remove(id, entry)
      return null
    }
    return entry.value
  }

  put(key: EvidenceSearchCacheKey, result: ProtectedSourceSearchResult): boolean {
    const normalized = normalizeKey(key)
    const now = safeNow(this.clock)
    if (now === null) {
      this.clear()
      return false
    }
    if (!normalized || normalized.grantExpiresAt <= now) return false
    const expiresAtByTtl = now + this.ttlMs
    const expiresAt = Math.min(expiresAtByTtl, normalized.grantExpiresAt)
    if (!Number.isSafeInteger(expiresAtByTtl) || !Number.isSafeInteger(expiresAt) ||
        expiresAt <= now) return false
    const value = snapshotResult(result, now)
    if (!value || !resultMatchesKey(value, normalized)) return false
    const retainedBytes = Buffer.byteLength(serializeEntry(normalized, value), 'utf8')
    if (retainedBytes > this.maxRetainedBytes ||
        retainedBytes > this.maxRetainedBytesPerWorkspace ||
        retainedBytes > this.maxRetainedBytesPerProfile) return false

    this.pruneExpired(now)
    const id = serializeKey(normalized)
    const replaced = this.entries.get(id)
    if (replaced) this.remove(id, replaced)
    this.evictScope(normalized, retainedBytes, 'profile')
    this.evictScope(normalized, retainedBytes, 'workspace')
    while (this.entries.size + 1 > this.maxEntries ||
        this.retainedBytes + retainedBytes > this.maxRetainedBytes) {
      if (!this.removeOldest(() => true)) return false
    }
    const entry = deepFreeze({
      key: normalized,
      value,
      retainedBytes,
      expiresAt,
    })
    this.entries.set(id, entry)
    this.retainedBytes += retainedBytes
    return true
  }

  invalidateSource(scope: EvidenceSearchCacheSourceScope): EvidenceSearchCacheInventory {
    this.prepareOperation()
    const removed = this.removeMatching((entry) => scoped(entry, scope) &&
      entry.key.sourceId === scope.sourceId)
    return removed
  }

  invalidateResource(scope: EvidenceSearchCacheResourceScope): EvidenceSearchCacheInventory {
    this.prepareOperation()
    const removed = this.removeMatching((entry) => scoped(entry, scope) &&
      entry.key.resourceId === scope.resourceId)
    return removed
  }

  invalidateGrant(scope: EvidenceSearchCacheGrantScope): EvidenceSearchCacheInventory {
    this.prepareOperation()
    const removed = this.removeMatching((entry) => scoped(entry, scope) &&
      entry.key.grantId === scope.grantId)
    return removed
  }

  inventoryAll(): EvidenceSearchCacheInventory {
    this.prepareOperation()
    const inventory = this.calculateInventory(() => true)
    return inventory
  }

  clear(): EvidenceSearchCacheInventory {
    return this.removeMatching(() => true)
  }

  inventorySource(scope: EvidenceSearchCacheSourceScope): EvidenceSearchCacheInventory {
    this.prepareOperation()
    const inventory = this.calculateInventory((entry) => scoped(entry, scope) &&
      entry.key.sourceId === scope.sourceId)
    return inventory
  }

  inventoryResource(scope: EvidenceSearchCacheResourceScope): EvidenceSearchCacheInventory {
    this.prepareOperation()
    const inventory = this.calculateInventory((entry) => scoped(entry, scope) &&
      entry.key.resourceId === scope.resourceId)
    return inventory
  }

  inventoryGrant(scope: EvidenceSearchCacheGrantScope): EvidenceSearchCacheInventory {
    this.prepareOperation()
    const inventory = this.calculateInventory((entry) => scoped(entry, scope) &&
      entry.key.grantId === scope.grantId)
    return inventory
  }

  private prepareOperation(): number | null {
    const now = safeNow(this.clock)
    if (now === null) {
      this.clear()
      return null
    }
    this.pruneExpired(now)
    return now
  }

  private evictScope(
    key: Readonly<EvidenceSearchCacheKey>,
    incomingBytes: number,
    tier: 'profile' | 'workspace',
  ): void {
    const matches = tier === 'profile'
      ? (entry: CacheEntry) => entry.key.workspaceId === key.workspaceId &&
        entry.key.profileId === key.profileId
      : (entry: CacheEntry) => entry.key.workspaceId === key.workspaceId
    const maxEntries = tier === 'profile'
      ? this.maxEntriesPerProfile : this.maxEntriesPerWorkspace
    const maxBytes = tier === 'profile'
      ? this.maxRetainedBytesPerProfile : this.maxRetainedBytesPerWorkspace
    let usage = this.calculateInventory(matches)
    while (usage.entries + 1 > maxEntries || usage.retainedBytes + incomingBytes > maxBytes) {
      if (!this.removeOldest(matches)) return
      usage = this.calculateInventory(matches)
    }
  }

  private pruneExpired(now: number): void {
    this.removeMatching((entry) => now >= entry.expiresAt)
  }

  private removeOldest(matches: (entry: CacheEntry) => boolean): boolean {
    for (const [id, entry] of this.entries) {
      if (!matches(entry)) continue
      this.remove(id, entry)
      return true
    }
    return false
  }

  private removeMatching(matches: (entry: CacheEntry) => boolean): EvidenceSearchCacheInventory {
    let removedEntries = 0
    let removedBytes = 0
    for (const [id, entry] of this.entries) {
      if (!matches(entry)) continue
      this.remove(id, entry)
      removedEntries += 1
      removedBytes += entry.retainedBytes
    }
    return { entries: removedEntries, retainedBytes: removedBytes }
  }

  private calculateInventory(
    matches: (entry: CacheEntry) => boolean,
  ): EvidenceSearchCacheInventory {
    let count = 0
    let bytes = 0
    for (const entry of this.entries.values()) {
      if (!matches(entry)) continue
      count += 1
      bytes += entry.retainedBytes
    }
    return { entries: count, retainedBytes: bytes }
  }

  private remove(id: string, entry: CacheEntry): void {
    if (!this.entries.delete(id)) return
    this.retainedBytes -= entry.retainedBytes
  }
}

function normalizeKey(key: EvidenceSearchCacheKey): Readonly<EvidenceSearchCacheKey> | null {
  if (!key || typeof key !== 'object' || key.operation !== 'source_content.search' ||
      key.evaluatorVersion !== ACCESS_GRANT_EVALUATOR_VERSION ||
      !validScope(key.grantId) || !validScope(key.workspaceId) ||
      !validScope(key.profileId) || !validScope(key.subjectId) ||
      !validScope(key.purpose) || !(key.channel === null || validScope(key.channel)) ||
      !validScope(key.resourceId) || !validScope(key.sourceId) ||
      !validScope(key.sourceVersionId) || !validScope(key.preparationJobId) ||
      !validConsent(key.consent) ||
      !['auto', 'ask', 'deny', 'allowlist'].includes(key.permissionMode) ||
      !Number.isSafeInteger(key.grantRevision) || key.grantRevision < 1 ||
      !Number.isSafeInteger(key.grantExpiresAt) || key.grantExpiresAt < 1 ||
      !Number.isSafeInteger(key.sourceRevision) || key.sourceRevision < 1 ||
      !Number.isSafeInteger(key.expectedByteCount) || key.expectedByteCount < 1 ||
      !validChecksum(key.sourceChecksum) || !validChecksum(key.resourceChecksum) ||
      !validObjectKey(key.objectKey) || !validPolicyRef(key.audiencePolicyRef) ||
      !validPolicyRef(key.sensitivityPolicyRef) || !validPolicyRef(key.purposePolicyRef) ||
      !validPolicyRef(key.retentionPolicyRef) || !validPolicyRef(key.freshnessPolicyRef) ||
      !['public', 'internal', 'confidential', 'restricted'].includes(key.classification) ||
      !['source_of_record', 'supporting_reference', 'example'].includes(key.authority) ||
      !validQuery(key.query, key.matchMode) ||
      !Number.isSafeInteger(key.maxMatches) || key.maxMatches < 1 ||
      key.maxMatches > SOURCE_UTF8_SEARCH_MAX_MATCHES ||
      !Number.isSafeInteger(key.contextBytes) || key.contextBytes < 0 ||
      key.contextBytes > SOURCE_UTF8_SEARCH_MAX_CONTEXT_BYTES) return null
  return deepFreeze({
    grantId: key.grantId,
    grantRevision: key.grantRevision,
    grantExpiresAt: key.grantExpiresAt,
    evaluatorVersion: key.evaluatorVersion,
    workspaceId: key.workspaceId,
    profileId: key.profileId,
    subjectId: key.subjectId,
    purpose: key.purpose,
    channel: key.channel,
    consent: key.consent.state === 'recorded'
      ? { state: 'recorded', evidenceId: key.consent.evidenceId }
      : { state: 'not_required' },
    permissionMode: key.permissionMode,
    operation: key.operation,
    resourceId: key.resourceId,
    sourceId: key.sourceId,
    sourceVersionId: key.sourceVersionId,
    sourceRevision: key.sourceRevision,
    sourceChecksum: key.sourceChecksum,
    resourceChecksum: key.resourceChecksum,
    preparationJobId: key.preparationJobId,
    objectKey: key.objectKey,
    expectedByteCount: key.expectedByteCount,
    classification: key.classification,
    authority: key.authority,
    audiencePolicyRef: key.audiencePolicyRef,
    sensitivityPolicyRef: key.sensitivityPolicyRef,
    purposePolicyRef: key.purposePolicyRef,
    retentionPolicyRef: key.retentionPolicyRef,
    freshnessPolicyRef: key.freshnessPolicyRef,
    query: canonicalQuery(key.query, key.matchMode),
    matchMode: key.matchMode,
    maxMatches: key.maxMatches,
    contextBytes: key.contextBytes,
  })
}

function snapshotResult(
  result: ProtectedSourceSearchResult,
  now: number,
): Readonly<ProtectedSourceSearchResult> | null {
  if (!result || typeof result !== 'object' || !Array.isArray(result.matches)) return null
  const matches = result.matches.map((match) => ({
    evidenceId: match.evidenceId,
    text: match.text,
    byteStart: match.byteStart,
    byteEnd: match.byteEnd,
    matchByteStart: match.matchByteStart,
    matchByteEnd: match.matchByteEnd,
  }))
  const snapshot: ProtectedSourceSearchResult = {
    resourceId: result.resourceId,
    sourceId: result.sourceId,
    sourceVersionId: result.sourceVersionId,
    sourceRevision: result.sourceRevision,
    sourceChecksum: result.sourceChecksum,
    resourceChecksum: result.resourceChecksum,
    freshness: result.freshness,
    classification: result.classification,
    authority: result.authority,
    status: result.status,
    matchMode: result.matchMode,
    matches,
    truncated: result.truncated,
    totalByteCount: result.totalByteCount,
    observedAt: result.observedAt,
  }
  return validResult(snapshot, now) ? deepFreeze(snapshot) : null
}

function resultMatchesKey(
  result: Readonly<ProtectedSourceSearchResult>,
  key: Readonly<EvidenceSearchCacheKey>,
): boolean {
  return result.resourceId === key.resourceId && result.sourceId === key.sourceId &&
    result.sourceVersionId === key.sourceVersionId &&
    result.sourceRevision === key.sourceRevision &&
    result.sourceChecksum === key.sourceChecksum &&
    result.resourceChecksum === key.resourceChecksum &&
    result.totalByteCount === key.expectedByteCount && result.freshness === 'current' &&
    result.classification === key.classification && result.authority === key.authority &&
    result.matchMode === key.matchMode && result.matches.length <= key.maxMatches &&
    result.matches.every((match) => match.evidenceId === evidenceId(key, match))
}

function validResult(result: ProtectedSourceSearchResult, now = Number.MAX_SAFE_INTEGER): boolean {
  if (!validScope(result.resourceId) || !validScope(result.sourceId) ||
      !validScope(result.sourceVersionId) ||
      !Number.isSafeInteger(result.sourceRevision) || result.sourceRevision < 1 ||
      !validChecksum(result.sourceChecksum) || !validChecksum(result.resourceChecksum) ||
      result.freshness !== 'current' ||
      !['public', 'internal', 'confidential', 'restricted'].includes(result.classification) ||
      !['source_of_record', 'supporting_reference', 'example'].includes(result.authority) ||
      !['complete', 'no_matches'].includes(result.status) ||
      !['exact_utf8', 'ascii_case_insensitive'].includes(result.matchMode) ||
      typeof result.truncated !== 'boolean' ||
      !Number.isSafeInteger(result.totalByteCount) || result.totalByteCount < 1 ||
      !Number.isSafeInteger(result.observedAt) || result.observedAt < 0 ||
      result.observedAt > now ||
      result.matches.length > SOURCE_UTF8_SEARCH_MAX_MATCHES ||
      (result.status === 'no_matches') !== (result.matches.length === 0) ||
      (result.status === 'no_matches' && result.truncated)) return false
  return result.matches.every((match) =>
    validChecksum(match.evidenceId) && typeof match.text === 'string' &&
    Buffer.from(match.text, 'utf8').toString('utf8') === match.text &&
    Number.isSafeInteger(match.byteStart) && match.byteStart >= 0 &&
    Number.isSafeInteger(match.byteEnd) && match.byteStart < match.byteEnd &&
    match.byteEnd <= result.totalByteCount &&
    Buffer.byteLength(match.text, 'utf8') === match.byteEnd - match.byteStart &&
    Number.isSafeInteger(match.matchByteStart) &&
    match.matchByteStart >= match.byteStart &&
    Number.isSafeInteger(match.matchByteEnd) &&
    match.matchByteStart < match.matchByteEnd && match.matchByteEnd <= match.byteEnd,
  )
}

function validEntry(
  entry: CacheEntry,
  expectedKey: Readonly<EvidenceSearchCacheKey>,
  now: number,
): boolean {
  try {
    return Number.isSafeInteger(entry.retainedBytes) && entry.retainedBytes > 0 &&
      Number.isSafeInteger(entry.expiresAt) && entry.expiresAt > 0 &&
      serializeKey(entry.key) === serializeKey(expectedKey) &&
      entry.expiresAt > now && resultMatchesKey(entry.value, entry.key) &&
      validResult(entry.value, now) &&
      entry.retainedBytes === Buffer.byteLength(serializeEntry(entry.key, entry.value), 'utf8')
  } catch {
    return false
  }
}

function serializeKey(key: Readonly<EvidenceSearchCacheKey>): string {
  return JSON.stringify(keyTuple(key))
}

function serializeEntry(
  key: Readonly<EvidenceSearchCacheKey>,
  value: Readonly<ProtectedSourceSearchResult>,
): string {
  return JSON.stringify([keyTuple(key), resultTuple(value)])
}

function keyTuple(key: Readonly<EvidenceSearchCacheKey>): readonly unknown[] {
  return [
    EVIDENCE_SEARCH_CACHE_DOMAIN, EVIDENCE_SEARCH_CACHE_KEY_VERSION,
    key.grantId, key.grantRevision, key.grantExpiresAt, key.evaluatorVersion,
    key.workspaceId, key.profileId, key.subjectId, key.purpose, key.channel,
    key.consent.state, key.consent.state === 'recorded' ? key.consent.evidenceId : null,
    key.permissionMode, key.operation, key.resourceId, key.sourceId,
    key.sourceVersionId, key.sourceRevision, key.sourceChecksum, key.resourceChecksum,
    key.preparationJobId, key.objectKey, key.expectedByteCount, key.classification,
    key.authority, key.audiencePolicyRef, key.sensitivityPolicyRef,
    key.purposePolicyRef, key.retentionPolicyRef, key.freshnessPolicyRef,
    key.query, key.matchMode, key.maxMatches, key.contextBytes,
  ]
}

function resultTuple(value: Readonly<ProtectedSourceSearchResult>): readonly unknown[] {
  return [
    value.resourceId, value.sourceId, value.sourceVersionId, value.sourceRevision,
    value.sourceChecksum, value.resourceChecksum, value.freshness,
    value.classification, value.authority, value.status, value.matchMode,
    value.matches.map((match) => [match.evidenceId, match.text, match.byteStart,
      match.byteEnd, match.matchByteStart, match.matchByteEnd]),
    value.truncated, value.totalByteCount, value.observedAt,
  ]
}

function canonicalQuery(query: string, mode: SourceUtf8SearchMatchMode): string {
  return mode === 'ascii_case_insensitive' ? query.toLowerCase() : query
}

function validQuery(query: string, mode: SourceUtf8SearchMatchMode): boolean {
  if (mode !== 'exact_utf8' && mode !== 'ascii_case_insensitive') return false
  const encoded = Buffer.from(query, 'utf8')
  if (encoded.length < 1 || encoded.length > SOURCE_UTF8_SEARCH_MAX_QUERY_BYTES ||
      encoded.toString('utf8') !== query || query.trim() !== query ||
      /[\u0000-\u001f\u007f]/u.test(query)) return false
  return mode !== 'ascii_case_insensitive' || /^[\x20-\x7e]+$/.test(query)
}

function validScope(value: string): boolean {
  return typeof value === 'string' && ACCESS_GRANT_OPAQUE_ID_PATTERN.test(value)
}

function validPolicyRef(value: string): boolean {
  return validScope(value)
}

function validConsent(value: AccessConsent): boolean {
  return value !== null && typeof value === 'object' &&
    (value.state === 'not_required' ||
      (value.state === 'recorded' && validScope(value.evidenceId)))
}

function validChecksum(value: string): boolean {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value)
}

function evidenceId(
  key: Readonly<EvidenceSearchCacheKey>,
  match: ProtectedSourceSearchResult['matches'][number],
): string {
  const value = [
    'source-search-v1', key.resourceId, key.sourceVersionId,
    key.resourceChecksum, match.byteStart, match.byteEnd,
    match.matchByteStart, match.matchByteEnd,
  ].join('\n')
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function validObjectKey(value: string): boolean {
  return typeof value === 'string' && value.length >= 1 && value.length <= 1_024 &&
    value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value)
}

function scoped(entry: CacheEntry, scope: EvidenceSearchCacheScope): boolean {
  return entry.key.workspaceId === scope.workspaceId &&
    entry.key.profileId === scope.profileId
}

function positiveLimit(value: number | undefined, fallback: number): number {
  const selected = value ?? fallback
  if (!Number.isSafeInteger(selected) || selected < 1) {
    throw new TypeError('Evidence search cache limits must be positive safe integers')
  }
  return selected
}

function safeNow(clock: () => number): number | null {
  try {
    const value = clock()
    return Number.isSafeInteger(value) && value >= 0 ? value : null
  } catch {
    return null
  }
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}
