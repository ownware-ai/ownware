/**
 * Unit tests — credential gateway endpoints.
 *
 * Covers:
 *   - POST /threads/:id/credential: validates body, stores value in vault,
 *     resolves HITL, registers handle, returns id+label WITHOUT value.
 *   - POST /threads/:id/credential/deny: resolves HITL with null.
 *   - GET /threads/:id/credential/pending: exposes metadata only.
 *   - 404 when thread has no active session companions.
 *   - 404 when requestId is unknown (timeout-already-resolved).
 *   - Response payload must NOT contain the plaintext value.
 *
 * No HTTP server is started — we drive the handlers directly with mock
 * req/res objects, same pattern as the other `*-handler.test.ts` files.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { GatewayState } from '../../../src/gateway/state.js'
import { createCredentialHandlers } from '../../../src/gateway/handlers/credentials.js'
import { CredentialHITL } from '../../../src/credential/hitl.js'
import { ThreadCredentialRuntime, makeRuntimeCredentialId } from '../../../src/credential/runtime.js'
import {
  CredentialVault,
  __resetMasterKeyCacheForTests,
} from '../../../src/connector/credentials/vault.js'

// ---------------------------------------------------------------------------
// Mock HTTP plumbing
// ---------------------------------------------------------------------------

function mockRequest(body: unknown): IncomingMessage {
  // Router `readBody` does Buffer.concat on the `data` chunks, so the
  // stream MUST emit Buffer (not string). Readable.from('...') emits
  // strings — wrap in a Buffer first.
  const payload = body === undefined ? '' : JSON.stringify(body)
  const stream = Readable.from([Buffer.from(payload, 'utf-8')]) as unknown as IncomingMessage
  return stream
}

interface CapturedResponse {
  statusCode: number
  headers: Record<string, string | number | readonly string[]>
  body: string
}

function mockResponse(): { res: ServerResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = { statusCode: 0, headers: {}, body: '' }
  const res = {
    statusCode: 0,
    headersSent: false,
    writeHead(code: number, headers?: Record<string, string | number | readonly string[]>) {
      captured.statusCode = code
      if (headers) Object.assign(captured.headers, headers)
      ;(res as unknown as { headersSent: boolean }).headersSent = true
      return res
    },
    end(chunk?: string) {
      if (typeof chunk === 'string') captured.body = chunk
      return res
    },
  } as unknown as ServerResponse
  return { res, captured }
}

function parseBody<T>(captured: CapturedResponse): T {
  return JSON.parse(captured.body) as T
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let tmpHome: string
let prevHome: string | undefined
let state: GatewayState
let tmpDataDir: string
let vault: CredentialVault

function buildCompanions(threadId: string): {
  credentialHITL: CredentialHITL
  credentialRuntime: ThreadCredentialRuntime
} {
  const credentialHITL = new CredentialHITL({ timeoutMs: 60_000 })
  // Share the test vault — same instance the handler receives via deps.
  // Without shared-instance wiring, the handler's save would land in a
  // different directory than the runtime reads from, producing a silent
  // divergence that tests can't catch.
  const credentialRuntime = new ThreadCredentialRuntime(threadId, vault)
  return { credentialHITL, credentialRuntime }
}

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'cortex-cred-endpoint-'))
  tmpDataDir = mkdtempSync(join(tmpdir(), 'cortex-cred-endpoint-data-'))
  prevHome = process.env['HOME']
  process.env['HOME'] = tmpHome
  __resetMasterKeyCacheForTests()
  // Isolated vault in the tmp directory. NOT the module-level
  // `credentialVault` — that one is anchored at the user's real
  // `~/.ownware/` at module-load time and would pollute the host.
  vault = new CredentialVault(join(tmpHome, 'credentials'))
  state = new GatewayState(join(tmpDataDir, 'ownware.db'))
})

afterEach(() => {
  state.close()
  if (prevHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = prevHome
  __resetMasterKeyCacheForTests()
  rmSync(tmpHome, { recursive: true, force: true })
  rmSync(tmpDataDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /threads/:threadId/credential', () => {
  it('stores the value in the vault, resolves HITL, returns id + label (no value)', async () => {
    const threadId = 'thr-1'
    const { credentialHITL, credentialRuntime } = buildCompanions(threadId)
    // In a real run, `new HumanInTheLoop()` + zoneManager/etc. are set
    // alongside these — the endpoint handler only touches the credential
    // slots, so the zeros below are fine for this unit test.
    state.setSessionCompanions(threadId, {
      hitl: { dispose: () => undefined } as unknown as SessionCompanionHitl,
      zoneManager: null,
      getLastZoneDecision: () => null,
      credentialHITL,
      credentialRuntime,
    })

    // Kick off a pending request (simulates the loop awaiting a value).
    const pendingPromise = credentialHITL.request({
      requestId: 'req-1',
      label: 'Admin JWT',
      hint: 'devtools',
      usage: 'auth admin',
      placement: { type: 'env', variableName: 'ADMIN_JWT' },
      isRequired: true,
      createdAt: Date.now(),
    })

    const handlers = createCredentialHandlers(state, { vault })
    const { res, captured } = mockResponse()
    await handlers.respond(
      mockRequest({ requestId: 'req-1', value: 'super-secret-jwt-value' }),
      res,
      { threadId },
    )

    expect(captured.statusCode).toBe(200)
    const body = parseBody<{ credentialId: string; label: string; accepted: boolean }>(captured)
    expect(body.credentialId).toBe(makeRuntimeCredentialId(threadId, 'ADMIN_JWT'))
    expect(body.label).toBe('Admin JWT')
    expect(body.accepted).toBe(true)

    // The plaintext value must NEVER appear in the response.
    expect(captured.body).not.toContain('super-secret-jwt-value')

    // HITL promise resolves with the stored handle.
    const handle = await pendingPromise
    expect(handle).not.toBeNull()
    expect(handle!.placement.type).toBe('env')

    // Runtime picks up the handle.
    const entries = credentialRuntime.listEnvCredentials()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.variableName).toBe('ADMIN_JWT')

    // The value is cached so the shell tool's sync resolveValue works.
    expect(credentialRuntime.resolveValue(body.credentialId)).toBe('super-secret-jwt-value')
  })

  it('returns 404 when there is no active session for the thread', async () => {
    const handlers = createCredentialHandlers(state, { vault })
    const { res, captured } = mockResponse()
    await handlers.respond(
      mockRequest({ requestId: 'req-1', value: 'x' }),
      res,
      { threadId: 'thr-404' },
    )
    expect(captured.statusCode).toBe(404)
  })

  it('returns 404 when the requestId is unknown', async () => {
    const threadId = 'thr-2'
    const { credentialHITL, credentialRuntime } = buildCompanions(threadId)
    state.setSessionCompanions(threadId, {
      hitl: { dispose: () => undefined } as unknown as SessionCompanionHitl,
      zoneManager: null,
      getLastZoneDecision: () => null,
      credentialHITL,
      credentialRuntime,
    })

    const handlers = createCredentialHandlers(state, { vault })
    const { res, captured } = mockResponse()
    await handlers.respond(
      mockRequest({ requestId: 'nonexistent', value: 'x' }),
      res,
      { threadId },
    )
    expect(captured.statusCode).toBe(404)
  })

  it('returns 400 on malformed body', async () => {
    const threadId = 'thr-3'
    const { credentialHITL, credentialRuntime } = buildCompanions(threadId)
    state.setSessionCompanions(threadId, {
      hitl: { dispose: () => undefined } as unknown as SessionCompanionHitl,
      zoneManager: null,
      getLastZoneDecision: () => null,
      credentialHITL,
      credentialRuntime,
    })

    const handlers = createCredentialHandlers(state, { vault })
    const missingValue = mockResponse()
    await handlers.respond(
      mockRequest({ requestId: 'req-1' }),
      missingValue.res,
      { threadId },
    )
    expect(missingValue.captured.statusCode).toBe(400)

    const emptyValue = mockResponse()
    await handlers.respond(
      mockRequest({ requestId: 'req-1', value: '' }),
      emptyValue.res,
      { threadId },
    )
    expect(emptyValue.captured.statusCode).toBe(400)
  })
})

describe('POST /threads/:threadId/credential/deny', () => {
  it('resolves the HITL with null and returns denied:true', async () => {
    const threadId = 'thr-deny'
    const { credentialHITL, credentialRuntime } = buildCompanions(threadId)
    state.setSessionCompanions(threadId, {
      hitl: { dispose: () => undefined } as unknown as SessionCompanionHitl,
      zoneManager: null,
      getLastZoneDecision: () => null,
      credentialHITL,
      credentialRuntime,
    })

    const pending = credentialHITL.request({
      requestId: 'rd-1',
      label: 'DB URL',
      hint: 'h',
      usage: 'u',
      placement: { type: 'env', variableName: 'DATABASE_URL' },
      isRequired: true,
      createdAt: Date.now(),
    })

    const handlers = createCredentialHandlers(state, { vault })
    const { res, captured } = mockResponse()
    await handlers.deny(
      mockRequest({ requestId: 'rd-1' }),
      res,
      { threadId },
    )

    expect(captured.statusCode).toBe(200)
    const body = parseBody<{ denied: boolean; label: string }>(captured)
    expect(body.denied).toBe(true)
    expect(body.label).toBe('DB URL')

    expect(await pending).toBeNull()
  })

  it('returns 404 on unknown requestId', async () => {
    const threadId = 'thr-deny-2'
    const { credentialHITL, credentialRuntime } = buildCompanions(threadId)
    state.setSessionCompanions(threadId, {
      hitl: { dispose: () => undefined } as unknown as SessionCompanionHitl,
      zoneManager: null,
      getLastZoneDecision: () => null,
      credentialHITL,
      credentialRuntime,
    })

    const handlers = createCredentialHandlers(state, { vault })
    const { res, captured } = mockResponse()
    await handlers.deny(
      mockRequest({ requestId: 'missing' }),
      res,
      { threadId },
    )
    expect(captured.statusCode).toBe(404)
  })
})

describe('GET /threads/:threadId/credential/pending', () => {
  it('lists pending metadata with no values', async () => {
    const threadId = 'thr-list'
    const { credentialHITL, credentialRuntime } = buildCompanions(threadId)
    state.setSessionCompanions(threadId, {
      hitl: { dispose: () => undefined } as unknown as SessionCompanionHitl,
      zoneManager: null,
      getLastZoneDecision: () => null,
      credentialHITL,
      credentialRuntime,
    })

    void credentialHITL.request({
      requestId: 'a',
      label: 'A',
      hint: '',
      usage: '',
      placement: { type: 'env', variableName: 'A_VAR' },
      isRequired: false,
      createdAt: Date.now(),
    })
    void credentialHITL.request({
      requestId: 'b',
      label: 'B',
      hint: '',
      usage: '',
      placement: { type: 'bearer' },
      isRequired: false,
      createdAt: Date.now(),
    })

    const handlers = createCredentialHandlers(state, { vault })
    const { res, captured } = mockResponse()
    await handlers.list(mockRequest(undefined), res, { threadId })
    expect(captured.statusCode).toBe(200)
    const body = parseBody<{ pending: Array<{ label: string }> }>(captured)
    expect(body.pending).toHaveLength(2)
    const labels = body.pending.map(p => p.label).sort()
    expect(labels).toEqual(['A', 'B'])
    // No `value` field should ever appear in listPending output.
    expect(captured.body).not.toMatch(/"value"/)

    credentialHITL.dispose()
  })
})

// The legacy file-vault-backed `GET /credentials` and
// `DELETE /credentials/:credentialId` handlers (and their tests) have
// been removed in Phase 3 of the credentials-unification board. The
// unified versions live in
// `tests/unit/credential/credential-store-handler.test.ts`.
