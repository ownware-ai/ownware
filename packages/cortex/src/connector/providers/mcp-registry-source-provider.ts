/**
 * `MCPRegistrySourceProvider` — surface the official MCP server registry
 * (registry.modelcontextprotocol.io, ~5000+ entries) as a `ConnectorSourceProvider`.
 *
 * Phase 6-C.1 (2026-05-07).
 *
 * Opt-in: this provider is registered ONLY when the user enables the
 * MCP registry as a catalog source via Settings → Advanced. When
 * registered, every `connectors(action: 'search')` call sees its
 * entries alongside the curated featured catalog. When the toggle is
 * off (default), the provider isn't constructed at all — zero
 * cost.
 *
 * Architecture-doc anchor:
 *   "MCP Registry (5000+) | local cache | every 24h + boot |
 *    OPT-IN (Settings → Advanced)"
 *
 * ## Identity rules
 *
 * Registry entries surface with `source: 'mcp'` (the wire enum has no
 * `'mcp_registry'` value — same source as featured + custom rows so
 * the agent's renderer doesn't need a new branch). Source-local id is
 * the registry id verbatim (e.g. `io.github.makenotion/notion-mcp-server`).
 * `canonicalId` is `mcp:<id>`; `logicalKey` defers to the standard
 * derivation (which returns `id` as-is for non-auto-suffix mcp rows).
 *
 * Cross-source dedup: today the registry's `dedupeAliases` collapses
 * by `logicalKey` (or alias-table override). Curated `mcp:notion` and
 * registry `mcp:io.github.makenotion/notion-mcp-server` have
 * different logicalKeys, so they BOTH appear in v1. That's
 * acceptable — the user can pick the one they trust. Future work:
 * add an alias table mapping registry ids onto curated logical keys.
 *
 * ## Performance
 *
 * The fetch is cached in-process for 1h (`fetchMCPRegistry`'s
 * cache). Both `listGlobal` and `listForProfile` resolve from the
 * cached array — no per-call network hit after the first warm-up.
 * On startup the first search after enabling the toggle pays the
 * 1-2s registry round-trip; subsequent searches are sub-ms in
 * Map/Array land.
 *
 * Naive substring search at 5000 entries is borderline; the agent
 * tool's `maxItems` cap (default 20) bounds the wire size regardless
 * of catalog growth. SQLite FTS upgrade tracked as Phase 5-A in the
 * board's BUGS.md "Architectural smells" section.
 */

import type { Connector, ConnectorCategory, AuthMode, ConnectorTokenInput } from '../schema.js'
import { makeCanonicalConnectorId } from '../schema.js'
import { deriveLogicalKey } from '../logical-key.js'
import type { ConnectorSourceProvider } from '../registry.js'
import { fetchMCPRegistry } from '../mcp/registry.js'
import type { MCPRegistryEntry, MCPCategory, MCPEnvVar } from '../types.js'

// ---------------------------------------------------------------------------
// Public class
// ---------------------------------------------------------------------------

export interface MCPRegistrySourceProviderOptions {
  /**
   * Override the registry fetch — primarily for tests. Production
   * passes the default `fetchMCPRegistry` import implicitly.
   */
  readonly fetcher?: () => Promise<readonly MCPRegistryEntry[]>
  /**
   * Closure read on every `listGlobal()` call. When it returns
   * `false`, the provider short-circuits to `[]` without invoking
   * the fetcher. Used by the gateway to wire a `Settings → Advanced`
   * toggle in front of the registry: the provider is always present
   * in the unified `ConnectorRegistry`, but it produces nothing
   * unless the user has flipped the toggle on. This pattern (gate
   * inside the provider, not register/unregister at the registry
   * level) means a setting flip takes effect on the very next
   * search — no registry rebuild, no session restart.
   *
   * Default: always-on. Tests use this; production passes a
   * settings-backed closure.
   */
  readonly enabledChecker?: () => boolean
}

export class MCPRegistrySourceProvider implements ConnectorSourceProvider {
  readonly name = 'mcp_registry'
  private readonly fetcher: () => Promise<readonly MCPRegistryEntry[]>
  private readonly enabledChecker: () => boolean

  constructor(opts: MCPRegistrySourceProviderOptions = {}) {
    this.fetcher = opts.fetcher ?? fetchMCPRegistry
    this.enabledChecker = opts.enabledChecker ?? (() => true)
  }

  /**
   * Global catalog view — every entry the registry knows about.
   *
   * Failure mode: if the registry is unreachable (offline boot,
   * upstream outage, AbortSignal timeout in `fetchMCPRegistry`),
   * we return `[]` rather than throw. The unified `ConnectorRegistry`
   * walks every provider's `listGlobal()` in parallel; one provider
   * failing must not brick the catalog. The error is logged once.
   */
  async listGlobal(): Promise<Connector[]> {
    if (!this.enabledChecker()) return []
    let entries: readonly MCPRegistryEntry[]
    try {
      entries = await this.fetcher()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(
        `[connector] MCP registry fetch failed; falling back to empty list: ${msg}`,
      )
      return []
    }
    // Sanitize + dedup at the source provider boundary so the rest
    // of the system sees only entries that have a chance of working.
    //
    // Sanitize: an entry is renderable only if it has SOME launch
    // mechanism (package OR remoteUrl) AND a human-readable title.
    // Registry entries missing both are unspawnable garbage; entries
    // with empty titles render as nameless cards. Either case
    // contributes friction without value, so we filter at the
    // boundary.
    //
    // Dedup: the registry exposes every published version as a
    // separate entry, so a single author's `io.github.user/jira`
    // can return 7 cards (v0.3.1, v0.4.0, v0.4.1, …). The user
    // doesn't want a version selector — they want one card per
    // distinct server. Group by id, keep the row with the latest
    // version (semver-aware string compare; falls back to last-seen
    // for non-semver versions).
    const sane = entries.filter(isRenderable)
    const deduped = dedupByLatestVersion(sane)
    return deduped.map(registryEntryToConnector)
  }

  /**
   * Registry entries are catalog metadata, not profile attachments.
   * Profile-scoped views (Abilities tab, `connectors(list_attached)`)
   * should not surface them — `listForProfile` returns an empty list.
   * The user installs a registry server via the standard Connect flow,
   * which writes an `mcp_servers` row and bridges into
   * `MCPSourceProvider.listForProfile` from there.
   */
  async listForProfile(_profileId: string): Promise<Connector[]> {
    return []
  }
}

// ---------------------------------------------------------------------------
// Mapper
// ---------------------------------------------------------------------------

/**
 * Project a single `MCPRegistryEntry` onto a `Connector`. Pure
 * function. Exposed for tests; not intended for external callers
 * (they should go through `listGlobal`).
 */
/**
 * True when the registry entry has the minimum data needed to
 * render a usable card and stand any chance of spawning. Tries to
 * fail soft — we only filter entries that are obviously garbage.
 *
 * Rules (must ALL hold):
 *  - Title is non-empty (a nameless card is unrenderable).
 *  - At least one launch mechanism: a `package` (npx/uvx target)
 *    OR a `remoteUrl` (hosted MCP). Entries with neither have no
 *    way to be spawned by Loom's MCPClient.
 */
function isRenderable(entry: MCPRegistryEntry): boolean {
  if (entry.title.trim().length === 0) return false
  if (entry.package == null && entry.remoteUrl == null) return false
  return true
}

/**
 * Collapse multiple versions of the same registry id into a single
 * entry — the one with the highest version. Registry IDs follow
 * `<namespace>/<name>` which is stable across versions; the version
 * is on a separate field. Without dedup, a search for "jira"
 * returns 7 copies of `io.github.aaronsb/jira-cloud` (one per
 * published version), polluting the user's chat with redundant
 * cards.
 *
 * Version comparison: uses lexicographic ordering on the version
 * string after stripping a leading `v`. Sufficient for semver
 * patterns like `0.10.0` vs `0.4.3` — but only when the version
 * components are zero-padded numerically (which most semver-style
 * publishers do; the registry's own examples follow this).
 *
 * Hardening note: we DO NOT call `parseSemver` because the
 * registry doesn't strictly enforce semver — some publishers use
 * date-style versions (`2026-04-01`), commit shas, or arbitrary
 * tags. The naive string compare gives a deterministic winner for
 * every shape (latest publish wins for matching prefixes) without
 * pulling in a parser dependency. v2 could swap in a real semver
 * comparator if mixed-shape collisions become a real problem.
 */
function dedupByLatestVersion(
  entries: readonly MCPRegistryEntry[],
): readonly MCPRegistryEntry[] {
  const byId = new Map<string, MCPRegistryEntry>()
  for (const entry of entries) {
    const existing = byId.get(entry.id)
    if (existing == null) {
      byId.set(entry.id, entry)
      continue
    }
    const a = entry.version.replace(/^v/i, '')
    const b = existing.version.replace(/^v/i, '')
    // localeCompare with `numeric: true` handles `0.10.0` > `0.4.3`
    // correctly (lexicographic string compare would say `0.10.0`
    // is LESS than `0.4.3` because `1` < `4` in pure char order).
    const cmp = a.localeCompare(b, undefined, { numeric: true })
    if (cmp > 0) byId.set(entry.id, entry)
  }
  return [...byId.values()]
}

export function registryEntryToConnector(entry: MCPRegistryEntry): Connector {
  const tokenInputs = projectTokenInputs(entry.requiredEnv, entry.optionalEnv)
  const auth = deriveAuthMode(entry.requiredEnv)
  // Available modes: registry entries don't carry an OAuth preset on
  // the wire (presets are a curated-catalog concept), so the only
  // mode the dialog can offer is 'token' when env vars exist. When
  // none exist, this is a zero-auth server (the dialog renders a
  // simple connect-status confirmation rather than a wizard).
  const availableModes: readonly ('token' | 'oauth')[] =
    tokenInputs.length > 0 ? ['token'] : []

  return {
    id: entry.id,
    canonicalId: makeCanonicalConnectorId('mcp', entry.id),
    logicalKey: deriveLogicalKey('mcp', entry.id),
    name: entry.title,
    description: entry.description,
    source: 'mcp',
    category: mcpCategoryToConnectorCategory(entry.category),
    auth,
    status: 'needs_setup',
    toolNames: null,
    iconUrl: entry.icon,
    ...(availableModes.length > 0 ? { availableModes } : {}),
    ...(tokenInputs.length > 0 ? { tokenInputs } : {}),
  }
}

/**
 * Map registry's category enum to the wider `ConnectorCategory`
 * union the UI groups by. Direct pass-through where the names align;
 * `'other'` covers anything outside the current set so a future
 * registry category addition compiles without immediate UI work.
 */
function mcpCategoryToConnectorCategory(c: MCPCategory): ConnectorCategory {
  switch (c) {
    case 'dev-tools':
      return 'dev-tools'
    case 'communication':
      return 'communication'
    case 'data':
      return 'data'
    case 'browser':
      return 'browser'
    case 'productivity':
      return 'productivity'
    case 'ai':
      return 'ai'
    case 'cloud':
      return 'cloud'
    case 'finance':
      return 'finance'
    case 'other':
      return 'other'
  }
}

function deriveAuthMode(requiredEnv: readonly MCPEnvVar[]): AuthMode {
  if (requiredEnv.length === 0) return { mode: 'none' }
  return {
    mode: 'api_key',
    envVars: requiredEnv.map((v) => ({
      name: v.name,
      description: v.description,
      isRequired: v.isRequired,
      isSecret: v.isSecret,
      ...(v.helpUrl !== undefined ? { helpUrl: v.helpUrl } : {}),
    })),
  }
}

/**
 * Build the `tokenInputs` projection — the wire-level surface the
 * Mode B wizard reads. Registry entries don't carry `transform`
 * hints, so the projection is a straight env-var copy. Required
 * inputs come first, then optional; mirrors the ordering rule the
 * legacy CredentialDialog used (so users see the must-fill fields
 * up top regardless of how the upstream registry orders them).
 */
function projectTokenInputs(
  requiredEnv: readonly MCPEnvVar[],
  optionalEnv: readonly MCPEnvVar[],
): readonly ConnectorTokenInput[] {
  const inputs: ConnectorTokenInput[] = []
  for (const v of requiredEnv) {
    inputs.push({
      name: v.name,
      description: v.description,
      isRequired: true,
      isSecret: v.isSecret,
      ...(v.helpUrl !== undefined ? { helpUrl: v.helpUrl } : {}),
    })
  }
  for (const v of optionalEnv) {
    inputs.push({
      name: v.name,
      description: v.description,
      isRequired: false,
      isSecret: v.isSecret,
      ...(v.helpUrl !== undefined ? { helpUrl: v.helpUrl } : {}),
    })
  }
  return inputs
}
