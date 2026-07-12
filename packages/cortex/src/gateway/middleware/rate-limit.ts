/**
 * Rate limiting middleware — token-bucket algorithm per IP address.
 *
 * Two tiers:
 * - General endpoints: 600 requests/minute (raised from 60 — the post-1b.9
 *   pane API does many invalidate-on-settle refetches; the old 60/min
 *   limit was being hit by routine workspace usage and silently dropping
 *   chat replies when the SSE stream got blocked. See BUGS.md
 *   `[CRITICAL · BLOCKING] Infinite invalidation loop hits rate limit`
 *   for the full diagnosis.)
 * - /api/v1/run: 10 requests/minute (expensive LLM calls)
 *
 * Override per-instance via `createRateLimiter({ generalLimit, runLimit })`
 * or set the env vars `OWNWARE_RATE_LIMIT_GENERAL` /
 * `OWNWARE_RATE_LIMIT_RUN`. To disable entirely (dev / Electron),
 * set `OWNWARE_DISABLE_RATE_LIMIT=1` — `check()` short-circuits to
 * always-allow.
 *
 * Returns 429 with Retry-After header when exceeded.
 * Stale buckets are cleaned up every 5 minutes to prevent memory leaks.
 *
 * Followup: SSE-based pane invalidation (per cortex/gateway/CLAUDE.md
 * hydration contract) would let us return to a tighter limit. Tracked
 * in BUGS.md as a wave-5+ slice.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendError } from '../router.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * General rate limit: 600 requests per minute (10/sec).
 * Raised from 60/min on 2026-05-10 after the post-1b.9 pane API's
 * invalidate-on-settle pattern was found to exceed the old limit
 * during routine workspace usage. See module doc above.
 */
const GENERAL_LIMIT = 600

/** Run endpoint rate limit: 10 requests per minute */
const RUN_LIMIT = 10

/**
 * Env-var escape hatches. Empty / unset = use defaults.
 *   OWNWARE_DISABLE_RATE_LIMIT=1   → check() always returns true
 *   OWNWARE_RATE_LIMIT_GENERAL=N   → override the general limit
 *   OWNWARE_RATE_LIMIT_RUN=N       → override the run limit
 */
const DISABLE_VIA_ENV = process.env['OWNWARE_DISABLE_RATE_LIMIT'] === '1'

function envInt(name: string): number | undefined {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return undefined
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/** Refill interval in milliseconds (1 minute) */
const REFILL_INTERVAL_MS = 60_000

/** Stale bucket cleanup interval in milliseconds (5 minutes) */
const CLEANUP_INTERVAL_MS = 5 * 60_000

/** Bucket expiry: if no requests for 10 minutes, remove the bucket */
const BUCKET_EXPIRY_MS = 10 * 60_000

/** Paths that use the lower (run) rate limit */
const RUN_PATHS = new Set(['/api/v1/run'])

// ---------------------------------------------------------------------------
// Token bucket
// ---------------------------------------------------------------------------

interface Bucket {
  tokens: number
  lastRefill: number
  maxTokens: number
}

// ---------------------------------------------------------------------------
// Rate limiter factory
// ---------------------------------------------------------------------------

export interface RateLimiter {
  /** Middleware function. Returns true if allowed, false if rate-limited (response sent). */
  check(req: IncomingMessage, res: ServerResponse): boolean
  readonly limits: RateLimitDescriptor
  /** Stop the cleanup timer (for graceful shutdown). */
  stop(): void
}

export interface RateLimitDescriptor {
  readonly enabled: boolean
  readonly windowSeconds: 60
  readonly generalRequests: number
  readonly runStarts: number
}

export function createRateLimiter(opts?: {
  /**
   * Force-disable rate limiting entirely. `check()` returns true for every
   * request without touching any bucket. Honours the
   * `OWNWARE_DISABLE_RATE_LIMIT=1` env var as well — either path produces
   * the no-op limiter, which is appropriate for dev / Electron / test.
   */
  disabled?: boolean
  generalLimit?: number
  runLimit?: number
}): RateLimiter {
  // Disabled path: short-circuit to a no-op limiter. Saves the bucket
  // book-keeping entirely + avoids the 60-req/min surprise that bit
  // the post-1b.9 pane-invalidation flow.
  if (opts?.disabled === true || DISABLE_VIA_ENV) {
    return {
      check: () => true,
      limits: {
        enabled: false,
        windowSeconds: 60,
        generalRequests: 0,
        runStarts: 0,
      },
      stop: () => { /* no-op */ },
    }
  }

  const generalLimit = opts?.generalLimit ?? envInt('OWNWARE_RATE_LIMIT_GENERAL') ?? GENERAL_LIMIT
  const runLimit = opts?.runLimit ?? envInt('OWNWARE_RATE_LIMIT_RUN') ?? RUN_LIMIT

  /** IP → bucket for general endpoints */
  const generalBuckets = new Map<string, Bucket>()
  /** IP → bucket for run endpoints */
  const runBuckets = new Map<string, Bucket>()

  // Periodic cleanup of stale buckets
  const cleanupTimer = setInterval(() => {
    const now = Date.now()
    cleanupMap(generalBuckets, now)
    cleanupMap(runBuckets, now)
  }, CLEANUP_INTERVAL_MS)

  // Don't block process exit
  if (cleanupTimer.unref) cleanupTimer.unref()

  function cleanupMap(map: Map<string, Bucket>, now: number): void {
    for (const [key, bucket] of map) {
      if (now - bucket.lastRefill > BUCKET_EXPIRY_MS) {
        map.delete(key)
      }
    }
  }

  function getOrCreate(map: Map<string, Bucket>, ip: string, maxTokens: number): Bucket {
    let bucket = map.get(ip)
    if (!bucket) {
      bucket = { tokens: maxTokens, lastRefill: Date.now(), maxTokens }
      map.set(ip, bucket)
    }
    return bucket
  }

  function refill(bucket: Bucket): void {
    const now = Date.now()
    const elapsed = now - bucket.lastRefill
    // Refill proportionally: maxTokens per REFILL_INTERVAL_MS
    const tokensToAdd = (elapsed / REFILL_INTERVAL_MS) * bucket.maxTokens
    bucket.tokens = Math.min(bucket.maxTokens, bucket.tokens + tokensToAdd)
    bucket.lastRefill = now
  }

  function check(req: IncomingMessage, res: ServerResponse): boolean {
    const ip = req.socket.remoteAddress ?? '127.0.0.1'
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const pathname = url.pathname

    const isRunPath = RUN_PATHS.has(pathname)
    const map = isRunPath ? runBuckets : generalBuckets
    const limit = isRunPath ? runLimit : generalLimit

    const bucket = getOrCreate(map, ip, limit)
    refill(bucket)

    if (bucket.tokens < 1) {
      // Calculate retry-after in seconds
      const tokensNeeded = 1 - bucket.tokens
      const retryAfterSec = Math.ceil((tokensNeeded / bucket.maxTokens) * (REFILL_INTERVAL_MS / 1000))

      res.setHeader('Retry-After', String(retryAfterSec))
      sendError(
        res,
        429,
        'Too many requests. Please slow down.',
        'rate_limited',
        'rate_limit',
        { retryAfter: retryAfterSec },
      )
      return false
    }

    bucket.tokens -= 1
    return true
  }

  function stop(): void {
    clearInterval(cleanupTimer)
  }

  return {
    check,
    limits: {
      enabled: true,
      windowSeconds: 60,
      generalRequests: generalLimit,
      runStarts: runLimit,
    },
    stop,
  }
}
