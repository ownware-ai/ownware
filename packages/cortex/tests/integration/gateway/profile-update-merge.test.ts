/**
 * Integration tests for `PUT /api/v1/profiles/:id` (F-15 + F-16 fix).
 *
 * Historically the handler did a shallow spread of `body.config` onto the
 * zod-parsed `loaded.config`, which silently reset every sibling of any
 * nested object the client touched (F-15) AND inflated every optional
 * field to its default on disk (F-16). These tests pin the correct
 * behavior so the bug cannot regress:
 *
 *   - Sparse patches preserve siblings at every depth.
 *   - The on-disk agent.json keeps its minimal author-written shape
 *     after a round-trip.
 *   - Invalid patches never corrupt the file.
 *
 * Runs against a real gateway with its own temp profiles dir. No mocks.
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
 * Minimal, author-written agent.json. Only four blocks specified; zod
 * will fill defaults on load but the disk file must stay minimal.
 *
 * Note the `security` block deliberately sets multiple sibling keys so
 * the shallow-merge regression (F-15) is directly observable: a patch
 * touching `security.level` alone must not wipe `zones` / `sandbox`.
 */
const INITIAL_CONFIG = {
  name: 'merge-fixture',
  description: 'Fixture for merge-semantics tests',
  model: 'anthropic:claude-haiku-4-5-20251001',
  security: {
    level: 'standard',
    permissionMode: 'ask',
    sandbox: { enabled: true, provider: 'docker' },
    zones: {
      enabled: true,
      maxAutoZone: 'workspace',
      overrides: [{ tool: 'fs_write', zone: 'workspace', reason: 'explicit' }],
    },
    hitlTimeoutMs: 1_800_000,
  },
  tools: {
    preset: 'coding',
    deny: ['shell_execute'],
  },
  tags: ['fixture', 'merge'],
} as const

beforeAll(async () => {
  // Two temp dirs: `profilesDir` seeds the user catalog; `dataDir`
  // overrides the gateway's `~/.ownware` so writes from the PUT handler
  // stay inside the sandbox. Without overriding dataDir, the handler
  // writes to `<dataDir>/profiles/<id>/agent.json` which defaults to
  // the real user home — tests would leak between runs and clobber
  // real profiles.
  profilesDir = await mkdtemp(join(tmpdir(), 'cortex-merge-profiles-'))
  dataDir = await mkdtemp(join(tmpdir(), 'cortex-merge-data-'))

  // Seed the fixture directly inside the user-profiles location the
  // gateway will use (`<dataDir>/profiles`), so edits round-trip in
  // place and the disk path observed by the test == the disk path
  // the handler writes.
  const userProfiles = join(dataDir, 'profiles')
  await mkdir(userProfiles, { recursive: true })
  const profileDir = join(userProfiles, 'merge-fixture')
  await mkdir(profileDir, { recursive: true })
  profileJsonPath = join(profileDir, 'agent.json')
  await writeFile(profileJsonPath, JSON.stringify(INITIAL_CONFIG, null, 2))
  await writeFile(join(profileDir, 'SOUL.md'), '# Merge Fixture\n')
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

async function put(path: string, data: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'PUT',
    body: JSON.stringify(data),
    headers: authHeaders({ 'Content-Type': 'application/json' }),
  })
  const body = await res.json()
  return { status: res.status, body }
}

async function getDetail(): Promise<any> {
  const res = await fetch(`${baseUrl}/api/v1/profiles/merge-fixture`, { headers: authHeaders() })
  return res.json()
}

async function readDiskConfig(): Promise<Record<string, any>> {
  const text = await readFile(profileJsonPath, 'utf-8')
  return JSON.parse(text)
}

/**
 * Restore the fixture to its pristine state so each test starts from the
 * same on-disk bytes. Without this, one test's disk mutation would leak
 * into the next via the shared gateway/profile dir.
 */
async function restoreFixture(): Promise<void> {
  await writeFile(profileJsonPath, JSON.stringify(INITIAL_CONFIG, null, 2))
  await put('/api/v1/profiles/merge-fixture', {}) // trigger registry reload via file handler is unnecessary
}

describe('PUT /api/v1/profiles/:id — deep merge semantics (F-15)', () => {
  it('sparse patch to security.level preserves every sibling key', async () => {
    await restoreFixture()

    const { status } = await put('/api/v1/profiles/merge-fixture', {
      config: { security: { level: 'strict' } },
    })
    expect(status).toBe(200)

    const disk = await readDiskConfig()
    expect(disk.security.level).toBe('strict')
    expect(disk.security.permissionMode).toBe('ask')
    expect(disk.security.sandbox).toEqual({ enabled: true, provider: 'docker' })
    expect(disk.security.zones.enabled).toBe(true)
    expect(disk.security.zones.maxAutoZone).toBe('workspace')
    expect(disk.security.zones.overrides).toEqual([
      { tool: 'fs_write', zone: 'workspace', reason: 'explicit' },
    ])
    expect(disk.security.hitlTimeoutMs).toBe(1_800_000)

    const detail = await getDetail()
    expect(detail.config.security.level).toBe('strict')
    expect(detail.config.security.permissionMode).toBe('ask')
    expect(detail.config.security.sandbox).toEqual({ enabled: true, provider: 'docker' })
    expect(detail.config.security.zones.maxAutoZone).toBe('workspace')
  })

  it('two-level-deep sparse patch preserves siblings at both levels', async () => {
    await restoreFixture()

    const { status } = await put('/api/v1/profiles/merge-fixture', {
      config: { security: { zones: { maxAutoZone: 'safe' } } },
    })
    expect(status).toBe(200)

    const disk = await readDiskConfig()
    // Level-2 sibling preserved
    expect(disk.security.zones.enabled).toBe(true)
    expect(disk.security.zones.overrides).toEqual([
      { tool: 'fs_write', zone: 'workspace', reason: 'explicit' },
    ])
    // Level-1 sibling preserved
    expect(disk.security.level).toBe('standard')
    expect(disk.security.sandbox).toEqual({ enabled: true, provider: 'docker' })
    // Target key updated
    expect(disk.security.zones.maxAutoZone).toBe('safe')
  })

  it('array values replace wholesale (do not element-merge)', async () => {
    await restoreFixture()

    const { status } = await put('/api/v1/profiles/merge-fixture', {
      config: { tags: ['brand-new'] },
    })
    expect(status).toBe(200)

    const disk = await readDiskConfig()
    expect(disk.tags).toEqual(['brand-new'])
  })

  it('replacing tools.deny with empty array clears it (not merges)', async () => {
    await restoreFixture()

    const { status } = await put('/api/v1/profiles/merge-fixture', {
      config: { tools: { deny: [] } },
    })
    expect(status).toBe(200)

    const disk = await readDiskConfig()
    expect(disk.tools.deny).toEqual([])
    // Sibling preserved
    expect(disk.tools.preset).toBe('coding')
  })

  it('on-disk agent.json is not inflated with schema defaults after a save (F-16)', async () => {
    await restoreFixture()

    await put('/api/v1/profiles/merge-fixture', {
      config: { description: 'Touched — must not inflate other fields' },
    })

    const disk = await readDiskConfig()
    // The patch only touched `description`, so the disk shape should
    // remain the author-written set of blocks — no fresh `memory`,
    // `workspace`, `execution`, `hooks`, etc. injected with defaults.
    expect(Object.keys(disk).sort()).toEqual(
      ['description', 'model', 'name', 'security', 'tags', 'tools'].sort(),
    )
    expect(disk.description).toBe('Touched — must not inflate other fields')
  })
})

describe('PUT /api/v1/profiles/:id — validation', () => {
  it('rejects an invalid patch value without touching disk', async () => {
    await restoreFixture()
    const before = await readFile(profileJsonPath, 'utf-8')

    const { status } = await put('/api/v1/profiles/merge-fixture', {
      config: { security: { level: 'super-strict' /* not in enum */ } },
    })
    expect(status).toBe(500)

    const after = await readFile(profileJsonPath, 'utf-8')
    expect(after).toBe(before)
  })

  it('rejects a patch that would set a negative hitlTimeoutMs without writing', async () => {
    await restoreFixture()
    const before = await readFile(profileJsonPath, 'utf-8')

    const { status } = await put('/api/v1/profiles/merge-fixture', {
      config: { security: { hitlTimeoutMs: -1 } },
    })
    expect(status).toBe(500)

    const after = await readFile(profileJsonPath, 'utf-8')
    expect(after).toBe(before)
  })
})

describe('PUT /api/v1/profiles/:id — null-as-delete (RFC 7396)', () => {
  it('null removes an optional top-level field', async () => {
    await restoreFixture()

    const { status } = await put('/api/v1/profiles/merge-fixture', {
      config: { description: null },
    })
    expect(status).toBe(200)

    const disk = await readDiskConfig()
    expect('description' in disk).toBe(false)
  })
})
