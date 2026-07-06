/**
 * Stream Stall Guard
 *
 * Wraps an AsyncIterable to detect stalls — if no events arrive within
 * the configured timeout, throws a ProviderError. Resets the timer on
 * each chunk received.
 *
 * Used by OpenAI and Google providers to match Anthropic's stall detection.
 */

import { ProviderError } from '../core/errors.js'

export interface StallGuardOptions {
  /** Provider name for error messages */
  readonly provider: string
  /** Warn after this many ms with no events (default: 30000) */
  readonly warnMs: number
  /** Throw after this many ms with no events (default: 90000) */
  readonly timeoutMs: number
}

/**
 * Wrap an AsyncIterable with stall detection.
 * If no values are yielded for `timeoutMs`, throws ProviderError.
 *
 * Implementation uses a resolve-based approach (not reject-based) to avoid
 * unhandled promise rejections when timers fire after the generator exits.
 */
export async function* withStallGuard<T>(
  source: AsyncIterable<T>,
  options: StallGuardOptions,
): AsyncGenerator<T> {
  const { provider, warnMs, timeoutMs } = options

  let stallWarnTimer: ReturnType<typeof setTimeout> | undefined
  let stallTimeoutTimer: ReturnType<typeof setTimeout> | undefined
  let resolveStall: ((err: ProviderError) => void) | undefined

  const clearTimers = () => {
    if (stallWarnTimer) { clearTimeout(stallWarnTimer); stallWarnTimer = undefined }
    if (stallTimeoutTimer) { clearTimeout(stallTimeoutTimer); stallTimeoutTimer = undefined }
    resolveStall = undefined
  }

  // Creates a promise that RESOLVES with a ProviderError (instead of rejecting)
  // to avoid unhandled rejection issues with fake timers.
  const createStallPromise = (): Promise<ProviderError> => {
    return new Promise<ProviderError>((resolve) => { resolveStall = resolve })
  }

  let currentStallPromise = createStallPromise()

  const resetTimers = () => {
    if (stallWarnTimer) clearTimeout(stallWarnTimer)
    if (stallTimeoutTimer) clearTimeout(stallTimeoutTimer)

    currentStallPromise = createStallPromise()

    stallWarnTimer = setTimeout(() => {
      console.warn(`[loom/${provider}] Stream stall warning: no events for ${warnMs / 1000}s`)
    }, warnMs)

    stallTimeoutTimer = setTimeout(() => {
      resolveStall?.(new ProviderError(
        `Stream stalled: no events received for ${timeoutMs / 1000}s`,
        provider,
        { recoverable: true },
      ))
    }, timeoutMs)
  }

  const iterator = source[Symbol.asyncIterator]()
  resetTimers()

  try {
    while (true) {
      // Race between the next chunk and the stall timeout.
      // stallPromise resolves (not rejects) with a ProviderError to avoid unhandled rejections.
      const result = await Promise.race([
        iterator.next().then(r => ({ kind: 'chunk' as const, result: r })),
        currentStallPromise.then(err => ({ kind: 'stall' as const, error: err })),
      ])

      if (result.kind === 'stall') {
        throw result.error
      }

      if (result.result.done) break
      resetTimers()
      yield result.result.value
    }
  } finally {
    clearTimers()
  }
}
