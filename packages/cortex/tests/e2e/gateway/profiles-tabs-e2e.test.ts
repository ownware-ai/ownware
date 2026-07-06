/**
 * E2E tests for Profile metadata, workspace panes, and file tree.
 *
 * (Workspace tabs were replaced by the panes API in slice 1b.9 —
 * migration 025 dropped workspace_tabs.)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { OwnwareGateway } from '../../../src/gateway/server.js'
import { join } from 'node:path'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { existsSync } from 'node:fs'

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let gateway: OwnwareGateway
let token: string
let tempDir: string
const baseUrl = () => `http://127.0.0.1:${gateway.port}`

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cortex-profiles-tabs-'))
  const dbPath = join(tempDir, 'test.db')

  const profileDir = join(tempDir, 'profiles', 'test-agent')
  await mkdir(profileDir, { recursive: true })
  await writeFile(join(profileDir, 'agent.json'), JSON.stringify({
    name: 'test-agent',
    description: 'Test agent for profiles + tabs e2e',
    model: 'anthropic:claude-sonnet-4-20250514',
    tools: { preset: 'none' },
    context: { cwd: false, datetime: false },
  }))
  await writeFile(join(profileDir, 'SOUL.md'), '# Test Agent\nYou are a test agent.')

  // Gateway Test Isolation (package CLAUDE.md): pass BOTH profilesDir AND
  // dataDir. Without dataDir the gateway defaults to ~/.ownware and every
  // profile created via the API (POST, duplicate) leaks into the user's
  // real system.
  gateway = new OwnwareGateway({
    port: 0,
    profilesDir: join(tempDir, 'profiles'),
    dataDir: join(tempDir, 'data'),
    dbPath,
  })
  await gateway.start()
  token = gateway.token
}, 15_000)

afterAll(async () => {
  await gateway?.stop()
  await rm(tempDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function api(path: string, opts?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl()}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, ...opts?.headers },
  })
}

async function json(path: string, opts?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await api(path, opts)
  if (res.status === 204) return { status: 204, body: null }
  const body = await res.json()
  return { status: res.status, body }
}

async function post(path: string, data: unknown): Promise<{ status: number; body: any }> {
  return json(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}

async function put(path: string, data: unknown): Promise<{ status: number; body: any }> {
  return json(path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}

async function del(path: string): Promise<{ status: number; body: any }> {
  return json(path, { method: 'DELETE' })
}

// ---------------------------------------------------------------------------
// Profile metadata enrichment
// ---------------------------------------------------------------------------

describe('profile metadata', () => {
  it('listProfiles includes metadata fields', async () => {
    const { status, body } = await json('/api/v1/profiles')
    expect(status).toBe(200)
    expect(Array.isArray(body)).toBe(true)
    const profile = body.find((p: any) => p.id === 'test-agent')
    expect(profile).toBeTruthy()
    // Metadata fields exist (may be null/0 defaults)
    expect('icon' in profile).toBe(true)
    expect('color' in profile).toBe(true)
    expect('category' in profile).toBe(true)
    expect('useCount' in profile).toBe(true)
    expect('isLive' in profile).toBe(true)
  })

  it('getProfile includes metadata', async () => {
    const { status, body } = await json('/api/v1/profiles/test-agent')
    expect(status).toBe(200)
    expect('icon' in body).toBe(true)
    expect('isLive' in body).toBe(true)
  })

  it('updateProfile saves metadata (icon, color, category)', async () => {
    const { status } = await put('/api/v1/profiles/test-agent', {
      icon: 'code',
      color: '#7C5CFC',
      category: 'development',
    })
    expect(status).toBe(200)

    // Verify via list
    const { body } = await json('/api/v1/profiles')
    const profile = body.find((p: any) => p.id === 'test-agent')
    expect(profile.icon).toBe('code')
    expect(profile.color).toBe('#7C5CFC')
    expect(profile.category).toBe('development')
  })
})

// ---------------------------------------------------------------------------
// Profile delete
// ---------------------------------------------------------------------------

describe('profile delete', () => {
  it('creates then deletes a profile', async () => {
    // productId is required since slice-08 of product-base-shift; only the
    // 'ownware' product is profilePolicy 'open' (closed products 403 creates).
    const { status: createStatus } = await post('/api/v1/profiles', {
      name: 'to-delete',
      description: 'Will be deleted',
      productId: 'ownware',
    })
    expect(createStatus).toBe(201)

    // Verify exists
    const { status: getStatus } = await json('/api/v1/profiles/to-delete')
    expect(getStatus).toBe(200)

    // Delete
    const { status: delStatus } = await del('/api/v1/profiles/to-delete')
    expect(delStatus).toBe(204)

    // Verify gone
    const { status: goneStatus } = await json('/api/v1/profiles/to-delete')
    expect(goneStatus).toBe(404)

    // Verify directory is gone — API-created profiles live under
    // dataDir/profiles (the user layer), not the bundled profilesDir.
    expect(existsSync(join(tempDir, 'data', 'profiles', 'to-delete'))).toBe(false)
  })

  it('returns 404 for nonexistent profile', async () => {
    const { status } = await del('/api/v1/profiles/nonexistent-xyz')
    expect(status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Profile duplicate
// ---------------------------------------------------------------------------

describe('profile duplicate', () => {
  it('duplicates a profile with -copy suffix', async () => {
    const { status, body } = await post('/api/v1/profiles/test-agent/duplicate', {})
    expect(status).toBe(201)
    expect(body.id).toBe('test-agent-copy')
    expect(body.duplicatedFrom).toBe('test-agent')

    // Verify the copy exists
    const { status: getStatus, body: detail } = await json('/api/v1/profiles/test-agent-copy')
    expect(getStatus).toBe(200)
    expect(detail.name).toBe('test-agent-copy')
  })

  it('generates -copy-2 when -copy already exists', async () => {
    const { status, body } = await post('/api/v1/profiles/test-agent/duplicate', {})
    expect(status).toBe(201)
    expect(body.id).toBe('test-agent-copy-2')
  })

  it('returns 404 for nonexistent profile', async () => {
    const { status } = await post('/api/v1/profiles/nonexistent-xyz/duplicate', {})
    expect(status).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// Workspace panes
//
// Slice 1b.9 removed the /workspaces/:id/tabs surface (migration 025
// dropped workspace_tabs). A chat's open-view state is a workspace_panes
// row whose config carries (profileId, threadId); the thread itself is
// created separately via POST /threads.
// ---------------------------------------------------------------------------

describe('workspace panes', () => {
  let wsId: string
  let firstThreadId: string

  it('creates workspace for pane tests', async () => {
    const wsDir = join(tempDir, 'pane-workspace')
    await mkdir(wsDir, { recursive: true })
    const { status, body } = await post('/api/v1/workspaces', { path: wsDir, name: 'Pane Test WS' })
    expect(status).toBe(201)
    wsId = body.id
  })

  it('creates a chat pane → 201', async () => {
    const { body: thread } = await post('/api/v1/threads', {
      profileId: 'test-agent',
      title: 'First Chat',
    })
    firstThreadId = thread.id

    const { status, body } = await post(`/api/v1/workspaces/${wsId}/panes`, {
      config: { kind: 'chat', profileId: 'test-agent', threadId: thread.id },
      title: 'First Chat',
    })
    expect(status).toBe(201)
    expect(body.pane).toBeTruthy()
    expect(body.pane.title).toBe('First Chat')
    expect(body.pane.focused).toBe(true) // new panes auto-focus in their zone
    expect(body.pane.config.threadId).toBe(thread.id)
  })

  it('lists panes → 1 pane at position 0', async () => {
    const { status, body } = await json(`/api/v1/workspaces/${wsId}/panes`)
    expect(status).toBe(200)
    expect(body.items.length).toBe(1)
    expect(body.items[0].position).toBe(0)
  })

  it('creates second chat pane → position 1', async () => {
    const { body: thread } = await post('/api/v1/threads', {
      profileId: 'test-agent',
      title: 'Second Chat',
    })
    const { status, body } = await post(`/api/v1/workspaces/${wsId}/panes`, {
      config: { kind: 'chat', profileId: 'test-agent', threadId: thread.id },
      title: 'Second Chat',
    })
    expect(status).toBe(201)
    expect(body.pane.position).toBe(1)
  })

  it('reorders panes within the tabs zone', async () => {
    const { body: panesBody } = await json(`/api/v1/workspaces/${wsId}/panes`)
    const ids = panesBody.items.map((p: any) => p.id).reverse() // swap order

    const { status, body } = await put(`/api/v1/workspaces/${wsId}/panes`, {
      zone: 'tabs',
      ids,
    })
    expect(status).toBe(200)
    expect(body[0].id).toBe(ids[0])
    expect(body[0].position).toBe(0)
    expect(body[1].position).toBe(1)
  })

  it('deletes pane → thread remains', async () => {
    const { body: panesBody } = await json(`/api/v1/workspaces/${wsId}/panes`)
    const paneToDelete = panesBody.items.find(
      (p: any) => p.config.threadId === firstThreadId,
    )
    expect(paneToDelete).toBeTruthy()

    const { status, body } = await del(`/api/v1/workspaces/${wsId}/panes/${paneToDelete.id}`)
    expect(status).toBe(200)
    expect(body.closed).toBe(true)

    // Pane is gone
    const { body: remaining } = await json(`/api/v1/workspaces/${wsId}/panes`)
    expect(remaining.items.length).toBe(1)

    // Closing a pane never deletes the thread it wrapped
    const { status: threadStatus } = await json(`/api/v1/threads/${firstThreadId}`)
    expect(threadStatus).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// File tree
//
// The depth-recursive GET /workspaces/:id/files tree was superseded by
// the lazy per-directory GET /workspaces/:id/files/tree listing (coder
// explorer) — one directory level per request, entries are
// { name, path, type } with dirs first, then files, each alphabetical.
// ---------------------------------------------------------------------------

describe('workspace file tree', () => {
  let wsId: string

  it('creates workspace with nested files', async () => {
    const wsDir = join(tempDir, 'file-tree-test')
    await mkdir(join(wsDir, 'src'), { recursive: true })
    await mkdir(join(wsDir, 'docs'), { recursive: true })
    await mkdir(join(wsDir, '.git'), { recursive: true })
    await mkdir(join(wsDir, 'node_modules'), { recursive: true })
    await writeFile(join(wsDir, 'README.md'), '# Test')
    await writeFile(join(wsDir, 'src', 'index.ts'), 'console.log("hello")')
    await writeFile(join(wsDir, 'docs', 'guide.md'), '# Guide')
    await writeFile(join(wsDir, '.git', 'config'), 'git-config')
    await writeFile(join(wsDir, 'node_modules', 'pkg.json'), '{}')

    const { status, body } = await post('/api/v1/workspaces', { path: wsDir, name: 'Files WS' })
    expect(status).toBe(201)
    wsId = body.id
  })

  it('GET files/tree → correct root listing', async () => {
    const { status, body } = await json(`/api/v1/workspaces/${wsId}/files/tree`)
    expect(status).toBe(200)
    expect(Array.isArray(body.entries)).toBe(true)

    // Directories first, then files
    const names = body.entries.map((e: any) => e.name)
    expect(names).toContain('docs')
    expect(names).toContain('src')
    expect(names).toContain('README.md')
    expect(names.indexOf('docs')).toBeLessThan(names.indexOf('README.md'))
  })

  it('skips .git and node_modules', async () => {
    const { body } = await json(`/api/v1/workspaces/${wsId}/files/tree`)
    const names = body.entries.map((e: any) => e.name)
    expect(names).not.toContain('.git')
    expect(names).not.toContain('node_modules')
  })

  it('lists a subdirectory via ?path=', async () => {
    // Lazy expansion replaced the old ?depth= parameter — the explorer
    // fetches one directory level per request.
    const { status, body } = await json(`/api/v1/workspaces/${wsId}/files/tree?path=src`)
    expect(status).toBe(200)
    const entry = body.entries.find((e: any) => e.name === 'index.ts')
    expect(entry).toBeTruthy()
    expect(entry.type).toBe('file')
    expect(entry.path).toBe('src/index.ts') // workspace-relative, forward slashes
  })

  // (size/modifiedAt assertions removed — TreeEntry carries only
  // { name, path, type }; that per-entry stat surface went away with the
  // legacy recursive tree endpoint.)

  it('returns 404 not_found when workspace path is deleted', async () => {
    // The legacy endpoint answered 410 here; /files/tree reports a
    // missing root as a structured 404 { error: 'not_found' }.
    const ephemeralDir = join(tempDir, 'ephemeral-dir')
    await mkdir(ephemeralDir, { recursive: true })
    const { body: ws } = await post('/api/v1/workspaces', { path: ephemeralDir, name: 'Ephemeral' })

    // Delete the directory
    await rm(ephemeralDir, { recursive: true, force: true })

    const { status, body } = await json(`/api/v1/workspaces/${ws.id}/files/tree`)
    expect(status).toBe(404)
    expect(body.error).toBe('not_found')
  })
})
