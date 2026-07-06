/**
 * Unit Tests — Stall Guard
 *
 * Tests the withStallGuard utility that wraps async iterables
 * with stall detection (timeout on no events).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { withStallGuard } from '../../../src/provider/stall-guard.js'
import { ProviderError } from '../../../src/core/errors.js'

describe('withStallGuard', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('passes through all values from a healthy stream', async () => {
    async function* source() {
      yield 1
      yield 2
      yield 3
    }

    const values: number[] = []
    for await (const v of withStallGuard(source(), { provider: 'test', warnMs: 100, timeoutMs: 200 })) {
      values.push(v)
    }
    expect(values).toEqual([1, 2, 3])
  })

  it('throws ProviderError when stream stalls beyond timeout', async () => {
    const stalled = {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<number>>(() => {}),
        return: () => Promise.resolve({ done: true as const, value: undefined }),
      }),
    }

    const gen = withStallGuard(stalled, { provider: 'test', warnMs: 50, timeoutMs: 100 })

    // Capture the promise and attach error handler before advancing timers
    // to prevent unhandled rejection during timer advancement
    const nextPromise = gen.next()
    const caughtError = nextPromise.catch((e: unknown) => e)

    await vi.advanceTimersByTimeAsync(150)

    const err = await caughtError
    expect(err).toBeInstanceOf(ProviderError)
    expect((err as ProviderError).message).toMatch(/stall/)
  })

  it('resets timer on each received value', async () => {
    const items = [1, 2, 3]
    let idx = 0

    const slow = {
      [Symbol.asyncIterator]: () => ({
        next() {
          if (idx < items.length) {
            const val = items[idx++]
            return Promise.resolve({ done: false as const, value: val })
          }
          return Promise.resolve({ done: true as const, value: undefined })
        },
        return() {
          return Promise.resolve({ done: true as const, value: undefined })
        },
      }),
    }

    const values: number[] = []
    for await (const v of withStallGuard(slow, { provider: 'test', warnMs: 500, timeoutMs: 1000 })) {
      values.push(v)
    }
    expect(values).toEqual([1, 2, 3])
  })

  it('error includes provider name and is recoverable', async () => {
    const stalled = {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<number>>(() => {}),
        return: () => Promise.resolve({ done: true as const, value: undefined }),
      }),
    }

    const gen = withStallGuard(stalled, { provider: 'my-provider', warnMs: 50, timeoutMs: 100 })

    // Attach error handler before advancing timers
    const nextPromise = gen.next()
    const caughtError = nextPromise.catch((e: unknown) => e)

    await vi.advanceTimersByTimeAsync(150)

    const err = await caughtError
    expect(err).toBeInstanceOf(ProviderError)
    expect((err as ProviderError).provider).toBe('my-provider')
    expect((err as ProviderError).recoverable).toBe(true)
  })

  it('cleans up timers when stream completes normally', async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')

    async function* source() {
      yield 'done'
    }

    for await (const _ of withStallGuard(source(), { provider: 'test', warnMs: 100, timeoutMs: 200 })) {
      // consume
    }

    expect(clearTimeoutSpy).toHaveBeenCalled()
    clearTimeoutSpy.mockRestore()
  })
})
