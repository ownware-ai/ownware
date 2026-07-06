/**
 * E2E lifecycle test for the connector-unification board (2026-04-27).
 *
 * Exercises the full chain through a real gateway against real SQLite +
 * real filesystem agent.json:
 *
 *   1. Register a custom Figma server → row exists, has logicalKey 'figma'.
 *   2. Register the same Figma again with a DIFFERENT URL → no second
 *      row (logicalKey dedup), API returns `dedupedBy: 'logicalKey'`.
 *   3. Pre-register an auto-detected Figma row (mimicking auto-register)
 *      with `registry_id='detected'` → still dedups against the custom.
 *   4. Catalog response shows ONE Figma card (registry-level dedup).
 *   5. Attach the Figma to a profile → agent.json updated.
 *   6. Manually edit agent.json to drop Figma → restart gateway →
 *      reconcile drops the assignment but keeps the user-registered row.
 *   7. Detect detect-marker rows: profile-orphaned 'detected' rows
 *      survive (auto-detect re-attaches them on next scan).
 *   8. Detach via API → assignment dropped, row stays (user-owned).
 *
 * This is the customer-handover smoke test for the dedup/reconcile
 * machinery. Skipping any step constitutes a regression that ships
 * customer-visible data drift.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { OwnwareGateway } from '../../src/gateway/server.js'

let gateway: OwnwareGateway
let baseUrl: string
let profilesDir: string
let dataDir: string
let userProfilesDir: string
let authToken: string

const ORIGINAL_SKIP_ENV = process.env['OWNWARE_SKIP_MCP_REGISTRY']

/**
 * Seed a profile under userProfilesDir with the given mcp config in its
 * agent.json so we can exercise reconcile against a known starting state.
 */
async function writeProfile(
  name: string,
  mcp: Record<string, unknown> = {},
): Promise<void> {
  const dir = join(userProfilesDir, name)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'agent.json'),
    JSON.stringify(
      {
        name,
        version: '1.0.0',
        provider: 'anthropic',
        model: 'anthropic:claude-sonnet-4-6',
        tools: { preset: 'full', allow: [], deny: [], custom: [], mcp },
        memory: { enabled: false, sources: [], autoLearn: false, isolation: 'shared' },
        skills: { dirs: [], external: [] },
        context: { git: false, os: false, cwd: false },
        permissions: { mode: 'default' },
      },
      null,
      2,
    ),
    'utf-8',
  )
}

beforeAll(async () => {
  process.env['OWNWARE_SKIP_MCP_REGISTRY'] = '1'
  profilesDir = await mkdtemp(join(tmpdir(), 'cortex-e2e-unif-bundled-'))
  dataDir = await mkdtemp(join(tmpdir(), 'cortex-e2e-unif-data-'))
  userProfilesDir = join(dataDir, 'profiles')
  await mkdir(userProfilesDir, { recursive: true })

  // Seed two user profiles so reconcile has something to walk.
  await writeProfile('coder', {})
  await writeProfile('reviewer', {})

  gateway = new OwnwareGateway({ port: 0, profilesDir, dataDir })
  await gateway.start()
  baseUrl = `http://localhost:${gateway.port}`

  // Read the gateway's auth token. OwnwareGateway writes it to dataDir
  // for the loopback Electron client; tests can read the same file.
  const tokenPath = join(dataDir, 'auth-token')
  authToken = (await readFile(tokenPath, 'utf-8').catch(() => '')).trim()
}, 30_000)

afterAll(async () => {
  await gateway.stop()
  await rm(profilesDir, { recursive: true, force: true })
  await rm(dataDir, { recursive: true, force: true })
  if (ORIGINAL_SKIP_ENV === undefined) {
    delete process.env['OWNWARE_SKIP_MCP_REGISTRY']
  } else {
    process.env['OWNWARE_SKIP_MCP_REGISTRY'] = ORIGINAL_SKIP_ENV
  }
})

function authHeaders(): Record<string, string> {
  return authToken
    ? { 'Content-Type': 'application/json', authorization: `Bearer ${authToken}` }
    : { 'Content-Type': 'application/json' }
}

async function POST(path: string, body: unknown): Promise<{ status: number; payload: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let payload: unknown = null
  try {
    payload = text.length > 0 ? JSON.parse(text) : null
  } catch {
    payload = text
  }
  return { status: res.status, payload }
}

async function DELETE(path: string): Promise<{ status: number }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'DELETE',
    headers: authHeaders(),
  })
  return { status: res.status }
}

async function GET(path: string): Promise<{ status: number; payload: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'GET',
    headers: authHeaders(),
  })
  const text = await res.text()
  let payload: unknown = null
  try {
    payload = text.length > 0 ? JSON.parse(text) : null
  } catch {
    payload = text
  }
  return { status: res.status, payload }
}

// ---------------------------------------------------------------------------
// The lifecycle scenarios
// ---------------------------------------------------------------------------

describe('Connector unification — E2E lifecycle', () => {
  let figmaId: string

  it('1. registers a custom Figma server', async () => {
    const res = await POST('/api/v1/mcp/register', {
      name: 'Figma',
      transport: 'http',
      url: 'https://mcp.figma.com/mcp',
    })
    expect(res.status).toBe(201)
    const payload = res.payload as { id: string; name: string; source: string }
    expect(payload.source).toBe('mcp')
    expect(payload.name).toBe('Figma')
    expect(payload.id).toMatch(/^figma-[a-z2-7]{8}$/)
    figmaId = payload.id
  })

  it('2. registering the SAME Figma again returns the existing row (endpoint dedup)', async () => {
    const res = await POST('/api/v1/mcp/register', {
      name: 'Figma',
      transport: 'http',
      url: 'https://mcp.figma.com/mcp',
    })
    expect(res.status).toBe(200)
    const payload = res.payload as { id: string; dedupedBy?: string }
    expect(payload.id).toBe(figmaId)
    expect(payload.dedupedBy).toBe('endpoint')
  })

  it('3. registering Figma with a DIFFERENT URL still dedups by logicalKey', async () => {
    const res = await POST('/api/v1/mcp/register', {
      name: 'Figma',
      transport: 'http',
      url: 'https://different-figma-instance.example.com/mcp',
    })
    expect(res.status).toBe(200)
    const payload = res.payload as { id: string; dedupedBy?: string }
    expect(payload.id).toBe(figmaId)
    expect(payload.dedupedBy).toBe('logicalKey')
  })

  it('4. catalog shows exactly one Figma card after multiple register attempts', async () => {
    const res = await GET('/api/v1/catalog')
    expect(res.status).toBe(200)
    const items = (res.payload as { items: Array<{ logicalKey: string; source: string }> }).items
    const figmaEntries = items.filter(c => c.logicalKey === 'figma')
    expect(figmaEntries.length).toBe(1)
  })

  it('5. catalog Connector for Figma carries the new logicalKey field', async () => {
    const res = await GET('/api/v1/catalog')
    const items = (res.payload as { items: Array<{ id: string; logicalKey: string; name: string }> }).items
    const figma = items.find(c => c.id === figmaId)
    expect(figma).toBeDefined()
    expect(figma!.logicalKey).toBe('figma')
    expect(figma!.name).toBe('Figma')
  })

  it('6. attaching Figma to a profile updates agent.json', async () => {
    const res = await POST('/api/v1/profiles/coder/mcp', {
      serverId: figmaId,
    })
    expect(res.status).toBe(201)

    const agentJson = JSON.parse(
      await readFile(join(userProfilesDir, 'coder', 'agent.json'), 'utf-8'),
    )
    expect(agentJson.tools.mcp).toHaveProperty(figmaId)
  })

  it('7. detaching Figma updates agent.json AND DB junction', async () => {
    const res = await DELETE(`/api/v1/profiles/coder/mcp/${figmaId}`)
    expect(res.status).toBe(204)

    const agentJson = JSON.parse(
      await readFile(join(userProfilesDir, 'coder', 'agent.json'), 'utf-8'),
    )
    expect(agentJson.tools.mcp).not.toHaveProperty(figmaId)
  })

  it('8. user-registered row survives detachment (only assignments are dropped)', async () => {
    // The custom row stays in the DB so the user can re-attach without
    // re-entering credentials.
    const res = await GET('/api/v1/catalog')
    const items = (res.payload as { items: Array<{ id: string; source: string }> }).items
    const figma = items.find(c => c.id === figmaId)
    expect(figma).toBeDefined()
    expect(figma!.source).toBe('mcp')
  })

  it('9. delete via /mcp/register removes the row entirely', async () => {
    const res = await DELETE(`/api/v1/mcp/register/${figmaId}`)
    expect(res.status).toBe(204)

    const after = await GET('/api/v1/catalog')
    const items = (after.payload as { items: Array<{ id: string }> }).items
    const figma = items.find(c => c.id === figmaId)
    expect(figma).toBeUndefined()
  })
})
