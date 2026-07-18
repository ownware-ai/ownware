import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'

const SAFE_SCOPE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SAFE_RESOURCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/
const SAFE_OPERATION = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/
const MAX_SCOPE_IDS = 256
export const ACCESS_GRANT_MAX_ACTIVE_PER_SCOPE = 1_024
export const ACCESS_GRANT_MIN_TTL_SECONDS = 60
export const ACCESS_GRANT_MAX_TTL_SECONDS = 30 * 24 * 60 * 60

export type AccessAutonomy = 'observe' | 'recommend' | 'draft' | 'act'
export type AccessScope =
  | { readonly mode: 'all' }
  | { readonly mode: 'list'; readonly ids: readonly string[] }
export type AccessConsent =
  | { readonly state: 'not_required' }
  | { readonly state: 'recorded'; readonly evidenceId: string }
export type PreparedTextAccessOperation =
  | 'source_content.read'
  | 'source_content.search'

export interface CreateAccessGrantInput {
  readonly workspaceId: string
  readonly profileId: string
  readonly subjectId: string
  readonly purpose: string
  readonly channel: string | null
  readonly resourceKind: string
  readonly resourceId: string
  readonly operation: string
  readonly fieldScope: AccessScope
  readonly rowScope: AccessScope
  readonly consent: AccessConsent
  readonly autonomyCeiling: AccessAutonomy
  readonly effectiveAt: number
  readonly expiresAt: number
  readonly issuedBy: string
}

export interface CreateImmediateAccessGrantInput
  extends Omit<CreateAccessGrantInput, 'effectiveAt' | 'expiresAt'> {
  readonly ttlSeconds: number
}

export interface CreatePreparedTextReadGrantInput {
  readonly workspaceId: string
  readonly profileId: string
  readonly subjectId: string
  readonly purpose: string
  readonly channel: string | null
  readonly resourceId: string
  readonly consent: AccessConsent
  readonly ttlSeconds: number
  readonly issuedBy: string
}

export interface CreatePreparedTextAccessGrantInput
  extends CreatePreparedTextReadGrantInput {
  readonly operation: PreparedTextAccessOperation
}

export interface AccessGrantRevision extends CreateAccessGrantInput {
  readonly grantId: string
  readonly revision: number
  readonly state: 'active' | 'revoked'
  readonly revisionCreatedAt: number
  readonly revokedAt: number | null
}

export type AccessGrantLifecycle = 'scheduled' | 'effective' | 'expired' | 'revoked'

export interface CurrentAccessGrant extends AccessGrantRevision {
  readonly lifecycle: AccessGrantLifecycle
}

export interface AccessGrantPage {
  readonly items: readonly CurrentAccessGrant[]
  readonly nextCursor: string | null
}

export interface AccessGrantSourceIdentity {
  readonly grantId: string
  readonly workspaceId: string
  readonly profileId: string
  readonly sourceId: string
}

export interface SourceDeletionGrantRevocation {
  readonly grantId: string
  readonly revision: number
}

export interface PreparedTextReadTarget {
  readonly workspaceId: string
  readonly profileId: string
  readonly resourceId: string
  readonly jobId: string
  readonly sourceId: string
  readonly sourceVersionId: string
  readonly sourceRevision: number
  readonly objectKey: string
  readonly expectedByteCount: number
  readonly expectedChecksum: string
  readonly classification: 'public' | 'internal' | 'confidential' | 'restricted'
  readonly authority: 'source_of_record' | 'supporting_reference' | 'example'
  readonly audiencePolicyRef: string
  readonly sensitivityPolicyRef: string
  readonly purposePolicyRef: string
  readonly retentionPolicyRef: string
  readonly freshnessPolicyRef: string
}

export class AccessGrantStoreError extends Error {
  constructor(readonly code:
    | 'access_grant_invalid'
     | 'access_grant_not_found'
     | 'access_grant_revision_conflict'
     | 'access_grant_not_active'
     | 'access_grant_limit_exceeded'
     | 'access_grant_resource_unavailable') {
    super(code)
    this.name = 'AccessGrantStoreError'
  }
}

interface AccessGrantRow {
  readonly grant_id: string
  readonly revision: number
  readonly state: string
  readonly workspace_id: string
  readonly profile_id: string
  readonly subject_id: string
  readonly purpose: string
  readonly channel: string | null
  readonly resource_kind: string
  readonly resource_id: string
  readonly operation: string
  readonly field_scope_mode: string
  readonly field_ids_json: string
  readonly row_scope_mode: string
  readonly row_ids_json: string
  readonly consent_state: string
  readonly consent_evidence_id: string | null
  readonly autonomy_ceiling: string
  readonly effective_at: number
  readonly expires_at: number
  readonly issued_by: string
  readonly revision_created_at: number
  readonly revoked_at: number | null
  readonly head_workspace_id: string
  readonly head_profile_id: string
}

export class AccessGrantStore {
  constructor(
    private readonly db: Database.Database,
    private readonly maxActivePerScope: number = ACCESS_GRANT_MAX_ACTIVE_PER_SCOPE,
  ) {
    if (!Number.isSafeInteger(maxActivePerScope) || maxActivePerScope < 1) {
      throw new TypeError('Access grant limit is invalid')
    }
  }

  create(input: CreateAccessGrantInput, now: number = Date.now()): AccessGrantRevision {
    const normalized = normalizeGrantInput(input)
    validateTimestamp(now)
    return this.createNormalized(normalized, now)
  }

  createImmediate(
    input: CreateImmediateAccessGrantInput,
    now: number = Date.now(),
  ): AccessGrantRevision {
    const normalized = normalizeImmediateGrantInput(input, now)
    return this.createNormalized(normalized, now)
  }

  createPreparedTextReadGrant(
    input: CreatePreparedTextReadGrantInput,
    now: number = Date.now(),
  ): AccessGrantRevision {
    return this.createPreparedTextAccessGrant({
      ...input,
      operation: 'source_content.read',
    }, now)
  }

  createPreparedTextAccessGrant(
    input: CreatePreparedTextAccessGrantInput,
    now: number = Date.now(),
  ): AccessGrantRevision {
    const normalized = normalizeImmediateGrantInput({
      workspaceId: input.workspaceId,
      profileId: input.profileId,
      subjectId: input.subjectId,
      purpose: input.purpose,
      channel: input.channel,
      resourceKind: 'source_resource',
      resourceId: input.resourceId,
      operation: input.operation,
      fieldScope: { mode: 'all' },
      rowScope: { mode: 'all' },
      consent: input.consent,
      autonomyCeiling: 'observe',
      ttlSeconds: input.ttlSeconds,
      issuedBy: input.issuedBy,
    }, now)
    return this.db.transaction(() => {
      if (!this.getPreparedTextReadTargetScoped(
        normalized.workspaceId,
        normalized.profileId,
        normalized.resourceId,
      )) {
        throw new AccessGrantStoreError('access_grant_resource_unavailable')
      }
      return this.createNormalizedInTransaction(normalized, now)
    }).immediate()
  }

  private createNormalized(
    normalized: CreateAccessGrantInput,
    now: number,
  ): AccessGrantRevision {
    return this.db.transaction(
      () => this.createNormalizedInTransaction(normalized, now),
    ).immediate()
  }

  private createNormalizedInTransaction(
    normalized: CreateAccessGrantInput,
    now: number,
  ): AccessGrantRevision {
    const active = this.db.prepare(`
      SELECT COUNT(*) AS count FROM access_grants g
      JOIN access_grant_revisions r
        ON r.grant_id = g.grant_id AND r.revision = g.current_revision
      WHERE g.workspace_id = ? AND g.profile_id = ? AND r.state = 'active'
        AND r.expires_at > ?
    `).get(normalized.workspaceId, normalized.profileId, now) as { count: number }
    if (active.count >= this.maxActivePerScope) {
      throw new AccessGrantStoreError('access_grant_limit_exceeded')
    }
    const grantId = randomUUID()
    this.db.prepare(`
      INSERT INTO access_grants (
        grant_id, workspace_id, profile_id, current_revision, created_at
      ) VALUES (?, ?, ?, 1, ?)
    `).run(grantId, normalized.workspaceId, normalized.profileId, now)
    this.insertRevision(grantId, 1, 'active', normalized, now, null)
    return this.getCurrentScoped(
      grantId, normalized.workspaceId, normalized.profileId,
    )!
  }

  getPreparedTextReadTargetScoped(
    workspaceId: string,
    profileId: string,
    resourceId: string,
  ): PreparedTextReadTarget | null {
    if (!isScope(workspaceId) || !isScope(profileId) || !isUuid(resourceId)) return null
    const row = this.db.prepare(`
      SELECT r.workspace_id, r.profile_id, r.resource_id, r.job_id,
        r.source_id, r.source_version_id, r.source_revision,
        v.object_key, v.byte_count, v.checksum,
        r.classification, r.authority, r.audience_policy_ref,
        r.sensitivity_policy_ref, r.purpose_policy_ref,
        r.retention_policy_ref, r.freshness_policy_ref
      FROM source_derived_resources r
      JOIN runtime_sources s
        ON s.source_id = r.source_id
        AND s.workspace_id = r.workspace_id
        AND s.profile_id = r.profile_id
      JOIN source_versions v
        ON v.source_version_id = r.source_version_id
        AND v.source_id = r.source_id
      JOIN source_jobs j
        ON j.job_id = r.job_id
        AND j.workspace_id = r.workspace_id
        AND j.profile_id = r.profile_id
        AND j.source_id = r.source_id
        AND j.source_version_id = r.source_version_id
        AND j.resource_id = r.resource_id
      WHERE r.resource_id = ? AND r.workspace_id = ? AND r.profile_id = ?
        AND r.kind = 'text_extraction' AND r.operation = 'extract_text'
        AND r.implementation_version = 'text_extraction.v1'
        AND r.coverage = 'complete' AND r.freshness = 'current'
        AND r.stale_at IS NULL AND r.byte_start = 0
        AND r.byte_end = r.byte_count
        AND r.source_checksum = v.checksum
        AND r.resource_checksum = v.checksum
        AND r.byte_count = v.byte_count
        AND s.current_version_id = r.source_version_id
        AND s.registration_state = 'registered'
        AND s.inspection_state = 'complete'
        AND s.preparation_state = 'ready'
        AND s.access_state = 'available'
        AND s.freshness_state = 'fresh'
        AND s.conflict_state IN ('none', 'resolved')
        AND s.deletion_state = 'active'
        AND v.verified_media_type = 'text/plain'
        AND v.inspection_state = 'complete'
        AND v.preparation_state = 'ready'
        AND j.operation = 'extract_text'
        AND j.implementation_version = 'text_extraction.v1'
        AND j.source_revision = r.source_revision
        AND j.state = 'succeeded' AND j.checkpoint = 4
        AND j.outcome_code = 'preparation_complete'
        AND j.terminal_at IS NOT NULL
    `).get(resourceId, workspaceId, profileId) as {
      workspace_id: string
      profile_id: string
      resource_id: string
      job_id: string
      source_id: string
      source_version_id: string
      source_revision: number
      object_key: string
      byte_count: number
      checksum: string
      classification: PreparedTextReadTarget['classification']
      authority: PreparedTextReadTarget['authority']
      audience_policy_ref: string
      sensitivity_policy_ref: string
      purpose_policy_ref: string
      retention_policy_ref: string
      freshness_policy_ref: string
    } | undefined
    return row ? {
      workspaceId: row.workspace_id,
      profileId: row.profile_id,
      resourceId: row.resource_id,
      jobId: row.job_id,
      sourceId: row.source_id,
      sourceVersionId: row.source_version_id,
      sourceRevision: row.source_revision,
      objectKey: row.object_key,
      expectedByteCount: row.byte_count,
      expectedChecksum: row.checksum,
      classification: row.classification,
      authority: row.authority,
      audiencePolicyRef: row.audience_policy_ref,
      sensitivityPolicyRef: row.sensitivity_policy_ref,
      purposePolicyRef: row.purpose_policy_ref,
      retentionPolicyRef: row.retention_policy_ref,
      freshnessPolicyRef: row.freshness_policy_ref,
    } : null
  }

  getPreparedTextReadTargetForOwner(resourceId: string): PreparedTextReadTarget | null {
    if (!isUuid(resourceId)) return null
    const scope = this.db.prepare(`
      SELECT workspace_id, profile_id FROM source_derived_resources
      WHERE resource_id = ?
    `).get(resourceId) as { workspace_id: string; profile_id: string } | undefined
    return scope ? this.getPreparedTextReadTargetScoped(
      scope.workspace_id, scope.profile_id, resourceId,
    ) : null
  }

  getCurrentScoped(
    grantId: string,
    workspaceId: string,
    profileId: string,
  ): AccessGrantRevision | null {
    if (!isUuid(grantId) || !isScope(workspaceId) || !isScope(profileId)) return null
    const row = this.db.prepare(`
      SELECT r.*, g.workspace_id AS head_workspace_id,
        g.profile_id AS head_profile_id
      FROM access_grants g
      JOIN access_grant_revisions r
        ON r.grant_id = g.grant_id AND r.revision = g.current_revision
      WHERE g.grant_id = ? AND g.workspace_id = ? AND g.profile_id = ?
    `).get(grantId, workspaceId, profileId) as AccessGrantRow | undefined
    return row ? projectRow(row) : null
  }

  getCurrentForOwner(grantId: string): AccessGrantRevision | null {
    if (!isUuid(grantId)) return null
    const row = this.db.prepare(`
      SELECT r.*, g.workspace_id AS head_workspace_id,
        g.profile_id AS head_profile_id
      FROM access_grants g
      JOIN access_grant_revisions r
        ON r.grant_id = g.grant_id AND r.revision = g.current_revision
      WHERE g.grant_id = ?
    `).get(grantId) as AccessGrantRow | undefined
    return row ? projectRow(row) : null
  }

  getSourceIdentityForOwner(grantId: string): AccessGrantSourceIdentity | null {
    if (!isUuid(grantId)) return null
    const row = this.db.prepare(`
      SELECT g.grant_id, g.workspace_id, g.profile_id, d.source_id
      FROM access_grants g
      JOIN access_grant_revisions r
        ON r.grant_id = g.grant_id AND r.revision = g.current_revision
      JOIN source_derived_resources d
        ON d.resource_id = r.resource_id
        AND d.workspace_id = r.workspace_id
        AND d.profile_id = r.profile_id
      WHERE g.grant_id = ?
        AND r.resource_kind = 'source_resource'
        AND r.operation IN ('source_content.read', 'source_content.search')
    `).get(grantId) as {
      grant_id: string
      workspace_id: string
      profile_id: string
      source_id: string
    } | undefined
    return row ? {
      grantId: row.grant_id,
      workspaceId: row.workspace_id,
      profileId: row.profile_id,
      sourceId: row.source_id,
    } : null
  }

  listCurrentForOwner(
    page: { readonly limit: number; readonly cursor: string | null },
    now: number = Date.now(),
  ): AccessGrantPage {
    validateTimestamp(now)
    if (!Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > 100 ||
        !(page.cursor === null || isUuid(page.cursor))) {
      throw new AccessGrantStoreError('access_grant_invalid')
    }
    const cursor = page.cursor?.toLowerCase() ?? null
    const rows = this.db.prepare(`
      SELECT r.*, g.workspace_id AS head_workspace_id,
        g.profile_id AS head_profile_id
      FROM access_grants g
      JOIN access_grant_revisions r
        ON r.grant_id = g.grant_id AND r.revision = g.current_revision
      WHERE (@cursor IS NULL OR g.grant_id > @cursor)
      ORDER BY g.grant_id ASC
      LIMIT @rowLimit
    `).all({ cursor, rowLimit: page.limit + 1 }) as AccessGrantRow[]
    const hasMore = rows.length > page.limit
    const pageRows = hasMore ? rows.slice(0, page.limit) : rows
    const items = pageRows.map(row => withLifecycle(projectRow(row), now))
    return {
      items,
      nextCursor: hasMore ? items.at(-1)!.grantId : null,
    }
  }

  listCurrentScoped(
    workspaceId: string,
    profileId: string,
    page: { readonly limit: number; readonly cursor: string | null },
    now: number = Date.now(),
  ): AccessGrantPage {
    validateTimestamp(now)
    if (!Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > 100 ||
        !(page.cursor === null || isUuid(page.cursor))) {
      throw new AccessGrantStoreError('access_grant_invalid')
    }
    if (!isScope(workspaceId) || !isScope(profileId)) {
      return { items: [], nextCursor: null }
    }
    const cursor = page.cursor?.toLowerCase() ?? null
    const rows = this.db.prepare(`
      SELECT r.*, g.workspace_id AS head_workspace_id,
        g.profile_id AS head_profile_id
      FROM access_grants g
      JOIN access_grant_revisions r
        ON r.grant_id = g.grant_id AND r.revision = g.current_revision
      WHERE g.workspace_id = @workspaceId AND g.profile_id = @profileId
        AND (@cursor IS NULL OR g.grant_id > @cursor)
      ORDER BY g.grant_id ASC
      LIMIT @rowLimit
    `).all({
      workspaceId,
      profileId,
      cursor,
      rowLimit: page.limit + 1,
    }) as AccessGrantRow[]
    const hasMore = rows.length > page.limit
    const pageRows = hasMore ? rows.slice(0, page.limit) : rows
    const items = pageRows.map(row => withLifecycle(projectRow(row), now))
    return {
      items,
      nextCursor: hasMore ? items.at(-1)!.grantId : null,
    }
  }

  revoke(input: {
    readonly grantId: string
    readonly workspaceId: string
    readonly profileId: string
    readonly expectedRevision: number
  }, now: number = Date.now()): AccessGrantRevision {
    if (!isUuid(input.grantId) || !isScope(input.workspaceId) ||
        !isScope(input.profileId) || !Number.isSafeInteger(input.expectedRevision) ||
        input.expectedRevision < 1 || !Number.isSafeInteger(now) || now < 0) {
      throw new AccessGrantStoreError('access_grant_invalid')
    }
    return this.db.transaction(
      () => this.revokeInTransaction(input, now),
    ).immediate()
  }

  revokePreparedTextGrantsForFrozenSource(input: {
    readonly workspaceId: string
    readonly profileId: string
    readonly sourceId: string
  }, now: number = Date.now()): readonly SourceDeletionGrantRevocation[] {
    validateTimestamp(now)
    return this.db.transaction(() => {
      const source = this.db.prepare(`
        SELECT 1 FROM runtime_sources
        WHERE source_id = ? AND workspace_id = ? AND profile_id = ?
          AND deletion_state = 'frozen'
      `).get(input.sourceId, input.workspaceId, input.profileId)
      if (!source) throw new Error('Source is not frozen for grant revocation')
      const rows = this.db.prepare(`
        SELECT DISTINCT g.grant_id, g.current_revision
        FROM access_grants g
        JOIN access_grant_revisions r
          ON r.grant_id = g.grant_id AND r.revision = g.current_revision
        JOIN source_derived_resources d
          ON d.resource_id = r.resource_id
          AND d.workspace_id = r.workspace_id
          AND d.profile_id = r.profile_id
        WHERE g.workspace_id = ? AND g.profile_id = ?
          AND d.source_id = ?
          AND r.state = 'active'
          AND r.resource_kind = 'source_resource'
          AND r.operation IN ('source_content.read', 'source_content.search')
        ORDER BY g.grant_id
      `).all(input.workspaceId, input.profileId, input.sourceId) as Array<{
        grant_id: string
        current_revision: number
      }>
      return rows.map((row) => {
        const revoked = this.revokeInTransaction({
          grantId: row.grant_id,
          workspaceId: input.workspaceId,
          profileId: input.profileId,
          expectedRevision: row.current_revision,
        }, now)
        return { grantId: revoked.grantId, revision: revoked.revision }
      })
    }).immediate()
  }

  findLiveCandidates(input: {
    readonly workspaceId: string
    readonly profileId: string
    readonly subjectId: string
    readonly purpose: string
    readonly channel: string | null
    readonly resourceKind: string
    readonly resourceId: string
    readonly operation: string
  }, now: number): readonly AccessGrantRevision[] {
    const rows = this.db.prepare(`
      SELECT r.*, g.workspace_id AS head_workspace_id,
        g.profile_id AS head_profile_id
      FROM access_grants g
      JOIN access_grant_revisions r
        ON r.grant_id = g.grant_id AND r.revision = g.current_revision
      WHERE r.workspace_id = @workspaceId AND r.profile_id = @profileId
        AND g.workspace_id = @workspaceId AND g.profile_id = @profileId
        AND r.subject_id = @subjectId AND r.purpose = @purpose
        AND r.channel IS @channel
        AND r.resource_kind = @resourceKind AND r.resource_id = @resourceId
        AND r.operation = @operation AND r.state = 'active'
        AND r.effective_at <= @now AND r.expires_at > @now
      ORDER BY
        CASE r.field_scope_mode WHEN 'list' THEN 0 ELSE 1 END,
        CASE r.row_scope_mode WHEN 'list' THEN 0 ELSE 1 END,
        CASE r.autonomy_ceiling
          WHEN 'observe' THEN 0 WHEN 'recommend' THEN 1
          WHEN 'draft' THEN 2 ELSE 3 END,
        r.expires_at ASC, r.grant_id ASC
      LIMIT ${this.maxActivePerScope + 1}
    `).all({ ...input, now }) as AccessGrantRow[]
    if (rows.length > this.maxActivePerScope) {
      throw new Error('Access grant candidate bound exceeded')
    }
    return rows.map(projectRow)
  }

  private insertRevision(
    grantId: string,
    revision: number,
    state: AccessGrantRevision['state'],
    input: CreateAccessGrantInput,
    revisionCreatedAt: number,
    revokedAt: number | null,
  ): void {
    this.db.prepare(`
      INSERT INTO access_grant_revisions (
        grant_id, revision, workspace_id, profile_id, state, subject_id,
        purpose, channel, resource_kind, resource_id, operation,
        field_scope_mode, field_ids_json, row_scope_mode, row_ids_json,
        consent_state, consent_evidence_id, autonomy_ceiling, effective_at,
        expires_at, issued_by, revision_created_at, revoked_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `).run(
      grantId,
      revision,
      input.workspaceId,
      input.profileId,
      state,
      input.subjectId,
      input.purpose,
      input.channel,
      input.resourceKind,
      input.resourceId,
      input.operation,
      input.fieldScope.mode,
      JSON.stringify(input.fieldScope.mode === 'list' ? input.fieldScope.ids : []),
      input.rowScope.mode,
      JSON.stringify(input.rowScope.mode === 'list' ? input.rowScope.ids : []),
      input.consent.state,
      input.consent.state === 'recorded' ? input.consent.evidenceId : null,
      input.autonomyCeiling,
      input.effectiveAt,
      input.expiresAt,
      input.issuedBy,
      revisionCreatedAt,
      revokedAt,
    )
  }

  private revokeInTransaction(input: {
    readonly grantId: string
    readonly workspaceId: string
    readonly profileId: string
    readonly expectedRevision: number
  }, now: number): AccessGrantRevision {
    const current = this.getCurrentScoped(
      input.grantId, input.workspaceId, input.profileId,
    )
    if (!current) throw new AccessGrantStoreError('access_grant_not_found')
    if (current.revision !== input.expectedRevision) {
      throw new AccessGrantStoreError('access_grant_revision_conflict')
    }
    if (current.state !== 'active') {
      throw new AccessGrantStoreError('access_grant_not_active')
    }
    if (now < current.revisionCreatedAt) {
      throw new AccessGrantStoreError('access_grant_invalid')
    }
    const revision = current.revision + 1
    this.insertRevision(input.grantId, revision, 'revoked', current, now, now)
    const advanced = this.db.prepare(`
      UPDATE access_grants SET current_revision = ?
      WHERE grant_id = ? AND workspace_id = ? AND profile_id = ?
        AND current_revision = ?
    `).run(
      revision,
      input.grantId,
      input.workspaceId,
      input.profileId,
      input.expectedRevision,
    )
    if (advanced.changes !== 1) {
      throw new AccessGrantStoreError('access_grant_revision_conflict')
    }
    return this.getCurrentScoped(
      input.grantId, input.workspaceId, input.profileId,
    )!
  }
}

export function validateAccessContext(input: {
  readonly workspaceId: string
  readonly profileId: string
  readonly subjectId: string
  readonly purpose: string
  readonly channel: string | null
  readonly resourceKind: string
  readonly resourceId: string
  readonly operation: string
  readonly fieldScope: AccessScope
  readonly rowScope: AccessScope
  readonly consent: AccessConsent
  readonly autonomy: AccessAutonomy
  readonly permissionMode: 'auto' | 'ask' | 'deny' | 'allowlist'
}): boolean {
  return isScope(input.workspaceId) && isScope(input.profileId) &&
    isScope(input.subjectId) && isPurpose(input.purpose) &&
    (input.channel === null || isScope(input.channel)) &&
    isKind(input.resourceKind) && SAFE_RESOURCE.test(input.resourceId) &&
    input.resourceId.length <= 200 && SAFE_OPERATION.test(input.operation) &&
    input.operation.length <= 128 && validRequestScope(input.fieldScope) &&
    validRequestScope(input.rowScope) && validConsent(input.consent) &&
    ['observe', 'recommend', 'draft', 'act'].includes(input.autonomy) &&
    ['auto', 'ask', 'deny', 'allowlist'].includes(input.permissionMode)
}

function normalizeGrantInput(input: CreateAccessGrantInput): CreateAccessGrantInput {
  if (!isScope(input.workspaceId) || !isScope(input.profileId) ||
      !isScope(input.subjectId) || !isPurpose(input.purpose) ||
      !(input.channel === null || isScope(input.channel)) ||
      !isKind(input.resourceKind) || !SAFE_RESOURCE.test(input.resourceId) ||
      input.resourceId.length > 200 || !SAFE_OPERATION.test(input.operation) ||
      input.operation.length > 128 || !validConsent(input.consent) ||
      !['observe', 'recommend', 'draft', 'act'].includes(input.autonomyCeiling) ||
      !Number.isSafeInteger(input.effectiveAt) || !Number.isSafeInteger(input.expiresAt) ||
      input.effectiveAt < 0 || input.expiresAt <= input.effectiveAt ||
      !isScope(input.issuedBy)) {
    throw new AccessGrantStoreError('access_grant_invalid')
  }
  return {
    ...input,
    fieldScope: normalizeScope(input.fieldScope),
    rowScope: normalizeScope(input.rowScope),
  }
}

function normalizeImmediateGrantInput(
  input: CreateImmediateAccessGrantInput,
  now: number,
): CreateAccessGrantInput {
  validateTimestamp(now)
  if (!Number.isSafeInteger(input.ttlSeconds) ||
      input.ttlSeconds < ACCESS_GRANT_MIN_TTL_SECONDS ||
      input.ttlSeconds > ACCESS_GRANT_MAX_TTL_SECONDS) {
    throw new AccessGrantStoreError('access_grant_invalid')
  }
  const expiresAt = now + input.ttlSeconds * 1_000
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) {
    throw new AccessGrantStoreError('access_grant_invalid')
  }
  return normalizeGrantInput({
    workspaceId: input.workspaceId,
    profileId: input.profileId,
    subjectId: input.subjectId,
    purpose: input.purpose,
    channel: input.channel,
    resourceKind: input.resourceKind,
    resourceId: input.resourceId,
    operation: input.operation,
    fieldScope: input.fieldScope,
    rowScope: input.rowScope,
    consent: input.consent,
    autonomyCeiling: input.autonomyCeiling,
    effectiveAt: now,
    expiresAt,
    issuedBy: input.issuedBy,
  })
}

function validateTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AccessGrantStoreError('access_grant_invalid')
  }
}

function normalizeScope(scope: AccessScope): AccessScope {
  if (scope.mode === 'all') return { mode: 'all' }
  if (!validIds(scope.ids, false)) {
    throw new AccessGrantStoreError('access_grant_invalid')
  }
  return { mode: 'list', ids: [...new Set(scope.ids)].sort() }
}

function validIds(ids: readonly string[], allowEmpty: boolean): boolean {
  return Array.isArray(ids) && ids.length <= MAX_SCOPE_IDS &&
    (allowEmpty || ids.length > 0) && ids.every((id) => isScope(id))
}

function validRequestScope(scope: AccessScope): boolean {
  return scope !== null && typeof scope === 'object' &&
    (scope.mode === 'all' ||
      (scope.mode === 'list' && validIds(scope.ids, false)))
}

function validConsent(consent: AccessConsent): boolean {
  return consent !== null && typeof consent === 'object' &&
    (consent.state === 'not_required' ||
    (consent.state === 'recorded' && isScope(consent.evidenceId))
    )
}

function isScope(value: string): boolean {
  return typeof value === 'string' && SAFE_SCOPE.test(value)
}

function isPurpose(value: string): boolean {
  return isScope(value) && value.length <= 64
}

function isKind(value: string): boolean {
  return isScope(value) && value.length <= 64
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(value)
}

function projectRow(row: AccessGrantRow): AccessGrantRevision {
  if (!isUuid(row.grant_id) || !Number.isSafeInteger(row.revision) || row.revision < 1 ||
      row.workspace_id !== row.head_workspace_id || row.profile_id !== row.head_profile_id ||
      !['active', 'revoked'].includes(row.state) ||
      !['observe', 'recommend', 'draft', 'act'].includes(row.autonomy_ceiling) ||
      !Number.isSafeInteger(row.effective_at) || !Number.isSafeInteger(row.expires_at) ||
      row.effective_at < 0 || row.expires_at <= row.effective_at ||
      !Number.isSafeInteger(row.revision_created_at) || row.revision_created_at < 0 ||
      !(row.revoked_at === null || (Number.isSafeInteger(row.revoked_at) &&
        row.revoked_at >= row.revision_created_at)) ||
      (row.state === 'active') !== (row.revoked_at === null)) {
    throw new Error('Persisted access grant revision is invalid')
  }
  const fieldScope = projectScope(row.field_scope_mode, row.field_ids_json)
  const rowScope = projectScope(row.row_scope_mode, row.row_ids_json)
  const consent: AccessConsent = row.consent_state === 'recorded' &&
      row.consent_evidence_id !== null && isScope(row.consent_evidence_id)
    ? { state: 'recorded', evidenceId: row.consent_evidence_id }
    : row.consent_state === 'not_required' && row.consent_evidence_id === null
      ? { state: 'not_required' }
      : (() => { throw new Error('Persisted access grant consent is invalid') })()
  const projected = {
    grantId: row.grant_id,
    revision: row.revision,
    state: row.state as AccessGrantRevision['state'],
    workspaceId: row.workspace_id,
    profileId: row.profile_id,
    subjectId: row.subject_id,
    purpose: row.purpose,
    channel: row.channel,
    resourceKind: row.resource_kind,
    resourceId: row.resource_id,
    operation: row.operation,
    fieldScope,
    rowScope,
    consent,
    autonomyCeiling: row.autonomy_ceiling as AccessAutonomy,
    effectiveAt: row.effective_at,
    expiresAt: row.expires_at,
    issuedBy: row.issued_by,
    revisionCreatedAt: row.revision_created_at,
    revokedAt: row.revoked_at,
  }
  try {
    normalizeGrantInput(projected)
  } catch {
    throw new Error('Persisted access grant revision is invalid')
  }
  return projected
}

function withLifecycle(grant: AccessGrantRevision, now: number): CurrentAccessGrant {
  const lifecycle: AccessGrantLifecycle = grant.state === 'revoked'
    ? 'revoked'
    : now < grant.effectiveAt
      ? 'scheduled'
      : now >= grant.expiresAt
        ? 'expired'
        : 'effective'
  return { ...grant, lifecycle }
}

function projectScope(mode: string, json: string): AccessScope {
  if (mode === 'all' && json === '[]') return { mode: 'all' }
  if (mode !== 'list') throw new Error('Persisted access grant scope is invalid')
  const parsed = JSON.parse(json) as unknown
  if (!Array.isArray(parsed) || !validIds(parsed as string[], false)) {
    throw new Error('Persisted access grant scope is invalid')
  }
  const ids = parsed as string[]
  if (JSON.stringify([...new Set(ids)].sort()) !== json) {
    throw new Error('Persisted access grant scope is not canonical')
  }
  return { mode: 'list', ids }
}
