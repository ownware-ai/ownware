/**
 * Contract tests — /api/v1/teams surface (the team vertical, S1).
 *
 * No LLM, no API key: CRUD shapes, validation failures, run binding,
 * and the board read. The full behavioural path (members working,
 * conductor wakes, finish_run) lives in tests/e2e/team-run.test.ts.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createTestGateway, type TestGateway } from '../harness/gateway.js'

const TeamSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  displayName: z.string(),
  conductorName: z.string(),
  memberCount: z.number(),
  members: z.array(
    z.object({ slug: z.string(), profileId: z.string(), role: z.string() }),
  ),
  lastRun: z
    .object({
      runId: z.string(),
      status: z.string(),
      receipt: z.unknown().nullable(),
      updatedAt: z.string(),
    })
    .nullable(),
})

let gw: TestGateway

beforeAll(async () => {
  gw = await createTestGateway()
})

afterAll(async () => {
  await gw.stop()
})

describe('contract: /api/v1/teams', () => {
  it('rejects an invalid team (bad slug, unknown member profile, dup slugs)', async () => {
    const badName = await gw.client.post('/api/v1/teams', {
      name: 'Bad Name!',
      displayName: 'X',
      members: [{ slug: 'a', profileId: 'mini', role: 'R' }],
    })
    expect(badName.status).toBe(400)

    const unknownProfile = await gw.client.post('/api/v1/teams', {
      name: 'ghost-crew',
      displayName: 'Ghost Crew',
      members: [{ slug: 'a', profileId: 'does-not-exist', role: 'R' }],
    })
    expect(unknownProfile.status).toBe(400)
    expect((unknownProfile.body as { message: string }).message).toMatch(/not registered/)

    const dupSlugs = await gw.client.post('/api/v1/teams', {
      name: 'dup-crew',
      displayName: 'Dup Crew',
      members: [
        { slug: 'a', profileId: 'mini', role: 'R1' },
        { slug: 'a', profileId: 'mini', role: 'R2' },
      ],
    })
    expect(dupSlugs.status).toBe(400)
  })

  it('creates, lists, updates, and deletes a team; duplicate names 409', async () => {
    const created = await gw.client.post<{ id: string; members: unknown[] }>('/api/v1/teams', {
      name: 'crud-crew',
      displayName: 'CRUD Crew',
      charter: 'Test charter.',
      members: [{ slug: 'solo', profileId: 'mini', role: 'Everything' }],
    })
    expect(created.status).toBe(201)
    const teamId = created.body.id

    const dup = await gw.client.post('/api/v1/teams', {
      name: 'crud-crew',
      displayName: 'Other',
      members: [{ slug: 'x', profileId: 'mini', role: 'R' }],
    })
    expect(dup.status).toBe(409)

    const list = await gw.client.get('/api/v1/teams', z.array(TeamSummarySchema))
    expect(list.status).toBe(200)
    expect(list.body.some((t) => t.id === teamId)).toBe(true)

    const patched = await gw.client.patch<{ displayName: string }>(`/api/v1/teams/${teamId}`, {
      displayName: 'CRUD Crew v2',
    })
    expect(patched.status).toBe(200)
    expect(patched.body.displayName).toBe('CRUD Crew v2')

    const deleted = await gw.client.delete<{ deleted: boolean }>(`/api/v1/teams/${teamId}`)
    expect(deleted.status).toBe(200)
    expect((await gw.client.get(`/api/v1/teams/${teamId}`)).status).toBe(404)
  })

  it('starts a run bound 1:1 to a thread, parks a conductor session, serves the board', async () => {
    const created = await gw.client.post<{ id: string }>('/api/v1/teams', {
      name: 'run-crew',
      displayName: 'Run Crew',
      members: [{ slug: 'solo', profileId: 'mini', role: 'Everything' }],
    })
    expect(created.status).toBe(201)

    const runRes = await gw.client.post<{
      runId: string
      threadId: string
      conductorProfileId: string
      model: string
    }>(`/api/v1/teams/${created.body.id}/runs`, {})
    expect(runRes.status).toBe(201)
    expect(runRes.body.conductorProfileId).toContain('team-conductor-')

    // Conductor session is parked in gateway state — the normal /run
    // pipeline will reuse it (no team code in run.ts).
    expect(gw.state.getSession(runRes.body.threadId)).toBeDefined()
    expect(gw.state.getSessionCompanions(runRes.body.threadId)).toBeDefined()

    // The conductor profile is registered but hidden from the lobby.
    const profiles = await gw.client.get<Array<{ id?: string; name?: string }>>('/api/v1/profiles')
    expect(profiles.status).toBe(200)

    // Board read: empty board, active run.
    const board = await gw.client.get<{
      run: { id: string; status: string }
      teamName: string
      tasks: unknown[]
    }>(`/api/v1/threads/${runRes.body.threadId}/team-board`)
    expect(board.status).toBe(200)
    expect(board.body.run.id).toBe(runRes.body.runId)
    expect(board.body.run.status).toBe('active')
    expect(board.body.tasks).toEqual([])

    // A non-team thread has no board.
    const thread = await gw.client.post<{ id: string }>('/api/v1/threads', { profileId: 'mini' })
    const noBoard = await gw.client.get(`/api/v1/threads/${thread.body.id}/team-board`)
    expect(noBoard.status).toBe(404)

    // Cancel closes the run.
    const cancel = await gw.client.post<{ cancelled: boolean }>(
      `/api/v1/team-runs/${runRes.body.runId}/cancel`,
      { reason: 'contract test cleanup' },
    )
    expect(cancel.status).toBe(200)
    const after = await gw.client.get<{ run: { status: string } }>(
      `/api/v1/threads/${runRes.body.threadId}/team-board`,
    )
    expect(after.body.run.status).toBe('cancelled')
    const cancelAgain = await gw.client.post(`/api/v1/team-runs/${runRes.body.runId}/cancel`, {})
    expect(cancelAgain.status).toBe(409)
  })

  it('team.changed invalidation hints ride the multiplexed /api/v1/events SSE', async () => {
    // Subscribe to the multiplexed channel, then mutate the catalog
    // and a run — both scopes must arrive as hint-only envelopes.
    const controller = new AbortController()
    const res = await fetch(`${gw.baseUrl}/api/v1/events`, {
      headers: { Authorization: `Bearer ${gw.token}`, Accept: 'text/event-stream' },
      signal: controller.signal,
    })
    expect(res.ok).toBe(true)
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const readUntil = async (predicate: () => boolean, timeoutMs: number): Promise<void> => {
      const deadline = Date.now() + timeoutMs
      while (!predicate() && Date.now() < deadline) {
        const racer = await Promise.race([
          reader.read(),
          new Promise<null>((r) => setTimeout(() => r(null), 500)),
        ])
        if (racer && !racer.done && racer.value) {
          buffer += decoder.decode(racer.value, { stream: true })
        }
      }
    }

    try {
      const created = await gw.client.post<{ id: string }>('/api/v1/teams', {
        name: 'sse-crew',
        displayName: 'SSE Crew',
        members: [{ slug: 'solo', profileId: 'mini', role: 'R' }],
      })
      expect(created.status).toBe(201)
      await readUntil(() => buffer.includes('event: team.changed'), 10_000)
      expect(buffer).toContain('event: team.changed')
      expect(buffer).toContain('"scope":"teams"')

      const runRes = await gw.client.post<{ runId: string; threadId: string }>(
        `/api/v1/teams/${created.body.id}/runs`,
        {},
      )
      const cancel = await gw.client.post(`/api/v1/team-runs/${runRes.body.runId}/cancel`, {})
      expect(cancel.status).toBe(200)
      await readUntil(() => buffer.includes('"scope":"board"'), 10_000)
      expect(buffer).toContain('"scope":"board"')
      expect(buffer).toContain(runRes.body.threadId)
      // Hint-only: no business fields on the wire.
      expect(buffer).not.toContain('SSE Crew')
    } finally {
      controller.abort()
    }
  })
})
