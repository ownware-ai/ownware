/**
 * Unit tests for the gateway Foundation layer.
 *
 * Tests migration 004, body size limit, param guard, auth middleware,
 * encrypt/decrypt, and all new CRUD methods.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { CortexDatabase, encryptValue, decryptValue, generateEncryptionKey } from '../../../src/gateway/db/database.js'
import { validateParams } from '../../../src/gateway/middleware/param-guard.js'
import { generateSessionToken, createAuthMiddleware } from '../../../src/gateway/middleware/auth.js'
import { readBody, RequestError } from '../../../src/gateway/router.js'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  CreateThreadSchema,
  CreateWorkspaceSchema,
  CreateLocalProfileSchema,
  SetSettingSchema,
  SetProviderKeySchema,
  SetProfileMetadataSchema,
  SetAppStateSchema,
} from '../../../src/gateway/validation/schemas.js'

// ---------------------------------------------------------------------------
// Database test helpers
// ---------------------------------------------------------------------------

let db: CortexDatabase
let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cortex-foundation-test-'))
  db = new CortexDatabase(join(tempDir, 'test.db'))
})

afterEach(async () => {
  db.close()
  await rm(tempDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Migration 004
// ---------------------------------------------------------------------------

describe('migration 004', () => {
  it('creates the migration-004 tables that still exist post-025', () => {
    // The DB is already migrated via constructor — verify tables exist.
    // `workspace_tabs` was dropped by migration 025 (replaced by
    // `workspace_panes`); pane coverage lives elsewhere, so it is
    // excluded from this list. `provider_keys` was a planned table
    // listed in the original test but was never actually emitted by
    // migration 004 (see `src/gateway/db/schema.ts` migration 004 body —
    // only six tables are created); LLM credentials live in the unified
    // `credentials` table (migration 014) today, so it is excluded too.
    const tables = ['local_profile', 'user_settings',
      'profile_metadata', 'app_state', 'audit_log']

    for (const table of tables) {
      const row = (db as any).db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
      ).get(table)
      expect(row, `table ${table} should exist`).toBeTruthy()
    }
  })

  it('adds duration_ms and success columns to usage_records', () => {
    const cols = (db as any).db.prepare(
      `PRAGMA table_info(usage_records)`,
    ).all() as { name: string }[]
    const colNames = cols.map((c: { name: string }) => c.name)
    expect(colNames).toContain('duration_ms')
    expect(colNames).toContain('success')
  })

  it('adds last_message_preview column to threads', () => {
    const cols = (db as any).db.prepare(
      `PRAGMA table_info(threads)`,
    ).all() as { name: string }[]
    const colNames = cols.map((c: { name: string }) => c.name)
    expect(colNames).toContain('last_message_preview')
  })

  it('creates the migration-004 indexes that still exist post-025', () => {
    // `idx_workspace_tabs_ws` was dropped alongside `workspace_tabs` in
    // migration 025; pane indexes live with the pane substrate
    // (migration 024) and aren't covered here.
    const indexes = ['idx_usage_date', 'idx_usage_profile_date',
      'idx_mcp_servers_name', 'idx_profile_meta_category']

    for (const idx of indexes) {
      const row = (db as any).db.prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND name=?`,
      ).get(idx)
      expect(row, `index ${idx} should exist`).toBeTruthy()
    }
  })

  it('is idempotent — re-running constructor does not error', () => {
    // Create a second database on the same file — migrations should be skipped
    const db2 = new CortexDatabase(join(tempDir, 'test.db'))
    expect(db2).toBeTruthy()
    db2.close()
  })

  it('records migration version 4 in _migrations', () => {
    const row = (db as any).db.prepare(
      'SELECT version FROM _migrations WHERE version = 4',
    ).get() as { version: number } | undefined
    expect(row).toBeTruthy()
    expect(row!.version).toBe(4)
  })
})

// ---------------------------------------------------------------------------
// Local Profile CRUD
// ---------------------------------------------------------------------------

describe('local_profile CRUD', () => {
  it('creates and retrieves a local profile', () => {
    const profile = db.createLocalProfile('Alice')
    expect(profile.id).toMatch(/^lp_/)
    expect(profile.displayName).toBe('Alice')
    expect(profile.avatarUrl).toBeNull()

    const retrieved = db.getLocalProfile()
    expect(retrieved).toBeTruthy()
    expect(retrieved!.displayName).toBe('Alice')
  })

  it('updates a local profile', () => {
    const profile = db.createLocalProfile('Bob')
    const updated = db.updateLocalProfile(profile.id, { displayName: 'Robert' })
    expect(updated).toBeTruthy()
    expect(updated!.displayName).toBe('Robert')
  })

  it('returns undefined for non-existent update', () => {
    const result = db.updateLocalProfile('nonexistent', { displayName: 'X' })
    expect(result).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// User Settings CRUD
// ---------------------------------------------------------------------------

describe('user_settings CRUD', () => {
  it('sets and gets a setting', () => {
    const setting = db.setSetting('theme', 'dark')
    expect(setting.key).toBe('theme')
    expect(setting.value).toBe('dark')

    const retrieved = db.getSetting('theme')
    expect(retrieved).toBeTruthy()
    expect(retrieved!.value).toBe('dark')
  })

  it('upserts on conflict', () => {
    db.setSetting('theme', 'dark')
    db.setSetting('theme', 'light')
    const retrieved = db.getSetting('theme')
    expect(retrieved!.value).toBe('light')
  })

  it('lists all settings', () => {
    db.setSetting('theme', 'dark')
    db.setSetting('fontSize', '14')
    const all = db.getAllSettings()
    expect(all.length).toBe(2)
  })

  it('deletes a setting', () => {
    db.setSetting('theme', 'dark')
    expect(db.deleteSetting('theme')).toBe(true)
    expect(db.getSetting('theme')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Profile Metadata CRUD
// ---------------------------------------------------------------------------

describe('profile_metadata CRUD', () => {
  it('sets and gets profile metadata', () => {
    const meta = db.setProfileMetadata('coder', { icon: 'code', color: '#ff0000', category: 'development' })
    expect(meta.profileId).toBe('coder')
    expect(meta.icon).toBe('code')
    expect(meta.color).toBe('#ff0000')
    expect(meta.category).toBe('development')
  })

  it('upserts on profile_id conflict', () => {
    db.setProfileMetadata('coder', { icon: 'code' })
    db.setProfileMetadata('coder', { color: '#00ff00' })
    const meta = db.getProfileMetadata('coder')
    expect(meta!.icon).toBe('code') // preserved from first
    expect(meta!.color).toBe('#00ff00') // updated
  })

  it('lists all profile metadata', () => {
    db.setProfileMetadata('coder', { icon: 'code' })
    db.setProfileMetadata('writer', { icon: 'pen' })
    const all = db.listProfileMetadata()
    expect(all.length).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Workspace Tabs CRUD — removed (migration 025 dropped the table, replaced by
// `workspace_panes`). Pane coverage lives in tests/unit/gateway/pane-events.test.ts
// and friends; this file's tab scope no longer exists.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// App State CRUD
// ---------------------------------------------------------------------------

describe('app_state CRUD', () => {
  it('sets and gets app state', () => {
    const state = db.setAppState('last_workspace', 'ws_123')
    expect(state.key).toBe('last_workspace')
    expect(state.value).toBe('ws_123')
  })

  it('upserts on key conflict', () => {
    db.setAppState('last_workspace', 'ws_1')
    db.setAppState('last_workspace', 'ws_2')
    expect(db.getAppState('last_workspace')!.value).toBe('ws_2')
  })

  it('deletes app state', () => {
    db.setAppState('key', 'val')
    expect(db.deleteAppState('key')).toBe(true)
    expect(db.getAppState('key')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Audit Log
// ---------------------------------------------------------------------------

describe('audit_log', () => {
  it('adds and lists audit entries', () => {
    db.addAuditLog({ action: 'create', entityType: 'thread', entityId: 'thread_1' })
    db.addAuditLog({ action: 'delete', entityType: 'workspace', entityId: 'ws_1', detail: 'user initiated' })
    const logs = db.listAuditLog()
    expect(logs.length).toBe(2)
    const actions = logs.map(l => l.action).sort()
    expect(actions).toEqual(['create', 'delete'])
  })

  it('respects limit parameter', () => {
    for (let i = 0; i < 5; i++) {
      db.addAuditLog({ action: 'test', entityType: 'x' })
    }
    expect(db.listAuditLog(2).length).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Updated addUsageRecord (duration_ms, success)
// ---------------------------------------------------------------------------

describe('addUsageRecord with new fields', () => {
  it('stores duration_ms and success', () => {
    db.addUsageRecord({
      profileId: 'coder',
      model: 'claude-sonnet-4-20250514',
      provider: 'anthropic',
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.01,
      durationMs: 1500,
      success: true,
    })

    const row = (db as any).db.prepare(
      'SELECT duration_ms, success FROM usage_records LIMIT 1',
    ).get() as { duration_ms: number; success: number }
    expect(row.duration_ms).toBe(1500)
    expect(row.success).toBe(1)
  })

  it('defaults success to 1 when not specified', () => {
    db.addUsageRecord({
      profileId: 'coder',
      model: 'test',
      provider: 'test',
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.001,
    })

    const row = (db as any).db.prepare(
      'SELECT success FROM usage_records LIMIT 1',
    ).get() as { success: number }
    expect(row.success).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Updated addMessage (last_message_preview)
// ---------------------------------------------------------------------------

describe('addMessage updates last_message_preview', () => {
  it('sets thread last_message_preview on message add', () => {
    const thread = db.createThread('coder')
    expect(thread.lastMessagePreview).toBeNull()

    db.addMessage(thread.id, {
      id: 'msg_test1',
      role: 'user',
      content: 'Hello world',
      timestamp: new Date().toISOString(),
    })

    const updated = db.getThread(thread.id)
    expect(updated!.lastMessagePreview).toBe('Hello world')
  })

  it('truncates preview to 200 chars', () => {
    const thread = db.createThread('coder')
    const longContent = 'x'.repeat(300)

    db.addMessage(thread.id, {
      id: 'msg_long',
      role: 'assistant',
      content: longContent,
      timestamp: new Date().toISOString(),
    })

    const updated = db.getThread(thread.id)
    expect(updated!.lastMessagePreview!.length).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// Encrypt/Decrypt round-trip
// ---------------------------------------------------------------------------

describe('encrypt/decrypt helpers', () => {
  it('round-trips a secret', () => {
    const key = generateEncryptionKey()
    const secret = 'sk-ant-api-key-12345'
    const { encrypted, iv, authTag } = encryptValue(secret, key)
    const decrypted = decryptValue(encrypted, iv, authTag, key)
    expect(decrypted).toBe(secret)
  })

  it('fails with wrong key', () => {
    const key1 = generateEncryptionKey()
    const key2 = generateEncryptionKey()
    const { encrypted, iv, authTag } = encryptValue('secret', key1)
    expect(() => decryptValue(encrypted, iv, authTag, key2)).toThrow()
  })

  it('fails with tampered auth tag', () => {
    const key = generateEncryptionKey()
    const { encrypted, iv } = encryptValue('secret', key)
    expect(() => decryptValue(encrypted, iv, 'deadbeef'.repeat(4), key)).toThrow()
  })

  it('generates a 32-byte key', () => {
    const key = generateEncryptionKey()
    expect(key.length).toBe(32)
  })
})

// ---------------------------------------------------------------------------
// Body size limit (readBody)
// ---------------------------------------------------------------------------

describe('readBody size limit', () => {
  function createMockRequest(body: string): IncomingMessage {
    const readable = new Readable({
      read() {
        this.push(Buffer.from(body))
        this.push(null)
      },
    })
    return readable as unknown as IncomingMessage
  }

  it('reads a normal body', async () => {
    const result = await readBody(createMockRequest('{"hello":"world"}'))
    expect(result).toBe('{"hello":"world"}')
  })

  it('rejects body exceeding 10MB', async () => {
    // Create a stream that pushes >10MB
    const readable = new Readable({
      read() {
        // Push 11MB in one chunk
        this.push(Buffer.alloc(11 * 1024 * 1024, 'x'))
        this.push(null)
      },
    })

    await expect(readBody(readable as unknown as IncomingMessage)).rejects.toThrow(RequestError)
    await expect(readBody(createMockRequest('')).catch(() => null)).resolves.toBeDefined() // reset
  })
})

// ---------------------------------------------------------------------------
// Param guard
// ---------------------------------------------------------------------------

describe('validateParams', () => {
  it('allows safe params', () => {
    expect(() => validateParams({ id: 'profile-name_v2' })).not.toThrow()
    expect(() => validateParams({ id: 'thread_abc123' })).not.toThrow()
    expect(() => validateParams({ id: 'ws_12345' })).not.toThrow()
  })

  it('rejects path traversal (..)', () => {
    expect(() => validateParams({ id: '../etc/passwd' })).toThrow(RequestError)
  })

  it('rejects encoded path traversal (%2e%2e)', () => {
    expect(() => validateParams({ id: '%2e%2e/etc' })).toThrow(RequestError)
  })

  it('rejects semicolon injection', () => {
    expect(() => validateParams({ id: 'foo;bar' })).toThrow(RequestError)
  })

  it('rejects pipe injection', () => {
    expect(() => validateParams({ id: 'foo|bar' })).toThrow(RequestError)
  })

  it('rejects backtick injection', () => {
    expect(() => validateParams({ id: 'foo`id`' })).toThrow(RequestError)
  })
})

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

describe('auth middleware', () => {
  function createMockReq(url: string, method: string = 'GET', authHeader?: string): IncomingMessage {
    return {
      url,
      method,
      headers: {
        host: 'localhost:3011',
        ...(authHeader ? { authorization: authHeader } : {}),
      },
    } as unknown as IncomingMessage
  }

  function createMockRes(): { res: ServerResponse; status: number | null; body: string } {
    const state = { status: null as number | null, body: '' }
    const res = {
      writeHead: vi.fn((status: number) => { state.status = status }),
      end: vi.fn((body?: string) => { state.body = body ?? '' }),
      setHeader: vi.fn(),
    } as unknown as ServerResponse
    return { res, ...state }
  }

  it('generates a 64-char hex token', () => {
    const token = generateSessionToken()
    expect(token).toMatch(/^[a-f0-9]{64}$/)
  })

  it('rejects request without token', () => {
    const token = generateSessionToken()
    const middleware = createAuthMiddleware(token)
    const req = createMockReq('/api/v1/profiles')
    const { res } = createMockRes()

    const result = middleware(req, res)
    expect(result).toBe(false)
  })

  it('rejects request with wrong token', () => {
    const token = generateSessionToken()
    const middleware = createAuthMiddleware(token)
    const req = createMockReq('/api/v1/profiles', 'GET', 'Bearer wrong-token')
    const { res } = createMockRes()

    const result = middleware(req, res)
    expect(result).toBe(false)
  })

  it('allows request with correct token', () => {
    const token = generateSessionToken()
    const middleware = createAuthMiddleware(token)
    const req = createMockReq('/api/v1/profiles', 'GET', `Bearer ${token}`)
    const { res } = createMockRes()

    const result = middleware(req, res)
    expect(result).toBe(true)
  })

  it('skips auth for /api/v1/health', () => {
    const token = generateSessionToken()
    const middleware = createAuthMiddleware(token)
    const req = createMockReq('/api/v1/health')
    const { res } = createMockRes()

    const result = middleware(req, res)
    expect(result).toBe(true)
  })

  it('skips auth for OPTIONS (CORS preflight)', () => {
    const token = generateSessionToken()
    const middleware = createAuthMiddleware(token)
    const req = createMockReq('/api/v1/profiles', 'OPTIONS')
    const { res } = createMockRes()

    const result = middleware(req, res)
    expect(result).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

describe('Zod validation schemas', () => {
  it('CreateThreadSchema: valid input passes', () => {
    const result = CreateThreadSchema.safeParse({ profileId: 'coder' })
    expect(result.success).toBe(true)
  })

  it('CreateThreadSchema: missing profileId fails', () => {
    const result = CreateThreadSchema.safeParse({})
    expect(result.success).toBe(false)
  })

  it('CreateWorkspaceSchema: valid input passes', () => {
    const result = CreateWorkspaceSchema.safeParse({ path: '/home/user/project' })
    expect(result.success).toBe(true)
  })

  // RunRequestSchema tests removed — the run body is validated by the run
  // handler's own strict schema (handlers/run.ts) and covered by the run
  // handler integration tests; the drifted duplicate export was deleted.

  it('CreateLocalProfileSchema: valid input passes', () => {
    const result = CreateLocalProfileSchema.safeParse({ displayName: 'Alice' })
    expect(result.success).toBe(true)
  })

  it('SetSettingSchema: valid input passes', () => {
    const result = SetSettingSchema.safeParse({ key: 'theme', value: 'dark' })
    expect(result.success).toBe(true)
  })

  it('SetProviderKeySchema: empty apiKey fails', () => {
    const result = SetProviderKeySchema.safeParse({ providerId: 'anthropic', apiKey: '' })
    expect(result.success).toBe(false)
  })

  it('SetProfileMetadataSchema: allows null values', () => {
    const result = SetProfileMetadataSchema.safeParse({ icon: null, color: null })
    expect(result.success).toBe(true)
  })

  // CreateWorkspaceTabSchema tests removed alongside `workspace_tabs`
  // (migration 025). The schema was deleted from
  // `src/gateway/validation/schemas.ts`; pane-create validation lives
  // with the pane handler tests, not here.

  it('SetAppStateSchema: valid input passes', () => {
    const result = SetAppStateSchema.safeParse({ key: 'test', value: 'val' })
    expect(result.success).toBe(true)
  })

  it('rejects unknown keys (strict mode)', () => {
    const result = CreateThreadSchema.safeParse({ profileId: 'x', unknown: 'field' })
    expect(result.success).toBe(false)
  })
})
