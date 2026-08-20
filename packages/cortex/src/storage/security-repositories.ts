import type { ActivityLedgerRepository } from '../gateway/activity-ledger.js'
import type {
  CredentialAuditEvent,
  RecordEventInput,
} from '../credential/audit.js'
import type {
  OAuthRefreshAcquireResult,
  OAuthRefreshLease,
} from '../credential/oauth-refresh-coordinator.js'
import type { SpendCap } from '../credential/schema.js'
import type { SpendCheckResult } from '../credential/spend-tracker.js'
import type {
  CredentialBootMigrationOptions,
  CredentialBootMigrationResult,
  CredentialStore,
} from '../credential/store/index.js'
import type {
  AccessGrantPage,
  AccessGrantRevision,
  AccessGrantSourceIdentity,
  CreateAccessGrantInput,
  CreateDataViewQueryWindowGrantInput,
  CreatePreparedTextAccessGrantInput,
  DataViewQueryTargetIdentity,
  PreparedTextReadTarget,
} from '../gateway/access-grant-store.js'
import type { DelegatedPrincipal } from '../gateway/auth/scoped-principal.js'
import type {
  IdempotencyClaim,
  IdempotencyClaimInput,
  IdempotencyCompleteInput,
} from '../gateway/idempotency.js'
import type {
  DurableRunStatus,
  RunConsequence,
  RunPermissionRequest,
  RunSnapshot,
} from '../gateway/run-store.js'
import type { Thread } from '../gateway/types.js'
import type { EffectReceiptRepository } from '../gateway/effect-receipt-store.js'
import type { EgressReceiptRepository } from '../gateway/egress-receipt-store.js'
import type { SkillActivationReceiptRepository } from '../gateway/skill-activation-receipt-store.js'
import type { EffectReversalRepository } from '../gateway/effect-reversal-store.js'
import type { CodexThreadReference } from '../runtime/codex/official-thread.js'
import type { EgressMode } from '@ownware/loom'

export interface CredentialAuditPage {
  readonly events: readonly CredentialAuditEvent[]
  readonly total: number
}

export interface CredentialUsageAggregate {
  readonly totalCalls: number
  readonly topConsumers: ReadonlyArray<{ readonly key: string; readonly count: number }>
  readonly windowStart: string | null
}

export interface CredentialCostAggregate {
  readonly totalEstimatedUsd: number
  readonly totalActualUsd: number
  readonly buckets: ReadonlyArray<{
    readonly date: string
    readonly estimatedUsd: number
    readonly actualUsd: number
    readonly calls: number
  }>
  readonly windowStart: string | null
}

export interface CredentialAuditRepository {
  recordEvent(input: RecordEventInput): Promise<CredentialAuditEvent>
  listEventsForCredential(
    credentialId: string,
    options?: { readonly limit?: number; readonly offset?: number },
  ): Promise<CredentialAuditPage>
  aggregateUsage(
    credentialId: string,
    options?: { readonly sinceIso?: string; readonly groupBy?: 'tool_name' | 'agent_id' },
  ): Promise<CredentialUsageAggregate>
  aggregateCost(
    credentialId: string,
    options?: { readonly sinceIso?: string },
  ): Promise<CredentialCostAggregate>
}

export interface CredentialSpendRepository {
  check(
    credentialId: string,
    cap: SpendCap,
    estimatedCostUsd: number,
    now?: Date,
  ): Promise<SpendCheckResult>
}

export interface CredentialMigrationRepository {
  run(options?: CredentialBootMigrationOptions): Promise<CredentialBootMigrationResult>
}

export interface DelegatedPrincipalRepository {
  insert(principal: DelegatedPrincipal): Promise<void>
  find(tokenId: string): Promise<(DelegatedPrincipal & { readonly revokedAt: number | null }) | null>
  revoke(tokenId: string, reason: string, revokedAt: number): Promise<boolean>
}

export interface ThreadPrincipalBindingRepository {
  bind(threadId: string, principalKey: string, now?: number): Promise<boolean>
  allows(threadId: string, principalKey: string): Promise<boolean>
}

export interface ThreadAuthorityTransactionRepository {
  createAndBind(
    profileId: string,
    workspaceId: string | undefined,
    principalKey: string,
  ): Promise<Thread>
}

export interface RunCreateInput {
  readonly threadId: string
  readonly workspaceId?: string
  readonly profileId: string
  readonly candidateId?: string
  readonly model: string
  readonly egressMode?: EgressMode
  readonly timeoutMs: number
  readonly startSeq: number
}

export interface RunRepository {
  create(input: RunCreateInput, now?: number): Promise<RunSnapshot>
  countActiveForProfile(profileId: string): Promise<number>
  get(runId: string): Promise<RunSnapshot | null>
  markRunning(runId: string, now?: number): Promise<void>
  advanceConsequence(runId: string, consequence: RunConsequence, now?: number): Promise<void>
  requestCancel(
    runId: string,
    now?: number,
  ): Promise<'requested' | 'already_requested' | 'terminal' | 'missing'>
  markTerminal(
    runId: string,
    status: Extract<
      DurableRunStatus,
      'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'indeterminate'
    >,
    input: {
      readonly endSeq: number
      readonly consequence: RunConsequence
      readonly code?: string
      readonly now?: number
    },
  ): Promise<void>
  recoverInterrupted(now?: number): Promise<number>
  recordPermissionRequest(input: {
    readonly runId: string
    readonly requestId: string
    readonly toolName: string
    readonly toolInput: Record<string, unknown>
    readonly policyRevision: string
    readonly agentId: string | null
  }, now?: number): Promise<RunPermissionRequest>
  getPermissionRequest(runId: string, requestId: string): Promise<RunPermissionRequest | null>
  consumePermissionApproval(input: {
    readonly runId: string
    readonly requestId: string
    readonly toolName: string
    readonly toolInput: Record<string, unknown>
    readonly policyRevision: string
    readonly agentId: string | null
      readonly toolCallId?: string
  }, now?: number): Promise<
    | 'consumed'
    | 'missing'
    | 'intent_mismatch'
    | 'not_approved'
    | 'already_consumed'
  >
  decidePermission(
    runId: string,
    requestId: string,
    operationHash: string,
    decision: 'approve' | 'deny',
    now?: number,
  ): Promise<'decided' | 'missing' | 'hash_mismatch' | 'already_decided'>
  expirePermission(
    runId: string,
    requestId: string,
    operationHash: string,
    now?: number,
  ): Promise<'expired' | 'missing' | 'hash_mismatch' | 'already_terminal'>
  markWaiting(runId: string, now?: number): Promise<void>
  markRunningAfterDecision(runId: string, now?: number): Promise<void>
}

export interface IdempotencyRepository {
  claim(input: IdempotencyClaimInput, now?: number): Promise<IdempotencyClaim>
  complete(input: IdempotencyCompleteInput, now?: number): Promise<void>
  markIndeterminate(
    input: Pick<IdempotencyCompleteInput, 'principalKey' | 'operation' | 'key'>,
    now?: number,
  ): Promise<void>
  abandon(
    input: Pick<IdempotencyCompleteInput, 'principalKey' | 'operation' | 'key'>,
  ): Promise<void>
  linkRun(recordId: string, runId: string): Promise<void>
  linkSourceMutation(
    recordId: string,
    sourceId: string,
    kind: 'access_grant',
    now?: number,
  ): Promise<void>
}

export interface AccessGrantCandidateInput {
  readonly workspaceId: string
  readonly profileId: string
  readonly subjectId: string
  readonly purpose: string
  readonly channel: string | null
  readonly resourceKind: string
  readonly resourceId: string
  readonly operation: string
}

export interface AccessGrantRepository {
  create(input: CreateAccessGrantInput, now?: number): Promise<AccessGrantRevision>
  createPreparedTextAccessGrant(
    input: CreatePreparedTextAccessGrantInput,
    now?: number,
  ): Promise<AccessGrantRevision>
  createDataViewQueryWindowGrant(
    input: CreateDataViewQueryWindowGrantInput,
    now?: number,
  ): Promise<AccessGrantRevision>
  getPreparedTextReadTargetScoped(
    workspaceId: string,
    profileId: string,
    resourceId: string,
  ): Promise<PreparedTextReadTarget | null>
  getPreparedTextReadTargetForOwner(resourceId: string): Promise<PreparedTextReadTarget | null>
  getDataViewQueryTargetForOwner(dataViewId: string): Promise<DataViewQueryTargetIdentity | null>
  getCurrentForOwner(grantId: string): Promise<AccessGrantRevision | null>
  getSourceIdentityForOwner(grantId: string): Promise<AccessGrantSourceIdentity | null>
  listCurrentForOwner(
    page: { readonly limit: number; readonly cursor: string | null },
    now?: number,
  ): Promise<AccessGrantPage>
  revoke(input: {
    readonly grantId: string
    readonly workspaceId: string
    readonly profileId: string
    readonly expectedRevision: number
  }, now?: number): Promise<AccessGrantRevision>
  findLiveCandidates(
    input: AccessGrantCandidateInput,
    now: number,
  ): Promise<readonly AccessGrantRevision[]>
}

export interface OAuthRefreshRepository {
  tryAcquire(
    credentialId: string,
    now: number,
    leaseMs: number,
  ): Promise<OAuthRefreshAcquireResult>
  renew(
    lease: OAuthRefreshLease,
    now: number,
    leaseMs: number,
  ): Promise<OAuthRefreshLease | null>
  release(lease: OAuthRefreshLease): Promise<boolean>
  inspect(credentialId: string): Promise<OAuthRefreshLease | null>
}

export interface CodexThreadReferenceRepository {
  load(localThreadId: string): Promise<CodexThreadReference | undefined>
  save(input: unknown): Promise<CodexThreadReference>
}

export interface SecurityRepositories {
  readonly credentials: CredentialStore
  readonly credentialAudit: CredentialAuditRepository
  readonly credentialSpend: CredentialSpendRepository
  readonly credentialMigrations: CredentialMigrationRepository
  readonly principals: DelegatedPrincipalRepository
  readonly threadBindings: ThreadPrincipalBindingRepository
  readonly runs: RunRepository
  readonly effectReceipts: EffectReceiptRepository
  readonly egressReceipts: EgressReceiptRepository
  readonly skillActivationReceipts: SkillActivationReceiptRepository
  readonly effectReversals: EffectReversalRepository
  readonly activityLedger: ActivityLedgerRepository
  readonly idempotency: IdempotencyRepository
  readonly accessGrants: AccessGrantRepository
  readonly oauthRefresh: OAuthRefreshRepository
  readonly codexThreadReferences: CodexThreadReferenceRepository
}

export interface SecurityTransactionRepositories {
  readonly threadAuthority: ThreadAuthorityTransactionRepository
}
