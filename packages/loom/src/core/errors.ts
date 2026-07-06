/**
 * Loom Error Hierarchy
 *
 * All errors extend LoomError so consumers can catch the base class.
 * Each error carries structured data for observability and recovery decisions.
 */

export class LoomError extends Error {
  readonly code: string
  readonly recoverable: boolean

  constructor(message: string, code: string, recoverable = false) {
    super(message)
    this.name = 'LoomError'
    this.code = code
    this.recoverable = recoverable
  }
}

// ---------------------------------------------------------------------------
// Provider errors (API failures)
// ---------------------------------------------------------------------------

export class ProviderError extends LoomError {
  readonly provider: string
  readonly statusCode: number | null
  readonly retryAfterMs: number | null
  readonly headers: Record<string, string>

  constructor(
    message: string,
    provider: string,
    opts: {
      statusCode?: number
      retryAfterMs?: number
      headers?: Record<string, string>
      recoverable?: boolean
    } = {},
  ) {
    super(message, 'PROVIDER_ERROR', opts.recoverable ?? false)
    this.name = 'ProviderError'
    this.provider = provider
    this.statusCode = opts.statusCode ?? null
    this.retryAfterMs = opts.retryAfterMs ?? null
    this.headers = opts.headers ?? {}
  }

  get isRateLimit(): boolean {
    return this.statusCode === 429
  }

  get isOverloaded(): boolean {
    return this.statusCode === 529
  }

  get isServerError(): boolean {
    return this.statusCode !== null && this.statusCode >= 500 && this.statusCode < 600
  }

  get isPromptTooLong(): boolean {
    return this.message.includes('prompt is too long') ||
           this.message.includes('maximum context length')
  }

  get isMaxOutputTokens(): boolean {
    return this.message.includes('max_tokens') ||
           this.message.includes('maximum output')
  }
}

// ---------------------------------------------------------------------------
// First-class provider-error subclasses
//
// Every HTTP error from an LLM provider should be surfaced as one of these
// rather than a raw ProviderError. That way callers can branch on
// `instanceof AuthenticationError` (prompt the user to fix their key)
// vs. `instanceof ServiceUnavailableError` (show a transient banner + retry)
// vs. `instanceof ContextWindowExceededError` (trigger compaction or model
// fallback). Each class fixes `recoverable` at construction based on
// whether the underlying condition can clear on a retry.
//
// Build these via `classifyHttpError(status, body, provider)` in each
// adapter — never instantiate subclasses directly unless you already know
// the exact condition (e.g., Anthropic's body-based overloaded_error).
// ---------------------------------------------------------------------------

/** 401 — bad or missing API key. User has to fix it; retry won't help. */
export class AuthenticationError extends ProviderError {
  constructor(message: string, provider: string, opts: ProviderErrorOpts = {}) {
    super(message, provider, { ...opts, recoverable: false, statusCode: opts.statusCode ?? 401 })
    this.name = 'AuthenticationError'
  }
}

/** 403 — key is valid but lacks access to this model/feature. Not retryable. */
export class PermissionDeniedError extends ProviderError {
  constructor(message: string, provider: string, opts: ProviderErrorOpts = {}) {
    super(message, provider, { ...opts, recoverable: false, statusCode: opts.statusCode ?? 403 })
    this.name = 'PermissionDeniedError'
  }
}

/** 404 — model name wrong, or endpoint doesn't exist. Not retryable. */
export class NotFoundError extends ProviderError {
  constructor(message: string, provider: string, opts: ProviderErrorOpts = {}) {
    super(message, provider, { ...opts, recoverable: false, statusCode: opts.statusCode ?? 404 })
    this.name = 'NotFoundError'
  }
}

/** 422 — request shape the server can parse but won't accept. Not retryable. */
export class UnprocessableEntityError extends ProviderError {
  constructor(message: string, provider: string, opts: ProviderErrorOpts = {}) {
    super(message, provider, { ...opts, recoverable: false, statusCode: opts.statusCode ?? 422 })
    this.name = 'UnprocessableEntityError'
  }
}

/** 429 — rate limited. Retryable (with Retry-After honoring, handled elsewhere). */
export class RateLimitError extends ProviderError {
  constructor(message: string, provider: string, opts: ProviderErrorOpts = {}) {
    super(message, provider, { ...opts, recoverable: true, statusCode: opts.statusCode ?? 429 })
    this.name = 'RateLimitError'
  }
}

/** 5xx — server-side trouble. Retryable. */
export class ServiceUnavailableError extends ProviderError {
  constructor(message: string, provider: string, opts: ProviderErrorOpts = {}) {
    super(message, provider, { ...opts, recoverable: true, statusCode: opts.statusCode ?? 503 })
    this.name = 'ServiceUnavailableError'
  }
}

/** 529 (Anthropic) — fleet-wide overload. Retryable. */
export class OverloadedError extends ProviderError {
  constructor(message: string, provider: string, opts: ProviderErrorOpts = {}) {
    super(message, provider, { ...opts, recoverable: true, statusCode: opts.statusCode ?? 529 })
    this.name = 'OverloadedError'
  }
}

/**
 * 400 whose body names the too-long-prompt condition. Distinct from generic
 * InvalidRequest because callers typically want to compact or fall back to
 * a larger-context model instead of just failing.
 */
export class ContextWindowExceededError extends ProviderError {
  constructor(message: string, provider: string, opts: ProviderErrorOpts = {}) {
    super(message, provider, { ...opts, recoverable: false, statusCode: opts.statusCode ?? 400 })
    this.name = 'ContextWindowExceededError'
  }
}

/** 400 whose body names a content-policy / safety block. Not retryable. */
export class ContentPolicyError extends ProviderError {
  constructor(message: string, provider: string, opts: ProviderErrorOpts = {}) {
    super(message, provider, { ...opts, recoverable: false, statusCode: opts.statusCode ?? 400 })
    this.name = 'ContentPolicyError'
  }
}

type ProviderErrorOpts = {
  statusCode?: number
  retryAfterMs?: number
  headers?: Record<string, string>
  recoverable?: boolean
}

// ---------------------------------------------------------------------------
// Classifier — the single chokepoint that turns an HTTP response into a
// typed ProviderError subclass. Call this from every adapter whenever you
// convert an SDK error into a Loom error.
// ---------------------------------------------------------------------------

/**
 * Heuristic body parser — keyed on text we know providers put in messages
 * for specific error conditions. Deliberately narrow: we match only
 * substrings that are stable across provider versions, to avoid false
 * positives. When the body says nothing recognizable, the caller falls
 * back on the status code alone.
 */
function classifyByBody(bodyText: string | null): 'context_window' | 'content_policy' | null {
  if (!bodyText) return null
  const lower = bodyText.toLowerCase()

  // Anthropic: "prompt is too long: X tokens > Y maximum"
  // OpenAI:    "This model's maximum context length is X tokens..."
  //            "context_length_exceeded"
  // Google:    "exceeded the model's context length"
  if (
    lower.includes('prompt is too long') ||
    lower.includes('maximum context length') ||
    lower.includes('context_length_exceeded') ||
    lower.includes("exceeded the model's context") ||
    lower.includes('context window')
  ) {
    return 'context_window'
  }

  // Anthropic: "content_policy_violation"
  // OpenAI:    "content_policy_violation" / "content filter"
  if (
    lower.includes('content_policy_violation') ||
    lower.includes('content filter') ||
    lower.includes('safety policy')
  ) {
    return 'content_policy'
  }

  return null
}

/**
 * Classify a provider HTTP error into the right ProviderError subclass.
 * Pass the HTTP status, the raw body text (if available — used to detect
 * context-window vs. generic 400 errors), and the originating provider
 * name. Returns a fully-constructed subclass — caller throws it.
 *
 * Network-level failures (no response, connection refused) should NOT go
 * through here — they're recoverable and belong on the retry path with
 * `statusCode: null` on a base ProviderError.
 */
export function classifyHttpError(
  status: number,
  bodyText: string | null,
  provider: string,
  opts: { message?: string; retryAfterMs?: number; headers?: Record<string, string> } = {},
): ProviderError {
  const msg = opts.message ?? bodyText ?? `HTTP ${status}`
  const passOpts = { statusCode: status, retryAfterMs: opts.retryAfterMs, headers: opts.headers }

  // Body-content short-circuits — these override status-code classification
  // because "400 + context exceeded" needs different handling than "400 +
  // bad JSON." Order matters: check the most specific signals first.
  const bodyTag = classifyByBody(bodyText)
  if (status === 400 && bodyTag === 'context_window') {
    return new ContextWindowExceededError(msg, provider, passOpts)
  }
  if (status === 400 && bodyTag === 'content_policy') {
    return new ContentPolicyError(msg, provider, passOpts)
  }

  switch (status) {
    case 401:
      return new AuthenticationError(msg, provider, passOpts)
    case 403:
      return new PermissionDeniedError(msg, provider, passOpts)
    case 404:
      return new NotFoundError(msg, provider, passOpts)
    case 408:
      // Request timeout — treat as retryable transient. Falls out as generic
      // recoverable ProviderError (no dedicated subclass because callers
      // rarely need to branch on it separately from 5xx).
      return new ProviderError(msg, provider, { ...passOpts, recoverable: true })
    case 409:
      return new ProviderError(msg, provider, { ...passOpts, recoverable: true })
    case 422:
      return new UnprocessableEntityError(msg, provider, passOpts)
    case 429:
      return new RateLimitError(msg, provider, passOpts)
    case 529:
      return new OverloadedError(msg, provider, passOpts)
  }

  if (status >= 500 && status < 600) {
    return new ServiceUnavailableError(msg, provider, passOpts)
  }

  // Everything else (most 4xx) — unrecoverable generic provider error.
  return new ProviderError(msg, provider, { ...passOpts, recoverable: false })
}

// ---------------------------------------------------------------------------
// Tool errors
// ---------------------------------------------------------------------------

export class ToolError extends LoomError {
  readonly toolName: string
  readonly toolCallId: string

  constructor(message: string, toolName: string, toolCallId: string, recoverable = true) {
    super(message, 'TOOL_ERROR', recoverable)
    this.name = 'ToolError'
    this.toolName = toolName
    this.toolCallId = toolCallId
  }
}

export class ToolTimeoutError extends ToolError {
  readonly timeoutMs: number

  constructor(toolName: string, toolCallId: string, timeoutMs: number) {
    super(`Tool "${toolName}" timed out after ${timeoutMs}ms`, toolName, toolCallId, true)
    this.name = 'ToolTimeoutError'
    this.timeoutMs = timeoutMs
  }
}

export class ToolPermissionError extends ToolError {
  readonly input: Record<string, unknown>

  constructor(toolName: string, toolCallId: string, input: Record<string, unknown>) {
    super(`Permission denied for tool "${toolName}"`, toolName, toolCallId, false)
    this.name = 'ToolPermissionError'
    this.input = input
  }
}

// ---------------------------------------------------------------------------
// Compaction errors
// ---------------------------------------------------------------------------

export class CompactionError extends LoomError {
  readonly strategy: string

  constructor(message: string, strategy: string) {
    super(message, 'COMPACTION_ERROR', true)
    this.name = 'CompactionError'
    this.strategy = strategy
  }
}

// ---------------------------------------------------------------------------
// Checkpoint errors
// ---------------------------------------------------------------------------

export class CheckpointError extends LoomError {
  constructor(message: string) {
    super(message, 'CHECKPOINT_ERROR', true)
    this.name = 'CheckpointError'
  }
}

// ---------------------------------------------------------------------------
// Abort / Cancellation
// ---------------------------------------------------------------------------

export class AbortError extends LoomError {
  readonly reason: 'user' | 'timeout' | 'system' | 'interrupt'

  constructor(reason: 'user' | 'timeout' | 'system' | 'interrupt' = 'user') {
    super(`Aborted: ${reason}`, 'ABORT', false)
    this.name = 'AbortError'
    this.reason = reason
  }
}

// ---------------------------------------------------------------------------
// Configuration errors
// ---------------------------------------------------------------------------

export class ConfigError extends LoomError {
  readonly field: string

  constructor(message: string, field: string) {
    super(message, 'CONFIG_ERROR', false)
    this.name = 'ConfigError'
    this.field = field
  }
}
