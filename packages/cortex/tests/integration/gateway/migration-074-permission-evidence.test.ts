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

describe('migration 074 permission evidence redaction', () => {
  it('removes historical raw inputs and denial context from events and messages', () => {
    dir = mkdtempSync(join(tmpdir(), 'permission-evidence-migration-'))
    const path = join(dir, 'ownware.db')
    const old = new Database(path)
    runMigrationsSafely(old, path, MIGRATIONS.filter((migration) => migration.version <= 73))
    old.prepare('INSERT INTO threads (id, profile_id) VALUES (?, ?)')
      .run('thread_existing', 'test')

    const inputCanary = 'historical-private-input-canary'
    const contextCanary = 'historical-private-context-canary'
    const insertEvent = old.prepare(`
      INSERT INTO agent_events (
        thread_id, agent_id, parent_agent_id, seq, type, payload, created_at
      ) VALUES ('thread_existing', 'root', NULL, ?, ?, ?, ?)
    `)
    insertEvent.run(1, 'permission.request', JSON.stringify({
      type: 'permission.request',
      requestId: 'req_legacy',
      toolName: 'send_email',
      input: { body: inputCanary, recipient: 'synthetic@example.test' },
      reason: contextCanary,
      explanation: contextCanary,
      severityReason: contextCanary,
      turnIndex: 0,
      operationHash: 'a'.repeat(64),
      zoneLevel: 4,
      zoneName: 'external',
      severityTag: 'warn',
    }), 1)
    insertEvent.run(2, 'permission.response', JSON.stringify({
      type: 'permission.response',
      requestId: 'req_legacy',
      granted: false,
      turnIndex: 0,
      reason: {
        type: 'user-denied',
        toolName: 'send_email',
        toolInput: { body: inputCanary },
        note: contextCanary,
      },
    }), 2)
    old.prepare(`
      INSERT INTO messages (id, thread_id, role, content, permissions)
      VALUES (?, ?, 'assistant', '', ?)
    `).run('message_existing', 'thread_existing', JSON.stringify([{
      requestId: 'req_legacy',
      toolName: 'send_email',
      input: { body: inputCanary, recipient: 'synthetic@example.test' },
      reason: contextCanary,
      decision: 'denied',
      explanation: contextCanary,
      severityReason: contextCanary,
      severityTag: 'warn',
    }]))
    old.close()

    const upgraded = new CortexDatabase(path)
    const migratedEvents = upgraded.listAgentEvents({
      threadId: 'thread_existing',
      agentId: 'root',
    })
    const persisted = JSON.stringify(migratedEvents)
    const messages = JSON.stringify(upgraded.getMessages('thread_existing'))
    for (const surface of [persisted, messages]) {
      expect(surface).not.toContain(inputCanary)
      expect(surface).not.toContain(contextCanary)
      expect(surface).toContain('2 input fields')
    }
    expect(migratedEvents.find((event) => event.type === 'permission.response')?.payload)
      .toMatchObject({ granted: false })
    expect(upgraded.rawMainHandle.pragma('foreign_key_check')).toEqual([])
    expect(upgraded.rawMainHandle.pragma('integrity_check', { simple: true })).toBe('ok')
    expect(upgraded.rawMainHandle.pragma('user_version', { simple: true }))
      .toBe(MIGRATIONS.at(-1)!.version)
    expect(auditMigrations(MIGRATIONS)).toEqual([])
    upgraded.close()
  })
})
