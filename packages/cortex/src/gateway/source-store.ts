import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { SourceQuotaPolicy } from './source-quota-policy.js'

export const SOURCE_KINDS = [
  'file', 'text', 'visual', 'structured_export',
  'cloud_document', 'connected_snapshot', 'supported_other',
] as const
export type SourceKind = typeof SOURCE_KINDS[number]

export const SOURCE_CLASSIFICATIONS = [
  'public', 'internal', 'confidential', 'restricted',
] as const
export type SourceClassification = typeof SOURCE_CLASSIFICATIONS[number]

export const SOURCE_AUTHORITIES = [
  'source_of_record', 'supporting_reference', 'example', 'excluded',
] as const
export type SourceAuthority = typeof SOURCE_AUTHORITIES[number]

export interface SourceRegistrationInput {
  readonly workspaceId: string
  readonly profileId: string
  readonly kind: SourceKind
  readonly label: string
  readonly classification: SourceClassification
  readonly authority: SourceAuthority
  readonly audiencePolicyRef: string
  readonly sensitivityPolicyRef: string
  readonly purposePolicyRef: string
  readonly retentionPolicyRef: string
  readonly freshnessPolicyRef: string
}

export interface SourceManifest {
  readonly sourceId: string
  readonly kind: SourceKind
  readonly label: string
  readonly classification: SourceClassification
  readonly authority: SourceAuthority
  readonly audiencePolicyRef: string
  readonly sensitivityPolicyRef: string
  readonly purposePolicyRef: string
  readonly retentionPolicyRef: string
  readonly freshnessPolicyRef: string
  readonly revision: number
  readonly currentVersionId: string | null
  readonly health: {
    readonly registration: 'pending' | 'registered' | 'rejected'
    readonly inspection: 'not_started' | 'queued' | 'inspecting' | 'complete' | 'partial' | 'failed'
    readonly preparation: 'not_requested' | 'queued' | 'preparing' | 'ready' | 'partial' | 'failed'
    readonly access: 'available' | 'denied' | 'expired' | 'disconnected' | 'wrong_identity'
    readonly freshness: 'fresh' | 'aging' | 'stale' | 'unknown'
    readonly conflict: 'none' | 'suspected' | 'confirmed' | 'resolved'
    readonly deletion: 'active' | 'frozen' | 'deleting' | 'partially_deleted' | 'deleted'
  }
  readonly createdAt: number
  readonly updatedAt: number
}

export interface PendingSourceManifest extends Omit<SourceManifest, 'health'> {
  readonly health: {
    readonly registration: 'pending'
    readonly inspection: 'not_started'
    readonly preparation: 'not_requested'
    readonly access: 'available'
    readonly freshness: 'unknown'
    readonly conflict: 'none'
    readonly deletion: 'active'
  }
}

interface SourceRow {
  readonly source_id: string
  readonly kind: SourceKind
  readonly label: string
  readonly classification: SourceClassification
  readonly authority: SourceAuthority
  readonly audience_policy_ref: string
  readonly sensitivity_policy_ref: string
  readonly purpose_policy_ref: string
  readonly retention_policy_ref: string
  readonly freshness_policy_ref: string
  readonly revision: number
  readonly current_version_id: string | null
  readonly registration_state: SourceManifest['health']['registration']
  readonly inspection_state: SourceManifest['health']['inspection']
  readonly preparation_state: SourceManifest['health']['preparation']
  readonly access_state: SourceManifest['health']['access']
  readonly freshness_state: SourceManifest['health']['freshness']
  readonly conflict_state: SourceManifest['health']['conflict']
  readonly deletion_state: SourceManifest['health']['deletion']
  readonly created_at: number
  readonly updated_at: number
}

export class SourceStore {
  constructor(
    private readonly db: Database.Database,
    private readonly quota: SourceQuotaPolicy = new SourceQuotaPolicy(db),
  ) {}

  create(input: SourceRegistrationInput, now: number = Date.now()): PendingSourceManifest {
    return this.db.transaction((): PendingSourceManifest => {
      this.quota.assertCanGrow(input, { sourceRegistrations: 1 })
      const sourceId = randomUUID()
      this.db.prepare(`
      INSERT INTO runtime_sources (
        source_id, workspace_id, profile_id, kind, label, classification,
        authority, audience_policy_ref, sensitivity_policy_ref,
        purpose_policy_ref, retention_policy_ref, freshness_policy_ref,
        revision, current_version_id, registration_state, inspection_state,
        preparation_state, access_state, freshness_state, conflict_state,
        deletion_state, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL,
        'pending', 'not_started', 'not_requested', 'available', 'unknown',
        'none', 'active', ?, ?
      )
      `).run(
        sourceId, input.workspaceId, input.profileId, input.kind, input.label,
        input.classification, input.authority, input.audiencePolicyRef,
        input.sensitivityPolicyRef, input.purposePolicyRef,
        input.retentionPolicyRef, input.freshnessPolicyRef, now, now,
      )
      const row = this.getRow(sourceId)!
      if (row.registration_state !== 'pending' || row.inspection_state !== 'not_started' ||
          row.preparation_state !== 'not_requested' || row.access_state !== 'available' ||
          row.freshness_state !== 'unknown' || row.conflict_state !== 'none' ||
          row.deletion_state !== 'active') {
        throw new Error('New source did not retain its initial lifecycle state')
      }
      return {
        ...this.project(row),
        health: {
          registration: 'pending',
          inspection: 'not_started',
          preparation: 'not_requested',
          access: 'available',
          freshness: 'unknown',
          conflict: 'none',
          deletion: 'active',
        },
      }
    }).immediate()
  }

  getScoped(sourceId: string, workspaceId: string, profileId: string): SourceManifest | null {
    const row = this.db.prepare(`
      SELECT * FROM runtime_sources
      WHERE source_id = ? AND workspace_id = ? AND profile_id = ?
    `).get(sourceId, workspaceId, profileId) as SourceRow | undefined
    return row ? this.project(row) : null
  }

  listScoped(
    workspaceId: string,
    profileId: string,
    options: { readonly limit: number; readonly cursor?: string },
  ): { readonly items: readonly SourceManifest[]; readonly nextCursor: string | null } {
    const rows = this.db.prepare(`
      SELECT * FROM runtime_sources
      WHERE workspace_id = ? AND profile_id = ?
        AND (? IS NULL OR source_id > ?)
      ORDER BY source_id ASC
      LIMIT ?
    `).all(
      workspaceId,
      profileId,
      options.cursor ?? null,
      options.cursor ?? null,
      options.limit + 1,
    ) as SourceRow[]
    const hasMore = rows.length > options.limit
    const page = hasMore ? rows.slice(0, options.limit) : rows
    return {
      items: page.map((row) => this.project(row)),
      nextCursor: hasMore ? page.at(-1)!.source_id : null,
    }
  }

  private getRow(sourceId: string): SourceRow | null {
    return (this.db.prepare(
      'SELECT * FROM runtime_sources WHERE source_id = ?',
    ).get(sourceId) as SourceRow | undefined) ?? null
  }

  private project(row: SourceRow): SourceManifest {
    return {
      sourceId: row.source_id,
      kind: row.kind,
      label: row.label,
      classification: row.classification,
      authority: row.authority,
      audiencePolicyRef: row.audience_policy_ref,
      sensitivityPolicyRef: row.sensitivity_policy_ref,
      purposePolicyRef: row.purpose_policy_ref,
      retentionPolicyRef: row.retention_policy_ref,
      freshnessPolicyRef: row.freshness_policy_ref,
      revision: row.revision,
      currentVersionId: row.current_version_id,
      health: {
        registration: row.registration_state,
        inspection: row.inspection_state,
        preparation: row.preparation_state,
        access: row.access_state,
        freshness: row.freshness_state,
        conflict: row.conflict_state,
        deletion: row.deletion_state,
      },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}
