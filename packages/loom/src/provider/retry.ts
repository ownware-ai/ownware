/**
 * Retry Logic
 *
 * Exponential backoff with jitter, Retry-After header support,
 * and special handling for rate limits (429), overload (529),
 * and server errors (5xx).
 *
 * Simplified for Loom's provider layer.
 */

import type { RetryConfig } from '../core/config.js'
import { ProviderError } from '../core/errors.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Information about a retry attempt, for logging/observability. */
export interface RetryAttemptInfo {
  readonly attempt: number
  readonly maxRetries: number
  readonly delayMs: number
  readonly error: Error
  readonly statusCode: number | null
}

/** Optional callbacks for observability. */
export interface RetryCallbacks {
  /** Called before each retry wait. */
  onRetry?: (info: RetryAttemptInfo) => void
}

// ---------------------------------------------------------------------------
// withRetry — wraps a single async call
// ---------------------------------------------------------------------------

/**
 * Retry an async function with exponential backoff and jitter.
 *
 * - Respects Retry-After from ProviderError
 * - Different handling for 429 (rate limit), 529 (overload), 5xx (server)
 * - Circuit breaker: stops after maxRetries
 *
 * @param fn - The async function to retry
 * @param config - Retry configuration (from LoomConfig)
 * @param callbacks - Optional retry event callbacks
 * @param signal - Optional AbortSignal
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  config: RetryConfig,
  callbacks?: RetryCallbacks,
  signal?: AbortSignal,
): Promise<T> {
  let lastError: Error | undefined

  for (let attempt = 1; attempt <= config.maxRetries + 1; attempt++) {
    if (signal?.aborted) {
      throw new Error('Aborted')
    }

    try {
      return await fn()
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))

      // Don't retry on the last attempt
      if (attempt > config.maxRetries) {
        break
      }

      // Only retry on retryable errors
      if (!isRetryable(error, config)) {
        break
      }

      const delayMs = computeDelay(attempt, error, config)

      callbacks?.onRetry?.({
        attempt,
        maxRetries: config.maxRetries,
        delayMs,
        error: lastError,
        statusCode: error instanceof ProviderError ? error.statusCode : null,
      })

      await sleep(delayMs, signal)
    }
  }

  throw lastError!
}

// ---------------------------------------------------------------------------
// retryableStream — wraps an AsyncGenerator with retry on failure
// ---------------------------------------------------------------------------

/**
 * Wraps an AsyncGenerator factory with retry logic.
 *
 * If the generator throws a retryable error, the entire stream
 * is restarted from scratch (provider calls are not resumable).
 *
 * Yields are forwarded transparently — consumers see a single
 * uninterrupted stream even across retries.
 *
 * @param factory - Function that creates a fresh AsyncGenerator
 * @param config - Retry configuration
 * @param callbacks - Optional retry event callbacks
 * @param signal - Optional AbortSignal
 */
export async function* retryableStream<T>(
  factory: () => AsyncGenerator<T>,
  config: RetryConfig,
  callbacks?: RetryCallbacks,
  signal?: AbortSignal,
): AsyncGenerator<T> {
  let lastError: Error | undefined

  for (let attempt = 1; attempt <= config.maxRetries + 1; attempt++) {
    if (signal?.aborted) {
      throw new Error('Aborted')
    }

    try {
      const gen = factory()
      for await (const value of gen) {
        yield value
      }
      return // Stream completed successfully
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))

      if (attempt > config.maxRetries) {
        break
      }

      if (!isRetryable(error, config)) {
        break
      }

      const delayMs = computeDelay(attempt, error, config)

      callbacks?.onRetry?.({
        attempt,
        maxRetries: config.maxRetries,
        delayMs,
        error: lastError,
        statusCode: error instanceof ProviderError ? error.statusCode : null,
      })

      await sleep(delayMs, signal)
      // Loop restarts the entire stream from scratch
    }
  }

  throw lastError!
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Determine if an error is retryable based on status code and config.
 */
function isRetryable(error: unknown, config: RetryConfig): boolean {
  if (error instanceof ProviderError) {
    // Connection errors (no status code) are retryable
    if (error.statusCode === null) {
      return true
    }
    return config.retryableStatusCodes.includes(error.statusCode)
  }

  // Network/connection errors (e.g., fetch failures)
  if (error instanceof TypeError && error.message.includes('fetch')) {
    return true
  }

  return false
}

/**
 * Compute delay for a retry attempt.
 *
 * Priority:
 * 1. Retry-After from the error (ProviderError.retryAfterMs)
 * 2. Exponential backoff with jitter, capped at maxDelayMs
 */
function computeDelay(
  attempt: number,
  error: unknown,
  config: RetryConfig,
): number {
  // Respect Retry-After header from the provider
  if (error instanceof ProviderError && error.retryAfterMs !== null) {
    return Math.min(error.retryAfterMs, config.maxDelayMs)
  }

  // Exponential backoff: baseDelay * 2^(attempt-1)
  const baseDelay = Math.min(
    config.baseDelayMs * Math.pow(2, attempt - 1),
    config.maxDelayMs,
  )

  // Add jitter (0-25% of base delay) to prevent thundering herd
  const jitter = Math.random() * 0.25 * baseDelay

  return Math.floor(baseDelay + jitter)
}

/**
 * Sleep that respects an AbortSignal.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Aborted'))
      return
    }

    const timer = setTimeout(resolve, ms)

    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('Aborted'))
    }

    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
