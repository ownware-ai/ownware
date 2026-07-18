import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { RuntimePrincipal } from './auth/scoped-principal.js'

export const IDEMPOTENCY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const IDEMPOTENCY_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SAFE_SOURCE_LABEL = /^[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$/u
const SAFE_POLICY_REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export interface RunStartSnapshot {
  readonly runId?: string
  readonly threadId: string
  readonly agentId: 'root'
  readonly profileId: string
  readonly candidateId: string | null
  readonly model: string
  readonly status: 'running'
  readonly timeoutMs?: number
}

export interface DeploymentMutationSnapshot {
  readonly state: 'active' | 'paused'
  readonly changed: boolean
  readonly profileId: string
  readonly activeCandidateId: string
  readonly deploymentRevision: number
  readonly routingState: 'active' | 'paused'
  readonly health: 'unknown' | 'starting' | 'healthy' | 'degraded' | 'unhealthy'
  readonly healthObservedAt: number | null
  readonly activeRunCount: number
}

export interface SourceRegistrationSnapshot {
  readonly sourceId: string
  readonly kind: 'file' | 'text' | 'visual' | 'structured_export' |
    'cloud_document' | 'connected_snapshot' | 'supported_other'
  readonly label: string
  readonly classification: 'public' | 'internal' | 'confidential' | 'restricted'
  readonly authority: 'source_of_record' | 'supporting_reference' | 'example' | 'excluded'
  readonly audiencePolicyRef: string
  readonly sensitivityPolicyRef: string
  readonly purposePolicyRef: string
  readonly retentionPolicyRef: string
  readonly freshnessPolicyRef: string
  readonly revision: number
  readonly currentVersionId: string | null
  readonly health: {
    readonly registration: 'pending'
    readonly inspection: 'not_started'
    readonly preparation: 'not_requested'
    readonly access: 'available'
    readonly freshness: 'unknown'
    readonly conflict: 'none'
    readonly deletion: 'active'
  }
  readonly createdAt: number
  readonly updatedAt: number
}

export interface SourceUploadSessionSnapshot {
  readonly uploadId: string
  readonly sourceId: string
  readonly state: 'open'
  readonly offset: 0
  readonly expectedBytes: number
  readonly expectedChecksum: string
  readonly declaredMediaType: 'text/plain' | 'application/pdf'
  readonly maxChunkBytes: 1048576
  readonly maxChunks: 64
  readonly expiresAt: number
  readonly createdAt: number
}

export interface SourceJobSnapshot {
  readonly jobId: string
  readonly sourceId: string
  readonly sourceVersionId: string
  readonly operation: 'inspect_format' | 'extract_text'
  readonly implementationVersion: 'inspect_format.v1' | 'text_extraction.v1'
  readonly resourceId: string | null
  readonly state: 'queued' | 'running' | 'waiting_for_resource' |
    'cancel_requested' | 'succeeded' | 'partial' | 'failed' | 'cancelled'
  readonly attempt: number
  readonly maxAttempts: 3
  readonly checkpoint: number
  readonly cancelRequestedAt: number | null
  readonly outcomeCode: string | null
  readonly createdAt: number
  readonly updatedAt: number
  readonly terminalAt: number | null
}

export interface SourceDeletionCountsSnapshot {
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

export interface SourceDeletionSnapshot {
  readonly jobId: string
  readonly sourceId: string
  readonly operation: 'delete_source'
  readonly state: 'queued' | 'deleting' | 'cancel_requested' | 'cancelled' |
    'partially_deleted' | 'deleted'
  readonly sourceRevision: number
  readonly affected: SourceDeletionCountsSnapshot
  readonly remaining: SourceDeletionCountsSnapshot
  readonly createdAt: number
  readonly updatedAt: number
  readonly terminalAt: number | null
}

export interface AccessGrantMutationReceipt {
  readonly grantId: string
  readonly revision: number
  readonly mutation: 'created' | 'revoked'
  readonly acceptedAt: number
}

export type IdempotencySnapshot =
  RunStartSnapshot | DeploymentMutationSnapshot | SourceRegistrationSnapshot |
  SourceUploadSessionSnapshot | SourceJobSnapshot | SourceDeletionSnapshot |
  AccessGrantMutationReceipt

export type IdempotencyClaim =
  | { readonly kind: 'claimed'; readonly recordId: string }
  | { readonly kind: 'replay'; readonly statusCode: number; readonly result: IdempotencySnapshot }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'in_progress' }
  | { readonly kind: 'indeterminate' }
  | { readonly kind: 'expired' }

interface ClaimInput {
  readonly principalKey: string
  readonly operation: string
  readonly key: string
  readonly input: unknown
}

interface CompleteInput {
  readonly principalKey: string
  readonly operation: string
  readonly key: string
  readonly statusCode: number
  readonly result: IdempotencySnapshot
}

interface IdempotencyRow {
  readonly principal_key: string
  readonly operation: string
  readonly idempotency_key: string
  readonly request_salt: string
  readonly request_digest: string
  readonly state: 'in_progress' | 'completed' | 'indeterminate'
  readonly lease_owner: string
  readonly status_code: number | null
  readonly result_json: string | null
  readonly expires_at: number
  readonly source_id: string | null
}

export function principalContinuityKey(principal: RuntimePrincipal): string {
  if (principal.kind === 'owner') return 'owner'
  return [
    'delegated',
    principal.delegateId,
    principal.workspaceId,
    principal.profileId,
    principal.purpose,
    principal.channel ?? '',
  ].join('\0')
}

export function isValidIdempotencyKey(value: string): boolean {
  return IDEMPOTENCY_KEY.test(value)
}

export class RunIdempotencyStore {
  constructor(
    private readonly db: Database.Database,
    private readonly leaseOwner: string = randomUUID(),
  ) {}

  claim(input: ClaimInput, now: number = Date.now()): IdempotencyClaim {
    if (!isValidIdempotencyKey(input.key)) throw new Error('Invalid idempotency key')
    const run = this.db.transaction((): IdempotencyClaim => {
      const row = this.find(input)
      if (!row) {
        const salt = randomBytes(16).toString('hex')
        const recordId = randomUUID()
        this.db.prepare(`
          INSERT INTO run_idempotency (
            id, principal_key, operation, idempotency_key, request_salt,
            request_digest, state, lease_owner, status_code, result_json,
            created_at, updated_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'in_progress', ?, NULL, NULL, ?, ?, ?)
        `).run(
          recordId, input.principalKey, input.operation, input.key, salt,
          digestInput(salt, input.input), this.leaseOwner, now, now, now + IDEMPOTENCY_RETENTION_MS,
        )
        return { kind: 'claimed', recordId }
      }

      if (row.request_digest !== digestInput(row.request_salt, input.input)) {
        return { kind: 'conflict' }
      }
      if (row.state === 'completed') {
        if (now > row.expires_at) return { kind: 'expired' }
        if (row.source_id !== null && !this.sourceIsActive(row.source_id)) {
          return { kind: 'indeterminate' }
        }
        const result = parseSnapshot(row.result_json)
        if (row.status_code === null || result === null) {
          this.markRowIndeterminate(input, now)
          return { kind: 'indeterminate' }
        }
        return { kind: 'replay', statusCode: row.status_code, result }
      }
      if (row.state === 'indeterminate') return { kind: 'indeterminate' }
      if (row.lease_owner === this.leaseOwner) return { kind: 'in_progress' }
      this.markRowIndeterminate(input, now)
      return { kind: 'indeterminate' }
    })
    return run.immediate()
  }

  complete(input: CompleteInput, now: number = Date.now()): void {
    const result = validateSnapshot(input.result)
    const sourceId = sourceIdForOperation(input.operation, result)
    const updated = this.db.prepare(`
      UPDATE run_idempotency
      SET state = 'completed', status_code = ?, result_json = ?,
        source_id = COALESCE(?, source_id), updated_at = ?
      WHERE principal_key = ? AND operation = ? AND idempotency_key = ?
        AND state = 'in_progress' AND lease_owner = ?
        AND (? IS NULL OR EXISTS (
          SELECT 1 FROM runtime_sources
          WHERE source_id = ? AND deletion_state = 'active'
        ))
    `).run(
      input.statusCode,
      JSON.stringify(result),
      sourceId,
      now,
      input.principalKey,
      input.operation,
      input.key,
      this.leaseOwner,
      sourceId,
      sourceId,
    )
    if (updated.changes !== 1) throw new Error('Idempotency claim is not completable')
  }

  markIndeterminate(input: Pick<CompleteInput, 'principalKey' | 'operation' | 'key'>, now: number = Date.now()): void {
    this.markRowIndeterminate(input, now)
  }

  abandon(input: Pick<CompleteInput, 'principalKey' | 'operation' | 'key'>): void {
    this.db.prepare(`
      DELETE FROM run_idempotency
      WHERE principal_key = ? AND operation = ? AND idempotency_key = ?
        AND state = 'in_progress' AND lease_owner = ?
    `).run(input.principalKey, input.operation, input.key, this.leaseOwner)
  }

  linkRun(recordId: string, runId: string): void {
    this.db.prepare(
      'UPDATE run_idempotency SET run_id = ? WHERE id = ? AND run_id IS NULL',
    ).run(runId, recordId)
  }

  linkSourceMutation(
    recordId: string,
    sourceId: string,
    kind: 'access_grant',
    now: number = Date.now(),
  ): void {
    if (!IDEMPOTENCY_KEY.test(recordId) || !IDEMPOTENCY_KEY.test(sourceId) ||
        !Number.isSafeInteger(now) || now < 0) {
      throw new Error('Invalid source mutation link')
    }
    const linked = this.db.prepare(`
      UPDATE run_idempotency
      SET source_id = ?, source_mutation_kind = ?, updated_at = ?
      WHERE id = ? AND state = 'in_progress' AND lease_owner = ?
        AND source_id IS NULL AND source_mutation_kind IS NULL
        AND EXISTS (
          SELECT 1 FROM runtime_sources
          WHERE source_id = ? AND deletion_state = 'active'
        )
    `).run(sourceId, kind, now, recordId, this.leaseOwner, sourceId)
    if (linked.changes !== 1) throw new Error('Source mutation link is not available')
  }

  private find(input: Pick<ClaimInput, 'principalKey' | 'operation' | 'key'>): IdempotencyRow | null {
    return (this.db.prepare(`
      SELECT * FROM run_idempotency
      WHERE principal_key = ? AND operation = ? AND idempotency_key = ?
    `).get(input.principalKey, input.operation, input.key) as IdempotencyRow | undefined) ?? null
  }

  private markRowIndeterminate(
    input: Pick<ClaimInput, 'principalKey' | 'operation' | 'key'>,
    now: number,
  ): void {
    this.db.prepare(`
      UPDATE run_idempotency
      SET state = 'indeterminate', status_code = NULL, result_json = NULL, updated_at = ?
      WHERE principal_key = ? AND operation = ? AND idempotency_key = ?
        AND state = 'in_progress'
    `).run(now, input.principalKey, input.operation, input.key)
  }

  private sourceIsActive(sourceId: string): boolean {
    return this.db.prepare(`
      SELECT 1 FROM runtime_sources WHERE source_id = ? AND deletion_state = 'active'
    `).get(sourceId) !== undefined
  }
}

function digestInput(salt: string, input: unknown): string {
  return createHash('sha256').update(salt).update('\0').update(canonicalJson(input)).digest('hex')
}

function sourceIdForOperation(
  operation: string,
  result: IdempotencySnapshot,
): string | null {
  if (![
    'sources.register', 'source_uploads.create',
    'source_jobs.create', 'source_preparations.create',
  ].includes(operation)) return null
  return 'sourceId' in result ? result.sourceId : null
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Idempotency input contains a non-finite number')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`,
    ).join(',')}}`
  }
  throw new Error('Idempotency input contains an unsupported value')
}

function parseSnapshot(json: string | null): IdempotencySnapshot | null {
  if (json === null || json.length > 4096) return null
  try {
    return validateSnapshot(JSON.parse(json))
  } catch {
    return null
  }
}

function validateSnapshot(value: unknown): IdempotencySnapshot {
  if (!value || typeof value !== 'object') throw new Error('Invalid run snapshot')
  const row = value as Record<string, unknown>
  if (typeof row['grantId'] === 'string') return validateAccessGrantReceipt(row)
  if (typeof row['jobId'] === 'string' && row['operation'] === 'delete_source') {
    return validateSourceDeletionSnapshot(row)
  }
  if (typeof row['jobId'] === 'string') return validateSourceJobSnapshot(row)
  if (typeof row['uploadId'] === 'string') return validateSourceUploadSessionSnapshot(row)
  if (typeof row['sourceId'] === 'string') return validateSourceRegistrationSnapshot(row)
  if (row['state'] === 'active' || row['state'] === 'paused') {
    return validateDeploymentSnapshot(row)
  }
  if ((row['runId'] !== undefined &&
        (typeof row['runId'] !== 'string' || row['runId'].length > 128)) ||
      typeof row['threadId'] !== 'string' || row['threadId'].length > 128 ||
      row['agentId'] !== 'root' || typeof row['profileId'] !== 'string' ||
      row['profileId'].length > 128 || typeof row['model'] !== 'string' ||
      (row['candidateId'] !== undefined && row['candidateId'] !== null &&
        (typeof row['candidateId'] !== 'string' ||
          !/^sha256:[0-9a-f]{64}$/.test(row['candidateId']))) ||
      row['model'].length > 256 || row['status'] !== 'running' ||
      (row['timeoutMs'] !== undefined &&
        (!Number.isSafeInteger(row['timeoutMs']) || (row['timeoutMs'] as number) <= 0))) {
    throw new Error('Invalid run snapshot')
  }
  return {
    ...(typeof row['runId'] === 'string' ? { runId: row['runId'] } : {}),
    threadId: row['threadId'],
    agentId: 'root',
    profileId: row['profileId'],
    candidateId: typeof row['candidateId'] === 'string' ? row['candidateId'] : null,
    model: row['model'],
    status: 'running',
    ...(typeof row['timeoutMs'] === 'number' ? { timeoutMs: row['timeoutMs'] } : {}),
  }
}

function validateAccessGrantReceipt(
  row: Record<string, unknown>,
): AccessGrantMutationReceipt {
  if (!IDEMPOTENCY_KEY.test(String(row['grantId'])) ||
      !Number.isSafeInteger(row['revision']) || (row['revision'] as number) < 1 ||
      !['created', 'revoked'].includes(String(row['mutation'])) ||
      !Number.isSafeInteger(row['acceptedAt']) || (row['acceptedAt'] as number) < 0 ||
      Object.keys(row).some((key) => ![
        'grantId', 'revision', 'mutation', 'acceptedAt',
      ].includes(key))) {
    throw new Error('Invalid access grant mutation receipt')
  }
  return {
    grantId: row['grantId'] as string,
    revision: row['revision'] as number,
    mutation: row['mutation'] as AccessGrantMutationReceipt['mutation'],
    acceptedAt: row['acceptedAt'] as number,
  }
}

function validateSourceJobSnapshot(row: Record<string, unknown>): SourceJobSnapshot {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  const states: readonly SourceJobSnapshot['state'][] = [
    'queued', 'running', 'waiting_for_resource', 'cancel_requested',
    'succeeded', 'partial', 'failed', 'cancelled',
  ]
  const outcomeCodes = new Set([
    'attempts_exhausted', 'cancelled', 'source_format_invalid',
    'source_object_mismatch', 'source_object_missing', 'source_object_oversized',
    'source_storage_inconsistent',
    ...(row['operation'] === 'inspect_format'
      ? ['inspection_complete', 'inspection_timeout', 'inspection_unavailable']
      : ['preparation_complete', 'preparation_timeout', 'preparation_unavailable']),
  ])
  const state = row['state'] as SourceJobSnapshot['state']
  const operation = row['operation']
  const expectedImplementation = operation === 'inspect_format'
    ? 'inspect_format.v1' : operation === 'extract_text' ? 'text_extraction.v1' : null
  const implementationVersion = row['implementationVersion'] ??
    (operation === 'inspect_format' ? 'inspect_format.v1' : undefined)
  const resourceId = row['resourceId'] ?? null
  const resourceIdentityValid = operation === 'inspect_format'
    ? resourceId === null
    : state === 'succeeded' ? uuid.test(String(resourceId)) : resourceId === null
  const cancelRequestedAt = row['cancelRequestedAt']
  const terminalAt = row['terminalAt']
  const outcomeCode = row['outcomeCode']
  if (!uuid.test(String(row['jobId'])) || !uuid.test(String(row['sourceId'])) ||
      !uuid.test(String(row['sourceVersionId'])) || expectedImplementation === null ||
      implementationVersion !== expectedImplementation ||
      !resourceIdentityValid ||
      !states.includes(state) || !Number.isInteger(row['attempt']) ||
      (row['attempt'] as number) < 0 || (row['attempt'] as number) > 3 ||
      row['maxAttempts'] !== 3 || !Number.isInteger(row['checkpoint']) ||
      (row['checkpoint'] as number) < 0 || (row['checkpoint'] as number) > 4 ||
      !(cancelRequestedAt === null || Number.isSafeInteger(cancelRequestedAt)) ||
      !(terminalAt === null || Number.isSafeInteger(terminalAt)) ||
      !(outcomeCode === null || (typeof outcomeCode === 'string' && outcomeCodes.has(outcomeCode))) ||
      !Number.isSafeInteger(row['createdAt']) || !Number.isSafeInteger(row['updatedAt']) ||
      (row['updatedAt'] as number) < (row['createdAt'] as number)) {
    throw new Error('Invalid source job snapshot')
  }
  return {
    jobId: row['jobId'] as string,
    sourceId: row['sourceId'] as string,
    sourceVersionId: row['sourceVersionId'] as string,
    operation: operation as SourceJobSnapshot['operation'],
    implementationVersion: expectedImplementation,
    resourceId: resourceId as string | null,
    state,
    attempt: row['attempt'] as number,
    maxAttempts: 3,
    checkpoint: row['checkpoint'] as number,
    cancelRequestedAt: cancelRequestedAt as number | null,
    outcomeCode: outcomeCode as string | null,
    createdAt: row['createdAt'] as number,
    updatedAt: row['updatedAt'] as number,
    terminalAt: terminalAt as number | null,
  }
}

function validateSourceDeletionSnapshot(row: Record<string, unknown>): SourceDeletionSnapshot {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  const states: readonly SourceDeletionSnapshot['state'][] = [
    'queued', 'deleting', 'cancel_requested', 'cancelled',
    'partially_deleted', 'deleted',
  ]
  const state = row['state'] as SourceDeletionSnapshot['state']
  const affected = validateSourceDeletionCounts(row['affected'])
  const remaining = validateSourceDeletionCounts(row['remaining'])
  const terminalAt = row['terminalAt']
  if (!uuid.test(String(row['jobId'])) || !uuid.test(String(row['sourceId'])) ||
      row['operation'] !== 'delete_source' || !states.includes(state) ||
      !Number.isSafeInteger(row['sourceRevision']) || (row['sourceRevision'] as number) < 2 ||
      !Number.isSafeInteger(row['createdAt']) || !Number.isSafeInteger(row['updatedAt']) ||
      (row['updatedAt'] as number) < (row['createdAt'] as number) ||
      !(terminalAt === null || Number.isSafeInteger(terminalAt)) ||
      (state === 'deleted' && terminalAt === null) ||
      (state !== 'deleted' && state !== 'cancelled' && state !== 'partially_deleted' &&
        terminalAt !== null)) {
    throw new Error('Invalid source deletion snapshot')
  }
  return {
    jobId: row['jobId'] as string,
    sourceId: row['sourceId'] as string,
    operation: 'delete_source',
    state,
    sourceRevision: row['sourceRevision'] as number,
    affected,
    remaining,
    createdAt: row['createdAt'] as number,
    updatedAt: row['updatedAt'] as number,
    terminalAt: terminalAt as number | null,
  }
}

function validateSourceDeletionCounts(value: unknown): SourceDeletionCountsSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid source deletion counts')
  }
  const row = value as Record<string, unknown>
  const keys: readonly (keyof SourceDeletionCountsSnapshot)[] = [
    'immutableOriginals', 'uploadStaging', 'placedCandidates', 'derivedResources',
    'dataViews', 'searchIndexes', 'sourceJobs', 'idempotencyReplays',
    'retrievalCacheEntries',
  ]
  if (Object.keys(row).length !== keys.length || keys.some((key) =>
    !Number.isSafeInteger(row[key]) || (row[key] as number) < 0)) {
    throw new Error('Invalid source deletion counts')
  }
  return Object.fromEntries(keys.map((key) => [key, row[key]])) as unknown as
    SourceDeletionCountsSnapshot
}

function validateSourceUploadSessionSnapshot(
  row: Record<string, unknown>,
): SourceUploadSessionSnapshot {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  if (!uuid.test(String(row['uploadId'])) || !uuid.test(String(row['sourceId'])) ||
      row['state'] !== 'open' || row['offset'] !== 0 ||
      !Number.isSafeInteger(row['expectedBytes']) || (row['expectedBytes'] as number) < 1 ||
      (row['expectedBytes'] as number) > 16 * 1024 * 1024 ||
      typeof row['expectedChecksum'] !== 'string' ||
      !/^sha256:[0-9a-f]{64}$/.test(row['expectedChecksum']) ||
      !['text/plain', 'application/pdf'].includes(String(row['declaredMediaType'])) ||
      row['maxChunkBytes'] !== 1024 * 1024 || row['maxChunks'] !== 64 ||
      !Number.isSafeInteger(row['expiresAt']) || !Number.isSafeInteger(row['createdAt']) ||
      (row['expiresAt'] as number) <= (row['createdAt'] as number)) {
    throw new Error('Invalid source upload session snapshot')
  }
  return {
    uploadId: row['uploadId'] as string,
    sourceId: row['sourceId'] as string,
    state: 'open',
    offset: 0,
    expectedBytes: row['expectedBytes'] as number,
    expectedChecksum: row['expectedChecksum'],
    declaredMediaType: row['declaredMediaType'] as SourceUploadSessionSnapshot['declaredMediaType'],
    maxChunkBytes: 1048576,
    maxChunks: 64,
    expiresAt: row['expiresAt'] as number,
    createdAt: row['createdAt'] as number,
  }
}

function validateSourceRegistrationSnapshot(
  row: Record<string, unknown>,
): SourceRegistrationSnapshot {
  const policyRefs = [
    row['audiencePolicyRef'], row['sensitivityPolicyRef'], row['purposePolicyRef'],
    row['retentionPolicyRef'], row['freshnessPolicyRef'],
  ]
  const health = row['health'] as Record<string, unknown> | undefined
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(String(row['sourceId'])) ||
      !['file', 'text', 'visual', 'structured_export', 'cloud_document',
        'connected_snapshot', 'supported_other'].includes(String(row['kind'])) ||
      typeof row['label'] !== 'string' || row['label'].length < 1 || row['label'].length > 160 ||
      !SAFE_SOURCE_LABEL.test(row['label']) ||
      !['public', 'internal', 'confidential', 'restricted'].includes(String(row['classification'])) ||
      !['source_of_record', 'supporting_reference', 'example', 'excluded']
        .includes(String(row['authority'])) ||
      policyRefs.some((value) => typeof value !== 'string' || !SAFE_POLICY_REF.test(value)) ||
      row['revision'] !== 1 || row['currentVersionId'] !== null || !health ||
      health['registration'] !== 'pending' || health['inspection'] !== 'not_started' ||
      health['preparation'] !== 'not_requested' || health['access'] !== 'available' ||
      health['freshness'] !== 'unknown' || health['conflict'] !== 'none' ||
      health['deletion'] !== 'active' || !Number.isSafeInteger(row['createdAt']) ||
      !Number.isSafeInteger(row['updatedAt']) ||
      (row['updatedAt'] as number) < (row['createdAt'] as number)) {
    throw new Error('Invalid source registration snapshot')
  }
  return {
    sourceId: row['sourceId'] as string,
    kind: row['kind'] as SourceRegistrationSnapshot['kind'],
    label: row['label'],
    classification: row['classification'] as SourceRegistrationSnapshot['classification'],
    authority: row['authority'] as SourceRegistrationSnapshot['authority'],
    audiencePolicyRef: row['audiencePolicyRef'] as string,
    sensitivityPolicyRef: row['sensitivityPolicyRef'] as string,
    purposePolicyRef: row['purposePolicyRef'] as string,
    retentionPolicyRef: row['retentionPolicyRef'] as string,
    freshnessPolicyRef: row['freshnessPolicyRef'] as string,
    revision: 1,
    currentVersionId: null,
    health: {
      registration: 'pending',
      inspection: 'not_started',
      preparation: 'not_requested',
      access: 'available',
      freshness: 'unknown',
      conflict: 'none',
      deletion: 'active',
    },
    createdAt: row['createdAt'] as number,
    updatedAt: row['updatedAt'] as number,
  }
}

function validateDeploymentSnapshot(row: Record<string, unknown>): DeploymentMutationSnapshot {
  const candidateId = row['activeCandidateId']
  const revision = row['deploymentRevision']
  const health = row['health']
  const observedAt = row['healthObservedAt']
  const activeRunCount = row['activeRunCount']
  if ((row['state'] !== 'active' && row['state'] !== 'paused') ||
      typeof row['changed'] !== 'boolean' || typeof row['profileId'] !== 'string' ||
      row['profileId'].length === 0 || row['profileId'].length > 128 ||
      typeof candidateId !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(candidateId) ||
      !Number.isSafeInteger(revision) || (revision as number) <= 0 ||
      row['routingState'] !== row['state'] ||
      !['unknown', 'starting', 'healthy', 'degraded', 'unhealthy'].includes(String(health)) ||
      !(observedAt === null || (Number.isSafeInteger(observedAt) && (observedAt as number) >= 0)) ||
      !Number.isSafeInteger(activeRunCount) || (activeRunCount as number) < 0) {
    throw new Error('Invalid deployment mutation snapshot')
  }
  return {
    state: row['state'],
    changed: row['changed'],
    profileId: row['profileId'],
    activeCandidateId: candidateId,
    deploymentRevision: revision as number,
    routingState: row['state'],
    health: health as DeploymentMutationSnapshot['health'],
    healthObservedAt: observedAt as number | null,
    activeRunCount: activeRunCount as number,
  }
}
