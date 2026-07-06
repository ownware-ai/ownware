/**
 * Integration tests for slice-08 of product-base-shift Phase 2:
 *
 *   • `POST /api/v1/profiles` now requires `productId` in the body
 *     and writes it into `agent.json`.
 *   • `POST /api/v1/profiles/:id/duplicate` now accepts an optional
 *     `{ name?, soulMd?, description? }` body for the client's "Fork"
 *     surface. Slug-conflict suffixing (`-2`, `-3`, …) stays.
 *   • The duplicated profile inherits the source `productId` —
 *     forks stay inside the same product.
 *
 * Runs against a real gateway with its own temp profile + data dirs
 * (cortex/CLAUDE.md gateway-test-isolation rule).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { OwnwareGateway } from '../../../src/gateway/server.js'

let gateway: OwnwareGateway
let baseUrl: string
let profilesDir: string
let dataDir: string

/**
 * Seed a builtin-shaped profile inside the user-profiles dir so the
 * duplicate endpoint has something to fork. Mirrors the
 * profile-update-merge.test.ts pattern.
 */
const SOURCE_CONFIG = {
  name: 'src-designer',
  description: 'Source profile for slice-08 tests',
  model: 'anthropic:claude-haiku-4-5-20251001',
  // Lives in the OPEN product — closed products (ownware-design etc.) now
  // reject duplicate/fork with 403 by policy, and this suite's subject
  // is the override-body behaviour, not the policy gate.
  productId: 'ownware',
} as const

const SOURCE_SOUL = '# src-designer\n\nOriginal SOUL.\n'

beforeAll(async () => {
  profilesDir = await mkdtemp(join(tmpdir(), 'cortex-slice08-profiles-'))
  dataDir = await mkdtemp(join(tmpdir(), 'cortex-slice08-data-'))

  // Seed the source profile inside <dataDir>/profiles so the gateway
  // sees it on discover().
  const userProfiles = join(dataDir, 'profiles')
  await mkdir(userProfiles, { recursive: true })
  const srcDir = join(userProfiles, SOURCE_CONFIG.name)
  await mkdir(srcDir, { recursive: true })
  await writeFile(join(srcDir, 'agent.json'), JSON.stringify(SOURCE_CONFIG, null, 2))
  await writeFile(join(srcDir, 'SOUL.md'), SOURCE_SOUL)
  await writeFile(join(srcDir, 'AGENTS.md'), '# Memory\n')
  await mkdir(join(srcDir, 'skills'), { recursive: true })

  gateway = new OwnwareGateway({ port: 0, profilesDir, dataDir })
  await gateway.start()
  baseUrl = `http://localhost:${gateway.port}`
}, 15_000)

afterAll(async () => {
  await gateway.stop()
  await rm(profilesDir, { recursive: true, force: true })
  await rm(dataDir, { recursive: true, force: true })
})

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  return { Authorization: `Bearer ${gateway.token}`, ...extra }
}

async function post(path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    body: body !== undefined ? JSON.stringify(body) : undefined,
    headers: authHeaders({ 'Content-Type': 'application/json' }),
  })
  const text = await res.text()
  const parsed = text.length > 0 ? JSON.parse(text) : null
  return { status: res.status, body: parsed }
}

async function get(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, { headers: authHeaders() })
  return { status: res.status, body: await res.json() }
}

async function readDiskAgentJson(slug: string): Promise<Record<string, any>> {
  const p = join(dataDir, 'profiles', slug, 'agent.json')
  return JSON.parse(await readFile(p, 'utf-8'))
}

async function readDiskSoul(slug: string): Promise<string> {
  return readFile(join(dataDir, 'profiles', slug, 'SOUL.md'), 'utf-8')
}

describe('POST /api/v1/profiles — productId is required and round-trips', () => {
  it('400 when productId is missing', async () => {
    const r = await post('/api/v1/profiles', {
      name: 'no-product-id',
      description: 'should be rejected',
    })
    expect(r.status).toBe(400)
    expect(JSON.stringify(r.body)).toContain('productId')
  })

  it('400 when productId is not a kebab slug', async () => {
    const r = await post('/api/v1/profiles', {
      name: 'bad-slug',
      productId: 'Ownware Coder',
    })
    expect(r.status).toBe(400)
  })

  it('201 + writes productId into agent.json + surfaces it on list', async () => {
    const r = await post('/api/v1/profiles', {
      name: 'my-coder-1',
      productId: 'ownware',
      description: 'Custom coder',
    })
    expect(r.status).toBe(201)
    expect(r.body.id).toBe('my-coder-1')
    expect(r.body.productId).toBe('ownware')

    const onDisk = await readDiskAgentJson('my-coder-1')
    expect(onDisk['productId']).toBe('ownware')

    const list = await get('/api/v1/profiles')
    expect(list.status).toBe(200)
    const created = (list.body as Array<Record<string, any>>).find(
      (p) => p['id'] === 'my-coder-1',
    )
    expect(created).toBeDefined()
    expect(created?.['productId']).toBe('ownware')
  })

  it('409 on slug collision (create twice with the same name)', async () => {
    await post('/api/v1/profiles', {
      name: 'collision-target',
      productId: 'ownware',
    })
    const second = await post('/api/v1/profiles', {
      name: 'collision-target',
      productId: 'ownware',
    })
    expect(second.status).toBe(409)
  })
})

describe('POST /api/v1/profiles/:id/duplicate — optional override body', () => {
  it('bodyless POST still works (legacy shape): auto-name <id>-copy', async () => {
    const r = await post('/api/v1/profiles/src-designer/duplicate')
    expect(r.status).toBe(201)
    expect(r.body.id).toBe('src-designer-copy')
    expect(r.body.duplicatedFrom).toBe('src-designer')
    expect(r.body.productId).toBe('ownware')
  })

  it('overrides honor `name` + `soulMd` + `description` + inherit productId', async () => {
    const r = await post('/api/v1/profiles/src-designer/duplicate', {
      name: 'my-designer',
      soulMd: '# my-designer\n\nMy custom SOUL.\n',
      description: 'My customized fork',
    })
    expect(r.status).toBe(201)
    expect(r.body.id).toBe('my-designer')
    expect(r.body.productId).toBe('ownware')

    const onDisk = await readDiskAgentJson('my-designer')
    expect(onDisk['name']).toBe('my-designer')
    expect(onDisk['description']).toBe('My customized fork')
    expect(onDisk['productId']).toBe('ownware')

    const soul = await readDiskSoul('my-designer')
    expect(soul).toContain('My custom SOUL.')

    const sourceSoul = await readDiskSoul('src-designer')
    expect(sourceSoul).toBe(SOURCE_SOUL)
  })

  it('slug-conflict suffixing on explicit `name` collides (-2)', async () => {
    // Setup: 'forkme' already exists as a base profile.
    await post('/api/v1/profiles', {
      name: 'forkme',
      productId: 'ownware',
    })
    // First duplicate with explicit name colliding with existing slug.
    const first = await post('/api/v1/profiles/src-designer/duplicate', {
      name: 'forkme',
    })
    expect(first.status).toBe(201)
    expect(first.body.id).toBe('forkme-2')
  })

  it('400 on malformed `name` slug', async () => {
    const r = await post('/api/v1/profiles/src-designer/duplicate', {
      name: 'BAD CASE',
    })
    expect(r.status).toBe(400)
  })

  it('404 when source profile does not exist', async () => {
    const r = await post('/api/v1/profiles/does-not-exist/duplicate', {
      name: 'whatever',
    })
    expect(r.status).toBe(404)
  })
})
