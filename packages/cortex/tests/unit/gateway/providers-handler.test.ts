/**
 * Unit tests — `createProviderHandlers().listProviders`.
 *
 * Pins the wire contract for `GET /api/v1/providers` after the rebuild
 * for accuracy-audit BUG #22:
 *
 *   - Exactly one row per known LLM provider in the cortex catalogue
 *     (`LLM_PROVIDERS`), never per saved credential.
 *   - Each row carries `available: boolean` sourced from the Loom
 *     adapter factory map (`PROVIDER_ADAPTER_IDS`). False = the engine
 *     can't call this provider in this build; the client greys the card.
 *   - Each row carries `configured: boolean` indicating whether the
 *     user has saved a credential. `keyHint` / `createdAt` /
 *     `updatedAt` are populated iff `configured: true`.
 *   - Provider-id order matches `LLM_PROVIDERS` so the client's display
 *     order is stable across builds.
 */

import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

// Mock the LLM SDKs to dodge real network / env var lookups. The
// handler under test never streams; these are insurance for any code
// path bootstrap may invoke when wiring `refreshProviderRegistry`.
vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    constructor(_opts: { apiKey?: string }) {}
    messages = { stream: vi.fn(), countTokens: vi.fn(() => ({ input_tokens: 0 })) }
  },
}))
vi.mock('openai', () => ({
  default: class MockOpenAI {
    constructor(_opts: { apiKey?: string }) {}
    chat = { completions: { create: vi.fn() } }
  },
}))
vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: class MockGoogle {
    constructor(_apiKey: string) {}
    getGenerativeModel = vi.fn(() => ({ countTokens: vi.fn(() => ({ totalTokens: 0 })) }))
  },
}))

import { CredentialAuditLog } from '../../../src/credential/audit.js'
import { CredentialInjector } from '../../../src/credential/injector.js'
import { GatewayCredentialResolver } from '../../../src/credential/resolver.js'
import { createSqliteCredentialSpendRepository } from '../../../src/storage/sqlite-security-repositories.js'
import { DbCredentialBackend } from '../../../src/credential/store/db-backend.js'
import { __resetMasterKeyCacheForTests } from '../../../src/connector/credentials/vault.js'
import { MIGRATIONS } from '../../../src/gateway/db/schema.js'
import {
  createProviderHandlers,
  testProviderKey,
} from '../../../src/gateway/handlers/providers.js'
import { LLM_PROVIDERS } from '../../../src/gateway/llm-providers.js'

interface CapturedResponse {
  status?: number
  body?: unknown
}

function fakeRes(captured: CapturedResponse): ServerResponse {
  const res = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    setHeader(k: string, v: string) { this.headers[k] = v },
    writeHead(code: number) {
      captured.status = code
      this.statusCode = code
    },
    end(body?: string) {
      captured.status ??= this.statusCode
      if (body) captured.body = JSON.parse(body)
    },
    write() { /* noop */ },
  } as unknown as ServerResponse
  return res
}

const fakeReq = {} as unknown as IncomingMessage

interface ProviderRow {
  provider: string
  available: boolean
  configured: boolean
  keyHint?: string
  createdAt?: string
  updatedAt?: string
}

let prevHome: string | undefined
let tmpHome: string
let db: Database.Database
let store: DbCredentialBackend
let audit: CredentialAuditLog
let resolver: GatewayCredentialResolver
let injector: CredentialInjector

beforeEach(() => {
  prevHome = process.env['HOME']
  tmpHome = mkdtempSync(join(tmpdir(), 'cortex-providers-handler-'))
  process.env['HOME'] = tmpHome
  __resetMasterKeyCacheForTests()
  db = new Database(':memory:')
  for (const m of MIGRATIONS) db.exec(m.sql)
  store = new DbCredentialBackend(db)
  audit = new CredentialAuditLog(db)
  resolver = new GatewayCredentialResolver({
    store,
    audit,
    spend: createSqliteCredentialSpendRepository(db),
  })
  injector = new CredentialInjector(resolver)
})

afterEach(() => {
  vi.restoreAllMocks()
  db.close()
  if (prevHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = prevHome
  __resetMasterKeyCacheForTests()
  try { rmSync(tmpHome, { recursive: true, force: true }) } catch { /* best-effort */ }
})

async function callListProviders(): Promise<ProviderRow[]> {
  const handlers = createProviderHandlers({ store, resolver, injector, audit })
  const captured: CapturedResponse = {}
  await handlers.listProviders(fakeReq, fakeRes(captured))
  expect(captured.status).toBe(200)
  expect(Array.isArray(captured.body)).toBe(true)
  return captured.body as ProviderRow[]
}

describe('GET /api/v1/providers — catalogue-wide shape', () => {
  it('returns one row per known LLM provider regardless of saved credentials', async () => {
    const rows = await callListProviders()
    // Pre-fix the handler returned `credentials.map(...)` which yielded
    // an EMPTY array when no key was saved. After the fix every
    // catalogued provider shows up so the client can render its card.
    expect(rows.map((r) => r.provider)).toEqual(LLM_PROVIDERS.map((d) => d.providerId))
  })

  it('marks every provider available=true when every descriptor has a shipped adapter', async () => {
    const rows = await callListProviders()
    for (const row of rows) {
      expect(row.available).toBe(true)
    }
  })

  it('marks every provider configured=false when the store is empty', async () => {
    const rows = await callListProviders()
    for (const row of rows) {
      expect(row.configured).toBe(false)
      expect(row.keyHint).toBeUndefined()
      expect(row.createdAt).toBeUndefined()
      expect(row.updatedAt).toBeUndefined()
    }
  })

  it('marks a provider configured=true ONLY when its credential is saved', async () => {
    await store.save({
      name: 'Anthropic API Key',
      value: 'sk-ant-XXXXXXXX-T22',
      category: 'llm',
      authType: 'api-key',
      variableName: 'ANTHROPIC_API_KEY',
      source: 'manual',
    })
    const rows = await callListProviders()
    const anthropic = rows.find((r) => r.provider === 'anthropic')
    const openai = rows.find((r) => r.provider === 'openai')
    expect(anthropic?.configured).toBe(true)
    expect(typeof anthropic?.keyHint).toBe('string')
    expect(typeof anthropic?.createdAt).toBe('string')
    expect(typeof anthropic?.updatedAt).toBe('string')
    expect(openai?.configured).toBe(false)
    expect(openai?.keyHint).toBeUndefined()
  })
})

describe('POST /api/v1/providers/validate — compatible presets', () => {
  it('validates a fixed preset only against its server-owned models endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    )

    const result = await testProviderKey('groq', 'gsk_secret_fixture')

    expect(result).toEqual({ provider: 'groq', isValid: true })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.groq.com/openai/v1/models',
      expect.objectContaining({
        method: 'GET',
        headers: { Authorization: 'Bearer gsk_secret_fixture' },
      }),
    )
  })

  it('keeps auth rejection and upstream failures distinct without returning a body', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('secret upstream detail', { status: 401 }))
      .mockResolvedValueOnce(new Response('secret upstream detail', { status: 503 }))

    await expect(testProviderKey('mistral', 'bad-key')).resolves.toEqual({
      provider: 'mistral', isValid: false, error: 'Invalid API key',
    })
    await expect(testProviderKey('mistral', 'maybe-key')).resolves.toEqual({
      provider: 'mistral',
      isValid: false,
      error: 'Provider validation endpoint returned status 503',
    })
  })

  it('does not surface transport errors that may contain endpoint or credential data', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('request to https://example.invalid/?key=secret failed'),
    )

    await expect(testProviderKey('cerebras', 'secret')).resolves.toEqual({
      provider: 'cerebras', isValid: false, error: 'Validation request failed',
    })
  })

  it('does not pretend a public model list validates a router credential', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')

    await expect(testProviderKey('vercel', 'not-tested')).resolves.toEqual({
      provider: 'vercel',
      isValid: false,
      error: 'Credential validation is unavailable without a billable inference request',
    })
    await expect(testProviderKey('helicone', 'not-tested')).resolves.toEqual({
      provider: 'helicone',
      isValid: false,
      error: 'Credential validation is unavailable without a billable inference request',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
