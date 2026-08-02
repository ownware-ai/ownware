import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MIGRATIONS } from '../../../../src/gateway/db/schema.js'
import {
  MigrationSafetyError,
  migrationFingerprint,
  runMigrationsSafely,
} from '../../../../src/gateway/db/migration-safety.js'

describe('migration 083 — durable message sequence', () => {
  let dir: string
  let dbPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cortex-migration-083-'))
    dbPath = join(dir, 'ownware.db')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function open(): Database.Database {
    const db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    return db
  }

  it('backfills the prior observable order, preserves every field, and restarts exactly', () => {
    const db = open()
    runMigrationsSafely(db, dbPath, MIGRATIONS.filter(({ version }) => version <= 82))
    db.exec(`
      INSERT INTO threads (id, profile_id, title)
      VALUES ('thread-a', 'profile', 'A'), ('thread-b', 'profile', 'B');

      INSERT INTO messages (
        id, thread_id, role, content, tools, sub_agents, permissions,
        attachments, thinking, usage_input, usage_output, created_at, parts,
        credentials, model, usage_cache_read, usage_cache_creation
      ) VALUES
        (
          'message-z', 'thread-a', 'assistant', 'rich row', '[{"name":"tool"}]',
          '[{"agentId":"child"}]', '[{"requestId":"permission"}]',
          '[{"name":"file.txt"}]', 'thought', 11, 7,
          '2026-08-02T00:00:00.000Z', '[{"kind":"text","text":"rich row"}]',
          '[{"credentialId":"opaque"}]', 'provider:model', 5, 3
        ),
        (
          'message-a', 'thread-a', 'user', 'same timestamp, lower id',
          NULL, NULL, NULL, NULL, NULL, NULL, NULL,
          '2026-08-02T00:00:00.000Z', NULL, NULL, NULL, NULL, NULL
        ),
        (
          'message-b2', 'thread-b', 'assistant', 'later',
          NULL, NULL, NULL, NULL, NULL, 2, 1,
          '2026-08-02T00:00:02.000Z', NULL, NULL, 'provider:other', 0, 0
        ),
        (
          'message-b1', 'thread-b', 'user', 'earlier',
          NULL, NULL, NULL, NULL, NULL, NULL, NULL,
          '2026-08-02T00:00:01.000Z', NULL, NULL, NULL, NULL, NULL
        );
    `)
    const before = db.prepare(`
      SELECT * FROM messages ORDER BY thread_id, created_at, id
    `).all()

    runMigrationsSafely(db, dbPath, MIGRATIONS)

    const afterWithoutSequence = db.prepare(`
      SELECT
        id, thread_id, role, content, tools, sub_agents, permissions,
        attachments, thinking, usage_input, usage_output, created_at, parts,
        credentials, model, usage_cache_read, usage_cache_creation
      FROM messages ORDER BY thread_id, created_at, id
    `).all()
    expect(afterWithoutSequence).toEqual(before)
    expect(db.prepare(`
      SELECT thread_id, id, message_seq FROM messages
      ORDER BY thread_id, message_seq
    `).all()).toEqual([
      { thread_id: 'thread-a', id: 'message-a', message_seq: 1 },
      { thread_id: 'thread-a', id: 'message-z', message_seq: 2 },
      { thread_id: 'thread-b', id: 'message-b1', message_seq: 1 },
      { thread_id: 'thread-b', id: 'message-b2', message_seq: 2 },
    ])

    const migration = MIGRATIONS.find(({ version }) => version === 83)!
    expect(db.prepare(`
      SELECT version, name, fingerprint FROM _migrations WHERE version = 83
    `).get()).toEqual({
      version: 83,
      name: '083_message_sequence',
      fingerprint: migrationFingerprint(migration),
    })
    expect(db.prepare(`
      SELECT "unique" AS is_unique FROM pragma_index_list('messages')
      WHERE name = 'idx_messages_thread_sequence'
    `).get()).toEqual({ is_unique: 1 })
    expect(db.prepare(`
      SELECT name FROM pragma_index_info('idx_messages_thread_sequence') ORDER BY seqno
    `).all()).toEqual([{ name: 'thread_id' }, { name: 'message_seq' }])
    expect(() => db.prepare(`
      UPDATE messages SET message_seq = 0 WHERE id = 'message-a'
    `).run()).toThrow()
    expect(() => db.prepare(`
      UPDATE messages SET message_seq = 9007199254740992 WHERE id = 'message-a'
    `).run()).toThrow()
    expect(() => db.prepare(`
      UPDATE messages SET message_seq = 2 WHERE id = 'message-a'
    `).run()).toThrow()

    const receipt = db.prepare(`
      SELECT version, name, fingerprint FROM _migrations ORDER BY version
    `).all()
    runMigrationsSafely(db, dbPath, MIGRATIONS)
    expect(db.prepare(`
      SELECT version, name, fingerprint FROM _migrations ORDER BY version
    `).all()).toEqual(receipt)
    const changed = MIGRATIONS.map((entry) => entry.version === 83
      ? { ...entry, sql: `${entry.sql}\n-- changed after application` }
      : entry)
    expect(() => runMigrationsSafely(db, dbPath, changed)).toThrow(MigrationSafetyError)
    db.close()
  })

  it('restores the populated v82 snapshot after a failing v83 rebuild, then retries cleanly', () => {
    let db = open()
    const throughV82 = MIGRATIONS.filter(({ version }) => version <= 82)
    runMigrationsSafely(db, dbPath, throughV82)
    db.exec(`
      INSERT INTO threads (id, profile_id, title)
      VALUES ('thread-rollback', 'profile', 'preserve rollback row');
      INSERT INTO messages (id, thread_id, role, content, created_at)
      VALUES (
        'message-rollback', 'thread-rollback', 'user', 'preserve rollback message',
        '2026-08-02T00:00:00.000Z'
      );
    `)
    const migration = MIGRATIONS.find(({ version }) => version === 83)!
    const failing = [
      ...throughV82,
      {
        ...migration,
        sql: `${migration.sql}\nUPDATE messages SET message_seq = 0;`,
      },
    ]

    expect(() => runMigrationsSafely(db, dbPath, failing)).toThrow(MigrationSafetyError)
    db = open()
    expect(db.pragma('user_version', { simple: true })).toBe(82)
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM pragma_table_info('messages')
      WHERE name = 'message_seq'
    `).get()).toEqual({ count: 0 })
    expect(db.prepare(`
      SELECT content FROM messages WHERE id = 'message-rollback'
    `).get()).toEqual({ content: 'preserve rollback message' })
    expect(db.prepare(`SELECT MAX(version) AS version FROM _migrations`).get())
      .toEqual({ version: 82 })

    runMigrationsSafely(db, dbPath, MIGRATIONS)
    expect(db.prepare(`
      SELECT id, message_seq FROM messages WHERE thread_id = 'thread-rollback'
    `).get()).toEqual({ id: 'message-rollback', message_seq: 1 })
    db.close()
  })
})
