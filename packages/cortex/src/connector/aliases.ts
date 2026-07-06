/**
 * Connector aliases — the logical-key → canonicalId map.
 *
 * Problem
 * -------
 * The same logical app (e.g. Notion) can exist as multiple connectors
 * across sources. The unified `/api/v1/connectors` view would render
 * two cards for the same product — confusing to the user.
 *
 * Solution
 * --------
 * This module is the single source of truth: a SMALL explicit table
 * grouping canonicalIds that represent the same logical app. Registry
 * de-dup uses it to collapse aliased entries through a pure resolver
 * (`source-resolver.ts`); the client shows ONE card per logical key.
 *
 * Current state (2026-05-06)
 * --------------------------
 * Empty. Composio was dropped from the Tier 1 catalog as part of the
 * connector production rebuild. Without a second source, no logical
 * app has more than one canonicalId, so no aliases are needed.
 *
 * The pre-rebuild table mapped `notion`, `slack`, `github`,
 * `gitlab`, `linear`, `stripe`, `supabase`, `tavily`, `exa`,
 * `firecrawl`, `gmail`, `google-sheets`, `google-drive` between
 * `mcp:` and `composio:` canonicalIds, should the
 * Advanced → BYO-Composio surface revive any of those mappings.
 *
 * Entry rules (when re-populating)
 * --------------------------------
 * - Add an entry only when two sources provably surface the same
 *   product (slug exists in both source catalogs).
 * - The LEFT side ("logical key") is the canonical user-facing name.
 * - The RIGHT side is the list of source-prefixed canonicalIds (see
 *   `schema.ts > makeCanonicalConnectorId`).
 * - A canonicalId MUST NOT appear under more than one logical key
 *   (enforced by unit test; ambiguity would break resolution).
 */

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

/**
 * Logical key → canonicalIds that represent it. Readonly by construction.
 * Order of canonicalIds inside a list is informational only — the resolver
 * has its own deterministic precedence.
 *
 * Empty for v1 — see file header.
 */
export const CONNECTOR_ALIASES: Readonly<Record<string, readonly string[]>> = {}

// ---------------------------------------------------------------------------
// Lookups (pre-computed for O(1) hot-path access)
// ---------------------------------------------------------------------------

/** canonicalId → logicalKey (reverse map). Built at module load. */
const CANONICAL_TO_LOGICAL: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>()
  for (const [logical, canonIds] of Object.entries(CONNECTOR_ALIASES)) {
    for (const cid of canonIds) {
      if (m.has(cid)) {
        throw new Error(
          `CONNECTOR_ALIASES misconfigured: canonicalId '${cid}' appears under ` +
            `both '${m.get(cid)}' and '${logical}'. A canonicalId may belong to ` +
            `exactly one logical key.`,
        )
      }
      m.set(cid, logical)
    }
  }
  return m
})()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * If `canonicalId` is an alias (belongs to some logical key), return the
 * logical key. Otherwise return `null`.
 */
export function getAliasesFor(canonicalId: string): string | null {
  return CANONICAL_TO_LOGICAL.get(canonicalId) ?? null
}

/**
 * Return the canonicalIds that represent the given `logicalKey`. Empty
 * array when the key is unknown.
 */
export function getCanonicalIdsFor(logicalKey: string): readonly string[] {
  return CONNECTOR_ALIASES[logicalKey] ?? []
}

/** True when `logicalKey` is present in the alias table. */
export function isAliasLogicalKey(logicalKey: string): boolean {
  return Object.prototype.hasOwnProperty.call(CONNECTOR_ALIASES, logicalKey)
}

/** Every logical key, in table order. */
export function listAliasLogicalKeys(): readonly string[] {
  return Object.keys(CONNECTOR_ALIASES)
}
