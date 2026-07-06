/**
 * ComposioCatalogCache — shared in-memory view of Composio's live
 * toolkit catalogue.
 *
 * Both the source provider (which lists connectors for the UI) and the
 * tool adapter (which resolves declared toolkit slugs into Loom tool
 * objects at profile-assembly time) need the same data: "what does
 * Composio say about toolkit X right now?" Pre-rip both surfaces read
 * from a SQLite mirror refreshed hourly. The mirror staled faster than
 * users edited their orgs (created auth_configs, enabled new toolkits)
 * and the resulting UX was the documented "Setup needed never clears"
 * symptom.
 *
 * Live model:
 *   - One `listToolkits` paginated walk per (TTL window | cache miss).
 *   - Concurrent callers during a miss share a single in-flight
 *     promise — `Promise<readonly ComposioToolkitSummary[]>` — so we
 *     never run two walks at once.
 *   - `getBySlug(slug)` is O(1) over the cached array after the walk
 *     completes; first call after expiry pays the walk cost.
 *
 * No persistence. The cache lives on the gateway instance; restart
 * means a cold walk on the next request, ~200ms × N pages. With
 * limit=100 and Composio's current catalogue (~1k toolkits) that's
 * 10-11 calls × ~150ms ≈ 1.5s total — bounded, paid once per gateway
 * lifecycle for the warm case.
 *
 * Two consumer paths (2026-05-25):
 *   - `listToolkits()` — full-walk, used by the unified `/connectors`
 *     handler when no `?source=composio` param is supplied. Still
 *     pays the 1.5s cold walk; downstream callers (Tools lobby,
 *     profile-scoped reads) tolerate it because they ask once and
 *     reuse for 60s.
 *   - `listPage()` — per-page, used by the paginated
 *     `/connectors?source=composio&search=&cursor=` branch that
 *     backs the Add Tool modal. Pays only one Composio API call per
 *     page-key per 60s. This is the path that takes the modal's
 *     first paint from 3+ min (1000 cards + 1000 icon GETs) to
 *     sub-second.
 *
 * Both paths read from the same upstream client but cache
 * independently. The full-walk path is preserved deliberately for
 * the unified-list consumers; `composio-live-catalog-2026-05-21`
 * tracks the eventual removal of `walkAllPages` once those consumers
 * also migrate to pagination.
 */

import type {
  ComposioClient,
  ComposioToolkitSummary,
} from './client.js'

export interface ComposioCatalogCacheOptions {
  readonly client: ComposioClient
  /** Cache TTL in ms. Default 60_000 (60s). */
  readonly ttlMs?: number
  /** Hard ceiling on paginated walk depth. Default 200. */
  readonly maxPages?: number
  /** Page size for `listToolkits`. Default 100. */
  readonly pageSize?: number
  /** Test seam — override the clock. */
  readonly now?: () => number
  /** Test seam — override the log sink. */
  readonly log?: (msg: string) => void
}

const DEFAULT_TTL_MS = 60_000
const DEFAULT_MAX_PAGES = 200
const DEFAULT_PAGE_SIZE = 100
/** After an empty/partial (failed) walk, retry this soon instead of caching
 *  emptiness for a full TTL — recover fast when Composio comes back. */
const RETRY_AFTER_EMPTY_MS = 10_000

/**
 * A single page of toolkits returned by Composio's `/api/v3/toolkits`
 * endpoint, normalised to the wire shape the gateway returns. The
 * cursor is whatever Composio handed back — opaque to us, replayed
 * straight back as the `cursor` param on the next call.
 */
export interface ComposioToolkitPage {
  readonly items: readonly ComposioToolkitSummary[]
  readonly nextCursor: string | null
}

interface ComposioPageCacheEntry {
  readonly page: ComposioToolkitPage
  readonly expiresAt: number
}

export class ComposioCatalogCache {
  private readonly client: ComposioClient
  private readonly ttlMs: number
  private readonly maxPages: number
  private readonly pageSize: number
  private readonly now: () => number
  private readonly log: (msg: string) => void

  private cache: { entries: readonly ComposioToolkitSummary[]; expiresAt: number } | null = null
  private inFlight: Promise<readonly ComposioToolkitSummary[]> | null = null

  // Per-page cache keyed by JSON.stringify({ search, cursor, limit }).
  // Separate from the full-catalog `cache` field above — the two
  // serve different consumers (legacy full-list callers vs. the
  // paginated `/connectors?source=composio` modal path) and either
  // can warm independently. 60s TTL matches the full-walk budget.
  private readonly pageCache = new Map<string, ComposioPageCacheEntry>()
  // Coalesce concurrent fetches for the same page key into one
  // network call — mirror of `inFlight` for the full walk.
  private readonly inFlightPages = new Map<string, Promise<ComposioToolkitPage>>()

  constructor(opts: ComposioCatalogCacheOptions) {
    this.client = opts.client
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
    this.maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES
    this.pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE
    this.now = opts.now ?? Date.now
    this.log = opts.log ?? ((msg) => { console.log(msg) })
  }

  /**
   * The full Composio catalogue. Stale-while-revalidate:
   *   - fresh cache  → served immediately;
   *   - stale cache  → last-good served IMMEDIATELY, refreshed in background;
   *   - cold (boot)  → one walk (the gateway warms this at startup).
   *
   * This is what makes the connector list "always ready": after the first
   * successful walk a request NEVER blocks on Composio again, so a slow/down
   * Composio can't time out the caller (e.g. the builder's list_capabilities).
   */
  async listToolkits(): Promise<readonly ComposioToolkitSummary[]> {
    const now = this.now()
    if (this.cache !== null && this.cache.expiresAt > now) {
      return this.cache.entries
    }
    if (this.cache !== null) {
      void this.refresh()
      return this.cache.entries
    }
    return this.refresh()
  }

  /**
   * Force a catalogue refresh now (startup warm-up + periodic keep-warm).
   * Coalesces with any in-flight walk; never throws.
   */
  async warm(): Promise<void> {
    await this.refresh()
  }

  /**
   * Run a single coalesced walk and update the cache. Never clobbers a good
   * (non-empty) catalogue with an empty/partial failed walk — Composio being
   * slow or down must NOT turn into "no connectors"; it keeps the last-good
   * list and retries soon.
   */
  private refresh(): Promise<readonly ComposioToolkitSummary[]> {
    if (this.inFlight !== null) return this.inFlight
    this.inFlight = this.walkAllPages()
      .then((entries) => {
        const prev = this.cache
        if (entries.length > 0) {
          this.cache = { entries, expiresAt: this.now() + this.ttlMs }
        } else {
          const keep = prev !== null && prev.entries.length > 0 ? prev.entries : entries
          this.cache = { entries: keep, expiresAt: this.now() + RETRY_AFTER_EMPTY_MS }
        }
        return this.cache.entries
      })
      .finally(() => {
        this.inFlight = null
      })
    return this.inFlight
  }

  /**
   * Resolve a single toolkit slug against the cached catalogue. Returns
   * `null` when the slug is not present (typo, deprecated toolkit,
   * etc.). Triggers the same paginated walk as `listToolkits` on cache
   * miss, then indexes O(1) on subsequent calls within the TTL.
   */
  async getBySlug(slug: string): Promise<ComposioToolkitSummary | null> {
    const all = await this.listToolkits()
    for (const item of all) {
      if (item.slug === slug) return item
    }
    return null
  }

  /**
   * Fetch one page of toolkits directly from Composio with optional
   * `search` + `cursor`. Cached per `{ search, cursor, limit }` key
   * for `ttlMs`. Concurrent misses on the same key coalesce into one
   * network call.
   *
   * Used by the gateway's paginated `/api/v1/connectors?source=composio`
   * passthrough — the path the Add Tool modal consumes. The full-walk
   * `listToolkits()` above stays callable for legacy unified-list
   * consumers; this method is the new on-demand path.
   *
   * `limit` defaults to the cache's configured `pageSize` so callers
   * can omit it for the natural default. `search` and `cursor` are
   * pass-through — undefined means "no filter" / "first page."
   */
  async listPage(params: {
    readonly search?: string
    readonly cursor?: string
    readonly limit?: number
  } = {}): Promise<ComposioToolkitPage> {
    const limit = params.limit ?? this.pageSize
    const key = JSON.stringify({
      search: params.search ?? null,
      cursor: params.cursor ?? null,
      limit,
    })
    const now = this.now()
    const cached = this.pageCache.get(key)
    if (cached !== undefined && cached.expiresAt > now) return cached.page

    const existing = this.inFlightPages.get(key)
    if (existing !== undefined) return existing

    const fetchPromise = this.fetchPageDirect({
      ...(params.search !== undefined ? { search: params.search } : {}),
      ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
      limit,
    }).finally(() => {
      this.inFlightPages.delete(key)
    })
    this.inFlightPages.set(key, fetchPromise)
    const page = await fetchPromise
    this.pageCache.set(key, { page, expiresAt: this.now() + this.ttlMs })
    return page
  }

  private async fetchPageDirect(params: {
    readonly search?: string
    readonly cursor?: string
    readonly limit: number
  }): Promise<ComposioToolkitPage> {
    try {
      const response = await this.client.listToolkits(params)
      return {
        items: response.items,
        nextCursor: response.next_cursor && response.next_cursor.length > 0
          ? response.next_cursor
          : null,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.log(
        `[ownware] composio.catalog-cache: listPage failed — ${message}; returning empty page`,
      )
      return { items: [], nextCursor: null }
    }
  }

  /**
   * Mark the cache stale so the next read serves the last-good list instantly
   * and refreshes in the background. Used by connect / disconnect handlers.
   *
   * Note: a connection lifecycle event changes per-install connection STATUS
   * (re-derived per request in the source mapping), not the global catalogue
   * body cached here — so there's no need to force a blocking cold walk and
   * risk a timeout. We keep the entries and just expire them.
   */
  invalidate(): void {
    if (this.cache !== null) {
      this.cache = { entries: this.cache.entries, expiresAt: 0 }
    }
    this.pageCache.clear()
  }

  private async walkAllPages(): Promise<readonly ComposioToolkitSummary[]> {
    const all: ComposioToolkitSummary[] = []
    let cursor: string | undefined
    let pages = 0
    try {
      while (true) {
        const page = await this.client.listToolkits({
          limit: this.pageSize,
          ...(cursor !== undefined ? { cursor } : {}),
        })
        pages++
        for (const item of page.items) all.push(item)
        const next = page.next_cursor
        if (!next || next.length === 0) break
        cursor = next
        if (pages >= this.maxPages) {
          this.log(
            `[ownware] composio.catalog-cache: reached MAX_PAGES=${this.maxPages}; stopping walk`,
          )
          break
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.log(
        `[ownware] composio.catalog-cache: listToolkits failed after ${pages} pages — ${message}; serving partial list`,
      )
    }
    return all
  }
}
