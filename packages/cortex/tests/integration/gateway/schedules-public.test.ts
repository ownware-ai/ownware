import { afterEach, describe, expect, it } from 'vitest'
import { createTestGateway, type TestGateway } from '../../framework/harness/index.js'

/**
 * P1 promotion: the schedules family enters the public contract. These cases
 * cover what promotion added — the owner-only boundary and capability
 * discovery — plus one full lifecycle over real HTTP.
 */

const PROFILE = 'schedules-public'

let gateway: TestGateway | undefined

afterEach(async () => {
  await gateway?.stop()
  gateway = undefined
})

describe('schedules (public)', () => {
  it('advertises both capabilities', async () => {
    gateway = await createTestGateway({ profiles: [{ name: PROFILE, tools: { preset: 'none' } }] })
    const body = (await gateway.client.get('/api/v1/capabilities')).body as {
      capabilities: ReadonlyArray<{ id: string }>
    }
    const ids = new Set(body.capabilities.map((c) => c.id))
    expect(ids.has('schedules.read')).toBe(true)
    expect(ids.has('schedules.manage')).toBe(true)
    expect(ids.has('threads.list')).toBe(true)
  })

  it('walks the full lifecycle: create, read, pause, resume, runs, delete', async () => {
    gateway = await createTestGateway({ profiles: [{ name: PROFILE, tools: { preset: 'none' } }] })
    const created = await gateway.client.post('/api/v1/schedules', {
      profileId: PROFILE,
      name: 'morning triage',
      prompt: 'triage the inbox',
      cadenceKind: 'daily',
      cadenceExpr: '{"time":"07:30"}',
      cadenceDisplay: 'Every day at 07:30',
      timezone: 'UTC',
    })
    expect(created.status).toBe(201)
    const schedule = (created.body as { schedule: { id: string; safetyLevel: string; nextRunAt: number | null } }).schedule
    // The effective envelope rides along — the surface can display it.
    expect(schedule.safetyLevel).toBe('draft-approval')
    expect(schedule.nextRunAt).not.toBeNull()

    const paused = await gateway.client.post(`/api/v1/schedules/${schedule.id}/pause`, {})
    expect((paused.body as { schedule: { enabled: boolean } }).schedule.enabled).toBe(false)
    const resumed = await gateway.client.post(`/api/v1/schedules/${schedule.id}/resume`, {})
    expect((resumed.body as { schedule: { enabled: boolean } }).schedule.enabled).toBe(true)

    const runs = await gateway.client.get(`/api/v1/schedules/${schedule.id}/runs`)
    expect(runs.status).toBe(200)
    expect((runs.body as { runs: unknown[] }).runs).toEqual([])

    const deleted = await fetch(
      `${gateway.baseUrl}/api/v1/schedules/${schedule.id}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${gateway.token}` } },
    )
    expect(deleted.status).toBe(200)
  })

  it('refuses every schedule surface to a delegated principal', async () => {
    gateway = await createTestGateway({
      disableAuth: false,
      profiles: [{ name: PROFILE, tools: { preset: 'none' } }],
    })
    const workspaceId = (await gateway.state.createWorkspace(gateway.tmpDir, 'Sched')).id
    const issued = await gateway.client.post('/api/v1/auth/delegations', {
      delegateId: 'browser-sched',
      workspaceId,
      profileId: PROFILE,
      subjectId: 'subject-a',
      purpose: 'support',
      channel: 'web',
      operations: ['schedules.read', 'schedules.manage'],
    })
    const token = (issued.body as { token: string }).token
    // Routines run unattended under their own envelope; even a delegation
    // naming the operations is refused — this is an owner surface.
    for (const [method, path] of [
      ['GET', '/api/v1/schedules'],
      ['POST', '/api/v1/schedules'],
      ['GET', '/api/v1/schedules/runs'],
      ['POST', '/api/v1/schedules/preview'],
    ] as const) {
      const response = await fetch(`${gateway.baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(method === 'POST' ? { body: '{}' } : {}),
      })
      expect(response.status, `${method} ${path}`).toBe(403)
    }
  })
})
