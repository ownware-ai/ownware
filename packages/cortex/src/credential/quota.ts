/**
 * Quota and cost as things we can honestly say.
 *
 * Authentication, billing, and provider rate limits are independent facts.
 * OAuth does not prove a subscription, an API key does not prove that a local
 * price is known, and a response rate-limit header does not prove plan
 * allowance. This module keeps those facts separate so an absent price cannot
 * silently become `$0` and a generic 429 cannot become “plan exhausted”.
 *
 * ## The claim, and its authority
 *
 * > We report response-scoped rate-limit statements as provider signals,
 * > timestamped. We do not claim they describe subscription allowance or
 * > predict whether the next request will be served.
 *
 * The authority is the provider's own rate-limit response headers. That is a
 * genuine authority for that response's rate-limit state — not a proxy we
 * inferred. What it does NOT establish is account-plan allowance or prediction:
 * a header on response N describes the limit signal at response N. Between
 * then and the next request the
 * provider may have served other clients, changed a policy, or reset a window.
 * Every reading therefore carries `observedAt`, and the type has no field that
 * would let a caller state a guarantee about a future request.
 *
 * ## Conventions, not a provider catalogue
 *
 * Three header conventions are parsed, covering the field as it exists:
 *
 *   1. `<vendor>-ratelimit-<dimension>-remaining|limit|reset`
 *   2. `x-ratelimit-remaining|limit|reset-<dimension>`
 *   3. `RateLimit: limit=…, remaining=…, reset=…`  (IETF httpapi draft)
 *
 * A provider that follows any of them is understood with no code change here;
 * that is the difference between support and a catalogue with an integration
 * tax. A provider that follows none yields `unknown` — the honest answer —
 * rather than a fabricated number.
 *
 * ## What is deliberately NOT here
 *
 * No parsing of error-body prose. Matching a string like `UsageLimitError` out
 * of a response body is a heuristic on a message a provider may reword at any
 * time, and it cannot establish a plan allowance. A `429` status and a
 * `Retry-After` header are structural and authoritative; the prose next to
 * them is not, and is never used to claim exhaustion.
 */

// ---------------------------------------------------------------------------
// Quota signal
// ---------------------------------------------------------------------------

/**
 * One dimension of a response rate limit. Providers meter different things — requests,
 * tokens, input tokens — and we do not normalise across them, because summing
 * or picking a "primary" would invent a number nobody stated.
 */
export interface QuotaDimension {
  /** Provider's own name for what is metered, e.g. `requests`, `tokens`. */
  readonly name: string
  /** Units remaining, as stated. */
  readonly remaining: number
  /** Ceiling for the window, when stated. */
  readonly limit: number | undefined
  /** ISO 8601 instant the window resets, when stated or derivable. */
  readonly resetAt: string | undefined
}

/**
 * What a provider response said about rate limiting.
 *
 * `unknown` is a first-class outcome, not a failure. Most of the time it will
 * be the honest answer, and a surface that cannot render it will lie.
 */
export type QuotaSignal =
  | {
      readonly state: 'unknown'
      /** Why we have nothing to report — shown to an operator, not a customer. */
      readonly reason: 'no-response-yet' | 'provider-stated-nothing'
    }
  | {
      readonly state: 'reported'
      /** Every dimension the provider stated. Never empty in this variant. */
      readonly dimensions: readonly QuotaDimension[]
      /** When the provider said it. Staleness is the caller's to weigh. */
      readonly observedAt: string
    }
  | {
      readonly state: 'rate_limited'
      /** ISO instant the provider said to retry at, when it said one. */
      readonly retryAt: string | undefined
      /** Dimensions stated alongside the refusal, if any. */
      readonly dimensions: readonly QuotaDimension[]
      readonly observedAt: string
    }

/** The starting signal for a credential that has not been used yet. */
export const QUOTA_UNKNOWN: QuotaSignal = { state: 'unknown', reason: 'no-response-yet' }

// ---------------------------------------------------------------------------
// Cost surface
// ---------------------------------------------------------------------------

/**
 * What a person should be shown about what a call cost.
 *
 * Authentication method is deliberately absent. The caller must supply the
 * route's billing authority rather than asking this module to infer billing
 * from `oauth2`.
 */
export type CostSurface =
  | {
      readonly kind: 'metered'
      /** Real money attributable to this call. */
      readonly amountUsd: number
      /**
       * True when derived from a local pricing table rather than a
       * provider-reported figure — an estimate must not be shown as a bill.
       */
      readonly estimated: boolean
    }
  | {
      readonly kind: 'subscription'
      /** A response rate-limit signal, not proof of account-plan allowance. */
      readonly quota: QuotaSignal
    }
  | {
      readonly kind: 'unknown'
      readonly reason: 'billing-basis-unknown' | 'metered-price-unavailable'
    }

export type BillingBasis =
  | 'metered'
  | 'subscription_allowance'
  | 'unknown'

/**
 * Build the surface for a credential.
 *
 * Missing metered price is `unknown`, never zero. A subscription surface is
 * constructed only from an explicit route-level billing decision; OAuth alone
 * is not an authority.
 */
export function costSurfaceFor(input: {
  readonly billingBasis: BillingBasis
  readonly amountUsd?: number
  readonly estimated?: boolean
  readonly quota?: QuotaSignal
}): CostSurface {
  if (input.billingBasis === 'subscription_allowance') {
    return { kind: 'subscription', quota: input.quota ?? QUOTA_UNKNOWN }
  }
  if (input.billingBasis === 'unknown') {
    return { kind: 'unknown', reason: 'billing-basis-unknown' }
  }
  if (
    input.amountUsd === undefined
    || !Number.isFinite(input.amountUsd)
    || input.amountUsd < 0
  ) {
    return { kind: 'unknown', reason: 'metered-price-unavailable' }
  }
  return {
    kind: 'metered',
    amountUsd: input.amountUsd,
    estimated: input.estimated ?? false,
  }
}

// ---------------------------------------------------------------------------
// Header parsing
// ---------------------------------------------------------------------------

/** Case-insensitive header access over either a `Headers` or a plain record. */
type HeaderSource = Headers | Readonly<Record<string, string>>

function readHeader(source: HeaderSource, name: string): string | undefined {
  if (typeof (source as Headers).get === 'function') {
    return (source as Headers).get(name) ?? undefined
  }
  const record = source as Readonly<Record<string, string>>
  const hit = Object.keys(record).find(k => k.toLowerCase() === name.toLowerCase())
  return hit === undefined ? undefined : record[hit]
}

function headerNames(source: HeaderSource): string[] {
  if (typeof (source as Headers).forEach === 'function' && typeof (source as Headers).get === 'function') {
    const names: string[] = []
    ;(source as Headers).forEach((_v, k) => names.push(k))
    return names
  }
  return Object.keys(source as Readonly<Record<string, string>>)
}

function toFiniteNumber(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const n = Number.parseFloat(raw.trim())
  return Number.isFinite(n) ? n : undefined
}

/**
 * Normalise a reset value to an ISO instant.
 *
 * Providers express this three ways: seconds-from-now, a duration like `6s` or
 * `1m30s`, or an absolute timestamp. An unrecognised form yields `undefined` —
 * we do not guess, because a wrong reset time is worse than none (it would
 * tell someone to come back at a moment that means nothing).
 */
export function parseResetAt(raw: string | undefined, now: number): string | undefined {
  if (raw === undefined) return undefined
  const value = raw.trim()
  if (value === '') return undefined

  // Absolute ISO timestamp.
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const at = Date.parse(value)
    return Number.isNaN(at) ? undefined : new Date(at).toISOString()
  }

  // Duration form: 1h2m3s / 30s / 1.5s
  const duration = /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(value)
  if (duration !== null && value !== '' && /[hms]/.test(value)) {
    const hours = Number.parseFloat(duration[1] ?? '0') || 0
    const minutes = Number.parseFloat(duration[2] ?? '0') || 0
    const seconds = Number.parseFloat(duration[3] ?? '0') || 0
    const ms = (hours * 3600 + minutes * 60 + seconds) * 1000
    if (ms > 0) return new Date(now + ms).toISOString()
    return undefined
  }

  // Bare number: epoch seconds if it is plausibly a timestamp, else a delay.
  const numeric = toFiniteNumber(value)
  if (numeric === undefined || numeric < 0) return undefined
  // ~1.5e9 is 2017; anything at or above that is an absolute epoch-seconds
  // value rather than a delay measured in seconds.
  if (numeric >= 1_500_000_000) return new Date(numeric * 1000).toISOString()
  return new Date(now + numeric * 1000).toISOString()
}

/** Collect dimensions from convention 1 and 2 (vendor-prefixed and x-prefixed). */
function parsePrefixedDimensions(source: HeaderSource, now: number): QuotaDimension[] {
  const byName = new Map<string, { remaining?: number; limit?: number; reset?: string }>()

  for (const rawName of headerNames(source)) {
    const name = rawName.toLowerCase()
    if (!name.includes('ratelimit')) continue

    // Convention 1: <vendor>-ratelimit-<dimension>-<field>
    let match = /ratelimit-([a-z0-9_]+)-(remaining|limit|reset)$/.exec(name)
    // Convention 2: x-ratelimit-<field>-<dimension>
    if (match === null) {
      const alt = /ratelimit-(remaining|limit|reset)-([a-z0-9_]+)$/.exec(name)
      if (alt !== null) match = [alt[0], alt[2], alt[1]] as unknown as RegExpExecArray
    }
    if (match === null) continue

    const dimension = match[1] as string
    const field = match[2] as 'remaining' | 'limit' | 'reset'
    const value = readHeader(source, rawName)
    if (value === undefined) continue

    const entry = byName.get(dimension) ?? {}
    if (field === 'reset') {
      const at = parseResetAt(value, now)
      if (at !== undefined) entry.reset = at
    } else {
      const n = toFiniteNumber(value)
      if (n !== undefined) entry[field] = n
    }
    byName.set(dimension, entry)
  }

  const out: QuotaDimension[] = []
  for (const [name, entry] of byName) {
    // `remaining` is the load-bearing field; a dimension without it states no
    // rate-limit state and is not worth reporting as one.
    if (entry.remaining === undefined) continue
    out.push({
      name,
      remaining: entry.remaining,
      limit: entry.limit,
      resetAt: entry.reset,
    })
  }
  return out
}

/** Convention 3: `RateLimit: limit=100, remaining=42, reset=60`. */
function parseStructuredRateLimit(source: HeaderSource, now: number): QuotaDimension[] {
  const raw = readHeader(source, 'ratelimit')
  if (raw === undefined) return []

  const fields = new Map<string, string>()
  for (const part of raw.split(',')) {
    const [key, value] = part.split('=')
    if (key === undefined || value === undefined) continue
    fields.set(key.trim().toLowerCase(), value.trim().replace(/^"|"$/g, ''))
  }

  const remaining = toFiniteNumber(fields.get('remaining'))
  if (remaining === undefined) return []
  return [
    {
      // The draft does not name the dimension; say so rather than invent one.
      name: fields.get('name') ?? 'requests',
      remaining,
      limit: toFiniteNumber(fields.get('limit')),
      resetAt: parseResetAt(fields.get('reset'), now),
    },
  ]
}

/**
 * Read a provider's response-scoped rate-limit statement.
 *
 * `status` is consulted only for the structural fact of refusal (`429`), never
 * for the prose beside it. A refusal yields `rate_limited` even when the
 * provider stated no numbers. It does not establish subscription exhaustion.
 */
export function readQuotaFromResponse(input: {
  readonly status: number
  readonly headers: HeaderSource
  readonly now?: number
}): QuotaSignal {
  const now = input.now ?? Date.now()
  const observedAt = new Date(now).toISOString()

  const dimensions = [
    ...parsePrefixedDimensions(input.headers, now),
    ...parseStructuredRateLimit(input.headers, now),
  ]

  if (input.status === 429) {
    return {
      state: 'rate_limited',
      retryAt: parseResetAt(readHeader(input.headers, 'retry-after'), now)
        ?? dimensions.find(d => d.resetAt !== undefined)?.resetAt,
      dimensions,
      observedAt,
    }
  }

  if (dimensions.length === 0) {
    return { state: 'unknown', reason: 'provider-stated-nothing' }
  }

  return { state: 'reported', dimensions, observedAt }
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

/**
 * Whether a reading is old enough that it should not be shown as current.
 *
 * Exists so a surface cannot silently present a week-old number as live. The
 * caller decides the threshold; there is no universally right one.
 */
export function isStale(signal: QuotaSignal, maxAgeMs: number, now: number = Date.now()): boolean {
  if (signal.state === 'unknown') return false
  const at = Date.parse(signal.observedAt)
  if (Number.isNaN(at)) return true
  return now - at > maxAgeMs
}

/**
 * Plain-language description of a cost surface, for an operator-facing string.
 *
 * Never emits a money figure for a subscription, and never asserts that a
 * future request will succeed. `unknown` is stated as unknown.
 */
export function describeCostSurface(surface: CostSurface): string {
  if (surface.kind === 'metered') {
    const amount = `$${surface.amountUsd.toFixed(4)}`
    return surface.estimated ? `${amount} (estimated)` : amount
  }
  if (surface.kind === 'unknown') {
    return surface.reason === 'metered-price-unavailable'
      ? 'Metered usage — price unavailable'
      : 'Billing basis unknown'
  }

  const quota = surface.quota
  if (quota.state === 'unknown') {
    return 'Subscription allowance — provider limit status unknown'
  }
  if (quota.state === 'rate_limited') {
    return quota.retryAt === undefined
      ? 'Subscription request rate-limited — the provider did not say when to retry'
      : `Subscription request rate-limited — retry after ${quota.retryAt}`
  }
  const parts = quota.dimensions.map(d =>
    d.limit === undefined
      ? `${d.remaining} ${d.name} left`
      : `${d.remaining} of ${d.limit} ${d.name} left`,
  )
  return `Subscription allowance — response limits: ${parts.join(', ')} as of ${quota.observedAt}`
}
