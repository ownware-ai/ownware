import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CortexDatabase } from '../../../src/gateway/db/database.js'
import {
  auditMigrations,
  runMigrationsSafely,
} from '../../../src/gateway/db/migration-safety.js'
import { MIGRATIONS } from '../../../src/gateway/db/schema.js'

let dir = ''

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

describe('migration 073 agent event stream high-water', () => {
  it('seeds existing cursor positions and keeps sequence monotonic after pruning', () => {
    dir = mkdtempSync(join(tmpdir(), 'agent-event-stream-migration-'))
    const path = join(dir, 'ownware.db')
    const old = new Database(path)
    runMigrationsSafely(old, path, MIGRATIONS.filter((migration) => migration.version <= 72))
    old.prepare('INSERT INTO threads (id, profile_id) VALUES (?, ?)')
      .run('thread_existing', 'test')
    const insert = old.prepare(`
      INSERT INTO agent_events (
        thread_id, agent_id, parent_agent_id, seq, type, payload, created_at
      ) VALUES (?, 'root', NULL, ?, 'text.delta', ?, ?)
    `)
    for (let seq = 1; seq <= 3; seq++) {
      insert.run(
        'thread_existing',
        seq,
        JSON.stringify({ type: 'text.delta', text: `before-${seq}`, turnIndex: 0 }),
        seq,
      )
    }
    old.close()

    const upgraded = new CortexDatabase(path)
    expect(upgraded.getAgentEventMaxSeq('thread_existing', 'root')).toBe(3)
    expect(upgraded.pruneAgentEvents('thread_existing')).toBe(3)
    expect(upgraded.getAgentEventMaxSeq('thread_existing', 'root')).toBe(3)
    expect(upgraded.appendAgentEvent({
      threadId: 'thread_existing',
      agentId: 'root',
      parentAgentId: null,
      type: 'text.delta',
      payload: { type: 'text.delta', text: 'after-prune', turnIndex: 0 },
    })).toBe(4)
    expect(upgraded.rawMainHandle.pragma('foreign_key_check')).toEqual([])
    expect(upgraded.rawMainHandle.pragma('integrity_check', { simple: true })).toBe('ok')
    expect(upgraded.rawMainHandle.pragma('user_version', { simple: true }))
      .toBe(MIGRATIONS.at(-1)!.version)
    expect(auditMigrations(MIGRATIONS)).toEqual([])
    upgraded.close()
  })
})
