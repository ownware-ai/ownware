/**
 * Cache control — wire-level marker shape and per-session configuration.
 *
 * The provider's prompt cache lets us attach a `cache_control` marker to a
 * request block, telling the server to snapshot the KV state up to and
 * including that block. The marker has two relevant knobs on current
 * provider surface:
 *
 *   - `type: 'ephemeral'` — required. The only supported kind.
 *   - `ttl` — optional. Controls how long the cache entry lives:
 *       - `'5m'` (default if absent) — 5 minute TTL.
 *       - `'1h'` — 1 hour TTL. Keeps entries alive across normal
 *         between-turn pauses (reading a reply, thinking, typing) that
 *         routinely exceed the 5-minute default.
 *
 * `CacheProfile` is the session-level configuration that chooses between
 * those two. Every marker the loop emits (both system-side and the last-
 * message marker) passes through `buildCacheMarker`, so changing the
 * profile once at session start propagates everywhere. Holding the shape
 * in one place also means a future knob (account-gated scope, different
 * tier names) can be added without hunting down marker-construction
 * sites scattered across the loop.
 *
 * Omitted: any form of scope field. The public provider SDK does not
 * declare one, so we cannot verify a runtime contract for it, and
 * inventing a shape the server may silently ignore would mislead every
 * downstream reader into thinking caching crosses session boundaries
 * when it does not. If a verified scope knob surfaces later, it plugs
 * into this module — nothing else has to change.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Allowed TTL values. The list is a hard enumeration from the provider's
 * public SDK type; callers cannot pass arbitrary duration strings.
 */
export type CacheTTL = '5m' | '1h'

/**
 * The wire-level cache control marker attached to a single content block.
 * Loom constructs these; providers that do not support prompt caching
 * ignore the field (non-Anthropic adapters never read it).
 *
 * `ttl` is emitted only when the caller explicitly opts into a non-default
 * tier. Emitting `ttl: '5m'` is technically allowed but semantically
 * identical to the default — we keep the wire shape minimal so request
 * diffs do not contain cosmetic differences that mask real changes during
 * debugging.
 */
export interface CacheControlMarker {
  readonly type: 'ephemeral'
  readonly ttl?: CacheTTL
}

/**
 * Session-level cache configuration. Read once at session start and
 * applied uniformly to every marker the loop emits during that session.
 * Passing a fresh `CacheProfile` on a later turn does not change the TTL
 * for markers already written server-side — their tier is fixed at
 * write time.
 */
export interface CacheProfile {
  /**
   * Target TTL tier. Defaults to `'5m'` when absent so every existing
   * caller gets today's behaviour untouched. Switching to `'1h'` is
   * explicitly opt-in per profile.
   */
  readonly ttl?: CacheTTL
}

/**
 * Default profile — the no-opt-in baseline. Equivalent to omitting the
 * `cacheProfile` field entirely. Exposed as a named constant so tests
 * and downstream code have a single reference point instead of scattering
 * `{ ttl: '5m' }` literals throughout the codebase.
 */
export const DEFAULT_CACHE_PROFILE: CacheProfile = Object.freeze({ ttl: '5m' })

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Construct a cache marker from a profile. Centralising this in one place
 * means every call site behaves identically — the system-block emitter,
 * the last-message-marker helper, any future caller all go through here.
 *
 *  - Undefined / null profile → `{ type: 'ephemeral' }`.
 *  - `{ ttl: '5m' }` (explicit default) → `{ type: 'ephemeral' }`. We
 *    strip the redundant field for the reason given on `CacheControlMarker`.
 *  - `{ ttl: '1h' }` → `{ type: 'ephemeral', ttl: '1h' }`.
 *
 * Unknown TTL values are a programmer error — TypeScript rejects them at
 * compile time via the `CacheTTL` union. If someone forces one through a
 * cast, we fall back to the default marker and move on. We do not throw
 * on this path: a mistyped TTL inside a user-supplied profile field
 * should degrade to safe default caching, not crash a live session.
 */
export function buildCacheMarker(profile?: CacheProfile | null): CacheControlMarker {
  if (profile?.ttl === '1h') {
    return { type: 'ephemeral', ttl: '1h' }
  }
  return { type: 'ephemeral' }
}
