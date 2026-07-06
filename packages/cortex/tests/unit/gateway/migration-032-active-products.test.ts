/**
 * Migration #32 — add `workspaces.active_products` (product-base shift
 * Phase 2 · slice-01).
 *
 * Three things must hold:
 *   1. Legacy rows (created before migration 32) backfill to
 *      '["ownware"]' via the column DEFAULT.
 *   2. New rows inserted after the migration with no explicit
 *      `active_products` also receive the default.
 *   3. Writing an explicit value round-trips through SQLite as a
 *      JSON-encoded TEXT column.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { tmpdir } from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { MIGRATIONS } from '../../../src/gateway/db/schema.js'

let tempDir: string
let db: Database.Database

function applyMigrationsThrough(handle: Database.Database, lastVersion: number): void {
  handle.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version     INTEGER     PRIMARY KEY,
      name        TEXT        NOT NULL,
      applied_at  TEXT        NOT NULL DEFAULT (datetime('now'))
    );
  `)
  for (const m of MIGRATIONS) {
    if (m.version > lastVersion) break
    handle.exec(m.sql)
    handle.prepare(
      'INSERT OR IGNORE INTO _migrations (version, name) VALUES (?, ?)',
    ).run(m.version, m.name)
  }
}

function applySingleMigration(handle: Database.Database, version: number): void {
  const m = MIGRATIONS.find((x) => x.version === version)
  if (!m) throw new Error(`Migration ${version} not found`)
  handle.exec(m.sql)
  handle.prepare(
    'INSERT INTO _migrations (version, name) VALUES (?, ?)',
  ).run(m.version, m.name)
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cortex-mig32-test-'))
  db = new Database(join(tempDir, 'test.db'))
  db.exec('PRAGMA foreign_keys = ON')
  applyMigrationsThrough(db, 31)
})

afterEach(async () => {
  db.close()
  await rm(tempDir, { recursive: true, force: true })
})

describe('migration 032 — workspaces.active_products', () => {
  it('backfills legacy rows with the default ["ownware"]', () => {
    db.prepare(
      "INSERT INTO workspaces (id, name, path) VALUES ('w-legacy', 'Legacy', '/legacy')",
    ).run()

    applySingleMigration(db, 32)

    const row = db.prepare(
      "SELECT active_products FROM workspaces WHERE id = 'w-legacy'",
    ).get() as { active_products: string }
    expect(row.active_products).toBe('["ownware"]')
    expect(JSON.parse(row.active_products)).toEqual(['ownware'])
  })

  it('applies the default for new rows inserted post-migration', () => {
    applySingleMigration(db, 32)

    db.prepare(
      "INSERT INTO workspaces (id, name, path) VALUES ('w-new', 'New', '/new')",
    ).run()

    const row = db.prepare(
      "SELECT active_products FROM workspaces WHERE id = 'w-new'",
    ).get() as { active_products: string }
    expect(JSON.parse(row.active_products)).toEqual(['ownware'])
  })

  it('round-trips an explicit multi-product value', () => {
    applySingleMigration(db, 32)

    db.prepare(`
      INSERT INTO workspaces (id, name, path, active_products)
      VALUES ('w-multi', 'Multi', '/multi', ?)
    `).run(JSON.stringify(['ownware', 'ownware-design']))

    const row = db.prepare(
      "SELECT active_products FROM workspaces WHERE id = 'w-multi'",
    ).get() as { active_products: string }
    expect(JSON.parse(row.active_products)).toEqual(['ownware', 'ownware-design'])
  })

  it('survives an UPDATE that replaces the product list', () => {
    applySingleMigration(db, 32)

    db.prepare(
      "INSERT INTO workspaces (id, name, path) VALUES ('w-up', 'Up', '/up')",
    ).run()

    db.prepare(
      'UPDATE workspaces SET active_products = ? WHERE id = ?',
    ).run(JSON.stringify(['ownware', 'ownware-marketing']), 'w-up')

    const row = db.prepare(
      "SELECT active_products FROM workspaces WHERE id = 'w-up'",
    ).get() as { active_products: string }
    expect(JSON.parse(row.active_products)).toEqual(['ownware', 'ownware-marketing'])
  })

  it('keeps the column NOT NULL — direct NULL insert is rejected', () => {
    applySingleMigration(db, 32)

    expect(() => {
      db.prepare(`
        INSERT INTO workspaces (id, name, path, active_products)
        VALUES ('w-null', 'Null', '/null', NULL)
      `).run()
    }).toThrow()
  })
})
