/**
 * Unit tests — quota and cost as things we can honestly say.
 *
 * The claim under test, narrowed deliberately during the design gate:
 *
 *   > Response rate-limit headers are timestamped signals. They do not prove
 *   > subscription allowance or predict whether the next request is served.
 *
 * So the tests are organised around what could make that claim false:
 *
 *   1. A provider that states nothing must yield `unknown` — never a
 *      fabricated number, and never silence that reads as healthy.
 *   2. A subscription must be structurally incapable of rendering as £0.00.
 *      This is the specific lie the whole module exists to prevent, so it is
 *      asserted at the type level AND the string level.
 *   3. Real header shapes from the three conventions must parse, including
 *      vendors we have never heard of — the difference between support and a
 *      catalogue.
 *   4. Ambiguous or malformed values must degrade to "unknown", because a
 *      wrong reset time is worse than none.
 */

import { describe, expect, it } from 'vitest'

import {
  QUOTA_UNKNOWN,
  costSurfaceFor,
  describeCostSurface,
  isStale,
  parseResetAt,
  readQuotaFromResponse,
  type QuotaSignal,
} from '../../../src/credential/quota.js'

const NOW = Date.parse('2026-07-26T12:00:00.000Z')

const read = (headers: Record<string, string>, status = 200): QuotaSignal =>
  readQuotaFromResponse({ status, headers, now: NOW })

// ---------------------------------------------------------------------------
// 1 — silence is reported as silence
// ---------------------------------------------------------------------------

describe('a provider that states nothing yields unknown', () => {
  it('reports unknown when no rate-limit headers are present', () => {
    expect(read({ 'content-type': 'text/event-stream' })).toEqual({
      state: 'unknown',
      reason: 'provider-stated-nothing',
    })
  })

  it('reports unknown before any response has been seen', () => {
    expect(QUOTA_UNKNOWN).toEqual({ state: 'unknown', reason: 'no-response-yet' })
  })

  it('ignores a rate-limit header that states no remaining value', () => {
    // A limit without a remaining count states a policy, not an allowance.
    // Reporting it as an allowance would invent the number that matters.
    expect(read({ 'anthropic-ratelimit-requests-limit': '1000' }).state).toBe('unknown')
  })

  it('does not infer exhaustion from error prose', () => {
    // Deliberately excluded: matching words in a body is a heuristic on text a
    // provider may reword at any time, and cannot establish an allowance.
    const signal = read({ 'content-type': 'application/json' }, 400)
    expect(signal.state).toBe('unknown')
  })
})

// ---------------------------------------------------------------------------
// 2 — billing cannot be inferred from authentication
// ---------------------------------------------------------------------------

describe('billing basis stays distinct from credential authentication', () => {
  it('produces a surface with no money field at all', () => {
    const surface = costSurfaceFor({ billingBasis: 'subscription_allowance' })
    expect(surface.kind).toBe('subscription')
    // Not zero, not null — absent. There is no number for a caller to reach for.
    expect('amountUsd' in surface).toBe(false)
  })

  it('never emits a currency figure in its description', () => {
    const surface = costSurfaceFor({ billingBasis: 'subscription_allowance' })
    const text = describeCostSurface(surface)
    expect(text).not.toMatch(/[$£€]/)
    expect(text).not.toContain('0.00')
    expect(text).toMatch(/unknown/i)
  })

  it('says the provider limit status is unknown rather than implying it is fine', () => {
    const text = describeCostSurface(
      costSurfaceFor({ billingBasis: 'subscription_allowance' }),
    )
    expect(text).toMatch(/limit status unknown/i)
  })

  it('ignores an amountUsd wrongly passed for a subscription', () => {
    // Defensive: a caller that computes 0 for a subscription must not be able
    // to smuggle it onto the surface.
    const surface = costSurfaceFor({
      billingBasis: 'subscription_allowance',
      amountUsd: 0,
    })
    expect('amountUsd' in surface).toBe(false)
  })

  it('still shows real money for a metered key', () => {
    const surface = costSurfaceFor({ billingBasis: 'metered', amountUsd: 0.0123 })
    expect(describeCostSurface(surface)).toBe('$0.0123')
  })

  it('marks an estimate as an estimate rather than a bill', () => {
    const surface = costSurfaceFor({
      billingBasis: 'metered',
      amountUsd: 0.5,
      estimated: true,
    })
    expect(describeCostSurface(surface)).toContain('estimated')
  })

  it('does not turn a missing metered price into zero', () => {
    const surface = costSurfaceFor({ billingBasis: 'metered' })
    expect(surface).toEqual({
      kind: 'unknown',
      reason: 'metered-price-unavailable',
    })
    expect(describeCostSurface(surface)).toMatch(/price unavailable/i)
  })

  it('does not let an OAuth-shaped credential imply subscription billing', () => {
    const surface = costSurfaceFor({
      billingBasis: 'unknown',
      authType: 'oauth2',
    } as Parameters<typeof costSurfaceFor>[0] & { authType: 'oauth2' })
    expect(surface).toEqual({
      kind: 'unknown',
      reason: 'billing-basis-unknown',
    })
  })
})

// ---------------------------------------------------------------------------
// 3 — the three conventions, including unknown vendors
// ---------------------------------------------------------------------------

describe('provider statements are read from all three conventions', () => {
  it('reads vendor-prefixed headers (<vendor>-ratelimit-<dim>-<field>)', () => {
    const signal = read({
      'anthropic-ratelimit-requests-remaining': '42',
      'anthropic-ratelimit-requests-limit': '1000',
      'anthropic-ratelimit-requests-reset': '2026-07-26T12:05:00Z',
    })

    expect(signal.state).toBe('reported')
    if (signal.state !== 'reported') return
    expect(signal.dimensions).toEqual([
      { name: 'requests', remaining: 42, limit: 1000, resetAt: '2026-07-26T12:05:00.000Z' },
    ])
    expect(signal.observedAt).toBe('2026-07-26T12:00:00.000Z')
  })

  it('reads x-prefixed headers (x-ratelimit-<field>-<dim>)', () => {
    const signal = read({
      'x-ratelimit-remaining-tokens': '15000',
      'x-ratelimit-limit-tokens': '30000',
      'x-ratelimit-reset-tokens': '60s',
    })

    expect(signal.state).toBe('reported')
    if (signal.state !== 'reported') return
    expect(signal.dimensions[0]).toEqual({
      name: 'tokens',
      remaining: 15000,
      limit: 30000,
      resetAt: '2026-07-26T12:01:00.000Z',
    })
  })

  it('reads the IETF structured RateLimit header', () => {
    const signal = read({ ratelimit: 'limit=100, remaining=17, reset=30' })
    expect(signal.state).toBe('reported')
    if (signal.state !== 'reported') return
    expect(signal.dimensions[0]).toMatchObject({ remaining: 17, limit: 100 })
  })

  it('understands a vendor it has never heard of, with no code change', () => {
    // The point of parsing conventions rather than listing providers: this
    // vendor does not exist and is understood anyway.
    const signal = read({
      'acme-cloud-ratelimit-widgets-remaining': '7',
      'acme-cloud-ratelimit-widgets-limit': '10',
    })
    expect(signal.state).toBe('reported')
    if (signal.state !== 'reported') return
    expect(signal.dimensions[0]).toMatchObject({ name: 'widgets', remaining: 7, limit: 10 })
  })

  it('reports several metered dimensions separately, never summed', () => {
    // Summing requests and tokens, or picking a "primary", would state a
    // number no provider ever gave us.
    const signal = read({
      'anthropic-ratelimit-requests-remaining': '5',
      'anthropic-ratelimit-tokens-remaining': '9000',
    })
    expect(signal.state).toBe('reported')
    if (signal.state !== 'reported') return
    expect(signal.dimensions).toHaveLength(2)
    expect(signal.dimensions.map(d => d.name).sort()).toEqual(['requests', 'tokens'])
  })

  it('accepts a Headers instance as readily as a plain record', () => {
    const headers = new Headers({ 'x-ratelimit-remaining-requests': '3' })
    const signal = readQuotaFromResponse({ status: 200, headers, now: NOW })
    expect(signal.state).toBe('reported')
  })
})

// ---------------------------------------------------------------------------
// exhaustion is structural, never prose
// ---------------------------------------------------------------------------

describe('rate limiting is read from the refusal itself', () => {
  it('reports rate_limited on 429 without claiming plan exhaustion', () => {
    // The refusal IS the provider's statement; absence of headers does not
    // soften it.
    const signal = read({}, 429)
    expect(signal.state).toBe('rate_limited')
    if (signal.state !== 'rate_limited') return
    expect(signal.retryAt).toBeUndefined()
    expect(signal.dimensions).toEqual([])
  })

  it('uses Retry-After when the provider supplies one', () => {
    const signal = read({ 'retry-after': '120' }, 429)
    expect(signal.state).toBe('rate_limited')
    if (signal.state !== 'rate_limited') return
    expect(signal.retryAt).toBe('2026-07-26T12:02:00.000Z')
  })

  it('falls back to a dimension reset when Retry-After is absent', () => {
    const signal = read({ 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '45' }, 429)
    expect(signal.state).toBe('rate_limited')
    if (signal.state !== 'rate_limited') return
    expect(signal.retryAt).toBe('2026-07-26T12:00:45.000Z')
  })

  it('describes exhaustion without a reset honestly', () => {
    const surface = costSurfaceFor({
      billingBasis: 'subscription_allowance',
      quota: read({}, 429),
    })
    expect(describeCostSurface(surface)).toMatch(/did not say when to retry/i)
  })
})

// ---------------------------------------------------------------------------
// 4 — malformed input degrades to unknown, never to a guess
// ---------------------------------------------------------------------------

describe('reset values parse across forms, and refuse to guess', () => {
  it('reads delay-in-seconds', () => {
    expect(parseResetAt('30', NOW)).toBe('2026-07-26T12:00:30.000Z')
  })

  it('reads a duration string', () => {
    expect(parseResetAt('1m30s', NOW)).toBe('2026-07-26T12:01:30.000Z')
  })

  it('reads an absolute epoch-seconds timestamp', () => {
    const epoch = Math.floor(Date.parse('2026-07-26T13:00:00.000Z') / 1000)
    expect(parseResetAt(String(epoch), NOW)).toBe('2026-07-26T13:00:00.000Z')
  })

  it('reads an absolute ISO timestamp', () => {
    expect(parseResetAt('2026-07-26T12:30:00Z', NOW)).toBe('2026-07-26T12:30:00.000Z')
  })

  it('returns undefined for a form it does not recognise', () => {
    // A wrong reset time is worse than none — it sends someone back at a
    // moment that means nothing.
    expect(parseResetAt('next tuesday', NOW)).toBeUndefined()
    expect(parseResetAt('', NOW)).toBeUndefined()
    expect(parseResetAt('-5', NOW)).toBeUndefined()
    expect(parseResetAt(undefined, NOW)).toBeUndefined()
  })

  it('drops a malformed remaining value rather than reporting zero', () => {
    // Coercing garbage to 0 would read as "rate limited" — a damaging
    // possible misreading.
    expect(read({ 'x-ratelimit-remaining-requests': 'lots' }).state).toBe('unknown')
  })
})

// ---------------------------------------------------------------------------
// staleness
// ---------------------------------------------------------------------------

describe('staleness is visible to the caller', () => {
  it('treats a fresh reading as current', () => {
    const signal = read({ 'x-ratelimit-remaining-requests': '5' })
    expect(isStale(signal, 60_000, NOW + 10_000)).toBe(false)
  })

  it('treats an old reading as stale', () => {
    const signal = read({ 'x-ratelimit-remaining-requests': '5' })
    expect(isStale(signal, 60_000, NOW + 120_000)).toBe(true)
  })

  it('never calls unknown stale — there is nothing to go stale', () => {
    expect(isStale(QUOTA_UNKNOWN, 1, NOW + 1_000_000)).toBe(false)
  })

  it('timestamps every reading so staleness is computable at all', () => {
    const signal = read({ 'x-ratelimit-remaining-requests': '5' })
    expect(signal.state).toBe('reported')
    if (signal.state !== 'reported') return
    expect(Number.isNaN(Date.parse(signal.observedAt))).toBe(false)
  })
})
