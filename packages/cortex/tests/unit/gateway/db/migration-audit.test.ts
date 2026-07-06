import { describe, it, expect } from 'vitest'
import type { Migration } from '../../../../src/gateway/db/schema.js'
import { MIGRATIONS } from '../../../../src/gateway/db/schema.js'
import {
  auditMigrations,
  DESTRUCTIVE_AUDIT_BASELINE,
} from '../../../../src/gateway/db/migration-safety.js'

describe('migration destructive-SQL audit (B2)', () => {
  it('the REAL migration set passes — no new unacknowledged destructive migrations', () => {
    // This is the build gate. If it fails, a migration newer than the baseline
    // contains DROP/DELETE/RENAME without a `destructive: { reason }` ack.
    // Fix by rewriting it additively (expand→contract) or acknowledging it.
    expect(auditMigrations(MIGRATIONS)).toEqual([])
  })

  it('flags a NEW destructive migration that is not acknowledged', () => {
    const m: Migration = {
      version: DESTRUCTIVE_AUDIT_BASELINE + 1,
      name: 'evil_drop',
      sql: 'DROP TABLE threads;',
    }
    const findings = auditMigrations([m])
    expect(findings).toHaveLength(1)
    expect(findings[0].matched).toContain('DROP TABLE')
  })

  it('clears a destructive migration once explicitly acknowledged', () => {
    const m: Migration = {
      version: DESTRUCTIVE_AUDIT_BASELINE + 1,
      name: 'verified_rebuild',
      sql: 'DROP TABLE _old_threads_tmp;',
      destructive: { reason: '12-step rebuild — rows copied into threads first' },
    }
    expect(auditMigrations([m])).toEqual([])
  })

  it('grandfathers everything at or below the baseline', () => {
    const m: Migration = {
      version: DESTRUCTIVE_AUDIT_BASELINE,
      name: 'shipped_destructive',
      sql: 'DELETE FROM workspace_tabs;',
    }
    expect(auditMigrations([m])).toEqual([])
  })

  it('does NOT flag a destructive keyword that only appears in a comment', () => {
    const m: Migration = {
      version: DESTRUCTIVE_AUDIT_BASELINE + 1,
      name: 'commented',
      sql: `
        -- DROP TABLE foo;  (we are NOT doing this anymore)
        /* RENAME TO bar was considered and rejected */
        CREATE TABLE foo (id INTEGER PRIMARY KEY);
      `,
    }
    expect(auditMigrations([m])).toEqual([])
  })

  it('does NOT flag an additive new migration', () => {
    const m: Migration = {
      version: DESTRUCTIVE_AUDIT_BASELINE + 1,
      name: 'additive',
      sql: 'ALTER TABLE threads ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;',
    }
    expect(auditMigrations([m])).toEqual([])
  })

  it('catches DROP COLUMN, DELETE FROM, and RENAME variants', () => {
    const base = DESTRUCTIVE_AUDIT_BASELINE
    expect(auditMigrations([{ version: base + 1, name: 'a', sql: 'ALTER TABLE t DROP COLUMN c;' }])).toHaveLength(1)
    expect(auditMigrations([{ version: base + 1, name: 'b', sql: 'DELETE FROM t WHERE x = 1;' }])).toHaveLength(1)
    expect(auditMigrations([{ version: base + 1, name: 'c', sql: 'ALTER TABLE t RENAME TO t2;' }])).toHaveLength(1)
    expect(auditMigrations([{ version: base + 1, name: 'd', sql: 'ALTER TABLE t RENAME COLUMN a TO b;' }])).toHaveLength(1)
  })
})
