/**
 * Message row <-> CredentialRecord round-trip.
 *
 * Migration 013 added a `credentials` JSON column to the `messages`
 * table so a hydrated thread can rebuild the full CredentialChatItem
 * on refresh (same visual as live SSE). This suite pins:
 *
 *   - The column exists post-migration (no schema drift).
 *   - addMessage → getMessages round-trips every CredentialRecord
 *     field, across all three decision states.
 *   - A mixed row (tools + permissions + credentials) round-trips
 *     independently — the new column does not collide with existing
 *     JSON columns.
 *   - A row written without credentials stays `undefined` on read
 *     (back-compat for every pre-013 assistant turn).
 *   - parts entries `{kind:'credential', requestId}` round-trip.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { CortexDatabase } from '../../../src/gateway/db/database.js'
import type { ThreadMessage, CredentialRecord } from '../../../src/gateway/types.js'

let db: CortexDatabase
let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cortex-cred-msg-'))
  db = new CortexDatabase(join(tempDir, 'test.db'))
})

afterEach(async () => {
  db.close()
  await rm(tempDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seedThread(): string {
  const t = db.createThread('coder', 'cred round-trip')
  return t.id
}

function baseAssistant(overrides: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    id: `msg_${Math.random().toString(36).slice(2, 14)}`,
    role: 'assistant',
    content: '',
    timestamp: new Date().toISOString(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

describe('migration 013 (messages.credentials)', () => {
  it('adds a `credentials` column to the messages table', () => {
    const cols = (db as unknown as { db: { prepare: (sql: string) => { all: () => { name: string }[] } } })
      .db.prepare(`PRAGMA table_info(messages)`)
      .all() as { name: string }[]
    const names = cols.map(c => c.name)
    expect(names).toContain('credentials')
  })
})

// ---------------------------------------------------------------------------
// Round-trip
// ---------------------------------------------------------------------------

describe('addMessage / getMessages with credentials', () => {
  it('round-trips a single stored credential with every field preserved', () => {
    const threadId = seedThread()
    const cred: CredentialRecord = {
      requestId: 'req-stored-1',
      label: 'Admin JWT',
      hint: 'DevTools > localStorage > token',
      usage: 'Call the admin API',
      placement: { type: 'bearer' },
      isRequired: true,
      decision: 'stored',
      credentialId: 'runtime.thread_x.ADMIN_JWT',
    }
    db.addMessage(threadId, baseAssistant({
      credentials: [cred],
      parts: [{ kind: 'credential', requestId: cred.requestId }],
    }))
    const rows = db.getMessages(threadId)
    const assistant = rows.find(r => r.role === 'assistant')!
    expect(assistant.credentials).toEqual([cred])
    expect(assistant.parts).toEqual([{ kind: 'credential', requestId: cred.requestId }])
  })

  it('round-trips denied and pending records without credentialId', () => {
    const threadId = seedThread()
    const denied: CredentialRecord = {
      requestId: 'req-denied',
      label: 'API Key',
      hint: 'skipped',
      usage: 'skipped',
      placement: { type: 'env', variableName: 'API_KEY' },
      isRequired: false,
      decision: 'denied',
    }
    const pending: CredentialRecord = {
      requestId: 'req-pending',
      label: 'Session cookie',
      hint: '',
      usage: 'call /admin',
      placement: { type: 'cookie', name: 'sid' },
      isRequired: true,
      decision: 'pending',
    }
    db.addMessage(threadId, baseAssistant({
      credentials: [denied, pending],
      parts: [
        { kind: 'credential', requestId: denied.requestId },
        { kind: 'credential', requestId: pending.requestId },
      ],
    }))
    const rows = db.getMessages(threadId)
    const assistant = rows.find(r => r.role === 'assistant')!
    expect(assistant.credentials).toEqual([denied, pending])
    expect(assistant.credentials?.[0]!.credentialId).toBeUndefined()
    expect(assistant.credentials?.[1]!.credentialId).toBeUndefined()
  })

  it('preserves every placement variant', () => {
    const threadId = seedThread()
    const placements: CredentialRecord['placement'][] = [
      { type: 'env', variableName: 'A' },
      { type: 'bearer' },
      { type: 'header', name: 'X-Api' },
      { type: 'cookie', name: 'sid' },
      { type: 'body', fieldPath: 'auth.token' },
      { type: 'query', paramName: 'key' },
      { type: 'basic', usernameCredentialId: 'runtime.u' },
    ]
    const creds: CredentialRecord[] = placements.map((p, i) => ({
      requestId: `req-${i}`,
      label: `label ${i}`,
      hint: '',
      usage: '',
      placement: p,
      isRequired: false,
      decision: 'pending',
    }))
    db.addMessage(threadId, baseAssistant({ credentials: creds }))
    const rows = db.getMessages(threadId)
    expect(rows.find(r => r.role === 'assistant')!.credentials).toEqual(creds)
  })

  it('co-exists with tools and permissions on the same row', () => {
    const threadId = seedThread()
    const msg = baseAssistant({
      content: 'ok',
      tools: [{ toolCallId: 't1', name: 'request_credential', input: { label: 'K' }, isError: false, durationMs: 1, output: 'ok' }],
      permissions: [{ requestId: 'p1', toolName: 'shell', input: {}, reason: 'r', decision: 'approved' }],
      credentials: [{
        requestId: 'c1',
        label: 'K',
        hint: '',
        usage: '',
        placement: { type: 'env', variableName: 'K' },
        isRequired: false,
        decision: 'stored',
        credentialId: 'runtime.thread_x.K',
      }],
      parts: [
        { kind: 'text', text: 'ok' },
        { kind: 'tool', toolCallId: 't1' },
        { kind: 'permission', requestId: 'p1' },
        { kind: 'credential', requestId: 'c1' },
      ],
    })
    db.addMessage(threadId, msg)
    const assistant = db.getMessages(threadId).find(r => r.role === 'assistant')!
    expect(assistant.tools).toEqual(msg.tools)
    expect(assistant.permissions).toEqual(msg.permissions)
    expect(assistant.credentials).toEqual(msg.credentials)
    expect(assistant.parts).toEqual(msg.parts)
  })

  it('leaves credentials undefined on a row that never had any', () => {
    const threadId = seedThread()
    db.addMessage(threadId, baseAssistant({ content: 'hi' }))
    const assistant = db.getMessages(threadId).find(r => r.role === 'assistant')!
    expect(assistant.credentials).toBeUndefined()
  })
})
