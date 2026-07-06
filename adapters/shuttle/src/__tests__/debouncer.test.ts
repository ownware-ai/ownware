import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Debouncer } from '../debouncer.js'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('Debouncer', () => {
  it('coalesces rapid pushes into ONE flush', () => {
    const flushed: Array<{ key: string; items: string[] }> = []
    const d = new Debouncer<string>({ debounceMs: 100 }, (key, items) => {
      flushed.push({ key, items })
    })

    d.push('a', 'hi')
    d.push('a', 'quick q')
    vi.advanceTimersByTime(50)
    d.push('a', '...') // resets the timer
    expect(flushed).toHaveLength(0) // still buffering
    expect(d.pendingCount('a')).toBe(3)

    vi.advanceTimersByTime(100)
    expect(flushed).toEqual([{ key: 'a', items: ['hi', 'quick q', '...'] }])
    expect(d.pendingCount('a')).toBe(0)
  })

  it('flushes separate keys independently', () => {
    const flushed: Array<{ key: string; items: string[] }> = []
    const d = new Debouncer<string>({ debounceMs: 100 }, (key, items) => {
      flushed.push({ key, items })
    })
    d.push('a', 'a1')
    d.push('b', 'b1')
    vi.advanceTimersByTime(100)
    expect(flushed).toEqual([
      { key: 'a', items: ['a1'] },
      { key: 'b', items: ['b1'] },
    ])
  })

  it('maxWaitMs caps total buffering for a chatty user', () => {
    const flushed: string[][] = []
    const d = new Debouncer<string>({ debounceMs: 100, maxWaitMs: 250 }, (_key, items) => {
      flushed.push(items)
    })
    d.push('a', '1') // firstAt = 0
    vi.advanceTimersByTime(80)
    d.push('a', '2')
    vi.advanceTimersByTime(80)
    d.push('a', '3')
    vi.advanceTimersByTime(80) // now 240 — under cap, still buffering
    expect(flushed).toHaveLength(0)
    d.push('a', '4') // now 240 >= 250? not yet; advance a touch
    vi.advanceTimersByTime(20) // 260
    d.push('a', '5') // now 260 >= 250 → immediate flush including '5'
    expect(flushed).toEqual([['1', '2', '3', '4', '5']])
  })

  it('bump() extends the window (typing)', () => {
    const flushed: string[][] = []
    const d = new Debouncer<string>({ debounceMs: 100 }, (_k, items) => {
      flushed.push(items)
    })
    d.push('a', 'x')
    vi.advanceTimersByTime(90)
    d.bump('a') // user is typing → wait again
    vi.advanceTimersByTime(90)
    expect(flushed).toHaveLength(0)
    vi.advanceTimersByTime(20)
    expect(flushed).toEqual([['x']])
  })
})
