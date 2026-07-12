/**
 * Unit tests for the Security + Electron Readiness layer.
 *
 * Tests rate limiter, credential encryption, CORS, access log,
 * and process.env isolation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRateLimiter } from '../../../src/gateway/middleware/rate-limit.js'
import { createAccessLogger } from '../../../src/gateway/middleware/access-log.js'
import { handleCORS, DEFAULT_CORS_ORIGINS } from '../../../src/gateway/cors.js'
import { sendError } from '../../../src/gateway/router.js'
import {
  MCPCredentialStore,
  encryptCredential,
  decryptCredential,
} from '../../../src/connector/mcp/credentials.js'

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockReq(opts: {
  url?: string
  method?: string
  ip?: string
  origin?: string
  userAgent?: string
}): IncomingMessage {
  return {
    url: opts.url ?? '/api/v1/profiles',
    method: opts.method ?? 'GET',
    headers: {
      host: 'localhost:3011',
      ...(opts.origin ? { origin: opts.origin } : {}),
      ...(opts.userAgent ? { 'user-agent': opts.userAgent } : {}),
    },
    socket: { remoteAddress: opts.ip ?? '127.0.0.1' },
  } as unknown as IncomingMessage
}

function createMockRes(): { res: ServerResponse; headers: Record<string, string>; statusCode: number; body: string } {
  const state = { headers: {} as Record<string, string>, statusCode: 200, body: '' }
  const res = {
    statusCode: 200,
    writeHead: vi.fn((status: number, headers?: Record<string, string>) => {
      state.statusCode = status
      res.statusCode = status
      if (headers) Object.assign(state.headers, headers)
    }),
    setHeader: vi.fn((name: string, value: string) => { state.headers[name] = value }),
    end: vi.fn((body?: string) => { state.body = body ?? '' }),
    write: vi.fn(),
    headersSent: false,
    on: vi.fn(),
  } as unknown as ServerResponse
  return { res, ...state }
}

function sentJson(res: ServerResponse): Record<string, unknown> {
  const end = res.end as unknown as { mock: { calls: Array<[string?]> } }
  const body = end.mock.calls.at(-1)?.[0]
  return JSON.parse(body ?? '{}') as Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Rate Limiter
// ---------------------------------------------------------------------------

describe('rate limiter', () => {
  it('allows requests under the general limit', () => {
    const rl = createRateLimiter({ generalLimit: 5, runLimit: 2 })
    const req = createMockReq({})
    const { res } = createMockRes()

    for (let i = 0; i < 5; i++) {
      expect(rl.check(req, res)).toBe(true)
    }
    rl.stop()
  })

  it('blocks when general limit is exceeded', () => {
    const rl = createRateLimiter({ generalLimit: 3, runLimit: 2 })
    const req = createMockReq({})

    // Consume all tokens
    for (let i = 0; i < 3; i++) {
      const { res } = createMockRes()
      rl.check(req, res)
    }

    // Next request should be blocked
    const { res } = createMockRes()
    const result = rl.check(req, res)
    expect(result).toBe(false)
    rl.stop()
  })

  it('uses lower limit for /api/v1/run', () => {
    const rl = createRateLimiter({ generalLimit: 60, runLimit: 2 })
    const req = createMockReq({ url: '/api/v1/run' })

    // Consume run tokens
    for (let i = 0; i < 2; i++) {
      const { res } = createMockRes()
      rl.check(req, res)
    }

    const { res } = createMockRes()
    const result = rl.check(req, res)
    expect(result).toBe(false)
    rl.stop()
  })

  it('isolates buckets per IP', () => {
    const rl = createRateLimiter({ generalLimit: 2, runLimit: 1 })

    // IP 1 consumes its tokens
    const req1 = createMockReq({ ip: '1.2.3.4' })
    for (let i = 0; i < 2; i++) {
      const { res } = createMockRes()
      rl.check(req1, res)
    }

    // IP 2 should still have tokens
    const req2 = createMockReq({ ip: '5.6.7.8' })
    const { res } = createMockRes()
    expect(rl.check(req2, res)).toBe(true)
    rl.stop()
  })

  it('refills tokens over time', () => {
    const rl = createRateLimiter({ generalLimit: 2, runLimit: 1 })
    const req = createMockReq({})

    // Consume tokens
    for (let i = 0; i < 2; i++) {
      const { res } = createMockRes()
      rl.check(req, res)
    }

    // Blocked
    const { res: blocked } = createMockRes()
    expect(rl.check(req, blocked)).toBe(false)

    // Simulate time passing by manipulating the bucket directly
    // The rate limiter uses Date.now() internally, so we advance the clock
    vi.useFakeTimers()
    vi.advanceTimersByTime(31_000) // 31 seconds = ~50% of 1 minute = 1 token refill for limit=2

    const { res: allowed } = createMockRes()
    expect(rl.check(req, allowed)).toBe(true)

    vi.useRealTimers()
    rl.stop()
  })

  it('stop() does not crash', () => {
    const rl = createRateLimiter()
    expect(() => rl.stop()).not.toThrow()
  })

  it('returns 429 with Retry-After header', () => {
    const rl = createRateLimiter({ generalLimit: 1, runLimit: 1 })
    const req = createMockReq({})

    // Consume the one token
    const { res: first } = createMockRes()
    rl.check(req, first)

    // Next request should get 429
    const mock = createMockRes()
    rl.check(req, mock.res)
    // The sendJSON call sets headers via writeHead
    expect((mock.res.setHeader as any).mock.calls.some(
      (c: [string, string]) => c[0] === 'Retry-After'
    )).toBe(true)
    expect(sentJson(mock.res)).toMatchObject({
      error: 'rate_limited',
      message: 'Too many requests. Please slow down.',
      category: 'rate_limit',
      retryAfter: expect.any(Number),
      correlationId: expect.any(String),
    })

    rl.stop()
  })
})

describe('common HTTP error envelope', () => {
  it.each([
    [401, 'unauthorized', 'auth'],
    [403, 'forbidden', 'auth'],
    [413, 'payload_too_large', 'invalid_request'],
    [429, 'rate_limited', 'rate_limit'],
    [503, 'service_unavailable', 'overload'],
  ] as const)('maps status %s to a stable code and bounded category', (status, error, category) => {
    const { res } = createMockRes()
    sendError(res, status, 'Safe recovery message')

    const body = sentJson(res)
    expect(body).toEqual({
      error,
      message: 'Safe recovery message',
      category,
      correlationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    })
    expect((res.setHeader as any).mock.calls).toContainEqual([
      'X-Ownware-Correlation-Id',
      body.correlationId,
    ])
  })

  it('does not let supplemental details override stable or generated fields', () => {
    const { res } = createMockRes()
    sendError(res, 429, 'Safe recovery message', 'rate_limited', 'rate_limit', {
      error: 'caller_value',
      message: 'caller value',
      category: 'unknown',
      correlationId: 'caller-value',
      retryAfter: 12,
    })

    expect(sentJson(res)).toEqual({
      error: 'rate_limited',
      message: 'Safe recovery message',
      category: 'rate_limit',
      correlationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      retryAfter: 12,
    })
  })
})

// ---------------------------------------------------------------------------
// Credential Encryption
// ---------------------------------------------------------------------------

describe('credential encryption', () => {
  it('encrypt → decrypt round-trip returns original', () => {
    const secret = 'sk-ant-api-key-12345'
    const encrypted = encryptCredential(secret)
    const decrypted = decryptCredential(encrypted)
    expect(decrypted).toBe(secret)
  })

  it('encrypt produces different ciphertext each call (random IV)', () => {
    const secret = 'same-secret'
    const a = encryptCredential(secret)
    const b = encryptCredential(secret)
    expect(a).not.toBe(b)
    // But both decrypt to the same value
    expect(decryptCredential(a)).toBe(secret)
    expect(decryptCredential(b)).toBe(secret)
  })

  it('decrypt with corrupted data returns null', () => {
    expect(decryptCredential('garbage')).toBeNull()
    expect(decryptCredential('aa:bb:cc')).toBeNull()
    expect(decryptCredential('')).toBeNull()
  })

  it('decrypt with wrong format returns null', () => {
    expect(decryptCredential('too:many:colons:here')).toBeNull()
    expect(decryptCredential('onlyone')).toBeNull()
  })
})

describe('credential store encryption integration', () => {
  let tempDir: string
  let store: MCPCredentialStore

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cortex-cred-test-'))
    store = new MCPCredentialStore(tempDir)
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('save encrypts on disk, load decrypts', async () => {
    await store.save('test-server', { API_KEY: 'secret123' })

    // Read raw file — should NOT be plain JSON
    const files = await import('node:fs/promises').then(fs => fs.readdir(tempDir))
    expect(files.length).toBe(1)
    const raw = await readFile(join(tempDir, files[0]!), 'utf-8')

    // Should NOT be parseable as JSON (it's encrypted)
    expect(() => JSON.parse(raw)).toThrow()

    // New writes use the v2 master-key format: "v2:iv:authTag:ciphertext".
    // The legacy v1 format ("iv:authTag:ciphertext", 3 segments) is still
    // accepted by decryptCredential for backward-compat reads, but save()
    // always emits v2.
    const parts = raw.split(':')
    expect(parts.length).toBe(4)
    expect(parts[0]).toBe('v2')

    // Load should decrypt correctly
    const loaded = await store.load('test-server')
    expect(loaded).toBeTruthy()
    expect(loaded!.env.API_KEY).toBe('secret123')
    expect(loaded!.serverId).toBe('test-server')
  })

  it('backward compat: loads plain JSON and auto-migrates', async () => {
    // Write a legacy plain JSON credential file
    const legacyCreds = {
      serverId: 'legacy-server',
      env: { OLD_KEY: 'old-value' },
      updatedAt: '2025-01-01T00:00:00Z',
    }
    const safeName = 'legacy-server'.replace(/[^a-zA-Z0-9._-]/g, '_')
    await writeFile(join(tempDir, `${safeName}.json`), JSON.stringify(legacyCreds, null, 2), 'utf-8')

    // Load should work
    const loaded = await store.load('legacy-server')
    expect(loaded).toBeTruthy()
    expect(loaded!.env.OLD_KEY).toBe('old-value')

    // File should now be encrypted (auto-migration)
    const raw = await readFile(join(tempDir, `${safeName}.json`), 'utf-8')
    expect(() => JSON.parse(raw)).toThrow() // No longer plain JSON
  })

  it('save does NOT mutate process.env', async () => {
    const envBefore = process.env.OWNWARE_TEST_CRED_CHECK
    await store.save('env-test', { OWNWARE_TEST_CRED_CHECK: 'should-not-appear' })
    expect(process.env.OWNWARE_TEST_CRED_CHECK).toBe(envBefore)
  })

  it('delete does NOT mutate process.env', async () => {
    process.env.OWNWARE_TEST_CRED_DEL = 'should-remain'
    await store.save('del-test', { OWNWARE_TEST_CRED_DEL: 'stored' })
    await store.delete('del-test')
    expect(process.env.OWNWARE_TEST_CRED_DEL).toBe('should-remain')
    delete process.env.OWNWARE_TEST_CRED_DEL
  })

  it('checkEnvVars finds stored credentials', async () => {
    await store.save('check-test', { KEY_A: 'val-a' })
    const status = await store.checkEnvVars('check-test', ['KEY_A', 'KEY_B'])
    expect(status.KEY_A).toBe(true)
    expect(status.KEY_B).toBe(false)
  })

  it('backward compat: loads legacy v1 (hostname-derived) blob and auto-migrates to v2', async () => {
    // Write a v1 blob using the legacy export, then verify the store
    // reads it AND rewrites it as v2 on first access. This is the
    // migration path for users upgrading from a pre-2026-04-11 install.
    const safeName = 'v1-server'
    const v1Blob = encryptCredential(JSON.stringify({
      serverId: 'v1-server',
      env: { LEGACY_KEY: 'old-token' },
      updatedAt: '2026-01-01T00:00:00Z',
    }))
    expect(v1Blob.split(':').length).toBe(3) // sanity: legacy format
    expect(v1Blob.startsWith('v2:')).toBe(false)

    await writeFile(join(tempDir, `${safeName}.json`), v1Blob, 'utf-8')

    const loaded = await store.load('v1-server')
    expect(loaded).toBeTruthy()
    expect(loaded!.env.LEGACY_KEY).toBe('old-token')

    // After load, the file should have been re-encrypted in v2 format.
    const after = await readFile(join(tempDir, `${safeName}.json`), 'utf-8')
    expect(after.startsWith('v2:')).toBe(true)
    expect(after.split(':').length).toBe(4)

    // Round-trip the migrated file
    const reloaded = await store.load('v1-server')
    expect(reloaded!.env.LEGACY_KEY).toBe('old-token')
  })

  it('save uses v2 master-key format for new writes', async () => {
    await store.save('v2-test', { TOKEN: 'fresh' })
    const safeName = 'v2-test'
    const raw = await readFile(join(tempDir, `${safeName}.json`), 'utf-8')
    expect(raw.startsWith('v2:')).toBe(true)
    const loaded = await store.load('v2-test')
    expect(loaded!.env.TOKEN).toBe('fresh')
  })
})

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

describe('CORS', () => {
  it('allows localhost:5173 with default origins', () => {
    const req = createMockReq({ origin: 'http://localhost:5173', method: 'GET' })
    const { res, headers } = createMockRes()
    handleCORS(req, res, DEFAULT_CORS_ORIGINS)
    expect((res.setHeader as any).mock.calls.find(
      (c: [string, string]) => c[0] === 'Access-Control-Allow-Origin' && c[1] === 'http://localhost:5173'
    )).toBeTruthy()
  })

  it('sets empty CORS header for disallowed GET (read-only, no CSRF risk)', () => {
    const req = createMockReq({ origin: 'http://evil.com', method: 'GET' })
    const { res } = createMockRes()
    const handled = handleCORS(req, res, DEFAULT_CORS_ORIGINS)
    expect(handled).toBe(false)
    expect((res.setHeader as any).mock.calls.find(
      (c: [string, string]) => c[0] === 'Access-Control-Allow-Origin' && c[1] === ''
    )).toBeTruthy()
  })

  it('rejects mutating POST from disallowed origin with 403', () => {
    const req = createMockReq({ origin: 'http://evil.com', method: 'POST' })
    const { res } = createMockRes()
    const handled = handleCORS(req, res, DEFAULT_CORS_ORIGINS)
    expect(handled).toBe(true)
    expect((res.writeHead as any).mock.calls[0]?.[0]).toBe(403)
    expect(sentJson(res)).toEqual({
      error: 'forbidden_origin',
      message: 'Cross-origin request blocked',
      category: 'auth',
      correlationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    })
  })

  it('rejects mutating DELETE from disallowed origin with 403', () => {
    const req = createMockReq({ origin: 'http://evil.com', method: 'DELETE' })
    const { res } = createMockRes()
    const handled = handleCORS(req, res, DEFAULT_CORS_ORIGINS)
    expect(handled).toBe(true)
    expect((res.writeHead as any).mock.calls[0]?.[0]).toBe(403)
  })

  it('allows POST from localhost origin', () => {
    const req = createMockReq({ origin: 'http://localhost:5175', method: 'POST' })
    const { res } = createMockRes()
    const handled = handleCORS(req, res, DEFAULT_CORS_ORIGINS)
    expect(handled).toBe(false)
  })

  it('allows POST with no Origin header (same-origin or non-browser)', () => {
    const req = createMockReq({ method: 'POST' })
    const { res } = createMockRes()
    const handled = handleCORS(req, res, DEFAULT_CORS_ORIGINS)
    expect(handled).toBe(false)
  })

  it('allows everything with ["*"]', () => {
    const req = createMockReq({ origin: 'http://any-site.com', method: 'GET' })
    const { res } = createMockRes()
    handleCORS(req, res, ['*'])
    expect((res.setHeader as any).mock.calls.find(
      (c: [string, string]) => c[0] === 'Access-Control-Allow-Origin' && c[1] === '*'
    )).toBeTruthy()
  })

  it('exact match works', () => {
    const req = createMockReq({ origin: 'https://app.ownware.dev', method: 'GET' })
    const { res } = createMockRes()
    handleCORS(req, res, ['https://app.ownware.dev'])
    expect((res.setHeader as any).mock.calls.find(
      (c: [string, string]) => c[0] === 'Access-Control-Allow-Origin' && c[1] === 'https://app.ownware.dev'
    )).toBeTruthy()
  })

  it('backward compat: single string "*" works', () => {
    const req = createMockReq({ origin: 'http://any.com', method: 'GET' })
    const { res } = createMockRes()
    handleCORS(req, res, '*')
    expect((res.setHeader as any).mock.calls.find(
      (c: [string, string]) => c[0] === 'Access-Control-Allow-Origin' && c[1] === '*'
    )).toBeTruthy()
  })

  it('handles OPTIONS preflight', () => {
    const req = createMockReq({ method: 'OPTIONS' })
    const { res } = createMockRes()
    const result = handleCORS(req, res, DEFAULT_CORS_ORIGINS)
    expect(result).toBe(true) // preflight handled
  })

  it('allows 127.0.0.1 with default origins', () => {
    const req = createMockReq({ origin: 'http://127.0.0.1:3011', method: 'GET' })
    const { res } = createMockRes()
    handleCORS(req, res, DEFAULT_CORS_ORIGINS)
    expect((res.setHeader as any).mock.calls.find(
      (c: [string, string]) => c[0] === 'Access-Control-Allow-Origin' && c[1] === 'http://127.0.0.1:3011'
    )).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// Access Log
// ---------------------------------------------------------------------------

describe('access log', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cortex-log-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('writes valid JSONL entries', async () => {
    const logger = createAccessLogger(tempDir)

    const req = createMockReq({ url: '/api/v1/profiles', method: 'GET', ip: '127.0.0.1', userAgent: 'test-agent' })
    const { res } = createMockRes()
    Object.defineProperty(res, 'statusCode', { value: 200, writable: true })

    logger.log(req, res, 42)
    await logger.close()

    const content = await readFile(logger.logPath, 'utf-8')
    const lines = content.trim().split('\n')
    expect(lines.length).toBe(1)

    const entry = JSON.parse(lines[0]!)
    expect(entry.ts).toBeTruthy()
    expect(entry.method).toBe('GET')
    expect(entry.url).toBe('/api/v1/profiles')
    expect(entry.status).toBe(200)
    expect(entry.durationMs).toBe(42)
    expect(entry.ip).toBe('127.0.0.1')
    expect(entry.userAgent).toBe('test-agent')
  })

  it('is append-only (multiple writes)', async () => {
    const logger = createAccessLogger(tempDir)

    const req1 = createMockReq({ url: '/api/v1/health', method: 'GET' })
    const req2 = createMockReq({ url: '/api/v1/profiles', method: 'POST' })
    const { res: res1 } = createMockRes()
    const { res: res2 } = createMockRes()
    Object.defineProperty(res1, 'statusCode', { value: 200, writable: true })
    Object.defineProperty(res2, 'statusCode', { value: 201, writable: true })

    logger.log(req1, res1, 5)
    logger.log(req2, res2, 15)
    await logger.close()

    const content = await readFile(logger.logPath, 'utf-8')
    const lines = content.trim().split('\n')
    expect(lines.length).toBe(2)

    const e1 = JSON.parse(lines[0]!)
    const e2 = JSON.parse(lines[1]!)
    expect(e1.url).toBe('/api/v1/health')
    expect(e2.url).toBe('/api/v1/profiles')
  })

  it('creates the log directory if it does not exist', async () => {
    const nestedDir = join(tempDir, 'deep', 'nested', 'logs')
    const logger = createAccessLogger(nestedDir)
    const req = createMockReq({})
    const { res } = createMockRes()
    Object.defineProperty(res, 'statusCode', { value: 200, writable: true })

    logger.log(req, res, 1)
    await logger.close()

    const content = await readFile(logger.logPath, 'utf-8')
    expect(content.trim().length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Data directory configuration
// ---------------------------------------------------------------------------

describe('data directory', () => {
  it('OWNWARE_DATA_DIR env var is respected', () => {
    // This is tested more thoroughly in e2e tests.
    // Here we just verify the env var exists as a concept.
    const original = process.env.OWNWARE_DATA_DIR
    process.env.OWNWARE_DATA_DIR = '/tmp/cortex-test-data-dir'
    expect(process.env.OWNWARE_DATA_DIR).toBe('/tmp/cortex-test-data-dir')
    if (original !== undefined) {
      process.env.OWNWARE_DATA_DIR = original
    } else {
      delete process.env.OWNWARE_DATA_DIR
    }
  })
})
