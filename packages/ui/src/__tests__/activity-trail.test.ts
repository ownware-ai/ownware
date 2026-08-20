import { describe, expect, it } from 'vitest'
import {
  loadingProjection,
  readyProjection,
  selectActivityTrail,
  type ProjectedActivityEntry,
  type ProjectionCapability,
} from '../index.js'

const CAPS: readonly ProjectionCapability[] = [{ id: 'activity.read', version: 1 }]

const entry = (
  ledgerSeq: number,
  overrides: Partial<ProjectedActivityEntry> = {},
): ProjectedActivityEntry => ({
  ledgerSeq,
  family: 'effect',
  receiptId: `receipt-${ledgerSeq}`,
  runId: 'run-1',
  threadId: 'thread-1',
  profileId: 'assistant',
  workspaceId: null,
  occurredAt: 1000 + ledgerSeq,
  origin: 'live',
  outcome: 'succeeded',
  consequence: 'effect_possible',
  toolName: 'send_email',
  ...overrides,
})

const page = (items: readonly ProjectedActivityEntry[], reconstructedThrough = 0) => ({
  items,
  coverage: {
    reconstructedThrough,
    reconstructedCount: reconstructedThrough,
    observedFrom: items.some((item) => item.origin === 'live')
      ? Math.min(...items.filter((i) => i.origin === 'live').map((i) => i.ledgerSeq))
      : null,
  },
})

describe('selectActivityTrail', () => {
  it('is unavailable without the capability', () => {
    const projection = selectActivityTrail({
      capabilities: readyProjection([]),
      page: readyProjection(page([entry(1)])),
    })
    expect(projection.state).toBe('unavailable')
  })

  it('projects a newest-first trail with per-row order provenance', () => {
    const projection = selectActivityTrail({
      capabilities: readyProjection(CAPS),
      page: readyProjection(page([
        entry(3),
        entry(2, { origin: 'backfill' }),
        entry(1, { origin: 'backfill' }),
      ], 2)),
    })
    expect(projection.state).toBe('ready')
    if (projection.state !== 'ready') return
    expect(projection.rows.map((row) => row.observedOrder)).toEqual([true, false, false])
    expect(projection.coverageStatement).toContain('reconstructed')
  })

  it('keeps an unknown additive family visible but never known', () => {
    // Open world: a family added by a future gateway stays in the trail as
    // raw evidence — dropped rows would misrepresent the record — but earns
    // no family-specific presentation.
    const projection = selectActivityTrail({
      capabilities: readyProjection(CAPS),
      page: readyProjection(page([entry(2, { family: 'artifact_provenance' }), entry(1)])),
    })
    expect(projection.state).toBe('ready')
    if (projection.state !== 'ready') return
    expect(projection.rows[0]).toMatchObject({ knownFamily: false })
    expect(projection.rows[1]).toMatchObject({ knownFamily: true })
  })

  it('describes an empty trail as absence of receipts, never absence of activity', () => {
    const projection = selectActivityTrail({
      capabilities: readyProjection(CAPS),
      page: readyProjection(page([])),
    })
    expect(projection.state).toBe('ready')
    if (projection.state !== 'ready') return
    expect(projection.coverageStatement).toContain('not proof')
  })

  it('rejects a disordered page rather than silently re-sorting it', () => {
    const projection = selectActivityTrail({
      capabilities: readyProjection(CAPS),
      page: readyProjection(page([entry(1), entry(2)])),
    })
    expect(projection).toMatchObject({ state: 'unsupported', reason: 'malformed_activity_evidence' })
  })

  it('rejects malformed rows and coverage', () => {
    const bad = selectActivityTrail({
      capabilities: readyProjection(CAPS),
      page: readyProjection({
        items: [{ ...entry(1), ledgerSeq: 0 }],
        coverage: { reconstructedThrough: 0, reconstructedCount: 0, observedFrom: null },
      }),
    })
    expect(bad).toMatchObject({ state: 'unsupported' })
    const badCoverage = selectActivityTrail({
      capabilities: readyProjection(CAPS),
      page: readyProjection({
        items: [],
        coverage: { reconstructedThrough: -1, reconstructedCount: 0, observedFrom: null },
      }),
    })
    expect(badCoverage).toMatchObject({ state: 'unsupported' })
  })

  it('propagates a loading page as blocked, not as an empty trail', () => {
    const projection = selectActivityTrail({
      capabilities: readyProjection(CAPS),
      page: loadingProjection(),
    })
    expect(projection.state).not.toBe('ready')
  })
})
