/**
 * Unit tests — file-vault → credentials migration.
 *
 * Pins down every behaviour the importer claims:
 *   - Multi-var bundles unfold into one credential row per env-var.
 *   - Runtime per-thread files are skipped (purged separately).
 *   - Files are deleted only after a fully-clean import; partial
 *     failures leave them on disk for retry.
 *   - Idempotent via the app_state flag; per-row dedupe is the
 *     belt-and-suspenders.
 *   - Empty values, non-POSIX names, and unreadable bundles each
 *     have an explicit, isolated outcome.
 */

import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
import { DbCredentialBackend } from '../../../src/credential/store/db-backend.js'
import {
  FILE_VAULT_IMPORTED_FLAG,
  importFileVaultIntoCredentials,
} from '../../../src/credential/migrations/import-file-vault.js'
import { makeRuntimeCredentialId } from '../../../src/credential/runtime.js'
import { MIGRATIONS } from '../../../src/gateway/db/schema.js'

// ---------------------------------------------------------------------------
// Test environment
// ---------------------------------------------------------------------------

let prevHome: string | undefined
let tmpHome: string
let vaultDir: string
let vault: CredentialVault

beforeEach(() => {
  prevHome = process.env['HOME']
  tmpHome = mkdtempSync(join(tmpdir(), 'cortex-cred-import-fv-'))
  process.env['HOME'] = tmpHome
  vaultDir = join(tmpHome, 'credentials')
  __resetMasterKeyCacheForTests()
  vault = new CredentialVault(vaultDir)
})
afterEach(() => {
  if (prevHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = prevHome
  __resetMasterKeyCacheForTests()
  try { rmSync(tmpHome, { recursive: true, force: true }) } catch { /* best-effort */ }
})

function makeDb(): Database.Database {
  const db = new Database(':memory:')
  for (const m of MIGRATIONS) db.exec(m.sql)
  return db
}

function flagValue(db: Database.Database): string | undefined {
  const row = db
    .prepare('SELECT value FROM app_state WHERE key = ?')
    .get(FILE_VAULT_IMPORTED_FLAG) as { value: string } | undefined
  return row?.value
}

// ---------------------------------------------------------------------------
// Tests — happy path
// ---------------------------------------------------------------------------

describe('importFileVaultIntoCredentials — happy path', () => {
  it('unfolds a multi-var bundle into one credential per env var', async () => {
    await vault.save('mcp-server-github', {
      GITHUB_TOKEN: 'ghp_AAAAAAAA-1111',
      GITHUB_API_URL: 'https://api.github.com',
    })
    const db = makeDb()
    const backend = new DbCredentialBackend(db)

    const result = await importFileVaultIntoCredentials(db, backend, { vault })
    expect(result.ran).toBe(true)
    expect(result.perConnector.length).toBe(1)
    expect(result.perConnector[0]!.importedVars.sort()).toEqual([
      'GITHUB_API_URL',
      'GITHUB_TOKEN',
    ])

    const list = await backend.list({ category: 'mcp-server' })
    expect(list.map(c => c.variableName).sort()).toEqual([
      'GITHUB_API_URL',
      'GITHUB_TOKEN',
    ])
    expect(list.every(c => c.forConnector === 'mcp-server-github')).toBe(true)
    expect(list.every(c => c.source === 'mcp-config')).toBe(true)
    expect(list.every(c => c.authType === 'api-key')).toBe(true)
    expect(list.every(c => c.trust === 'medium')).toBe(true)

    // Plaintext round-trips through the new master-key encryption.
    const tokenRow = list.find(c => c.variableName === 'GITHUB_TOKEN')!
    const decrypted = await backend.decrypt(tokenRow.id)
    expect(decrypted?.value).toBe('ghp_AAAAAAAA-1111')

    db.close()
  })

  it('deletes the .json file after a fully clean import', async () => {
    await vault.save('mcp-server-github', { GITHUB_TOKEN: 'ghp_AAAAAAAA-1111' })
    const filePath = join(vaultDir, 'mcp-server-github.json')
    expect(existsSync(filePath)).toBe(true)

    const db = makeDb()
    const backend = new DbCredentialBackend(db)
    const result = await importFileVaultIntoCredentials(db, backend, { vault })

    expect(result.perConnector[0]!.fileDeleted).toBe(true)
    expect(existsSync(filePath)).toBe(false)
    db.close()
  })

  it('keeps the file when deleteAfterImport is false', async () => {
    await vault.save('mcp-server-github', { GITHUB_TOKEN: 'ghp_AAAAAAAA-1111' })
    const filePath = join(vaultDir, 'mcp-server-github.json')

    const db = makeDb()
    const backend = new DbCredentialBackend(db)
    await importFileVaultIntoCredentials(db, backend, { vault, deleteAfterImport: false })

    expect(existsSync(filePath)).toBe(true)
    db.close()
  })

  it('flips the flag with no work when the vault is empty', async () => {
    const db = makeDb()
    const backend = new DbCredentialBackend(db)
    const result = await importFileVaultIntoCredentials(db, backend, { vault })
    expect(result.ran).toBe(true)
    expect(result.perConnector).toEqual([])
    expect(flagValue(db)).toBe('1')
    db.close()
  })
})

// ---------------------------------------------------------------------------
// Tests — runtime files left alone
// ---------------------------------------------------------------------------

describe('importFileVaultIntoCredentials — runtime skip', () => {
  it('skips runtime.<threadId>.<varName> files entirely', async () => {
    const id = makeRuntimeCredentialId('thread_abc', 'ANTHROPIC_API_KEY')
    await vault.save(id, { ANTHROPIC_API_KEY: 'sk-ant-RUNTIME-1111' })

    const db = makeDb()
    const backend = new DbCredentialBackend(db)
    const result = await importFileVaultIntoCredentials(db, backend, { vault })

    expect(result.skippedRuntime).toContain(id)
    expect(result.perConnector).toEqual([])

    // Nothing was imported.
    const list = await backend.list({ includeRevoked: true })
    expect(list.length).toBe(0)

    // Runtime file is still on disk — purge belongs to C42, not us.
    expect(existsSync(join(vaultDir, `${id}.json`))).toBe(true)
    db.close()
  })

  it('processes non-runtime files even when runtime files are present', async () => {
    await vault.save('mcp-server-github', { GITHUB_TOKEN: 'ghp_AAAA-1111' })
    const runtimeId = makeRuntimeCredentialId('thread_abc', 'ANTHROPIC_API_KEY')
    await vault.save(runtimeId, { ANTHROPIC_API_KEY: 'sk-ant-RUNTIME' })

    const db = makeDb()
    const backend = new DbCredentialBackend(db)
    const result = await importFileVaultIntoCredentials(db, backend, { vault })

    expect(result.skippedRuntime).toEqual([runtimeId])
    expect(result.perConnector.length).toBe(1)
    expect(result.perConnector[0]!.connectorId).toBe('mcp-server-github')
    db.close()
  })
})

// ---------------------------------------------------------------------------
// Tests — partial / corrupt cases
// ---------------------------------------------------------------------------

describe('importFileVaultIntoCredentials — partial cases', () => {
  it('skips empty values without erroring out the run', async () => {
    await vault.save('mcp-foo', { GOOD: 'value-1', BAD: '' })
    const db = makeDb()
    const backend = new DbCredentialBackend(db)
    const result = await importFileVaultIntoCredentials(db, backend, { vault })

    expect(result.perConnector[0]!.importedVars).toEqual(['GOOD'])
    expect(result.perConnector[0]!.errors.length).toBe(1)
    expect(result.perConnector[0]!.fileDeleted).toBe(false)
    expect(existsSync(join(vaultDir, 'mcp-foo.json'))).toBe(true)
    db.close()
  })

  it('skips non-POSIX variable names', async () => {
    await vault.save('mcp-foo', {
      GOOD_TOKEN: 'value-1',
      'bad-name': 'value-2',
    })
    const db = makeDb()
    const backend = new DbCredentialBackend(db)
    const result = await importFileVaultIntoCredentials(db, backend, { vault })

    expect(result.perConnector[0]!.importedVars).toEqual(['GOOD_TOKEN'])
    expect(result.perConnector[0]!.skippedVars).toContain('bad-name')
    // skipped → not a clean import → file is kept
    expect(result.perConnector[0]!.fileDeleted).toBe(false)
    db.close()
  })

  it('records "vault.load returned null" for an unreadable file', async () => {
    // Plant a deliberately corrupt file that decrypt() rejects.
    // Save a real entry first so the vault directory exists, then
    // overwrite the planted corrupt file in the same dir.
    await vault.save('seed', { SEED: 'value' })
    writeFileSync(join(vaultDir, 'broken.json'), 'not-valid-cipher-text', { mode: 0o600 })

    const db = makeDb()
    const backend = new DbCredentialBackend(db)
    const result = await importFileVaultIntoCredentials(db, backend, { vault })

    const broken = result.perConnector.find(c => c.connectorId === 'broken')
    expect(broken).toBeDefined()
    expect(broken!.errors.length).toBe(1)
    expect(broken!.importedVars).toEqual([])
    expect(broken!.fileDeleted).toBe(false)
    db.close()
  })
})

// ---------------------------------------------------------------------------
// Tests — idempotency
// ---------------------------------------------------------------------------

describe('importFileVaultIntoCredentials — idempotency', () => {
  it('second invocation after a clean import sees an empty vault (ran === true, nothing imported)', async () => {
    // The 2026-05-10 evergreen rewrite drops the one-shot flag — every
    // boot scans the vault and imports any new files. After the first
    // run cleans up its file the vault is empty, so the second run
    // exits early with `ran: true` and no per-connector entries.
    await vault.save('mcp-server-github', { GITHUB_TOKEN: 'ghp_AAAA-1111' })
    const db = makeDb()
    const backend = new DbCredentialBackend(db)

    await importFileVaultIntoCredentials(db, backend, { vault })
    const second = await importFileVaultIntoCredentials(db, backend, { vault })
    expect(second.ran).toBe(true)
    expect(second.perConnector).toEqual([])
    db.close()
  })

  it('per-row dedupe prevents duplicates when the same file is imported twice', async () => {
    // With deleteAfterImport: false the file persists, so a re-run
    // sees the same `(forConnector, variableName)` pair already in
    // SQL and skips rather than inserting a duplicate. This is the
    // safety net that makes the always-on importer cheap and lossless.
    await vault.save('mcp-server-github', { GITHUB_TOKEN: 'ghp_AAAA-1111' })
    const db = makeDb()
    const backend = new DbCredentialBackend(db)

    await importFileVaultIntoCredentials(db, backend, { vault, deleteAfterImport: false })
    const second = await importFileVaultIntoCredentials(db, backend, {
      vault,
      deleteAfterImport: false,
    })
    expect(second.ran).toBe(true)
    expect(second.perConnector[0]!.importedVars).toEqual([])
    expect(second.perConnector[0]!.skippedVars).toEqual(['GITHUB_TOKEN'])

    const list = await backend.list({ category: 'mcp-server' })
    expect(list.length).toBe(1)
    db.close()
  })

  it('catches files added AFTER an earlier import (the leak fix)', async () => {
    // Pre-2026-05-10 behavior: the one-shot flag prevented later
    // imports, so files written between boots (e.g., the user adds a
    // Linear key on day 2) were orphaned forever. The evergreen
    // rewrite catches these on the next boot.
    await vault.save('seed-server', { SEED: 'first-run-1' })
    const db = makeDb()
    const backend = new DbCredentialBackend(db)
    await importFileVaultIntoCredentials(db, backend, { vault })

    // A new credential lands AFTER the first run completed.
    await vault.save('linear', { LINEAR_API_KEY: 'lin_api_AAAA-1111' })
    const second = await importFileVaultIntoCredentials(db, backend, { vault })

    expect(second.ran).toBe(true)
    const linear = second.perConnector.find(c => c.connectorId === 'linear')
    expect(linear).toBeDefined()
    expect(linear!.importedVars).toEqual(['LINEAR_API_KEY'])
    expect(linear!.fileDeleted).toBe(true)

    const list = await backend.list({ category: 'mcp-server' })
    expect(list.map(c => c.variableName).sort()).toEqual([
      'LINEAR_API_KEY',
      'SEED',
    ])
    db.close()
  })
})
