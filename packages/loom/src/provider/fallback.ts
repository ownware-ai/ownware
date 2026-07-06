/**
 * Provider Fallback Chain
 *
 * Wraps a primary ProviderAdapter with automatic fallback to
 * alternative models when the primary fails. Handles rate limits,
 * timeouts, and provider errors gracefully.
 *
 * Design:
 *   - Wraps any ProviderAdapter — transparent to the loop
 *   - Tries primary first, falls back in order on failure
 *   - Retryable errors (429, 500, 502, 503) trigger fallback
 *   - Non-retryable errors (400, 401, 403) fail immediately
 *   - Tracks attempts for observability
 *   - Zero external deps
 *
 * Usage:
 *   const primary = resolveProvider('anthropic:claude-sonnet-4-20250514')
 *   const fallback = createFallbackProvider(primary.provider, [
 *     'anthropic:claude-haiku-4-5-20251001',
 *     'openai:gpt-4o',
 *   ])
 */

import type {
  ProviderAdapter,
  ProviderRequest,
  ProviderChunk,
  ProviderFeature,
  ToolDefinition,
} from './types.js'
import type { Message } from '../messages/types.js'
import { resolveProvider } from './registry.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FallbackAttempt {
  readonly model: string
  readonly provider: string
  readonly error: string
  readonly timestamp: number
}

export interface FallbackProviderOptions {
  /** Maximum total attempts across all models (primary + fallbacks). Default: 3. */
  readonly maxAttempts?: number
  /** HTTP status codes that should trigger fallback. Default: [429, 500, 502, 503, 529]. */
  readonly retryableStatusCodes?: readonly number[]
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_RETRYABLE_STATUS_CODES = [429, 500, 502, 503, 529]

/** Errors that should NOT trigger fallback (bad request, auth, etc.) */
const NON_RETRYABLE_PATTERNS = [
  'invalid_api_key',
  'authentication',
  'invalid_request',
  'not_found_error',
  'permission',
  '400',
  '401',
  '403',
  '404',
]

// ---------------------------------------------------------------------------
// Fallback provider
// ---------------------------------------------------------------------------

/**
 * Create a ProviderAdapter that wraps a primary provider with fallback models.
 *
 * @param primary - The primary provider adapter
 * @param fallbackModels - Model strings to try in order (e.g., ["anthropic:haiku", "openai:gpt-4o"])
 * @param options - Configuration
 * @returns A ProviderAdapter that transparently falls back on failure
 */
export function createFallbackProvider(
  primary: ProviderAdapter,
  fallbackModels: readonly string[],
  options?: FallbackProviderOptions,
): FallbackProviderAdapter {
  return new FallbackProviderAdapter(primary, fallbackModels, options)
}

export class FallbackProviderAdapter implements ProviderAdapter {
  readonly name: string
  private readonly primary: ProviderAdapter
  private readonly fallbackModels: readonly string[]
  private readonly maxAttempts: number
  private readonly retryableStatusCodes: readonly number[]

  /** Tracks all fallback attempts for observability */
  private readonly _attempts: FallbackAttempt[] = []

  constructor(
    primary: ProviderAdapter,
    fallbackModels: readonly string[],
    options?: FallbackProviderOptions,
  ) {
    this.primary = primary
    this.fallbackModels = fallbackModels
    this.maxAttempts = options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    this.retryableStatusCodes = options?.retryableStatusCodes ?? DEFAULT_RETRYABLE_STATUS_CODES
    this.name = `${primary.name}+fallback`
  }

  /** Get all fallback attempts from the current session (for observability) */
  get attempts(): readonly FallbackAttempt[] {
    return this._attempts
  }

  /**
   * Stream with automatic fallback.
   *
   * Tries the primary provider first. If it fails with a retryable error,
   * tries each fallback model in order until one succeeds or all fail.
   */
  async *stream(request: ProviderRequest): AsyncGenerator<ProviderChunk> {
    let attemptCount = 0
    let lastError: Error | null = null

    // Try primary
    try {
      attemptCount++
      yield* this.primary.stream(request)
      return
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e))
      lastError = error

      if (!this.isRetryable(error)) {
        throw error // Non-retryable — don't waste time on fallbacks
      }

      this._attempts.push({
        model: request.model,
        provider: this.primary.name,
        error: error.message,
        timestamp: Date.now(),
      })
    }

    // Try fallbacks
    for (const modelString of this.fallbackModels) {
      if (attemptCount >= this.maxAttempts) break

      try {
        attemptCount++
        const { provider, model } = resolveProvider(modelString)
        const fallbackRequest: ProviderRequest = { ...request, model }

        yield* provider.stream(fallbackRequest)
        return // Success
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e))
        lastError = error

        this._attempts.push({
          model: modelString,
          provider: modelString.split(':')[0] ?? 'unknown',
          error: error.message,
          timestamp: Date.now(),
        })

        if (!this.isRetryable(error)) {
          throw error
        }
      }
    }

    // All attempts failed
    const summary = this._attempts.slice(-this.maxAttempts)
      .map(a => `  ${a.provider}:${a.model} → ${a.error}`)
      .join('\n')

    throw new Error(
      `All provider attempts failed (${attemptCount} attempts):\n${summary}`,
      { cause: lastError },
    )
  }

  async countTokens(messages: Message[], system?: string): Promise<number> {
    return this.primary.countTokens(messages, system)
  }

  supportsFeature(feature: ProviderFeature): boolean {
    return this.primary.supportsFeature(feature)
  }

  formatTools(tools: ToolDefinition[]): unknown[] {
    return this.primary.formatTools(tools)
  }

  getModelPricing(model: string): import('./pricing.js').ModelPricing | null {
    return this.primary.getModelPricing(model)
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Determine if an error should trigger fallback.
   * Returns false for auth errors, invalid requests, etc.
   */
  private isRetryable(error: Error): boolean {
    const message = error.message.toLowerCase()

    // Check for non-retryable patterns
    for (const pattern of NON_RETRYABLE_PATTERNS) {
      if (message.includes(pattern)) return false
    }

    // Check for retryable HTTP status codes in the error message
    for (const code of this.retryableStatusCodes) {
      if (message.includes(String(code))) return true
    }

    // Common retryable patterns
    if (
      message.includes('rate_limit') ||
      message.includes('overloaded') ||
      message.includes('timeout') ||
      message.includes('econnrefused') ||
      message.includes('econnreset') ||
      message.includes('socket hang up') ||
      message.includes('fetch failed')
    ) {
      return true
    }

    // Default: retry unknown errors (conservative approach)
    return true
  }
}
