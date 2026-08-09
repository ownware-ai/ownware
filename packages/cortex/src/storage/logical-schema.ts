import { createHash } from 'node:crypto'
import type { LogicalValueKind, LogicalValueProjection } from './value-codec.js'

export interface PhysicalColumnDescriptor {
  readonly table: string
  readonly name: string
  readonly declaredType: string
  readonly notNull: boolean
  readonly defaultValue: unknown
  readonly pkPosition: number
  readonly hidden: number
}

export interface LogicalColumnDescriptor extends PhysicalColumnDescriptor {
  readonly key: string
  readonly kind: LogicalValueKind
  readonly nullable: boolean
  readonly postgresqlType: 'TEXT' | 'BIGINT' | 'BOOLEAN' | 'DOUBLE PRECISION' | 'BYTEA'
  readonly postgresqlProjection: LogicalValueProjection
}

export class LogicalSchemaError extends Error {
  override readonly name = 'LogicalSchemaError'

  constructor(readonly code: string) {
    super(`Logical storage schema is not certified (${code}).`)
  }
}

export const SQLITE_V85_COLUMN_COUNT = 749
export const SQLITE_V85_COLUMN_SET_HASH =
  'sha256:3d5c7666cddab1ca3224a673edf7be1bec9a20a5b49782dbc8df691383afbb47'

function keys(value: string): ReadonlySet<string> {
  return new Set(value.trim().split(/\s+/).filter(Boolean))
}

const BOOLEAN_COLUMNS = keys(`
  memories.pinned
  provider_usage_facts.success
  schedule_runs.was_catch_up
  schedules.skip_weekends
  schedules.skip_holidays
  schedules.enabled
  schedules.quiet_on_empty
  threads.pinned
  usage_records.success
  workspaces.pinned
`)

const EPOCH_MILLISECOND_COLUMNS = keys(`
  access_grant_revisions.effective_at
  access_grant_revisions.expires_at
  access_grant_revisions.revision_created_at
  access_grant_revisions.revoked_at
  access_grants.created_at
  agent_events.created_at
  channel_job_work_lines.created_at
  channel_jobs.lease_expires_at
  channel_jobs.retry_after
  channel_jobs.cancel_requested_at
  channel_jobs.created_at
  channel_jobs.updated_at
  channel_jobs.terminal_at
  channel_receipts.created_at
  codex_thread_references.updated_at
  connector_connections.initiated_at
  connector_connections.completed_at
  connector_connections.last_polled_at
  connector_connections.expires_at
  connector_connections.last_verified_at
  delegated_principals.issued_at
  delegated_principals.expires_at
  delegated_principals.revoked_at
  gateway_runs.accepted_at
  gateway_runs.started_at
  gateway_runs.updated_at
  gateway_runs.terminal_at
  gateway_runs.cancel_requested_at
  oauth_refresh_leases.expires_at
  oauth_refresh_leases.updated_at
  profile_candidate_activation_history.activated_at
  profile_candidate_activations.updated_at
  profile_candidate_activations.health_observed_at
  profile_candidate_deletions.started_at
  profile_candidate_deletions.updated_at
  profile_candidate_deletions.deleted_at
  profile_candidates.created_at
  profile_candidates.updated_at
  run_idempotency.created_at
  run_idempotency.updated_at
  run_idempotency.expires_at
  run_permission_requests.requested_at
  run_permission_requests.decided_at
  runtime_sources.created_at
  runtime_sources.updated_at
  schedule_approvals.created_at
  schedule_approvals.decided_at
  schedule_runs.scheduled_for
  schedule_runs.started_at
  schedule_runs.finished_at
  schedule_runs.created_at
  schedules.next_run_at
  schedules.last_run_at
  schedules.created_at
  schedules.updated_at
  source_data_view_jobs.lease_expires_at
  source_data_view_jobs.retry_after
  source_data_view_jobs.cancel_requested_at
  source_data_view_jobs.created_at
  source_data_view_jobs.updated_at
  source_data_view_jobs.terminal_at
  source_data_views.created_at
  source_data_views.stale_at
  source_deletion_inventory.created_at
  source_deletion_inventory.updated_at
  source_deletion_inventory.terminal_at
  source_deletion_plans.inventory_completed_at
  source_deletion_plans.created_at
  source_deletion_plans.updated_at
  source_deletion_tombstones.created_at
  source_deletion_tombstones.terminal_at
  source_derived_resources.created_at
  source_derived_resources.stale_at
  source_jobs.lease_expires_at
  source_jobs.retry_after
  source_jobs.cancel_requested_at
  source_jobs.created_at
  source_jobs.updated_at
  source_jobs.terminal_at
  source_upload_chunks.accepted_at
  source_upload_sessions.expires_at
  source_upload_sessions.created_at
  source_upload_sessions.updated_at
  source_upload_sessions.byte_reservation_released_at
  source_versions.created_at
  thread_principal_bindings.created_at
`)

const ISO_INSTANT_COLUMNS = keys(`
  _migrations.applied_at
  app_state.updated_at
  audit_log.created_at
  codex_thread_references.bound_at
  codex_thread_references.active_started_at
  codex_thread_references.last_turn_completed_at
  credential_audit_log.created_at
  credentials.expires_at
  credentials.last_used_at
  credentials.created_at
  credentials.updated_at
  local_profile.created_at
  local_profile.updated_at
  mcp_servers.created_at
  mcp_servers.updated_at
  memories.last_referenced_at
  memories.created_at
  memories.updated_at
  memory_proposals.created_at
  memory_proposals.resolved_at
  messages.created_at
  plugin_grants.updated_at
  plugin_migration_receipts.applied_at
  plugin_packages.created_at
  plugin_packages.updated_at
  plugin_versions.installed_at
  profile_mcp_servers.added_at
  profile_metadata.updated_at
  profile_metadata.last_used_at
  provider_pricebook_snapshots.recorded_at
  provider_usage_cost_observations.observed_at
  provider_usage_cost_observations.reconciled_at
  provider_usage_cost_observations.recorded_at
  provider_usage_facts.occurred_at
  provider_usage_facts.recorded_at
  tasks.created_at
  tasks.updated_at
  team_leases.last_activity_at
  team_runs.created_at
  team_runs.updated_at
  team_tasks.created_at
  team_tasks.updated_at
  teams.created_at
  teams.updated_at
  threads.created_at
  threads.updated_at
  usage_records.created_at
  user_identity.created_at
  user_identity.updated_at
  user_settings.updated_at
  workspace_profiles.last_used_at
  workspaces.last_opened_at
  workspaces.created_at
  workspaces.updated_at
`)

const JSON_VALUE_COLUMNS = keys(`
  access_grant_revisions.field_ids_json
  access_grant_revisions.row_ids_json
  agent_events.payload
  channel_jobs.params_json
  channel_jobs.state_json
  channel_jobs.gate_json
  channel_jobs.gate_response_json
  channel_receipts.body_json
  connector_connections.metadata_json
  credential_audit_log.detail
  credentials.granted_scopes
  credentials.spend_cap
  credentials.tags
  delegated_principals.operations_json
  mcp_servers.args
  mcp_servers.headers
  mcp_servers.tools_json
  mcp_servers.env
  messages.tools
  messages.sub_agents
  messages.permissions
  messages.attachments
  messages.parts
  messages.credentials
  plugin_versions.manifest_json
  provider_pricebook_snapshots.payload_json
  provider_usage_facts.tokens_json
  provider_usage_facts.units_json
  provider_usage_facts.provider_facts_json
  run_idempotency.result_json
  schedule_approvals.tool_input
  schedule_approvals.result
  schedules.cadence_expr
  schedules.tool_envelope
  source_data_views.fields_json
  team_members.tool_restricts
  team_runs.receipt
  team_tasks.deliverables
  team_tasks.depends_on
  team_tasks.resource_hints
  workspaces.active_products
`)

// Empty today. This category exists so an exact serialized JSON/signature input
// cannot be accidentally reclassified as semantic JSON in a future migration.
const JSON_BYTES_COLUMNS: ReadonlySet<string> = new Set()

const POSTGRESQL_TEXT_KEY_COLUMNS = keys(`
  run_idempotency.principal_key
  source_upload_sessions.principal_key
`)

const SPECIAL_KINDS: ReadonlyArray<readonly [ReadonlySet<string>, LogicalValueKind, string]> = [
  [BOOLEAN_COLUMNS, 'boolean', 'INTEGER'],
  [EPOCH_MILLISECOND_COLUMNS, 'epoch-milliseconds', 'INTEGER'],
  [ISO_INSTANT_COLUMNS, 'iso-instant', 'TEXT'],
  [JSON_VALUE_COLUMNS, 'json-value', 'TEXT'],
  [JSON_BYTES_COLUMNS, 'json-bytes', 'TEXT'],
]

function fail(code: string): never {
  throw new LogicalSchemaError(code)
}

function keyOf(column: Pick<PhysicalColumnDescriptor, 'table' | 'name'>): string {
  return `${column.table}.${column.name}`
}

function normalizedColumnSet(columns: readonly PhysicalColumnDescriptor[]): readonly PhysicalColumnDescriptor[] {
  return [...columns].sort((left, right) => {
    const leftKey = keyOf(left)
    const rightKey = keyOf(right)
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
  })
}

export function physicalColumnSetHash(columns: readonly PhysicalColumnDescriptor[]): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(normalizedColumnSet(columns)))
    .digest('hex')}`
}

function defaultKind(declaredType: string): LogicalValueKind {
  switch (declaredType) {
    case 'INTEGER': return 'safe-integer'
    case 'REAL': return 'finite-real'
    case 'TEXT': return 'text'
    default: return fail('declared_type_unknown')
  }
}

export function postgresqlTypeForLogicalKind(
  kind: LogicalValueKind,
): LogicalColumnDescriptor['postgresqlType'] {
  switch (kind) {
    case 'text':
    case 'iso-instant':
    case 'json-value':
    case 'json-bytes':
      // JSON remains TEXT initially: existing code owns parsing and exact bytes
      // survive transfer. JSONB normalization is not silently introduced.
      return 'TEXT'
    case 'safe-integer':
    case 'epoch-milliseconds':
      return 'BIGINT'
    case 'boolean': return 'BOOLEAN'
    case 'finite-real': return 'DOUBLE PRECISION'
    case 'binary': return 'BYTEA'
  }
}

export function logicalKindForColumn(
  key: string,
  fallback: LogicalValueKind,
): LogicalValueKind {
  for (const [set, kind] of SPECIAL_KINDS) {
    if (set.has(key)) return kind
  }
  return fallback
}

export function postgresqlProjectionForColumn(key: string): LogicalValueProjection {
  return POSTGRESQL_TEXT_KEY_COLUMNS.has(key)
    ? 'postgresql-text-key-v1'
    : 'identity'
}

export function classifyLogicalColumns(
  columns: readonly PhysicalColumnDescriptor[],
): readonly LogicalColumnDescriptor[] {
  if (columns.length !== SQLITE_V85_COLUMN_COUNT) return fail('column_count_mismatch')
  if (physicalColumnSetHash(columns) !== SQLITE_V85_COLUMN_SET_HASH) {
    return fail('column_set_mismatch')
  }

  const byKey = new Map<string, PhysicalColumnDescriptor>()
  for (const column of columns) {
    const key = keyOf(column)
    if (byKey.has(key)) return fail('column_duplicate')
    byKey.set(key, column)
  }

  const kinds = new Map<string, LogicalValueKind>()
  for (const [set, kind, expectedType] of SPECIAL_KINDS) {
    for (const key of set) {
      if (kinds.has(key)) return fail('classification_overlap')
      const column = byKey.get(key)
      if (column === undefined) return fail('classified_column_missing')
      if (column.declaredType !== expectedType) return fail('classified_type_mismatch')
      kinds.set(key, kind)
    }
  }

  return normalizedColumnSet(columns).map((column) => {
    const key = keyOf(column)
    const kind = kinds.get(key) ?? defaultKind(column.declaredType)
    return {
      ...column,
      key,
      kind,
      // SQLite permits NULL in several non-INTEGER PRIMARY KEY declarations.
      // The logical/PostgreSQL primary-key contract does not.
      nullable: column.pkPosition === 0 && !column.notNull,
      postgresqlType: postgresqlTypeForLogicalKind(kind),
      postgresqlProjection: postgresqlProjectionForColumn(key),
    }
  })
}

/** Exact logical/projection identity hashed into canonical transfer receipts. */
export function logicalColumnSetHash(
  columns: readonly LogicalColumnDescriptor[],
): string {
  const normalized = [...columns]
    .sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0)
    .map((column) => ({
      key: column.key,
      kind: column.kind,
      nullable: column.nullable,
      pkPosition: column.pkPosition,
      postgresqlType: column.postgresqlType,
      postgresqlProjection: column.postgresqlProjection,
    }))
  return `sha256:${createHash('sha256').update(JSON.stringify(normalized)).digest('hex')}`
}
