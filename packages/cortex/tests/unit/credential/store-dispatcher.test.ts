/**
 * Unit tests — credential store dispatcher + boot migrations.
 *
 * Two things this file pins:
 *
 *   1. `createCredentialStore(db)` produces a store that passes the
 *      same `runBackendContract` harness as the raw backend.
 *      Future multi-backend dispatchers must keep passing it.
 *   2. `runCredentialBootMigrations` runs both importers in the
 *      canonical order, idempotently, and returns the per-migration
 *      result. The order is observable via the log sink — the
 *      provider-keys log line fires before the file-vault one.
 */

import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { scryptSync } from 'node:crypto'
import { hostname, tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest'
import {
  CredentialVault,
  __resetMasterKeyCacheForTests,
} from '../../../src/connector/credentials/vault.js'
import {
  createCredentialStore,
  runCredentialBootMigrations,
} from '../../../src/credential/store/index.js'
import { encryptValue } from '../../../src/gateway/db/database.js'
import { MIGRATIONS } from '../../../src/gateway/db/schema.js'
import { runBackendContract } from './store-contract.test.js'

// ---------------------------------------------------------------------------
// Test environment
// ---------------------------------------------------------------------------

let prevHome: string | undefined
let tmpHome: string

function setupHome(): void {
  prevHome = process.env['HOME']
  tmpHome = mkdtempSync(join(tmpdir(), 'cortex-cred-disp-'))
  process.env['HOME'] = tmpHome
  __resetMasterKeyCacheForTests()
}
function teardownHome(): void {
  if (prevHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = prevHome
  __resetMasterKeyCacheForTests()
  try { rmSync(tmpHome, { recursive: true, force: true }) } catch { /* best-effort */ }
}

function makeDb(): Database.Database {
  const db = new Database(':memory:')
  for (const m of MIGRATIONS) db.exec(m.sql)
  return db
}

function legacyKey(): Buffer {
  return scryptSync(`${hostname()}-${userInfo().username}`, 'cortex-provider-keys-v1', 32)
}

/**
 * Recreate the legacy `provider_keys` table for migration tests.
 *
 * The current schema no longer creates this table — it was retired at
 * the credential-unification cutover. Tests that exercise the
 * upgrade-from-legacy path manually CREATE TABLE here so the importer
 * has rows to read against, mirroring what an existing user's DB
 * looks like before they upgrade.
 */
function ensureLegacyProviderKeysTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_keys (
      id              TEXT        PRIMARY KEY,
      provider_id     TEXT        NOT NULL UNIQUE,
      encrypted_key   TEXT        NOT NULL,
      key_hint        TEXT        NOT NULL DEFAULT '',
      iv              TEXT        NOT NULL,
      auth_tag        TEXT        NOT NULL,
      created_at      TEXT        NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT        NOT NULL DEFAULT (datetime('now'))
    );
  `)
}

function seedProviderKey(db: Database.Database, providerId: string, value: string): void {
  ensureLegacyProviderKeysTable(db)
  const { encrypted, iv, authTag } = encryptValue(value, legacyKey())
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO provider_keys (id, provider_id, encrypted_key, key_hint, iv, auth_tag, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(`pk_${providerId}_seed`, providerId, encrypted, '****', iv, authTag, now, now)
}

// ---------------------------------------------------------------------------
// Contract — dispatcher round-trips through the harness
// ---------------------------------------------------------------------------

describe('createCredentialStore — contract', () => {
  beforeEach(() => { setupHome() })
  afterEach(() => { teardownHome() })

  runBackendContract(() => createCredentialStore(makeDb()))
})

// ---------------------------------------------------------------------------
// Boot migrations
// ---------------------------------------------------------------------------

describe('runCredentialBootMigrations', () => {
  beforeEach(() => { setupHome() })
  afterEach(() => { teardownHome() })

  it('runs both importers in order on first boot', async () => {
    const db = makeDb()
    const store = createCredentialStore(db)

    seedProviderKey(db, 'anthropic', 'sk-ant-AAAAAAAA-1111')
    const vault = new CredentialVault(join(tmpHome, 'credentials'))
    await vault.save('mcp-server-github', { GITHUB_TOKEN: 'ghp_BBBBBBBB-2222' })

    const log: string[] = []
    const result = await runCredentialBootMigrations(db, store, {
      vault,
      log: m => log.push(m),
    })

    expect(result.providerKeys.ran).toBe(true)
    expect(result.providerKeys.imported).toEqual(['anthropic'])
    expect(result.fileVault.ran).toBe(true)
    expect(result.fileVault.perConnector.length).toBe(1)

    // Both kinds present in the unified store.
    const llmList = await store.list({ category: 'llm' })
    const mcpList = await store.list({ category: 'mcp-server' })
    expect(llmList.length).toBe(1)
    expect(mcpList.length).toBe(1)

    // Order: provider-keys log fires before file-vault log.
    const pkIdx = log.findIndex(m => m.includes('migrated 1 provider key'))
    const fvIdx = log.findIndex(m => m.includes('imported 1 secret'))
    expect(pkIdx).toBeGreaterThanOrEqual(0)
    expect(fvIdx).toBeGreaterThanOrEqual(0)
    expect(pkIdx).toBeLessThan(fvIdx)
    db.close()
  })

  it('second invocation is idempotent (providerKeys short-circuits, fileVault re-scans cheaply)', async () => {
    // Provider-keys is a one-shot importer (legacy table goes away post-C24)
    // so its second invocation returns `ran: false` via the app_state flag.
    //
    // File-vault is the 2026-05-10 evergreen importer — every boot scans the
    // vault so files written AFTER the first boot (registry.ts / mcp.ts /
    // connector-runtime-setup.ts still write there) are picked up. On the
    // second invocation here the first run deleted the file, so `vault.list()`
    // returns `[]` and the importer exits with `ran: true, perConnector: []`.
    // See import-file-vault.test.ts "second invocation after a clean import"
    // for the full per-importer contract.
    const db = makeDb()
    const store = createCredentialStore(db)
    seedProviderKey(db, 'anthropic', 'sk-ant-AAAAAAAA-1111')
    const vault = new CredentialVault(join(tmpHome, 'credentials'))
    await vault.save('mcp-server-github', { GITHUB_TOKEN: 'ghp_BBBBBBBB-2222' })

    await runCredentialBootMigrations(db, store, { vault })
    const second = await runCredentialBootMigrations(db, store, { vault })
    expect(second.providerKeys.ran).toBe(false)
    expect(second.fileVault.ran).toBe(true)
    expect(second.fileVault.perConnector).toEqual([])

    // Idempotent: still exactly the original counts.
    const llmList = await store.list({ category: 'llm' })
    const mcpList = await store.list({ category: 'mcp-server' })
    expect(llmList.length).toBe(1)
    expect(mcpList.length).toBe(1)
    db.close()
  })

  it('forceRun re-runs both importers', async () => {
    const db = makeDb()
    const store = createCredentialStore(db)
    seedProviderKey(db, 'anthropic', 'sk-ant-AAAAAAAA-1111')
    const vault = new CredentialVault(join(tmpHome, 'credentials'))
    await vault.save('mcp-server-github', { GITHUB_TOKEN: 'ghp_BBBBBBBB-2222' })

    await runCredentialBootMigrations(db, store, { vault, deleteAfterImport: false })
    const second = await runCredentialBootMigrations(db, store, {
      vault,
      forceRun: true,
      deleteAfterImport: false,
    })
    expect(second.providerKeys.ran).toBe(true)
    expect(second.fileVault.ran).toBe(true)
    // Per-row dedupe kicks in on both — no duplicates.
    expect(second.providerKeys.alreadyPresent).toEqual(['anthropic'])
    expect(second.fileVault.perConnector[0]!.skippedVars).toEqual(['GITHUB_TOKEN'])
    db.close()
  })

  it('survives a clean install with no legacy data on either side', async () => {
    const db = makeDb()
    const store = createCredentialStore(db)
    const vault = new CredentialVault(join(tmpHome, 'credentials'))
    const result = await runCredentialBootMigrations(db, store, { vault })
    expect(result.providerKeys.ran).toBe(true)
    expect(result.providerKeys.imported).toEqual([])
    expect(result.fileVault.ran).toBe(true)
    expect(result.fileVault.perConnector).toEqual([])
    db.close()
  })
})
