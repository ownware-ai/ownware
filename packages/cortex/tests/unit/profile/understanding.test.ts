/**
 * Unit tests for the understanding digest — the canonical `UnderstandingSlice`
 * contract + the additive, race-free `mergeSlices` accumulation.
 */

import { describe, it, expect } from 'vitest'
import { mergeSlices } from '../../../src/profile/understanding.js'

describe('mergeSlices — additive accumulation (data not re-typed)', () => {
  it('appends usage from separate scans without losing any', () => {
    const browser = { usage: [{ app: 'GitHub', count: 4626 }] }
    const apps = { usage: [{ app: 'Linear', count: 880 }] }
    const merged = mergeSlices(mergeSlices({}, browser), apps)
    expect(merged.usage).toEqual([
      { app: 'GitHub', count: 4626 },
      { app: 'Linear', count: 880 },
    ])
  })

  it('last writer wins per app (a re-run updates the count, not duplicates it)', () => {
    const first = { usage: [{ app: 'GitHub', count: 10 }] }
    const second = { usage: [{ app: 'github', count: 4626 }] } // case-insensitive same app
    const merged = mergeSlices(mergeSlices({}, first), second)
    expect(merged.usage).toEqual([{ app: 'github', count: 4626 }])
  })

  it('scalars are last-writer-wins; judgment slice fills summary/voice without touching data', () => {
    const data = { usage: [{ app: 'GitHub', count: 4626 }], suggestedConnectors: ['github'] }
    const judgment = { summary: 'Solo founder.', voice: 'Plain and direct.', traits: ['Ships small chunks'] }
    const merged = mergeSlices(mergeSlices({}, data), judgment)
    expect(merged.summary).toBe('Solo founder.')
    expect(merged.voice).toBe('Plain and direct.')
    expect(merged.usage).toEqual([{ app: 'GitHub', count: 4626 }]) // untouched by judgment
    expect(merged.traits).toEqual(['Ships small chunks'])
  })

  it('dedupes traits and connectors across slices', () => {
    const a = { traits: ['Direct'], suggestedConnectors: ['github'] }
    const b = { traits: ['Direct', 'Researches first'], suggestedConnectors: ['github', 'gmail'] }
    const merged = mergeSlices(mergeSlices({}, a), b)
    expect(merged.traits).toEqual(['Direct', 'Researches first'])
    expect(merged.suggestedConnectors).toEqual(['github', 'gmail'])
  })

  it('an empty accumulator merged with an empty slice stays minimal (no empty arrays)', () => {
    const merged = mergeSlices({}, {})
    expect(merged.usage).toBeUndefined()
    expect(merged.traits).toBeUndefined()
    expect(merged.sources).toBeUndefined()
  })

  it('dedupes sources by label+detail', () => {
    const a = { sources: [{ label: 'browser', detail: '4,626 pages' }] }
    const b = { sources: [{ label: 'browser', detail: '4,626 pages' }, { label: 'github', detail: '2 repos' }] }
    const merged = mergeSlices(mergeSlices({}, a), b)
    expect(merged.sources).toEqual([
      { label: 'browser', detail: '4,626 pages' },
      { label: 'github', detail: '2 repos' },
    ])
  })
})
