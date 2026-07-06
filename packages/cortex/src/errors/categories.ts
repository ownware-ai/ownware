/**
 * Error Category — the closed wire enum.
 *
 * Source of truth for human-readable docs: `categories.md` (same folder).
 * When you change this file, change that one in the same commit.
 *
 * Order here is the canonical wire order — do NOT reorder casually; this
 * file is grep'd by client mirrors when verifying the enum is in sync.
 */

export const ERROR_CATEGORIES = [
  // Authentication & authorization
  'auth',
  'connector_auth_expired',
  'connector_not_configured',
  // Throttling & overload
  'rate_limit',
  'overload',
  'connector_rate_limited',
  // Request shape & content
  'context_window',
  'content_policy',
  'invalid_request',
  'connector_validation',
  // Transport-level
  'network',
  'sqlite',
  'connector_vendor',
  // Tool execution
  'tool_timeout',
  'tool_permission',
  // Lifecycle
  'aborted',
  'not_found',
  'config',
  // Fallback
  'unknown',
] as const

export type ErrorCategory = (typeof ERROR_CATEGORIES)[number]

/**
 * User-action hints. The renderer reads this string and routes to the
 * right surface (settings panel, reconnect card, retry button, etc.).
 * Optional on the wire — categories like `aborted` and `tool_permission`
 * deliberately have no action.
 */
export const USER_ACTIONS = [
  'open-settings-brains',
  'reconnect-connector',
  'setup-connector',
  'wait-and-retry',
  'try-shorter-or-bigger-model',
  'rephrase-or-cancel',
  'fix-form-errors',
  'check-connection',
  'restart-app',
  'contact-support',
  'retry-or-increase-timeout',
  'go-back-or-refresh',
  'open-settings',
  'copy-details-for-support',
] as const

export type UserAction = (typeof USER_ACTIONS)[number]

/**
 * The classified result every consumer receives. Bounded fields keep one
 * pathological error from drowning the channel:
 *   - message: ≤ 2000 chars
 *   - userAction: closed enum
 *   - cause: walked up to 5 hops deep
 */
export interface ClassifiedError {
  readonly category: ErrorCategory
  readonly message: string
  readonly retryable: boolean
  readonly userAction?: UserAction
  /** Optional retry-after hint (ms), populated for rate_limit categories. */
  readonly retryAfterMs?: number
  /** Original error name (Error.name) — useful for telemetry without leaking message contents. */
  readonly errorName?: string
  /** Next link in the cause chain, if walked. Same shape, recursive. */
  readonly cause?: ClassifiedError
}

/** Truncate to 2000 chars — bounded payload. */
export const MAX_MESSAGE_LEN = 2000

export function boundMessage(s: string): string {
  return s.length > MAX_MESSAGE_LEN ? s.slice(0, MAX_MESSAGE_LEN) : s
}
