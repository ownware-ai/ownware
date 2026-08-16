import { describe, expect, it } from 'vitest'
import { MIGRATIONS } from '../../../src/gateway/db/schema.js'
import {
  STORAGE_ADAPTER_BASELINE_VERSION,
  STORAGE_LOGICAL_MIGRATIONS,
  assertStorageMigrationAlignment,
} from '../../../src/storage/migration-manifest.js'
import {
  POSTGRESQL_MIGRATION_MANIFEST,
  postgreSqlMigrationFingerprint,
  validatePostgreSqlMigrationHistory,
  validatePostgreSqlMigrationManifest,
  type PostgreSqlMigration,
  type PostgreSqlMigrationManifest,
} from '../../../src/storage/postgresql-migrations.js'
import { POSTGRESQL_BASELINE_DDL_HASH } from '../../../src/storage/postgresql-baseline.js'

const V90: PostgreSqlMigration = {
  version: 90,
  name: '090_fixture',
  sql: 'ALTER TABLE ownware.threads ADD COLUMN fixture TEXT',
  verifyApplied: async () => true,
}

function fixtureManifest(
  migration: PostgreSqlMigration = V90,
): PostgreSqlMigrationManifest {
  return {
    migrations: [...POSTGRESQL_MIGRATION_MANIFEST.migrations, migration],
    logicalMigrations: [...STORAGE_LOGICAL_MIGRATIONS, { version: 90, name: '090_fixture' }],
    verifyCurrentSchema: async () => true,
  }
}

describe('logical storage migration manifests', () => {
  it('keeps the shipped SQLite and PostgreSQL post-baseline identities exact', () => {
    const sqlite = MIGRATIONS
      .filter((migration) => migration.version > STORAGE_ADAPTER_BASELINE_VERSION)
      .map(({ version, name }) => ({ version, name }))
    const postgresql = POSTGRESQL_MIGRATION_MANIFEST.migrations
      .slice(1)
      .map(({ version, name }) => ({ version, name }))

    expect(() => assertStorageMigrationAlignment(
      STORAGE_LOGICAL_MIGRATIONS,
      sqlite,
      postgresql,
    )).not.toThrow()
    expect(sqlite).toEqual(STORAGE_LOGICAL_MIGRATIONS)
    expect(postgresql).toEqual(STORAGE_LOGICAL_MIGRATIONS)
  })

  it('accepts one aligned future identity while keeping dialect SQL separate', () => {
    expect(() => assertStorageMigrationAlignment(
      [...STORAGE_LOGICAL_MIGRATIONS, { version: 90, name: '090_fixture' }],
      [...STORAGE_LOGICAL_MIGRATIONS, { version: 90, name: '090_fixture' }],
      [...STORAGE_LOGICAL_MIGRATIONS, { version: 90, name: '090_fixture' }],
    )).not.toThrow()
    expect(() => validatePostgreSqlMigrationManifest(fixtureManifest())).not.toThrow()
  })

  it.each([
    {
      label: 'missing PostgreSQL entry',
      logical: [{ version: 83, name: '083_fixture' }],
      sqlite: [{ version: 83, name: '083_fixture' }],
      postgresql: [],
    },
    {
      label: 'dialect name disagreement',
      logical: [{ version: 83, name: '083_fixture' }],
      sqlite: [{ version: 83, name: '083_fixture' }],
      postgresql: [{ version: 83, name: '083_other' }],
    },
    {
      label: 'gapped logical version',
      logical: [{ version: 84, name: '084_fixture' }],
      sqlite: [{ version: 84, name: '084_fixture' }],
      postgresql: [{ version: 84, name: '084_fixture' }],
    },
  ])('rejects $label', ({ logical, sqlite, postgresql }) => {
    expect(() => assertStorageMigrationAlignment(logical, sqlite, postgresql))
      .toThrow('Storage')
  })

  it('fingerprints exact dialect SQL and validates an applied prefix', () => {
    const baseline = POSTGRESQL_MIGRATION_MANIFEST.migrations[0]!
    expect(postgreSqlMigrationFingerprint(baseline)).toBe(POSTGRESQL_BASELINE_DDL_HASH)
    expect(validatePostgreSqlMigrationHistory([{
      version: String(baseline.version),
      name: baseline.name,
      fingerprint: postgreSqlMigrationFingerprint(baseline),
    }], fixtureManifest())).toBe(1)
  })

  it('distinguishes a coherent newer head from malformed or gapped history', () => {
    const rows = POSTGRESQL_MIGRATION_MANIFEST.migrations.map((migration) => ({
      version: String(migration.version),
      name: migration.name,
      fingerprint: postgreSqlMigrationFingerprint(migration),
    }))
    expect(() => validatePostgreSqlMigrationHistory([
      ...rows,
      { version: '90', name: '090_newer', fingerprint: `sha256:${'a'.repeat(64)}` },
    ], POSTGRESQL_MIGRATION_MANIFEST)).toThrow(expect.objectContaining({
      code: 'schema_version_newer',
    }))
    expect(() => validatePostgreSqlMigrationHistory([
      ...rows,
      { version: '90', name: '', fingerprint: 'invalid' },
    ], POSTGRESQL_MIGRATION_MANIFEST)).toThrow(expect.objectContaining({
      code: 'schema_history_diverged',
    }))
    expect(() => validatePostgreSqlMigrationHistory([
      ...rows,
      { version: '91', name: '091_gap', fingerprint: `sha256:${'b'.repeat(64)}` },
    ], POSTGRESQL_MIGRATION_MANIFEST)).toThrow(expect.objectContaining({
      code: 'schema_history_diverged',
    }))
  })
})
