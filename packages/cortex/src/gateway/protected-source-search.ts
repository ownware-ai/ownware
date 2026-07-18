import { createHash } from 'node:crypto'
import {
  AccessGrantStore,
  type AccessConsent,
  type PreparedTextReadTarget,
} from './access-grant-store.js'
import {
  AccessGrantEvaluator,
  type AccessEvaluationContext,
} from './access-grant-evaluator.js'
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
    private readonly evaluateHardFloor: ProtectedSourceReadHardFloor,
    private readonly clock: () => number = Date.now,
  ) {}

  async search(input: ProtectedSourceSearchInput): Promise<ProtectedSourceSearchResult> {
    validateSearch(input)
    const before = this.lookup(input)
    if (!before || !this.isAllowed(input, before, this.clock())) throw unavailable()

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
    if (!after || !sameTarget(before, after) ||
        !this.isAllowed(input, after, observedAt)) throw unavailable()

    const matches = result.matches.map((match) => ({
      evidenceId: evidenceId(after, match.byteStart, match.byteEnd,
        match.matchByteStart, match.matchByteEnd),
      ...match,
    }))
    return {
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

  private isAllowed(
    input: ProtectedSourceSearchInput,
    target: PreparedTextReadTarget,
    now: number,
  ): boolean {
    let hardFloor: AccessEvaluationContext['hardFloor']
    try {
      hardFloor = this.evaluateHardFloor(policyContext(input, target))
    } catch {
      return false
    }
    return this.evaluator.evaluate({
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
    }, now).decision === 'allow'
  }
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
