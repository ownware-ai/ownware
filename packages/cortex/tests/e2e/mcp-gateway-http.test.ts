/**
 * LIVE HTTP E2E — Surviving MCP gateway endpoints (T21 trimmed).
 *
 * Spins up the REAL gateway and verifies the endpoints the client still
 * uses: credentials CRUD + the standalone connect ping. The marketplace
 * + per-profile listing + cross-profile servers endpoints were retired
 * in T21 — the client reads those surfaces through `/api/v1/connectors` +
 * `/api/v1/catalog` instead. The corresponding test blocks were removed
 * with the endpoints; coverage for the unified surface lives in
 * `tests/integration/gateway/catalog-endpoint.test.ts` and the
 * connector aggregation suites under `tests/unit/connector/`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { OwnwareGateway } from '../../src/gateway/server.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROFILES_DIR = resolve(__dirname, '../../profiles')

// ---------------------------------------------------------------------------
// Gateway setup
// ---------------------------------------------------------------------------

let gateway: OwnwareGateway
let BASE: string
let token: string
let dataTmp: string

beforeAll(async () => {
  // dataDir isolation is mandatory (package CLAUDE.md) — without it the
  // gateway writes DB/credentials into the user's real ~/.ownware.
  dataTmp = await mkdtemp(join(tmpdir(), 'cortex-mcp-http-data-'))
  gateway = new OwnwareGateway({
    port: 0, // random port
    profilesDir: PROFILES_DIR,
    dataDir: dataTmp,
  })
  await gateway.start()
  BASE = `http://localhost:${gateway.port}`
  token = gateway.token
  console.log(`Gateway running at ${BASE}`)
}, 30_000)

afterAll(async () => {
  await gateway.stop()
  await rm(dataTmp, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function get(path: string) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  })
  const body = await res.json()
  return { status: res.status, body }
}

async function post(path: string, data?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: data ? JSON.stringify(data) : undefined,
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

async function del(path: string) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` },
  })
  return { status: res.status }
}

// ═══════════════════════════════════════════════════════════════════════════
// POST/GET/DELETE /api/v1/mcp/credentials — Credential management
// ═══════════════════════════════════════════════════════════════════════════

describe('Credential management endpoints', () => {
  const testServerId = 'test-credential-server'

  afterAll(async () => {
    await del(`/api/v1/mcp/credentials/${testServerId}`)
  })

  it('POST saves credentials', async () => {
    const { status, body } = await post(`/api/v1/mcp/credentials/${testServerId}`, {
      env: {
        API_KEY: 'sk-test-12345',
        DB_URL: 'postgres://localhost/test',
      },
    })
    expect(status).toBe(200)
    expect(body.serverId).toBe(testServerId)
    expect(body.saved).toBe(2)
  })

  it('GET checks which vars are set (never returns actual values)', async () => {
    const { status, body } = await get(`/api/v1/mcp/credentials/${testServerId}`)
    expect(status).toBe(200)
    expect(body.serverId).toBe(testServerId)
    expect(Array.isArray(body.envStatus)).toBe(true)
    expect(typeof body.isReady).toBe('boolean')

    // CRITICAL: actual values should NEVER be returned.
    const bodyStr = JSON.stringify(body)
    expect(bodyStr).not.toContain('sk-test-12345')
    expect(bodyStr).not.toContain('postgres://localhost/test')
  })

  it('DELETE removes credentials', async () => {
    const { status } = await del(`/api/v1/mcp/credentials/${testServerId}`)
    expect(status).toBe(204)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/v1/mcp/connect/:serverId — Live connection ping (survivor)
// ═══════════════════════════════════════════════════════════════════════════

describe('POST /api/v1/mcp/connect/:serverId — Live connection', () => {
  it('returns 404 for unknown server', async () => {
    const { status } = await post('/api/v1/mcp/connect/nonexistent-xyz-123')
    expect(status).toBe(404)
  })
})
