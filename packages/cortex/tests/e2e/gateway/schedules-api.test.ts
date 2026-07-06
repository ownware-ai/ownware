/**
 * Schedules HTTP API — driven end-to-end over real HTTP against an
 * in-process gateway. CRUD + pause/resume + list-runs + validation.
 * No model call (run-now-with-a-real-model is covered by the gated
 * tests/e2e/schedule-fires-real.test.ts), so this runs in the normal suite.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { OwnwareGateway } from '../../../src/gateway/server.js'

let gateway: OwnwareGateway
let baseUrl: string
let root: string

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'sched-api-'))
  mkdirSync(join(root, 'profiles'), { recursive: true })
  gateway = new OwnwareGateway({
    port: 0,
    profilesDir: join(root, 'profiles'),
    dataDir: join(root, 'data'),
    dbPath: join(root, 'api.db'),
    tls: false,
    disableAuth: true,
  })
  await gateway.start()
  baseUrl = `http://127.0.0.1:${gateway.port}`
})

afterAll(async () => {
  await gateway?.stop().catch(() => {})
  rmSync(root, { recursive: true, force: true })
})

const api = (path: string, init?: RequestInit): Promise<Response> =>
  fetch(`${baseUrl}/api/v1${path}`, init)
const post = (path: string, body?: unknown): Promise<Response> =>
  api(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
const patch = (path: string, body: unknown): Promise<Response> =>
  api(path, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

const validBody = {
  profileId: 'ownware',
  name: 'Morning triage',
  prompt: 'triage inbox',
  cadenceKind: 'daily',
  cadenceExpr: '{"time":"09:00"}',
  cadenceDisplay: 'Daily at 9:00 AM',
  timezone: 'UTC',
}

interface ScheduleResp {
  schedule: { id: string; name: string; enabled: boolean; catchUpPolicy: string }
}

describe('schedules HTTP API', () => {
  let id: string

  it('POST /schedules creates (201); GET lists + filters by profile', async () => {
    const res = await post('/schedules', validBody)
    expect(res.status).toBe(201)
    const { schedule } = (await res.json()) as ScheduleResp
    expect(schedule.id).toMatch(/^sched_/)
    expect(schedule.catchUpPolicy).toBe('catch-up') // owner-locked default
    id = schedule.id

    const list = (await (await api('/schedules')).json()) as { schedules: Array<{ id: string }> }
    expect(list.schedules.map((s) => s.id)).toContain(id)

    const byProfile = (await (await api('/schedules?profileId=ownware')).json()) as {
      schedules: Array<{ id: string }>
    }
    expect(byProfile.schedules.map((s) => s.id)).toContain(id)
    const otherProfile = (await (await api('/schedules?profileId=nobody')).json()) as {
      schedules: unknown[]
    }
    expect(otherProfile.schedules).toEqual([])
  })

  it('GET /schedules/:id returns it; unknown → 404', async () => {
    expect((await api(`/schedules/${id}`)).status).toBe(200)
    expect((await api('/schedules/sched_nope')).status).toBe(404)
  })

  it('PATCH edits fields', async () => {
    const res = await patch(`/schedules/${id}`, { name: 'Renamed', catchUpPolicy: 'skip' })
    expect(res.status).toBe(200)
    const { schedule } = (await res.json()) as ScheduleResp
    expect(schedule.name).toBe('Renamed')
    expect(schedule.catchUpPolicy).toBe('skip')
  })

  it('pause/resume toggles enabled', async () => {
    const paused = (await (await post(`/schedules/${id}/pause`)).json()) as ScheduleResp
    expect(paused.schedule.enabled).toBe(false)
    const resumed = (await (await post(`/schedules/${id}/resume`)).json()) as ScheduleResp
    expect(resumed.schedule.enabled).toBe(true)
  })

  it('GET /:id/runs is empty initially', async () => {
    const { runs } = (await (await api(`/schedules/${id}/runs`)).json()) as { runs: unknown[] }
    expect(runs).toEqual([])
  })

  it('rejects invalid bodies (400)', async () => {
    expect((await post('/schedules', { name: 'x' })).status).toBe(400) // missing required fields
    expect((await post('/schedules', { ...validBody, cadenceKind: 'bogus' })).status).toBe(400)
    // 'window' policy requires a window
    expect((await post('/schedules', { ...validBody, catchUpPolicy: 'window' })).status).toBe(400)
  })

  it('DELETE removes it', async () => {
    expect((await api(`/schedules/${id}`, { method: 'DELETE' })).status).toBe(200)
    expect((await api(`/schedules/${id}`)).status).toBe(404)
    expect((await api(`/schedules/${id}`, { method: 'DELETE' })).status).toBe(404)
  })
})
