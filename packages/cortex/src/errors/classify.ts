/**
 * classifyError — the single chokepoint for turning any thrown value into
 * a `ClassifiedError`. Walks the cause graph, checks the most-specific
 * signals first, falls through to `'unknown'`.
 *
 * Two layers of classification exist in the system (frontman pattern):
 *
 *   - **Loom's `classifyHttpError`** (provider-HTTP specific) — runs inside
 *     each provider adapter to produce typed `ProviderError` subclasses.
 *   - **This function** — runs at every package seam (cortex handlers,
 *     gateway responses, anywhere an unknown `unknown` value needs a name).
 *
 * Never throws. Always returns a fully-populated `ClassifiedError`.
 *
 * See `categories.md` for the semantics of each category.
 */

import {
  LoomError,
  ProviderError,
  AuthenticationError,
  PermissionDeniedError,
  NotFoundError,
  UnprocessableEntityError,
  RateLimitError,
  ServiceUnavailableError,
  OverloadedError,
  ContextWindowExceededError,
  ContentPolicyError,
  ToolError,
  ToolTimeoutError,
  ToolPermissionError,
  CompactionError,
  CheckpointError,
  AbortError,
  ConfigError,
} from '@ownware/loom'
import {
  ConnectorAuthExpiredError,
  ConnectorRateLimitedError,
  ConnectorNetworkError,
  ConnectorValidationError,
  ConnectorVendorError,
  ConnectorNotConfiguredError,
  ConnectorError,
} from '../connector/errors.js'
import {
  type ClassifiedError,
  type ErrorCategory,
  type UserAction,
  boundMessage,
} from './categories.js'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const MAX_CAUSE_DEPTH = 5

export function classifyError(err: unknown): ClassifiedError {
  const candidates = collectCauseGraph(err)
  // Most-specific first: each candidate is classified independently; we
  // return the first non-unknown classification, with the unknown fallback
  // only kicking in when nothing in the chain matched.
  let firstUnknown: ClassifiedError | null = null
  for (const candidate of candidates) {
    const classified = classifySingle(candidate)
    if (classified.category !== 'unknown') return classified
    if (firstUnknown === null) firstUnknown = classified
  }
  return firstUnknown ?? makeUnknown(err)
}

// ---------------------------------------------------------------------------
// Cause-graph walk
// ---------------------------------------------------------------------------

/**
 * Walk `err.cause`, `err.errors[]`, `err.original`, `err.reason`, `err.error`
 * up to `MAX_CAUSE_DEPTH` levels. Cycle-guarded via a `Set`.
 *
 * Why this matters: libraries wrap errors. undici wraps DNS errors. fetch
 * wraps undici. Without a cause walk, the top-level `TypeError: fetch failed`
 * never reveals the underlying `ENOTFOUND`, and our classifier returns
 * `'unknown'` for things that should be `'network'`.
 */
function collectCauseGraph(err: unknown): unknown[] {
  const seen = new Set<unknown>()
  const out: unknown[] = []
  const queue: { value: unknown; depth: number }[] = [{ value: err, depth: 0 }]

  while (queue.length > 0) {
    const next = queue.shift()
    if (!next) break
    const { value, depth } = next
    if (value === null || value === undefined) continue
    if (seen.has(value)) continue
    seen.add(value)
    out.push(value)
    if (depth >= MAX_CAUSE_DEPTH) continue
    // Standard Error.cause
    if (value instanceof Error && value.cause !== undefined && value.cause !== value) {
      queue.push({ value: value.cause, depth: depth + 1 })
    }
    // AggregateError-style .errors[]
    if (value instanceof Error) {
      const maybeErrors = (value as unknown as { errors?: unknown }).errors
      if (Array.isArray(maybeErrors)) {
        for (const e of maybeErrors) {
          queue.push({ value: e, depth: depth + 1 })
        }
      }
    }
    // Common wrapper field names from various libraries
    if (typeof value === 'object') {
      for (const field of ['original', 'reason', 'error']) {
        const wrapped: unknown = (value as Record<string, unknown>)[field]
        if (wrapped !== undefined && wrapped !== value) {
          queue.push({ value: wrapped, depth: depth + 1 })
        }
      }
    }
  }

  return out
}

// ---------------------------------------------------------------------------
// Single-value classification — order matters; most-specific first
// ---------------------------------------------------------------------------

function classifySingle(value: unknown): ClassifiedError {
  // 1) Loom typed provider errors — exact subclass → category
  if (value instanceof AuthenticationError) {
    return classified('auth', value, false, 'open-settings-brains')
  }
  if (value instanceof PermissionDeniedError) {
    return classified('auth', value, false, 'open-settings-brains')
  }
  if (value instanceof RateLimitError) {
    return classified('rate_limit', value, true, 'wait-and-retry', value.retryAfterMs ?? undefined)
  }
  if (value instanceof OverloadedError) {
    return classified('overload', value, true, 'wait-and-retry')
  }
  if (value instanceof ServiceUnavailableError) {
    return classified('overload', value, true, 'wait-and-retry')
  }
  if (value instanceof ContextWindowExceededError) {
    return classified('context_window', value, false, 'try-shorter-or-bigger-model')
  }
  if (value instanceof ContentPolicyError) {
    return classified('content_policy', value, false, 'rephrase-or-cancel')
  }
  if (value instanceof UnprocessableEntityError) {
    return classified('invalid_request', value, false)
  }
  if (value instanceof NotFoundError) {
    // Provider "model not found" is a config issue, not a UI 404.
    return classified('config', value, false, 'open-settings')
  }
  // Generic ProviderError — fall back on status code.
  if (value instanceof ProviderError) {
    if (value.statusCode === 429) {
      return classified('rate_limit', value, true, 'wait-and-retry', value.retryAfterMs ?? undefined)
    }
    if (value.statusCode === 529 || (value.statusCode != null && value.statusCode >= 500)) {
      return classified('overload', value, true, 'wait-and-retry')
    }
    if (value.statusCode === null) {
      // Network-level — no response.
      return classified('network', value, true, 'check-connection')
    }
    return classified('unknown', value, false, 'copy-details-for-support')
  }

  // 2) Loom typed lifecycle / config / tool errors
  if (value instanceof AbortError) {
    return classified('aborted', value, false)
  }
  if (value instanceof ToolTimeoutError) {
    return classified('tool_timeout', value, true, 'retry-or-increase-timeout')
  }
  if (value instanceof ToolPermissionError) {
    return classified('tool_permission', value, false)
  }
  if (value instanceof ToolError) {
    return classified('unknown', value, value.recoverable, 'copy-details-for-support')
  }
  if (value instanceof ConfigError) {
    return classified('config', value, false, 'open-settings')
  }
  if (value instanceof CompactionError || value instanceof CheckpointError) {
    return classified('unknown', value, value.recoverable, 'copy-details-for-support')
  }
  if (value instanceof LoomError) {
    return classified('unknown', value, value.recoverable, 'copy-details-for-support')
  }

  // 3) Cortex connector errors — keyed off discriminant
  if (value instanceof ConnectorAuthExpiredError) {
    return classified('connector_auth_expired', value, false, 'reconnect-connector')
  }
  if (value instanceof ConnectorNotConfiguredError) {
    return classified('connector_not_configured', value, false, 'setup-connector')
  }
  if (value instanceof ConnectorRateLimitedError) {
    return classified(
      'connector_rate_limited',
      value,
      true,
      'wait-and-retry',
      value.retryAfterMs ?? undefined,
    )
  }
  if (value instanceof ConnectorValidationError) {
    return classified('connector_validation', value, false, 'fix-form-errors')
  }
  if (value instanceof ConnectorVendorError) {
    return classified('connector_vendor', value, true, 'wait-and-retry')
  }
  if (value instanceof ConnectorNetworkError) {
    return classified('network', value, true, 'check-connection')
  }
  if (value instanceof ConnectorError) {
    return classified('unknown', value, false, 'copy-details-for-support')
  }

  // 4) Node / undici / fetch error codes — message OR `code` property
  if (value instanceof Error) {
    const code = (value as { code?: unknown }).code
    const codeStr = typeof code === 'string' ? code : null
    const name = value.name
    const msg = value.message

    if (
      codeStr !== null &&
      (NETWORK_CODES.has(codeStr) || codeStr.startsWith('UND_ERR_'))
    ) {
      return classified('network', value, true, 'check-connection')
    }
    if (
      NETWORK_NAMES.has(name) ||
      NETWORK_MSG_PATTERNS.some(re => re.test(msg))
    ) {
      return classified('network', value, true, 'check-connection')
    }
    if (codeStr !== null && SQLITE_CODES.has(codeStr)) {
      const transient = codeStr === 'SQLITE_BUSY' || codeStr === 'SQLITE_LOCKED'
      return classified(
        'sqlite',
        value,
        transient,
        transient ? 'wait-and-retry' : 'contact-support',
      )
    }
    if (name === 'AbortError' || msg.toLowerCase().includes('aborted')) {
      return classified('aborted', value, false)
    }
  }

  // 5) Plain strings or non-Error throws
  return makeUnknown(value)
}

// ---------------------------------------------------------------------------
// Code/name/message tables
// ---------------------------------------------------------------------------

const NETWORK_CODES = new Set<string>([
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ECONNABORTED',
])

const NETWORK_NAMES = new Set<string>([
  'ConnectTimeoutError',
  'BodyTimeoutError',
  'HeadersTimeoutError',
  'SocketError',
])

const NETWORK_MSG_PATTERNS: readonly RegExp[] = [
  /failed to fetch/i,
  /network ?error/i,
  /getaddrinfo/i,
  /socket hang up/i,
  /network is unreachable/i,
  /fetch failed/i,
]

const SQLITE_CODES = new Set<string>([
  'SQLITE_BUSY',
  'SQLITE_LOCKED',
  'SQLITE_IOERR',
  'SQLITE_CANTOPEN',
  'SQLITE_CORRUPT',
  'SQLITE_FULL',
  'SQLITE_READONLY',
  'SQLITE_NOTADB',
])

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function classified(
  category: ErrorCategory,
  err: unknown,
  retryable: boolean,
  userAction?: UserAction,
  retryAfterMs?: number,
): ClassifiedError {
  const message = err instanceof Error ? err.message : String(err)
  const errorName = err instanceof Error ? err.name : undefined
  const base: ClassifiedError = {
    category,
    message: boundMessage(message.length > 0 ? message : category),
    retryable,
    ...(userAction !== undefined ? { userAction } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(errorName !== undefined ? { errorName } : {}),
  }
  return base
}

function makeUnknown(err: unknown): ClassifiedError {
  const message = err instanceof Error ? err.message : String(err)
  const errorName = err instanceof Error ? err.name : undefined
  return {
    category: 'unknown',
    message: boundMessage(message.length > 0 ? message : 'Unknown error'),
    retryable: false,
    userAction: 'copy-details-for-support',
    ...(errorName !== undefined ? { errorName } : {}),
  }
}

// ---------------------------------------------------------------------------
// Re-exports for callers — one import path for the whole pipeline
// ---------------------------------------------------------------------------

export type { ClassifiedError, ErrorCategory, UserAction } from './categories.js'
export { ERROR_CATEGORIES, USER_ACTIONS } from './categories.js'
