/**
 * Pure source resolver for aliased connectors.
 *
 * A logical app (e.g. Notion) can be offered by multiple sources: an MCP
 * server AND a Composio catalog entry. `resolveSourceForLogicalKey`
 * picks ONE winner from the candidate set using the precedence below.
 *
 * Precedence
 * ----------
 *   1. User's persisted choice, if a candidate with that `source` exists
 *      AND its status is neither `error` nor `auth_error`. Both are
 *      terminal-broken in the post-F4.c-1 taxonomy — the user never ends
 *      up with a known-broken connector. `stale` (transient probe miss)
 *      and `needs_setup` (explicit) still honour the user's choice.
 *   2. Composio candidate whose status is `ready`.
 *   3. MCP candidate whose status is `ready`.
 *   4. Any candidate whose status is `ready` (deterministic source
 *      order: see `SOURCE_DETERMINISTIC_ORDER`).
 *   5. No candidate is `ready` — cold start. Fall back to the first
 *      candidate in deterministic source order (Composio before MCP).
 *   6. Empty input → `null`.
 *
 * Composio-first default (2026-05-25): the BYO Composio key in
 * Settings → Advanced is an explicit, deliberate paste — the inference
 * is "the user wants Composio's hosted coverage." Pre-2026-05-25 the
 * default was MCP-first because Composio was env-var-opt-in; that
 * inference is no longer accurate. Non-aliased connectors are
 * unaffected (the resolver only runs on alias groups via
 * `ConnectorRegistry.dedupeAliases`), so a niche MCP server for an app
 * Composio doesn't cover still wins by being the only candidate.
 *
 * Principle-5 caveat: Composio actions execute on Composio's cloud,
 * not the user's machine. The client surfaces this via the per-card source
 * badge — pick the right tradeoff for the user, don't hide which side
 * they're on.
 *
 * No I/O. Takes a snapshot, returns a decision. Trivially unit-testable.
 */

import type { Connector, ConnectorSource } from './schema.js'

/**
 * Deterministic tie-break order. Used by rank 4 and rank 5.
 *
 * Composio first because a configured Composio key is a deliberate
 * Settings → Advanced act — the inference "user wants Composio" beats
 * the older "MCP is more battle-tested" framing now that Composio's
 * managed-auth coverage outpaces the curated MCP set for most apps.
 * MCP second. `builtin` rounds out the list; unlikely to appear in an
 * alias group today but the enumeration makes the ordering total and
 * explicit.
 *
 * `'custom_mcp'` removed 2026-05-01 (Milestone B Phase 17) — user-
 * registered MCP rows flow through the unified `mcp` source label.
 */
export const SOURCE_DETERMINISTIC_ORDER: readonly ConnectorSource[] = [
  'composio',
  'mcp',
  'builtin',
]

/** Comparator that sorts candidates by `SOURCE_DETERMINISTIC_ORDER`. */
function bySourceOrder(a: Connector, b: Connector): number {
  const ia = SOURCE_DETERMINISTIC_ORDER.indexOf(a.source)
  const ib = SOURCE_DETERMINISTIC_ORDER.indexOf(b.source)
  // Unknown sources sort after known ones, alphabetically amongst themselves.
  const la = ia === -1 ? SOURCE_DETERMINISTIC_ORDER.length : ia
  const lb = ib === -1 ? SOURCE_DETERMINISTIC_ORDER.length : ib
  if (la !== lb) return la - lb
  return a.source.localeCompare(b.source)
}

/**
 * Resolve the single "winning" connector for a logical key given the
 * set of candidates and the user's persisted source preference.
 *
 * @param logicalKey   user-facing logical key (e.g. `notion`). Informational.
 * @param candidates   connectors mapped to `logicalKey` (all sources).
 * @param userChoice   user's saved preference (`'mcp'`, `'composio'`, …),
 *                     or undefined when no preference stored.
 */
export function resolveSourceForLogicalKey(
  logicalKey: string,
  candidates: readonly Connector[],
  userChoice?: string | null,
): Connector | null {
  void logicalKey // retained for symmetry + future telemetry; behaviour depends only on candidates + userChoice
  if (candidates.length === 0) return null

  // Deterministic working copy.
  const sorted = [...candidates].sort(bySourceOrder)

  // 1. User choice.
  //
  // Post-taxonomy semantics (F4.c-2, 2026-05-17): `'auth_error'` is a
  // terminal-broken status in the same family as `'error'` — the user
  // must reauthorize before the connector is usable again. Both have
  // to fall through so we can serve a `'ready'` alternative if one
  // exists. `'stale'` is in-flight uncertain and `'needs_setup'` is
  // explicit — neither qualifies as "known broken," so we honour the
  // user's choice even with those statuses (matches pre-extension
  // behaviour where `'needs_setup'` was already allowed through).
  if (userChoice && userChoice.length > 0) {
    const chosen = sorted.find(
      c => c.source === userChoice && c.status !== 'error' && c.status !== 'auth_error',
    )
    if (chosen) return chosen
    // Fall through — choice unusable.
  }

  // 2. Composio ready.
  const composioReady = sorted.find(c => c.source === 'composio' && c.status === 'ready')
  if (composioReady) return composioReady

  // 3. MCP ready.
  const mcpReady = sorted.find(c => c.source === 'mcp' && c.status === 'ready')
  if (mcpReady) return mcpReady

  // 4. Any ready, deterministic source order.
  const anyReady = sorted.find(c => c.status === 'ready')
  if (anyReady) return anyReady

  // 5. Cold start: first in deterministic order (Composio before MCP).
  return sorted[0] ?? null
}
