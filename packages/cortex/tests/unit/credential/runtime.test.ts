/**
 * Unit tests — ThreadCredentialRuntime.
 *
 * Covers:
 *   - `.env` auto-import: classification, vault writes, config return.
 *   - .env.local precedence (override rules).
 *   - Missing / malformed .env files: best-effort behaviour.
 *   - Handle + value cache: listEnvCredentials, listAllCredentialValues,
 *     resolveValue, primeValueCache.
 *   - Cleanup scoping: only runtime_<threadId>_* entries removed from vault.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  CredentialVault,
  __resetMasterKeyCacheForTests,
} from '../../../src/connector/credentials/vault.js'
import {
  ThreadCredentialRuntime,
  RUNTIME_CREDENTIAL_ID_PREFIX,
  makeRuntimeCredentialId,
} from '../../../src/credential/runtime.js'

let tmpHome: string
let tmpWorkspace: string
let prevHome: string | undefined
let vault: CredentialVault

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'cortex-runtime-'))
  tmpWorkspace = mkdtempSync(join(tmpdir(), 'cortex-ws-'))
  prevHome = process.env['HOME']
  process.env['HOME'] = tmpHome
  __resetMasterKeyCacheForTests()
  // Use an isolated vault directory so each test starts fresh.
  vault = new CredentialVault(join(tmpHome, 'credentials'))
})

afterEach(() => {
  if (prevHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = prevHome
  __resetMasterKeyCacheForTests()
  rmSync(tmpHome, { recursive: true, force: true })
  rmSync(tmpWorkspace, { recursive: true, force: true })
})

function writeDotenv(workspace: string, filename: string, content: string): void {
  writeFileSync(join(workspace, filename), content, 'utf-8')
}

// ---------------------------------------------------------------------------
// makeRuntimeCredentialId
// ---------------------------------------------------------------------------

describe('makeRuntimeCredentialId', () => {
  it('builds `runtime.<thread>.<var>` with safe-char thread id', () => {
    expect(makeRuntimeCredentialId('thr-123', 'DATABASE_URL')).toBe('runtime.thr-123.DATABASE_URL')
  })

  it('sanitises thread id characters outside [A-Za-z0-9_-]', () => {
    // `.` is stripped from threadId during sanitization — the dot is
    // reserved as the runtime-id separator. Then we emit
    // `runtime.<safe>.<var>`, and `<safe>` here is `thr_ab_cd`.
    expect(makeRuntimeCredentialId('thr/ab.cd', 'X')).toBe('runtime.thr_ab_cd.X')
  })

  it('preserves the RUNTIME prefix (cleanup relies on it)', () => {
    const id = makeRuntimeCredentialId('t', 'VAR')
    expect(id.startsWith(RUNTIME_CREDENTIAL_ID_PREFIX)).toBe(true)
  })

  it('round-trips through parseRuntimeCredentialId — even with underscores in var', async () => {
    const { parseRuntimeCredentialId } = await import('../../../src/credential/runtime.js')
    const id = makeRuntimeCredentialId('thread-uuid-1', 'DATABASE_URL')
    const parsed = parseRuntimeCredentialId(id)
    expect(parsed).toEqual({ threadId: 'thread-uuid-1', variableName: 'DATABASE_URL' })
  })

  it('parseRuntimeCredentialId returns null for non-runtime ids', async () => {
    const { parseRuntimeCredentialId } = await import('../../../src/credential/runtime.js')
    expect(parseRuntimeCredentialId('mcp-server-github')).toBeNull()
    expect(parseRuntimeCredentialId('runtime.')).toBeNull()
    expect(parseRuntimeCredentialId('runtime.onlythread')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Import from workspace
// ---------------------------------------------------------------------------

describe('ThreadCredentialRuntime.importFromWorkspace', () => {
  it('classifies .env vars and stores sensitive in vault / returns safe as config', async () => {
    writeDotenv(tmpWorkspace, '.env', [
      'NODE_ENV=development',
      'PORT=3000',
      'DATABASE_URL=postgres://u:p@host/db',
      'JWT_SECRET=sekrit-xyz',
    ].join('\n'))

    const rt = new ThreadCredentialRuntime('t-1', vault)
    const result = await rt.importFromWorkspace(tmpWorkspace)

    expect(result.configVars).toEqual({ NODE_ENV: 'development', PORT: '3000' })
    expect(result.imported).toHaveLength(2)

    const ids = result.imported.map(h => h.credentialId)
    expect(ids).toContain(makeRuntimeCredentialId('t-1', 'DATABASE_URL'))
    expect(ids).toContain(makeRuntimeCredentialId('t-1', 'JWT_SECRET'))

    // Vault round-trips the values.
    const dbLoaded = await vault.load(makeRuntimeCredentialId('t-1', 'DATABASE_URL'))
    expect(dbLoaded?.env.DATABASE_URL).toBe('postgres://u:p@host/db')
  })

  it('uses .env.local to override .env (standard dotenv precedence)', async () => {
    writeDotenv(tmpWorkspace, '.env', 'PORT=3000\nDATABASE_URL=postgres://default')
    writeDotenv(tmpWorkspace, '.env.local', 'PORT=4000\nDATABASE_URL=postgres://local')

    const rt = new ThreadCredentialRuntime('t-1', vault)
    const result = await rt.importFromWorkspace(tmpWorkspace)

    expect(result.configVars.PORT).toBe('4000')
    const dbId = makeRuntimeCredentialId('t-1', 'DATABASE_URL')
    const bundle = await vault.load(dbId)
    expect(bundle?.env.DATABASE_URL).toBe('postgres://local')
  })

  it('is a no-op when no .env files exist', async () => {
    const rt = new ThreadCredentialRuntime('t-1', vault)
    const result = await rt.importFromWorkspace(tmpWorkspace)
    expect(result.imported).toEqual([])
    expect(result.configVars).toEqual({})
    expect(result.filesRead).toEqual([])
  })

  it('reports skipped lines per file for diagnostics', async () => {
    writeDotenv(tmpWorkspace, '.env', '1BAD=skipped\nGOOD=ok\nmissing_equals')
    const rt = new ThreadCredentialRuntime('t-1', vault)
    const result = await rt.importFromWorkspace(tmpWorkspace)
    const envPath = join(tmpWorkspace, '.env')
    expect(result.parseSkipped[envPath]).toEqual([1, 3])
    // GOOD key is UNKNOWN → treated as sensitive (secure default).
    expect(result.imported.map(h => h.placement.type === 'env' && h.placement.variableName)).toEqual(['GOOD'])
  })

  it('pre-populates the in-memory cache so resolveValue returns synchronously', async () => {
    writeDotenv(tmpWorkspace, '.env', 'JWT_SECRET=hello')
    const rt = new ThreadCredentialRuntime('t-1', vault)
    await rt.importFromWorkspace(tmpWorkspace)
    const id = makeRuntimeCredentialId('t-1', 'JWT_SECRET')
    expect(rt.resolveValue(id)).toBe('hello')
  })
})

// ---------------------------------------------------------------------------
// Handle + cache surfaces
// ---------------------------------------------------------------------------

describe('ThreadCredentialRuntime — handle + cache surfaces', () => {
  it('listEnvCredentials returns only env-placed entries', async () => {
    writeDotenv(tmpWorkspace, '.env', 'DB_URL=postgres://x\nJWT_SECRET=y')
    const rt = new ThreadCredentialRuntime('t-1', vault)
    await rt.importFromWorkspace(tmpWorkspace)

    const entries = rt.listEnvCredentials()
    expect(entries).toHaveLength(2)
    for (const e of entries) {
      expect(e.credentialId.startsWith(RUNTIME_CREDENTIAL_ID_PREFIX)).toBe(true)
      expect(typeof e.variableName).toBe('string')
    }
  })

  it('listAllCredentialValues exposes values — for redactor only', async () => {
    writeDotenv(tmpWorkspace, '.env', 'STRIPE_KEY=sk_live_abcdef')
    const rt = new ThreadCredentialRuntime('t-1', vault)
    await rt.importFromWorkspace(tmpWorkspace)

    const values = rt.listAllCredentialValues()
    expect(values).toHaveLength(1)
    expect(values[0]!.value).toBe('sk_live_abcdef')
    expect(values[0]!.label).toContain('STRIPE_KEY')
  })

  it('primeValueCache loads vault values when cache is cold', async () => {
    // Pre-seed the vault without going through the import path.
    const id = makeRuntimeCredentialId('t-1', 'USER_JWT')
    await vault.save(id, { USER_JWT: 'token-abc' })
    const rt = new ThreadCredentialRuntime('t-1', vault)
    rt.addHandle({
      credentialId: id,
      label: 'USER_JWT',
      placement: { type: 'env', variableName: 'USER_JWT' },
      storedAt: Date.now(),
    })
    expect(rt.resolveValue(id)).toBeNull()
    await rt.primeValueCache()
    expect(rt.resolveValue(id)).toBe('token-abc')
  })

  it('addHandle dedupes by credentialId (later call replaces)', async () => {
    const rt = new ThreadCredentialRuntime('t-1', vault)
    const id = makeRuntimeCredentialId('t-1', 'X')
    rt.addHandle({ credentialId: id, label: 'first', placement: { type: 'env', variableName: 'X' }, storedAt: 1 })
    rt.addHandle({ credentialId: id, label: 'second', placement: { type: 'env', variableName: 'X' }, storedAt: 2 })
    const list = rt.listHandles()
    expect(list).toHaveLength(1)
    expect(list[0]!.label).toBe('second')
  })

  it('deleteHandle removes the handle and clears the cached value', async () => {
    writeDotenv(tmpWorkspace, '.env', 'JWT_SECRET=abc')
    const rt = new ThreadCredentialRuntime('t-1', vault)
    await rt.importFromWorkspace(tmpWorkspace)
    const id = makeRuntimeCredentialId('t-1', 'JWT_SECRET')
    expect(rt.resolveValue(id)).toBe('abc')

    const removed = rt.deleteHandle(id)
    expect(removed).toBe(true)
    expect(rt.resolveValue(id)).toBeNull()
    expect(rt.listHandles()).toEqual([])
    expect(rt.listEnvCredentials()).toEqual([])
  })

  it('deleteHandle returns false for unknown id', async () => {
    const rt = new ThreadCredentialRuntime('t-1', vault)
    expect(rt.deleteHandle('missing_id')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Cleanup scoping
// ---------------------------------------------------------------------------

describe('ThreadCredentialRuntime.cleanup', () => {
  it('deletes runtime-scoped vault entries and leaves MCP entries untouched', async () => {
    // Runtime-owned entry.
    writeDotenv(tmpWorkspace, '.env', 'JWT_SECRET=stuff')
    const rt = new ThreadCredentialRuntime('t-1', vault)
    await rt.importFromWorkspace(tmpWorkspace)
    const runtimeId = makeRuntimeCredentialId('t-1', 'JWT_SECRET')
    expect(await vault.load(runtimeId)).not.toBeNull()

    // Pre-existing non-runtime entry, e.g. an MCP credential.
    const mcpId = 'mcp-server-github'
    await vault.save(mcpId, { GITHUB_TOKEN: 'ghp_xxx' })
    expect(await vault.load(mcpId)).not.toBeNull()

    await rt.cleanup()

    expect(await vault.load(runtimeId)).toBeNull()
    expect(await vault.load(mcpId)).not.toBeNull()
    expect(rt.listHandles()).toEqual([])
    expect(rt.listEnvCredentials()).toEqual([])
  })

  it('is idempotent — a second cleanup is a no-op', async () => {
    writeDotenv(tmpWorkspace, '.env', 'JWT=x')
    const rt = new ThreadCredentialRuntime('t-1', vault)
    await rt.importFromWorkspace(tmpWorkspace)
    await rt.cleanup()
    await rt.cleanup()
    expect(rt.listHandles()).toEqual([])
  })
})
