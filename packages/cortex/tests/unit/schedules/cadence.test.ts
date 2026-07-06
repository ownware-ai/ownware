/**
 * Cadence math — pure unit tests (no DB, no clock). Proves timezone/DST
 * correctness, weekend + holiday skipping, weekly day selection, and the
 * range/next-N helpers the calendar + live-preview depend on.
 */
import { describe, it, expect } from 'vitest'
import {
  computeNextRun,
  occurrencesInRange,
  nextOccurrences,
  type CadenceContext,
} from '../../../src/schedules/cadence.js'
import type { ScheduleDto } from '../../../src/schedules/types.js'

function sched(over: Partial<ScheduleDto>): ScheduleDto {
  return {
    id: 'sched_x',
    profileId: 'p',
    workspaceId: null,
    name: 't',
    prompt: 'p',
    model: null,
    cadenceKind: 'daily',
    cadenceExpr: '{"time":"09:00"}',
    cadenceDisplay: 'Daily at 9:00 AM',
    timezone: 'America/New_York',
    catchUpPolicy: 'catch-up',
    catchUpWindowMs: null,
    overlapPolicy: 'skip-if-running',
    skipWeekends: false,
    skipHolidays: false,
    toolEnvelope: null,
    enabled: true,
    state: 'scheduled',
    nextRunAt: null,
    lastRunAt: null,
    lastRunId: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }
}

/** Local "HH:MM" of an epoch in a tz. */
function hm(epoch: number, tz: string): string {
  const m: Record<string, string> = {}
  for (const p of new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    hourCycle: 'h23',
  }).formatToParts(new Date(epoch)))
    m[p.type] = p.value
  return `${m['hour']}:${m['minute']}`
}
/** Local weekday 0=Sun … 6=Sat. */
function wd(epoch: number, tz: string): number {
  const s = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(new Date(epoch))
  return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[s as 'Sun']!
}
/** Local "YYYY-MM-DD". */
function iso(epoch: number, tz: string): string {
  const m: Record<string, string> = {}
  for (const p of new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(epoch)))
    m[p.type] = p.value
  return `${m['year']}-${m['month']}-${m['day']}`
}

describe('cadence — daily + timezone/DST', () => {
  it('daily fires at the wall-clock time in the schedule timezone', () => {
    const s = sched({ cadenceKind: 'daily', cadenceExpr: '{"time":"09:00"}', timezone: 'America/New_York' })
    const from = Date.UTC(2026, 5, 1, 0, 0) // June 1, 00:00 UTC
    const next = computeNextRun(s, from)!
    expect(hm(next, 'America/New_York')).toBe('09:00')
  })

  it('★ a 9:00 daily STAYS 9:00 across the spring-forward DST boundary (no hour drift)', () => {
    // US DST 2026 begins Sun Mar 8. Mar 7 = EST (UTC-5), Mar 8+ = EDT (UTC-4).
    const s = sched({ cadenceKind: 'daily', cadenceExpr: '{"time":"09:00"}', timezone: 'America/New_York' })
    const from = new Date('2026-03-06T12:00:00-05:00').getTime() // Fri Mar 6, noon ET
    const occ = nextOccurrences(s, 5, from) // Mar 7,8,9,10,11
    expect(occ.length).toBe(5)
    for (const t of occ) expect(hm(t, 'America/New_York')).toBe('09:00')
    expect(iso(occ[0]!, 'America/New_York')).toBe('2026-03-07') // EST
    expect(iso(occ[2]!, 'America/New_York')).toBe('2026-03-09') // EDT
    // The actual UTC offset changed (different absolute gap), but local stayed 9:00.
    const gapAcrossDst = occ[2]! - occ[1]! // Mar 9 - Mar 8, both EDT → exactly 24h
    expect(gapAcrossDst).toBe(24 * 60 * 60_000)
    const gapOverTransition = occ[1]! - occ[0]! // Mar 8 - Mar 7, EST→EDT → 23h
    expect(gapOverTransition).toBe(23 * 60 * 60_000)
  })

  it('a different timezone gives a different absolute instant for the same wall time', () => {
    const ny = computeNextRun(sched({ timezone: 'America/New_York' }), Date.UTC(2026, 5, 1, 0, 0))!
    const la = computeNextRun(sched({ timezone: 'America/Los_Angeles' }), Date.UTC(2026, 5, 1, 0, 0))!
    expect(hm(ny, 'America/New_York')).toBe('09:00')
    expect(hm(la, 'America/Los_Angeles')).toBe('09:00')
    expect(la).not.toBe(ny) // 9am LA is 3h after 9am NY
  })
})

describe('cadence — weekly / weekdays / weekend + holiday skipping', () => {
  it('weekly fires only on the chosen days', () => {
    const s = sched({ cadenceKind: 'weekly', cadenceExpr: '{"time":"09:00","days":[1,3,5]}', timezone: 'UTC' })
    const from = Date.UTC(2026, 5, 7, 0, 0) // Sun Jun 7 2026
    const occ = nextOccurrences(s, 3, from)
    expect(occ.map((t) => wd(t, 'UTC'))).toEqual([1, 3, 5]) // Mon, Wed, Fri
    for (const t of occ) expect(hm(t, 'UTC')).toBe('09:00')
  })

  it('weekdays skips Saturday and Sunday', () => {
    const s = sched({ cadenceKind: 'weekdays', cadenceExpr: '{"time":"09:00"}', timezone: 'UTC' })
    // Fri Jun 5 2026, after 9am → next must be Monday Jun 8 (skip Sat/Sun).
    const from = Date.UTC(2026, 5, 5, 12, 0)
    const next = computeNextRun(s, from)!
    expect(wd(next, 'UTC')).toBe(1) // Monday
    expect(iso(next, 'UTC')).toBe('2026-06-08')
  })

  it('skipWeekends on a daily pushes a weekend occurrence to Monday', () => {
    const s = sched({ cadenceKind: 'daily', cadenceExpr: '{"time":"09:00"}', timezone: 'UTC', skipWeekends: true })
    const from = Date.UTC(2026, 5, 5, 12, 0) // Fri after 9am
    expect(wd(computeNextRun(s, from)!, 'UTC')).toBe(1) // → Monday, not Sat
  })

  it('skipHolidays skips a configured holiday date', () => {
    const s = sched({ cadenceKind: 'daily', cadenceExpr: '{"time":"09:00"}', timezone: 'UTC', skipHolidays: true })
    const ctx: CadenceContext = { isHoliday: (d) => d === '2026-06-02' } // Tue is a holiday
    const from = Date.UTC(2026, 5, 1, 12, 0) // Mon Jun 1, after 9am → next would be Jun 2
    const next = computeNextRun(s, from, ctx)!
    expect(iso(next, 'UTC')).toBe('2026-06-03') // Jun 2 skipped → Jun 3
  })

  it('holiday skip is ignored when skipHolidays is off', () => {
    const s = sched({ cadenceKind: 'daily', cadenceExpr: '{"time":"09:00"}', timezone: 'UTC', skipHolidays: false })
    const ctx: CadenceContext = { isHoliday: () => true } // everything "is" a holiday
    const from = Date.UTC(2026, 5, 1, 12, 0)
    expect(computeNextRun(s, from, ctx)).not.toBeNull() // still fires
  })
})

describe('cadence — once + interval + range helpers', () => {
  it('once fires at its instant, then never again', () => {
    const at = Date.UTC(2026, 5, 10, 14, 30)
    const s = sched({ cadenceKind: 'once', cadenceExpr: String(at) })
    expect(computeNextRun(s, at - 1000)).toBe(at)
    expect(computeNextRun(s, at)).toBeNull() // strictly after
    expect(computeNextRun(s, at + 1000)).toBeNull()
  })

  it('interval keeps Slice-3 behavior (fromMs + minutes)', () => {
    const s = sched({ cadenceKind: 'interval', cadenceExpr: '30', timezone: 'UTC' })
    const from = Date.UTC(2026, 5, 1, 12, 0)
    expect(computeNextRun(s, from)).toBe(from + 30 * 60_000)
  })

  it('occurrencesInRange enumerates a daily week (7 occurrences)', () => {
    const s = sched({ cadenceKind: 'daily', cadenceExpr: '{"time":"09:00"}', timezone: 'UTC' })
    const from = Date.UTC(2026, 5, 1, 0, 0)
    const to = Date.UTC(2026, 5, 8, 0, 0)
    const occ = occurrencesInRange(s, from, to)
    expect(occ.length).toBe(7) // Jun 1..7 at 9:00 (Jun 8 09:00 is after `to`)
    for (const t of occ) expect(hm(t, 'UTC')).toBe('09:00')
    // strictly increasing
    for (let i = 1; i < occ.length; i++) expect(occ[i]!).toBeGreaterThan(occ[i - 1]!)
  })

  it('a weekly with no days never fires', () => {
    const s = sched({ cadenceKind: 'weekly', cadenceExpr: '{"time":"09:00","days":[]}', timezone: 'UTC' })
    expect(computeNextRun(s, Date.UTC(2026, 5, 1, 0, 0))).toBeNull()
    expect(occurrencesInRange(s, 0, Date.UTC(2030, 0, 1))).toEqual([])
  })
})
