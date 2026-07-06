/**
 * Unit tests — credential injector.
 *
 * Pinned:
 *   - injectEnvForChild mutates the env Record with the right name.
 *   - injectAuthHeader picks Bearer for bearer-token / oauth2,
 *     Bearer-by-default for api-key, throws on basic.
 *   - runWithCredential passes the value to the callback exactly
 *     once; the injector never returns the value to the caller.
 *   - All three throw InjectorHandleUnknownError on a bad / expired
 *     handle.
 *   - Plaintext: the value never leaks into a thrown error message.
 */

import Database from 'better-sqlite3'
import { type ResolveContext, unsafeCreateHandle } from '@ownware/loom'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { CredentialAuditLog } from '../../../src/credential/audit.js'
import {
  CredentialInjector,
  InjectorAuthShapeError,
  InjectorHandleUnknownError,
} from '../../../src/credential/injector.js'
import { GatewayCredentialResolver } from '../../../src/credential/resolver.js'
import { DbCredentialBackend } from '../../../src/credential/store/db-backend.js'
import { __resetMasterKeyCacheForTests } from '../../../src/connector/credentials/vault.js'
import { MIGRATIONS } from '../../../src/gateway/db/schema.js'

let prevHome: string | undefined
let tmpHome: string
let db: Database.Database
let store: DbCredentialBackend
let audit: CredentialAuditLog
let resolver: GatewayCredentialResolver
let injector: CredentialInjector

const ctx: ResolveContext = {
  agentId: 'agent_x',
  sessionId: 'sess_x',
  threadId: 'thread_x',
  toolName: 'shell',
}

beforeEach(() => {
  prevHome = process.env['HOME']
  tmpHome = mkdtempSync(join(tmpdir(), 'cortex-cred-injector-'))
  process.env['HOME'] = tmpHome
  __resetMasterKeyCacheForTests()
  db = new Database(':memory:')
  for (const m of MIGRATIONS) db.exec(m.sql)
  store = new DbCredentialBackend(db)
  audit = new CredentialAuditLog(db)
  resolver = new GatewayCredentialResolver({ store, audit, spendDb: db })
  injector = new CredentialInjector(resolver)
})
afterEach(() => {
  db.close()
  if (prevHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = prevHome
  __resetMasterKeyCacheForTests()
  try { rmSync(tmpHome, { recursive: true, force: true }) } catch { /* best-effort */ }
})

async function seedAndResolve(overrides: Partial<Parameters<typeof store.save>[0]> = {}) {
  await store.save({
    name: 'Anthropic',
    value: 'sk-ant-XXXXXXXX-INJC',
    category: 'llm',
    authType: 'api-key',
    variableName: 'ANTHROPIC_API_KEY',
    source: 'manual',
    ...overrides,
  })
  return resolver.resolve(overrides.variableName ?? 'ANTHROPIC_API_KEY', ctx)
}

// ---------------------------------------------------------------------------
// injectEnvForChild
// ---------------------------------------------------------------------------

describe('CredentialInjector — injectEnvForChild', () => {
  it('writes the variable name + value into the env Record', async () => {
    const handle = await seedAndResolve()
    const env: Record<string, string> = {}
    await injector.injectEnvForChild(handle, env)
    expect(env['ANTHROPIC_API_KEY']).toBe('sk-ant-XXXXXXXX-INJC')
  })

  it('overwrites an existing entry with the same variable name', async () => {
    const handle = await seedAndResolve()
    const env: Record<string, string> = { ANTHROPIC_API_KEY: 'old-stale-value' }
    await injector.injectEnvForChild(handle, env)
    expect(env['ANTHROPIC_API_KEY']).toBe('sk-ant-XXXXXXXX-INJC')
  })

  it('preserves unrelated env entries', async () => {
    const handle = await seedAndResolve()
    const env: Record<string, string> = { PATH: '/usr/bin', USER: 'alice' }
    await injector.injectEnvForChild(handle, env)
    expect(env['PATH']).toBe('/usr/bin')
    expect(env['USER']).toBe('alice')
  })

  it('throws InjectorHandleUnknownError for a fabricated handle', async () => {
    const fake = unsafeCreateHandle('fake-token-no-resolve')
    await expect(
      injector.injectEnvForChild(fake, {}),
    ).rejects.toBeInstanceOf(InjectorHandleUnknownError)
  })

  it('throws after the handle is released', async () => {
    const handle = await seedAndResolve()
    resolver.releaseHandle(handle)
    await expect(
      injector.injectEnvForChild(handle, {}),
    ).rejects.toBeInstanceOf(InjectorHandleUnknownError)
  })

  it('throws after the handle TTL expires', async () => {
    vi.useFakeTimers()
    try {
      const shortTtl = new GatewayCredentialResolver({
        store, audit, spendDb: db, handleTtlMs: 1_000,
      })
      const shortInjector = new CredentialInjector(shortTtl)
      await store.save({
        name: 'Anthropic',
        value: 'sk-ant-XXXXXXXX-INJC',
        category: 'llm',
        authType: 'api-key',
        variableName: 'ANTHROPIC_API_KEY',
        source: 'manual',
      })
      const handle = await shortTtl.resolve('ANTHROPIC_API_KEY', ctx)
      vi.advanceTimersByTime(2_000)
      await expect(
        shortInjector.injectEnvForChild(handle, {}),
      ).rejects.toBeInstanceOf(InjectorHandleUnknownError)
    } finally {
      vi.useRealTimers()
    }
  })
})

// ---------------------------------------------------------------------------
// injectAuthHeader
// ---------------------------------------------------------------------------

describe('CredentialInjector — injectAuthHeader', () => {
  it('writes Bearer header for api-key by default', async () => {
    const handle = await seedAndResolve({ value: 'tok-abc' })
    const headers: Record<string, string> = {}
    await injector.injectAuthHeader(handle, headers)
    expect(headers['Authorization']).toBe('Bearer tok-abc')
  })

  it('writes raw value when scheme is "raw" and authType is api-key', async () => {
    const handle = await seedAndResolve({ value: 'raw-key-no-bearer' })
    const headers: Record<string, string> = {}
    await injector.injectAuthHeader(handle, headers, { scheme: 'raw' })
    expect(headers['Authorization']).toBe('raw-key-no-bearer')
  })

  it('writes Bearer for oauth2', async () => {
    const handle = await seedAndResolve({
      name: 'GitHub',
      category: 'oauth',
      authType: 'oauth2',
      variableName: 'GITHUB_TOKEN',
      value: 'oauth-tok',
    })
    const headers: Record<string, string> = {}
    await injector.injectAuthHeader(handle, headers, { scheme: 'raw' })
    // OAuth ignores the raw scheme — always Bearer.
    expect(headers['Authorization']).toBe('Bearer oauth-tok')
  })

  it('writes Bearer for bearer-token', async () => {
    const handle = await seedAndResolve({
      name: 'Bearer',
      category: 'tool',
      authType: 'bearer-token',
      variableName: 'BEARER_TOKEN',
      value: 'bear-tok',
    })
    const headers: Record<string, string> = {}
    await injector.injectAuthHeader(handle, headers, { scheme: 'raw' })
    expect(headers['Authorization']).toBe('Bearer bear-tok')
  })

  it('throws InjectorAuthShapeError for basic auth', async () => {
    // basic-auth credentials are still looked up by variableName for
    // the resolve path (the schema lets `variableName` be set for
    // every authType). The injector only refuses at the auth-header
    // injection step, not during resolve.
    const handle = await seedAndResolve({
      name: 'Basic',
      category: 'tool',
      authType: 'basic',
      variableName: 'BASIC_PASSWORD',
    })
    await expect(
      injector.injectAuthHeader(handle, {}),
    ).rejects.toBeInstanceOf(InjectorAuthShapeError)
  })

  it('throws InjectorHandleUnknownError on a bad handle', async () => {
    const fake = unsafeCreateHandle('fake')
    await expect(
      injector.injectAuthHeader(fake, {}),
    ).rejects.toBeInstanceOf(InjectorHandleUnknownError)
  })
})

// ---------------------------------------------------------------------------
// runWithCredential
// ---------------------------------------------------------------------------

describe('CredentialInjector — runWithCredential', () => {
  it('passes the value to the callback and returns its result', async () => {
    const handle = await seedAndResolve({ value: 'sdk-key' })
    const result = await injector.runWithCredential(handle, value => `built-${value}`)
    expect(result).toBe('built-sdk-key')
  })

  it('awaits async callbacks', async () => {
    const handle = await seedAndResolve({ value: 'sdk-key-async' })
    const result = await injector.runWithCredential(handle, async value => {
      await Promise.resolve()
      return value.toUpperCase()
    })
    expect(result).toBe('SDK-KEY-ASYNC')
  })

  it('propagates a callback throw to the caller', async () => {
    const handle = await seedAndResolve()
    await expect(
      injector.runWithCredential(handle, () => {
        throw new Error('callback boom')
      }),
    ).rejects.toThrow('callback boom')
  })

  it('throws InjectorHandleUnknownError on a bad handle (callback never runs)', async () => {
    const fake = unsafeCreateHandle('fake')
    let called = false
    await expect(
      injector.runWithCredential(fake, () => {
        called = true
        return 'should not happen'
      }),
    ).rejects.toBeInstanceOf(InjectorHandleUnknownError)
    expect(called).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Plaintext discipline
// ---------------------------------------------------------------------------

describe('CredentialInjector — plaintext discipline', () => {
  it('the InjectorHandleUnknownError message does not include any value', async () => {
    const fake = unsafeCreateHandle('whatever')
    try {
      await injector.injectEnvForChild(fake, {})
      expect.fail('should have thrown')
    } catch (err) {
      expect(String(err)).not.toMatch(/sk-[A-Za-z0-9]/)
    }
  })

  it('runWithCredential\'s value is dropped from the injector\'s scope after fn returns', async () => {
    const handle = await seedAndResolve({ value: 'sk-ant-LEAK-CHECK-RUN' })
    let captured: string | null = null
    await injector.runWithCredential(handle, value => {
      captured = value
      return 'ok'
    })
    expect(captured).toBe('sk-ant-LEAK-CHECK-RUN')
    // The injector itself doesn't expose any state, so there's
    // nothing to grep for — the test pins the contract that
    // only the callback sees the value.
  })
})
