import {
  StorageLifecycleError,
  StorageRepositoryError,
} from './contracts.js'
import type { SqliteRootRepositoryContext } from './sqlite-adapter.js'
import type { SqliteDatabase } from './sqlite-driver.js'
import {
  PluginGrantConflictError,
  PluginMigrationConflictError,
  PluginVersionConflictError,
  PluginVersionNotFoundError,
  comparePluginVersionsDescending,
  normalizePluginGrantKey,
  normalizePluginId,
  normalizePluginMigrationInput,
  normalizePluginVersion,
  normalizePutPluginGrantInput,
  normalizeRegisterPluginVersionInput,
  parseStoredPluginManifest,
  validatePluginExpectedRevision,
  type PluginGrantKey,
  type PluginGrantRecord,
  type PluginMigrationReceipt,
  type PluginRepository,
  type PluginVersionRecord,
} from './plugin-repository.js'

interface PluginVersionRow {
  readonly plugin_id: string
  readonly version: string
  readonly manifest_json: string
  readonly manifest_sha256: string
  readonly package_sha256: string
  readonly package_key: string
  readonly source_kind: PluginVersionRecord['sourceKind']
  readonly trust_kind: PluginVersionRecord['trustKind']
  readonly installed_at: string
}

interface PluginGrantRow {
  readonly plugin_id: string
  readonly scope_kind: PluginGrantRecord['scopeKind']
  readonly scope_id: string
  readonly decision: PluginGrantRecord['decision']
  readonly version: string | null
  readonly revision: number | bigint
  readonly updated_at: string
}

interface PluginMigrationRow {
  readonly plugin_id: string
  readonly version: string
  readonly migration_id: string
  readonly migration_sha256: string
  readonly applied_at: string
}

const PRESERVED_ERRORS = new Set([
  'PluginGrantConflictError',
  'PluginMigrationConflictError',
  'PluginVersionConflictError',
  'PluginVersionNotFoundError',
  'ZodError',
])

function call<T>(
  context: SqliteRootRepositoryContext,
  operation: string,
  code: 'read_failed' | 'write_failed',
  fn: (database: SqliteDatabase) => T,
): T {
  try {
    context.assertActive()
    return fn(context.database)
  } catch (error) {
    if (
      error instanceof StorageLifecycleError ||
      error instanceof StorageRepositoryError ||
      error instanceof TypeError ||
      error instanceof RangeError ||
      (error instanceof Error && PRESERVED_ERRORS.has(error.name))
    ) throw error
    const sqliteCode = typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { readonly code?: unknown }).code ?? '')
      : ''
    throw new StorageRepositoryError(
      code,
      'sqlite',
      'plugins',
      operation,
      sqliteCode === 'SQLITE_BUSY' || sqliteCode === 'SQLITE_LOCKED',
    )
  }
}

function mapVersion(row: PluginVersionRow): PluginVersionRecord {
  return {
    pluginId: row.plugin_id,
    version: row.version,
    manifest: parseStoredPluginManifest(row.manifest_json, row.manifest_sha256),
    manifestSha256: row.manifest_sha256,
    packageSha256: row.package_sha256,
    packageKey: row.package_key,
    sourceKind: row.source_kind,
    trustKind: row.trust_kind,
    installedAt: row.installed_at,
  }
}

function mapGrant(row: PluginGrantRow): PluginGrantRecord {
  const revision = Number(row.revision)
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new PluginGrantConflictError()
  }
  return {
    pluginId: row.plugin_id,
    scopeKind: row.scope_kind,
    scopeId: row.scope_kind === 'global' ? null : row.scope_id,
    decision: row.decision,
    version: row.version,
    revision,
    updatedAt: row.updated_at,
  }
}

function mapMigration(row: PluginMigrationRow): PluginMigrationReceipt {
  return {
    pluginId: row.plugin_id,
    version: row.version,
    migrationId: row.migration_id,
    migrationSha256: row.migration_sha256,
    appliedAt: row.applied_at,
  }
}

function sameVersion(
  existing: PluginVersionRecord,
  normalized: ReturnType<typeof normalizeRegisterPluginVersionInput>,
): boolean {
  return existing.manifestSha256 === normalized.manifestSha256 &&
    existing.packageSha256 === normalized.packageSha256 &&
    existing.packageKey === normalized.packageKey &&
    existing.sourceKind === normalized.sourceKind &&
    existing.trustKind === normalized.trustKind
}

function scopeId(key: PluginGrantKey): string {
  return key.scopeKind === 'global' ? '' : key.scopeId!
}

function getVersion(
  database: SqliteDatabase,
  pluginId: string,
  version: string,
): PluginVersionRecord | null {
  const row = database.prepare(`
    SELECT plugin_id, version, manifest_json, manifest_sha256, package_sha256,
      package_key, source_kind, trust_kind, installed_at
    FROM plugin_versions WHERE plugin_id = ? AND version = ?
  `).get(pluginId, version) as PluginVersionRow | undefined
  return row === undefined ? null : mapVersion(row)
}

function pluginExists(database: SqliteDatabase, pluginId: string): boolean {
  return database.prepare('SELECT 1 FROM plugin_packages WHERE id = ?')
    .get(pluginId) !== undefined
}

function getGrant(
  database: SqliteDatabase,
  key: PluginGrantKey,
): PluginGrantRecord | null {
  const row = database.prepare(`
    SELECT plugin_id, scope_kind, scope_id, decision, version, revision, updated_at
    FROM plugin_grants
    WHERE plugin_id = ? AND scope_kind = ? AND scope_id = ?
  `).get(key.pluginId, key.scopeKind, scopeId(key)) as PluginGrantRow | undefined
  return row === undefined ? null : mapGrant(row)
}

export function createSqlitePluginRepository(
  context: SqliteRootRepositoryContext,
): PluginRepository {
  return {
    async registerVersion(input) {
      const normalized = normalizeRegisterPluginVersionInput(input)
      return call(context, 'register_version', 'write_failed', database =>
        database.transaction(() => {
          const existing = getVersion(database, normalized.pluginId, normalized.version)
          if (existing !== null) {
            if (!sameVersion(existing, normalized)) throw new PluginVersionConflictError()
            return existing
          }
          const installedAt = new Date().toISOString()
          database.prepare(`
            INSERT INTO plugin_packages (id, created_at, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT (id) DO UPDATE SET updated_at = excluded.updated_at
          `).run(normalized.pluginId, installedAt, installedAt)
          database.prepare(`
            INSERT INTO plugin_versions (
              plugin_id, version, manifest_json, manifest_sha256, package_sha256,
              package_key, source_kind, trust_kind, installed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            normalized.pluginId,
            normalized.version,
            normalized.manifestJson,
            normalized.manifestSha256,
            normalized.packageSha256,
            normalized.packageKey,
            normalized.sourceKind,
            normalized.trustKind,
            installedAt,
          )
          return getVersion(database, normalized.pluginId, normalized.version)!
        })())
    },

    async getVersion(pluginIdInput, versionInput) {
      const pluginId = normalizePluginId(pluginIdInput)
      const version = normalizePluginVersion(versionInput)
      return call(context, 'get_version', 'read_failed', database =>
        getVersion(database, pluginId, version))
    },

    async listVersions(pluginIdInput) {
      const pluginId = normalizePluginId(pluginIdInput)
      return call(context, 'list_versions', 'read_failed', database => {
        const rows = database.prepare(`
          SELECT plugin_id, version, manifest_json, manifest_sha256, package_sha256,
            package_key, source_kind, trust_kind, installed_at
          FROM plugin_versions WHERE plugin_id = ?
        `).all(pluginId) as PluginVersionRow[]
        return rows.map(mapVersion).sort((left, right) =>
          comparePluginVersionsDescending(left.version, right.version))
      })
    },

    async putGrant(input, expectedRevisionInput) {
      const normalized = normalizePutPluginGrantInput(input)
      const expectedRevision = validatePluginExpectedRevision(expectedRevisionInput)
      return call(context, 'put_grant', 'write_failed', database =>
        database.transaction(() => {
          if (!pluginExists(database, normalized.pluginId)) {
            throw new PluginVersionNotFoundError()
          }
          if (
            normalized.version !== null &&
            getVersion(database, normalized.pluginId, normalized.version) === null
          ) throw new PluginVersionNotFoundError()

          const existing = getGrant(database, normalized)
          if (existing === null) {
            if (expectedRevision !== null) throw new PluginGrantConflictError()
            const updatedAt = new Date().toISOString()
            database.prepare(`
              INSERT INTO plugin_grants (
                plugin_id, scope_kind, scope_id, decision, version, revision, updated_at
              ) VALUES (?, ?, ?, ?, ?, 1, ?)
            `).run(
              normalized.pluginId,
              normalized.scopeKind,
              scopeId(normalized),
              normalized.decision,
              normalized.version,
              updatedAt,
            )
            return getGrant(database, normalized)!
          }
          const unchanged = existing.decision === normalized.decision &&
            existing.version === normalized.version
          if (
            unchanged &&
            (expectedRevision === existing.revision ||
              expectedRevision === existing.revision - 1 ||
              expectedRevision === null)
          ) return existing
          if (expectedRevision !== existing.revision) throw new PluginGrantConflictError()
          const revision = existing.revision + 1
          const updatedAt = new Date().toISOString()
          database.prepare(`
            UPDATE plugin_grants
            SET decision = ?, version = ?, revision = ?, updated_at = ?
            WHERE plugin_id = ? AND scope_kind = ? AND scope_id = ? AND revision = ?
          `).run(
            normalized.decision,
            normalized.version,
            revision,
            updatedAt,
            normalized.pluginId,
            normalized.scopeKind,
            scopeId(normalized),
            existing.revision,
          )
          return getGrant(database, normalized)!
        })())
    },

    async getGrant(keyInput) {
      const key = normalizePluginGrantKey(keyInput)
      return call(context, 'get_grant', 'read_failed', database => getGrant(database, key))
    },

    async listGrants(pluginIdInput) {
      const pluginId = pluginIdInput === undefined ? undefined : normalizePluginId(pluginIdInput)
      return call(context, 'list_grants', 'read_failed', database => {
        const rows = (pluginId === undefined
          ? database.prepare(`
              SELECT plugin_id, scope_kind, scope_id, decision, version, revision, updated_at
              FROM plugin_grants
              ORDER BY plugin_id, scope_kind, scope_id
            `).all()
          : database.prepare(`
              SELECT plugin_id, scope_kind, scope_id, decision, version, revision, updated_at
              FROM plugin_grants WHERE plugin_id = ?
              ORDER BY scope_kind, scope_id
            `).all(pluginId)) as PluginGrantRow[]
        return rows.map(mapGrant)
      })
    },

    async recordMigration(input) {
      const normalized = normalizePluginMigrationInput(input)
      return call(context, 'record_migration', 'write_failed', database =>
        database.transaction(() => {
          const existing = database.prepare(`
            SELECT plugin_id, version, migration_id, migration_sha256, applied_at
            FROM plugin_migration_receipts
            WHERE plugin_id = ? AND version = ? AND migration_id = ?
          `).get(
            normalized.pluginId,
            normalized.version,
            normalized.migrationId,
          ) as PluginMigrationRow | undefined
          if (existing !== undefined) {
            if (existing.migration_sha256 !== normalized.migrationSha256) {
              throw new PluginMigrationConflictError()
            }
            return mapMigration(existing)
          }
          if (getVersion(database, normalized.pluginId, normalized.version) === null) {
            throw new PluginVersionNotFoundError()
          }
          const appliedAt = new Date().toISOString()
          database.prepare(`
            INSERT INTO plugin_migration_receipts (
              plugin_id, version, migration_id, migration_sha256, applied_at
            ) VALUES (?, ?, ?, ?, ?)
          `).run(
            normalized.pluginId,
            normalized.version,
            normalized.migrationId,
            normalized.migrationSha256,
            appliedAt,
          )
          return mapMigration({
            plugin_id: normalized.pluginId,
            version: normalized.version,
            migration_id: normalized.migrationId,
            migration_sha256: normalized.migrationSha256,
            applied_at: appliedAt,
          })
        })())
    },

    async listMigrations(identityInput) {
      const pluginId = normalizePluginId(identityInput.pluginId)
      const version = normalizePluginVersion(identityInput.version)
      return call(context, 'list_migrations', 'read_failed', database => {
        const rows = database.prepare(`
          SELECT plugin_id, version, migration_id, migration_sha256, applied_at
          FROM plugin_migration_receipts
          WHERE plugin_id = ? AND version = ?
          ORDER BY migration_id
        `).all(pluginId, version) as PluginMigrationRow[]
        return rows.map(mapMigration)
      })
    },
  }
}
