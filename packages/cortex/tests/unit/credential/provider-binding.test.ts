/**
 * Unit tests — provider ⇄ resolver binding.
 *
 * Pinned:
 *   - apiKeyProvider() resolves a fresh value via resolver+injector
 *   - audit row is written exactly once per call (resolver does it)
 *   - context() is called per invocation so audit rows reflect the
 *     live agent/session/thread ids
 *   - thrown errors from the resolver propagate verbatim (no swallow)
 *   - lastHandle() returns the most recent handle for post-flight
 *     true-up; null before the first call
 *   - the static fixture returns its value without touching any
 *     resolver
 */

import Database from 'better-sqlite3'
import {
  CredentialDeniedError,
  type ResolveContext,
} from '@ownware/loom'
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
import { CredentialInjector } from '../../../src/credential/injector.js'
import {
  makeApiKeyProvider,
  makeStaticApiKeyProvider,
} from '../../../src/credential/provider-binding.js'
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

const fixedCtx: ResolveContext = {
  agentId: 'agent_x',
  sessionId: 'sess_x',
  threadId: 'thread_x',
}

beforeEach(() => {
  prevHome = process.env['HOME']
  tmpHome = mkdtempSync(join(tmpdir(), 'cortex-cred-binding-'))
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

async function seed(value = 'sk-ant-XXXXXXXX-BIND') {
  return store.save({
    name: 'Anthropic',
    value,
    category: 'llm',
    authType: 'api-key',
    variableName: 'ANTHROPIC_API_KEY',
    source: 'manual',
  })
}

// ---------------------------------------------------------------------------
// makeApiKeyProvider — happy path
// ---------------------------------------------------------------------------

describe('makeApiKeyProvider — happy path', () => {
  it('resolves and returns the credential value', async () => {
    await seed('sk-ant-RESOLVED')
    const binding = makeApiKeyProvider({
      resolver, injector,
      variableName: 'ANTHROPIC_API_KEY',
      context: () => fixedCtx,
    })
    const key = await binding.apiKeyProvider()
    expect(key).toBe('sk-ant-RESOLVED')
  })

  it('writes one resolve audit row per apiKeyProvider() call', async () => {
    const cred = await seed()
    const binding = makeApiKeyProvider({
      resolver, injector,
      variableName: 'ANTHROPIC_API_KEY',
      context: () => fixedCtx,
    })
    await binding.apiKeyProvider()
    await binding.apiKeyProvider()
    const events = audit.listEventsForCredential(cred.id).events
    const resolves = events.filter(e => e.eventType === 'resolve' && e.outcome === 'ok')
    expect(resolves.length).toBe(2)
  })

  it('issues a fresh handle per call (lastHandle changes)', async () => {
    await seed()
    const binding = makeApiKeyProvider({
      resolver, injector,
      variableName: 'ANTHROPIC_API_KEY',
      context: () => fixedCtx,
    })
    expect(binding.lastHandle()).toBeNull()
    await binding.apiKeyProvider()
    const first = binding.lastHandle()
    expect(first).not.toBeNull()
    await binding.apiKeyProvider()
    const second = binding.lastHandle()
    expect(second).not.toBeNull()
    expect(first!.token).not.toBe(second!.token)
  })

  it('calls context() per invocation so live ids land on audit rows', async () => {
    const cred = await seed()
    const contextFn = vi.fn(() => fixedCtx)
    const binding = makeApiKeyProvider({
      resolver, injector,
      variableName: 'ANTHROPIC_API_KEY',
      context: contextFn,
    })
    await binding.apiKeyProvider()
    await binding.apiKeyProvider()
    expect(contextFn).toHaveBeenCalledTimes(2)
    const events = audit.listEventsForCredential(cred.id).events
    expect(events.every(e => e.agentId === 'agent_x')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// makeApiKeyProvider — error propagation
// ---------------------------------------------------------------------------

describe('makeApiKeyProvider — error propagation', () => {
  it('propagates MissingCredentialError when no credential exists', async () => {
    const binding = makeApiKeyProvider({
      resolver, injector,
      variableName: 'NOPE',
      context: () => fixedCtx,
    })
    await expect(binding.apiKeyProvider()).rejects.toThrow(/NOPE/)
  })

  it('propagates CredentialDeniedError when a gate refuses', async () => {
    const cred = await seed()
    await store.update(cred.id, { status: 'revoked', statusReason: 'user removed' })
    const binding = makeApiKeyProvider({
      resolver, injector,
      variableName: 'ANTHROPIC_API_KEY',
      context: () => fixedCtx,
    })
    await expect(binding.apiKeyProvider()).rejects.toBeInstanceOf(CredentialDeniedError)
  })

  it('clears lastHandle when the resolve fails', async () => {
    const binding = makeApiKeyProvider({
      resolver, injector,
      variableName: 'NOPE',
      context: () => fixedCtx,
    })
    try { await binding.apiKeyProvider() } catch { /* expected */ }
    expect(binding.lastHandle()).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// makeApiKeyProvider — plaintext discipline
// ---------------------------------------------------------------------------

describe('makeApiKeyProvider — plaintext discipline', () => {
  it('the binding object does not retain the value after the call returns', async () => {
    await seed('sk-ant-LEAK-CHECK-BINDING')
    const binding = makeApiKeyProvider({
      resolver, injector,
      variableName: 'ANTHROPIC_API_KEY',
      context: () => fixedCtx,
    })
    await binding.apiKeyProvider()
    // The binding's enumerable properties are functions; they don't
    // serialise the value. Closure state holds only the handle, not
    // the value.
    expect(JSON.stringify(binding)).not.toContain('LEAK-CHECK')
  })
})

// ---------------------------------------------------------------------------
// makeStaticApiKeyProvider — fixture for non-resolver tests
// ---------------------------------------------------------------------------

describe('makeStaticApiKeyProvider', () => {
  it('returns the static value on every apiKeyProvider() call', async () => {
    const binding = makeStaticApiKeyProvider('sk-static')
    expect(await binding.apiKeyProvider()).toBe('sk-static')
    expect(await binding.apiKeyProvider()).toBe('sk-static')
  })

  it('lastHandle() returns a deterministic handle (NOT null)', () => {
    const binding = makeStaticApiKeyProvider('sk-static')
    expect(binding.lastHandle()).not.toBeNull()
  })
})
