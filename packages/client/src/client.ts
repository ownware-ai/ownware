/**
 * OwnwareClient — the typed SDK over the gateway wire contract.
 *
 * "5 lines to talk to your agent":
 *
 *   import { OwnwareClient } from '@ownware/client'
 *   const ownware = new OwnwareClient({ baseUrl: 'http://localhost:4000', token })
 *   const { runId } = await ownware.run({ profileId: 'assistant', prompt: 'hello' })
 *   if (!runId) throw new Error('Gateway does not support run snapshots')
 *   for await (const ev of ownware.streamReply(runId)) {
 *     if (ev.type === 'delta') process.stdout.write(ev.text)
 *   }
 *
 * Transport rules the whole class follows:
 *   - fetch + ReadableStream SSE, never EventSource (bearer auth needs
 *     headers; EventSource can't send them).
 *   - Node and browser: nothing here touches node:* APIs.
 *   - Every SSE event carries `seq` — the resume cursor. Reconnect with
 *     `since: lastSeq` and the stream resumes instead of replaying.
 *
 * The wire contract itself is versioned next to this package:
 * `spec/openapi.yaml` (REST) + `spec/asyncapi.yaml` (SSE events).
 */

import { parseSseFrames } from './sse.js'
import { interpretSseEvent, type RunStreamEvent } from './run-stream.js'
import {
  providerHubModelQueryString,
  providerHubUsageQueryString,
  type OpenAICompatibleConnectionConfig,
  type OpenAICompatibleConnectionInput,
  type OpenAICompatibleConnectionList,
  type ProviderHubConnectionPage,
  type ProviderHubModelPage,
  type ProviderHubModelQuery,
  type ProviderHubOverview,
  type ProviderHubProviderPage,
  type ProviderHubVerificationOverview,
  type ProviderHubReconciledCostInput,
  type ProviderHubUsageEntry,
  type ProviderHubUsageEvidenceExport,
  type ProviderHubUsagePage,
  type ProviderHubUsageQuery,
  type ProviderHubUsageSummary,
} from './provider-hub.js'

// ── inputs / outputs ─────────────────────────────────────────────────────────

export interface RunInput {
  readonly profileId: string
  readonly prompt: string
  readonly threadId?: string
  readonly model?: string
  /**
   * Workspace this run operates in (`POST /api/v1/workspaces` to
   * create/list). Without it the run has no workspace boundary and the
   * zone system escalates every file access to "outside workspace".
   */
  readonly workspaceId?: string
  /** Bounded one-turn data; never registered as reusable knowledge. */
  readonly attachments?: readonly RunAttachmentInput[]
  /** UUID reused only when retrying this exact logical run start. */
  readonly idempotencyKey?: string
  /** Tighten this run to verified literal-loopback dispatch only. */
  readonly egressMode?: EgressMode
  /** Interactive transports this caller is prepared to complete. */
  readonly interactionCapabilities?: readonly string[]
}

export const SENSITIVE_INPUT_INTERACTION_CAPABILITY = 'sensitive-input.v1' as const

export interface SensitiveInputDecisionResult {
  readonly runId: string
  readonly requestId: string
  readonly accepted: true
  readonly status: 'provided' | 'denied'
}

export type EgressMode = 'unrestricted' | 'local-only'

export interface RunAttachmentInput {
  readonly filename: string
  /** Strict canonical base64. */
  readonly data: string
  readonly mimeType: string
}

export interface ModelSubstitution {
  /** Normalized configured preference before the gateway's fallback policy. */
  readonly configuredModel: string
  /** Model the gateway actually dispatched. Always equal to `RunResult.model`. */
  readonly effectiveModel: string
  readonly configuredSource: 'profile'
  readonly reason: 'profile_default_unavailable'
}

export interface RunResult {
  /** Immutable execution identity. Present on Gateway contract 0.5+. */
  readonly runId?: string
  readonly threadId: string
  /** Agent that answers — 'root' for a plain run. */
  readonly agentId?: string
  readonly profileId?: string
  /** Immutable profile candidate pinned before this run, or null on legacy profiles. */
  readonly candidateId?: string | null
  /** The model the gateway ACTUALLY dispatched (profile default, your override, or the keyless fallback). */
  readonly model?: string
  /** Present only when the configured winner differed from actual dispatch. */
  readonly modelSubstitution?: ModelSubstitution
  readonly status?: string
  /** Gateway-enforced wall-clock timeout for this run, in milliseconds. */
  readonly timeoutMs?: number
  readonly egressMode?: EgressMode
}

/** Durable thread aggregate returned by the public hydration route. */
export interface Thread {
  readonly id: string
  readonly profileId: string
  readonly workspaceId: string | null
  readonly title: string | null
  readonly status: 'active' | 'completed' | 'error'
  readonly messageCount: number
  readonly totalTokens: number
  readonly totalCost: number
  readonly model: string | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly lastMessagePreview: string | null
}

export type ThreadMessagePart =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'thinking'; readonly text: string }
  | { readonly kind: 'tool'; readonly toolCallId: string }
  | { readonly kind: 'subagent'; readonly agentId: string }
  | { readonly kind: 'permission'; readonly requestId: string }
  | { readonly kind: 'credential'; readonly requestId: string }

export interface ThreadAttachment {
  readonly filename: string
  readonly mimeType: string
  readonly sizeBytes?: number
  readonly category: 'image' | 'pdf' | 'notebook' | 'text' | 'binary'
}

export interface ThreadToolCall {
  readonly toolCallId?: string
  readonly name: string
  readonly input: unknown
  readonly output?: string
  readonly isError?: boolean
  readonly durationMs?: number
  readonly startedAt?: string
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface ThreadSubAgent {
  readonly agentId: string
  readonly profileName: string
  readonly model?: string
  readonly usage?: {
    readonly inputTokens: number
    readonly outputTokens: number
    readonly costUsd: number
  }
  readonly task?: string
  readonly prompt?: string
  readonly status: 'running' | 'completed' | 'error'
  readonly result?: string
  readonly durationMs?: number
  readonly toolCount?: number
  readonly turnCount?: number
}

export interface ThreadPermission {
  readonly requestId?: string
  readonly toolName: string
  /** Legacy rows may carry model-authored input; new rows retain only `{}`. */
  readonly input?: Readonly<Record<string, unknown>>
  readonly inputSummary?: string
  readonly operationHash?: string
  readonly intentRevision?: 1
  readonly reason: string
  readonly decision: 'approved' | 'denied' | 'pending'
  readonly zoneLevel?: number
  readonly zoneName?: string
  readonly explanation?: string
  readonly severityTag?: 'info' | 'warn' | 'critical'
  readonly severityReason?: string
}

export type ThreadCredentialPlacement =
  | { readonly type: 'env'; readonly variableName: string }
  | { readonly type: 'bearer' }
  | { readonly type: 'header'; readonly name: string }
  | { readonly type: 'cookie'; readonly name: string }
  | { readonly type: 'body'; readonly fieldPath: string }
  | { readonly type: 'query'; readonly paramName: string }
  | { readonly type: 'basic'; readonly usernameCredentialId?: string }

/** Metadata-only legacy credential exchange; it never carries the value. */
export interface ThreadCredential {
  readonly requestId: string
  readonly label: string
  readonly hint: string
  readonly usage: string
  readonly placement: ThreadCredentialPlacement
  readonly isRequired: boolean
  readonly decision: 'pending' | 'stored' | 'denied'
  readonly credentialId?: string
}

/** One durable consolidated message in adapter-assigned thread order. */
export interface ThreadMessage {
  readonly id: string
  readonly role: 'user' | 'assistant' | 'tool_result' | 'system' | 'error'
  readonly content: string
  readonly tools?: readonly ThreadToolCall[]
  readonly subAgents?: readonly ThreadSubAgent[]
  readonly permissions?: readonly ThreadPermission[]
  readonly credentials?: readonly ThreadCredential[]
  readonly attachments?: readonly ThreadAttachment[]
  readonly thinking?: string
  readonly usage?: {
    readonly inputTokens: number
    readonly outputTokens: number
    readonly cacheReadTokens?: number
    readonly cacheCreationTokens?: number
  }
  readonly model?: string
  readonly timestamp: string
  /** Ordered turn timeline; absent only for older stored rows. */
  readonly parts?: readonly ThreadMessagePart[]
}

export interface ThreadHydrationAgent {
  readonly agentId: string
  readonly parentAgentId: string | null
  readonly eventCount: number
}

/**
 * Complete durable history plus point-in-time live-tail correlation.
 * `runningRunId` is present only for a live run confirmed by the public
 * durable run repository. It is not a guessed latest/historical run ID.
 */
export interface ThreadHydration {
  readonly thread: Thread
  readonly messages: readonly ThreadMessage[]
  readonly agents: readonly ThreadHydrationAgent[]
  readonly runningAgentId: 'root' | null
  readonly runningRunId: string | null
  readonly maxSeq: number
  readonly lastClosedTurnEndSeq: number
}

export type DurableRunStatus =
  | 'accepted'
  | 'running'
  | 'waiting'
  | 'cancel_requested'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'indeterminate'

/** Monotonic evidence about what may already have escaped the run boundary. */
export type RunConsequence =
  | 'none_observed'
  | 'output_observed'
  | 'effect_possible'
  | 'effect_confirmed'

export interface RunSnapshot {
  readonly runId: string
  readonly threadId: string
  readonly workspaceId: string | null
  readonly profileId: string
  readonly candidateId?: string | null
  readonly model: string
  readonly timeoutMs: number
  readonly egressMode: EgressMode
  readonly status: DurableRunStatus
  readonly consequence: RunConsequence
  readonly terminal: boolean
  readonly outcomeKnown: boolean
  readonly acceptedAt: number
  readonly startedAt: number | null
  readonly updatedAt: number
  readonly terminalAt: number | null
  readonly cancelRequestedAt: number | null
  readonly startSeq: number
  readonly endSeq: number | null
  readonly earliestRetainedCursor: number | null
  readonly code: string | null
}

export type EffectReceiptKind =
  | 'intent_observed'
  | 'outcome_observed'
  | 'authority_confirmed'
  | 'reconciliation'

export type EffectReceiptOutcome =
  | 'pending'
  | 'succeeded'
  | 'failed'
  | 'denied'
  | 'unknown'

export interface EffectReceipt {
  readonly receiptId: string
  /** Monotonic append order within this run. */
  readonly sequence: number
  /** Stable correlation for one conservatively observed tool action. */
  readonly effectId: string
  readonly runId: string
  readonly toolCallId: string
  readonly toolName: string
  readonly kind: EffectReceiptKind
  /** Tool lifecycle outcome; by itself this does not prove an external effect. */
  readonly outcome: EffectReceiptOutcome
  readonly consequence: RunConsequence
  readonly authorityKind: 'runtime' | 'effect_observer' | 'reconciler'
  /** Bounded structural provenance inside the configured adapter trust boundary. */
  readonly authorityRef: string
  readonly observedAt: number
}

export interface EffectReceiptPage {
  readonly items: readonly EffectReceipt[]
  readonly nextCursor: string | null
}

export interface EffectReceiptListOptions {
  readonly limit?: number
  readonly cursor?: string
}

export type EgressReceiptPhase =
  | 'dispatch_started'
  | 'response_observed'
  | 'dispatch_failed'
  | 'dispatch_blocked'
  | 'route_unavailable'
  | 'outcome_unknown'

export type EgressReasonCode =
  | 'local_only_remote_destination'
  | 'local_only_custom_transport'
  | 'local_only_route_unavailable'
  | 'local_only_redirect'
  | 'route_unavailable'
  | 'run_terminated_after_dispatch'
  | 'gateway_restarted_after_dispatch'

export interface EgressReceipt {
  readonly receiptId: string
  readonly sequence: number
  readonly dispatchId: string
  readonly runId: string
  readonly mode: EgressMode
  readonly sourceKind: 'provider' | 'tool' | 'connector' | 'browser' | 'process' | 'runtime'
  readonly sourceRef: string
  readonly transport: 'http' | 'https' | 'ws' | 'wss' | 'tcp' | 'tls' | 'unknown'
  readonly mediation: 'platform_fetch' | 'custom_fetch' | 'uncontained' | 'unknown'
  readonly destinationOrigin: string | null
  readonly phase: EgressReceiptPhase
  readonly reasonCode: EgressReasonCode | null
  readonly observedAt: number
}

export interface EgressReceiptPage {
  readonly items: readonly EgressReceipt[]
  readonly nextCursor: string | null
}

export interface EgressReceiptListOptions {
  readonly limit?: number
  readonly cursor?: string
}

export interface SkillActivationReceipt {
  readonly receiptId: string
  /** Gap-free append order within this run. */
  readonly sequence: number
  readonly runId: string
  /** Exact profile catalogue identity; install-local and opaque. */
  readonly profileId: string
  readonly profileDigest: string
  readonly skillName: string
  /** Exact frozen skill identity; install-local and opaque. */
  readonly skillDigest: string
  /** Null for the root agent, concrete for an explicitly granted helper. */
  readonly agentId: string | null
  /** Exact dispatcher call; null when the skill entered at helper spawn. */
  readonly toolCallId: string | null
  readonly turnIndex: number
  readonly activatedAt: number
}

export interface SkillActivationReceiptPage {
  readonly items: readonly SkillActivationReceipt[]
  readonly nextCursor: string | null
}

export interface SkillActivationReceiptListOptions {
  readonly limit?: number
  readonly cursor?: string
}

export type EffectReversalOperationKind = 'inverse' | 'compensation'
export type EffectReversalOfferStatus = 'available' | 'confirmed' | 'stale' | 'expired'
export type EffectReversalReceiptOutcome = 'confirmed' | 'stale' | 'expired'

export interface EffectReversalOffer {
  readonly offerId: string
  readonly sequence: number
  readonly runId: string
  readonly effectId: string
  readonly toolCallId: string
  readonly toolName: string
  readonly adapterRef: string
  readonly adapterRevision: string
  readonly operationKind: EffectReversalOperationKind
  readonly status: EffectReversalOfferStatus
  readonly createdAt: number
  readonly expiresAt: number | null
  readonly resolvedAt: number | null
}

export interface EffectReversalReceipt {
  readonly receiptId: string
  readonly sequence: number
  readonly offerId: string
  readonly runId: string
  readonly effectId: string
  readonly operationKind: EffectReversalOperationKind
  readonly outcome: EffectReversalReceiptOutcome
  readonly authorityRef: string
  readonly actorKind: 'owner' | 'delegated'
  readonly observedAt: number
}

export interface EffectReversalOfferPage {
  readonly items: readonly EffectReversalOffer[]
  readonly nextCursor: string | null
}

export interface EffectReversalReceiptPage {
  readonly items: readonly EffectReversalReceipt[]
  readonly nextCursor: string | null
}

export interface EffectReversalListOptions {
  readonly limit?: number
  readonly cursor?: string
}

export interface ExecuteEffectReversalInput {
  readonly idempotencyKey: string
}

export interface EffectReversalExecutionResult {
  readonly disposition: 'executed' | 'replayed' | 'already_terminal'
  readonly offer: EffectReversalOffer
  readonly receipt: EffectReversalReceipt
}

export interface StreamReplyOptions {
  /** Resume cursor — replay events with seq > since. Default 0. */
  readonly since?: number
  readonly signal?: AbortSignal
}

/** One raw gateway event: the SSE frame's JSON with its seq surfaced. */
export interface GatewayEvent {
  readonly type: string
  readonly seq: number
  readonly data: Record<string, unknown>
}

export interface ResumeInput {
  readonly action: 'approve' | 'deny' | 'always' | 'answer' | 'allow_folder_session'
  /**
   * Grant scope when `action: 'always'`: `tool` (default — this exact
   * tool, persisted) · `profile` (every tool for this profile) ·
   * `session` (in-memory only). The gateway grants at the request's own
   * zone level, never wider.
   */
  readonly scope?: 'session' | 'tool' | 'profile'
  /** Free-text reply when `action: 'answer'`. */
  readonly answer?: string
  /** Specific pending request (when multiple are outstanding). */
  readonly requestId?: string
  /** Absolute path being granted when `action: 'allow_folder_session'`. */
  readonly grantPath?: string
}

export interface PermissionDecisionInput {
  readonly decision: 'approve' | 'deny'
  readonly operationHash: string
}

export interface PermissionDecisionResult extends PermissionDecisionInput {
  readonly runId: string
  readonly requestId: string
  readonly intentRevision: 1
}

export interface RunCancellationResult {
  readonly runId: string
  readonly status: DurableRunStatus
  readonly consequence: RunConsequence
  readonly terminal: boolean
  readonly outcomeKnown: boolean
  readonly cancellation: 'requested' | 'already_requested' | 'already_terminal'
}

/** One entry from deprecated GET /api/v1/models compatibility projection. */
export interface ModelEntry {
  readonly id: string
  readonly name?: string
  readonly provider?: string
  /** Whether this model can answer RIGHT NOW (key set, or local Ollama reachable). */
  readonly hasCredentials?: boolean
  /** At most one entry per catalog carries true — the recommended pick. */
  readonly default?: boolean
  readonly [key: string]: unknown
}

export interface HealthResult {
  readonly status: string
  readonly version?: string
  readonly [key: string]: unknown
}

export type CodexAccountState =
  | { readonly state: 'unknown'; readonly reason: 'not_read' }
  | {
      readonly state: 'authenticated'
      readonly authMode: 'chatgpt'
      readonly plan: string
      readonly requiresOpenaiAuth: boolean
      readonly authority: 'account/read'
      readonly observedAt: string
      readonly validUntil: null
    }
  | {
      readonly state: 'signed_out'
      readonly requiresOpenaiAuth: boolean
      readonly authority: 'account/read'
      readonly observedAt: string
      readonly validUntil: null
    }
  | {
      readonly state: 'unsupported_auth'
      readonly authMode: 'apiKey' | 'amazonBedrock'
      readonly requiresOpenaiAuth: boolean
      readonly authority: 'account/read'
      readonly observedAt: string
      readonly validUntil: null
    }

export interface CodexRateLimitWindow {
  readonly usedPercent: number
  readonly windowDurationMinutes: number | null
  readonly resetsAt: string | null
}

export interface CodexRateLimitBucket {
  readonly id: string | null
  readonly name: string | null
  readonly plan: string | null
  readonly primary: CodexRateLimitWindow | null
  readonly secondary: CodexRateLimitWindow | null
  readonly reachedType: string | null
  readonly spendControlReached: boolean | null
  readonly hasCredits: boolean | null
  readonly unlimitedCredits: boolean | null
  readonly spendRemainingPercent: number | null
  readonly spendResetsAt: string | null
}

export type CodexQuotaState =
  | {
      readonly state: 'unknown'
      readonly reason: 'not_read' | 'provider_stated_no_usable_limit' | 'unrecognized_provider_shape'
      readonly authority?: 'account/rateLimits/read' | 'account/rateLimits/updated'
      readonly observedAt?: string
      readonly validUntil: null
    }
  | {
      readonly state: 'reported' | 'exhausted'
      readonly authority: 'account/rateLimits/read' | 'account/rateLimits/updated'
      readonly observedAt: string
      readonly validUntil: null
      readonly buckets: readonly CodexRateLimitBucket[]
      readonly resetCreditsAvailable: number | null
      readonly resetCreditDetailsKnown: boolean | null
    }

export interface CodexRuntimeStatus {
  readonly runtime: {
    readonly id: 'openai-codex'
    readonly accessRoute: 'openai-chatgpt-managed'
    readonly support: 'experimental'
    readonly upstreamSupport: 'experimental_unsupported_for_production'
    readonly processState: 'starting' | 'running' | 'closing' | 'closed' | 'failed'
    readonly protocolVersion: string
    readonly supportedVersionRange: string
  }
  readonly account: CodexAccountState
  readonly login: {
    readonly phase: 'idle' | 'pending' | 'cancelling' | 'succeeded' | 'cancelled' | 'failed'
    readonly reason?: 'provider_rejected'
  }
  readonly quota: CodexQuotaState
}

export type CodexLoginPresentation =
  | {
      readonly kind: 'browser'
      /** One-time correlation value; do not persist or log. */
      readonly loginId: string
      /** One-time provider URL; do not persist or log. */
      readonly url: string
    }
  | {
      readonly kind: 'device'
      /** One-time correlation value; do not persist or log. */
      readonly loginId: string
      readonly verificationUrl: string
      /** One-time device code; do not persist or log. */
      readonly userCode: string
    }

export interface CodexModel {
  readonly id: string
  readonly model: string
  readonly displayName: string
  readonly description: string
  readonly hidden: boolean
  readonly isDefault: boolean
  readonly defaultReasoningEffort: string
  readonly reasoningEfforts: readonly string[]
  readonly inputModalities: readonly string[]
  readonly serviceTiers: readonly string[]
  readonly defaultServiceTier: string | null
  readonly supportsPersonality: boolean
}

export interface CodexModelCatalog {
  readonly authority: 'model/list'
  readonly observedAt: string
  readonly validUntil: null
  readonly models: readonly CodexModel[]
}

export interface GatewayContractDescriptor {
  readonly name: string
  readonly major: number
  readonly revision: string
}

export interface GatewayCapability {
  readonly id: string
  readonly version: number
}

export interface PublicGatewayLimits {
  readonly jsonBodyBytes: number
  readonly candidateUpload?: {
    readonly maxFiles: number
    readonly maxDecodedBytes: number
    readonly maxPathCharacters: number
  }
  readonly runAttachments?: {
    readonly maxCount: number
    readonly maxItemDecodedBytes: number
    readonly maxTotalDecodedBytes: number
    readonly maxFilenameCharacters: number
  }
  readonly sensitiveInput?: {
    readonly interactionCapability: string
    readonly contentType: 'text/plain; charset=utf-8'
    readonly maxBytes: number
  }
  readonly sourceList?: {
    readonly maxPageSize: number
  }
  /** Owner-only connection inventory page bound. Added in contract 0.29.0. */
  readonly connectionList?: {
    readonly maxPageSize: number
  }
  readonly sourceUpload?: {
    readonly maxDecodedBytes: number
    readonly maxChunkBytes: number
    readonly maxChunks: number
    readonly sessionTtlSeconds: number
    readonly supportedSourceKinds: readonly SourceKind[]
    readonly supportedMediaTypes: readonly string[]
  }
  readonly sourceInspection?: {
    readonly maxBytes: number
    readonly perAttemptTimeoutMs: number
    readonly maxAttempts: number
  }
  readonly sourcePreparation?: {
    readonly maxBytes: number
    readonly perAttemptTimeoutMs: number
    readonly maxAttempts: number
    readonly maxResourcesPerJob: number
  }
  readonly sourceDataView?: {
    readonly supportedFormats: readonly string[]
    readonly maxSourceBytes: number
    readonly maxArtifactBytes: number
    readonly maxFields: number
    readonly maxRows: number
    readonly maxCellBytes: number
    readonly maxCells: number
    readonly perAttemptTimeoutMs: number
    readonly maxAttempts: number
    /** Maximum explicit fields in one protected query. Added in contract 0.27.0. */
    readonly maxQueryFields?: number
    /** Maximum row window in one protected query. Added in contract 0.27.0. */
    readonly maxQueryRows?: number
    /** Maximum projected cells in one protected query. */
    readonly maxQueryCells?: number
    /** Maximum canonical selection result size in bytes. */
    readonly maxQueryResultBytes?: number
    /** Bounded artifact verification and selection deadline. */
    readonly queryTimeoutMs?: number
    /** Maximum exact field or row identities in one Data View grant. */
    readonly maxGrantScopeIds?: number
  }
  readonly accessGrants?: {
    readonly minTtlSeconds: number
    readonly maxTtlSeconds: number
    readonly maxActivePerWorkspaceProfile: number
    readonly maxPageSize: number
  }
  readonly sourceContent?: {
    readonly maxRangeBytes: number
  }
  readonly sourceSearch?: {
    readonly maxScanBytes: number
    readonly maxQueryBytes: number
    readonly maxMatches: number
    readonly maxContextBytes: number
    readonly perRequestTimeoutMs: number
    readonly matchModes: readonly SourceContentSearchMatchMode[]
  }
  readonly sourceQuota?: {
    readonly workspace: SourceQuotaCeilings
    readonly profile: SourceQuotaCeilings
  }
  readonly delegationDefaultTtlSeconds: number
  readonly delegationMaxTtlSeconds: number
  readonly idempotencyRetentionSeconds: number
  readonly rateLimit: {
    readonly enabled: boolean
    readonly windowSeconds: number
    readonly generalRequests: number
    readonly runStarts: number
  }
}

export interface SourceQuotaCeilings {
  readonly maxSourceRegistrations: number
  readonly maxRetainedAndReservedBytes: number
  readonly maxActiveUploadSessions: number
  readonly maxNonterminalJobs: number
  readonly maxDerivedResources: number
}

export type SourceQuotaResourceClass =
  | 'source_registrations'
  | 'source_storage_bytes'
  | 'source_upload_sessions'
  | 'source_jobs'
  | 'source_derived_resources'

export interface CapabilityRequirements {
  /** Contract major required by the caller. Defaults to the SDK's v1 contract. */
  readonly requiredMajor?: number
  /** Minimum version for each public capability the caller depends on. */
  readonly requiredCapabilities?: Readonly<Record<string, number>>
}

export type CapabilityNegotiationResult =
  | {
      readonly status: 'available'
      readonly contract: GatewayContractDescriptor
      readonly capabilities: readonly GatewayCapability[]
      readonly limits?: PublicGatewayLimits
    }
  | {
      readonly status: 'unavailable'
      readonly missing: readonly string[]
      readonly contract?: GatewayContractDescriptor
      readonly capabilities?: readonly GatewayCapability[]
      readonly limits?: PublicGatewayLimits
    }
  | {
      readonly status: 'incompatible'
      readonly expectedMajor: number
      readonly actualMajor: number
      readonly contract: GatewayContractDescriptor
      readonly limits?: PublicGatewayLimits
    }

export interface IssueDelegationInput {
  readonly delegateId: string
  /** Explicit grant subject. Required for protected content and Data View query operations. */
  readonly subjectId?: string
  readonly workspaceId: string
  readonly profileId: string
  readonly purpose: string
  readonly channel?: string
  readonly operations: readonly string[]
  readonly ttlSeconds?: number
}

export interface DelegatedPrincipal {
  readonly kind: 'delegated'
  readonly tokenId: string
  readonly delegateId: string
  /** Explicit grant subject when the delegation is subject-bound. */
  readonly subjectId?: string
  readonly workspaceId: string
  readonly profileId: string
  readonly purpose: string
  readonly channel?: string
  readonly operations: readonly string[]
  readonly issuedAt: number
  readonly expiresAt: number
}

export interface IssueDelegationResult {
  /** Bearer secret. Keep server-side or in the intended client only; never log it. */
  readonly token: string
  readonly principal: DelegatedPrincipal
}

export interface CandidateUploadFile {
  readonly path: string
  readonly contentBase64: string
}

export interface ValidateCandidateInput {
  readonly files: readonly CandidateUploadFile[]
}

export interface CandidateFinding {
  readonly code: string
  readonly severity: 'error' | 'warning'
  readonly message: string
  readonly subjects?: readonly string[]
}

export interface CandidateValidationResult {
  readonly valid: boolean
  readonly candidateId: string | null
  readonly profileName: string | null
  readonly fileCount: number | null
  readonly totalBytes: number | null
  readonly findings: readonly CandidateFinding[]
}

export interface StageCandidateInput extends ValidateCandidateInput {
  readonly candidateId: string
}

export interface CandidateStageResult {
  readonly candidateId: string
  readonly profileName: string
  readonly state: 'ready' | 'placement_failed' | 'cleanup_failed'
  readonly ready: boolean
  readonly idempotent: boolean
  readonly code: string | null
  readonly fileCount: number
  readonly totalBytes: number
}

export interface ActivateCandidateInput {
  readonly profileId: string
  readonly candidateId: string
  readonly expectedActiveCandidateId: string | null
  /** Required when reactivating a profile from a durable undeployed state. */
  readonly expectedDeploymentRevision?: number | null
}

export interface CandidateActivationResult {
  readonly state: 'active' | 'activation_failed'
  readonly changed: boolean
  readonly candidateId: string
  readonly previousCandidateId: string | null
  readonly activeCandidateId: string
  readonly deploymentRevision: number
  readonly routingState: ProfileRoutingState
  readonly health: ProfileDeploymentHealth
  readonly healthObservedAt: number | null
  readonly code: string | null
}

export interface CandidateRollbackResult {
  readonly state: 'rolled_back' | 'rollback_failed'
  readonly changed: boolean
  readonly candidateId: string
  readonly previousCandidateId: string | null
  readonly activeCandidateId: string
  readonly deploymentRevision: number
  readonly routingState: ProfileRoutingState
  readonly health: ProfileDeploymentHealth
  readonly healthObservedAt: number | null
  readonly code: string | null
}

export type ProfileRoutingState = 'active' | 'paused'
export type ProfileDeploymentHealth =
  | 'unknown' | 'starting' | 'healthy' | 'degraded' | 'unhealthy'

export interface ProfileDeploymentMutationInput {
  readonly profileId: string
  readonly expectedDeploymentRevision: number
  readonly idempotencyKey: string
}

export interface ProfileDeploymentResult {
  readonly state: ProfileRoutingState
  readonly changed: boolean
  readonly profileId: string
  readonly activeCandidateId: string
  readonly deploymentRevision: number
  readonly routingState: ProfileRoutingState
  readonly health: ProfileDeploymentHealth
  readonly healthObservedAt: number | null
  readonly activeRunCount: number
}

export interface ProfileUndeployInput {
  readonly profileId: string
  readonly expectedActiveCandidateId: string
  readonly expectedDeploymentRevision: number
  readonly idempotencyKey: string
}

export interface ProfileUndeployResult {
  readonly state: 'undeployed' | 'undeploy_failed'
  readonly changed: true
  readonly profileId: string
  readonly previousCandidateId: string
  readonly activeCandidateId: null
  readonly deploymentRevision: number
  readonly routingState: null
  readonly health: null
  readonly healthObservedAt: null
  readonly activeRunCount: 0
  readonly undeployedAt: number
  readonly code: 'resolver_refresh_failed' | null
}

export type CandidatePublicState =
  | 'placing' | 'ready' | 'placement_failed' | 'cleanup_failed'
  | 'deleting' | 'delete_failed' | 'deleted'

export interface CandidateStatus {
  readonly candidateId: string
  readonly profileId: string
  readonly state: CandidatePublicState
  readonly ready: boolean
  readonly fileCount: number
  readonly totalBytes: number
  readonly code: string | null
  readonly createdAt: number
  readonly updatedAt: number
  readonly deletedAt: number | null
  readonly deletionEligible: boolean
  readonly deletionBlockedBy: string | null
}

export interface CandidateList {
  readonly profileId: string
  readonly items: readonly CandidateStatus[]
}

export interface ProfileDeploymentStatus {
  readonly profileId: string
  readonly activeCandidateId: string
  readonly deploymentRevision: number
  readonly routingState: ProfileRoutingState
  readonly health: ProfileDeploymentHealth
  readonly healthObservedAt: number | null
  readonly activeRunCount: number
  readonly updatedAt: number
}

export type ProfileDeploymentState =
  | {
      readonly state: 'active'
      readonly profileId: string
      readonly previousCandidateId: null
      readonly activeCandidateId: string
      readonly deploymentRevision: number
      readonly routingState: ProfileRoutingState
      readonly health: ProfileDeploymentHealth
      readonly healthObservedAt: number | null
      readonly activeRunCount: number
      readonly undeployedAt: null
      readonly updatedAt: number
    }
  | {
      readonly state: 'undeployed'
      readonly profileId: string
      readonly previousCandidateId: string
      readonly activeCandidateId: null
      readonly deploymentRevision: number
      readonly routingState: null
      readonly health: null
      readonly healthObservedAt: null
      readonly activeRunCount: 0
      readonly undeployedAt: number
      readonly updatedAt: number
    }

export interface CandidateDeletionResult {
  readonly candidateId: string
  readonly profileId: string
  readonly state: 'deleted' | 'delete_failed'
  readonly deleted: boolean
  readonly idempotent: boolean
  readonly code: string | null
}

export type SourceKind =
  | 'file' | 'text' | 'visual' | 'structured_export'
  | 'cloud_document' | 'connected_snapshot' | 'supported_other'

export type SourceClassification = 'public' | 'internal' | 'confidential' | 'restricted'
export type SourceAuthority =
  | 'source_of_record' | 'supporting_reference' | 'example' | 'excluded'

export interface RegisterSourceInput {
  readonly kind: SourceKind
  readonly label: string
  readonly classification: SourceClassification
  readonly authority: SourceAuthority
  readonly audiencePolicyRef: string
  readonly sensitivityPolicyRef: string
  readonly purposePolicyRef: string
  readonly retentionPolicyRef: string
  readonly freshnessPolicyRef: string
  /** UUID reused only when retrying this exact logical registration. */
  readonly idempotencyKey: string
}

export interface SourceHealth {
  readonly registration: 'pending' | 'registered' | 'rejected'
  readonly inspection: 'not_started' | 'queued' | 'inspecting' | 'complete' | 'partial' | 'failed'
  readonly preparation: 'not_requested' | 'queued' | 'preparing' | 'ready' | 'partial' | 'failed'
  readonly access: 'available' | 'denied' | 'expired' | 'disconnected' | 'wrong_identity'
  readonly freshness: 'fresh' | 'aging' | 'stale' | 'unknown'
  readonly conflict: 'none' | 'suspected' | 'confirmed' | 'resolved'
  readonly deletion: 'active' | 'frozen' | 'deleting' | 'partially_deleted' | 'deleted'
}

export interface SourceManifest extends Omit<RegisterSourceInput, 'idempotencyKey'> {
  readonly sourceId: string
  readonly revision: number
  readonly currentVersionId: string | null
  readonly health: SourceHealth
  readonly createdAt: number
  readonly updatedAt: number
}

export interface SourceListOptions {
  readonly limit?: number
  readonly cursor?: string
}

export interface SourceList {
  readonly items: readonly SourceManifest[]
  readonly nextCursor: string | null
}

export type ConnectionInventoryStatus = 'pending' | 'connected' | 'failed' | 'expired'
export type ConnectionRecovery =
  | 'none'
  | 'complete_connection'
  | 'reconnect'
  | 'verify_revocation'

export interface ConnectionInventoryItem {
  /** Ownware-owned opaque identity; never a vendor account or session handle. */
  readonly connectionId: string
  /** Provider-neutral logical capability identity. */
  readonly capabilityId: string
  readonly status: ConnectionInventoryStatus
  readonly recovery: ConnectionRecovery
  /** State-change time reduced to whole-second precision by the Gateway. */
  readonly changedAt: number
  readonly expiresAt: number | null
  readonly lastVerifiedAt: number | null
}

export interface ConnectionListOptions {
  readonly limit?: number
  readonly cursor?: string
}

export interface ConnectionList {
  readonly items: readonly ConnectionInventoryItem[]
  readonly nextCursor: string | null
  /** Connection alone grants no profile, tool, subject, purpose or action authority. */
  readonly accessPolicy: 'separate_grant_required'
}

/**
 * Media types the gateway accepts at source upload. Acceptance means the
 * bytes passed the type's framing verification and were stored — it is NOT
 * a promise the runtime can prepare (text-extract) them: preparation
 * refuses unsupported verified types with `source_media_unsupported`.
 * Discover the live set from the capabilities advertisement
 * (`supportedMediaTypes`) rather than assuming this union.
 */
export type SourceMediaType =
  | 'text/plain'
  | 'application/pdf'
  | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  | 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

export interface CreateSourceUploadSessionInput {
  readonly expectedBytes: number
  readonly expectedChecksum: string
  readonly declaredMediaType: SourceMediaType
  readonly filename: string
  readonly idempotencyKey: string
}

export interface SourceUploadSession {
  readonly uploadId: string
  readonly sourceId: string
  readonly state: 'open'
  readonly offset: 0
  readonly expectedBytes: number
  readonly expectedChecksum: string
  readonly declaredMediaType: SourceMediaType
  readonly maxChunkBytes: number
  readonly maxChunks: number
  readonly expiresAt: number
  readonly createdAt: number
}

export interface WriteSourceUploadChunkInput {
  readonly offset: number
  readonly checksum: string
  readonly bytes: Uint8Array
}

export interface SourceUploadChunkResult {
  readonly uploadId: string
  readonly state: 'open'
  readonly offset: number
  readonly chunkCount: number
  readonly replayed: boolean
}

export interface SourceVersionManifest {
  readonly sourceVersionId: string
  readonly sourceId: string
  readonly checksum: string
  readonly verifiedMediaType: SourceMediaType
  readonly byteCount: number
  readonly inspection: SourceHealth['inspection']
  readonly createdAt: number
}

export interface SourceUploadCompletionResult extends Omit<SourceVersionManifest, 'inspection'> {
  readonly inspection: 'not_started'
  readonly replayed: boolean
}

export type SourceJobOperation = 'inspect_format' | 'extract_text' | 'prepare_data_view'
export type SourceJobState =
  | 'queued' | 'running' | 'waiting_for_resource' | 'cancel_requested'
  | 'succeeded' | 'partial' | 'failed' | 'cancelled'
export type SourceJobOutcomeCode =
  | 'attempts_exhausted' | 'cancelled' | 'inspection_complete'
  | 'inspection_timeout' | 'inspection_unavailable' | 'source_format_invalid'
  | 'source_object_mismatch' | 'source_object_missing'
  | 'source_object_oversized' | 'source_storage_inconsistent'
  | 'preparation_complete' | 'preparation_timeout' | 'preparation_unavailable'
  | 'data_view_unavailable' | 'data_view_invalid' | 'data_view_too_large'
  | 'data_view_publication_conflict' | 'artifact_cleanup_failed'
  | 'csv_identity_invalid' | 'csv_input_oversized' | 'csv_invalid_utf8'
  | 'csv_header_empty' | 'csv_header_duplicate' | 'csv_quoting_invalid'
  | 'csv_bare_carriage_return' | 'csv_row_ragged'
  | 'csv_field_limit_exceeded' | 'csv_row_limit_exceeded'
  | 'csv_cell_limit_exceeded' | 'csv_total_cell_limit_exceeded'
  | 'csv_preparation_timeout'

export interface CreateSourceJobInput {
  readonly operation: 'inspect_format'
  readonly idempotencyKey: string
}

export interface CreateSourcePreparationInput {
  readonly operation: 'extract_text' | 'prepare_data_view'
  readonly idempotencyKey: string
}

export interface SourceJob {
  readonly jobId: string
  readonly sourceId: string
  readonly sourceVersionId: string
  readonly operation: SourceJobOperation
  readonly implementationVersion:
    'inspect_format.v1' | 'text_extraction.v1' | 'csv_data_view.v1'
  readonly resourceId: string | null
  readonly dataViewId: string | null
  readonly state: SourceJobState
  readonly attempt: number
  readonly maxAttempts: number
  readonly checkpoint: number
  readonly cancelRequestedAt: number | null
  readonly outcomeCode: SourceJobOutcomeCode | null
  readonly createdAt: number
  readonly updatedAt: number
  readonly terminalAt: number | null
}

export interface SourceJobCancellationResult extends SourceJob {
  readonly cancellation: 'requested' | 'already_requested'
}

export interface SourceResourceManifest {
  readonly resourceId: string
  readonly jobId: string
  readonly sourceId: string
  readonly sourceVersionId: string
  readonly kind: 'text_extraction'
  readonly operation: 'extract_text'
  readonly implementationVersion: 'text_extraction.v1'
  readonly sourceRevision: number
  readonly sourceChecksum: string
  readonly resourceChecksum: string
  readonly byteStart: 0
  readonly byteEnd: number
  readonly byteCount: number
  readonly classification: SourceClassification
  readonly authority: Exclude<SourceAuthority, 'excluded'>
  readonly audiencePolicyRef: string
  readonly sensitivityPolicyRef: string
  readonly purposePolicyRef: string
  readonly retentionPolicyRef: string
  readonly freshnessPolicyRef: string
  readonly coverage: 'complete'
  readonly freshness: 'current' | 'stale'
  readonly createdAt: number
  readonly staleAt: number | null
}

export interface SourceDataViewField {
  readonly fieldId: string
  readonly ordinal: number
  /** Untrusted display label from the structured source header. */
  readonly label: string
}

export interface SourceDataViewManifest {
  readonly dataViewId: string
  readonly jobId: string
  readonly sourceId: string
  readonly sourceVersionId: string
  readonly implementationVersion: 'csv_data_view.v1'
  readonly sourceRevision: number
  readonly sourceChecksum: string
  readonly artifactChecksum: string
  readonly artifactByteCount: number
  readonly fieldCount: number
  readonly rowCount: number
  readonly fields: readonly SourceDataViewField[]
  readonly classification: SourceClassification
  readonly authority: Exclude<SourceAuthority, 'excluded'>
  readonly audiencePolicyRef: string
  readonly sensitivityPolicyRef: string
  readonly purposePolicyRef: string
  readonly retentionPolicyRef: string
  readonly freshnessPolicyRef: string
  readonly freshness: 'current' | 'stale'
  readonly createdAt: number
  readonly staleAt: number | null
}

export interface CreateDataViewQueryGrantInput {
  readonly subjectId: string
  readonly purpose: string
  readonly channel: string | null
  readonly consent: AccessConsent
  readonly fieldIds: readonly string[]
  readonly rowOffset: number
  readonly rowCount: number
  readonly ttlSeconds: number
  /** UUID reused only when retrying this exact logical grant creation. */
  readonly idempotencyKey: string
}

export interface QuerySourceDataViewInput {
  readonly consent: AccessConsent
  readonly fieldIds: readonly string[]
  readonly rowOffset: number
  readonly rowCount: number
}

export interface SourceDataViewSelectionRow {
  readonly rowId: string
  readonly ordinal: number
  /** Values correspond positionally to `fields` and remain inert source data. */
  readonly values: readonly string[]
}

export interface ProtectedSourceDataViewSelection {
  readonly dataViewId: string
  readonly sourceId: string
  readonly sourceVersionId: string
  readonly sourceRevision: number
  readonly sourceChecksum: string
  readonly artifactChecksum: string
  readonly freshness: 'current'
  readonly classification: SourceClassification
  readonly authority: Exclude<SourceAuthority, 'excluded'>
  readonly implementationVersion: 'csv_data_view_selection.v1'
  readonly rowOffset: number
  readonly requestedRowCount: number
  readonly returnedRowCount: number
  readonly totalRowCount: number
  readonly complete: boolean
  readonly fields: readonly SourceDataViewField[]
  readonly rows: readonly SourceDataViewSelectionRow[]
  readonly observedAt: number
}

export type AccessConsent =
  | { readonly state: 'not_required' }
  | { readonly state: 'recorded'; readonly evidenceId: string }

export interface CreateAccessGrantInput {
  readonly operation?: 'source_content.read' | 'source_content.search'
  readonly subjectId: string
  readonly purpose: string
  readonly channel: string | null
  readonly consent: AccessConsent
  readonly ttlSeconds: number
  /** UUID reused only when retrying this exact logical grant creation. */
  readonly idempotencyKey: string
}

export interface AccessGrantMutationReceipt {
  readonly grantId: string
  readonly revision: number
  readonly mutation: 'created' | 'revoked'
  readonly acceptedAt: number
}

export interface AccessGrant {
  readonly grantId: string
  readonly revision: number
  readonly state: 'active' | 'revoked'
  readonly workspaceId: string
  readonly profileId: string
  readonly subjectId: string
  readonly purpose: string
  readonly channel: string | null
  readonly resourceKind: 'source_resource' | 'source_data_view'
  readonly resourceId: string
  readonly operation: 'source_content.read' | 'source_content.search' | 'source_data_views.query'
  readonly fieldScope:
    | { readonly mode: 'all' }
    | { readonly mode: 'list'; readonly ids: readonly string[] }
  readonly rowScope:
    | { readonly mode: 'all' }
    | { readonly mode: 'list'; readonly ids: readonly string[] }
  readonly consent: AccessConsent
  readonly autonomyCeiling: 'observe'
  readonly effectiveAt: number
  readonly expiresAt: number
  readonly issuedBy: 'install_owner'
  readonly revisionCreatedAt: number
  readonly revokedAt: number | null
}

export interface CurrentAccessGrant extends AccessGrant {
  readonly lifecycle: 'scheduled' | 'effective' | 'expired' | 'revoked'
}

export interface AccessGrantListOptions {
  readonly limit?: number
  readonly cursor?: string
}

export interface AccessGrantList {
  readonly items: readonly CurrentAccessGrant[]
  readonly nextCursor: string | null
}

export interface RevokeAccessGrantInput {
  readonly expectedRevision: number
  /** UUID reused only when retrying this exact logical revocation. */
  readonly idempotencyKey: string
}

export interface ReadSourceContentInput {
  readonly consent: AccessConsent
  readonly byteStart: number
  readonly byteEnd: number
}

export interface ProtectedSourceContent {
  readonly resourceId: string
  readonly sourceId: string
  readonly sourceVersionId: string
  readonly sourceRevision: number
  readonly sourceChecksum: string
  readonly resourceChecksum: string
  readonly freshness: 'current'
  readonly classification: SourceClassification
  readonly authority: Exclude<SourceAuthority, 'excluded'>
  readonly text: string
  readonly byteStart: number
  readonly byteEnd: number
  readonly byteCount: number
  readonly totalByteCount: number
  readonly observedAt: number
}

export type SourceContentSearchMatchMode =
  | 'exact_utf8'
  | 'ascii_case_insensitive'

export interface SearchSourceContentInput {
  readonly consent: AccessConsent
  readonly query: string
  readonly matchMode: SourceContentSearchMatchMode
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
  readonly classification: SourceClassification
  readonly authority: Exclude<SourceAuthority, 'excluded'>
  readonly status: 'complete' | 'no_matches'
  readonly matchMode: SourceContentSearchMatchMode
  readonly matches: readonly ProtectedSourceSearchMatch[]
  readonly truncated: boolean
  readonly totalByteCount: number
  /**
   * When this evidence snapshot was created. Equivalent repeated searches may
   * retain the same value; it is not proof of authorization, cache state,
   * response time, or current source freshness for a later request.
   */
  readonly observedAt: number
}

export interface CreateSourceDeletionInput {
  readonly expectedRevision: number
  readonly idempotencyKey: string
}

export interface SourceDeletionCounts {
  readonly immutableOriginals: number
  readonly uploadStaging: number
  readonly placedCandidates: number
  readonly derivedResources: number
  readonly dataViews: number
  readonly searchIndexes: number
  readonly sourceJobs: number
  readonly idempotencyReplays: number
  readonly retrievalCacheEntries: number
}

export interface SourceDeletion {
  readonly jobId: string
  readonly sourceId: string
  readonly operation: 'delete_source'
  readonly state:
    | 'queued' | 'deleting' | 'cancel_requested' | 'cancelled'
    | 'partially_deleted' | 'deleted'
  readonly sourceRevision: number
  readonly affected: SourceDeletionCounts
  readonly remaining: SourceDeletionCounts
  readonly createdAt: number
  readonly updatedAt: number
  readonly terminalAt: number | null
}

export interface SourceDeletionCancellationResult extends SourceDeletion {
  readonly cancellation: 'requested' | 'already_requested'
}

export interface SourceDeletionRetryResult extends SourceDeletion {
  readonly retry: 'queued'
}

/** One entry from GET /api/v1/profiles — a pickable agent. */
export interface ProfileSummary {
  readonly id: string
  readonly name?: string
  readonly description?: string
  readonly displayName?: string | null
  readonly availability?: 'available' | 'paused' | 'invalid' | 'unavailable'
  readonly activeCandidateId?: string | null
  readonly deploymentRevision?: number | null
  readonly health?: ProfileDeploymentHealth
  readonly healthObservedAt?: number | null
  readonly requiredCapabilities?: readonly string[]
  readonly findings?: readonly CandidateFinding[]
  readonly [key: string]: unknown
}

export type TaskPackScopeKind = 'global' | 'workspace' | 'agent'
export type TaskPackScopeDecision = 'allow' | 'deny'

export interface TaskPackTask {
  readonly id: string
  readonly label: string
  readonly description: string
  readonly examples: readonly string[]
}

export interface TaskPackDisplay {
  readonly category: string
  readonly accent: 'blue' | 'red' | 'green' | 'amber' | 'violet' | 'slate'
  /** Sanitized, geometry-only SVG source suitable for rendering as the pack icon. */
  readonly iconSvg: string
  /** Canonical 256px PNG for richer composer/task surfaces; absent on older manifests. */
  readonly composerIconDataUrl: string | null
}

export interface TaskPackScope {
  readonly taskPackId: string
  readonly scopeKind: TaskPackScopeKind
  readonly scopeId: string | null
  readonly decision: TaskPackScopeDecision
  readonly version: string | null
  readonly revision: number
  readonly updatedAt: string
}

export interface TaskPackCatalogEntry {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly availableVersions: readonly string[]
  readonly effectiveVersion: string | null
  readonly display: TaskPackDisplay | null
  readonly tasks: readonly TaskPackTask[]
  readonly scopes: readonly TaskPackScope[]
}

export interface TaskPackCatalog {
  readonly taskPacks: readonly TaskPackCatalogEntry[]
}

export interface TaskCatalogContext {
  readonly workspaceId?: string
  readonly agentId?: string
}

export interface SetTaskPackScopeInput {
  readonly scopeKind: TaskPackScopeKind
  readonly scopeId: string | null
  readonly decision: TaskPackScopeDecision
  readonly version: string | null
  readonly expectedRevision: number | null
}

export interface TaskPackScopeResult {
  readonly scope: TaskPackScope
}

/**
 * The minimal seam a channel adapter (or any driver) needs. `OwnwareClient`
 * implements it; tests substitute an in-memory fake.
 */
export interface GatewayClient {
  connections(options?: ConnectionListOptions): Promise<ConnectionList>
  registerSource(input: RegisterSourceInput): Promise<SourceManifest>
  sources(options?: SourceListOptions): Promise<SourceList>
  source(sourceId: string): Promise<SourceManifest>
  createSourceUploadSession(
    sourceId: string,
    input: CreateSourceUploadSessionInput,
  ): Promise<SourceUploadSession>
  writeSourceUploadChunk(
    uploadId: string,
    input: WriteSourceUploadChunkInput,
  ): Promise<SourceUploadChunkResult>
  completeSourceUpload(uploadId: string): Promise<SourceUploadCompletionResult>
  sourceVersion(sourceId: string, sourceVersionId: string): Promise<SourceVersionManifest>
  createSourceJob(
    sourceId: string,
    sourceVersionId: string,
    input: CreateSourceJobInput,
  ): Promise<SourceJob>
  createSourcePreparation(
    sourceId: string,
    sourceVersionId: string,
    input: CreateSourcePreparationInput,
  ): Promise<SourceJob>
  sourceJob(jobId: string): Promise<SourceJob>
  sourceResource(resourceId: string): Promise<SourceResourceManifest>
  sourceDataView(dataViewId: string): Promise<SourceDataViewManifest>
  createDataViewQueryGrant(
    dataViewId: string,
    input: CreateDataViewQueryGrantInput,
  ): Promise<AccessGrantMutationReceipt>
  querySourceDataView(
    dataViewId: string,
    input: QuerySourceDataViewInput,
  ): Promise<ProtectedSourceDataViewSelection>
  createAccessGrant(
    resourceId: string,
    input: CreateAccessGrantInput,
  ): Promise<AccessGrantMutationReceipt>
  accessGrant(grantId: string): Promise<AccessGrant>
  accessGrants(options?: AccessGrantListOptions): Promise<AccessGrantList>
  revokeAccessGrant(
    grantId: string,
    input: RevokeAccessGrantInput,
  ): Promise<AccessGrantMutationReceipt>
  readSourceContent(
    resourceId: string,
    input: ReadSourceContentInput,
  ): Promise<ProtectedSourceContent>
  searchSourceContent(
    resourceId: string,
    input: SearchSourceContentInput,
  ): Promise<ProtectedSourceSearchResult>
  cancelSourceJob(jobId: string): Promise<SourceJobCancellationResult>
  createSourceDeletion(
    sourceId: string,
    input: CreateSourceDeletionInput,
  ): Promise<SourceDeletion>
  sourceDeletion(jobId: string): Promise<SourceDeletion>
  cancelSourceDeletion(jobId: string): Promise<SourceDeletionCancellationResult>
  retrySourceDeletion(jobId: string): Promise<SourceDeletionRetryResult>
  validateCandidate(input: ValidateCandidateInput): Promise<CandidateValidationResult>
  stageCandidate(input: StageCandidateInput): Promise<CandidateStageResult>
  activateCandidate(input: ActivateCandidateInput): Promise<CandidateActivationResult>
  rollbackCandidate(input: ActivateCandidateInput): Promise<CandidateRollbackResult>
  pauseProfile(input: ProfileDeploymentMutationInput): Promise<ProfileDeploymentResult>
  resumeProfile(input: ProfileDeploymentMutationInput): Promise<ProfileDeploymentResult>
  undeployProfile(input: ProfileUndeployInput): Promise<ProfileUndeployResult>
  candidate(candidateId: string): Promise<CandidateStatus>
  candidates(profileId: string): Promise<CandidateList>
  deployment(profileId: string): Promise<ProfileDeploymentStatus>
  deploymentState(profileId: string): Promise<ProfileDeploymentState>
  deleteCandidate(candidateId: string): Promise<CandidateDeletionResult>
  run(input: RunInput): Promise<RunResult>
  /** Hydrate durable history and discover an addressable active run, if any. */
  hydrateThread(threadId: string): Promise<ThreadHydration>
  streamReply(runIdOrThreadId: string, opts?: StreamReplyOptions): AsyncIterable<RunStreamEvent>
  /**
   * Owner-only legacy compatibility surface. Delegated/public clients use
   * decidePermission so one response cannot affect sibling requests.
   */
  resume(threadId: string, input: ResumeInput): Promise<void>
  /**
   * Answer exactly one run-scoped `permission` event. Approval is consumed
   * once at the supported dispatch boundary; this response is not effect
   * success or remote target-freshness evidence.
   */
  decidePermission(
    runId: string,
    requestId: string,
    input: PermissionDecisionInput,
  ): Promise<PermissionDecisionResult>
  /** Submit one value through the dedicated non-JSON, non-echo transport. */
  submitSensitiveInput(
    runId: string,
    requestId: string,
    value: string,
  ): Promise<SensitiveInputDecisionResult>
  /** Decline one exact pending sensitive-input request. */
  denySensitiveInput(
    runId: string,
    requestId: string,
  ): Promise<SensitiveInputDecisionResult>
  /** Durably request cancellation for one immutable run. */
  cancel(runId: string): Promise<RunCancellationResult>
  /** Read one immutable run's bounded durable lifecycle snapshot. */
  runSnapshot(runId: string): Promise<RunSnapshot>
  /** Read immutable, payload-free effect authority observations. */
  listEffectReceipts(
    runId: string,
    options?: EffectReceiptListOptions,
  ): Promise<EffectReceiptPage>
  /** Read immutable, content-free outbound route observations. */
  listEgressReceipts(
    runId: string,
    options?: EgressReceiptListOptions,
  ): Promise<EgressReceiptPage>
  /** Read exact evidence that a bound skill body entered a conversation. */
  listSkillActivationReceipts(
    runId: string,
    options?: SkillActivationReceiptListOptions,
  ): Promise<SkillActivationReceiptPage>
  /** Read exact, content-free reversal offers supported by registered adapters. */
  listEffectReversalOffers(
    runId: string,
    options?: EffectReversalListOptions,
  ): Promise<EffectReversalOfferPage>
  /** Execute one exact offer with an explicit retry identity. */
  executeEffectReversal(
    runId: string,
    offerId: string,
    input: ExecuteEffectReversalInput,
  ): Promise<EffectReversalExecutionResult>
  /** Read immutable reversal execution receipts. */
  listEffectReversalReceipts(
    runId: string,
    options?: EffectReversalListOptions,
  ): Promise<EffectReversalReceiptPage>
}

export interface OwnwareClientOptions {
  /** Gateway base URL, e.g. `http://127.0.0.1:3011` (or `https://…` with a trusted/pinned cert). */
  readonly baseUrl: string
  /** Bearer token when gateway auth is enabled (`<dataDir>/gateway-token`, or `gateway.token` in-process). */
  readonly token?: string
  /** Injectable fetch (tests, custom TLS dispatcher). Defaults to global fetch. */
  readonly fetch?: typeof fetch
}

export class OwnwareError extends Error {
  readonly status: number
  readonly code: string
  readonly category: string
  readonly correlationId: string | undefined
  readonly retryAfterSeconds: number | undefined
  readonly actualRevision: number | undefined
  readonly actualCurrentVersionId: string | null | undefined
  readonly resourceClass: SourceQuotaResourceClass | undefined

  constructor(input: {
    readonly message: string
    readonly status: number
    readonly code: string
    readonly category: string
    readonly correlationId?: string
    readonly retryAfterSeconds?: number
    readonly actualRevision?: number
    readonly actualCurrentVersionId?: string | null
    readonly resourceClass?: SourceQuotaResourceClass
  }) {
    super(input.message)
    this.name = 'OwnwareError'
    this.status = input.status
    this.code = input.code
    this.category = input.category
    this.correlationId = input.correlationId
    this.retryAfterSeconds = input.retryAfterSeconds
    this.actualRevision = input.actualRevision
    this.actualCurrentVersionId = input.actualCurrentVersionId
    this.resourceClass = input.resourceClass
  }
}

const PROFILE_ID_MAX_LENGTH = 128
const CANDIDATE_ID = /^sha256:[0-9a-f]{64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const KEYED_DIGEST = /^hmac-sha256:[0-9a-f]{64}$/
const PUBLIC_CAPABILITY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const CONTRACT_REVISION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const MAX_EVIDENCE_PAGE_ITEMS = 100
const PROFILE_AVAILABILITIES = new Set([
  'available', 'paused', 'invalid', 'unavailable',
])
const PROFILE_DEPLOYMENT_HEALTH = new Set([
  'unknown', 'starting', 'healthy', 'degraded', 'unhealthy',
])

function invalidProfileCatalog(status: number): OwnwareError {
  return new OwnwareError({
    message: 'Ownware profile catalog response was invalid',
    status,
    code: 'profile_catalog_invalid',
    category: 'validation',
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function isOptionalNullableString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'string'
}

function isOptionalNullableInteger(value: unknown, minimum: number): boolean {
  return value === undefined || value === null ||
    (typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum)
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function isCandidateFinding(value: unknown): value is CandidateFinding {
  if (!isRecord(value)) return false
  if (typeof value['code'] !== 'string' ||
      (value['severity'] !== 'error' && value['severity'] !== 'warning') ||
      typeof value['message'] !== 'string') {
    return false
  }
  return value['subjects'] === undefined || isStringArray(value['subjects'])
}

function isProfileSummary(value: unknown): value is ProfileSummary {
  if (!isRecord(value)) return false
  const id = value['id']
  if (typeof id !== 'string' || id.length === 0 || id.length > PROFILE_ID_MAX_LENGTH) {
    return false
  }
  if (!isOptionalString(value['name']) ||
      !isOptionalString(value['description']) ||
      !isOptionalNullableString(value['displayName'])) {
    return false
  }
  const availability = value['availability']
  if (availability !== undefined &&
      (typeof availability !== 'string' || !PROFILE_AVAILABILITIES.has(availability))) {
    return false
  }
  const activeCandidateId = value['activeCandidateId']
  if (activeCandidateId !== undefined && activeCandidateId !== null &&
      (typeof activeCandidateId !== 'string' || !CANDIDATE_ID.test(activeCandidateId))) {
    return false
  }
  if (!isOptionalNullableInteger(value['deploymentRevision'], 1)) return false
  const health = value['health']
  if (health !== undefined &&
      (typeof health !== 'string' || !PROFILE_DEPLOYMENT_HEALTH.has(health))) {
    return false
  }
  if (!isOptionalNullableInteger(value['healthObservedAt'], 0)) return false
  if (value['requiredCapabilities'] !== undefined &&
      !isStringArray(value['requiredCapabilities'])) {
    return false
  }
  if (value['findings'] !== undefined &&
      (!Array.isArray(value['findings']) || !value['findings'].every(isCandidateFinding))) {
    return false
  }
  return true
}

function parseProfileCatalog(value: unknown, status: number): ProfileSummary[] {
  if (!Array.isArray(value)) throw invalidProfileCatalog(status)
  const identities = new Set<string>()
  const result: ProfileSummary[] = []
  for (const item of value) {
    if (!isProfileSummary(item)) throw invalidProfileCatalog(status)
    const identity = item.id.toLocaleLowerCase('en-US')
    if (identities.has(identity)) throw invalidProfileCatalog(status)
    identities.add(identity)
    result.push(item)
  }
  return result
}

type EvidenceResource =
  | 'gateway capabilities'
  | 'run start'
  | 'permission decision'
  | 'sensitive-input decision'
  | 'run cancellation'
  | 'run snapshot'
  | 'effect receipt page'
  | 'egress receipt page'
  | 'skill activation receipt page'
  | 'effect reversal offer page'
  | 'effect reversal execution'
  | 'effect reversal receipt page'

function invalidEvidenceResponse(
  status: number,
  resource: EvidenceResource,
): OwnwareError {
  return new OwnwareError({
    message: `Ownware ${resource} response was invalid`,
    status,
    code: `${resource.replaceAll('-', '_').replaceAll(' ', '_')}_invalid`,
    category: 'validation',
  })
}

async function readJsonResponse(
  response: Response,
  resource: EvidenceResource,
): Promise<unknown> {
  try {
    return await response.json() as unknown
  } catch {
    throw invalidEvidenceResponse(response.status, resource)
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isSafeInteger(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
}

function isNullableSafeInteger(value: unknown, minimum = 0): value is number | null {
  return value === null || isSafeInteger(value, minimum)
}

function isNullableNonEmptyString(value: unknown): value is string | null {
  return value === null || isNonEmptyString(value)
}

function isMember(value: unknown, members: ReadonlySet<string>): value is string {
  return typeof value === 'string' && members.has(value)
}

function hasIntegerFields(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  if (!required.every(field => isSafeInteger(value[field], 0))) return false
  return optional.every(field => value[field] === undefined || isSafeInteger(value[field], 0))
}

const SOURCE_KINDS = new Set<SourceKind>([
  'file', 'text', 'visual', 'structured_export',
  'cloud_document', 'connected_snapshot', 'supported_other',
])
const SOURCE_SEARCH_MATCH_MODES = new Set<SourceContentSearchMatchMode>([
  'exact_utf8', 'ascii_case_insensitive',
])

function isSourceQuotaCeilings(value: unknown): value is SourceQuotaCeilings {
  return hasIntegerFields(value, [
    'maxSourceRegistrations',
    'maxRetainedAndReservedBytes',
    'maxActiveUploadSessions',
    'maxNonterminalJobs',
    'maxDerivedResources',
  ])
}

/** Validate every field the SDK promises while deliberately ignoring additions. */
function isPublicGatewayLimits(value: unknown): value is PublicGatewayLimits {
  if (!isRecord(value) ||
      !isSafeInteger(value['jsonBodyBytes'], 0) ||
      !isSafeInteger(value['delegationDefaultTtlSeconds'], 0) ||
      !isSafeInteger(value['delegationMaxTtlSeconds'], 0) ||
      !isSafeInteger(value['idempotencyRetentionSeconds'], 0)) {
    return false
  }

  const integerGroups: ReadonlyArray<
    readonly [string, readonly string[]] |
    readonly [string, readonly string[], readonly string[]]
  > = [
    ['candidateUpload', ['maxFiles', 'maxDecodedBytes', 'maxPathCharacters']],
    ['runAttachments', [
      'maxCount', 'maxItemDecodedBytes', 'maxTotalDecodedBytes', 'maxFilenameCharacters',
    ]],
    ['sourceList', ['maxPageSize']],
    ['connectionList', ['maxPageSize']],
    ['sourceInspection', ['maxBytes', 'perAttemptTimeoutMs', 'maxAttempts']],
    ['sourcePreparation', [
      'maxBytes', 'perAttemptTimeoutMs', 'maxAttempts', 'maxResourcesPerJob',
    ]],
    ['sourceDataView', [
      'maxSourceBytes', 'maxArtifactBytes', 'maxFields', 'maxRows', 'maxCellBytes',
      'maxCells', 'perAttemptTimeoutMs', 'maxAttempts',
    ], [
      'maxQueryFields', 'maxQueryRows', 'maxQueryCells', 'maxQueryResultBytes',
      'queryTimeoutMs', 'maxGrantScopeIds',
    ]],
    ['accessGrants', [
      'minTtlSeconds', 'maxTtlSeconds', 'maxActivePerWorkspaceProfile', 'maxPageSize',
    ]],
    ['sourceContent', ['maxRangeBytes']],
    ['sourceSearch', [
      'maxScanBytes', 'maxQueryBytes', 'maxMatches', 'maxContextBytes', 'perRequestTimeoutMs',
    ]],
  ]
  for (const [name, required, optional = []] of integerGroups) {
    if (value[name] !== undefined && !hasIntegerFields(value[name], required, optional)) return false
  }

  const sensitiveInput = value['sensitiveInput']
  if (sensitiveInput !== undefined &&
      (!isRecord(sensitiveInput) ||
        !isNonEmptyString(sensitiveInput['interactionCapability']) ||
        sensitiveInput['contentType'] !== 'text/plain; charset=utf-8' ||
        !isSafeInteger(sensitiveInput['maxBytes'], 0))) {
    return false
  }

  const sourceUpload = value['sourceUpload']
  if (sourceUpload !== undefined) {
    if (!hasIntegerFields(sourceUpload, [
      'maxDecodedBytes', 'maxChunkBytes', 'maxChunks', 'sessionTtlSeconds',
    ]) || !Array.isArray(sourceUpload['supportedSourceKinds']) ||
        !sourceUpload['supportedSourceKinds'].every(kind => isMember(kind, SOURCE_KINDS)) ||
        !isStringArray(sourceUpload['supportedMediaTypes']) ||
        !sourceUpload['supportedMediaTypes'].every(isNonEmptyString)) {
      return false
    }
  }

  const sourceDataView = value['sourceDataView']
  if (sourceDataView !== undefined &&
      (!isRecord(sourceDataView) || !isStringArray(sourceDataView['supportedFormats']) ||
        !sourceDataView['supportedFormats'].every(isNonEmptyString))) {
    return false
  }

  const sourceSearch = value['sourceSearch']
  if (sourceSearch !== undefined &&
      (!isRecord(sourceSearch) || !Array.isArray(sourceSearch['matchModes']) ||
        !sourceSearch['matchModes'].every(mode => isMember(mode, SOURCE_SEARCH_MATCH_MODES)))) {
    return false
  }

  const sourceQuota = value['sourceQuota']
  if (sourceQuota !== undefined &&
      (!isRecord(sourceQuota) || !isSourceQuotaCeilings(sourceQuota['workspace']) ||
        !isSourceQuotaCeilings(sourceQuota['profile']))) {
    return false
  }

  const rateLimit = value['rateLimit']
  return isRecord(rateLimit) && typeof rateLimit['enabled'] === 'boolean' &&
    isSafeInteger(rateLimit['windowSeconds'], 0) &&
    isSafeInteger(rateLimit['generalRequests'], 0) &&
    isSafeInteger(rateLimit['runStarts'], 0)
}

interface GatewayCapabilityDocument {
  readonly contract: GatewayContractDescriptor
  readonly capabilities: readonly GatewayCapability[]
  readonly limits?: PublicGatewayLimits
}

function parseGatewayCapabilityDocument(
  value: unknown,
  status: number,
): GatewayCapabilityDocument {
  const invalid = (): never => { throw invalidEvidenceResponse(status, 'gateway capabilities') }
  if (!isRecord(value) || !isRecord(value['contract']) || !Array.isArray(value['capabilities'])) {
    return invalid()
  }
  const contract = value['contract']
  if (contract['name'] !== 'ownware.gateway' ||
      !isSafeInteger(contract['major'], 1) ||
      typeof contract['revision'] !== 'string' ||
      !CONTRACT_REVISION.test(contract['revision'])) {
    return invalid()
  }
  const identities = new Set<string>()
  for (const capability of value['capabilities']) {
    if (!isRecord(capability) ||
        typeof capability['id'] !== 'string' ||
        !PUBLIC_CAPABILITY_ID.test(capability['id']) ||
        !isSafeInteger(capability['version'], 1) ||
        identities.has(capability['id'])) {
      return invalid()
    }
    identities.add(capability['id'])
  }
  if (value['limits'] !== undefined && !isPublicGatewayLimits(value['limits'])) return invalid()
  return {
    contract: contract as unknown as GatewayContractDescriptor,
    capabilities: value['capabilities'] as unknown as readonly GatewayCapability[],
    ...(value['limits'] !== undefined ? { limits: value['limits'] } : {}),
  }
}

const DURABLE_RUN_STATUSES = new Set<DurableRunStatus>([
  'accepted', 'running', 'waiting', 'cancel_requested', 'succeeded', 'failed',
  'cancelled', 'timed_out', 'indeterminate',
])
const RUN_CONSEQUENCES = new Set<RunConsequence>([
  'none_observed', 'output_observed', 'effect_possible', 'effect_confirmed',
])
const EGRESS_MODES = new Set<EgressMode>(['unrestricted', 'local-only'])

function isRunIdentity(value: unknown, expectedRunId: string): value is string {
  return typeof value === 'string' && UUID.test(value) && value === expectedRunId
}

function parseRunResult(value: unknown, status: number, input: RunInput): RunResult {
  if (!isRecord(value) || !isNonEmptyString(value['threadId']) ||
      (input.threadId !== undefined && value['threadId'] !== input.threadId) ||
      (value['runId'] !== undefined &&
        (typeof value['runId'] !== 'string' || !UUID.test(value['runId']))) ||
      (value['agentId'] !== undefined && !isNonEmptyString(value['agentId'])) ||
      (value['profileId'] !== undefined && value['profileId'] !== input.profileId) ||
      (value['candidateId'] !== undefined && value['candidateId'] !== null &&
        (typeof value['candidateId'] !== 'string' || !CANDIDATE_ID.test(value['candidateId']))) ||
      (value['model'] !== undefined && !isNonEmptyString(value['model'])) ||
      (value['status'] !== undefined && !isNonEmptyString(value['status'])) ||
      (value['timeoutMs'] !== undefined && !isSafeInteger(value['timeoutMs'], 1)) ||
      (value['egressMode'] !== undefined && !isMember(value['egressMode'], EGRESS_MODES)) ||
      (input.egressMode !== undefined && value['egressMode'] !== input.egressMode)) {
    throw invalidEvidenceResponse(status, 'run start')
  }
  const substitution = value['modelSubstitution']
  if (substitution !== undefined &&
      (!isRecord(substitution) || !isNonEmptyString(substitution['configuredModel']) ||
        !isNonEmptyString(substitution['effectiveModel']) ||
        substitution['configuredSource'] !== 'profile' ||
        substitution['reason'] !== 'profile_default_unavailable' ||
        (value['model'] !== undefined && substitution['effectiveModel'] !== value['model']))) {
    throw invalidEvidenceResponse(status, 'run start')
  }
  return value as unknown as RunResult
}

function parsePermissionDecisionResult(
  value: unknown,
  status: number,
  runId: string,
  requestId: string,
  input: PermissionDecisionInput,
): PermissionDecisionResult {
  if (!isRecord(value) || !isRunIdentity(value['runId'], runId) ||
      value['requestId'] !== requestId || value['decision'] !== input.decision ||
      value['operationHash'] !== input.operationHash || value['intentRevision'] !== 1) {
    throw invalidEvidenceResponse(status, 'permission decision')
  }
  return value as unknown as PermissionDecisionResult
}

function parseSensitiveInputDecisionResult(
  value: unknown,
  status: number,
  runId: string,
  requestId: string,
  expectedDecision: SensitiveInputDecisionResult['status'],
): SensitiveInputDecisionResult {
  if (!isRecord(value) || !isRunIdentity(value['runId'], runId) ||
      value['requestId'] !== requestId || value['accepted'] !== true ||
      value['status'] !== expectedDecision) {
    throw invalidEvidenceResponse(status, 'sensitive-input decision')
  }
  return value as unknown as SensitiveInputDecisionResult
}

function isRunStatus(value: unknown): value is DurableRunStatus {
  return isMember(value, DURABLE_RUN_STATUSES)
}

function isRunConsequence(value: unknown): value is RunConsequence {
  return isMember(value, RUN_CONSEQUENCES)
}

function parseRunCancellationResult(
  value: unknown,
  status: number,
  runId: string,
): RunCancellationResult {
  const cancellations = new Set(['requested', 'already_requested', 'already_terminal'])
  if (!isRecord(value) || !isRunIdentity(value['runId'], runId) ||
      !isRunStatus(value['status']) || !isRunConsequence(value['consequence']) ||
      typeof value['terminal'] !== 'boolean' || typeof value['outcomeKnown'] !== 'boolean' ||
      !isMember(value['cancellation'], cancellations)) {
    throw invalidEvidenceResponse(status, 'run cancellation')
  }
  return value as unknown as RunCancellationResult
}

function parseRunSnapshot(value: unknown, status: number, runId: string): RunSnapshot {
  if (!isRecord(value) || !isRunIdentity(value['runId'], runId) ||
      !isNonEmptyString(value['threadId']) || !isNullableNonEmptyString(value['workspaceId']) ||
      !isNonEmptyString(value['profileId']) ||
      (value['candidateId'] !== undefined && value['candidateId'] !== null &&
        (typeof value['candidateId'] !== 'string' || !CANDIDATE_ID.test(value['candidateId']))) ||
      !isNonEmptyString(value['model']) || !isSafeInteger(value['timeoutMs'], 1) ||
      !isMember(value['egressMode'], EGRESS_MODES) || !isRunStatus(value['status']) ||
      !isRunConsequence(value['consequence']) || typeof value['terminal'] !== 'boolean' ||
      typeof value['outcomeKnown'] !== 'boolean' || !isSafeInteger(value['acceptedAt']) ||
      !isNullableSafeInteger(value['startedAt']) || !isSafeInteger(value['updatedAt']) ||
      !isNullableSafeInteger(value['terminalAt']) ||
      !isNullableSafeInteger(value['cancelRequestedAt']) || !isSafeInteger(value['startSeq']) ||
      !isNullableSafeInteger(value['endSeq']) ||
      !isNullableSafeInteger(value['earliestRetainedCursor']) ||
      (value['code'] !== null && typeof value['code'] !== 'string')) {
    throw invalidEvidenceResponse(status, 'run snapshot')
  }
  return value as unknown as RunSnapshot
}

const EFFECT_RECEIPT_KINDS = new Set<EffectReceiptKind>([
  'intent_observed', 'outcome_observed', 'authority_confirmed', 'reconciliation',
])
const EFFECT_RECEIPT_OUTCOMES = new Set<EffectReceiptOutcome>([
  'pending', 'succeeded', 'failed', 'denied', 'unknown',
])
const EFFECT_AUTHORITY_KINDS = new Set(['runtime', 'effect_observer', 'reconciler'])
const EGRESS_SOURCE_KINDS = new Set([
  'provider', 'tool', 'connector', 'browser', 'process', 'runtime',
])
const EGRESS_TRANSPORTS = new Set(['http', 'https', 'ws', 'wss', 'tcp', 'tls', 'unknown'])
const EGRESS_MEDIATIONS = new Set(['platform_fetch', 'custom_fetch', 'uncontained', 'unknown'])
const EGRESS_PHASES = new Set<EgressReceiptPhase>([
  'dispatch_started', 'response_observed', 'dispatch_failed', 'dispatch_blocked',
  'route_unavailable', 'outcome_unknown',
])
const EGRESS_REASON_CODES = new Set<EgressReasonCode>([
  'local_only_remote_destination', 'local_only_custom_transport',
  'local_only_route_unavailable', 'local_only_redirect', 'route_unavailable',
  'run_terminated_after_dispatch', 'gateway_restarted_after_dispatch',
])
const REVERSAL_OPERATIONS = new Set<EffectReversalOperationKind>(['inverse', 'compensation'])
const REVERSAL_OFFER_STATUSES = new Set<EffectReversalOfferStatus>([
  'available', 'confirmed', 'stale', 'expired',
])
const REVERSAL_RECEIPT_OUTCOMES = new Set<EffectReversalReceiptOutcome>([
  'confirmed', 'stale', 'expired',
])
const REVERSAL_ACTOR_KINDS = new Set(['owner', 'delegated'])

function isEffectReceipt(value: unknown, runId: string): value is EffectReceipt {
  return isRecord(value) && typeof value['receiptId'] === 'string' && UUID.test(value['receiptId']) &&
    isSafeInteger(value['sequence'], 1) && typeof value['effectId'] === 'string' &&
    UUID.test(value['effectId']) && isRunIdentity(value['runId'], runId) &&
    isNonEmptyString(value['toolCallId']) && isNonEmptyString(value['toolName']) &&
    isMember(value['kind'], EFFECT_RECEIPT_KINDS) &&
    isMember(value['outcome'], EFFECT_RECEIPT_OUTCOMES) &&
    isRunConsequence(value['consequence']) &&
    isMember(value['authorityKind'], EFFECT_AUTHORITY_KINDS) &&
    isNonEmptyString(value['authorityRef']) && isSafeInteger(value['observedAt'])
}

function isEgressReceipt(value: unknown, runId: string): value is EgressReceipt {
  return isRecord(value) && typeof value['receiptId'] === 'string' && UUID.test(value['receiptId']) &&
    isSafeInteger(value['sequence'], 1) && typeof value['dispatchId'] === 'string' &&
    UUID.test(value['dispatchId']) && isRunIdentity(value['runId'], runId) &&
    isMember(value['mode'], EGRESS_MODES) && isMember(value['sourceKind'], EGRESS_SOURCE_KINDS) &&
    isNonEmptyString(value['sourceRef']) && isMember(value['transport'], EGRESS_TRANSPORTS) &&
    isMember(value['mediation'], EGRESS_MEDIATIONS) &&
    isNullableNonEmptyString(value['destinationOrigin']) && isMember(value['phase'], EGRESS_PHASES) &&
    (value['reasonCode'] === null || isMember(value['reasonCode'], EGRESS_REASON_CODES)) &&
    isSafeInteger(value['observedAt'])
}

function isSkillActivationReceipt(
  value: unknown,
  runId: string,
): value is SkillActivationReceipt {
  return isRecord(value) && typeof value['receiptId'] === 'string' && UUID.test(value['receiptId']) &&
    isSafeInteger(value['sequence'], 1) && isRunIdentity(value['runId'], runId) &&
    isNonEmptyString(value['profileId']) && typeof value['profileDigest'] === 'string' &&
    KEYED_DIGEST.test(value['profileDigest']) && isNonEmptyString(value['skillName']) &&
    typeof value['skillDigest'] === 'string' && KEYED_DIGEST.test(value['skillDigest']) &&
    isNullableNonEmptyString(value['agentId']) && isNullableNonEmptyString(value['toolCallId']) &&
    isSafeInteger(value['turnIndex']) && isSafeInteger(value['activatedAt'])
}

function isEffectReversalOffer(value: unknown, runId: string): value is EffectReversalOffer {
  return isRecord(value) && typeof value['offerId'] === 'string' && UUID.test(value['offerId']) &&
    isSafeInteger(value['sequence'], 1) && isRunIdentity(value['runId'], runId) &&
    typeof value['effectId'] === 'string' && UUID.test(value['effectId']) &&
    isNonEmptyString(value['toolCallId']) && isNonEmptyString(value['toolName']) &&
    isNonEmptyString(value['adapterRef']) && isNonEmptyString(value['adapterRevision']) &&
    isMember(value['operationKind'], REVERSAL_OPERATIONS) &&
    isMember(value['status'], REVERSAL_OFFER_STATUSES) && isSafeInteger(value['createdAt']) &&
    isNullableSafeInteger(value['expiresAt']) && isNullableSafeInteger(value['resolvedAt'])
}

function isEffectReversalReceipt(
  value: unknown,
  runId: string,
): value is EffectReversalReceipt {
  return isRecord(value) && typeof value['receiptId'] === 'string' && UUID.test(value['receiptId']) &&
    isSafeInteger(value['sequence'], 1) && typeof value['offerId'] === 'string' &&
    UUID.test(value['offerId']) && isRunIdentity(value['runId'], runId) &&
    typeof value['effectId'] === 'string' && UUID.test(value['effectId']) &&
    isMember(value['operationKind'], REVERSAL_OPERATIONS) &&
    isMember(value['outcome'], REVERSAL_RECEIPT_OUTCOMES) &&
    isNonEmptyString(value['authorityRef']) && isMember(value['actorKind'], REVERSAL_ACTOR_KINDS) &&
    isSafeInteger(value['observedAt'])
}

function parseEvidencePage<T extends { readonly sequence: number }>(
  value: unknown,
  status: number,
  resource: Extract<EvidenceResource,
    | 'effect receipt page'
    | 'egress receipt page'
    | 'skill activation receipt page'
    | 'effect reversal offer page'
    | 'effect reversal receipt page'>,
  validate: (item: unknown) => item is T,
  identity: (item: T) => string,
): { readonly items: readonly T[]; readonly nextCursor: string | null } {
  if (!isRecord(value) || !Array.isArray(value['items']) ||
      value['items'].length > MAX_EVIDENCE_PAGE_ITEMS ||
      (value['nextCursor'] !== null &&
        (typeof value['nextCursor'] !== 'string' || !UUID.test(value['nextCursor'])))) {
    throw invalidEvidenceResponse(status, resource)
  }
  const identities = new Set<string>()
  let previousSequence = 0
  for (const raw of value['items']) {
    if (!validate(raw) || raw.sequence <= previousSequence || identities.has(identity(raw))) {
      throw invalidEvidenceResponse(status, resource)
    }
    previousSequence = raw.sequence
    identities.add(identity(raw))
  }
  return value as unknown as { readonly items: readonly T[]; readonly nextCursor: string | null }
}

function parseEffectReversalExecutionResult(
  value: unknown,
  status: number,
  runId: string,
  offerId: string,
): EffectReversalExecutionResult {
  const dispositions = new Set(['executed', 'replayed', 'already_terminal'])
  if (!isRecord(value) || !isMember(value['disposition'], dispositions) ||
      !isEffectReversalOffer(value['offer'], runId) ||
      !isEffectReversalReceipt(value['receipt'], runId)) {
    throw invalidEvidenceResponse(status, 'effect reversal execution')
  }
  const offer = value['offer']
  const receipt = value['receipt']
  if (offer.offerId !== offerId || receipt.offerId !== offerId ||
      receipt.effectId !== offer.effectId || receipt.operationKind !== offer.operationKind ||
      receipt.outcome !== offer.status) {
    throw invalidEvidenceResponse(status, 'effect reversal execution')
  }
  return value as unknown as EffectReversalExecutionResult
}

// ── the client ───────────────────────────────────────────────────────────────

export class OwnwareClient implements GatewayClient {
  private readonly base: string
  private readonly token: string | undefined
  private readonly doFetch: typeof fetch

  constructor(opts: OwnwareClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, '')
    this.token = opts.token
    this.doFetch = opts.fetch ?? fetch
  }

  private headers(json: boolean): Record<string, string> {
    const h: Record<string, string> = {}
    if (json) h['Content-Type'] = 'application/json'
    if (this.token) h['Authorization'] = `Bearer ${this.token}`
    return h
  }

  private async post(path: string, body: Record<string, unknown>): Promise<Response> {
    const res = await this.doFetch(`${this.base}${path}`, {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      throw await errorFromResponse(res)
    }
    return res
  }

  /** List the install owner's bounded provider-neutral connection inventory. */
  async connections(options: ConnectionListOptions = {}): Promise<ConnectionList> {
    const query = new URLSearchParams()
    if (options.limit !== undefined) query.set('limit', String(options.limit))
    if (options.cursor !== undefined) query.set('cursor', options.cursor)
    const suffix = query.size > 0 ? `?${query.toString()}` : ''
    const response = await this.doFetch(`${this.base}/api/v1/connections${suffix}`, {
      headers: this.headers(false),
    })
    if (!response.ok) throw await errorFromResponse(response)
    return (await response.json()) as ConnectionList
  }

  /** Read the install owner's redacted official-Codex connection state. */
  async codexRuntime(): Promise<CodexRuntimeStatus> {
    const response = await this.doFetch(`${this.base}/api/v1/runtimes/codex`, {
      headers: this.headers(false),
    })
    if (!response.ok) throw await errorFromResponse(response)
    return (await response.json()) as CodexRuntimeStatus
  }

  /** Start one Codex-owned ChatGPT login; returned material is one-time only. */
  async startCodexLogin(
    kind: 'browser' | 'device',
  ): Promise<CodexLoginPresentation> {
    const response = await this.post('/api/v1/runtimes/codex/login/start', { kind })
    return (await response.json()) as CodexLoginPresentation
  }

  /** Bounded long-poll for the active Codex-owned login attempt. */
  async waitForCodexLogin(timeoutMs?: number): Promise<CodexRuntimeStatus> {
    const response = await this.post('/api/v1/runtimes/codex/login/wait', {
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    })
    return (await response.json()) as CodexRuntimeStatus
  }

  async cancelCodexLogin(): Promise<CodexRuntimeStatus> {
    const response = await this.post('/api/v1/runtimes/codex/login/cancel', {})
    return (await response.json()) as CodexRuntimeStatus
  }

  async logoutCodex(): Promise<CodexRuntimeStatus> {
    const response = await this.post('/api/v1/runtimes/codex/logout', {})
    return (await response.json()) as CodexRuntimeStatus
  }

  /** Models observed from this exact Codex-managed ChatGPT account. */
  async codexModels(): Promise<CodexModelCatalog> {
    const response = await this.doFetch(`${this.base}/api/v1/runtimes/codex/models`, {
      headers: this.headers(false),
    })
    if (!response.ok) throw await errorFromResponse(response)
    return (await response.json()) as CodexModelCatalog
  }

  /** Central, secret-free provider/model/connection catalog overview. */
  async providerHubOverview(): Promise<ProviderHubOverview> {
    return this.providerHubGet('/api/v1/provider-hub')
  }

  async providerHubProviders(): Promise<ProviderHubProviderPage> {
    return this.providerHubGet('/api/v1/provider-hub/providers')
  }

  async providerHubConnections(): Promise<ProviderHubConnectionPage> {
    return this.providerHubGet('/api/v1/provider-hub/connections')
  }

  async providerHubVerifications(): Promise<ProviderHubVerificationOverview> {
    return this.providerHubGet('/api/v1/provider-hub/verifications')
  }

  async providerHubModels(query: ProviderHubModelQuery = {}): Promise<ProviderHubModelPage> {
    return this.providerHubGet(
      `/api/v1/provider-hub/models${providerHubModelQueryString(query)}`,
    )
  }

  async providerHubHealth(): Promise<ProviderHubOverview> {
    return this.providerHubGet('/api/v1/provider-hub/health')
  }

  async providerHubUsage(query: ProviderHubUsageQuery = {}): Promise<ProviderHubUsagePage> {
    return this.providerHubGet(
      `/api/v1/provider-hub/usage${providerHubUsageQueryString(query)}`,
    )
  }

  async providerHubUsageSummary(
    query: Omit<ProviderHubUsageQuery, 'classification' | 'limit'> = {},
  ): Promise<ProviderHubUsageSummary> {
    return this.providerHubGet(
      `/api/v1/provider-hub/usage/summary${providerHubUsageQueryString(query)}`,
    )
  }

  async exportProviderHubUsageEvidence(): Promise<ProviderHubUsageEvidenceExport> {
    return this.providerHubGet('/api/v1/provider-hub/usage/export')
  }

  async reconcileProviderHubUsageCost(
    usageId: string,
    input: ProviderHubReconciledCostInput,
  ): Promise<ProviderHubUsageEntry> {
    const response = await this.doFetch(
      `${this.base}/api/v1/provider-hub/usage/${encodeURIComponent(usageId)}/cost-observations`,
      { method: 'POST', headers: this.headers(true), body: JSON.stringify(input) },
    )
    if (!response.ok) throw await errorFromResponse(response)
    return (await response.json()) as ProviderHubUsageEntry
  }

  /** List immutable task-pack versions, tasks and owner-controlled scope decisions. */
  async taskCatalog(context: TaskCatalogContext = {}): Promise<TaskPackCatalog> {
    const query = new URLSearchParams()
    if (context.workspaceId !== undefined) query.set('workspaceId', context.workspaceId)
    if (context.agentId !== undefined) query.set('agentId', context.agentId)
    const suffix = query.size === 0 ? '' : `?${query.toString()}`
    const response = await this.doFetch(`${this.base}/api/v1/task-catalog${suffix}`, {
      headers: this.headers(false),
    })
    if (!response.ok) throw await errorFromResponse(response)
    return (await response.json()) as TaskPackCatalog
  }

  /** Compare-and-set one global, workspace or top-level-agent task-pack decision. */
  async setTaskPackScope(
    taskPackId: string,
    input: SetTaskPackScopeInput,
  ): Promise<TaskPackScopeResult> {
    const response = await this.doFetch(
      `${this.base}/api/v1/task-catalog/${encodeURIComponent(taskPackId)}/scope`,
      { method: 'PUT', headers: this.headers(true), body: JSON.stringify(input) },
    )
    if (!response.ok) throw await errorFromResponse(response)
    return (await response.json()) as TaskPackScopeResult
  }

  async refreshProviderHub(force = false): Promise<ProviderHubOverview> {
    const response = await this.doFetch(
      `${this.base}/api/v1/provider-hub/catalog/refresh?force=${String(force)}`,
      { method: 'POST', headers: this.headers(false) },
    )
    if (!response.ok) throw await errorFromResponse(response)
    return (await response.json()) as ProviderHubOverview
  }

  async openAICompatibleConnections(): Promise<OpenAICompatibleConnectionList> {
    return this.providerHubGet('/api/v1/provider-hub/connections/openai-compatible')
  }

  async saveOpenAICompatibleConnection(
    input: OpenAICompatibleConnectionInput,
  ): Promise<OpenAICompatibleConnectionConfig> {
    const response = await this.doFetch(
      `${this.base}/api/v1/provider-hub/connections/openai-compatible`,
      {
        method: 'POST',
        headers: this.headers(true),
        body: JSON.stringify(input),
      },
    )
    if (!response.ok) throw await errorFromResponse(response)
    return (await response.json()) as OpenAICompatibleConnectionConfig
  }

  async removeOpenAICompatibleConnection(connectionId: string): Promise<{ readonly removed: true }> {
    const response = await this.doFetch(
      `${this.base}/api/v1/provider-hub/connections/openai-compatible/${encodeURIComponent(connectionId)}`,
      { method: 'DELETE', headers: this.headers(false) },
    )
    if (!response.ok) throw await errorFromResponse(response)
    return (await response.json()) as { readonly removed: true }
  }

  async discoverOpenAICompatibleModels(
    connectionId: string,
  ): Promise<OpenAICompatibleConnectionConfig> {
    const response = await this.doFetch(
      `${this.base}/api/v1/provider-hub/connections/openai-compatible/${encodeURIComponent(connectionId)}/discover`,
      { method: 'POST', headers: this.headers(false) },
    )
    if (!response.ok) throw await errorFromResponse(response)
    return (await response.json()) as OpenAICompatibleConnectionConfig
  }

  private async providerHubGet<T>(path: string): Promise<T> {
    const response = await this.doFetch(`${this.base}${path}`, {
      headers: this.headers(false),
    })
    if (!response.ok) throw await errorFromResponse(response)
    return (await response.json()) as T
  }

  /** Register one logical source using only safe control metadata from a scoped principal. */
  async registerSource(input: RegisterSourceInput): Promise<SourceManifest> {
    const headers = this.headers(true)
    headers['Idempotency-Key'] = input.idempotencyKey
    const response = await this.doFetch(`${this.base}/api/v1/sources`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        kind: input.kind,
        label: input.label,
        classification: input.classification,
        authority: input.authority,
        audiencePolicyRef: input.audiencePolicyRef,
        sensitivityPolicyRef: input.sensitivityPolicyRef,
        purposePolicyRef: input.purposePolicyRef,
        retentionPolicyRef: input.retentionPolicyRef,
        freshnessPolicyRef: input.freshnessPolicyRef,
      }),
    })
    if (!response.ok) throw await errorFromResponse(response)
    return (await response.json()) as SourceManifest
  }

  /** List one bounded page in the workspace/profile scope carried by the bearer. */
  async sources(options: SourceListOptions = {}): Promise<SourceList> {
    const query = new URLSearchParams()
    if (options.limit !== undefined) query.set('limit', String(options.limit))
    if (options.cursor !== undefined) query.set('cursor', options.cursor)
    const suffix = query.size > 0 ? `?${query.toString()}` : ''
    const response = await this.doFetch(`${this.base}/api/v1/sources${suffix}`, {
      headers: this.headers(false),
    })
    if (!response.ok) throw await errorFromResponse(response)
    return (await response.json()) as SourceList
  }

  /** Read one safe source manifest; cross-scope identities are reported as absent. */
  async source(sourceId: string): Promise<SourceManifest> {
    const response = await this.doFetch(
      `${this.base}/api/v1/sources/${encodeURIComponent(sourceId)}`,
      { headers: this.headers(false) },
    )
    if (!response.ok) throw await errorFromResponse(response)
    return (await response.json()) as SourceManifest
  }

  async createSourceUploadSession(
    sourceId: string,
    input: CreateSourceUploadSessionInput,
  ): Promise<SourceUploadSession> {
    const headers = this.headers(true)
    headers['Idempotency-Key'] = input.idempotencyKey
    const response = await this.doFetch(
      `${this.base}/api/v1/sources/${encodeURIComponent(sourceId)}/upload-sessions`,
      {
        method: 'POST', headers,
        body: JSON.stringify({
          expectedBytes: input.expectedBytes,
          expectedChecksum: input.expectedChecksum,
          declaredMediaType: input.declaredMediaType,
          filename: input.filename,
        }),
      },
    )
    if (!response.ok) throw await errorFromResponse(response)
    return (await response.json()) as SourceUploadSession
  }

  async writeSourceUploadChunk(
    uploadId: string,
    input: WriteSourceUploadChunkInput,
  ): Promise<SourceUploadChunkResult> {
    const headers = this.headers(false)
    headers['Content-Type'] = 'application/offset+octet-stream'
    headers['Upload-Offset'] = String(input.offset)
    headers['Upload-Chunk-Checksum'] = input.checksum
    const response = await this.doFetch(
      `${this.base}/api/v1/source-uploads/${encodeURIComponent(uploadId)}`,
      { method: 'PATCH', headers, body: input.bytes as BodyInit },
    )
    if (!response.ok) throw await errorFromResponse(response)
    return (await response.json()) as SourceUploadChunkResult
  }

  async completeSourceUpload(uploadId: string): Promise<SourceUploadCompletionResult> {
    const response = await this.doFetch(
      `${this.base}/api/v1/source-uploads/${encodeURIComponent(uploadId)}/complete`,
      { method: 'POST', headers: this.headers(false) },
    )
    if (!response.ok) throw await errorFromResponse(response)
    return (await response.json()) as SourceUploadCompletionResult
  }

  async sourceVersion(
    sourceId: string,
    sourceVersionId: string,
  ): Promise<SourceVersionManifest> {
    const response = await this.doFetch(
      `${this.base}/api/v1/sources/${encodeURIComponent(sourceId)}/versions/${encodeURIComponent(sourceVersionId)}`,
      { headers: this.headers(false) },
    )
    if (!response.ok) throw await errorFromResponse(response)
    return (await response.json()) as SourceVersionManifest
  }

  /** Enqueue the allowlisted inspection operation for one exact immutable version. */
  async createSourceJob(
    sourceId: string,
    sourceVersionId: string,
    input: CreateSourceJobInput,
  ): Promise<SourceJob> {
    const headers = this.headers(true)
    headers['Idempotency-Key'] = input.idempotencyKey
    const response = await this.doFetch(
      `${this.base}/api/v1/sources/${encodeURIComponent(sourceId)}/versions/${encodeURIComponent(sourceVersionId)}/jobs`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ operation: input.operation }),
      },
    )
    if (!response.ok) throw await errorFromResponse(response)
    return (await response.json()) as SourceJob
  }

  /** Request the fixed bounded text extraction operation for one inspected current version. */
  async createSourcePreparation(
    sourceId: string,
    sourceVersionId: string,
    input: CreateSourcePreparationInput,
  ): Promise<SourceJob> {
    const headers = this.headers(true)
    headers['Idempotency-Key'] = input.idempotencyKey
    const response = await this.doFetch(
      `${this.base}/api/v1/sources/${encodeURIComponent(sourceId)}/versions/${encodeURIComponent(sourceVersionId)}/preparations`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ operation: input.operation }),
      },
    )
    if (!response.ok) throw await errorFromResponse(response)
    return (await response.json()) as SourceJob
  }

  /** Read one safe source-job projection in the bearer scope. */
  async sourceJob(jobId: string): Promise<SourceJob> {
    const response = await this.doFetch(
      `${this.base}/api/v1/source-jobs/${encodeURIComponent(jobId)}`,
      { headers: this.headers(false) },
    )
    if (!response.ok) throw await errorFromResponse(response)
    return (await response.json()) as SourceJob
  }

  /** Read immutable lineage and freshness metadata; source content is not returned. */
  async sourceResource(resourceId: string): Promise<SourceResourceManifest> {
    const response = await this.doFetch(
      `${this.base}/api/v1/source-resources/${encodeURIComponent(resourceId)}`,
      { headers: this.headers(false) },
    )
    if (!response.ok) throw await errorFromResponse(response)
    return (await response.json()) as SourceResourceManifest
  }

  /** Read a scoped content-free Data View manifest; no cells or placement are returned. */
  async sourceDataView(dataViewId: string): Promise<SourceDataViewManifest> {
    const response = await this.doFetch(
      `${this.base}/api/v1/source-data-views/${encodeURIComponent(dataViewId)}`,
      { headers: this.headers(false) },
    )
    if (!response.ok) throw await errorFromResponse(response)
    return (await response.json()) as SourceDataViewManifest
  }

  /** Owner-only: grant one subject exact fields and a bounded current row window. */
  async createDataViewQueryGrant(
    dataViewId: string,
    input: CreateDataViewQueryGrantInput,
  ): Promise<AccessGrantMutationReceipt> {
    const headers = this.headers(true)
    headers['Idempotency-Key'] = input.idempotencyKey
    const response = await this.doFetch(
      `${this.base}/api/v1/source-data-views/${encodeURIComponent(dataViewId)}/access-grants`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          subjectId: input.subjectId,
          purpose: input.purpose,
          channel: input.channel,
          consent: input.consent,
          fieldIds: input.fieldIds,
          rowOffset: input.rowOffset,
          rowCount: input.rowCount,
          ttlSeconds: input.ttlSeconds,
        }),
      },
    )
    if (!response.ok) throw await errorFromResponse(response)
    return (await response.json()) as AccessGrantMutationReceipt
  }

  /** Delegated-only: select exact fields and one bounded row window after live grant checks. */
  async querySourceDataView(
    dataViewId: string,
    input: QuerySourceDataViewInput,
  ): Promise<ProtectedSourceDataViewSelection> {
    const response = await this.doFetch(
      `${this.base}/api/v1/source-data-views/${encodeURIComponent(dataViewId)}/query`,
      {
        method: 'POST',
        headers: this.headers(true),
        body: JSON.stringify({
          consent: input.consent,
          fieldIds: input.fieldIds,
          rowOffset: input.rowOffset,
          rowCount: input.rowCount,
        }),
      },
    )
    if (!response.ok) throw await errorFromResponse(response)
    return (await response.json()) as ProtectedSourceDataViewSelection
  }

  /** Owner-only: grant one subject bounded observation of one current text resource. */
  async createAccessGrant(
    resourceId: string,
    input: CreateAccessGrantInput,
  ): Promise<AccessGrantMutationReceipt> {
    const headers = this.headers(true)
    headers['Idempotency-Key'] = input.idempotencyKey
    const response = await this.doFetch(
      `${this.base}/api/v1/source-resources/${encodeURIComponent(resourceId)}/access-grants`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...(input.operation === undefined ? {} : { operation: input.operation }),
          subjectId: input.subjectId,
          purpose: input.purpose,
          channel: input.channel,
          consent: input.consent,
          ttlSeconds: input.ttlSeconds,
        }),
      },
    )
    if (!response.ok) throw await errorFromResponse(response)
    return (await response.json()) as AccessGrantMutationReceipt
  }

  /** Owner-only: inspect one current immutable grant revision. */
  async accessGrant(grantId: string): Promise<AccessGrant> {
    const response = await this.doFetch(
      `${this.base}/api/v1/access-grants/${encodeURIComponent(grantId)}`,
      { headers: this.headers(false) },
    )
    if (!response.ok) throw await errorFromResponse(response)
    return (await response.json()) as AccessGrant
  }

  /** Owner-only: list current grant revisions with explicit lifecycle truth. */
  async accessGrants(options: AccessGrantListOptions = {}): Promise<AccessGrantList> {
    const query = new URLSearchParams()
    if (options.limit !== undefined) query.set('limit', String(options.limit))
    if (options.cursor !== undefined) query.set('cursor', options.cursor)
    const suffix = query.size > 0 ? `?${query.toString()}` : ''
    const response = await this.doFetch(`${this.base}/api/v1/access-grants${suffix}`, {
      headers: this.headers(false),
    })
    if (!response.ok) throw await errorFromResponse(response)
    return (await response.json()) as AccessGrantList
  }

  /** Owner-only: revoke exactly the revision the caller inspected. */
  async revokeAccessGrant(
    grantId: string,
    input: RevokeAccessGrantInput,
  ): Promise<AccessGrantMutationReceipt> {
    const headers = this.headers(true)
    headers['Idempotency-Key'] = input.idempotencyKey
    const response = await this.doFetch(
      `${this.base}/api/v1/access-grants/${encodeURIComponent(grantId)}/revoke`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ expectedRevision: input.expectedRevision }),
      },
    )
    if (!response.ok) throw await errorFromResponse(response)
    return (await response.json()) as AccessGrantMutationReceipt
  }

  /** Delegated-only: read one UTF-8 byte range after live grant evaluation. */
  async readSourceContent(
    resourceId: string,
    input: ReadSourceContentInput,
  ): Promise<ProtectedSourceContent> {
    const response = await this.doFetch(
      `${this.base}/api/v1/source-resources/${encodeURIComponent(resourceId)}/content`,
      {
        method: 'POST',
        headers: this.headers(true),
        body: JSON.stringify({
          consent: input.consent,
          byteStart: input.byteStart,
          byteEnd: input.byteEnd,
        }),
      },
    )
    if (!response.ok) throw await errorFromResponse(response)
    return (await response.json()) as ProtectedSourceContent
  }

  /** Delegated-only: search one current prepared UTF-8 resource after live grant evaluation. */
  async searchSourceContent(
    resourceId: string,
    input: SearchSourceContentInput,
  ): Promise<ProtectedSourceSearchResult> {
    const response = await this.doFetch(
      `${this.base}/api/v1/source-resources/${encodeURIComponent(resourceId)}/content/search`,
      {
        method: 'POST',
        headers: this.headers(true),
        body: JSON.stringify({
          consent: input.consent,
          query: input.query,
          matchMode: input.matchMode,
          maxMatches: input.maxMatches,
          contextBytes: input.contextBytes,
        }),
      },
    )
    if (!response.ok) throw await errorFromResponse(response)
    return (await response.json()) as ProtectedSourceSearchResult
  }

  /** Request cancellation without claiming that in-flight work has stopped. */
  async cancelSourceJob(jobId: string): Promise<SourceJobCancellationResult> {
    const response = await this.post(
      `/api/v1/source-jobs/${encodeURIComponent(jobId)}/cancel`,
      {},
    )
    return (await response.json()) as SourceJobCancellationResult
  }

  /** Freeze one exact source revision and enqueue its verified deletion. */
  async createSourceDeletion(
    sourceId: string,
    input: CreateSourceDeletionInput,
  ): Promise<SourceDeletion> {
    const headers = this.headers(true)
    headers['Idempotency-Key'] = input.idempotencyKey
    const response = await this.doFetch(
      `${this.base}/api/v1/sources/${encodeURIComponent(sourceId)}/deletions`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ expectedRevision: input.expectedRevision }),
      },
    )
    if (!response.ok) throw await errorFromResponse(response)
    return (await response.json()) as SourceDeletion
  }

  /** Read safe deletion progress without artifact identities or storage detail. */
  async sourceDeletion(jobId: string): Promise<SourceDeletion> {
    const response = await this.doFetch(
      `${this.base}/api/v1/source-deletions/${encodeURIComponent(jobId)}`,
      { headers: this.headers(false) },
    )
    if (!response.ok) throw await errorFromResponse(response)
    return (await response.json()) as SourceDeletion
  }

  /** Request cancellation before destructive work begins. */
  async cancelSourceDeletion(jobId: string): Promise<SourceDeletionCancellationResult> {
    const response = await this.post(
      `/api/v1/source-deletions/${encodeURIComponent(jobId)}/cancel`,
      {},
    )
    return (await response.json()) as SourceDeletionCancellationResult
  }

  /** Requeue only the remaining inventory of a partial deletion. */
  async retrySourceDeletion(jobId: string): Promise<SourceDeletionRetryResult> {
    const response = await this.post(
      `/api/v1/source-deletions/${encodeURIComponent(jobId)}/retry`,
      {},
    )
    return (await response.json()) as SourceDeletionRetryResult
  }

  /** Validate bounded portable Agent Kit bytes without installing or activating them. */
  async validateCandidate(input: ValidateCandidateInput): Promise<CandidateValidationResult> {
    const response = await this.post('/api/v1/candidates/validate', {
      files: input.files.map((file) => ({
        path: file.path,
        contentBase64: file.contentBase64,
      })),
    })
    return (await response.json()) as CandidateValidationResult
  }

  /** Stage exact validated bytes privately without changing the active profile. */
  async stageCandidate(input: StageCandidateInput): Promise<CandidateStageResult> {
    const response = await this.post('/api/v1/candidates/stage', {
      candidateId: input.candidateId,
      files: input.files.map((file) => ({
        path: file.path,
        contentBase64: file.contentBase64,
      })),
    })
    return (await response.json()) as CandidateStageResult
  }

  /** Atomically activate a ready candidate when the expected active identity still matches. */
  async activateCandidate(input: ActivateCandidateInput): Promise<CandidateActivationResult> {
    const response = await this.post('/api/v1/candidates/activate', {
      profileId: input.profileId,
      candidateId: input.candidateId,
      expectedActiveCandidateId: input.expectedActiveCandidateId,
      ...(input.expectedDeploymentRevision !== undefined
        ? { expectedDeploymentRevision: input.expectedDeploymentRevision }
        : {}),
    })
    return (await response.json()) as CandidateActivationResult
  }

  /** Roll back to a named ready candidate under the same compare-and-set fence. */
  async rollbackCandidate(input: ActivateCandidateInput): Promise<CandidateRollbackResult> {
    const response = await this.post('/api/v1/candidates/rollback', {
      profileId: input.profileId,
      candidateId: input.candidateId,
      expectedActiveCandidateId: input.expectedActiveCandidateId,
      ...(input.expectedDeploymentRevision !== undefined
        ? { expectedDeploymentRevision: input.expectedDeploymentRevision }
        : {}),
    })
    return (await response.json()) as CandidateRollbackResult
  }

  /** Pause one deployed profile so no new API, schedule or channel run can be accepted. */
  async pauseProfile(input: ProfileDeploymentMutationInput): Promise<ProfileDeploymentResult> {
    return this.mutateProfileRouting('pause', input)
  }

  /** Reverify the exact active candidate and resume new-run acceptance. */
  async resumeProfile(input: ProfileDeploymentMutationInput): Promise<ProfileDeploymentResult> {
    return this.mutateProfileRouting('resume', input)
  }

  /** Remove a paused, drained candidate deployment without deleting candidate bytes. */
  async undeployProfile(input: ProfileUndeployInput): Promise<ProfileUndeployResult> {
    const headers = this.headers(true)
    headers['Idempotency-Key'] = input.idempotencyKey
    const response = await this.doFetch(
      `${this.base}/api/v1/profiles/${encodeURIComponent(input.profileId)}/undeploy`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          expectedActiveCandidateId: input.expectedActiveCandidateId,
          expectedDeploymentRevision: input.expectedDeploymentRevision,
        }),
      },
    )
    if (!response.ok) throw await errorFromResponse(response)
    return (await response.json()) as ProfileUndeployResult
  }

  private async mutateProfileRouting(
    operation: 'pause' | 'resume',
    input: ProfileDeploymentMutationInput,
  ): Promise<ProfileDeploymentResult> {
    const headers = this.headers(true)
    headers['Idempotency-Key'] = input.idempotencyKey
    const response = await this.doFetch(
      `${this.base}/api/v1/profiles/${encodeURIComponent(input.profileId)}/${operation}`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          expectedDeploymentRevision: input.expectedDeploymentRevision,
        }),
      },
    )
    if (!response.ok) throw await errorFromResponse(response)
    return (await response.json()) as ProfileDeploymentResult
  }

  /** Read one bounded candidate status without exposing its runtime directory or bytes. */
  async candidate(candidateId: string): Promise<CandidateStatus> {
    const response = await this.doFetch(
      `${this.base}/api/v1/profile-candidates/${encodeURIComponent(candidateId)}`,
      { headers: this.headers(false) },
    )
    if (!response.ok) throw await errorFromResponse(response)
    return (await response.json()) as CandidateStatus
  }

  /** List bounded candidate status for one profile. */
  async candidates(profileId: string): Promise<CandidateList> {
    const response = await this.doFetch(
      `${this.base}/api/v1/profiles/${encodeURIComponent(profileId)}/candidates`,
      { headers: this.headers(false) },
    )
    if (!response.ok) throw await errorFromResponse(response)
    return (await response.json()) as CandidateList
  }

  /** Read one profile's durable deployment revision, routing and observed health. */
  async deployment(profileId: string): Promise<ProfileDeploymentStatus> {
    const response = await this.doFetch(
      `${this.base}/api/v1/profiles/${encodeURIComponent(profileId)}/deployment`,
      { headers: this.headers(false) },
    )
    if (!response.ok) throw await errorFromResponse(response)
    return (await response.json()) as ProfileDeploymentStatus
  }

  /** Read active or explicitly undeployed durable state without overloading legacy reads. */
  async deploymentState(profileId: string): Promise<ProfileDeploymentState> {
    const response = await this.doFetch(
      `${this.base}/api/v1/profiles/${encodeURIComponent(profileId)}/deployment-state`,
      { headers: this.headers(false) },
    )
    if (!response.ok) throw await errorFromResponse(response)
    return (await response.json()) as ProfileDeploymentState
  }

  /** Delete only an eligible unreferenced candidate; explicit failure remains non-success. */
  async deleteCandidate(candidateId: string): Promise<CandidateDeletionResult> {
    const response = await this.doFetch(
      `${this.base}/api/v1/profile-candidates/${encodeURIComponent(candidateId)}`,
      { method: 'DELETE', headers: this.headers(false) },
    )
    if (!response.ok) throw await errorFromResponse(response)
    return (await response.json()) as CandidateDeletionResult
  }

  /** Start a run. Returns immediately — stream the reply separately. */
  async run(input: RunInput): Promise<RunResult> {
    const body: Record<string, unknown> = { prompt: input.prompt, profileId: input.profileId }
    if (input.threadId) body['threadId'] = input.threadId
    if (input.model) body['model'] = input.model
    if (input.workspaceId) body['workspaceId'] = input.workspaceId
    if (input.attachments) body['attachments'] = input.attachments
    if (input.egressMode) body['egressMode'] = input.egressMode
    if (input.interactionCapabilities) {
      body['interactionCapabilities'] = input.interactionCapabilities
    }

    const headers = this.headers(true)
    if (input.idempotencyKey) headers['Idempotency-Key'] = input.idempotencyKey
    const res = await this.doFetch(`${this.base}/api/v1/run`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
    if (!res.ok) throw await errorFromResponse(res)
    const data = await readJsonResponse(res, 'run start')
    return parseRunResult(data, res.status, input)
  }

  /**
   * Hydrate durable thread history. A non-null runningRunId is safe to pass to
   * the bounded run stream; null never implies that a historical run ID was
   * inferred from message or event order.
   */
  async hydrateThread(threadId: string): Promise<ThreadHydration> {
    const response = await this.doFetch(
      `${this.base}/api/v1/threads/${encodeURIComponent(threadId)}/hydrate`,
      { headers: this.headers(false) },
    )
    if (!response.ok) throw await errorFromResponse(response)
    return (await response.json()) as ThreadHydration
  }

  /**
   * One run's reply as text deltas → done/error. Pass the immutable
   * runId returned by run() for bounded replay. A legacy thread ID keeps
   * using the older unbounded thread stream for v1 compatibility.
   */
  async *streamReply(runIdOrThreadId: string, opts: StreamReplyOptions = {}): AsyncIterable<RunStreamEvent> {
    let lastSeq = opts.since ?? 0
    for await (const frame of this.rawFrames(runIdOrThreadId, opts.since, opts.signal)) {
      const { event, stop, seq } = interpretSseEvent(frame.event, frame.data, lastSeq)
      lastSeq = seq
      if (event) yield event
      if (stop) break
    }
  }

  /**
   * The RAW event stream — every gateway event (tool calls, permission
   * requests, thinking, usage…), uninterpreted, with its seq. A run-ID stream
   * closes at that run's terminal boundary; a legacy thread-ID stream stays
   * open until the caller stops reading or aborts. Use `streamReply` for
   * "one reply as text".
   */
  async *events(runIdOrThreadId: string, opts: StreamReplyOptions = {}): AsyncIterable<GatewayEvent> {
    let lastSeq = opts.since ?? 0
    for await (const frame of this.rawFrames(runIdOrThreadId, opts.since, opts.signal)) {
      const seq = typeof frame.data['seq'] === 'number' ? (frame.data['seq'] as number) : lastSeq
      lastSeq = seq
      const type = typeof frame.data['type'] === 'string' ? (frame.data['type'] as string) : frame.event
      yield { type, seq, data: frame.data }
    }
  }

  /**
   * Live-tail ONE sub-agent's own event stream —
   * `GET /threads/:threadId/agents/:agentId/events`. The parent stream
   * carries only `agent.spawn`/`agent.complete`; a client that wants the
   * child's live detail subscribes here. It uses the same
   * `{type, seq, data}` framing as `events()`.
   */
  async *agentEvents(
    threadId: string,
    agentId: string,
    opts: StreamReplyOptions = {},
  ): AsyncIterable<GatewayEvent> {
    const path = `/api/v1/threads/${encodeURIComponent(threadId)}/agents/${encodeURIComponent(agentId)}/events`
    const url = `${this.base}${path}${opts.since === undefined ? '' : `?since=${opts.since}`}`
    const init: RequestInit = { headers: this.headers(false) }
    if (opts.signal) init.signal = opts.signal
    const res = await this.doFetch(url, init)
    if (!res.ok) throw await errorFromResponse(res)
    if (!res.body) {
      throw new OwnwareError({
        message: 'Ownware stream response had no body',
        status: res.status,
        code: 'stream_body_missing',
        category: 'network',
      })
    }
    let lastSeq = opts.since ?? 0
    for await (const frame of parseSseFrames(res.body)) {
      const data =
        frame.data !== null && typeof frame.data === 'object'
          ? (frame.data as Record<string, unknown>)
          : {}
      const seq = typeof data['seq'] === 'number' ? (data['seq'] as number) : lastSeq
      lastSeq = seq
      const type = typeof data['type'] === 'string' ? (data['type'] as string) : frame.event
      yield { type, seq, data }
    }
  }

  /**
   * One-shot JSON snapshot of a sub-agent's full event log —
   * `GET /threads/:threadId/agents/:agentId/events/history`.
   */
  async agentEventHistory(
    threadId: string,
    agentId: string,
  ): Promise<ReadonlyArray<{ seq: number; type: string; payload: Record<string, unknown> }>> {
    const res = await this.doFetch(
      `${this.base}/api/v1/threads/${encodeURIComponent(threadId)}/agents/${encodeURIComponent(agentId)}/events/history`,
      { headers: this.headers(false) },
    )
    if (!res.ok) throw await errorFromResponse(res)
    const body = (await res.json()) as {
      events?: Array<{ seq: number; type: string; payload: Record<string, unknown> }>
    }
    return body.events ?? []
  }

  /** Owner-only legacy pause response; public/delegated callers use decidePermission. */
  async resume(threadId: string, input: ResumeInput): Promise<void> {
    const body: Record<string, unknown> = { action: input.action }
    if (input.scope !== undefined) body['scope'] = input.scope
    if (input.answer !== undefined) body['answer'] = input.answer
    if (input.requestId !== undefined) body['requestId'] = input.requestId
    if (input.grantPath !== undefined) body['grantPath'] = input.grantPath
    await this.post(`/api/v1/threads/${encodeURIComponent(threadId)}/resume`, body)
  }

  /** Decide one exact run permission request; never approves/denies siblings. */
  async decidePermission(
    runId: string,
    requestId: string,
    input: PermissionDecisionInput,
  ): Promise<PermissionDecisionResult> {
    const res = await this.post(
      `/api/v1/runs/${encodeURIComponent(runId)}/permissions/${encodeURIComponent(requestId)}/decision`,
      { decision: input.decision, operationHash: input.operationHash },
    )
    const value = await readJsonResponse(res, 'permission decision')
    return parsePermissionDecisionResult(value, res.status, runId, requestId, input)
  }

  /** Submit one sensitive value without JSON serialization or response echo. */
  async submitSensitiveInput(
    runId: string,
    requestId: string,
    value: string,
  ): Promise<SensitiveInputDecisionResult> {
    const headers = this.headers(false)
    headers['Content-Type'] = 'text/plain; charset=utf-8'
    const response = await this.doFetch(
      `${this.base}/api/v1/runs/${encodeURIComponent(runId)}/sensitive-input/${encodeURIComponent(requestId)}`,
      { method: 'POST', headers, body: value },
    )
    if (!response.ok) throw await errorFromResponse(response)
    const decision = await readJsonResponse(response, 'sensitive-input decision')
    return parseSensitiveInputDecisionResult(
      decision,
      response.status,
      runId,
      requestId,
      'provided',
    )
  }

  /** Decline one exact pending sensitive-input request. */
  async denySensitiveInput(
    runId: string,
    requestId: string,
  ): Promise<SensitiveInputDecisionResult> {
    const response = await this.doFetch(
      `${this.base}/api/v1/runs/${encodeURIComponent(runId)}/sensitive-input/${encodeURIComponent(requestId)}/deny`,
      { method: 'POST', headers: this.headers(false) },
    )
    if (!response.ok) throw await errorFromResponse(response)
    const decision = await readJsonResponse(response, 'sensitive-input decision')
    return parseSensitiveInputDecisionResult(
      decision,
      response.status,
      runId,
      requestId,
      'denied',
    )
  }

  /** Durably request cancellation for one immutable run. */
  async cancel(runId: string): Promise<RunCancellationResult> {
    const res = await this.post(`/api/v1/runs/${encodeURIComponent(runId)}/cancel`, {})
    const value = await readJsonResponse(res, 'run cancellation')
    return parseRunCancellationResult(value, res.status, runId)
  }

  /** Owner-only legacy thread abort; public/delegated callers use cancel(runId). */
  async abort(threadId: string): Promise<void> {
    await this.post(`/api/v1/threads/${encodeURIComponent(threadId)}/abort`, {})
  }

  /** Read one immutable run's bounded durable lifecycle snapshot. */
  async runSnapshot(runId: string): Promise<RunSnapshot> {
    const res = await this.doFetch(
      `${this.base}/api/v1/runs/${encodeURIComponent(runId)}`,
      { headers: this.headers(false) },
    )
    if (!res.ok) throw await errorFromResponse(res)
    const value = await readJsonResponse(res, 'run snapshot')
    return parseRunSnapshot(value, res.status, runId)
  }

  /** Read immutable, payload-free authority observations for one run. */
  async listEffectReceipts(
    runId: string,
    options: EffectReceiptListOptions = {},
  ): Promise<EffectReceiptPage> {
    const query = new URLSearchParams()
    if (options.limit !== undefined) query.set('limit', String(options.limit))
    if (options.cursor !== undefined) query.set('cursor', options.cursor)
    const suffix = query.size === 0 ? '' : `?${query.toString()}`
    const res = await this.doFetch(
      `${this.base}/api/v1/runs/${encodeURIComponent(runId)}/effect-receipts${suffix}`,
      { headers: this.headers(false) },
    )
    if (!res.ok) throw await errorFromResponse(res)
    const value = await readJsonResponse(res, 'effect receipt page')
    return parseEvidencePage(
      value,
      res.status,
      'effect receipt page',
      (item): item is EffectReceipt => isEffectReceipt(item, runId),
      item => item.receiptId,
    )
  }

  /** Read immutable, content-free outbound route observations for one run. */
  async listEgressReceipts(
    runId: string,
    options: EgressReceiptListOptions = {},
  ): Promise<EgressReceiptPage> {
    const query = new URLSearchParams()
    if (options.limit !== undefined) query.set('limit', String(options.limit))
    if (options.cursor !== undefined) query.set('cursor', options.cursor)
    const suffix = query.size === 0 ? '' : `?${query.toString()}`
    const res = await this.doFetch(
      `${this.base}/api/v1/runs/${encodeURIComponent(runId)}/egress-receipts${suffix}`,
      { headers: this.headers(false) },
    )
    if (!res.ok) throw await errorFromResponse(res)
    const value = await readJsonResponse(res, 'egress receipt page')
    return parseEvidencePage(
      value,
      res.status,
      'egress receipt page',
      (item): item is EgressReceipt => isEgressReceipt(item, runId),
      item => item.receiptId,
    )
  }

  /** Read exact, content-free skill dispatcher observations for one run. */
  async listSkillActivationReceipts(
    runId: string,
    options: SkillActivationReceiptListOptions = {},
  ): Promise<SkillActivationReceiptPage> {
    const query = new URLSearchParams()
    if (options.limit !== undefined) query.set('limit', String(options.limit))
    if (options.cursor !== undefined) query.set('cursor', options.cursor)
    const suffix = query.size === 0 ? '' : `?${query.toString()}`
    const res = await this.doFetch(
      `${this.base}/api/v1/runs/${encodeURIComponent(runId)}/skill-activation-receipts${suffix}`,
      { headers: this.headers(false) },
    )
    if (!res.ok) throw await errorFromResponse(res)
    const value = await readJsonResponse(res, 'skill activation receipt page')
    return parseEvidencePage(
      value,
      res.status,
      'skill activation receipt page',
      (item): item is SkillActivationReceipt => isSkillActivationReceipt(item, runId),
      item => item.receiptId,
    )
  }

  /** Read exact, content-free reversal offers for one run. */
  async listEffectReversalOffers(
    runId: string,
    options: EffectReversalListOptions = {},
  ): Promise<EffectReversalOfferPage> {
    const query = new URLSearchParams()
    if (options.limit !== undefined) query.set('limit', String(options.limit))
    if (options.cursor !== undefined) query.set('cursor', options.cursor)
    const suffix = query.size === 0 ? '' : `?${query.toString()}`
    const response = await this.doFetch(
      `${this.base}/api/v1/runs/${encodeURIComponent(runId)}/reversal-offers${suffix}`,
      { headers: this.headers(false) },
    )
    if (!response.ok) throw await errorFromResponse(response)
    const value = await readJsonResponse(response, 'effect reversal offer page')
    return parseEvidencePage(
      value,
      response.status,
      'effect reversal offer page',
      (item): item is EffectReversalOffer => isEffectReversalOffer(item, runId),
      item => item.offerId,
    )
  }

  /** Execute one exact registered reversal offer. */
  async executeEffectReversal(
    runId: string,
    offerId: string,
    input: ExecuteEffectReversalInput,
  ): Promise<EffectReversalExecutionResult> {
    const headers = this.headers(false)
    headers['Idempotency-Key'] = input.idempotencyKey
    const response = await this.doFetch(
      `${this.base}/api/v1/runs/${encodeURIComponent(runId)}/reversal-offers/${encodeURIComponent(offerId)}/execute`,
      { method: 'POST', headers },
    )
    if (!response.ok) throw await errorFromResponse(response)
    const value = await readJsonResponse(response, 'effect reversal execution')
    return parseEffectReversalExecutionResult(value, response.status, runId, offerId)
  }

  /** Read immutable reversal execution receipts for one run. */
  async listEffectReversalReceipts(
    runId: string,
    options: EffectReversalListOptions = {},
  ): Promise<EffectReversalReceiptPage> {
    const query = new URLSearchParams()
    if (options.limit !== undefined) query.set('limit', String(options.limit))
    if (options.cursor !== undefined) query.set('cursor', options.cursor)
    const suffix = query.size === 0 ? '' : `?${query.toString()}`
    const response = await this.doFetch(
      `${this.base}/api/v1/runs/${encodeURIComponent(runId)}/reversal-receipts${suffix}`,
      { headers: this.headers(false) },
    )
    if (!response.ok) throw await errorFromResponse(response)
    const value = await readJsonResponse(response, 'effect reversal receipt page')
    return parseEvidencePage(
      value,
      response.status,
      'effect reversal receipt page',
      (item): item is EffectReversalReceipt => isEffectReversalReceipt(item, runId),
      item => item.receiptId,
    )
  }

  /**
   * @deprecated Use `providerHubModels()`; this is the old array shape projected
   * from the same canonical Provider Hub generation.
   */
  async models(): Promise<ModelEntry[]> {
    const res = await this.doFetch(`${this.base}/api/v1/models`, { headers: this.headers(false) })
    if (!res.ok) throw await errorFromResponse(res)
    return (await res.json()) as ModelEntry[]
  }

  /** Discover and compare the deliberately published Gateway contract. */
  async capabilities(
    requirements: CapabilityRequirements = {},
  ): Promise<CapabilityNegotiationResult> {
    const res = await this.doFetch(`${this.base}/api/v1/capabilities`, {
      headers: this.headers(false),
    })
    if (res.status === 404) {
      return { status: 'unavailable', missing: ['gateway.capabilities'] }
    }
    if (!res.ok) {
      throw await errorFromResponse(res)
    }

    const value = await readJsonResponse(res, 'gateway capabilities')
    const data = parseGatewayCapabilityDocument(value, res.status)
    const expectedMajor = requirements.requiredMajor ?? 1
    if (data.contract.major !== expectedMajor) {
      return {
        status: 'incompatible',
        expectedMajor,
        actualMajor: data.contract.major,
        contract: data.contract,
        ...(data.limits !== undefined ? { limits: data.limits } : {}),
      }
    }

    const available = new Map(data.capabilities.map((entry) => [entry.id, entry.version]))
    const missing = Object.entries(requirements.requiredCapabilities ?? {})
      .filter(([id, minimum]) => (available.get(id) ?? 0) < minimum)
      .map(([id]) => id)
      .sort()
    if (missing.length > 0) {
      return {
        status: 'unavailable',
        missing,
        contract: data.contract,
        capabilities: data.capabilities,
        ...(data.limits !== undefined ? { limits: data.limits } : {}),
      }
    }

    return {
      status: 'available',
      contract: data.contract,
      capabilities: data.capabilities,
      ...(data.limits !== undefined ? { limits: data.limits } : {}),
    }
  }

  /** Owner-only: issue a short-lived workspace/profile-scoped delegation. */
  async issueDelegation(input: IssueDelegationInput): Promise<IssueDelegationResult> {
    const body: Record<string, unknown> = {
      delegateId: input.delegateId,
      workspaceId: input.workspaceId,
      profileId: input.profileId,
      purpose: input.purpose,
      operations: input.operations,
    }
    if (input.subjectId !== undefined) body['subjectId'] = input.subjectId
    if (input.channel !== undefined) body['channel'] = input.channel
    if (input.ttlSeconds !== undefined) body['ttlSeconds'] = input.ttlSeconds
    const response = await this.post('/api/v1/auth/delegations', body)
    return (await response.json()) as IssueDelegationResult
  }

  /** Owner-only: revoke one delegated token ID immediately. */
  async revokeDelegation(tokenId: string, reason: string): Promise<void> {
    await this.post(
      `/api/v1/auth/delegations/${encodeURIComponent(tokenId)}/revoke`,
      { reason },
    )
  }

  /** The profiles this gateway serves — the pickable agents for a client shell. */
  async profiles(): Promise<ProfileSummary[]> {
    const res = await this.doFetch(`${this.base}/api/v1/profiles`, { headers: this.headers(false) })
    if (!res.ok) throw await errorFromResponse(res)
    let data: unknown
    try {
      data = await res.json()
    } catch {
      throw invalidProfileCatalog(res.status)
    }
    return parseProfileCatalog(data, res.status)
  }

  /** Liveness — the one unauthenticated route. */
  async health(): Promise<HealthResult> {
    const res = await this.doFetch(`${this.base}/api/v1/health`, { headers: this.headers(false) })
    if (!res.ok) throw await errorFromResponse(res)
    return (await res.json()) as HealthResult
  }

  private async *rawFrames(
    runIdOrThreadId: string,
    since: number | undefined,
    signal?: AbortSignal,
  ): AsyncGenerator<{ event: string; data: Record<string, unknown> }> {
    const path = UUID.test(runIdOrThreadId)
      ? `/api/v1/runs/${encodeURIComponent(runIdOrThreadId)}/events`
      : `/api/v1/threads/${encodeURIComponent(runIdOrThreadId)}/agents/root/events`
    const url = `${this.base}${path}${since === undefined ? '' : `?since=${since}`}`
    const init: RequestInit = { headers: this.headers(false) }
    if (signal) init.signal = signal

    const res = await this.doFetch(url, init)
    if (!res.ok) throw await errorFromResponse(res)
    if (!res.body) {
      throw new OwnwareError({
        message: 'Ownware stream response had no body',
        status: res.status,
        code: 'stream_body_missing',
        category: 'network',
      })
    }

    for await (const frame of parseSseFrames(res.body as ReadableStream<Uint8Array>)) {
      if (typeof frame.data !== 'object' || frame.data === null) continue
      yield { event: frame.event, data: frame.data as Record<string, unknown> }
    }
  }
}

/**
 * Back-compat name from the shuttle era — same class. Prefer
 * `OwnwareClient` in new code.
 */
export { OwnwareClient as HttpGatewayClient }
export type { OwnwareClientOptions as HttpGatewayClientOptions }

const SAFE_ERROR_TOKEN = /^[a-z][a-z0-9_]{0,63}$/
const SAFE_CORRELATION_ID = /^[A-Za-z0-9-]{1,128}$/
const MAX_ERROR_BODY_CHARS = 8_192
const MAX_SAFE_MESSAGE_CHARS = 500

async function errorFromResponse(res: Response): Promise<OwnwareError> {
  let body: Record<string, unknown> = {}
  try {
    const raw = await res.text()
    if (raw.length <= MAX_ERROR_BODY_CHARS) {
      const parsed = JSON.parse(raw) as unknown
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>
      }
    }
  } catch {
    // Older or intermediary responses may not be JSON. Never echo raw text.
  }

  const code = typeof body['error'] === 'string' && SAFE_ERROR_TOKEN.test(body['error'])
    ? body['error']
    : undefined
  const category = typeof body['category'] === 'string' && SAFE_ERROR_TOKEN.test(body['category'])
    ? body['category']
    : undefined
  const message = typeof body['message'] === 'string' && body['message'].length > 0 &&
      body['message'].length <= MAX_SAFE_MESSAGE_CHARS
    ? body['message']
    : undefined
  const isCommonEnvelope = code !== undefined && category !== undefined && message !== undefined

  const bodyCorrelation = typeof body['correlationId'] === 'string' &&
      SAFE_CORRELATION_ID.test(body['correlationId'])
    ? body['correlationId']
    : undefined
  const headerCorrelationRaw = res.headers.get('x-ownware-correlation-id')
  const headerCorrelation = headerCorrelationRaw !== null && SAFE_CORRELATION_ID.test(headerCorrelationRaw)
    ? headerCorrelationRaw
    : undefined
  const retryAfterBody = typeof body['retryAfter'] === 'number' &&
      Number.isFinite(body['retryAfter']) && body['retryAfter'] >= 0
    ? body['retryAfter']
    : undefined
  const retryAfterHeaderRaw = res.headers.get('retry-after')
  const retryAfterHeader = retryAfterHeaderRaw !== null ? Number.parseInt(retryAfterHeaderRaw, 10) : NaN
  const retryAfterSeconds = retryAfterBody ??
    (Number.isFinite(retryAfterHeader) && retryAfterHeader >= 0 ? retryAfterHeader : undefined)
  const actualRevision = code === 'source_upload_refresh_conflict' &&
      typeof body['actualRevision'] === 'number' && Number.isSafeInteger(body['actualRevision']) &&
      body['actualRevision'] > 0
    ? body['actualRevision']
    : undefined
  const rawActualCurrentVersionId = body['actualCurrentVersionId']
  const actualCurrentVersionId = code === 'source_upload_refresh_conflict' &&
      (rawActualCurrentVersionId === null ||
        (typeof rawActualCurrentVersionId === 'string' && UUID.test(rawActualCurrentVersionId)))
    ? rawActualCurrentVersionId
    : undefined
  const sourceQuotaResourceClasses: readonly SourceQuotaResourceClass[] = [
    'source_registrations', 'source_storage_bytes', 'source_upload_sessions',
    'source_jobs', 'source_derived_resources',
  ]
  const resourceClass = code === 'source_quota_exceeded' &&
      sourceQuotaResourceClasses.includes(body['resourceClass'] as SourceQuotaResourceClass)
    ? body['resourceClass'] as SourceQuotaResourceClass
    : undefined

  return new OwnwareError({
    message: isCommonEnvelope ? message : 'Ownware request failed',
    status: res.status,
    code: isCommonEnvelope ? code : 'unknown_error',
    category: isCommonEnvelope ? category : 'unknown',
    ...(bodyCorrelation ?? headerCorrelation
      ? { correlationId: bodyCorrelation ?? headerCorrelation }
      : {}),
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    ...(actualRevision !== undefined && actualCurrentVersionId !== undefined
      ? { actualRevision, actualCurrentVersionId }
      : {}),
    ...(resourceClass !== undefined ? { resourceClass } : {}),
  })
}
