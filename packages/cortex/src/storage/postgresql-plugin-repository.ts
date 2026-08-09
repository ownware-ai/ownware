import type { PostgreSqlRootRepositoryContext } from './postgresql-adapter.js'
import {
  repositoryCall,
  safeInteger,
  withPostgreSqlTransaction,
  type PostgreSqlQueryClient,
} from './postgresql-repository.js'
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
  readonly revision: unknown
  readonly updated_at: string
}

interface PluginMigrationRow {
  readonly plugin_id: string
  readonly version: string
  readonly migration_id: string
  readonly migration_sha256: string
  readonly applied_at: string
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
  return {
    pluginId: row.plugin_id,
    scopeKind: row.scope_kind,
    scopeId: row.scope_kind === 'global' ? null : row.scope_id,
    decision: row.decision,
    version: row.version,
    revision: safeInteger(row.revision),
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

async function getVersion(
  client: PostgreSqlQueryClient,
  pluginId: string,
  version: string,
): Promise<PluginVersionRecord | null> {
  const result = await client.query<PluginVersionRow>(`
    SELECT plugin_id, version, manifest_json, manifest_sha256, package_sha256,
      package_key, source_kind, trust_kind, installed_at
    FROM ownware.plugin_versions WHERE plugin_id = $1 AND version = $2
  `, [pluginId, version])
  const row = result.rows[0]
  return row === undefined ? null : mapVersion(row)
}

async function getGrant(
  client: PostgreSqlQueryClient,
  key: PluginGrantKey,
  forUpdate = false,
): Promise<PluginGrantRecord | null> {
  const result = await client.query<PluginGrantRow>(`
    SELECT plugin_id, scope_kind, scope_id, decision, version, revision, updated_at
    FROM ownware.plugin_grants
    WHERE plugin_id = $1 AND scope_kind = $2 AND scope_id = $3
    ${forUpdate ? 'FOR UPDATE' : ''}
  `, [key.pluginId, key.scopeKind, scopeId(key)])
  const row = result.rows[0]
  return row === undefined ? null : mapGrant(row)
}

export function createPostgreSqlPluginRepository(
  context: PostgreSqlRootRepositoryContext,
): PluginRepository {
  return {
    async registerVersion(input) {
      const normalized = normalizeRegisterPluginVersionInput(input)
      return repositoryCall(context, 'plugins', 'register_version', 'write_failed', () =>
        withPostgreSqlTransaction(context.pool, async client => {
          const installedAt = new Date().toISOString()
          await client.query(`
            INSERT INTO ownware.plugin_packages (id, created_at, updated_at)
            VALUES ($1, $2, $2)
            ON CONFLICT (id) DO UPDATE SET updated_at = EXCLUDED.updated_at
          `, [normalized.pluginId, installedAt])
          await client.query(`
            INSERT INTO ownware.plugin_versions (
              plugin_id, version, manifest_json, manifest_sha256, package_sha256,
              package_key, source_kind, trust_kind, installed_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            ON CONFLICT (plugin_id, version) DO NOTHING
          `, [
            normalized.pluginId,
            normalized.version,
            normalized.manifestJson,
            normalized.manifestSha256,
            normalized.packageSha256,
            normalized.packageKey,
            normalized.sourceKind,
            normalized.trustKind,
            installedAt,
          ])
          const existing = await getVersion(client, normalized.pluginId, normalized.version)
          if (existing === null || !sameVersion(existing, normalized)) {
            throw new PluginVersionConflictError()
          }
          return existing
        }))
    },

    async getVersion(pluginIdInput, versionInput) {
      const pluginId = normalizePluginId(pluginIdInput)
      const version = normalizePluginVersion(versionInput)
      return repositoryCall(context, 'plugins', 'get_version', 'read_failed', client =>
        getVersion(client, pluginId, version))
    },

    async listVersions(pluginIdInput) {
      const pluginId = normalizePluginId(pluginIdInput)
      return repositoryCall(context, 'plugins', 'list_versions', 'read_failed', async client => {
        const result = await client.query<PluginVersionRow>(`
          SELECT plugin_id, version, manifest_json, manifest_sha256, package_sha256,
            package_key, source_kind, trust_kind, installed_at
          FROM ownware.plugin_versions WHERE plugin_id = $1
        `, [pluginId])
        return result.rows.map(mapVersion).sort((left, right) =>
          comparePluginVersionsDescending(left.version, right.version))
      })
    },

    async putGrant(input, expectedRevisionInput) {
      const normalized = normalizePutPluginGrantInput(input)
      const expectedRevision = validatePluginExpectedRevision(expectedRevisionInput)
      return repositoryCall(context, 'plugins', 'put_grant', 'write_failed', () =>
        withPostgreSqlTransaction(context.pool, async client => {
          const packageLock = await client.query<{ readonly id: string }>(`
            SELECT id FROM ownware.plugin_packages WHERE id = $1 FOR UPDATE
          `, [normalized.pluginId])
          if (packageLock.rows[0] === undefined) throw new PluginVersionNotFoundError()
          if (
            normalized.version !== null &&
            await getVersion(client, normalized.pluginId, normalized.version) === null
          ) throw new PluginVersionNotFoundError()

          const existing = await getGrant(client, normalized, true)
          if (existing === null) {
            if (expectedRevision !== null) throw new PluginGrantConflictError()
            const updatedAt = new Date().toISOString()
            await client.query(`
              INSERT INTO ownware.plugin_grants (
                plugin_id, scope_kind, scope_id, decision, version, revision, updated_at
              ) VALUES ($1, $2, $3, $4, $5, 1, $6)
            `, [
              normalized.pluginId,
              normalized.scopeKind,
              scopeId(normalized),
              normalized.decision,
              normalized.version,
              updatedAt,
            ])
            return (await getGrant(client, normalized))!
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
          const updated = await client.query<PluginGrantRow>(`
            UPDATE ownware.plugin_grants
            SET decision = $1, version = $2, revision = $3, updated_at = $4
            WHERE plugin_id = $5 AND scope_kind = $6 AND scope_id = $7 AND revision = $8
            RETURNING plugin_id, scope_kind, scope_id, decision, version, revision, updated_at
          `, [
            normalized.decision,
            normalized.version,
            revision,
            updatedAt,
            normalized.pluginId,
            normalized.scopeKind,
            scopeId(normalized),
            existing.revision,
          ])
          const row = updated.rows[0]
          if (row === undefined) throw new PluginGrantConflictError()
          return mapGrant(row)
        }))
    },

    async getGrant(keyInput) {
      const key = normalizePluginGrantKey(keyInput)
      return repositoryCall(context, 'plugins', 'get_grant', 'read_failed', client =>
        getGrant(client, key))
    },

    async listGrants(pluginIdInput) {
      const pluginId = pluginIdInput === undefined ? undefined : normalizePluginId(pluginIdInput)
      return repositoryCall(context, 'plugins', 'list_grants', 'read_failed', async client => {
        const result = pluginId === undefined
          ? await client.query<PluginGrantRow>(`
              SELECT plugin_id, scope_kind, scope_id, decision, version, revision, updated_at
              FROM ownware.plugin_grants
              ORDER BY plugin_id, scope_kind, scope_id
            `)
          : await client.query<PluginGrantRow>(`
              SELECT plugin_id, scope_kind, scope_id, decision, version, revision, updated_at
              FROM ownware.plugin_grants WHERE plugin_id = $1
              ORDER BY scope_kind, scope_id
            `, [pluginId])
        return result.rows.map(mapGrant)
      })
    },

    async recordMigration(input) {
      const normalized = normalizePluginMigrationInput(input)
      return repositoryCall(context, 'plugins', 'record_migration', 'write_failed', () =>
        withPostgreSqlTransaction(context.pool, async client => {
          const version = await client.query<{ readonly version: string }>(`
            SELECT version FROM ownware.plugin_versions
            WHERE plugin_id = $1 AND version = $2 FOR UPDATE
          `, [normalized.pluginId, normalized.version])
          if (version.rows[0] === undefined) throw new PluginVersionNotFoundError()
          const appliedAt = new Date().toISOString()
          await client.query(`
            INSERT INTO ownware.plugin_migration_receipts (
              plugin_id, version, migration_id, migration_sha256, applied_at
            ) VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (plugin_id, version, migration_id) DO NOTHING
          `, [
            normalized.pluginId,
            normalized.version,
            normalized.migrationId,
            normalized.migrationSha256,
            appliedAt,
          ])
          const result = await client.query<PluginMigrationRow>(`
            SELECT plugin_id, version, migration_id, migration_sha256, applied_at
            FROM ownware.plugin_migration_receipts
            WHERE plugin_id = $1 AND version = $2 AND migration_id = $3
          `, [normalized.pluginId, normalized.version, normalized.migrationId])
          const row = result.rows[0]
          if (row === undefined || row.migration_sha256 !== normalized.migrationSha256) {
            throw new PluginMigrationConflictError()
          }
          return mapMigration(row)
        }))
    },

    async listMigrations(identityInput) {
      const pluginId = normalizePluginId(identityInput.pluginId)
      const version = normalizePluginVersion(identityInput.version)
      return repositoryCall(context, 'plugins', 'list_migrations', 'read_failed', async client => {
        const result = await client.query<PluginMigrationRow>(`
          SELECT plugin_id, version, migration_id, migration_sha256, applied_at
          FROM ownware.plugin_migration_receipts
          WHERE plugin_id = $1 AND version = $2
          ORDER BY migration_id
        `, [pluginId, version])
        return result.rows.map(mapMigration)
      })
    },
  }
}
