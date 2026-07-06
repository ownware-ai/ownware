import { describe, it, expect, vi } from 'vitest'
import { withRetry, retryableStream } from '../../../src/provider/retry.js'
import type { RetryConfig } from '../../../src/core/config.js'
import { ProviderError } from '../../../src/core/errors.js'

const fastRetryConfig: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 10,
  maxDelayMs: 100,
  retryableStatusCodes: [429, 500, 502, 503, 529],
}

describe('withRetry', () => {
  it('returns immediately on success', async () => {
    const result = await withRetry(() => Promise.resolve('ok'), fastRetryConfig)
    expect(result).toBe('ok')
  })

  it('retries on retryable error and succeeds', async () => {
    let calls = 0
    const fn = async () => {
      calls++
      if (calls < 3) {
        throw new ProviderError('rate limited', 'test', { statusCode: 429 })
      }
      return 'success'
    }

    const result = await withRetry(fn, fastRetryConfig)
    expect(result).toBe('success')
    expect(calls).toBe(3)
  })

  it('stops after maxRetries', async () => {
    let calls = 0
    const fn = async () => {
      calls++
      throw new ProviderError('overloaded', 'test', { statusCode: 529 })
    }

    await expect(withRetry(fn, fastRetryConfig)).rejects.toThrow('overloaded')
    // 1 initial + 3 retries = 4 calls
    expect(calls).toBe(4)
  })

  it('does not retry non-retryable errors', async () => {
    let calls = 0
    const fn = async () => {
      calls++
      throw new ProviderError('bad request', 'test', { statusCode: 400 })
    }

    await expect(withRetry(fn, fastRetryConfig)).rejects.toThrow('bad request')
    expect(calls).toBe(1)
  })

  it('does not retry non-ProviderError by default', async () => {
    let calls = 0
    const fn = async () => {
      calls++
      throw new Error('random error')
    }

    await expect(withRetry(fn, fastRetryConfig)).rejects.toThrow('random error')
    expect(calls).toBe(1)
  })

  it('respects Retry-After from ProviderError', async () => {
    let calls = 0
    const start = Date.now()
    const fn = async () => {
      calls++
      if (calls === 1) {
        throw new ProviderError('rate limited', 'test', {
          statusCode: 429,
          retryAfterMs: 50,
        })
      }
      return 'ok'
    }

    const result = await withRetry(fn, fastRetryConfig)
    expect(result).toBe('ok')
    // Should have waited at least ~50ms
    expect(Date.now() - start).toBeGreaterThanOrEqual(40)
  })

  it('caps Retry-After at maxDelayMs', async () => {
    let calls = 0
    const start = Date.now()
    const fn = async () => {
      calls++
      if (calls === 1) {
        throw new ProviderError('rate limited', 'test', {
          statusCode: 429,
          retryAfterMs: 999_999,
        })
      }
      return 'ok'
    }

    const result = await withRetry(fn, fastRetryConfig)
    expect(result).toBe('ok')
    // Should have been capped at maxDelayMs (100ms), not 999s
    expect(Date.now() - start).toBeLessThan(500)
  })

  it('calls onRetry callback', async () => {
    let calls = 0
    const retryInfos: unknown[] = []
    const fn = async () => {
      calls++
      if (calls < 2) {
        throw new ProviderError('server error', 'test', { statusCode: 500 })
      }
      return 'ok'
    }

    await withRetry(fn, fastRetryConfig, {
      onRetry: (info) => retryInfos.push(info),
    })

    expect(retryInfos).toHaveLength(1)
    expect(retryInfos[0]).toMatchObject({
      attempt: 1,
      maxRetries: 3,
      statusCode: 500,
    })
  })

  it('aborts immediately when signal is aborted', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      withRetry(() => Promise.resolve('ok'), fastRetryConfig, undefined, controller.signal),
    ).rejects.toThrow('Aborted')
  })

  it('retries connection errors (null statusCode)', async () => {
    let calls = 0
    const fn = async () => {
      calls++
      if (calls < 2) {
        throw new ProviderError('connection reset', 'test', {})
      }
      return 'ok'
    }

    const result = await withRetry(fn, fastRetryConfig)
    expect(result).toBe('ok')
    expect(calls).toBe(2)
  })
})

describe('retryableStream', () => {
  it('passes through a successful stream', async () => {
    async function* gen() {
      yield 1
      yield 2
      yield 3
    }

    const values: number[] = []
    for await (const v of retryableStream(gen, fastRetryConfig)) {
      values.push(v)
    }
    expect(values).toEqual([1, 2, 3])
  })

  it('restarts stream on retryable error', async () => {
    let attempt = 0
    function factory() {
      attempt++
      return (async function* () {
        yield attempt * 10
        if (attempt < 2) {
          throw new ProviderError('overloaded', 'test', { statusCode: 529 })
        }
        yield attempt * 10 + 1
      })()
    }

    const values: number[] = []
    for await (const v of retryableStream(factory, fastRetryConfig)) {
      values.push(v)
    }
    // First attempt: yields 10, then fails
    // Second attempt: yields 20, 21
    expect(values).toEqual([10, 20, 21])
  })

  it('stops after maxRetries on stream failure', async () => {
    let attempts = 0
    function factory() {
      return (async function* () {
        attempts++
        yield 'start'
        throw new ProviderError('always fails', 'test', { statusCode: 500 })
      })()
    }

    const values: string[] = []
    await expect(async () => {
      for await (const v of retryableStream(factory, fastRetryConfig)) {
        values.push(v)
      }
    }).rejects.toThrow('always fails')
    expect(attempts).toBe(4) // 1 initial + 3 retries
  })
})
