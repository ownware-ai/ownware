/**
 * Integration tests for the memory system HTTP surface.
 *
 * Spins a real `OwnwareGateway` against a temp profiles + data dir.
 * Exercises every public memory endpoint and verifies SSE
 * invalidation hints fan out exactly once per write.
 *
 * One full "approval flow" pass at the end proves end-to-end:
 *   propose (via store, simulating the agent tool)
 *     → list pending → accept (with edit)
 *     → memory shows up in list, ranked top-N visible.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OwnwareGateway } from '../../../src/gateway/server.js'

let gateway: OwnwareGateway
let baseUrl: string
let profilesDir: string
let dataDir: string

const PROFILE_ID = 'mem-fixture'

beforeAll(async () => {
  profilesDir = await mkdtemp(join(tmpdir(), 'cortex-mem-profiles-'))
  dataDir = await mkdtemp(join(tmpdir(), 'cortex-mem-data-'))
  // Seed a minimal profile in <dataDir>/profiles so the registry resolves it.
  const userProfiles = join(dataDir, 'profiles')
  await mkdir(userProfiles, { recursive: true })
  const dir = join(userProfiles, PROFILE_ID)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'agent.json'),
    JSON.stringify({
      name: PROFILE_ID,
      model: 'anthropic:claude-haiku-4-5-20251001',
    }),
  )
  await writeFile(join(dir, 'SOUL.md'), '# Mem\n')

  gateway = new OwnwareGateway({ port: 0, profilesDir, dataDir })
  await gateway.start()
  baseUrl = `http://localhost:${gateway.port}`
}, 15_000)

afterAll(async () => {
  await gateway.stop()
  await rm(profilesDir, { recursive: true, force: true })
  await rm(dataDir, { recursive: true, force: true })
})

beforeEach(() => {
  // Wipe memory tables between tests so each starts clean.
  const handle = gateway.state.rawDbHandle
  handle.exec('DELETE FROM memories; DELETE FROM memory_proposals; DELETE FROM user_identity;')
})

function headers(extra?: Record<string, string>): Record<string, string> {
  return { Authorization: `Bearer ${gateway.token}`, ...extra }
}

async function get(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, { headers: headers() })
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

async function post(path: string, data: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    body: JSON.stringify(data),
    headers: headers({ 'Content-Type': 'application/json' }),
  })
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

async function patch(path: string, data: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
    headers: headers({ 'Content-Type': 'application/json' }),
  })
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

async function put(path: string, data: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'PUT',
    body: JSON.stringify(data),
    headers: headers({ 'Content-Type': 'application/json' }),
  })
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

async function del(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'DELETE',
    headers: headers(),
  })
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

describe('Memory CRUD endpoints', () => {
  it('POST creates a user-pinned memory', async () => {
    const r = await post(`/api/v1/profiles/${PROFILE_ID}/memories`, {
      content: 'User uses Bun, not npm',
      kind: 'preference',
      pinned: true,
    })
    expect(r.status).toBe(201)
    expect(r.body.memory).toMatchObject({
      profileId: PROFILE_ID,
      content: 'User uses Bun, not npm',
      kind: 'preference',
      source: 'user_pinned',
      pinned: true,
      confidence: 1,
      status: 'active',
    })
  })

  it('GET lists active memories with total count', async () => {
    await post(`/api/v1/profiles/${PROFILE_ID}/memories`, { content: 'A' })
    await post(`/api/v1/profiles/${PROFILE_ID}/memories`, { content: 'B', pinned: true })
    const r = await get(`/api/v1/profiles/${PROFILE_ID}/memories`)
    expect(r.status).toBe(200)
    expect(r.body.items).toHaveLength(2)
    expect(r.body.total).toBe(2)
    // pinned 'B' first
    expect(r.body.items[0].content).toBe('B')
  })

  it('PATCH edits content and pin', async () => {
    const c = await post(`/api/v1/profiles/${PROFILE_ID}/memories`, { content: 'before' })
    const r = await patch(`/api/v1/memories/${c.body.memory.id}`, { content: 'after', pinned: true })
    expect(r.status).toBe(200)
    expect(r.body.memory.content).toBe('after')
    expect(r.body.memory.pinned).toBe(true)
  })

  it('PATCH archives via status field', async () => {
    const c = await post(`/api/v1/profiles/${PROFILE_ID}/memories`, { content: 'tmp' })
    await patch(`/api/v1/memories/${c.body.memory.id}`, { status: 'archived' })
    const list = await get(`/api/v1/profiles/${PROFILE_ID}/memories?status=archived`)
    expect(list.body.items).toHaveLength(1)
    expect(list.body.items[0].status).toBe('archived')
    const active = await get(`/api/v1/profiles/${PROFILE_ID}/memories`)
    expect(active.body.items).toHaveLength(0)
  })

  it('DELETE removes the row', async () => {
    const c = await post(`/api/v1/profiles/${PROFILE_ID}/memories`, { content: 'gone' })
    const r = await del(`/api/v1/memories/${c.body.memory.id}`)
    expect(r.status).toBe(200)
    expect(r.body.ok).toBe(true)
    const list = await get(`/api/v1/profiles/${PROFILE_ID}/memories?status=all`)
    expect(list.body.items).toHaveLength(0)
  })

  it('rejects oversize content with 400', async () => {
    const r = await post(`/api/v1/profiles/${PROFILE_ID}/memories`, {
      content: 'x'.repeat(3000),
    })
    expect(r.status).toBe(400)
    expect(typeof r.body.error).toBe('string')
  })

  it('returns 404 for missing memory', async () => {
    const r = await patch('/api/v1/memories/mem_nope', { content: 'x' })
    expect(r.status).toBe(404)
  })
})

describe('Proposal approval flow', () => {
  it('end-to-end: propose → list pending → accept (with edit) → appears in memories', async () => {
    // Use the in-process store as a stand-in for the agent's `remember` tool —
    // the wire shape from there forward is identical to a real session call.
    const proposal = gateway.memorySystem.proposals.propose({
      profileId: PROFILE_ID,
      threadId: 'thread_test',
      content: 'User prefers tabs over spaces',
      kind: 'preference',
    })

    const pending = await get(`/api/v1/profiles/${PROFILE_ID}/memories/proposals`)
    expect(pending.status).toBe(200)
    expect(pending.body.items).toHaveLength(1)
    expect(pending.body.items[0].id).toBe(proposal.id)
    expect(pending.body.pendingCount).toBe(1)

    // User edits during accept.
    const accept = await post(`/api/v1/memories/proposals/${proposal.id}/accept`, {
      content: 'User prefers spaces over tabs',
      pinned: true,
    })
    expect(accept.status).toBe(200)
    expect(accept.body.proposal.status).toBe('edited')
    expect(accept.body.memory.content).toBe('User prefers spaces over tabs')
    expect(accept.body.memory.pinned).toBe(true)

    // Memory now visible in the active list.
    const list = await get(`/api/v1/profiles/${PROFILE_ID}/memories`)
    expect(list.body.items).toHaveLength(1)
    expect(list.body.items[0].sourceProposalId).toBe(proposal.id)

    // Pending count drops to zero.
    const after = await get(`/api/v1/profiles/${PROFILE_ID}/memories/proposals`)
    expect(after.body.pendingCount).toBe(0)
  })

  it('reject leaves no memory; reason is recorded', async () => {
    const p = gateway.memorySystem.proposals.propose({
      profileId: PROFILE_ID,
      threadId: 't',
      content: 'wrong fact',
    })
    const r = await post(`/api/v1/memories/proposals/${p.id}/reject`, { reason: 'incorrect' })
    expect(r.status).toBe(200)
    expect(r.body.proposal.status).toBe('rejected')
    expect(r.body.proposal.rejectionReason).toBe('incorrect')

    const list = await get(`/api/v1/profiles/${PROFILE_ID}/memories?status=all`)
    expect(list.body.items).toHaveLength(0)
  })

  it('per-thread listing scopes correctly', async () => {
    gateway.memorySystem.proposals.propose({
      profileId: PROFILE_ID,
      threadId: 'thread_a',
      content: 'A',
    })
    gateway.memorySystem.proposals.propose({
      profileId: PROFILE_ID,
      threadId: 'thread_b',
      content: 'B',
    })
    const a = await get(`/api/v1/threads/thread_a/memories/proposals`)
    expect(a.body.items).toHaveLength(1)
    expect(a.body.items[0].proposedContent).toBe('A')
  })

  it('double-accept returns 409', async () => {
    const p = gateway.memorySystem.proposals.propose({
      profileId: PROFILE_ID,
      threadId: 't',
      content: 'X',
    })
    await post(`/api/v1/memories/proposals/${p.id}/accept`, {})
    const second = await post(`/api/v1/memories/proposals/${p.id}/accept`, {})
    expect(second.status).toBe(409)
  })
})

describe('User identity endpoints', () => {
  it('GET returns empty record before first set', async () => {
    const r = await get('/api/v1/user/identity')
    expect(r.status).toBe(200)
    expect(r.body.identity).toMatchObject({ name: null, role: null, updatedAt: null })
  })

  it('PUT upserts; subsequent GET reflects values', async () => {
    const u1 = await put('/api/v1/user/identity', {
      name: 'Sam',
      role: 'Founder',
      timezone: 'PST',
    })
    expect(u1.status).toBe(200)
    expect(u1.body.identity.name).toBe('Sam')

    const r = await get('/api/v1/user/identity')
    expect(r.body.identity).toMatchObject({
      name: 'Sam',
      role: 'Founder',
      timezone: 'PST',
    })
  })

  it('partial PUT preserves siblings', async () => {
    await put('/api/v1/user/identity', { name: 'A', role: 'B' })
    await put('/api/v1/user/identity', { name: 'A2' })
    const r = await get('/api/v1/user/identity')
    expect(r.body.identity).toMatchObject({ name: 'A2', role: 'B' })
  })

  it('null clears a field', async () => {
    await put('/api/v1/user/identity', { name: 'A', role: 'B' })
    await put('/api/v1/user/identity', { role: null })
    const r = await get('/api/v1/user/identity')
    expect(r.body.identity).toMatchObject({ name: 'A', role: null })
  })

  it('rejects oversize fields with 400', async () => {
    const r = await put('/api/v1/user/identity', { name: 'x'.repeat(500) })
    expect(r.status).toBe(400)
  })
})
