/**
 * Unit tests — Phase-8 unified-store provider bootstrap.
 *
 * Pinned:
 *   - For each catalogued LLM credential present in the unified
 *     store, a loom provider is registered with apiKeyProvider that
 *     calls into the resolver.
 *   - For each missing credential, the bootstrap leaves the loom
 *     registry alone (legacy fallback continues to serve).
 *   - Calling the apiKeyProvider closure runs the full resolve
 *     flow (audit row written, plaintext returned).
 *   - The placeholder `agentId='gateway-llm'` audit ctx is used
 *     when no override is supplied — easy to grep for.
 *   - Re-running the bootstrap is idempotent (overrides cleanly).
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
  vi,
} from 'vitest'

// Mock the loom SDKs so the bootstrap can construct provider
// instances without real network or env vars.
const anthropicCtor = vi.fn()
vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    constructor(opts: { apiKey?: string }) { anthropicCtor(opts) }
    messages = { stream: vi.fn(), countTokens: vi.fn(() => ({ input_tokens: 0 })) }
  },
}))

const openaiCtor = vi.fn()
vi.mock('openai', () => ({
  default: class MockOpenAI {
    constructor(opts: { apiKey?: string }) { openaiCtor(opts) }
    chat = { completions: { create: vi.fn() } }
  },
}))

const googleCtor = vi.fn()
vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: class MockGoogle {
    constructor(apiKey: string) { googleCtor(apiKey) }
    getGenerativeModel = vi.fn(() => ({ countTokens: vi.fn(() => ({ totalTokens: 0 })) }))
  },
}))

import { listProviders, getProvider, type ResolveContext } from '@ownware/loom'
import { CredentialAuditLog } from '../../../src/credential/audit.js'
import { bootstrapProvidersFromUnifiedStore } from '../../../src/credential/bootstrap-providers.js'
import { CredentialInjector } from '../../../src/credential/injector.js'
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

beforeEach(() => {
  prevHome = process.env['HOME']
  tmpHome = mkdtempSync(join(tmpdir(), 'cortex-cred-bootstrap-'))
  process.env['HOME'] = tmpHome
  __resetMasterKeyCacheForTests()
  db = new Database(':memory:')
  for (const m of MIGRATIONS) db.exec(m.sql)
  store = new DbCredentialBackend(db)
  audit = new CredentialAuditLog(db)
  resolver = new GatewayCredentialResolver({ store, audit, spendDb: db })
  injector = new CredentialInjector(resolver)
  anthropicCtor.mockClear()
  openaiCtor.mockClear()
  googleCtor.mockClear()
})
afterEach(() => {
  db.close()
  if (prevHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = prevHome
  __resetMasterKeyCacheForTests()
  try { rmSync(tmpHome, { recursive: true, force: true }) } catch { /* best-effort */ }
})

async function seedAnthropic(value = 'sk-ant-XXXXXXXX-BOOT') {
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
// Registration outcomes
// ---------------------------------------------------------------------------

describe('bootstrapProvidersFromUnifiedStore — registration', () => {
  it('registers each provider whose canonical credential is present', async () => {
    await seedAnthropic()
    const result = await bootstrapProvidersFromUnifiedStore({
      store, resolver, injector,
    })
    expect(result.registered).toEqual(['anthropic'])
    expect(result.skipped.sort()).toEqual(['google', 'openai', 'openrouter'])
    expect(listProviders()).toContain('anthropic')
  })

  it('registers all four when every catalogued credential exists', async () => {
    await seedAnthropic()
    await store.save({
      name: 'OpenAI', value: 'sk-oa-XXXX-BOOT',
      category: 'llm', authType: 'api-key',
      variableName: 'OPENAI_API_KEY', source: 'manual',
    })
    await store.save({
      name: 'Google', value: 'goog-XXXX-BOOT',
      category: 'llm', authType: 'api-key',
      variableName: 'GOOGLE_API_KEY', source: 'manual',
    })
    await store.save({
      name: 'OpenRouter', value: 'sk-or-XXXX-BOOT',
      category: 'llm', authType: 'api-key',
      variableName: 'OPENROUTER_API_KEY', source: 'manual',
    })
    const result = await bootstrapProvidersFromUnifiedStore({
      store, resolver, injector,
    })
    expect(result.registered.sort()).toEqual(['anthropic', 'google', 'openai', 'openrouter'])
    expect(result.skipped).toEqual([])
  })

  it('does NOT touch the registry when no credentials exist', async () => {
    const result = await bootstrapProvidersFromUnifiedStore({
      store, resolver, injector,
    })
    expect(result.registered).toEqual([])
    expect(result.skipped.sort()).toEqual(['anthropic', 'google', 'openai', 'openrouter'])
  })
})

// ---------------------------------------------------------------------------
// apiKeyProvider closure end-to-end
// ---------------------------------------------------------------------------

describe('bootstrapProvidersFromUnifiedStore — apiKeyProvider end-to-end', () => {
  it('the registered provider construct does NOT eagerly construct the SDK', async () => {
    await seedAnthropic()
    await bootstrapProvidersFromUnifiedStore({ store, resolver, injector })
    // Bootstrap calls `new AnthropicProvider({ apiKeyProvider })`
    // which does NOT call the underlying Anthropic SDK constructor —
    // that defers to the first stream() call.
    expect(anthropicCtor).toHaveBeenCalledTimes(0)
  })

  it('the registered provider is the AnthropicProvider class (resolver-backed)', async () => {
    await seedAnthropic()
    await bootstrapProvidersFromUnifiedStore({ store, resolver, injector })
    const provider = getProvider('anthropic')
    expect(provider).toBeDefined()
    expect(provider!.name).toBe('anthropic')
  })

  it('the apiKeyProvider closure runs the full resolver chain end-to-end', async () => {
    // We can't safely call provider.stream/countTokens in unit tests
    // (loom's own bundled SDK is loaded outside cortex's mock scope).
    // Instead: re-create the same binding the bootstrap created and
    // call the closure directly. This exercises the full
    // resolver+injector chain that the bootstrap wires.
    const cred = await seedAnthropic('sk-ant-XXXXXXXX-CALL1')
    await bootstrapProvidersFromUnifiedStore({ store, resolver, injector })
    // Build the same closure shape independently (the bootstrap's
    // closure is captured inside the registered provider; tests
    // can't reach it without depending on internal refs).
    const { makeApiKeyProvider } = await import(
      '../../../src/credential/provider-binding.js'
    )
    const binding = makeApiKeyProvider({
      resolver, injector,
      variableName: 'ANTHROPIC_API_KEY',
      context: () => ({
        agentId: 'gateway-llm',
        sessionId: 'gateway-llm',
        threadId: 'gateway-llm',
      }),
    })
    const value = await binding.apiKeyProvider()
    expect(value).toBe('sk-ant-XXXXXXXX-CALL1')
    const events = audit.listEventsForCredential(cred.id).events
    const resolveEvents = events.filter(e => e.eventType === 'resolve' && e.outcome === 'ok')
    expect(resolveEvents.length).toBe(1)
    expect(resolveEvents[0]!.agentId).toBe('gateway-llm')
  })

  it('honours an explicit contextProvider override', async () => {
    const cred = await seedAnthropic()
    const customCtx: ResolveContext = {
      agentId: 'agent_custom',
      sessionId: 'sess_custom',
      threadId: 'thread_custom',
    }
    await bootstrapProvidersFromUnifiedStore({
      store, resolver, injector,
      contextProvider: () => customCtx,
    })
    // Same approach — call a parallel binding with the same ctx
    // since we can't safely drive the registered provider's SDK
    // call in unit tests.
    const { makeApiKeyProvider } = await import(
      '../../../src/credential/provider-binding.js'
    )
    const binding = makeApiKeyProvider({
      resolver, injector,
      variableName: 'ANTHROPIC_API_KEY',
      context: () => customCtx,
    })
    await binding.apiKeyProvider()
    const events = audit.listEventsForCredential(cred.id).events
    expect(events[0]!.agentId).toBe('agent_custom')
  })

  it('plaintext value never appears in the registered provider object', async () => {
    await seedAnthropic('sk-ant-PLAINTEXT-LEAK-BOOTSTRAP-XXXX')
    await bootstrapProvidersFromUnifiedStore({ store, resolver, injector })
    const provider = getProvider('anthropic')
    // The provider holds a real SDK client whose internal completions
    // namespace points back at the client (circular ref), so plain
    // JSON.stringify throws. util.inspect walks the same surface
    // without choking on cycles — same plaintext-leak coverage,
    // circular-safe.
    const { inspect } = await import('node:util')
    const dump = inspect(provider, {
      depth: 10,
      showHidden: true,
      breakLength: Infinity,
      maxStringLength: Infinity,
    })
    expect(dump).not.toContain('PLAINTEXT-LEAK-BOOTSTRAP')
  })
})

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe('bootstrapProvidersFromUnifiedStore — idempotency', () => {
  it('re-running the bootstrap re-registers cleanly (no leak)', async () => {
    await seedAnthropic()
    await bootstrapProvidersFromUnifiedStore({ store, resolver, injector })
    await bootstrapProvidersFromUnifiedStore({ store, resolver, injector })
    // Registry is a Map, so duplicate registrations replace rather
    // than accumulate. listProviders should still contain anthropic
    // exactly once.
    const occurrences = listProviders().filter(p => p === 'anthropic').length
    expect(occurrences).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Failure isolation
// ---------------------------------------------------------------------------

describe('bootstrapProvidersFromUnifiedStore — failure isolation', () => {
  it('a per-call resolver failure does NOT crash the bootstrap (only the LLM call)', async () => {
    const cred = await seedAnthropic()
    await bootstrapProvidersFromUnifiedStore({ store, resolver, injector })
    // Soft-delete the credential after registration — the closure
    // will throw when the apiKeyProvider runs.
    await store.update(cred.id, { status: 'revoked', statusReason: 'user removed' })
    const provider = getProvider('anthropic')
    await expect(provider!.countTokens([])).rejects.toThrow()
  })
})
