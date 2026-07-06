/**
 * Calendar endpoints for the schedules vertical, over real HTTP against an
 * in-process gateway:
 *   GET  /schedules/occurrences?from&to   — paint the calendar grid
 *   POST /schedules/preview               — live "when would this run?" preview
 *
 * Also pins the route-ordering invariant: the literal /occurrences route must
 * win over /schedules/:id (else ":id" swallows "occurrences").
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
  root = mkdtempSync(join(tmpdir(), 'sched-cal-'))
  mkdirSync(join(root, 'profiles'), { recursive: true })
  gateway = new OwnwareGateway({
    port: 0,
    profilesDir: join(root, 'profiles'),
    dataDir: join(root, 'data'),
    dbPath: join(root, 'cal.db'),
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

const DAY = 24 * 60 * 60 * 1000

interface Occ {
  readonly scheduleId: string
  readonly profileId: string
  readonly name: string
  readonly at: number
}

describe('schedules calendar API', () => {
  let id: string

  beforeAll(async () => {
    const res = await post('/schedules', {
      profileId: 'ownware',
      name: 'Daily standup digest',
      prompt: 'summarize',
      cadenceKind: 'daily',
      cadenceExpr: '{"time":"09:00"}',
      cadenceDisplay: 'Daily at 9:00 AM',
      timezone: 'UTC',
    })
    id = ((await res.json()) as { schedule: { id: string } }).schedule.id
  })

  it('GET /schedules/occurrences paints a daily schedule across a 7-day window', async () => {
    const from = Date.now()
    const to = from + 7 * DAY
    const res = await api(`/schedules/occurrences?from=${from}&to=${to}`)
    expect(res.status).toBe(200) // literal route wins over /:id
    const { occurrences } = (await res.json()) as { occurrences: Occ[] }
    // A daily schedule yields ~7 fires in a 7-day window.
    expect(occurrences.length).toBeGreaterThanOrEqual(6)
    expect(occurrences.length).toBeLessThanOrEqual(8)
    // All belong to our schedule, lie inside the window, and carry display data.
    for (const o of occurrences) {
      expect(o.scheduleId).toBe(id)
      expect(o.profileId).toBe('ownware')
      expect(o.name).toBe('Daily standup digest')
      expect(o.at).toBeGreaterThan(from)
      expect(o.at).toBeLessThanOrEqual(to)
    }
    // Sorted ascending.
    const ats = occurrences.map((o) => o.at)
    expect([...ats].sort((a, b) => a - b)).toEqual(ats)
  })

  it('occurrences can be filtered by profile + rejects a bad window (400)', async () => {
    const from = Date.now()
    const to = from + DAY
    const mine = (await (await api(`/schedules/occurrences?from=${from}&to=${to}&profileId=ownware`)).json()) as {
      occurrences: Occ[]
    }
    expect(mine.occurrences.every((o) => o.profileId === 'ownware')).toBe(true)
    const none = (await (await api(`/schedules/occurrences?from=${from}&to=${to}&profileId=nobody`)).json()) as {
      occurrences: Occ[]
    }
    expect(none.occurrences).toEqual([])
    // Missing / inverted window → 400.
    expect((await api('/schedules/occurrences')).status).toBe(400)
    expect((await api(`/schedules/occurrences?from=${to}&to=${from}`)).status).toBe(400)
  })

  it('POST /schedules/preview returns the next N fire times for an unsaved cadence', async () => {
    const res = await post('/schedules/preview', {
      cadenceKind: 'daily',
      cadenceExpr: '{"time":"09:00"}',
      timezone: 'UTC',
      count: 5,
    })
    expect(res.status).toBe(200)
    const { occurrences } = (await res.json()) as { occurrences: number[] }
    expect(occurrences).toHaveLength(5)
    // Strictly increasing, all in the future, ~1 day apart.
    for (let i = 1; i < occurrences.length; i++) {
      expect(occurrences[i]!).toBeGreaterThan(occurrences[i - 1]!)
    }
    expect(occurrences[0]!).toBeGreaterThan(Date.now())
  })

  it('preview rejects an invalid body (400)', async () => {
    expect((await post('/schedules/preview', { cadenceKind: 'daily' })).status).toBe(400) // missing expr/tz
    expect((await post('/schedules/preview', { cadenceKind: 'bogus', cadenceExpr: 'x', timezone: 'UTC' })).status).toBe(400)
  })

  it('a "once" preview in the past yields no occurrences', async () => {
    const res = await post('/schedules/preview', {
      cadenceKind: 'once',
      cadenceExpr: String(Date.now() - DAY),
      timezone: 'UTC',
    })
    expect(res.status).toBe(200)
    const { occurrences } = (await res.json()) as { occurrences: number[] }
    expect(occurrences).toEqual([])
  })
})

interface RecentRun {
  readonly id: string
  readonly scheduleId: string
  readonly scheduleName: string
  readonly profileId: string
  readonly runStatus: string
  readonly scheduledFor: number
}

describe('cross-schedule recent runs feed (GET /schedules/runs)', () => {
  let aId: string
  let bId: string

  beforeAll(async () => {
    const mk = async (name: string, profileId: string): Promise<string> => {
      const res = await post('/schedules', {
        profileId,
        name,
        prompt: 'do',
        cadenceKind: 'daily',
        cadenceExpr: '{"time":"09:00"}',
        cadenceDisplay: 'Daily at 9:00 AM',
        timezone: 'UTC',
      })
      return ((await res.json()) as { schedule: { id: string } }).schedule.id
    }
    aId = await mk('Inbox triage', 'ari')
    bId = await mk('Newsletter', 'marketing')

    // Record runs directly via the store (thread_id null → no FK needed).
    const store = gateway.schedules
    const base = Date.now()
    store.recordRun({ scheduleId: aId, scheduledFor: base - 3000, runStatus: 'succeeded', finishedAt: base - 2900 })
    store.recordRun({ scheduleId: bId, scheduledFor: base - 2000, runStatus: 'ran-empty', finishedAt: base - 1900 })
    store.recordRun({ scheduleId: aId, scheduledFor: base - 1000, runStatus: 'running', startedAt: base - 1000 })
  })

  it('returns runs across all schedules, newest first, enriched with schedule name + profileId', async () => {
    const { runs } = (await (await api('/schedules/runs')).json()) as { runs: RecentRun[] }
    expect(runs.length).toBeGreaterThanOrEqual(3)
    // Newest-first by scheduledFor.
    const ours = runs.filter((r) => r.scheduleId === aId || r.scheduleId === bId)
    const ats = ours.map((r) => r.scheduledFor)
    expect([...ats].sort((x, y) => y - x)).toEqual(ats)
    // Enriched + cross-schedule (both schedules present).
    const a = ours.find((r) => r.scheduleId === aId)!
    expect(a.scheduleName).toBe('Inbox triage')
    expect(a.profileId).toBe('ari')
    expect(ours.some((r) => r.scheduleId === bId && r.scheduleName === 'Newsletter')).toBe(true)
  })

  it('?status=running narrows to in-flight runs only', async () => {
    const { runs } = (await (await api('/schedules/runs?status=running')).json()) as { runs: RecentRun[] }
    expect(runs.length).toBeGreaterThanOrEqual(1)
    expect(runs.every((r) => r.runStatus === 'running')).toBe(true)
  })
})
