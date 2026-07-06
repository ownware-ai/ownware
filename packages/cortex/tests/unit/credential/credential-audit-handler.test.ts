/**
 * Unit tests — audit / cost / usage / approve handlers (Phase 5).
 *
 * Three groups:
 *   - GET /:id/audit  — paginated listing of audit rows
 *   - GET /:id/cost   — daily-bucket cost rollup
 *   - GET /:id/usage  — top consumers + call count
 *   - POST /:id/approve — trust-gate response (signature verified)
 *
 * Plus: validate + reveal + create + update + delete handlers now
 * write audit rows. The store-handler test file pins the wire-shape
 * behaviour; this file pins the audit-write side effect.
 */

import Database from 'better-sqlite3'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest'
import { CredentialAuditLog } from '../../../src/credential/audit.js'
import { __resetMasterKeyCacheForTests } from '../../../src/connector/credentials/vault.js'
import { DbCredentialBackend } from '../../../src/credential/store/db-backend.js'
import { TrustGate, type ApprovalRequiredEvent } from '../../../src/credential/trust-gate.js'
import {
  createCredentialAuditHandlers,
  createCredentialStoreHandlers,
} from '../../../src/gateway/handlers/credential-store.js'
import { MIGRATIONS } from '../../../src/gateway/db/schema.js'

// ---------------------------------------------------------------------------
// Mock req/res
// ---------------------------------------------------------------------------

function mockRequest(url: string, body?: unknown): IncomingMessage {
  const payload = body === undefined ? '' : JSON.stringify(body)
  const stream = Readable.from([Buffer.from(payload, 'utf-8')]) as unknown as IncomingMessage
  ;(stream as unknown as { url: string }).url = url
  ;(stream as unknown as { headers: Record<string, string> }).headers = { host: 'localhost' }
  ;(stream as unknown as { method: string }).method = body === undefined ? 'GET' : 'POST'
  return stream
}

interface CapturedResponse {
  statusCode: number
  body: string
}

function mockResponse(): { res: ServerResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = { statusCode: 0, body: '' }
  const res = {
    statusCode: 0,
    headersSent: false,
    writeHead(code: number) {
      captured.statusCode = code
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

let prevHome: string | undefined
let tmpHome: string
let db: Database.Database
let store: DbCredentialBackend
let audit: CredentialAuditLog
let trustGate: TrustGate
let storeHandlers: ReturnType<typeof createCredentialStoreHandlers>
let auditHandlers: ReturnType<typeof createCredentialAuditHandlers>
let credentialId: string

beforeEach(async () => {
  prevHome = process.env['HOME']
  tmpHome = mkdtempSync(join(tmpdir(), 'cortex-cred-aud-handler-'))
  process.env['HOME'] = tmpHome
  __resetMasterKeyCacheForTests()
  db = new Database(':memory:')
  for (const m of MIGRATIONS) db.exec(m.sql)
  store = new DbCredentialBackend(db)
  audit = new CredentialAuditLog(db)
  trustGate = new TrustGate()
  storeHandlers = createCredentialStoreHandlers(store, { audit, trustGate })
  auditHandlers = createCredentialAuditHandlers(store, audit)

  const cred = await store.save({
    name: 'Anthropic',
    value: 'sk-ant-XXXXXXXX-HM8A',
    category: 'llm',
    authType: 'api-key',
    variableName: 'ANTHROPIC_API_KEY',
    source: 'manual',
  })
  credentialId = cred.id
})

afterEach(() => {
  db.close()
  if (prevHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = prevHome
  __resetMasterKeyCacheForTests()
  try { rmSync(tmpHome, { recursive: true, force: true }) } catch { /* best-effort */ }
})

// ---------------------------------------------------------------------------
// GET /credentials/:id/audit
// ---------------------------------------------------------------------------

describe('GET /api/v1/credentials/:id/audit', () => {
  it('returns the audit rows for a credential, newest first', async () => {
    audit.recordEvent({ credentialId, eventType: 'reveal', outcome: 'ok' })
    // Sub-millisecond inserts tie on `created_at` and the tiebreaker
    // (id DESC) is non-deterministic since ids are random UUIDs. A
    // small wait pushes the second insert into a later millisecond
    // bucket so the newest-first ordering is stable.
    await new Promise(r => setTimeout(r, 5))
    audit.recordEvent({ credentialId, eventType: 'validate', outcome: 'ok' })
    const { res, captured } = mockResponse()
    await auditHandlers.listAudit(
      mockRequest(`/api/v1/credentials/${credentialId}/audit`),
      res,
      { id: credentialId },
    )
    expect(captured.statusCode).toBe(200)
    const body = parseBody<{ events: { eventType: string }[]; total: number }>(captured)
    expect(body.total).toBe(2)
    expect(body.events[0]!.eventType).toBe('validate')
  })

  it('honours ?limit= and ?offset= query params', async () => {
    for (let i = 0; i < 5; i++) {
      audit.recordEvent({ credentialId, eventType: 'reveal', outcome: 'ok' })
    }
    const { res, captured } = mockResponse()
    await auditHandlers.listAudit(
      mockRequest(`/api/v1/credentials/${credentialId}/audit?limit=2&offset=2`),
      res,
      { id: credentialId },
    )
    const body = parseBody<{ events: unknown[]; total: number }>(captured)
    expect(body.events.length).toBe(2)
    expect(body.total).toBe(5)
  })

  it('returns 404 for an unknown credential id', async () => {
    const { res, captured } = mockResponse()
    await auditHandlers.listAudit(
      mockRequest('/api/v1/credentials/cred_000000000000/audit'),
      res,
      { id: 'cred_000000000000' },
    )
    expect(captured.statusCode).toBe(404)
  })

  it('returns 400 for a malformed credential id', async () => {
    const { res, captured } = mockResponse()
    await auditHandlers.listAudit(
      mockRequest('/api/v1/credentials/garbage/audit'),
      res,
      { id: 'garbage' },
    )
    expect(captured.statusCode).toBe(400)
  })

  it('returns 400 on non-numeric limit', async () => {
    const { res, captured } = mockResponse()
    await auditHandlers.listAudit(
      mockRequest(`/api/v1/credentials/${credentialId}/audit?limit=abc`),
      res,
      { id: credentialId },
    )
    expect(captured.statusCode).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// GET /credentials/:id/cost
// ---------------------------------------------------------------------------

describe('GET /api/v1/credentials/:id/cost', () => {
  it('returns daily buckets + totals', async () => {
    audit.recordEvent({
      credentialId, eventType: 'resolve', outcome: 'ok',
      estimatedCostUsd: 0.05, actualCostUsd: 0.07,
    })
    const { res, captured } = mockResponse()
    await auditHandlers.cost(
      mockRequest(`/api/v1/credentials/${credentialId}/cost`),
      res,
      { id: credentialId },
    )
    expect(captured.statusCode).toBe(200)
    const body = parseBody<{
      buckets: { date: string; estimatedUsd: number; actualUsd: number }[]
      totalEstimatedUsd: number
      totalActualUsd: number
    }>(captured)
    expect(body.buckets.length).toBe(1)
    expect(body.totalEstimatedUsd).toBeCloseTo(0.05, 5)
    expect(body.totalActualUsd).toBeCloseTo(0.07, 5)
  })

  it('honours ?since= window', async () => {
    audit.recordEvent({
      credentialId, eventType: 'resolve', outcome: 'ok',
      estimatedCostUsd: 0.05, actualCostUsd: 0.07,
    })
    const future = new Date(Date.now() + 60_000).toISOString()
    const { res, captured } = mockResponse()
    await auditHandlers.cost(
      mockRequest(`/api/v1/credentials/${credentialId}/cost?since=${encodeURIComponent(future)}`),
      res,
      { id: credentialId },
    )
    const body = parseBody<{ buckets: unknown[]; totalActualUsd: number }>(captured)
    expect(body.buckets).toEqual([])
    expect(body.totalActualUsd).toBe(0)
  })

  it('returns 400 on a malformed since param', async () => {
    const { res, captured } = mockResponse()
    await auditHandlers.cost(
      mockRequest(`/api/v1/credentials/${credentialId}/cost?since=not-a-date`),
      res,
      { id: credentialId },
    )
    expect(captured.statusCode).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// GET /credentials/:id/usage
// ---------------------------------------------------------------------------

describe('GET /api/v1/credentials/:id/usage', () => {
  it('returns total + top consumers grouped by tool name', async () => {
    audit.recordEvent({
      credentialId, eventType: 'resolve', outcome: 'ok', toolName: 'shell',
    })
    audit.recordEvent({
      credentialId, eventType: 'resolve', outcome: 'ok', toolName: 'shell',
    })
    audit.recordEvent({
      credentialId, eventType: 'resolve', outcome: 'ok', toolName: 'fetch',
    })
    const { res, captured } = mockResponse()
    await auditHandlers.usage(
      mockRequest(`/api/v1/credentials/${credentialId}/usage`),
      res,
      { id: credentialId },
    )
    const body = parseBody<{
      totalCalls: number
      topConsumers: { key: string; count: number }[]
    }>(captured)
    expect(body.totalCalls).toBe(3)
    expect(body.topConsumers).toEqual([
      { key: 'shell', count: 2 },
      { key: 'fetch', count: 1 },
    ])
  })
})

// ---------------------------------------------------------------------------
// POST /credentials/:id/approve
// ---------------------------------------------------------------------------

describe('POST /api/v1/credentials/:id/approve', () => {
  it('resolves a pending trust-gate request with the signed body', async () => {
    let captured: ApprovalRequiredEvent | null = null
    trustGate.onApprovalRequired(e => { captured = e })
    const promise = trustGate.requestApproval({ credentialId })
    expect(captured).not.toBeNull()
    const { res, captured: cap } = mockResponse()
    await storeHandlers.approve(
      mockRequest(`/api/v1/credentials/${credentialId}/approve`, {
        requestId: captured!.requestId,
        decision: 'granted',
        signature: captured!.signature,
      }),
      res,
      { id: credentialId },
    )
    expect(cap.statusCode).toBe(200)
    await expect(promise).resolves.toBe('granted')
  })

  it('records an approval_granted audit row on success', async () => {
    let captured: ApprovalRequiredEvent | null = null
    trustGate.onApprovalRequired(e => { captured = e })
    void trustGate.requestApproval({ credentialId })
    const { res } = mockResponse()
    await storeHandlers.approve(
      mockRequest(`/api/v1/credentials/${credentialId}/approve`, {
        requestId: captured!.requestId,
        decision: 'granted',
        signature: captured!.signature,
      }),
      res,
      { id: credentialId },
    )
    const { events } = audit.listEventsForCredential(credentialId)
    expect(events[0]!.eventType).toBe('approval_granted')
  })

  it('returns 404 + no audit on a forged signature', async () => {
    let captured: ApprovalRequiredEvent | null = null
    trustGate.onApprovalRequired(e => { captured = e })
    void trustGate.requestApproval({ credentialId })
    const tampered = captured!.signature.replace(/.$/, c => (c === '0' ? '1' : '0'))
    const { res, captured: cap } = mockResponse()
    await storeHandlers.approve(
      mockRequest(`/api/v1/credentials/${credentialId}/approve`, {
        requestId: captured!.requestId,
        decision: 'granted',
        signature: tampered,
      }),
      res,
      { id: credentialId },
    )
    expect(cap.statusCode).toBe(404)
    expect(audit.listEventsForCredential(credentialId).total).toBe(0)
  })

  it('returns 503 when trust gate is not configured', async () => {
    const noGate = createCredentialStoreHandlers(store, { audit })
    const { res, captured } = mockResponse()
    await noGate.approve(
      mockRequest(`/api/v1/credentials/${credentialId}/approve`, {
        requestId: 'apv_000000000000',
        decision: 'granted',
        signature: '0'.repeat(64),
      }),
      res,
      { id: credentialId },
    )
    expect(captured.statusCode).toBe(503)
  })
})

// ---------------------------------------------------------------------------
// Audit side-effects on the existing handlers
// ---------------------------------------------------------------------------

describe('audit side-effects on validate/reveal/create/update/delete', () => {
  it('reveal writes a "reveal" audit row', async () => {
    const { res } = mockResponse()
    await storeHandlers.reveal(
      mockRequest(`/api/v1/credentials/${credentialId}/reveal`, { confirm: true }),
      res,
      { id: credentialId },
    )
    const { events } = audit.listEventsForCredential(credentialId)
    expect(events[0]!.eventType).toBe('reveal')
    expect(events[0]!.outcome).toBe('ok')
  })

  it('validate writes a "validate" audit row with the verdict', async () => {
    globalThis.fetch = (async () => new Response('{}', { status: 200 })) as typeof globalThis.fetch
    const { res } = mockResponse()
    await storeHandlers.validate(
      mockRequest(`/api/v1/credentials/${credentialId}/validate`),
      res,
      { id: credentialId },
    )
    const { events } = audit.listEventsForCredential(credentialId)
    expect(events.find(e => e.eventType === 'validate')).toBeDefined()
  })

  it('soft-delete writes a "delete" audit row with hard: false', async () => {
    const { res } = mockResponse()
    await storeHandlers.remove(
      mockRequest(`/api/v1/credentials/${credentialId}`),
      res,
      { id: credentialId },
    )
    const { events } = audit.listEventsForCredential(credentialId)
    const del = events.find(e => e.eventType === 'delete')
    expect(del).toBeDefined()
    expect(del!.detail).toMatchObject({ hard: false })
  })
})
