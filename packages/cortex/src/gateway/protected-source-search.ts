import { createHash } from 'node:crypto'
import {
  AccessGrantStore,
  type AccessConsent,
  type PreparedTextReadTarget,
} from './access-grant-store.js'
import {
  AccessGrantEvaluator,
  type AccessEvaluationContext,
  type AccessEvaluation,
} from './access-grant-evaluator.js'
import {
  EvidenceSearchCache,
  type EvidenceSearchCacheKey,
} from './evidence-search-cache.js'
import type {
  ProtectedSourceReadHardFloor,
  ProtectedSourceReadPolicyContext,
} from './protected-source-read.js'
import {
  SOURCE_UTF8_SEARCH_MAX_CONTEXT_BYTES,
  SOURCE_UTF8_SEARCH_MAX_MATCHES,
  SOURCE_UTF8_SEARCH_MAX_QUERY_BYTES,
  SourceByteStore,
  SourceByteStoreError,
  type SourceUtf8SearchMatchMode,
} from './source-byte-store.js'

export interface ProtectedSourceSearchInput {
  readonly workspaceId: string
  readonly profileId: string
  readonly subjectId: string
  readonly purpose: string
  readonly channel: string | null
  readonly resourceId: string
  readonly consent: AccessConsent
  readonly permissionMode: AccessEvaluationContext['permissionMode']
  readonly query: string
  readonly matchMode: SourceUtf8SearchMatchMode
  readonly maxMatches: number
  readonly contextBytes: number
}

export interface ProtectedSourceSearchMatch {
  readonly evidenceId: string
  readonly text: string
  readonly byteStart: number
  readonly byteEnd: number
  readonly matchByteStart: number
  readonly matchByteEnd: number
}

export interface ProtectedSourceSearchResult {
  readonly resourceId: string
  readonly sourceId: string
  readonly sourceVersionId: string
  readonly sourceRevision: number
  readonly sourceChecksum: string
  readonly resourceChecksum: string
  readonly freshness: 'current'
  readonly classification: PreparedTextReadTarget['classification']
  readonly authority: PreparedTextReadTarget['authority']
  readonly status: 'complete' | 'no_matches'
  readonly matchMode: SourceUtf8SearchMatchMode
  readonly matches: readonly ProtectedSourceSearchMatch[]
  readonly truncated: boolean
  readonly totalByteCount: number
  readonly observedAt: number
}

export class ProtectedSourceSearchError extends Error {
  constructor(readonly code:
    | 'protected_source_search_invalid'
    | 'protected_source_search_timed_out'
    | 'protected_source_search_unavailable') {
    super(code)
    this.name = 'ProtectedSourceSearchError'
  }
}

export class ProtectedSourceSearchService {
  constructor(
    private readonly grants: AccessGrantStore,
    private readonly evaluator: AccessGrantEvaluator,
    private readonly bytes: SourceByteStore,
    private readonly cache: EvidenceSearchCache,
    private readonly evaluateHardFloor: ProtectedSourceReadHardFloor,
    private readonly clock: () => number = Date.now,
  ) {}

  async search(input: ProtectedSourceSearchInput): Promise<ProtectedSourceSearchResult> {
    validateSearch(input)
    const before = this.lookup(input)
    const beforeAuthorization = before
      ? this.authorize(input, before, this.clock()) : null
    if (!before || !beforeAuthorization) throw unavailable()
    const key = cacheKey(input, before, beforeAuthorization)
    const candidate = this.cache.get(key)
    if (candidate) {
      try {
        await this.bytes.verifyPlacedUtf8({
          objectKey: before.objectKey,
          expectedByteCount: before.expectedByteCount,
          expectedChecksum: before.expectedChecksum,
        })
      } catch (error) {
        if (error instanceof SourceByteStoreError && error.code === 'inspection_timeout') {
          throw new ProtectedSourceSearchError('protected_source_search_timed_out')
        }
        throw unavailable()
      }
      const after = this.lookup(input)
      const afterAuthorization = after
        ? this.authorize(input, after, this.clock()) : null
      if (!after || !afterAuthorization || !sameTarget(before, after) ||
          !sameAuthorization(beforeAuthorization, afterAuthorization)) throw unavailable()
      return candidate
    }

    let result: Awaited<ReturnType<SourceByteStore['searchPlacedUtf8']>>
    try {
      result = await this.bytes.searchPlacedUtf8({
        objectKey: before.objectKey,
        expectedByteCount: before.expectedByteCount,
        expectedChecksum: before.expectedChecksum,
        query: input.query,
        matchMode: input.matchMode,
        maxMatches: input.maxMatches,
        contextBytes: input.contextBytes,
      })
    } catch (error) {
      if (error instanceof SourceByteStoreError && error.code === 'inspection_timeout') {
        throw new ProtectedSourceSearchError('protected_source_search_timed_out')
      }
      if (error instanceof SourceByteStoreError && error.code === 'search_invalid') {
        throw new ProtectedSourceSearchError('protected_source_search_invalid')
      }
      throw unavailable()
    }

    const after = this.lookup(input)
    const observedAt = this.clock()
    const afterAuthorization = after
      ? this.authorize(input, after, observedAt) : null
    if (!after || !afterAuthorization || !sameTarget(before, after) ||
        !sameAuthorization(beforeAuthorization, afterAuthorization)) throw unavailable()

    const matches = result.matches.map((match) => ({
      evidenceId: evidenceId(after, match.byteStart, match.byteEnd,
        match.matchByteStart, match.matchByteEnd),
      ...match,
    }))
    const output: ProtectedSourceSearchResult = {
      resourceId: after.resourceId,
      sourceId: after.sourceId,
      sourceVersionId: after.sourceVersionId,
      sourceRevision: after.sourceRevision,
      sourceChecksum: after.expectedChecksum,
      resourceChecksum: after.expectedChecksum,
      freshness: 'current',
      classification: after.classification,
      authority: after.authority,
      status: matches.length === 0 ? 'no_matches' : 'complete',
      matchMode: input.matchMode,
      matches,
      truncated: result.truncated,
      totalByteCount: after.expectedByteCount,
      observedAt,
    }
    this.cache.put(key, output)
    return output
  }

  private lookup(input: ProtectedSourceSearchInput): PreparedTextReadTarget | null {
    try {
      return this.grants.getPreparedTextReadTargetScoped(
        input.workspaceId, input.profileId, input.resourceId,
      )
    } catch {
      return null
    }
  }

  private authorize(
    input: ProtectedSourceSearchInput,
    target: PreparedTextReadTarget,
    now: number,
  ): AllowedAccessEvaluation | null {
    let hardFloor: AccessEvaluationContext['hardFloor']
    try {
      hardFloor = this.evaluateHardFloor(policyContext(input, target))
    } catch {
      return null
    }
    const evaluation = this.evaluator.evaluate({
      workspaceId: input.workspaceId,
      profileId: input.profileId,
      subjectId: input.subjectId,
      purpose: input.purpose,
      channel: input.channel,
      resourceKind: 'source_resource',
      resourceId: input.resourceId,
      operation: 'source_content.search',
      fieldScope: { mode: 'all' },
      rowScope: { mode: 'all' },
      consent: input.consent,
      autonomy: 'observe',
      permissionMode: input.permissionMode,
      hardFloor,
    }, now)
    return evaluation.decision === 'allow' ? evaluation : null
  }
}

type AllowedAccessEvaluation = Extract<AccessEvaluation, { readonly decision: 'allow' }>

function cacheKey(
  input: ProtectedSourceSearchInput,
  target: PreparedTextReadTarget,
  authorization: AllowedAccessEvaluation,
): EvidenceSearchCacheKey {
  return {
    grantId: authorization.grantId,
    grantRevision: authorization.grantRevision,
    grantExpiresAt: authorization.expiresAt,
    evaluatorVersion: authorization.evaluatorVersion,
    workspaceId: input.workspaceId,
    profileId: input.profileId,
    subjectId: input.subjectId,
    purpose: input.purpose,
    channel: input.channel,
    consent: input.consent,
    permissionMode: input.permissionMode,
    operation: 'source_content.search',
    resourceId: target.resourceId,
    sourceId: target.sourceId,
    sourceVersionId: target.sourceVersionId,
    sourceRevision: target.sourceRevision,
    sourceChecksum: target.expectedChecksum,
    resourceChecksum: target.expectedChecksum,
    preparationJobId: target.jobId,
    objectKey: target.objectKey,
    expectedByteCount: target.expectedByteCount,
    classification: target.classification,
    authority: target.authority,
    audiencePolicyRef: target.audiencePolicyRef,
    sensitivityPolicyRef: target.sensitivityPolicyRef,
    purposePolicyRef: target.purposePolicyRef,
    retentionPolicyRef: target.retentionPolicyRef,
    freshnessPolicyRef: target.freshnessPolicyRef,
    query: input.query,
    matchMode: input.matchMode,
    maxMatches: input.maxMatches,
    contextBytes: input.contextBytes,
  }
}

function sameAuthorization(a: AllowedAccessEvaluation, b: AllowedAccessEvaluation): boolean {
  return a.evaluatorVersion === b.evaluatorVersion && a.grantId === b.grantId &&
    a.grantRevision === b.grantRevision && a.expiresAt === b.expiresAt
}

function validateSearch(input: ProtectedSourceSearchInput): void {
  const query = Buffer.from(input.query, 'utf8')
  const validMode = input.matchMode === 'exact_utf8' ||
    input.matchMode === 'ascii_case_insensitive'
  const printableQuery = input.query.length > 0 && input.query.trim() === input.query &&
    !/[\u0000-\u001f\u007f]/u.test(input.query) &&
    query.toString('utf8') === input.query && query.length <= SOURCE_UTF8_SEARCH_MAX_QUERY_BYTES
  const validAsciiFold = input.matchMode !== 'ascii_case_insensitive' ||
    /^[\x20-\x7e]+$/.test(input.query)
  if (!validMode || !printableQuery || !validAsciiFold ||
      !Number.isSafeInteger(input.maxMatches) || input.maxMatches < 1 ||
      input.maxMatches > SOURCE_UTF8_SEARCH_MAX_MATCHES ||
      !Number.isSafeInteger(input.contextBytes) || input.contextBytes < 0 ||
      input.contextBytes > SOURCE_UTF8_SEARCH_MAX_CONTEXT_BYTES) {
    throw new ProtectedSourceSearchError('protected_source_search_invalid')
  }
}

function policyContext(
  input: ProtectedSourceSearchInput,
  target: PreparedTextReadTarget,
): ProtectedSourceReadPolicyContext {
  return {
    workspaceId: input.workspaceId,
    profileId: input.profileId,
    subjectId: input.subjectId,
    purpose: input.purpose,
    channel: input.channel,
    resourceId: input.resourceId,
    operation: 'source_content.search',
    sourceId: target.sourceId,
    sourceVersionId: target.sourceVersionId,
    classification: target.classification,
    authority: target.authority,
    audiencePolicyRef: target.audiencePolicyRef,
    sensitivityPolicyRef: target.sensitivityPolicyRef,
    purposePolicyRef: target.purposePolicyRef,
    retentionPolicyRef: target.retentionPolicyRef,
    freshnessPolicyRef: target.freshnessPolicyRef,
  }
}

function sameTarget(a: PreparedTextReadTarget, b: PreparedTextReadTarget): boolean {
  return a.workspaceId === b.workspaceId && a.profileId === b.profileId &&
    a.resourceId === b.resourceId && a.jobId === b.jobId &&
    a.sourceId === b.sourceId && a.sourceVersionId === b.sourceVersionId &&
    a.sourceRevision === b.sourceRevision && a.objectKey === b.objectKey &&
    a.expectedByteCount === b.expectedByteCount &&
    a.expectedChecksum === b.expectedChecksum &&
    a.classification === b.classification && a.authority === b.authority &&
    a.audiencePolicyRef === b.audiencePolicyRef &&
    a.sensitivityPolicyRef === b.sensitivityPolicyRef &&
    a.purposePolicyRef === b.purposePolicyRef &&
    a.retentionPolicyRef === b.retentionPolicyRef &&
    a.freshnessPolicyRef === b.freshnessPolicyRef
}

function evidenceId(
  target: PreparedTextReadTarget,
  byteStart: number,
  byteEnd: number,
  matchByteStart: number,
  matchByteEnd: number,
): string {
  const value = [
    'source-search-v1', target.resourceId, target.sourceVersionId,
    target.expectedChecksum, byteStart, byteEnd, matchByteStart, matchByteEnd,
  ].join('\n')
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function unavailable(): ProtectedSourceSearchError {
  return new ProtectedSourceSearchError('protected_source_search_unavailable')
}
