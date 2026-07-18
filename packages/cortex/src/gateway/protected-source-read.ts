import {
  AccessGrantStore,
  type AccessConsent,
  type PreparedTextReadTarget,
} from './access-grant-store.js'
import {
  AccessGrantEvaluator,
  type AccessEvaluationContext,
} from './access-grant-evaluator.js'
import {
  SOURCE_UTF8_RANGE_MAX_BYTES,
  SourceByteStore,
} from './source-byte-store.js'

export interface ProtectedSourceReadInput {
  readonly workspaceId: string
  readonly profileId: string
  readonly subjectId: string
  readonly purpose: string
  readonly channel: string | null
  readonly resourceId: string
  readonly consent: AccessConsent
  readonly permissionMode: AccessEvaluationContext['permissionMode']
  readonly byteStart: number
  readonly byteEnd: number
}

export interface ProtectedSourceReadPolicyContext {
  readonly workspaceId: string
  readonly profileId: string
  readonly subjectId: string
  readonly purpose: string
  readonly channel: string | null
  readonly resourceId: string
  readonly operation: 'source_content.read' | 'source_content.search'
  readonly sourceId: string
  readonly sourceVersionId: string
  readonly classification: PreparedTextReadTarget['classification']
  readonly authority: PreparedTextReadTarget['authority']
  readonly audiencePolicyRef: string
  readonly sensitivityPolicyRef: string
  readonly purposePolicyRef: string
  readonly retentionPolicyRef: string
  readonly freshnessPolicyRef: string
}

export type ProtectedSourceReadHardFloor = (
  context: ProtectedSourceReadPolicyContext,
) => AccessEvaluationContext['hardFloor']

export interface ProtectedSourceReadResult {
  readonly resourceId: string
  readonly sourceId: string
  readonly sourceVersionId: string
  readonly sourceRevision: number
  readonly sourceChecksum: string
  readonly resourceChecksum: string
  readonly freshness: 'current'
  readonly classification: PreparedTextReadTarget['classification']
  readonly authority: PreparedTextReadTarget['authority']
  readonly text: string
  readonly byteStart: number
  readonly byteEnd: number
  readonly byteCount: number
  readonly totalByteCount: number
  readonly observedAt: number
}

export class ProtectedSourceReadError extends Error {
  constructor(readonly code:
    | 'protected_source_unavailable'
    | 'protected_source_range_invalid'
    | 'protected_source_range_too_large') {
    super(code)
    this.name = 'ProtectedSourceReadError'
  }
}

export class ProtectedSourceReadService {
  constructor(
    private readonly grants: AccessGrantStore,
    private readonly evaluator: AccessGrantEvaluator,
    private readonly bytes: SourceByteStore,
    private readonly evaluateHardFloor: ProtectedSourceReadHardFloor,
    private readonly clock: () => number = Date.now,
  ) {}

  async read(input: ProtectedSourceReadInput): Promise<ProtectedSourceReadResult> {
    validateRange(input.byteStart, input.byteEnd)
    const before = this.lookup(input)
    if (!before || input.byteEnd > before.expectedByteCount) {
      throw unavailable()
    }
    const beforeAt = this.clock()
    if (!this.isAllowed(input, before, beforeAt)) throw unavailable()

    let range: Awaited<ReturnType<SourceByteStore['readPlacedUtf8Range']>>
    try {
      range = await this.bytes.readPlacedUtf8Range({
        objectKey: before.objectKey,
        expectedByteCount: before.expectedByteCount,
        expectedChecksum: before.expectedChecksum,
        byteStart: input.byteStart,
        byteEnd: input.byteEnd,
      })
    } catch {
      throw unavailable()
    }

    const after = this.lookup(input)
    const observedAt = this.clock()
    if (!after || !sameTarget(before, after) ||
        !this.isAllowed(input, after, observedAt)) {
      throw unavailable()
    }

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
      ...range,
      totalByteCount: after.expectedByteCount,
      observedAt,
    }
  }

  private lookup(input: ProtectedSourceReadInput): PreparedTextReadTarget | null {
    try {
      return this.grants.getPreparedTextReadTargetScoped(
        input.workspaceId,
        input.profileId,
        input.resourceId,
      )
    } catch {
      return null
    }
  }

  private isAllowed(
    input: ProtectedSourceReadInput,
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
      operation: 'source_content.read',
      fieldScope: { mode: 'all' },
      rowScope: { mode: 'all' },
      consent: input.consent,
      autonomy: 'observe',
      permissionMode: input.permissionMode,
      hardFloor,
    }, now).decision === 'allow'
  }
}

function policyContext(
  input: ProtectedSourceReadInput,
  target: PreparedTextReadTarget,
): ProtectedSourceReadPolicyContext {
  return {
    workspaceId: input.workspaceId,
    profileId: input.profileId,
    subjectId: input.subjectId,
    purpose: input.purpose,
    channel: input.channel,
    resourceId: input.resourceId,
    operation: 'source_content.read',
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

function validateRange(byteStart: number, byteEnd: number): void {
  if (!Number.isSafeInteger(byteStart) || !Number.isSafeInteger(byteEnd) ||
      byteStart < 0 || byteStart >= byteEnd) {
    throw new ProtectedSourceReadError('protected_source_range_invalid')
  }
  if (byteEnd - byteStart > SOURCE_UTF8_RANGE_MAX_BYTES) {
    throw new ProtectedSourceReadError('protected_source_range_too_large')
  }
}

function unavailable(): ProtectedSourceReadError {
  return new ProtectedSourceReadError('protected_source_unavailable')
}
