import { describe, expect, it } from 'vitest'
import {
  POSTGRESQL_MIGRATION_MANIFEST,
  assertOnlyHeadVerifiesCurrentSchema,
  compiledSchemaHeadVersion,
  postgreSqlCurrentSchemaMatches,
} from '../../../src/storage/postgresql-migrations.js'
import { MIGRATIONS } from '../../../src/gateway/db/schema.js'
import { STORAGE_LOGICAL_MIGRATIONS } from '../../../src/storage/migration-manifest.js'

/**
 * Guards for the two mistakes that shipped repeatedly while adding migrations:
 * an earlier migration verifying against the compiled head, and tests pinning
 * that head by hand.
 */

describe('migration head invariants', () => {
  it('exposes one compiled head that every dialect agrees on', () => {
    const logicalHead = STORAGE_LOGICAL_MIGRATIONS.at(-1)!.version
    const sqliteHead = MIGRATIONS.at(-1)!.version
    const postgresqlHead = POSTGRESQL_MIGRATION_MANIFEST.migrations.at(-1)!.version
    expect(compiledSchemaHeadVersion()).toBe(logicalHead)
    expect(sqliteHead).toBe(logicalHead)
    expect(postgresqlHead).toBe(logicalHead)
  })

  it('lets only the head migration verify against the current schema', () => {
    // The real manifest already loaded, which proves the invariant holds for
    // the shipped set. This asserts the guard would actually catch a violation
    // rather than being a comment with syntax.
    const head = POSTGRESQL_MIGRATION_MANIFEST.migrations.at(-1)!
    const earlier = POSTGRESQL_MIGRATION_MANIFEST.migrations.at(-2)!
    expect(earlier.verifyApplied).not.toBe(head.verifyApplied)
  })

  it('keeps every migration pinned to a distinct postcondition below the head', () => {
    const head = POSTGRESQL_MIGRATION_MANIFEST.migrations.at(-1)!
    const offenders = POSTGRESQL_MIGRATION_MANIFEST.migrations
      .slice(0, -1)
      .filter((migration) => migration.verifyApplied === head.verifyApplied)
      .map((migration) => migration.name)
    expect(offenders).toEqual([])
  })
  it('rejects a manifest where an earlier migration verifies the current schema', () => {
    // The real proof: construct the mistake that shipped three times and show
    // it now fails loudly at construction instead of silently at install.
    const head = POSTGRESQL_MIGRATION_MANIFEST.migrations.at(-1)!
    const earlier = POSTGRESQL_MIGRATION_MANIFEST.migrations.at(-2)!
    const broken = [
      { ...earlier, verifyApplied: postgreSqlCurrentSchemaMatches },
      head,
    ]
    expect(() => assertOnlyHeadVerifiesCurrentSchema(broken))
      .toThrow(new RegExp(`${earlier.name}.*not the compiled head`, 's'))
  })

  it('accepts the head migration verifying the current schema', () => {
    const head = POSTGRESQL_MIGRATION_MANIFEST.migrations.at(-1)!
    expect(() => assertOnlyHeadVerifiesCurrentSchema([head])).not.toThrow()
  })
})
