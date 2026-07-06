/**
 * Composio Featured Toolkits — empty for v1.
 *
 * As of 2026-05-06, Composio is dropped from the Tier 1 catalog.
 * Reason: it forces non-tech users to obtain and paste a Composio
 * API key — a UX cliff that no consumer agent product can survive.
 *
 * The pre-cull catalog covered 19 toolkits — Notion, Slack, Gmail,
 * Google Workspace trio, GitHub, GitLab, Jira, Discord, Airtable,
 * Supabase, Tavily/Exa/Firecrawl, Stripe, HubSpot.
 *
 * The TYPES and HELPERS in this file are preserved on purpose: when
 * the Advanced → "Connect Composio account (BYO key)" surface ships,
 * it will repopulate this list and reuse the same module shape — no
 * importer churn. Until then, `FEATURED_COMPOSIO_TOOLKITS` is empty
 * and the rest of the system (sync, source resolver, aliases) sees
 * zero Composio entries on disk.
 *
 * The `source` tag is always `composio` so the client's featured strip
 * can distinguish these from MCP featured entries without string
 * matching.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ComposioFeaturedCategory =
  | 'productivity'
  | 'communication'
  | 'dev-tools'
  | 'data'
  | 'ai'
  | 'finance'
  | 'cloud'
  | 'other'

export interface FeaturedComposioToolkit {
  /** Composio app slug (`notion`, `gmail`, ...). Stable canonical id half. */
  readonly slug: string
  /** Display name used before the live catalogue loads. */
  readonly title: string
  /** One-line description — overwritten by live catalogue when present. */
  readonly description: string
  readonly category: ComposioFeaturedCategory
  /**
   * Source tag — always `composio`. Present so the client can filter the
   * flat featured feed without substring matching on id.
   */
  readonly source: 'composio'
  /**
   * `false` — no live API call has validated this slug yet. `sync.ts`
   * annotates a runtime copy with `verified: true` after reconciling
   * with the live catalogue, but THIS constant stays false so nobody
   * accidentally treats the static list as authoritative.
   */
  readonly verified: false
}

// ---------------------------------------------------------------------------
// The curated list (empty for v1 — see file header)
// ---------------------------------------------------------------------------

export const FEATURED_COMPOSIO_TOOLKITS: readonly FeaturedComposioToolkit[] = []

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the featured toolkits (optionally filtered by category).
 *
 * For v1 this always returns an empty array because Composio is not
 * surfaced in the default catalog. The function exists so the live
 * sync routine and Advanced → BYO-key surface have a stable API to
 * call.
 */
export function getFeaturedComposioToolkits(
  category?: ComposioFeaturedCategory,
): readonly FeaturedComposioToolkit[] {
  if (category === undefined) return FEATURED_COMPOSIO_TOOLKITS
  return FEATURED_COMPOSIO_TOOLKITS.filter(t => t.category === category)
}

/**
 * Lookup by slug. Always returns `undefined` for v1 (empty list).
 */
export function getFeaturedComposioToolkit(
  slug: string,
): FeaturedComposioToolkit | undefined {
  return FEATURED_COMPOSIO_TOOLKITS.find(t => t.slug === slug)
}

/**
 * Returns the set of featured slugs, for O(1) membership checks in
 * `sync.ts` when warning about missing slugs. Empty set for v1.
 */
export function featuredComposioSlugSet(): ReadonlySet<string> {
  return new Set(FEATURED_COMPOSIO_TOOLKITS.map(t => t.slug))
}
