/**
 * Unit tests — DbCredentialBackend.
 *
 * Runs the shared `runBackendContract` harness exported from
 * `store-contract.test.ts` against the real SQLite-backed backend.
 * Plus a small set of backend-specific tests that the harness can't
 * know about:
 *
 *   - Encryption is real AES-GCM via the master key (decrypt round-
 *     trips; the on-disk payload is NOT plaintext).
 *   - Migration 015 schema actually creates the columns the backend
 *     expects.
 *   - The backend handles a master-key cache reset between calls
 *     (paranoia check — if the file vault rotates the cached key,
 *     existing rows still decrypt because `getMasterKey` hits the
 *     persisted file, not the cache).
 *
 * Test isolation:
 *   - Each test gets a fresh `:memory:` SQLite (fast; no FS).
 *   - HOME is repointed at a tmp dir per test so the master key file
 *     lands somewhere disposable. `__resetMasterKeyCacheForTests()`
 *     drops the in-process cache so the new HOME is honoured.
 */

import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest'
import { DbCredentialBackend } from '../../../src/credential/store/db-backend.js'
import { __resetMasterKeyCacheForTests } from '../../../src/connector/credentials/vault.js'
import { MIGRATIONS } from '../../../src/gateway/db/schema.js'
import { runBackendContract, llmInput } from './store-contract.test.js'

// ---------------------------------------------------------------------------
// Test environment helpers
// ---------------------------------------------------------------------------

let prevHome: string | undefined
let tmpHome: string

function setupHome(): void {
  prevHome = process.env['HOME']
  tmpHome = mkdtempSync(join(tmpdir(), 'cortex-cred-db-'))
  process.env['HOME'] = tmpHome
  __resetMasterKeyCacheForTests()
}

function teardownHome(): void {
  if (prevHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = prevHome
  __resetMasterKeyCacheForTests()
  try { rmSync(tmpHome, { recursive: true, force: true }) } catch { /* best-effort */ }
}

/**
 * Build a fresh in-memory SQLite with every migration applied. Cheap
 * (sub-ms) so we use a new DB per test rather than cleaning up rows.
 */
function makeFreshDb(): Database.Database {
  const db = new Database(':memory:')
  for (const migration of MIGRATIONS) {
    db.exec(migration.sql)
  }
  return db
}

// ---------------------------------------------------------------------------
// Run the shared contract harness
// ---------------------------------------------------------------------------

describe('DbCredentialBackend — contract', () => {
  beforeEach(() => { setupHome() })
  afterEach(() => { teardownHome() })

  runBackendContract(() => new DbCredentialBackend(makeFreshDb()))
})

// ---------------------------------------------------------------------------
// Backend-specific tests
// ---------------------------------------------------------------------------

describe('DbCredentialBackend — encryption', () => {
  let db: Database.Database
  let backend: DbCredentialBackend

  beforeEach(() => {
    setupHome()
    db = makeFreshDb()
    backend = new DbCredentialBackend(db)
  })
  afterEach(() => {
    db.close()
    teardownHome()
  })

  it('stores ciphertext, never plaintext, in encrypted_value', async () => {
    const value = 'sk-ant-PLAINTEXT-CHECK-ON-DISK-99999'
    const cred = await backend.save(llmInput({ value }))
    const row = db
      .prepare('SELECT encrypted_value FROM credentials WHERE id = ?')
      .get(cred.id) as { encrypted_value: string }
    expect(row.encrypted_value).not.toContain(value)
    expect(row.encrypted_value).toMatch(/^v2:[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/)
  })

  it('round-trips the value through decrypt()', async () => {
    const value = 'sk-ant-XXXXXXXX-HM8A'
    const cred = await backend.save(llmInput({ value }))
    const decrypted = await backend.decrypt(cred.id)
    expect(decrypted?.value).toBe(value)
  })

  it('rotates the ciphertext when value is updated', async () => {
    const cred = await backend.save(llmInput({ value: 'old-value-AAAA' }))
    const before = db
      .prepare('SELECT encrypted_value FROM credentials WHERE id = ?')
      .get(cred.id) as { encrypted_value: string }
    await backend.update(cred.id, { value: 'new-value-BBBB' })
    const after = db
      .prepare('SELECT encrypted_value FROM credentials WHERE id = ?')
      .get(cred.id) as { encrypted_value: string }
    expect(after.encrypted_value).not.toBe(before.encrypted_value)
    const decrypted = await backend.decrypt(cred.id)
    expect(decrypted?.value).toBe('new-value-BBBB')
  })

  it('survives a master-key cache reset (decrypt re-reads the file)', async () => {
    const value = 'sk-ant-CACHE-RESET-CHECK'
    const cred = await backend.save(llmInput({ value }))
    __resetMasterKeyCacheForTests()
    const decrypted = await backend.decrypt(cred.id)
    expect(decrypted?.value).toBe(value)
  })

  it('returns null from decrypt when ciphertext is corrupted', async () => {
    const cred = await backend.save(llmInput())
    db.prepare('UPDATE credentials SET encrypted_value = ? WHERE id = ?')
      .run('v2:00:00:00', cred.id)
    expect(await backend.decrypt(cred.id)).toBeNull()
  })
})

describe('DbCredentialBackend — id validation', () => {
  let db: Database.Database
  let backend: DbCredentialBackend

  beforeEach(() => {
    setupHome()
    db = makeFreshDb()
    backend = new DbCredentialBackend(db)
  })
  afterEach(() => {
    db.close()
    teardownHome()
  })

  it('returns null from get for malformed id (no SQL run)', async () => {
    expect(await backend.get('not-a-cred-id')).toBeNull()
  })

  it('returns null from decrypt for malformed id', async () => {
    expect(await backend.decrypt('not-a-cred-id')).toBeNull()
  })

  it('returns null from update for malformed id', async () => {
    expect(await backend.update('not-a-cred-id', { name: 'x' })).toBeNull()
  })

  it('returns false from delete for malformed id', async () => {
    expect(await backend.delete('not-a-cred-id')).toBe(false)
  })
})

describe('DbCredentialBackend — metadata persistence', () => {
  let db: Database.Database
  let backend: DbCredentialBackend

  beforeEach(() => {
    setupHome()
    db = makeFreshDb()
    backend = new DbCredentialBackend(db)
  })
  afterEach(() => {
    db.close()
    teardownHome()
  })

  it('persists JSON columns (grantedScopes, spendCap, tags) round-trip', async () => {
    const cred = await backend.save({
      name: 'Anthropic',
      value: 'sk-ant-XXXXXXXX-HM8A',
      category: 'llm',
      authType: 'api-key',
      variableName: 'ANTHROPIC_API_KEY',
      source: 'manual',
      tags: ['work', 'prod'],
      spendCap: { amountUsd: 5, period: 'day' },
    })
    const refetched = await backend.get(cred.id)
    expect(refetched?.tags).toEqual(['work', 'prod'])
    expect(refetched?.spendCap).toEqual({ amountUsd: 5, period: 'day' })
  })

  it('clears spendCap on update with null (column becomes NULL)', async () => {
    const cred = await backend.save(llmInput({ spendCap: { amountUsd: 5, period: 'day' } }))
    await backend.update(cred.id, { spendCap: null })
    const row = db
      .prepare('SELECT spend_cap FROM credentials WHERE id = ?')
      .get(cred.id) as { spend_cap: string | null }
    expect(row.spend_cap).toBeNull()
  })

  it('clears expiresAt on update with null', async () => {
    const cred = await backend.save(llmInput({ expiresAt: '2099-01-01T00:00:00.000Z' }))
    await backend.update(cred.id, { expiresAt: null })
    const row = db
      .prepare('SELECT expires_at FROM credentials WHERE id = ?')
      .get(cred.id) as { expires_at: string | null }
    expect(row.expires_at).toBeNull()
  })

  it('handles a corrupt JSON tags column by falling back to empty', async () => {
    const cred = await backend.save(llmInput({ tags: ['work'] }))
    db.prepare('UPDATE credentials SET tags = ? WHERE id = ?')
      .run('{not valid json', cred.id)
    const refetched = await backend.get(cred.id)
    expect(refetched?.tags).toBeUndefined()
  })
})

describe('DbCredentialBackend — name + categories', () => {
  beforeEach(() => { setupHome() })
  afterEach(() => { teardownHome() })

  it('exposes the documented diagnostic name', () => {
    const backend = new DbCredentialBackend(makeFreshDb())
    expect(backend.name).toBe('sqlite-credentials')
  })

  it('claims every credential category', () => {
    const backend = new DbCredentialBackend(makeFreshDb())
    expect([...backend.categories].sort()).toEqual(
      ['llm', 'mcp-server', 'oauth', 'tool'].sort(),
    )
  })
})
