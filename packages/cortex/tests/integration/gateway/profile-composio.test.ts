/**
 * Integration tests for T03: `POST /api/v1/profiles/:id/composio` +
 * `DELETE /api/v1/profiles/:id/composio/:toolkit`.
 *
 * Mirror of `profile-update-merge.test.ts`'s setup — real gateway,
 * temp profilesDir + dataDir, HTTP calls, disk assertions — so the
 * handlers exercise the same fork + atomic-write path the PUT handler
 * uses. Covers every T03 acceptance criterion:
 *
 *   - POST appends to `config.tools.composio.toolkits`.
 *   - POST is idempotent: a second POST with the same slug is a 200
 *     no-op (no duplicate row, no rewrite storm).
 *   - DELETE removes the slug.
 *   - DELETE of a slug not present → 404.
 *   - Missing profile on either verb → 404.
 *   - Malformed slug on either verb → 400.
 *   - Atomic write preserves sibling config fields.
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
let profileJsonPath: string

/**
 * Minimal fixture. Deliberately carries a `security.level` sibling so
 * the atomic-write test can prove Composio edits don't clobber
 * unrelated config (parallel to the F-15 regression guard on the PUT
 * handler).
 */
const INITIAL_CONFIG = {
  name: 'composio-fixture',
  description: 'Fixture for T03 /profiles/:id/composio tests',
  model: 'anthropic:claude-haiku-4-5-20251001',
  security: { level: 'standard' },
  tools: {
    // Start with NO composio block — exercise the "first write creates
    // the block" path inside addProfileComposioToolkit.
    preset: 'coding',
  },
} as const

beforeAll(async () => {
  profilesDir = await mkdtemp(join(tmpdir(), 'cortex-composio-profiles-'))
  dataDir = await mkdtemp(join(tmpdir(), 'cortex-composio-data-'))

  const userProfiles = join(dataDir, 'profiles')
  await mkdir(userProfiles, { recursive: true })
  const profileDir = join(userProfiles, 'composio-fixture')
  await mkdir(profileDir, { recursive: true })
  profileJsonPath = join(profileDir, 'agent.json')
  await writeFile(profileJsonPath, JSON.stringify(INITIAL_CONFIG, null, 2))
  await writeFile(join(profileDir, 'SOUL.md'), '# Composio Fixture\n')
  await writeFile(join(profileDir, 'AGENTS.md'), '# Memory\n')
  await mkdir(join(profileDir, 'skills'), { recursive: true })

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

async function post(
  path: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: authHeaders({ 'Content-Type': 'application/json' }),
  })
  const payload: unknown = await res.json().catch(() => null)
  return { status: res.status, body: payload }
}

async function del(path: string): Promise<{ status: number }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'DELETE',
    headers: authHeaders(),
  })
  // 204 has no body — don't try to parse.
  return { status: res.status }
}

async function readDisk(): Promise<Record<string, unknown>> {
  const text = await readFile(profileJsonPath, 'utf-8')
  return JSON.parse(text) as Record<string, unknown>
}

function readToolkits(disk: Record<string, unknown>): string[] {
  const tools = disk['tools'] as Record<string, unknown> | undefined
  const composio = tools?.['composio'] as Record<string, unknown> | undefined
  const raw = composio?.['toolkits']
  return Array.isArray(raw) ? raw.filter((t): t is string => typeof t === 'string') : []
}

/**
 * Reset disk to pristine fixture so each test starts independent of
 * its predecessors. Same pattern as `profile-update-merge.test.ts` —
 * shared gateway/profile dir means tests mutate each other without
 * this.
 */
async function restoreFixture(): Promise<void> {
  await writeFile(profileJsonPath, JSON.stringify(INITIAL_CONFIG, null, 2))
  // The registry caches `loaded` until the next read; touching the
  // file via the gateway's own reload endpoint is the cheapest way to
  // invalidate that cache.
  await fetch(`${baseUrl}/api/v1/profiles/composio-fixture/reload`, {
    method: 'POST',
    headers: authHeaders(),
  })
}

describe('POST /api/v1/profiles/:id/composio — attach', () => {
  it('appends the toolkit slug to config.tools.composio.toolkits', async () => {
    await restoreFixture()
    const res = await post('/api/v1/profiles/composio-fixture/composio', {
      toolkit: 'gmail',
    })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      profileId: 'composio-fixture',
      toolkit: 'gmail',
      added: true,
    })
    expect(readToolkits(await readDisk())).toEqual(['gmail'])
  })

  it('is idempotent — re-adding an existing slug is a 200 no-op', async () => {
    await restoreFixture()
    const first = await post('/api/v1/profiles/composio-fixture/composio', {
      toolkit: 'slack',
    })
    expect(first.status).toBe(200)
    expect((first.body as { added: boolean }).added).toBe(true)

    const second = await post('/api/v1/profiles/composio-fixture/composio', {
      toolkit: 'slack',
    })
    expect(second.status).toBe(200)
    expect((second.body as { added: boolean }).added).toBe(false)

    // Exactly one entry — no duplicate.
    expect(readToolkits(await readDisk())).toEqual(['slack'])
  })

  it('preserves sibling config fields after a toolkit attach (atomic write)', async () => {
    await restoreFixture()
    await post('/api/v1/profiles/composio-fixture/composio', { toolkit: 'gmail' })
    const disk = await readDisk()
    // Unrelated siblings must survive the rewrite.
    expect(disk['name']).toBe('composio-fixture')
    expect((disk['security'] as { level: string }).level).toBe('standard')
    expect((disk['tools'] as { preset: string }).preset).toBe('coding')
  })

  it('supports multiple distinct toolkits in order', async () => {
    await restoreFixture()
    await post('/api/v1/profiles/composio-fixture/composio', { toolkit: 'gmail' })
    await post('/api/v1/profiles/composio-fixture/composio', { toolkit: 'slack' })
    await post('/api/v1/profiles/composio-fixture/composio', { toolkit: 'github' })
    expect(readToolkits(await readDisk())).toEqual(['gmail', 'slack', 'github'])
  })

  it('400s on a missing toolkit field', async () => {
    await restoreFixture()
    const res = await post('/api/v1/profiles/composio-fixture/composio', {})
    expect(res.status).toBe(400)
  })

  it('400s on an invalid slug grammar', async () => {
    await restoreFixture()
    const res = await post('/api/v1/profiles/composio-fixture/composio', {
      toolkit: 'Bad Slug With Spaces',
    })
    expect(res.status).toBe(400)
  })

  it('400s on an empty slug', async () => {
    await restoreFixture()
    const res = await post('/api/v1/profiles/composio-fixture/composio', {
      toolkit: '',
    })
    expect(res.status).toBe(400)
  })

  it('404s on a nonexistent profile', async () => {
    const res = await post('/api/v1/profiles/does-not-exist/composio', {
      toolkit: 'gmail',
    })
    expect(res.status).toBe(404)
  })
})

describe('DELETE /api/v1/profiles/:id/composio/:toolkit — detach', () => {
  it('removes the slug and returns 204', async () => {
    await restoreFixture()
    await post('/api/v1/profiles/composio-fixture/composio', { toolkit: 'gmail' })
    await post('/api/v1/profiles/composio-fixture/composio', { toolkit: 'slack' })

    const res = await del('/api/v1/profiles/composio-fixture/composio/gmail')
    expect(res.status).toBe(204)
    expect(readToolkits(await readDisk())).toEqual(['slack'])
  })

  it('404s on a toolkit not in the profile', async () => {
    await restoreFixture()
    // Ensure the composio block exists but without the target toolkit.
    await post('/api/v1/profiles/composio-fixture/composio', { toolkit: 'slack' })
    const res = await del('/api/v1/profiles/composio-fixture/composio/gmail')
    expect(res.status).toBe(404)
    // Didn't accidentally mutate the array.
    expect(readToolkits(await readDisk())).toEqual(['slack'])
  })

  it('404s on a profile with no composio block at all', async () => {
    await restoreFixture()
    const res = await del('/api/v1/profiles/composio-fixture/composio/gmail')
    expect(res.status).toBe(404)
  })

  it('404s on a nonexistent profile', async () => {
    const res = await del('/api/v1/profiles/does-not-exist/composio/gmail')
    expect(res.status).toBe(404)
  })

  it('400s on a malformed slug in the URL path', async () => {
    await restoreFixture()
    // Space gets percent-encoded to %20; grammar still rejects.
    const res = await del(
      '/api/v1/profiles/composio-fixture/composio/' +
        encodeURIComponent('Bad Slug'),
    )
    expect(res.status).toBe(400)
  })

  it('preserves sibling config fields after a detach (atomic write)', async () => {
    await restoreFixture()
    await post('/api/v1/profiles/composio-fixture/composio', { toolkit: 'gmail' })
    await del('/api/v1/profiles/composio-fixture/composio/gmail')
    const disk = await readDisk()
    expect(disk['name']).toBe('composio-fixture')
    expect((disk['security'] as { level: string }).level).toBe('standard')
    expect((disk['tools'] as { preset: string }).preset).toBe('coding')
  })
})
