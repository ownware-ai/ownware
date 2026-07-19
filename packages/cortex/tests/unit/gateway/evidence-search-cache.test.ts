import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  EvidenceSearchCache,
  type EvidenceSearchCacheKey,
  type EvidenceSearchCacheLimits,
} from '../../../src/gateway/evidence-search-cache.js'
import type { ProtectedSourceSearchResult } from '../../../src/gateway/protected-source-search.js'

describe('EvidenceSearchCache', () => {
  it('returns only an exact verified search candidate', () => {
    const cache = createCache()
    const key = cacheKey()
    const result = searchResult()

    expect(cache.put(key, result)).toBe(true)
    expect(cache.get(key)).toEqual(result)
    expect(cache.get({ ...key, subjectId: 'person.synthetic-2' })).toBeNull()
    expect(cache.get({ ...key, query: 'different' })).toBeNull()
  })

  it('binds every authority, lineage, policy, consent and parameter dimension', () => {
    const cache = createCache()
    const key = cacheKey()
    expect(cache.put(key, searchResult())).toBe(true)

    const variants: EvidenceSearchCacheKey[] = [
      { ...key, grantId: 'grant.synthetic-2' },
      { ...key, grantRevision: 2 },
      { ...key, grantExpiresAt: 10_001 },
      { ...key, evaluatorVersion: 'access_grant.v2' as 'access_grant.v1' },
      { ...key, workspaceId: 'workspace.other' },
      { ...key, profileId: 'other' },
      { ...key, subjectId: 'person.synthetic-2' },
      { ...key, purpose: 'sales_support' },
      { ...key, channel: null },
      { ...key, consent: { state: 'recorded', evidenceId: 'consent.synthetic-1' } },
      { ...key, permissionMode: 'ask' },
      { ...key, operation: 'source_content.read' as 'source_content.search' },
      { ...key, resourceId: 'resource.synthetic-2' },
      { ...key, sourceId: 'source.synthetic-2' },
      { ...key, sourceVersionId: 'version.synthetic-2' },
      { ...key, sourceRevision: 4 },
      { ...key, sourceChecksum: checksum('other-source') },
      { ...key, resourceChecksum: checksum('other-resource') },
      { ...key, preparationJobId: 'job.synthetic-2' },
      { ...key, objectKey: 'sources/source.synthetic-1/derived/other/content' },
      { ...key, expectedByteCount: 7 },
      { ...key, classification: 'confidential' },
      { ...key, authority: 'source_of_record' },
      { ...key, audiencePolicyRef: 'policy.audience-2' },
      { ...key, sensitivityPolicyRef: 'policy.sensitivity-2' },
      { ...key, purposePolicyRef: 'policy.purpose-2' },
      { ...key, retentionPolicyRef: 'policy.retention-2' },
      { ...key, freshnessPolicyRef: 'policy.freshness-2' },
      { ...key, query: 'needle' },
      { ...key, matchMode: 'ascii_case_insensitive' },
      { ...key, maxMatches: 4 },
      { ...key, contextBytes: 9 },
    ]
    for (const variant of variants) expect(cache.get(variant)).toBeNull()
    expect(cache.get(key)).not.toBeNull()

    const foldedKey = cacheKey({ query: 'Needle', matchMode: 'ascii_case_insensitive' })
    const foldedResult = searchResult({ matchMode: 'ascii_case_insensitive' })
    expect(cache.put(foldedKey, foldedResult)).toBe(true)
    expect(cache.get({ ...foldedKey, query: 'needle' })).toEqual(foldedResult)
  })

  it('stores an allowlisted immutable snapshot and rejects malformed evidence', () => {
    const cache = createCache()
    const key = cacheKey()
    const supplied = Object.assign(searchResult(), { privateCanary: 'never-retain-me' })
    expect(cache.put(key, supplied)).toBe(true)
    ;(supplied.matches as Array<{ text: string }>)[0]!.text = 'mutated'
    const hit = cache.get(key)!
    expect(hit.matches[0]?.text).toBe('Needle')
    expect(JSON.stringify(hit)).not.toContain('never-retain-me')
    expect(Object.isFrozen(hit)).toBe(true)
    expect(Object.isFrozen(hit.matches)).toBe(true)
    expect(Object.isFrozen(hit.matches[0])).toBe(true)
    expect(() => {
      ;(hit.matches as Array<{ text: string }>)[0]!.text = 'changed'
    }).toThrow()

    const noMatch = searchResult({ status: 'no_matches', matches: [] })
    expect(cache.put({ ...key, query: 'absent' }, noMatch)).toBe(true)
    expect(cache.put({ ...key, query: 'bad-status' }, {
      ...noMatch, status: 'complete',
    })).toBe(false)
    expect(cache.put({ ...key, query: 'bad-truncation' }, {
      ...noMatch, truncated: true,
    })).toBe(false)
    expect(cache.put({ ...key, query: 'future' }, searchResult({ observedAt: 201 }))).toBe(false)
    expect(cache.put({ ...key, query: 'bad-evidence' }, searchResult({
      matches: [{ ...searchResult().matches[0]!, evidenceId: checksum('forged') }],
    }))).toBe(false)
    expect(cache.put({ ...key, query: 'bad-range' }, searchResult({
      matches: [{ ...searchResult().matches[0]!, byteEnd: 7 }],
    }))).toBe(false)
    expect(cache.put({ ...key, query: 'wrong-resource' }, searchResult({
      resourceId: 'resource.synthetic-2',
    }))).toBe(false)
  })

  it('expires exclusively at the earlier grant or cache deadline without sliding', () => {
    let now = 200
    const byGrant = createCache({ ttlMs: 1_000, clock: () => now })
    const grantKey = cacheKey({ grantExpiresAt: 250 })
    expect(byGrant.put(grantKey, searchResult())).toBe(true)
    now = 249
    expect(byGrant.get(grantKey)).not.toBeNull()
    now = 250
    expect(byGrant.get(grantKey)).toBeNull()
    expect(byGrant.inventoryAll()).toEqual({ entries: 0, retainedBytes: 0 })
    expect(byGrant.put(cacheKey({ grantExpiresAt: 250 }), searchResult())).toBe(false)

    now = 200
    const byTtl = createCache({ ttlMs: 100, clock: () => now })
    const ttlKey = cacheKey()
    expect(byTtl.put(ttlKey, searchResult())).toBe(true)
    now = 250
    expect(byTtl.get(ttlKey)).not.toBeNull()
    now = 300
    expect(byTtl.inventorySource(scopeFor(ttlKey))).toEqual({
      entries: 0, retainedBytes: 0,
    })
    expect(byTtl.get(ttlKey)).toBeNull()

    let clockFails = false
    const brokenClock = createCache({
      clock: () => {
        if (clockFails) throw new Error('clock unavailable')
        return 200
      },
    })
    expect(brokenClock.put(ttlKey, searchResult())).toBe(true)
    clockFails = true
    expect(brokenClock.inventoryAll()).toEqual({ entries: 0, retainedBytes: 0 })
  })

  it('accounts for the full UTF-8 tuple, replacement, and nondestructive oversize rejection', () => {
    const ascii = createCache()
    const asciiPair = pair('ascii', { query: 'x' }, { text: 'x' })
    expect(ascii.put(asciiPair.key, asciiPair.result)).toBe(true)
    const asciiBytes = ascii.inventoryAll().retainedBytes

    const unicode = createCache()
    const unicodePair = pair('unicode', { query: 'é' }, { text: 'é' })
    expect(unicode.put(unicodePair.key, unicodePair.result)).toBe(true)
    const unicodeBytes = unicode.inventoryAll().retainedBytes
    expect(unicodeBytes).toBe(asciiBytes + 2)

    const beforeReplacement = unicode.inventoryAll()
    const replacement = { ...unicodePair.result, status: 'no_matches' as const, matches: [] }
    expect(unicode.put(unicodePair.key, replacement)).toBe(true)
    expect(unicode.inventoryAll().entries).toBe(1)
    expect(unicode.inventoryAll().retainedBytes).toBeLessThan(beforeReplacement.retainedBytes)

    const protectedEntry = pair('protected')
    const probe = createCache()
    expect(probe.put(protectedEntry.key, protectedEntry.result)).toBe(true)
    const exactBudget = probe.inventoryAll().retainedBytes
    const bounded = createCache({
      maxRetainedBytes: exactBudget,
      maxRetainedBytesPerWorkspace: exactBudget,
      maxRetainedBytesPerProfile: exactBudget,
    })
    expect(bounded.put(protectedEntry.key, protectedEntry.result)).toBe(true)
    const oversized = pair('oversized', {}, { text: 'z'.repeat(2_000) })
    expect(bounded.put(oversized.key, oversized.result)).toBe(false)
    expect(bounded.get(protectedEntry.key)).not.toBeNull()
    expect(bounded.inventoryAll()).toEqual({ entries: 1, retainedBytes: exactBudget })
  })

  it('applies deterministic profile, workspace, then global FIFO pressure', () => {
    const profileCache = createCache({
      maxEntries: 10, maxEntriesPerWorkspace: 10, maxEntriesPerProfile: 2,
    })
    const unrelated = pair('unrelated', { workspaceId: 'workspace.other', profileId: 'other' })
    const p1 = pair('p1')
    const p2 = pair('p2')
    const p3 = pair('p3')
    for (const item of [unrelated, p1, p2, p3]) expect(profileCache.put(item.key, item.result)).toBe(true)
    expect(profileCache.get(p1.key)).toBeNull()
    expect(profileCache.get(p2.key)).not.toBeNull()
    expect(profileCache.get(p3.key)).not.toBeNull()
    expect(profileCache.get(unrelated.key)).not.toBeNull()

    const workspaceCache = createCache({
      maxEntries: 10, maxEntriesPerWorkspace: 2, maxEntriesPerProfile: 10,
    })
    const w1 = pair('w1', { profileId: 'profile.one' })
    const w2 = pair('w2', { profileId: 'profile.two' })
    const w3 = pair('w3', { profileId: 'profile.three' })
    for (const item of [unrelated, w1, w2, w3]) expect(workspaceCache.put(item.key, item.result)).toBe(true)
    expect(workspaceCache.get(w1.key)).toBeNull()
    expect(workspaceCache.get(w2.key)).not.toBeNull()
    expect(workspaceCache.get(w3.key)).not.toBeNull()
    expect(workspaceCache.get(unrelated.key)).not.toBeNull()

    const globalCache = createCache({
      maxEntries: 2, maxEntriesPerWorkspace: 2, maxEntriesPerProfile: 2,
    })
    for (const item of [unrelated, w1, w2]) expect(globalCache.put(item.key, item.result)).toBe(true)
    expect(globalCache.get(unrelated.key)).toBeNull()
    expect(globalCache.get(w1.key)).not.toBeNull()
    expect(globalCache.get(w2.key)).not.toBeNull()

    const bytePairs = [pair('b1'), pair('b2'), pair('b3')]
    const byteBudget = retainedBytes(bytePairs[1]!) + retainedBytes(bytePairs[2]!)
    const byProfileBytes = createCache({
      maxRetainedBytes: 32 * 1024,
      maxRetainedBytesPerWorkspace: 32 * 1024,
      maxRetainedBytesPerProfile: byteBudget,
      maxEntries: 10, maxEntriesPerWorkspace: 10, maxEntriesPerProfile: 10,
    })
    for (const item of bytePairs) expect(byProfileBytes.put(item.key, item.result)).toBe(true)
    expect(byProfileBytes.get(bytePairs[0]!.key)).toBeNull()
    expect(byProfileBytes.get(bytePairs[1]!.key)).not.toBeNull()
    expect(byProfileBytes.get(bytePairs[2]!.key)).not.toBeNull()

    const workspacePairs = [
      pair('c1', { profileId: 'profile.one' }),
      pair('c2', { profileId: 'profile.two' }),
      pair('c3', { profileId: 'profile.three' }),
    ]
    const workspaceByteBudget = retainedBytes(workspacePairs[1]!) + retainedBytes(workspacePairs[2]!)
    const byWorkspaceBytes = createCache({
      maxRetainedBytes: 32 * 1024,
      maxRetainedBytesPerWorkspace: workspaceByteBudget,
      maxRetainedBytesPerProfile: 32 * 1024,
      maxEntries: 10, maxEntriesPerWorkspace: 10, maxEntriesPerProfile: 10,
    })
    for (const item of workspacePairs) expect(byWorkspaceBytes.put(item.key, item.result)).toBe(true)
    expect(byWorkspaceBytes.get(workspacePairs[0]!.key)).toBeNull()

    const globalPairs = [
      pair('g1', { workspaceId: 'workspace.one', profileId: 'profile.one' }),
      pair('g2', { workspaceId: 'workspace.two', profileId: 'profile.two' }),
      pair('g3', { workspaceId: 'workspace.three', profileId: 'profile.three' }),
    ]
    const globalByteBudget = retainedBytes(globalPairs[1]!) + retainedBytes(globalPairs[2]!)
    const byGlobalBytes = createCache({
      maxRetainedBytes: globalByteBudget,
      maxRetainedBytesPerWorkspace: 32 * 1024,
      maxRetainedBytesPerProfile: 32 * 1024,
      maxEntries: 10, maxEntriesPerWorkspace: 10, maxEntriesPerProfile: 10,
    })
    for (const item of globalPairs) expect(byGlobalBytes.put(item.key, item.result)).toBe(true)
    expect(byGlobalBytes.get(globalPairs[0]!.key)).toBeNull()
  })

  it('counts, clears and invalidates only the exact workspace/profile scope', () => {
    const cache = createCache({ maxEntries: 10, maxEntriesPerWorkspace: 10,
      maxEntriesPerProfile: 10 })
    const first = pair('first')
    const second = pair('second')
    const otherProfile = pair('other-profile', { profileId: 'other' })
    for (const item of [first, second, otherProfile]) expect(cache.put(item.key, item.result)).toBe(true)

    const sourceScope = scopeFor(first.key)
    expect(cache.inventorySource(sourceScope).entries).toBe(2)
    expect(cache.inventoryResource({ ...sourceScope, resourceId: first.key.resourceId }).entries)
      .toBe(2)
    expect(cache.inventoryGrant({ ...sourceScope, grantId: first.key.grantId }).entries).toBe(2)
    expect(cache.invalidateSource({ ...sourceScope, profileId: 'missing' }))
      .toEqual({ entries: 0, retainedBytes: 0 })
    const removed = cache.invalidateGrant({ ...sourceScope, grantId: first.key.grantId })
    expect(removed.entries).toBe(2)
    expect(removed.retainedBytes).toBeGreaterThan(0)
    expect(cache.invalidateGrant({ ...sourceScope, grantId: first.key.grantId }))
      .toEqual({ entries: 0, retainedBytes: 0 })
    expect(cache.get(otherProfile.key)).not.toBeNull()
    expect(cache.clear().entries).toBe(1)
    expect(cache.clear()).toEqual({ entries: 0, retainedBytes: 0 })
  })

  it('treats a corrupt retained snapshot as a miss and evicts it', () => {
    const cache = createCache()
    const key = cacheKey()
    expect(cache.put(key, searchResult())).toBe(true)
    const storage = cache as unknown as {
      entries: Map<string, {
        key: EvidenceSearchCacheKey
        value: ProtectedSourceSearchResult
        retainedBytes: number
        expiresAt: number
      }>
    }
    const [id, entry] = [...storage.entries.entries()][0]!
    storage.entries.set(id, {
      ...entry,
      value: { ...entry.value, matches: null } as unknown as ProtectedSourceSearchResult,
    })
    expect(cache.get(key)).toBeNull()
    expect(cache.inventoryAll()).toEqual({ entries: 0, retainedBytes: 0 })
  })
})

function createCache(overrides: EvidenceSearchCacheLimits = {}): EvidenceSearchCache {
  return new EvidenceSearchCache({
    maxEntries: 3,
    maxRetainedBytes: 16 * 1024,
    maxEntriesPerWorkspace: 2,
    maxRetainedBytesPerWorkspace: 12 * 1024,
    maxEntriesPerProfile: 2,
    maxRetainedBytesPerProfile: 8 * 1024,
    ttlMs: 1_000,
    clock: () => 200,
    ...overrides,
  })
}

function cacheKey(overrides: Partial<EvidenceSearchCacheKey> = {}): EvidenceSearchCacheKey {
  return {
    grantId: 'grant.synthetic-1',
    grantRevision: 1,
    grantExpiresAt: 10_000,
    evaluatorVersion: 'access_grant.v1',
    workspaceId: 'workspace.test',
    profileId: 'assistant',
    subjectId: 'person.synthetic-1',
    purpose: 'customer_support',
    channel: 'web.primary',
    consent: { state: 'not_required' },
    permissionMode: 'auto',
    operation: 'source_content.search',
    resourceId: 'resource.synthetic-1',
    sourceId: 'source.synthetic-1',
    sourceVersionId: 'version.synthetic-1',
    sourceRevision: 3,
    sourceChecksum: checksum('source'),
    resourceChecksum: checksum('resource'),
    preparationJobId: 'job.synthetic-1',
    objectKey: 'sources/source.synthetic-1/derived/resource.synthetic-1/content',
    expectedByteCount: 6,
    classification: 'internal',
    authority: 'supporting_reference',
    audiencePolicyRef: 'policy.audience-1',
    sensitivityPolicyRef: 'policy.sensitivity-1',
    purposePolicyRef: 'policy.purpose-1',
    retentionPolicyRef: 'policy.retention-1',
    freshnessPolicyRef: 'policy.freshness-1',
    query: 'Needle',
    matchMode: 'exact_utf8',
    maxMatches: 5,
    contextBytes: 8,
    ...overrides,
  }
}

function searchResult(overrides: Partial<ProtectedSourceSearchResult> = {}): ProtectedSourceSearchResult {
  return {
    resourceId: 'resource.synthetic-1',
    sourceId: 'source.synthetic-1',
    sourceVersionId: 'version.synthetic-1',
    sourceRevision: 3,
    sourceChecksum: checksum('source'),
    resourceChecksum: checksum('resource'),
    freshness: 'current',
    classification: 'internal',
    authority: 'supporting_reference',
    status: 'complete',
    matchMode: 'exact_utf8',
    matches: [{
      evidenceId: evidenceId('resource.synthetic-1', 'version.synthetic-1',
        checksum('resource'), 0, 6, 0, 6),
      text: 'Needle',
      byteStart: 0,
      byteEnd: 6,
      matchByteStart: 0,
      matchByteEnd: 6,
    }],
    truncated: false,
    totalByteCount: 6,
    observedAt: 100,
    ...overrides,
  }
}

function pair(
  suffix: string,
  keyOverrides: Partial<EvidenceSearchCacheKey> = {},
  options: { readonly text?: string } = {},
): { readonly key: EvidenceSearchCacheKey; readonly result: ProtectedSourceSearchResult } {
  const text = options.text ?? 'Needle'
  const byteCount = Buffer.byteLength(text, 'utf8')
  const key = cacheKey({
    query: `Needle-${suffix}`,
    expectedByteCount: byteCount,
    ...keyOverrides,
  })
  const result = searchResult({
    resourceId: key.resourceId,
    sourceId: key.sourceId,
    sourceVersionId: key.sourceVersionId,
    sourceRevision: key.sourceRevision,
    sourceChecksum: key.sourceChecksum,
    resourceChecksum: key.resourceChecksum,
    classification: key.classification,
    authority: key.authority,
    matchMode: key.matchMode,
    totalByteCount: key.expectedByteCount,
    matches: [{
      evidenceId: evidenceId(
        key.resourceId, key.sourceVersionId, key.resourceChecksum,
        0, byteCount, 0, byteCount,
      ),
      text,
      byteStart: 0,
      byteEnd: byteCount,
      matchByteStart: 0,
      matchByteEnd: byteCount,
    }],
  })
  return { key, result }
}

function scopeFor(key: EvidenceSearchCacheKey): {
  readonly workspaceId: string
  readonly profileId: string
  readonly sourceId: string
} {
  return {
    workspaceId: key.workspaceId,
    profileId: key.profileId,
    sourceId: key.sourceId,
  }
}

function retainedBytes(item: {
  readonly key: EvidenceSearchCacheKey
  readonly result: ProtectedSourceSearchResult
}): number {
  const probe = createCache({
    maxEntries: 10,
    maxEntriesPerWorkspace: 10,
    maxEntriesPerProfile: 10,
    maxRetainedBytes: 64 * 1024,
    maxRetainedBytesPerWorkspace: 64 * 1024,
    maxRetainedBytesPerProfile: 64 * 1024,
  })
  expect(probe.put(item.key, item.result)).toBe(true)
  return probe.inventoryAll().retainedBytes
}

function checksum(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function evidenceId(
  resourceId: string,
  sourceVersionId: string,
  resourceChecksum: string,
  byteStart: number,
  byteEnd: number,
  matchByteStart: number,
  matchByteEnd: number,
): string {
  return checksum([
    'source-search-v1', resourceId, sourceVersionId, resourceChecksum,
    byteStart, byteEnd, matchByteStart, matchByteEnd,
  ].join('\n'))
}
