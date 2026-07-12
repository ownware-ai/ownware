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

// ── inputs / outputs ─────────────────────────────────────────────────────────

export interface RunInput {
  readonly profileId: string
  readonly prompt: string
  readonly threadId?: string
  readonly model?: string
  /** Bounded one-turn data; never registered as reusable knowledge. */
  readonly attachments?: readonly RunAttachmentInput[]
  /** UUID reused only when retrying this exact logical run start. */
  readonly idempotencyKey?: string
}

export interface RunAttachmentInput {
  readonly filename: string
  /** Strict canonical base64. */
  readonly data: string
  readonly mimeType: string
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
  readonly status?: string
  /** Gateway-enforced wall-clock timeout for this run, in milliseconds. */
  readonly timeoutMs?: number
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

export interface RunSnapshot {
  readonly runId: string
  readonly threadId: string
  readonly workspaceId: string | null
  readonly profileId: string
  readonly candidateId?: string | null
  readonly model: string
  readonly timeoutMs: number
  readonly status: DurableRunStatus
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
}

export interface RunCancellationResult {
  readonly runId: string
  readonly status: DurableRunStatus
  readonly terminal: boolean
  readonly outcomeKnown: boolean
  readonly cancellation: 'requested' | 'already_requested' | 'already_terminal'
}

/** One entry from GET /api/v1/models. */
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
  readonly sourceList?: {
    readonly maxPageSize: number
  }
  readonly sourceUpload?: {
    readonly maxDecodedBytes: number
    readonly maxChunkBytes: number
    readonly maxChunks: number
    readonly sessionTtlSeconds: number
    readonly supportedMediaTypes: readonly string[]
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

export interface CreateSourceUploadSessionInput {
  readonly expectedBytes: number
  readonly expectedChecksum: string
  readonly declaredMediaType: 'text/plain' | 'application/pdf'
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
  readonly declaredMediaType: 'text/plain' | 'application/pdf'
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
  readonly verifiedMediaType: 'text/plain' | 'application/pdf'
  readonly byteCount: number
  readonly inspection: 'not_started'
  readonly createdAt: number
}

export interface SourceUploadCompletionResult extends SourceVersionManifest {
  readonly replayed: boolean
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

/**
 * The minimal seam a channel adapter (or any driver) needs. `OwnwareClient`
 * implements it; tests substitute an in-memory fake.
 */
export interface GatewayClient {
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
  validateCandidate(input: ValidateCandidateInput): Promise<CandidateValidationResult>
  stageCandidate(input: StageCandidateInput): Promise<CandidateStageResult>
  activateCandidate(input: ActivateCandidateInput): Promise<CandidateActivationResult>
  rollbackCandidate(input: ActivateCandidateInput): Promise<CandidateRollbackResult>
  pauseProfile(input: ProfileDeploymentMutationInput): Promise<ProfileDeploymentResult>
  resumeProfile(input: ProfileDeploymentMutationInput): Promise<ProfileDeploymentResult>
  candidate(candidateId: string): Promise<CandidateStatus>
  candidates(profileId: string): Promise<CandidateList>
  deployment(profileId: string): Promise<ProfileDeploymentStatus>
  deleteCandidate(candidateId: string): Promise<CandidateDeletionResult>
  run(input: RunInput): Promise<RunResult>
  streamReply(runIdOrThreadId: string, opts?: StreamReplyOptions): AsyncIterable<RunStreamEvent>
  /**
   * Owner-only legacy compatibility surface. Delegated/public clients use
   * decidePermission so one response cannot affect sibling requests.
   */
  resume(threadId: string, input: ResumeInput): Promise<void>
  /** Answer exactly one run-scoped `permission` event. */
  decidePermission(
    runId: string,
    requestId: string,
    input: PermissionDecisionInput,
  ): Promise<PermissionDecisionResult>
  /** Durably request cancellation for one immutable run. */
  cancel(runId: string): Promise<RunCancellationResult>
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

  constructor(input: {
    readonly message: string
    readonly status: number
    readonly code: string
    readonly category: string
    readonly correlationId?: string
    readonly retryAfterSeconds?: number
  }) {
    super(input.message)
    this.name = 'OwnwareError'
    this.status = input.status
    this.code = input.code
    this.category = input.category
    this.correlationId = input.correlationId
    this.retryAfterSeconds = input.retryAfterSeconds
  }
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
    })
    return (await response.json()) as CandidateActivationResult
  }

  /** Roll back to a named ready candidate under the same compare-and-set fence. */
  async rollbackCandidate(input: ActivateCandidateInput): Promise<CandidateRollbackResult> {
    const response = await this.post('/api/v1/candidates/rollback', {
      profileId: input.profileId,
      candidateId: input.candidateId,
      expectedActiveCandidateId: input.expectedActiveCandidateId,
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
    if (input.attachments) body['attachments'] = input.attachments

    const headers = this.headers(true)
    if (input.idempotencyKey) headers['Idempotency-Key'] = input.idempotencyKey
    const res = await this.doFetch(`${this.base}/api/v1/run`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
    if (!res.ok) throw await errorFromResponse(res)
    const data = (await res.json()) as RunResult & { threadId?: string }
    if (!data.threadId) throw new Error('ownware run response missing threadId')
    return data as RunResult
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

  /** Owner-only legacy pause response; public/delegated callers use decidePermission. */
  async resume(threadId: string, input: ResumeInput): Promise<void> {
    const body: Record<string, unknown> = { action: input.action }
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
    return (await res.json()) as PermissionDecisionResult
  }

  /** Durably request cancellation for one immutable run. */
  async cancel(runId: string): Promise<RunCancellationResult> {
    const res = await this.post(`/api/v1/runs/${encodeURIComponent(runId)}/cancel`, {})
    return (await res.json()) as RunCancellationResult
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
    return (await res.json()) as RunSnapshot
  }

  /** The model catalog with live availability (`hasCredentials`). */
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

    const data = (await res.json()) as {
      contract: GatewayContractDescriptor
      capabilities: readonly GatewayCapability[]
      limits?: PublicGatewayLimits
    }
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
    const data = (await res.json()) as ProfileSummary[] | { profiles?: ProfileSummary[] }
    return Array.isArray(data) ? data : (data.profiles ?? [])
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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
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

  return new OwnwareError({
    message: isCommonEnvelope ? message : 'Ownware request failed',
    status: res.status,
    code: isCommonEnvelope ? code : 'unknown_error',
    category: isCommonEnvelope ? category : 'unknown',
    ...(bodyCorrelation ?? headerCorrelation
      ? { correlationId: bodyCorrelation ?? headerCorrelation }
      : {}),
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  })
}
