/**
 * Integration test for the error pipeline (slices S5 / S7).
 *
 * Boots a real `OwnwareGateway` and verifies the wire envelope shape
 * across the failure modes that matter to UI clients:
 *
 *   - `{ error, message, category }` is the shape (envelope + category
 *     field arrived in slice S5).
 *   - The category for each known failure mode matches the closed enum
 *     in `packages/cortex/src/errors/categories.ts`.
 *   - The router's catch-all (added in S7) classifies even handler
 *     exceptions that don't explicitly call sendClassifiedError — this
 *     is the architectural guarantee that 410+ handler call sites get
 *     the right category without per-site adoption.
 *
 * This is the frontman-style end-to-end check the BOARD calls S13:
 * one test that proves the funnel actually round-trips, not 50 unit
 * tests for individual pieces.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { OwnwareGateway } from '../../../src/gateway/server.js'

let gateway: OwnwareGateway
let baseUrl: string
let profilesDir: string
let dataDir: string

beforeAll(async () => {
  if (!process.env['ANTHROPIC_API_KEY']) process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test-dummy'
  if (!process.env['OPENAI_API_KEY']) process.env['OPENAI_API_KEY'] = 'sk-test-dummy'

  profilesDir = await mkdtemp(join(tmpdir(), 'cortex-err-pipe-profiles-'))
  dataDir = await mkdtemp(join(tmpdir(), 'cortex-err-pipe-data-'))
  const userProfiles = join(dataDir, 'profiles')
  await mkdir(userProfiles, { recursive: true })

  const profileDir = join(userProfiles, 'sentinel')
  await mkdir(profileDir, { recursive: true })
  await writeFile(
    join(profileDir, 'agent.json'),
    JSON.stringify({ name: 'sentinel', model: 'anthropic:claude-haiku-4-5-20251001' }, null, 2),
  )
  await writeFile(join(profileDir, 'SOUL.md'), '# Error pipeline fixture\n')

  gateway = new OwnwareGateway({ port: 0, profilesDir, dataDir })
  await gateway.start()
  baseUrl = `http://localhost:${gateway.port}`
}, 20_000)

afterAll(async () => {
  if (gateway !== undefined) await gateway.stop()
  await rm(profilesDir, { recursive: true, force: true })
  await rm(dataDir, { recursive: true, force: true })
})

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  return { Authorization: `Bearer ${gateway.token}`, ...extra }
}

async function getJson(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}${path}`, { headers: authHeaders() })
  const body = (await res.json()) as Record<string, unknown>
  return { status: res.status, body }
}

async function postJson(
  path: string,
  body: unknown,
  opts?: { rawBody?: string },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const init: RequestInit = {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: opts?.rawBody ?? JSON.stringify(body),
  }
  const res = await fetch(`${baseUrl}${path}`, init)
  const json = (await res.json()) as Record<string, unknown>
  return { status: res.status, body: json }
}

describe('error pipeline — wire envelope round-trip (S13)', () => {
  it('every error response carries { error, message, category }', async () => {
    const { body } = await getJson('/api/v1/profiles/this-profile-does-not-exist')
    expect(body).toHaveProperty('error')
    expect(body).toHaveProperty('message')
    expect(body).toHaveProperty('category')
    expect(typeof body.category).toBe('string')
  })

  it('404 → category = "not_found"', async () => {
    const { status, body } = await getJson('/api/v1/profiles/this-profile-does-not-exist')
    expect(status).toBe(404)
    expect(body.category).toBe('not_found')
  })

  it('unknown route → 404 + category = "not_found"', async () => {
    const { status, body } = await getJson('/api/v1/route-that-does-not-exist')
    expect(status).toBe(404)
    expect(body.category).toBe('not_found')
  })

  it('400 from malformed JSON body → category = "invalid_request"', async () => {
    const { status, body } = await postJson(
      '/api/v1/run',
      undefined,
      { rawBody: '{not valid json' },
    )
    expect(status).toBe(400)
    expect(body.category).toBe('invalid_request')
  })

  it('runs against a missing profile → 4xx + classified category (not raw 500/unknown)', async () => {
    const { status, body } = await postJson('/api/v1/run', {
      profileId: 'definitely-not-here',
      prompt: 'hello',
    })
    // The run handler treats missing profile as 404 or 400, both of which
    // map to category buckets we own (not_found / invalid_request). What
    // we care about: the wire envelope is the new shape, category is set,
    // and it's NOT 'unknown' for this known failure mode.
    expect([400, 404]).toContain(status)
    expect(['not_found', 'invalid_request']).toContain(body.category)
  })

  it('category field is bounded to the closed enum (no free-text leakage)', async () => {
    const { body } = await getJson('/api/v1/profiles/missing-x')
    const ALLOWED = new Set([
      'auth', 'connector_auth_expired', 'connector_not_configured',
      'rate_limit', 'overload', 'connector_rate_limited',
      'context_window', 'content_policy', 'invalid_request', 'connector_validation',
      'network', 'sqlite', 'connector_vendor',
      'tool_timeout', 'tool_permission',
      'aborted', 'not_found', 'config',
      'unknown',
    ])
    expect(ALLOWED.has(body.category as string)).toBe(true)
  })
})
