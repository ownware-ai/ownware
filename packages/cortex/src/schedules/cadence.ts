/**
 * Cadence math for the scheduling engine — timezone-correct (IANA + DST),
 * weekend- and holiday-aware. Hand-rolled for the preset cadence set
 * (once / interval / daily / weekdays / weekly) so we take no date dependency
 * (Ownware bans utility deps). Arbitrary `cron` is intentionally out of v1.
 *
 * Canonical `cadence_expr` encodings:
 *   once      → epoch-ms (number) OR an ISO timestamp string of the single run
 *   interval  → minutes (number string)                    [Slice-3 compatible]
 *   daily     → JSON {"time":"HH:MM"}                       (every day)
 *   weekdays  → JSON {"time":"HH:MM"}                       (Mon–Fri)
 *   weekly    → JSON {"time":"HH:MM","days":[0..6]}         (0=Sun … 6=Sat)
 *
 * Every recurring kind fires at a WALL-CLOCK time in `schedule.timezone`, so a
 * "9:00 AM daily" stays 9:00 across a DST shift (it does not drift by an hour).
 *
 * The whole occurrence space derives from one primitive, `computeNextRun`
 * (the next instant strictly after `fromMs`); the range/next-N helpers just
 * iterate it. That keeps the math in one place.
 */

import type { ScheduleDto } from './types.js'

const MINUTE_MS = 60_000
const MAX_GRACE_MS = 2 * 60 * MINUTE_MS // 2h
const MIN_GRACE_MS = 30_000 // 30s
const DAY_PROBE_LIMIT = 400 // safety cap when scanning forward for a matching day

/** Optional context — e.g. a holiday predicate (applied only when skipHolidays). */
export interface CadenceContext {
  /** True if a local date "YYYY-MM-DD" (in the schedule's tz) is a holiday. */
  readonly isHoliday?: (isoDate: string) => boolean
}

// ---------------------------------------------------------------------------
// Timezone primitives (no dependency — Intl only)
// ---------------------------------------------------------------------------

const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

interface ZonedParts {
  readonly y: number
  readonly mo: number // 1-based
  readonly d: number
  readonly h: number
  readonly mi: number
  readonly s: number
  readonly weekday: number // 0=Sun
  readonly isoDate: string // YYYY-MM-DD
}

function partsInTz(epochMs: number, tz: string): ZonedParts {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const m: Record<string, string> = {}
  for (const p of dtf.formatToParts(new Date(epochMs))) m[p.type] = p.value
  return {
    y: +m['year']!,
    mo: +m['month']!,
    d: +m['day']!,
    h: +m['hour']!,
    mi: +m['minute']!,
    s: +m['second']!,
    weekday: WEEKDAY[m['weekday']!] ?? 0,
    isoDate: `${m['year']}-${m['month']}-${m['day']}`,
  }
}

/** ms the tz's wall clock is ahead of UTC at this instant (handles DST). */
function tzOffsetMs(epochMs: number, tz: string): number {
  const p = partsInTz(epochMs, tz)
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s)
  // Align the instant to whole seconds so the diff is a clean offset.
  return asUtc - Math.floor(epochMs / 1000) * 1000
}

/**
 * Epoch ms for a wall-clock time in `tz`. `mo1` is 1-based; the day may
 * overflow (Date.UTC normalizes, so d=32 → next month). Two-pass so a DST
 * transition between the guess and the result is corrected.
 */
function zonedWallToEpoch(y: number, mo1: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, mo1 - 1, d, h, mi, 0)
  const off1 = tzOffsetMs(guess, tz)
  let epoch = guess - off1
  const off2 = tzOffsetMs(epoch, tz)
  if (off2 !== off1) epoch = guess - off2
  return epoch
}

// ---------------------------------------------------------------------------
// Cadence spec
// ---------------------------------------------------------------------------

interface DaySpec {
  readonly h: number
  readonly m: number
  readonly days: ReadonlySet<number> // weekdays this fires on (0=Sun)
}

function parseDaySpec(s: ScheduleDto): DaySpec | null {
  let time = '09:00'
  let days: number[] | null = null
  try {
    const o = JSON.parse(s.cadenceExpr) as { time?: unknown; days?: unknown }
    if (typeof o.time === 'string') time = o.time
    if (Array.isArray(o.days)) days = o.days.filter((x): x is number => typeof x === 'number')
  } catch {
    // Not JSON — keep the 09:00 default (lenient: a malformed schedule still
    // computes something sane rather than crashing a calendar query).
  }
  const segs = time.split(':')
  const hh = Number(segs[0])
  const mm = Number(segs[1])
  if (!Number.isFinite(hh) || !Number.isFinite(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) {
    return null
  }
  let daySet: ReadonlySet<number>
  if (s.cadenceKind === 'weekdays') daySet = new Set([1, 2, 3, 4, 5])
  else if (s.cadenceKind === 'daily') daySet = new Set([0, 1, 2, 3, 4, 5, 6])
  else daySet = new Set(days ?? []) // weekly — empty means "no day picked" → never fires
  return { h: hh, m: mm, days: daySet }
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/**
 * The next fire instant strictly AFTER `fromMs`, or null if there is none
 * (a fired one-off, an unsupported cadence, or a weekly with no days).
 */
export function computeNextRun(s: ScheduleDto, fromMs: number, ctx: CadenceContext = {}): number | null {
  const skipWeekends = s.skipWeekends
  const isHoliday = s.skipHolidays && ctx.isHoliday ? ctx.isHoliday : (): boolean => false

  switch (s.cadenceKind) {
    case 'once': {
      const at = parseOnce(s.cadenceExpr)
      return at != null && at > fromMs ? at : null
    }
    case 'interval': {
      const minutes = Number(s.cadenceExpr)
      if (!Number.isFinite(minutes) || minutes <= 0) return null
      let next = fromMs + minutes * MINUTE_MS
      // Honor weekend/holiday skips by jumping whole days (bounded).
      if (skipWeekends || s.skipHolidays) {
        for (let i = 0; i < 14 && daySkipped(next, s.timezone, skipWeekends, isHoliday); i++) {
          next += 24 * 60 * MINUTE_MS
        }
      }
      return next
    }
    case 'daily':
    case 'weekdays':
    case 'weekly': {
      const spec = parseDaySpec(s)
      if (spec == null || spec.days.size === 0) return null
      return nextDayOccurrence(spec, fromMs, s.timezone, skipWeekends, isHoliday)
    }
    default:
      // 'cron' — deferred. The preset UI never produces it.
      return null
  }
}

function parseOnce(expr: string): number | null {
  const asNum = Number(expr)
  if (Number.isFinite(asNum) && asNum > 0) return asNum
  const asDate = Date.parse(expr)
  return Number.isFinite(asDate) ? asDate : null
}

function daySkipped(
  epochMs: number,
  tz: string,
  skipWeekends: boolean,
  isHoliday: (iso: string) => boolean,
): boolean {
  const p = partsInTz(epochMs, tz)
  if (skipWeekends && (p.weekday === 0 || p.weekday === 6)) return true
  if (isHoliday(p.isoDate)) return true
  return false
}

function nextDayOccurrence(
  spec: DaySpec,
  fromMs: number,
  tz: string,
  skipWeekends: boolean,
  isHoliday: (iso: string) => boolean,
): number | null {
  const start = partsInTz(fromMs, tz)
  for (let i = 0; i < DAY_PROBE_LIMIT; i++) {
    // The candidate date = start-date + i days (noon anchor dodges DST edges).
    const ap = partsInTz(zonedWallToEpoch(start.y, start.mo, start.d + i, 12, 0, tz), tz)
    const wd = ap.weekday
    if (!spec.days.has(wd)) continue
    if (skipWeekends && (wd === 0 || wd === 6)) continue
    if (isHoliday(ap.isoDate)) continue
    const epoch = zonedWallToEpoch(ap.y, ap.mo, ap.d, spec.h, spec.m, tz)
    if (epoch > fromMs) return epoch
  }
  return null
}

/** All occurrences in (fromMs, toMs], oldest-first, capped. */
export function occurrencesInRange(
  s: ScheduleDto,
  fromMs: number,
  toMs: number,
  ctx: CadenceContext = {},
  cap = 500,
): number[] {
  const out: number[] = []
  let t = fromMs
  while (out.length < cap) {
    const next = computeNextRun(s, t, ctx)
    if (next == null || next > toMs) break
    out.push(next)
    t = next
  }
  return out
}

/** The next `n` occurrences strictly after `fromMs` (for the live preview). */
export function nextOccurrences(s: ScheduleDto, n: number, fromMs: number, ctx: CadenceContext = {}): number[] {
  const out: number[] = []
  let t = fromMs
  for (let i = 0; i < n; i++) {
    const next = computeNextRun(s, t, ctx)
    if (next == null) break
    out.push(next)
    t = next
  }
  return out
}

/** Catch-up tolerance: half the period, clamped to [30s, 2h]. */
export function graceMs(s: ScheduleDto): number {
  let periodMs = 24 * 60 * MINUTE_MS // daily/weekly default period = a day
  if (s.cadenceKind === 'interval') {
    const minutes = Number(s.cadenceExpr)
    if (Number.isFinite(minutes) && minutes > 0) periodMs = minutes * MINUTE_MS
  } else if (s.cadenceKind === 'weekly') {
    periodMs = 7 * 24 * 60 * MINUTE_MS
  }
  return Math.min(MAX_GRACE_MS, Math.max(MIN_GRACE_MS, Math.floor(periodMs / 2)))
}
