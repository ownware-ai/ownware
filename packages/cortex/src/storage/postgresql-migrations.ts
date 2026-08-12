import { createHash } from 'node:crypto'
import {
  STORAGE_ADAPTER_BASELINE_VERSION,
  STORAGE_LOGICAL_MIGRATIONS,
  assertStorageMigrationAlignment,
  type StorageMigrationIdentity,
} from './migration-manifest.js'
import {
  POSTGRESQL_BASELINE_DDL_HASH,
  POSTGRESQL_BASELINE_MANIFEST,
  POSTGRESQL_BASELINE_NAME,
  POSTGRESQL_BASELINE_SQL,
  POSTGRESQL_BASELINE_SUMMARY,
  POSTGRESQL_BASELINE_VERSION,
} from './postgresql-baseline.js'
import { PostgreSqlStorageError } from './contracts.js'
import type { PostgreSqlClient, PostgreSqlPoolClient } from './postgresql-driver.js'
import {
  postgreSqlBaselineMatches,
  postgreSqlSchemaMatches,
  type PostgreSqlSchemaExpectation,
} from './postgresql-schema.js'

type QueryClient = Pick<PostgreSqlClient | PostgreSqlPoolClient, 'query'>

export interface PostgreSqlMigration {
  readonly version: number
  readonly name: string
  readonly sql: string
  /** Authoritative effect check run immediately after this migration's SQL. */
  readonly verifyApplied: (client: QueryClient) => Promise<boolean>
}

export interface PostgreSqlMigrationManifest {
  readonly migrations: readonly PostgreSqlMigration[]
  readonly logicalMigrations: readonly StorageMigrationIdentity[]
  /** Exact current-schema certification, including every applied migration. */
  readonly verifyCurrentSchema: (client: QueryClient) => Promise<boolean>
}

export interface PostgreSqlMigrationHistoryRow {
  readonly version: string
  readonly name: string
  readonly fingerprint: string | null
}

const BASELINE_MIGRATION: PostgreSqlMigration = Object.freeze({
  version: POSTGRESQL_BASELINE_VERSION,
  name: POSTGRESQL_BASELINE_NAME,
  sql: POSTGRESQL_BASELINE_SQL,
  verifyApplied: postgreSqlBaselineMatches,
})

const MESSAGE_SEQUENCE_SQL = `
ALTER TABLE ownware.messages ADD COLUMN message_seq BIGINT;

WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY thread_id
      ORDER BY created_at ASC, id ASC
    ) AS message_seq
  FROM ownware.messages
)
UPDATE ownware.messages AS message
SET message_seq = ranked.message_seq
FROM ranked
WHERE ranked.id = message.id;

ALTER TABLE ownware.messages ALTER COLUMN message_seq SET NOT NULL;
ALTER TABLE ownware.messages ADD CONSTRAINT ck_messages_message_seq_positive
  CHECK (message_seq BETWEEN 1 AND 9007199254740991);
CREATE UNIQUE INDEX idx_messages_thread_sequence
  ON ownware.messages(thread_id, message_seq ASC);
`

const PROVIDER_USAGE_EVIDENCE_SQL = `
CREATE TABLE ownware.provider_pricebook_snapshots (
  entry_id TEXT NOT NULL,
  version TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (payload_json IS JSON),
  payload_sha256 TEXT NOT NULL CHECK (
    payload_sha256 ~ '^sha256:[0-9a-f]{64}$'
  ),
  recorded_at TEXT NOT NULL CHECK (ownware._is_iso_instant(recorded_at)),
  PRIMARY KEY (entry_id, version)
);

CREATE TABLE ownware.provider_usage_facts (
  id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL CHECK (ownware._is_iso_instant(occurred_at)),
  thread_id TEXT,
  profile_id TEXT,
  provider_family_id TEXT NOT NULL,
  provider_route_id TEXT NOT NULL,
  model_route_id TEXT NOT NULL,
  connection_id TEXT,
  wire_model_id TEXT NOT NULL,
  service_tier TEXT,
  context_tier TEXT,
  region TEXT,
  billing_kind TEXT NOT NULL CHECK (billing_kind IN (
    'metered', 'provider_reported', 'subscription', 'local', 'unknown'
  )),
  tokens_json TEXT NOT NULL CHECK (tokens_json IS JSON),
  units_json TEXT NOT NULL CHECK (units_json IS JSON),
  provider_facts_json TEXT NOT NULL CHECK (provider_facts_json IS JSON),
  duration_ms DOUBLE PRECISION CHECK (
    duration_ms IS NULL OR (
      duration_ms >= 0 AND duration_ms NOT IN (
        'Infinity'::DOUBLE PRECISION,
        '-Infinity'::DOUBLE PRECISION,
        'NaN'::DOUBLE PRECISION
      )
    )
  ),
  success BOOLEAN NOT NULL,
  recorded_at TEXT NOT NULL CHECK (ownware._is_iso_instant(recorded_at))
);

CREATE INDEX idx_provider_usage_facts_occurred
  ON ownware.provider_usage_facts(occurred_at DESC, id DESC);
CREATE INDEX idx_provider_usage_facts_profile
  ON ownware.provider_usage_facts(profile_id ASC, occurred_at DESC, id DESC);
CREATE INDEX idx_provider_usage_facts_thread
  ON ownware.provider_usage_facts(thread_id ASC, occurred_at ASC, id ASC);
CREATE INDEX idx_provider_usage_facts_route_model
  ON ownware.provider_usage_facts(
    provider_route_id ASC, model_route_id ASC, occurred_at DESC, id DESC
  );

CREATE TABLE ownware.provider_usage_cost_observations (
  id TEXT PRIMARY KEY,
  usage_id TEXT NOT NULL REFERENCES ownware.provider_usage_facts(id),
  observation_seq BIGINT NOT NULL CHECK (
    observation_seq BETWEEN 1 AND 9007199254740991
  ),
  classification TEXT NOT NULL CHECK (classification IN (
    'estimated', 'provider_reported', 'reconciled',
    'subscription', 'local', 'unknown'
  )),
  amount_usd DOUBLE PRECISION,
  currency TEXT NOT NULL CHECK (currency = 'USD'),
  pricebook_entry_id TEXT,
  pricebook_version TEXT,
  observed_at TEXT NOT NULL CHECK (ownware._is_iso_instant(observed_at)),
  reconciled_at TEXT CHECK (
    reconciled_at IS NULL OR ownware._is_iso_instant(reconciled_at)
  ),
  recorded_at TEXT NOT NULL CHECK (ownware._is_iso_instant(recorded_at)),
  CONSTRAINT uq_provider_usage_cost_sequence UNIQUE (usage_id, observation_seq),
  CONSTRAINT ck_provider_usage_cost_amount CHECK (
    (classification IN ('unknown', 'subscription', 'local') AND amount_usd IS NULL)
    OR
    (classification IN ('estimated', 'provider_reported', 'reconciled')
      AND amount_usd IS NOT NULL AND amount_usd >= 0
      AND amount_usd NOT IN (
        'Infinity'::DOUBLE PRECISION,
        '-Infinity'::DOUBLE PRECISION,
        'NaN'::DOUBLE PRECISION
      ))
  ),
  CONSTRAINT ck_provider_usage_cost_estimate_snapshot CHECK (
    (classification = 'estimated'
      AND pricebook_entry_id IS NOT NULL AND pricebook_version IS NOT NULL)
    OR classification <> 'estimated'
  ),
  CONSTRAINT ck_provider_usage_cost_snapshot_pair CHECK (
    (pricebook_entry_id IS NULL AND pricebook_version IS NULL)
    OR (pricebook_entry_id IS NOT NULL AND pricebook_version IS NOT NULL)
  ),
  CONSTRAINT ck_provider_usage_cost_reconciliation CHECK (
    (classification = 'reconciled' AND reconciled_at IS NOT NULL)
    OR classification <> 'reconciled'
  ),
  FOREIGN KEY (pricebook_entry_id, pricebook_version)
    REFERENCES ownware.provider_pricebook_snapshots(entry_id, version)
);

CREATE INDEX idx_provider_usage_cost_classification
  ON ownware.provider_usage_cost_observations(
    classification ASC, observed_at DESC, id DESC
  );

CREATE FUNCTION ownware._reject_provider_usage_evidence_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'immutable provider usage evidence';
END;
$$;

CREATE TRIGGER provider_pricebook_snapshots_no_update
  BEFORE UPDATE ON ownware.provider_pricebook_snapshots
  FOR EACH ROW EXECUTE FUNCTION ownware._reject_provider_usage_evidence_mutation();
CREATE TRIGGER provider_pricebook_snapshots_no_delete
  BEFORE DELETE ON ownware.provider_pricebook_snapshots
  FOR EACH ROW EXECUTE FUNCTION ownware._reject_provider_usage_evidence_mutation();
CREATE TRIGGER provider_usage_facts_no_update
  BEFORE UPDATE ON ownware.provider_usage_facts
  FOR EACH ROW EXECUTE FUNCTION ownware._reject_provider_usage_evidence_mutation();
CREATE TRIGGER provider_usage_facts_no_delete
  BEFORE DELETE ON ownware.provider_usage_facts
  FOR EACH ROW EXECUTE FUNCTION ownware._reject_provider_usage_evidence_mutation();
CREATE TRIGGER provider_usage_cost_observations_no_update
  BEFORE UPDATE ON ownware.provider_usage_cost_observations
  FOR EACH ROW EXECUTE FUNCTION ownware._reject_provider_usage_evidence_mutation();
CREATE TRIGGER provider_usage_cost_observations_no_delete
  BEFORE DELETE ON ownware.provider_usage_cost_observations
  FOR EACH ROW EXECUTE FUNCTION ownware._reject_provider_usage_evidence_mutation();
`

const PLUGIN_CONTROL_PLANE_SQL = `
CREATE TABLE ownware.plugin_packages (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  created_at TEXT NOT NULL CHECK (ownware._is_iso_instant(created_at)),
  updated_at TEXT NOT NULL CHECK (ownware._is_iso_instant(updated_at))
);

CREATE TABLE ownware.plugin_versions (
  plugin_id TEXT NOT NULL REFERENCES ownware.plugin_packages(id),
  version TEXT NOT NULL,
  manifest_json TEXT NOT NULL CHECK (manifest_json IS JSON),
  manifest_sha256 TEXT NOT NULL CHECK (manifest_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  package_sha256 TEXT NOT NULL CHECK (package_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  package_key TEXT NOT NULL CHECK (length(package_key) BETWEEN 1 AND 1024),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('builtin', 'local', 'marketplace')),
  trust_kind TEXT NOT NULL CHECK (trust_kind IN (
    'builtin', 'local', 'verified', 'unverified'
  )),
  installed_at TEXT NOT NULL CHECK (ownware._is_iso_instant(installed_at)),
  PRIMARY KEY (plugin_id, version)
);

CREATE INDEX idx_plugin_versions_installed
  ON ownware.plugin_versions(plugin_id ASC, installed_at DESC, version DESC);

CREATE TABLE ownware.plugin_grants (
  plugin_id TEXT NOT NULL REFERENCES ownware.plugin_packages(id),
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('global', 'workspace', 'agent')),
  scope_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('allow', 'deny')),
  version TEXT,
  revision BIGINT NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  updated_at TEXT NOT NULL CHECK (ownware._is_iso_instant(updated_at)),
  PRIMARY KEY (plugin_id, scope_kind, scope_id),
  CONSTRAINT ck_plugin_grants_scope CHECK (
    (scope_kind = 'global' AND scope_id = '')
    OR (scope_kind <> 'global' AND length(scope_id) BETWEEN 1 AND 256)
  ),
  CONSTRAINT ck_plugin_grants_decision CHECK (
    (decision = 'allow' AND version IS NOT NULL)
    OR (decision = 'deny' AND version IS NULL)
  ),
  FOREIGN KEY (plugin_id, version)
    REFERENCES ownware.plugin_versions(plugin_id, version)
);

CREATE INDEX idx_plugin_grants_scope
  ON ownware.plugin_grants(scope_kind ASC, scope_id ASC, plugin_id ASC);

CREATE TABLE ownware.plugin_migration_receipts (
  plugin_id TEXT NOT NULL,
  version TEXT NOT NULL,
  migration_id TEXT NOT NULL,
  migration_sha256 TEXT NOT NULL CHECK (migration_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  applied_at TEXT NOT NULL CHECK (ownware._is_iso_instant(applied_at)),
  PRIMARY KEY (plugin_id, version, migration_id),
  FOREIGN KEY (plugin_id, version)
    REFERENCES ownware.plugin_versions(plugin_id, version)
);

CREATE FUNCTION ownware._reject_plugin_evidence_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'immutable plugin evidence';
END;
$$;

CREATE TRIGGER plugin_versions_no_update
  BEFORE UPDATE ON ownware.plugin_versions
  FOR EACH ROW EXECUTE FUNCTION ownware._reject_plugin_evidence_mutation();
CREATE TRIGGER plugin_versions_no_delete
  BEFORE DELETE ON ownware.plugin_versions
  FOR EACH ROW EXECUTE FUNCTION ownware._reject_plugin_evidence_mutation();
CREATE TRIGGER plugin_migration_receipts_no_update
  BEFORE UPDATE ON ownware.plugin_migration_receipts
  FOR EACH ROW EXECUTE FUNCTION ownware._reject_plugin_evidence_mutation();
CREATE TRIGGER plugin_migration_receipts_no_delete
  BEFORE DELETE ON ownware.plugin_migration_receipts
  FOR EACH ROW EXECUTE FUNCTION ownware._reject_plugin_evidence_mutation();
`

const PROFILE_DEPLOYMENT_TOMBSTONES_SQL = `
CREATE TABLE ownware.profile_candidate_deployment_tombstones (
  profile_id TEXT PRIMARY KEY,
  previous_candidate_id TEXT NOT NULL
    REFERENCES ownware.profile_candidates(candidate_id),
  deployment_revision BIGINT NOT NULL CHECK (
    deployment_revision BETWEEN 1 AND 9007199254740991
  ),
  undeployed_at BIGINT NOT NULL CHECK (
    undeployed_at BETWEEN 0 AND 9007199254740991
  ),
  updated_at BIGINT NOT NULL CHECK (
    updated_at BETWEEN undeployed_at AND 9007199254740991
  )
);

CREATE INDEX idx_profile_candidate_deployment_tombstones_candidate
  ON ownware.profile_candidate_deployment_tombstones(previous_candidate_id);
`

const PROVIDER_USAGE_EVIDENCE_COLUMNS = [
  { table: 'provider_pricebook_snapshots', name: 'entry_id', type: 'TEXT', nullable: false, pkPosition: 1 },
  { table: 'provider_pricebook_snapshots', name: 'version', type: 'TEXT', nullable: false, pkPosition: 2 },
  { table: 'provider_pricebook_snapshots', name: 'payload_json', type: 'TEXT', nullable: false, pkPosition: 0 },
  { table: 'provider_pricebook_snapshots', name: 'payload_sha256', type: 'TEXT', nullable: false, pkPosition: 0 },
  { table: 'provider_pricebook_snapshots', name: 'recorded_at', type: 'TEXT', nullable: false, pkPosition: 0 },
  { table: 'provider_usage_facts', name: 'id', type: 'TEXT', nullable: false, pkPosition: 1 },
  { table: 'provider_usage_facts', name: 'occurred_at', type: 'TEXT', nullable: false, pkPosition: 0 },
  { table: 'provider_usage_facts', name: 'thread_id', type: 'TEXT', nullable: true, pkPosition: 0 },
  { table: 'provider_usage_facts', name: 'profile_id', type: 'TEXT', nullable: true, pkPosition: 0 },
  { table: 'provider_usage_facts', name: 'provider_family_id', type: 'TEXT', nullable: false, pkPosition: 0 },
  { table: 'provider_usage_facts', name: 'provider_route_id', type: 'TEXT', nullable: false, pkPosition: 0 },
  { table: 'provider_usage_facts', name: 'model_route_id', type: 'TEXT', nullable: false, pkPosition: 0 },
  { table: 'provider_usage_facts', name: 'connection_id', type: 'TEXT', nullable: true, pkPosition: 0 },
  { table: 'provider_usage_facts', name: 'wire_model_id', type: 'TEXT', nullable: false, pkPosition: 0 },
  { table: 'provider_usage_facts', name: 'service_tier', type: 'TEXT', nullable: true, pkPosition: 0 },
  { table: 'provider_usage_facts', name: 'context_tier', type: 'TEXT', nullable: true, pkPosition: 0 },
  { table: 'provider_usage_facts', name: 'region', type: 'TEXT', nullable: true, pkPosition: 0 },
  { table: 'provider_usage_facts', name: 'billing_kind', type: 'TEXT', nullable: false, pkPosition: 0 },
  { table: 'provider_usage_facts', name: 'tokens_json', type: 'TEXT', nullable: false, pkPosition: 0 },
  { table: 'provider_usage_facts', name: 'units_json', type: 'TEXT', nullable: false, pkPosition: 0 },
  { table: 'provider_usage_facts', name: 'provider_facts_json', type: 'TEXT', nullable: false, pkPosition: 0 },
  { table: 'provider_usage_facts', name: 'duration_ms', type: 'DOUBLE PRECISION', nullable: true, pkPosition: 0 },
  { table: 'provider_usage_facts', name: 'success', type: 'BOOLEAN', nullable: false, pkPosition: 0 },
  { table: 'provider_usage_facts', name: 'recorded_at', type: 'TEXT', nullable: false, pkPosition: 0 },
  { table: 'provider_usage_cost_observations', name: 'id', type: 'TEXT', nullable: false, pkPosition: 1 },
  { table: 'provider_usage_cost_observations', name: 'usage_id', type: 'TEXT', nullable: false, pkPosition: 0 },
  { table: 'provider_usage_cost_observations', name: 'observation_seq', type: 'BIGINT', nullable: false, pkPosition: 0 },
  { table: 'provider_usage_cost_observations', name: 'classification', type: 'TEXT', nullable: false, pkPosition: 0 },
  { table: 'provider_usage_cost_observations', name: 'amount_usd', type: 'DOUBLE PRECISION', nullable: true, pkPosition: 0 },
  { table: 'provider_usage_cost_observations', name: 'currency', type: 'TEXT', nullable: false, pkPosition: 0 },
  { table: 'provider_usage_cost_observations', name: 'pricebook_entry_id', type: 'TEXT', nullable: true, pkPosition: 0 },
  { table: 'provider_usage_cost_observations', name: 'pricebook_version', type: 'TEXT', nullable: true, pkPosition: 0 },
  { table: 'provider_usage_cost_observations', name: 'observed_at', type: 'TEXT', nullable: false, pkPosition: 0 },
  { table: 'provider_usage_cost_observations', name: 'reconciled_at', type: 'TEXT', nullable: true, pkPosition: 0 },
  { table: 'provider_usage_cost_observations', name: 'recorded_at', type: 'TEXT', nullable: false, pkPosition: 0 },
] as const

const PROVIDER_USAGE_EVIDENCE_INDEXES = [
  {
    table: 'provider_usage_facts', name: 'idx_provider_usage_facts_occurred', unique: false,
    columns: [{ name: 'occurred_at', descending: true }, { name: 'id', descending: true }], predicate: null,
  },
  {
    table: 'provider_usage_facts', name: 'idx_provider_usage_facts_profile', unique: false,
    columns: [{ name: 'profile_id', descending: false }, { name: 'occurred_at', descending: true }, { name: 'id', descending: true }], predicate: null,
  },
  {
    table: 'provider_usage_facts', name: 'idx_provider_usage_facts_thread', unique: false,
    columns: [{ name: 'thread_id', descending: false }, { name: 'occurred_at', descending: false }, { name: 'id', descending: false }], predicate: null,
  },
  {
    table: 'provider_usage_facts', name: 'idx_provider_usage_facts_route_model', unique: false,
    columns: [{ name: 'provider_route_id', descending: false }, { name: 'model_route_id', descending: false }, { name: 'occurred_at', descending: true }, { name: 'id', descending: true }], predicate: null,
  },
  {
    table: 'provider_usage_cost_observations', name: 'idx_provider_usage_cost_classification', unique: false,
    columns: [{ name: 'classification', descending: false }, { name: 'observed_at', descending: true }, { name: 'id', descending: true }], predicate: null,
  },
] as const

const PLUGIN_CONTROL_PLANE_COLUMNS = [
  { table: 'plugin_packages', name: 'id', type: 'TEXT', nullable: false, pkPosition: 1 },
  { table: 'plugin_packages', name: 'created_at', type: 'TEXT', nullable: false, pkPosition: 0 },
  { table: 'plugin_packages', name: 'updated_at', type: 'TEXT', nullable: false, pkPosition: 0 },
  { table: 'plugin_versions', name: 'plugin_id', type: 'TEXT', nullable: false, pkPosition: 1 },
  { table: 'plugin_versions', name: 'version', type: 'TEXT', nullable: false, pkPosition: 2 },
  { table: 'plugin_versions', name: 'manifest_json', type: 'TEXT', nullable: false, pkPosition: 0 },
  { table: 'plugin_versions', name: 'manifest_sha256', type: 'TEXT', nullable: false, pkPosition: 0 },
  { table: 'plugin_versions', name: 'package_sha256', type: 'TEXT', nullable: false, pkPosition: 0 },
  { table: 'plugin_versions', name: 'package_key', type: 'TEXT', nullable: false, pkPosition: 0 },
  { table: 'plugin_versions', name: 'source_kind', type: 'TEXT', nullable: false, pkPosition: 0 },
  { table: 'plugin_versions', name: 'trust_kind', type: 'TEXT', nullable: false, pkPosition: 0 },
  { table: 'plugin_versions', name: 'installed_at', type: 'TEXT', nullable: false, pkPosition: 0 },
  { table: 'plugin_grants', name: 'plugin_id', type: 'TEXT', nullable: false, pkPosition: 1 },
  { table: 'plugin_grants', name: 'scope_kind', type: 'TEXT', nullable: false, pkPosition: 2 },
  { table: 'plugin_grants', name: 'scope_id', type: 'TEXT', nullable: false, pkPosition: 3 },
  { table: 'plugin_grants', name: 'decision', type: 'TEXT', nullable: false, pkPosition: 0 },
  { table: 'plugin_grants', name: 'version', type: 'TEXT', nullable: true, pkPosition: 0 },
  { table: 'plugin_grants', name: 'revision', type: 'BIGINT', nullable: false, pkPosition: 0 },
  { table: 'plugin_grants', name: 'updated_at', type: 'TEXT', nullable: false, pkPosition: 0 },
  { table: 'plugin_migration_receipts', name: 'plugin_id', type: 'TEXT', nullable: false, pkPosition: 1 },
  { table: 'plugin_migration_receipts', name: 'version', type: 'TEXT', nullable: false, pkPosition: 2 },
  { table: 'plugin_migration_receipts', name: 'migration_id', type: 'TEXT', nullable: false, pkPosition: 3 },
  { table: 'plugin_migration_receipts', name: 'migration_sha256', type: 'TEXT', nullable: false, pkPosition: 0 },
  { table: 'plugin_migration_receipts', name: 'applied_at', type: 'TEXT', nullable: false, pkPosition: 0 },
] as const

const PLUGIN_CONTROL_PLANE_INDEXES = [
  {
    table: 'plugin_grants', name: 'idx_plugin_grants_scope', unique: false,
    columns: [
      { name: 'scope_kind', descending: false },
      { name: 'scope_id', descending: false },
      { name: 'plugin_id', descending: false },
    ],
    predicate: null,
  },
  {
    table: 'plugin_versions', name: 'idx_plugin_versions_installed', unique: false,
    columns: [
      { name: 'plugin_id', descending: false },
      { name: 'installed_at', descending: true },
      { name: 'version', descending: true },
    ],
    predicate: null,
  },
] as const

const PROFILE_DEPLOYMENT_TOMBSTONE_COLUMNS = [
  {
    table: 'profile_candidate_deployment_tombstones',
    name: 'profile_id',
    type: 'TEXT',
    nullable: false,
    pkPosition: 1,
  },
  {
    table: 'profile_candidate_deployment_tombstones',
    name: 'previous_candidate_id',
    type: 'TEXT',
    nullable: false,
    pkPosition: 0,
  },
  {
    table: 'profile_candidate_deployment_tombstones',
    name: 'deployment_revision',
    type: 'BIGINT',
    nullable: false,
    pkPosition: 0,
  },
  {
    table: 'profile_candidate_deployment_tombstones',
    name: 'undeployed_at',
    type: 'BIGINT',
    nullable: false,
    pkPosition: 0,
  },
  {
    table: 'profile_candidate_deployment_tombstones',
    name: 'updated_at',
    type: 'BIGINT',
    nullable: false,
    pkPosition: 0,
  },
] as const

const PROFILE_DEPLOYMENT_TOMBSTONE_INDEX = {
  table: 'profile_candidate_deployment_tombstones',
  name: 'idx_profile_candidate_deployment_tombstones_candidate',
  unique: false,
  columns: [{ name: 'previous_candidate_id', descending: false }],
  predicate: null,
} as const

export const POSTGRESQL_MESSAGE_SEQUENCE_SCHEMA_EXPECTATION: PostgreSqlSchemaExpectation =
Object.freeze({
  summary: Object.freeze({
    ...POSTGRESQL_BASELINE_SUMMARY,
    columnCount: POSTGRESQL_BASELINE_SUMMARY.columnCount + 1,
    explicitIndexCount: POSTGRESQL_BASELINE_SUMMARY.explicitIndexCount + 1,
  }),
  manifest: Object.freeze({
    columns: Object.freeze([
      ...POSTGRESQL_BASELINE_MANIFEST.columns,
      {
        table: 'messages',
        name: 'message_seq',
        type: 'BIGINT',
        nullable: false,
        pkPosition: 0,
      },
    ].sort((left, right) => (
      left.table.localeCompare(right.table) || left.name.localeCompare(right.name)
    ))),
    uniqueConstraints: POSTGRESQL_BASELINE_MANIFEST.uniqueConstraints,
    foreignKeys: POSTGRESQL_BASELINE_MANIFEST.foreignKeys,
    explicitIndexes: Object.freeze([
      ...POSTGRESQL_BASELINE_MANIFEST.explicitIndexes,
      {
        table: 'messages',
        name: 'idx_messages_thread_sequence',
        unique: true,
        columns: [
          { name: 'thread_id', descending: false },
          { name: 'message_seq', descending: false },
        ],
        predicate: null,
      },
    ].sort((left, right) => left.name.localeCompare(right.name))),
  }),
})

export const POSTGRESQL_PROVIDER_USAGE_EVIDENCE_SCHEMA_EXPECTATION: PostgreSqlSchemaExpectation = Object.freeze({
  summary: Object.freeze({
    ...POSTGRESQL_BASELINE_SUMMARY,
    tableCount: POSTGRESQL_BASELINE_SUMMARY.tableCount + 3,
    columnCount: POSTGRESQL_BASELINE_SUMMARY.columnCount + 36,
    foreignKeyCount: POSTGRESQL_BASELINE_SUMMARY.foreignKeyCount + 2,
    uniqueConstraintCount: POSTGRESQL_BASELINE_SUMMARY.uniqueConstraintCount + 1,
    explicitIndexCount: POSTGRESQL_BASELINE_SUMMARY.explicitIndexCount + 6,
    triggerCount: POSTGRESQL_BASELINE_SUMMARY.triggerCount + 6,
  }),
  manifest: Object.freeze({
    columns: Object.freeze([
      ...POSTGRESQL_BASELINE_MANIFEST.columns,
      {
        table: 'messages',
        name: 'message_seq',
        type: 'BIGINT',
        nullable: false,
        pkPosition: 0,
      },
      ...PROVIDER_USAGE_EVIDENCE_COLUMNS,
    ].sort((left, right) => (
      left.table.localeCompare(right.table) || left.name.localeCompare(right.name)
    ))),
    uniqueConstraints: Object.freeze([
      ...POSTGRESQL_BASELINE_MANIFEST.uniqueConstraints,
      {
        table: 'provider_usage_cost_observations',
        columns: ['usage_id', 'observation_seq'],
      },
    ].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))),
    foreignKeys: Object.freeze([
      ...POSTGRESQL_BASELINE_MANIFEST.foreignKeys,
      {
        table: 'provider_usage_cost_observations',
        columns: ['pricebook_entry_id', 'pricebook_version'],
        referencedTable: 'provider_pricebook_snapshots',
        referencedColumns: ['entry_id', 'version'],
        onUpdate: 'NO ACTION',
        onDelete: 'NO ACTION',
        deferred: false,
      },
      {
        table: 'provider_usage_cost_observations',
        columns: ['usage_id'],
        referencedTable: 'provider_usage_facts',
        referencedColumns: ['id'],
        onUpdate: 'NO ACTION',
        onDelete: 'NO ACTION',
        deferred: false,
      },
    ].sort((left, right) => (
      left.table.localeCompare(right.table) || left.columns.join('\u0000').localeCompare(right.columns.join('\u0000'))
    ))),
    explicitIndexes: Object.freeze([
      ...POSTGRESQL_BASELINE_MANIFEST.explicitIndexes,
      {
        table: 'messages',
        name: 'idx_messages_thread_sequence',
        unique: true,
        columns: [
          { name: 'thread_id', descending: false },
          { name: 'message_seq', descending: false },
        ],
        predicate: null,
      },
      ...PROVIDER_USAGE_EVIDENCE_INDEXES,
    ].sort((left, right) => left.name.localeCompare(right.name))),
  }),
})

export const POSTGRESQL_PLUGIN_CONTROL_PLANE_SCHEMA_EXPECTATION:
PostgreSqlSchemaExpectation = Object.freeze({
  summary: Object.freeze({
    ...POSTGRESQL_BASELINE_SUMMARY,
    tableCount: POSTGRESQL_BASELINE_SUMMARY.tableCount + 7,
    columnCount: POSTGRESQL_BASELINE_SUMMARY.columnCount + 60,
    foreignKeyCount: POSTGRESQL_BASELINE_SUMMARY.foreignKeyCount + 6,
    uniqueConstraintCount: POSTGRESQL_BASELINE_SUMMARY.uniqueConstraintCount + 1,
    explicitIndexCount: POSTGRESQL_BASELINE_SUMMARY.explicitIndexCount + 8,
    triggerCount: POSTGRESQL_BASELINE_SUMMARY.triggerCount + 10,
  }),
  manifest: Object.freeze({
    columns: Object.freeze([
      ...POSTGRESQL_PROVIDER_USAGE_EVIDENCE_SCHEMA_EXPECTATION.manifest.columns,
      ...PLUGIN_CONTROL_PLANE_COLUMNS,
    ].sort((left, right) => (
      left.table.localeCompare(right.table) || left.name.localeCompare(right.name)
    ))),
    uniqueConstraints: POSTGRESQL_PROVIDER_USAGE_EVIDENCE_SCHEMA_EXPECTATION
      .manifest.uniqueConstraints,
    foreignKeys: Object.freeze([
      ...POSTGRESQL_PROVIDER_USAGE_EVIDENCE_SCHEMA_EXPECTATION.manifest.foreignKeys,
      {
        table: 'plugin_grants',
        columns: ['plugin_id'],
        referencedTable: 'plugin_packages',
        referencedColumns: ['id'],
        onUpdate: 'NO ACTION',
        onDelete: 'NO ACTION',
        deferred: false,
      },
      {
        table: 'plugin_grants',
        columns: ['plugin_id', 'version'],
        referencedTable: 'plugin_versions',
        referencedColumns: ['plugin_id', 'version'],
        onUpdate: 'NO ACTION',
        onDelete: 'NO ACTION',
        deferred: false,
      },
      {
        table: 'plugin_migration_receipts',
        columns: ['plugin_id', 'version'],
        referencedTable: 'plugin_versions',
        referencedColumns: ['plugin_id', 'version'],
        onUpdate: 'NO ACTION',
        onDelete: 'NO ACTION',
        deferred: false,
      },
      {
        table: 'plugin_versions',
        columns: ['plugin_id'],
        referencedTable: 'plugin_packages',
        referencedColumns: ['id'],
        onUpdate: 'NO ACTION',
        onDelete: 'NO ACTION',
        deferred: false,
      },
    ].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))),
    explicitIndexes: Object.freeze([
      ...POSTGRESQL_PROVIDER_USAGE_EVIDENCE_SCHEMA_EXPECTATION.manifest.explicitIndexes,
      ...PLUGIN_CONTROL_PLANE_INDEXES,
    ].sort((left, right) => left.name.localeCompare(right.name))),
  }),
})

export const POSTGRESQL_CURRENT_SCHEMA_EXPECTATION:
PostgreSqlSchemaExpectation = Object.freeze({
  summary: Object.freeze({
    ...POSTGRESQL_PLUGIN_CONTROL_PLANE_SCHEMA_EXPECTATION.summary,
    tableCount:
      POSTGRESQL_PLUGIN_CONTROL_PLANE_SCHEMA_EXPECTATION.summary.tableCount + 1,
    columnCount:
      POSTGRESQL_PLUGIN_CONTROL_PLANE_SCHEMA_EXPECTATION.summary.columnCount + 5,
    foreignKeyCount:
      POSTGRESQL_PLUGIN_CONTROL_PLANE_SCHEMA_EXPECTATION.summary.foreignKeyCount + 1,
    explicitIndexCount:
      POSTGRESQL_PLUGIN_CONTROL_PLANE_SCHEMA_EXPECTATION.summary.explicitIndexCount + 1,
  }),
  manifest: Object.freeze({
    columns: Object.freeze([
      ...POSTGRESQL_PLUGIN_CONTROL_PLANE_SCHEMA_EXPECTATION.manifest.columns,
      ...PROFILE_DEPLOYMENT_TOMBSTONE_COLUMNS,
    ].sort((left, right) => (
      left.table.localeCompare(right.table) || left.name.localeCompare(right.name)
    ))),
    uniqueConstraints:
      POSTGRESQL_PLUGIN_CONTROL_PLANE_SCHEMA_EXPECTATION.manifest.uniqueConstraints,
    foreignKeys: Object.freeze([
      ...POSTGRESQL_PLUGIN_CONTROL_PLANE_SCHEMA_EXPECTATION.manifest.foreignKeys,
      {
        table: 'profile_candidate_deployment_tombstones',
        columns: ['previous_candidate_id'],
        referencedTable: 'profile_candidates',
        referencedColumns: ['candidate_id'],
        onUpdate: 'NO ACTION',
        onDelete: 'NO ACTION',
        deferred: false,
      },
    ].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))),
    explicitIndexes: Object.freeze([
      ...POSTGRESQL_PLUGIN_CONTROL_PLANE_SCHEMA_EXPECTATION.manifest.explicitIndexes,
      PROFILE_DEPLOYMENT_TOMBSTONE_INDEX,
    ].sort((left, right) => left.name.localeCompare(right.name))),
  }),
})

async function postgreSqlMessageSequenceMatches(client: QueryClient): Promise<boolean> {
  const result = await client.query<{
    readonly constraint_valid: boolean
    readonly constraint_definition: string | null
    readonly data_valid: boolean
  }>(`
    SELECT
      COALESCE((
        SELECT constraint_record.convalidated
        FROM pg_catalog.pg_constraint AS constraint_record
        JOIN pg_catalog.pg_namespace AS namespace
          ON namespace.oid = constraint_record.connamespace
        WHERE namespace.nspname = 'ownware'
          AND constraint_record.conrelid = 'ownware.messages'::regclass
          AND constraint_record.conname = 'ck_messages_message_seq_positive'
          AND constraint_record.contype = 'c'
      ), FALSE) AS constraint_valid,
      (
        SELECT pg_catalog.pg_get_constraintdef(constraint_record.oid)
        FROM pg_catalog.pg_constraint AS constraint_record
        JOIN pg_catalog.pg_namespace AS namespace
          ON namespace.oid = constraint_record.connamespace
        WHERE namespace.nspname = 'ownware'
          AND constraint_record.conrelid = 'ownware.messages'::regclass
          AND constraint_record.conname = 'ck_messages_message_seq_positive'
          AND constraint_record.contype = 'c'
      ) AS constraint_definition,
      NOT EXISTS (
        SELECT 1 FROM ownware.messages
        WHERE message_seq NOT BETWEEN 1 AND 9007199254740991
      ) AS data_valid
  `)
  const row = result.rows[0]
  return row?.constraint_valid === true &&
    row.constraint_definition ===
      "CHECK (((message_seq >= 1) AND (message_seq <= '9007199254740991'::bigint)))" &&
    row.data_valid === true
}

async function postgreSqlCurrentSchemaMatches(client: QueryClient): Promise<boolean> {
  return await postgreSqlSchemaMatches(client, POSTGRESQL_CURRENT_SCHEMA_EXPECTATION) &&
    await postgreSqlMessageSequenceMatches(client) &&
    await postgreSqlProviderUsageEvidenceMatches(client) &&
    await postgreSqlPluginControlPlaneMatches(client) &&
    await postgreSqlProfileDeploymentTombstonesMatch(client)
}

async function postgreSqlPluginControlPlaneSchemaMatches(
  client: QueryClient,
): Promise<boolean> {
  return await postgreSqlSchemaMatches(
    client,
    POSTGRESQL_PLUGIN_CONTROL_PLANE_SCHEMA_EXPECTATION,
  ) &&
    await postgreSqlMessageSequenceMatches(client) &&
    await postgreSqlProviderUsageEvidenceMatches(client) &&
    await postgreSqlPluginControlPlaneMatches(client)
}

async function postgreSqlMessageSequenceSchemaMatches(client: QueryClient): Promise<boolean> {
  return await postgreSqlSchemaMatches(client, POSTGRESQL_MESSAGE_SEQUENCE_SCHEMA_EXPECTATION) &&
    await postgreSqlMessageSequenceMatches(client)
}

async function postgreSqlProviderUsageEvidenceMatches(client: QueryClient): Promise<boolean> {
  const result = await client.query<{
    readonly immutable_trigger_count: string
    readonly data_valid: boolean
  }>(`
    SELECT
      (SELECT count(*)::text
       FROM pg_catalog.pg_trigger AS trigger_record
       JOIN pg_catalog.pg_class AS relation ON relation.oid = trigger_record.tgrelid
       JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = 'ownware'
         AND trigger_record.tgname IN (
           'provider_pricebook_snapshots_no_update',
           'provider_pricebook_snapshots_no_delete',
           'provider_usage_facts_no_update',
           'provider_usage_facts_no_delete',
           'provider_usage_cost_observations_no_update',
           'provider_usage_cost_observations_no_delete'
         )
         AND trigger_record.tgenabled = 'O') AS immutable_trigger_count,
      NOT EXISTS (
        SELECT 1 FROM ownware.provider_usage_cost_observations
        WHERE observation_seq NOT BETWEEN 1 AND 9007199254740991
          OR (classification IN ('unknown', 'subscription', 'local') AND amount_usd IS NOT NULL)
          OR (classification IN ('estimated', 'provider_reported', 'reconciled') AND amount_usd IS NULL)
      ) AS data_valid
  `)
  return result.rows[0]?.immutable_trigger_count === '6' && result.rows[0]?.data_valid === true
}

async function postgreSqlProviderUsageEvidenceSchemaMatches(client: QueryClient): Promise<boolean> {
  return await postgreSqlSchemaMatches(
    client,
    POSTGRESQL_PROVIDER_USAGE_EVIDENCE_SCHEMA_EXPECTATION,
  ) && await postgreSqlMessageSequenceMatches(client) &&
    await postgreSqlProviderUsageEvidenceMatches(client)
}

async function postgreSqlPluginControlPlaneMatches(client: QueryClient): Promise<boolean> {
  const result = await client.query<{
    readonly immutable_trigger_count: string
    readonly data_valid: boolean
  }>(`
    SELECT
      (SELECT count(*)::text
       FROM pg_catalog.pg_trigger AS trigger_record
       JOIN pg_catalog.pg_class AS relation ON relation.oid = trigger_record.tgrelid
       JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = 'ownware'
         AND trigger_record.tgname IN (
           'plugin_versions_no_update',
           'plugin_versions_no_delete',
           'plugin_migration_receipts_no_update',
           'plugin_migration_receipts_no_delete'
         )
         AND trigger_record.tgenabled = 'O') AS immutable_trigger_count,
      NOT EXISTS (
        SELECT 1 FROM ownware.plugin_grants
        WHERE revision NOT BETWEEN 1 AND 9007199254740991
          OR (scope_kind = 'global' AND scope_id <> '')
          OR (scope_kind <> 'global' AND scope_id = '')
          OR (decision = 'allow' AND version IS NULL)
          OR (decision = 'deny' AND version IS NOT NULL)
      ) AS data_valid
  `)
  return result.rows[0]?.immutable_trigger_count === '4' && result.rows[0]?.data_valid === true
}

async function postgreSqlProfileDeploymentTombstonesMatch(
  client: QueryClient,
): Promise<boolean> {
  const result = await client.query<{ readonly data_valid: boolean }>(`
    SELECT NOT EXISTS (
      SELECT 1 FROM ownware.profile_candidate_deployment_tombstones
      WHERE deployment_revision NOT BETWEEN 1 AND 9007199254740991
        OR undeployed_at NOT BETWEEN 0 AND 9007199254740991
        OR updated_at < undeployed_at
        OR updated_at > 9007199254740991
    ) AS data_valid
  `)
  return result.rows[0]?.data_valid === true
}

const MESSAGE_SEQUENCE_MIGRATION: PostgreSqlMigration = Object.freeze({
  version: 83,
  name: '083_message_sequence',
  sql: MESSAGE_SEQUENCE_SQL,
  verifyApplied: postgreSqlMessageSequenceSchemaMatches,
})

const PROVIDER_USAGE_EVIDENCE_MIGRATION: PostgreSqlMigration = Object.freeze({
  version: 84,
  name: '084_provider_usage_evidence',
  sql: PROVIDER_USAGE_EVIDENCE_SQL,
  verifyApplied: postgreSqlProviderUsageEvidenceSchemaMatches,
})

const PLUGIN_CONTROL_PLANE_MIGRATION: PostgreSqlMigration = Object.freeze({
  version: 85,
  name: '085_plugin_control_plane',
  sql: PLUGIN_CONTROL_PLANE_SQL,
  verifyApplied: postgreSqlPluginControlPlaneSchemaMatches,
})

const PROFILE_DEPLOYMENT_TOMBSTONES_MIGRATION: PostgreSqlMigration = Object.freeze({
  version: 86,
  name: '086_profile_deployment_tombstones',
  sql: PROFILE_DEPLOYMENT_TOMBSTONES_SQL,
  verifyApplied: postgreSqlCurrentSchemaMatches,
})

/** Immutable production PostgreSQL dialect manifest. */
export const POSTGRESQL_MIGRATION_MANIFEST: PostgreSqlMigrationManifest = Object.freeze({
  migrations: Object.freeze([
    BASELINE_MIGRATION,
    MESSAGE_SEQUENCE_MIGRATION,
    PROVIDER_USAGE_EVIDENCE_MIGRATION,
    PLUGIN_CONTROL_PLANE_MIGRATION,
    PROFILE_DEPLOYMENT_TOMBSTONES_MIGRATION,
  ]),
  logicalMigrations: STORAGE_LOGICAL_MIGRATIONS,
  verifyCurrentSchema: postgreSqlCurrentSchemaMatches,
})

/** Fingerprint the exact dialect SQL that the migration client executes. */
export function postgreSqlMigrationFingerprint(migration: PostgreSqlMigration): string {
  return `sha256:${createHash('sha256').update(migration.sql).digest('hex')}`
}

function manifestFailure(): PostgreSqlStorageError {
  return new PostgreSqlStorageError('schema_history_diverged', 'migration', false)
}

/** Validate compiled identity before it can interpret or mutate a database. */
export function validatePostgreSqlMigrationManifest(
  manifest: PostgreSqlMigrationManifest,
): void {
  const migrations = manifest.migrations
  if (!Array.isArray(migrations) || typeof manifest.verifyCurrentSchema !== 'function') {
    throw manifestFailure()
  }
  const baseline = migrations[0]
  if (
    baseline === undefined ||
    baseline.version !== STORAGE_ADAPTER_BASELINE_VERSION ||
    baseline.version !== POSTGRESQL_BASELINE_VERSION ||
    baseline.name !== POSTGRESQL_BASELINE_NAME ||
    baseline.sql !== POSTGRESQL_BASELINE_SQL ||
    postgreSqlMigrationFingerprint(baseline) !== POSTGRESQL_BASELINE_DDL_HASH
  ) {
    throw manifestFailure()
  }

  const names = new Set<string>()
  for (let index = 0; index < migrations.length; index += 1) {
    const migration = migrations[index]!
    if (
      !Number.isSafeInteger(migration.version) ||
      migration.version !== POSTGRESQL_BASELINE_VERSION + index ||
      migration.name.trim().length === 0 ||
      migration.sql.trim().length === 0 ||
      typeof migration.verifyApplied !== 'function' ||
      names.has(migration.name)
    ) {
      throw manifestFailure()
    }
    names.add(migration.name)
  }

  try {
    assertStorageMigrationAlignment(
      manifest.logicalMigrations,
      manifest.logicalMigrations,
      migrations.slice(1),
    )
  } catch {
    throw manifestFailure()
  }
}

/**
 * Validate the exact applied prefix and return the first pending manifest row.
 * A clean contiguous next version beyond this binary is distinguished from a
 * malformed/gapped history so operators receive an honest newer-schema signal.
 */
export function validatePostgreSqlMigrationHistory(
  rows: readonly PostgreSqlMigrationHistoryRow[],
  manifest: PostgreSqlMigrationManifest,
): number {
  validatePostgreSqlMigrationManifest(manifest)
  if (rows.length === 0) throw manifestFailure()

  const comparable = Math.min(rows.length, manifest.migrations.length)
  for (let index = 0; index < comparable; index += 1) {
    const row = rows[index]!
    const expected = manifest.migrations[index]!
    if (
      row.version !== String(expected.version) ||
      row.name !== expected.name ||
      row.fingerprint !== postgreSqlMigrationFingerprint(expected)
    ) {
      throw manifestFailure()
    }
  }

  if (rows.length > manifest.migrations.length) {
    const firstUnknown = rows[manifest.migrations.length]!
    const targetVersion = manifest.migrations.at(-1)!.version
    if (
      firstUnknown.version === String(targetVersion + 1) &&
      firstUnknown.name.trim().length > 0 &&
      /^sha256:[0-9a-f]{64}$/.test(firstUnknown.fingerprint ?? '')
    ) {
      throw new PostgreSqlStorageError('schema_version_newer', 'migration', false)
    }
    throw manifestFailure()
  }
  return rows.length
}

/**
 * Apply a fresh manifest or the pending suffix of a validated existing prefix.
 * The caller owns the surrounding transaction and migration lock.
 */
export async function applyPostgreSqlMigrationManifest(
  client: QueryClient,
  manifest: PostgreSqlMigrationManifest,
  history: readonly PostgreSqlMigrationHistoryRow[] | null,
): Promise<void> {
  validatePostgreSqlMigrationManifest(manifest)
  const firstPending = history === null
    ? 0
    : validatePostgreSqlMigrationHistory(history, manifest)

  for (let index = firstPending; index < manifest.migrations.length; index += 1) {
    const migration = manifest.migrations[index]!
    await client.query(migration.sql)
    if (!await migration.verifyApplied(client)) {
      throw new PostgreSqlStorageError('schema_manifest_mismatch', 'migration', false)
    }
    await client.query(
      'INSERT INTO ownware._migrations (version, name, fingerprint) VALUES ($1, $2, $3)',
      [migration.version, migration.name, postgreSqlMigrationFingerprint(migration)],
    )
  }

  if (!await manifest.verifyCurrentSchema(client)) {
    throw new PostgreSqlStorageError('schema_manifest_mismatch', 'migration', false)
  }
}
