/**
 * Connector Registry
 *
 * Aggregates every tool source in the kernel into a single `Connector[]`
 * view. Today it knows about two sources:
 *
 *   - `builtin`  — every Loom built-in tool becomes a one-tool connector.
 *                  Always `status: 'ready'`, `auth: none`.
 *   - `mcp`      — MCP servers referenced by a profile (or all configured
 *                  servers across known profiles when no profileId is
 *                  given). Status is derived from the per-server credential
 *                  state exactly the way `/profiles/:id/mcp` already does.
 *
 * The registry is shaped as a list of named source providers so Milestone 2
 * (Composio) registers a third provider without touching this file's
 * interface. Consumers call `list()` / `listForProfile(id)`; providers are
 * internal wiring.
 */

import type { Tool } from '@ownware/loom'
import { builtinTools } from '@ownware/loom'
import type {
  AuthMode,
  Connector,
  ConnectorAvailableMode,
  ConnectorCategory,
  ConnectorOAuthPreset,
  ConnectorStatus,
  ConnectorTokenInput,
} from './schema.js'
import { CUSTOM_MCP_REGISTRY_MARKER, DETECTED_REGISTRY_MARKER, makeCanonicalConnectorId } from './schema.js'
import { deriveLogicalKey } from './logical-key.js'
import {
  lookupKnownAppByLogicalKey,
  knownAppCategoryToConnectorCategory,
} from './known-apps.js'

/**
 * Minimal surface of `GatewayState` that the custom-MCP source needs.
 * Declared locally rather than `import type { GatewayState }` from
 * `../gateway/state.js` to avoid a connector → gateway circular
 * import. The gateway layer passes its real `GatewayState` instance;
 * structural typing lets us accept it.
 */
export interface CustomMCPStateReader {
  readonly listMCPServers: (opts?: {
    readonly limit?: number
    readonly offset?: number
  }) => {
    readonly items: ReadonlyArray<{
      readonly id: string
      readonly name: string
      readonly transport: string
      readonly registryId?: string | null
      readonly command?: string | null
      readonly args?: readonly string[] | null
      readonly url?: string | null
      /**
       * Declared env-var NAMES for stdio servers. Keys are names; values
       * are placeholder empty strings at registration time. Real values
       * live in the credential vault. Optional so this interface tolerates
       * pre-migration-026 rows hydrating as `{}`.
       */
      readonly env?: Record<string, string> | null
      /** Declared header NAMES for http/sse servers. Same shape as env. */
      readonly headers?: Record<string, string> | null
    }>
  }
}
import { credentialVault } from './credentials/vault.js'
import { getRegistryEntry } from './mcp/registry.js'
import { getFeaturedServers } from './mcp/featured.js'
import { computeConnectorStatus } from './status.js'
import { pingBridge } from './bridge-catalog.js'
import type { ProfileRegistry } from '../profile/registry.js'
import type { MCPServerConfig as CortexMCPServerConfig } from '../profile/schema.js'
import { getOAuthPreset } from './mcp/oauth-presets.js'
import {
  CONNECTOR_ALIASES,
  getAliasesFor,
  getCanonicalIdsFor,
  isAliasLogicalKey,
} from './aliases.js'
import { resolveSourceForLogicalKey } from './source-resolver.js'
import { SourcePreferences, type SourcePreferencesStore } from './source-preferences.js'

/**
 * Lookup callback that returns the most recent `last_verified_at`
 * timestamp (Unix ms) for a `(connectorId, source)` pair, or `null`
 * when none exists.
 *
 * Threaded into `mcpServerToConnector` / `mcpRowToConnector` so the
 * wire's `lastVerifiedAt` is sourced from `connector_connections`
 * (written by `ComposioReconciler.touchVerified()`). Optional —
 * callers that don't have a connections store bind `() => null` and
 * the wire field is simply omitted.
 *
 * Added 2026-05-17 (F4.c-2, registry plumbing).
 */
export type LastVerifiedAtLookup = (
  connectorId: string,
  source: 'mcp' | 'composio',
) => number | null

const NO_LAST_VERIFIED: LastVerifiedAtLookup = () => null

/**
 * Credential-vault key written by the runtime-setup endpoint after a
 * successful Connect (spawn exits 0, OR user clicks acknowledge for
 * `command: null` connectors). Presence of this key flips the connector's
 * status from `needs_setup` to `ready`. Disconnect / session-expired
 * detection clears it.
 *
 * Stored under the vault key namespace alongside the connector's
 * credentials so the same encryption + lifecycle apply.
 */
export const RUNTIME_SETUP_COMPLETED_KEY = '__cortex_runtime_setup_completed'

// ---------------------------------------------------------------------------
// Source provider interface (internal)
// ---------------------------------------------------------------------------

export interface ConnectorSourceProvider {
  readonly name: string
  /** Return connectors visible globally (no profile context). */
  listGlobal(): Promise<Connector[]>
  /** Return connectors visible in the context of a single profile. */
  listForProfile(profileId: string): Promise<Connector[]>
}

// ---------------------------------------------------------------------------
// Built-in tool source
// ---------------------------------------------------------------------------

function toolCategoryToConnectorCategory(c: Tool['category']): ConnectorCategory {
  switch (c) {
    case 'filesystem': return 'filesystem'
    case 'shell': return 'shell'
    case 'browser': return 'browser'
    case 'search': return 'search'
    case 'agent': return 'agent'
    case 'memory': return 'memory'
    case 'mcp': return 'mcp'
    case 'custom': return 'custom'
    default: return 'other'
  }
}

/**
 * Grouped-builtin metadata per category. Session 1.5a collapses the
 * per-tool BuiltinSourceProvider emission into ONE card per logical
 * capability. The map below is the human-facing description for each
 * category-level card.
 *
 * `id` matches the Loom `Tool.category` value (kebab→snake where needed);
 * `name` is the Title Case display label shown in the client's connector
 * lobby; `description` is a short (<140 char) capability summary.
 *
 * Keys intentionally cover only the categories emitted by `builtinTools`.
 * If Loom adds a new category, we fall back to a synthesized card (see
 * `groupedCardMeta`).
 */
interface BuiltinCategoryMeta {
  readonly name: string
  readonly description: string
}

const BUILTIN_CATEGORY_META: Readonly<Record<string, BuiltinCategoryMeta>> = {
  filesystem: {
    name: 'Filesystem',
    description: 'Read, write, edit, list, glob, and grep files in the workspace.',
  },
  shell: {
    name: 'Shell',
    description: 'Run shell commands in a sandboxed execution environment.',
  },
  browser: {
    name: 'Browser',
    description: 'Navigate pages, click, type, screenshot, and inspect the web.',
  },
  search: {
    name: 'Web Search',
    description: 'Search the web for current information.',
  },
  agent: {
    name: 'Agent',
    description: 'Spawn sub-agents to delegate and parallelise work.',
  },
  memory: {
    name: 'Memory',
    description: 'Store, search, and forget items in the agent knowledge graph.',
  },
  mcp: {
    name: 'MCP Tools',
    description: 'Tools contributed by connected MCP servers.',
  },
  other: {
    name: 'Other',
    description: 'Miscellaneous built-in tools.',
  },
}

function groupedCardMeta(category: ConnectorCategory, tools: readonly Tool[]): BuiltinCategoryMeta {
  const preset = BUILTIN_CATEGORY_META[category]
  if (preset) return preset
  // Fallback for unknown categories — synthesise a minimal card so future
  // Loom additions never land as a broken entry.
  const name = category.charAt(0).toUpperCase() + category.slice(1)
  const first = tools[0]?.description ?? ''
  return { name, description: first }
}

/**
 * Human labels for the `custom`-category Loom builtins that ship as
 * single-tool connector cards. The raw `tool.name` is snake_case and
 * unfit for the lobby (non-technical users see it). If a tool isn't
 * listed here, we fall back to the raw name + description — safe
 * default for any future custom tool added to Loom before this map is
 * updated.
 */
interface CustomBuiltinMeta {
  readonly name: string
  readonly description: string
}

const CUSTOM_BUILTIN_META: Readonly<Record<string, CustomBuiltinMeta>> = {
  ask_user: {
    name: 'Ask You',
    description: 'Pause the agent to ask you a question before continuing.',
  },
  request_credential: {
    name: 'Request Secret',
    description: 'Ask you for a secret the agent can reference by name.',
  },
  image_generate: {
    name: 'Generate Image',
    description: 'Create an image from a text prompt.',
  },
  speech_synthesize: {
    name: 'Speak Aloud',
    description: 'Turn text into spoken audio.',
  },
  speech_transcribe: {
    name: 'Transcribe Audio',
    description: 'Turn spoken audio into text.',
  },
}

/**
 * UI rendering hints for builtin filesystem tools.
 *
 * **C2 → S3 migration:** the hardcoded map is retired. Every Loom
 * builtin now declares its own `uiDescriptor` on the tool definition
 * (board: tool-renderer-registry S2), so `builtinActionEntry` relays
 * `tool.uiDescriptor` directly instead of looking up a table. The
 * legacy `uiHints.fileLine` field is derived from the descriptor's
 * `kind` + `openAction` for backward compatibility while the client
 * finishes its dispatcher migration (S4); both fields ship on the
 * wire until S6 cleanup drops `uiHints` entirely.
 */
function deriveFileLineHintFromDescriptor(
  descriptor: NonNullable<Tool['uiDescriptor']>,
): NonNullable<NonNullable<Connector['actions']>[number]['uiHints']>['fileLine'] | undefined {
  if (descriptor.kind === 'file-write' && descriptor.openAction != null) {
    return { op: 'write', pathField: descriptor.openAction.pathField }
  }
  if (descriptor.kind === 'file-read' && descriptor.openAction != null) {
    return { op: 'read', pathField: descriptor.openAction.pathField }
  }
  if (descriptor.kind === 'file-edit' && descriptor.openAction != null) {
    return { op: 'edit', pathField: descriptor.openAction.pathField }
  }
  return undefined
}

/**
 * Synthesize a `ToolUIDescriptor` for an MCP / Composio action.
 *
 * Unlike builtins (which declare their descriptor on the Loom Tool
 * definition), external sources don't carry render metadata. Cortex
 * infers from the action name using explicit substring patterns —
 * NOT lossy lowercase-strip. The patterns mirror the client's previous
 * `inferFileLineFromName` heuristic but synthesize the FULL descriptor
 * (kind + summary + preview + openAction) instead of just the file-line
 * mini-hint.
 *
 * Every action gets a descriptor — no implicit fallthrough. Unknown
 * shapes default to `kind: 'external-action'` with a humanized verb
 * derived from the action name. The client's generic renderer then drives
 * the chat row.
 */
function synthesizeUiDescriptor(actionName: string): NonNullable<Tool['uiDescriptor']> {
  const lower = actionName.toLowerCase()
  // Strip Loom's MCP prefix and Composio's connector prefix before
  // matching — the inference works on the underlying action verb,
  // not the source's namespacing.
  let bare = lower
  const mcpMatch = bare.match(/^mcp__[a-z0-9-]+__(.+)$/)
  if (mcpMatch != null) bare = mcpMatch[1]!
  else if (bare.startsWith('composio_')) bare = bare.slice('composio_'.length)

  // file-write
  if (/(^|_)(create|write|save|new)_file($|_)/.test(bare) || bare === 'writefile') {
    return {
      kind: 'file-write',
      summary: { verb: 'Wrote', primaryField: 'path' },
      preview: { contentField: 'content', format: 'code', truncateAtLines: 10 },
      openAction: { target: 'file-pane', pathField: 'path' },
    }
  }
  // file-edit
  if (/(^|_)(update|edit|patch|modify)_file($|_)/.test(bare) || bare === 'editfile') {
    return {
      kind: 'file-edit',
      summary: { verb: 'Edited', primaryField: 'path' },
      openAction: { target: 'file-pane', pathField: 'path' },
    }
  }
  // file-read
  if (/(^|_)(read|get|load|fetch)_file($|_)/.test(bare) || bare === 'readfile') {
    return {
      kind: 'file-read',
      summary: { verb: 'Read', primaryField: 'path' },
      preview: { contentField: 'content', format: 'plain', truncateAtLines: 10 },
      openAction: { target: 'file-pane', pathField: 'path' },
    }
  }
  // search-ish
  if (/(^|_)(search|find|query|lookup|grep)($|_)/.test(bare)) {
    return { kind: 'search', summary: { verb: 'Searched' } }
  }
  // image-ish
  if (/(^|_)(screenshot|image|picture|photo)($|_)/.test(bare)) {
    return { kind: 'image', summary: { verb: 'Captured' } }
  }
  // shell-ish
  if (/(^|_)(shell|execute_command|run_command)($|_)/.test(bare)) {
    return {
      kind: 'shell',
      summary: { verb: 'Ran', primaryField: 'command' },
      preview: { contentField: 'output', format: 'plain', truncateAtLines: 10 },
    }
  }

  // Default — explicit declaration that the tool renders as a generic
  // external-action row. The verb is derived from the action name's
  // first segment (e.g. "send_email" → "Sent"). Past-tense is the
  // chat-stream convention.
  const firstSegment = bare.split('_')[0] ?? 'did'
  const verb = firstSegment.charAt(0).toUpperCase() + firstSegment.slice(1)
  return {
    kind: 'external-action',
    summary: { verb },
  }
}

function builtinActionEntry(tool: Tool): NonNullable<Connector['actions']>[number] {
  const descriptor = tool.uiDescriptor
  const legacyFileLine = descriptor != null ? deriveFileLineHintFromDescriptor(descriptor) : undefined
  return {
    name: tool.name,
    description: tool.description,
    isReadOnly: tool.isReadOnly ?? false,
    requiresPermission: tool.requiresPermission ?? false,
    ...(legacyFileLine != null ? { uiHints: { fileLine: legacyFileLine } } : {}),
    ...(descriptor != null ? { uiDescriptor: descriptor } : {}),
  }
}

function singleBuiltinToConnector(tool: Tool): Connector {
  // Degenerate grouping case: one connector per tool. Used for
  // category === 'custom' (ask_user, image_generate, speech_*,
  // request_credential) where each member is a distinct user-facing
  // capability and grouping them would lie to the user.
  const meta = CUSTOM_BUILTIN_META[tool.name]
  return {
    id: tool.name,
    canonicalId: makeCanonicalConnectorId('builtin', tool.name),
    logicalKey: deriveLogicalKey('builtin', tool.name),
    name: meta?.name ?? tool.name,
    description: meta?.description ?? tool.description,
    source: 'builtin',
    category: toolCategoryToConnectorCategory(tool.category),
    auth: { mode: 'none' },
    status: 'ready',
    toolNames: [tool.name],
    actions: [builtinActionEntry(tool)],
  }
}

function groupedBuiltinToConnector(
  category: ConnectorCategory,
  tools: readonly Tool[],
): Connector {
  const meta = groupedCardMeta(category, tools)
  return {
    id: category,
    canonicalId: makeCanonicalConnectorId('builtin', category),
    logicalKey: deriveLogicalKey('builtin', category),
    name: meta.name,
    description: meta.description,
    source: 'builtin',
    category,
    auth: { mode: 'none' },
    status: 'ready',
    toolNames: tools.map(t => t.name),
    actions: tools.map(t => builtinActionEntry(t)),
  }
}

class BuiltinSourceProvider implements ConnectorSourceProvider {
  readonly name = 'builtin'

  constructor(
    private readonly webSearchBuilder?: () => Promise<Connector>,
  ) {}

  async listGlobal(): Promise<Connector[]> {
    // Group Loom builtin tools by `Tool.category` into ONE Connector per
    // logical capability (browser, filesystem, memory, …). The `custom`
    // category is the lone exception: each tool stays its own card
    // because those tools are conceptually distinct.
    //
    // `search` is handled specially: when a web-search builder is
    // supplied the category-level card is replaced by the enriched
    // web-search connector (pluggable providers preserved). When no
    // builder is supplied we fall through to the generic grouping path.
    const byCategory = new Map<ConnectorCategory, Tool[]>()
    for (const tool of builtinTools) {
      const cat = toolCategoryToConnectorCategory(tool.category)
      const existing = byCategory.get(cat)
      if (existing) existing.push(tool)
      else byCategory.set(cat, [tool])
    }

    const out: Connector[] = []
    for (const [category, tools] of byCategory) {
      // Custom stays 1:1.
      if (category === 'custom') {
        for (const t of tools) out.push(singleBuiltinToConnector(t))
        continue
      }
      // Search — delegate to the enriched web-search builder when supplied.
      if (category === 'search' && this.webSearchBuilder) {
        out.push(await this.webSearchBuilder())
        continue
      }
      out.push(groupedBuiltinToConnector(category, tools))
    }
    return out
  }

  async listForProfile(_profileId: string): Promise<Connector[]> {
    return this.listGlobal()
  }
}

// ---------------------------------------------------------------------------
// MCP source
// ---------------------------------------------------------------------------

interface MCPServerSnapshot {
  readonly serverId: string
  readonly name: string
  readonly config: CortexMCPServerConfig
  readonly toolsMetadata?: readonly import('../gateway/types.js').MCPToolMetadata[] | null
}

/**
 * Look up registry + featured metadata for an MCP server id.
 *
 * `getRegistryEntry` hits the remote MCP registry (with a 1h cache).
 * Treat any network failure as "not in registry" so the connector
 * registry stays offline-safe. Featured entries are always local.
 */
async function describeMCPServer(serverId: string): Promise<{
  entry: Awaited<ReturnType<typeof getRegistryEntry>>
  feat: ReturnType<typeof getFeaturedServers>[number] | null
}> {
  let entry: Awaited<ReturnType<typeof getRegistryEntry>> = null
  // `OWNWARE_SKIP_MCP_REGISTRY=1` bypasses the remote registry lookup.
  // Used by tests and air-gapped environments. The featured (local) list
  // still provides curated metadata for well-known servers.
  const skipRemote = process.env['OWNWARE_SKIP_MCP_REGISTRY'] === '1'
  if (!skipRemote) {
    try {
      entry = await getRegistryEntry(serverId)
    } catch {
      entry = null
    }
  }
  // Always look up featured metadata when available. The remote registry
  // entry takes precedence for title/description/env (when present), but
  // the featured entry is still the source of truth for the curated
  // category (remote registry has no category field).
  const feat = getFeaturedServers().find(f => f.id === serverId) ?? null
  return { entry, feat }
}

/**
 * Map a `FeaturedMCPServer.category` value onto the kernel's
 * `ConnectorCategory` enum. Every featured category is already a valid
 * connector category value (union-compatible subset), so this is a direct
 * pass-through — but we keep the function explicit so adding a featured
 * category that doesn't exist in `ConnectorCategory` fails loudly at
 * compile time instead of silently falling through to `'mcp'`.
 */
function featuredCategoryToConnectorCategory(
  c: NonNullable<ReturnType<typeof getFeaturedServers>[number]>['category'],
): ConnectorCategory {
  switch (c) {
    case 'dev-tools': return 'dev-tools'
    case 'data': return 'data'
    case 'communication': return 'communication'
    case 'browser': return 'browser'
    case 'productivity': return 'productivity'
    case 'ai': return 'ai'
    case 'finance': return 'finance'
    case 'research': return 'research'
    case 'social': return 'social'
    case 'design': return 'design'
    case 'media': return 'media'
    case 'security': return 'security'
  }
}

/**
 * Project a loom `OAuthPreset` into the wire-shaped
 * `ConnectorOAuthPreset` the Mode A wizard reads. Sheds the
 * server-side fields (`authorizationUrl`, `tokenUrl`, `tokenToEnv`,
 * `clientId`) because they're only consumed by the gateway during
 * PKCE — exposing them on the wire would tempt clients to do
 * server-side work, and `clientId` is `''` under BYO anyway.
 *
 * Returns `undefined` when no preset exists for this connector, so
 * callers can spread the result conditionally.
 */
function projectOAuthPreset(serverId: string): ConnectorOAuthPreset | undefined {
  const preset = getOAuthPreset(serverId)
  if (preset == null) return undefined
  return {
    registerUrl: preset.registerUrl,
    scopes: preset.scopes,
    ...(preset.requiresSecret === true ? { requiresSecret: true } : {}),
  }
}

/**
 * Project a `MCPEnvVar` (from `connector/types.ts`, includes the
 * optional `transform` hint and `helpUrl`) into a wire-shaped
 * `ConnectorTokenInput`. Preserves every field, sheds nothing — the
 * Mode B wizard relies on `transform` to wrap Notion's integration
 * token into the JSON headers object the Notion MCP server expects.
 *
 * Used by both `mcpServerToConnector` and `mcpRowToConnector` so the
 * BYO Mode B wizard sees consistent inputs across the
 * profile-referenced and unattached-row paths.
 */
function projectTokenInputs(
  envVars: ReadonlyArray<{
    readonly name: string
    readonly description: string
    readonly isRequired: boolean
    readonly isSecret: boolean
    readonly helpUrl?: string
    readonly transform?: 'notion-headers'
  }>,
): ConnectorTokenInput[] {
  return envVars.map((v) => ({
    name: v.name,
    description: v.description,
    isRequired: v.isRequired,
    isSecret: v.isSecret,
    ...(v.helpUrl !== undefined && { helpUrl: v.helpUrl }),
    ...(v.transform !== undefined && { transform: v.transform }),
  }))
}

/**
 * Derive `availableModes` for the unified ConnectDialog (Phase
 * 4-revised-A, 2026-05-06).
 *
 * Derived from raw capabilities, NOT from `auth.mode`. The
 * discriminated `auth.mode` is single-winner — `'oauth'` overrides
 * `'api_key'` whenever a preset exists — but the dialog needs to
 * surface BOTH options when both paths are valid (e.g. GitHub: PAT
 * via env var OR PKCE via preset).
 *
 * - `'token'` whenever the connector declares any required env var.
 * - `'oauth'` whenever an `OAUTH_PRESETS` entry exists for the
 *   connector id.
 *
 * Both can be true simultaneously (GitHub, Notion, Slack). Neither
 * is true for connectors with no env vars and no preset (e.g.
 * Figma's hosted MCP today, custom user-registered stdio servers
 * with empty `env`).
 *
 * Exported so the dialog-mode test suite can exercise every
 * (hasRequiredEnv × hasOAuthPreset) combination without spinning up
 * a full profile registry per case.
 */
export function deriveAvailableModes(
  hasRequiredEnv: boolean,
  hasOAuthPreset: boolean,
): ConnectorAvailableMode[] {
  const modes: ConnectorAvailableMode[] = []
  if (hasRequiredEnv) modes.push('token')
  if (hasOAuthPreset) modes.push('oauth')
  return modes
}

/**
 * Derive required env vars from a profile's MCP config when neither the
 * remote registry nor the featured catalog provides them. The user
 * declared these names at register time (POST /mcp/register) and the
 * attach handler copied them into the profile's mcp config. Each
 * declared name becomes a required, secret-by-default env var so the
 * Connect dialog can render a tight form and `computeConnectorStatus`
 * correctly returns `'needs_setup'` until the vault has values.
 *
 * Stdio reads keys from `config.env`; http/sse from `config.headers`.
 * The MCPServerSchema gives both fields a default of `{}` so we don't
 * need to handle `undefined`.
 *
 * Exported for tests; internal callers go through `mcpServerToConnector`.
 */
export function deriveRequiredFromConfig(
  config: CortexMCPServerConfig,
): ReadonlyArray<{
  readonly name: string
  readonly description: string
  readonly isRequired: boolean
  readonly isSecret: boolean
}> {
  const names =
    config.transport === 'stdio'
      ? Object.keys(config.env ?? {})
      : Object.keys(config.headers ?? {})
  return names.map((n) => ({
    name: n,
    description:
      config.transport === 'stdio'
        ? 'Environment variable required by this server.'
        : 'HTTP header required by this server.',
    isRequired: true,
    // Names alone don't tell us if a value is sensitive; mask by
    // default. Safer to mask a non-secret URL than to leak a token.
    isSecret: true,
  }))
}

async function mcpServerToConnector(
  snap: MCPServerSnapshot,
  lastVerifiedLookup: LastVerifiedAtLookup = NO_LAST_VERIFIED,
): Promise<Connector> {
  const { entry, feat } = await describeMCPServer(snap.serverId)

  const registryOrFeatured = entry?.requiredEnv ?? feat?.requiredEnv ?? []
  const optionalVars = entry?.optionalEnv ?? []

  // Custom-MCP fallback: when neither the remote registry nor the
  // featured catalog knows this server, fall back to env / header
  // names the user declared at registration time (which the attach
  // handler copied into the profile config). Without this branch a
  // custom MCP with `env: { JIRA_API_TOKEN: '' }` would derive
  // auth.mode='none' and status='ready' even with no credentials set.
  const declaredFromConfig: typeof registryOrFeatured =
    registryOrFeatured.length === 0
      ? deriveRequiredFromConfig(snap.config)
      : []

  const requiredVars = registryOrFeatured.length > 0
    ? registryOrFeatured
    : declaredFromConfig

  const allRequired = [...requiredVars]
  const varNames = allRequired.map(v => v.name)
  const envCheck = await credentialVault.checkEnvVars(snap.serverId, varNames)

  // Decide auth mode FIRST — status derivation depends on it. OAuth
  // presets are recognized by id.
  const oauthPreset = getOAuthPreset(snap.serverId)
  let auth: AuthMode
  if (oauthPreset) {
    auth = {
      mode: 'oauth',
      provider: entry?.title ?? feat?.title ?? snap.serverId,
      hasPreset: true,
    }
  } else if (feat?.authType === 'runtime-setup') {
    if (feat.setupHint == null || feat.setupHint.length === 0) {
      throw new Error(
        `featured.ts entry "${feat.id}" declares authType: 'runtime-setup' but has no setupHint`,
      )
    }
    auth = {
      mode: 'runtime_setup',
      hint: feat.setupHint,
      command: feat.setupCommand ?? null,
    }
  } else if (allRequired.length === 0 && optionalVars.length === 0) {
    auth = { mode: 'none' }
  } else {
    auth = {
      mode: 'api_key',
      envVars: [...allRequired, ...optionalVars].map(v => ({
        name: v.name,
        description: v.description,
        isRequired: v.isRequired,
        isSecret: v.isSecret,
        ...(v.helpUrl !== undefined && { helpUrl: v.helpUrl }),
      })),
    }
  }

  // Hydrate the inputs `computeConnectorStatus` needs. The pure-function
  // boundary lives in `connector/status.ts`; everything I/O-shaped (vault
  // reads, bridge ping) happens here, then the decision drops out.
  const oauthBundle = auth.mode === 'oauth' ? await credentialVault.load(snap.serverId) : null
  const oauthBundlePresent =
    oauthBundle != null && Object.values(oauthBundle.env).some(v => v.length > 0)
  const runtimeSetupCheck = auth.mode === 'runtime_setup'
    ? await credentialVault.checkEnvVars(snap.serverId, [RUNTIME_SETUP_COMPLETED_KEY])
    : { [RUNTIME_SETUP_COMPLETED_KEY]: false }
  const runtimeSetupComplete = runtimeSetupCheck[RUNTIME_SETUP_COMPLETED_KEY] === true

  // Bridge reachability — only ping when the transport is actually a
  // bridge. Cached for 60 s so a global lobby load doesn't fire one
  // probe per render. Result is `false` for absent bridges or
  // ECONNREFUSED → status downgrades to needs_setup.
  const bridgeReachable =
    feat?.transport.kind === 'http_bridge'
      ? await pingBridge(feat.transport.bridgeId)
      : undefined

  const status: ConnectorStatus = computeConnectorStatus({
    auth,
    transport: feat?.transport,
    envCheck,
    requiredVars: allRequired,
    oauthBundlePresent,
    runtimeSetupComplete,
    ...(bridgeReachable !== undefined && { bridgeReachable }),
  })

  const actions = snap.toolsMetadata != null
    ? snap.toolsMetadata.map(t => ({
        name: t.name,
        description: t.description,
        isReadOnly: t.annotations?.readOnlyHint,
        requiresPermission: t.annotations?.destructiveHint === true ? true : undefined,
        uiDescriptor: synthesizeUiDescriptor(t.name),
      }))
    : undefined

  // Category resolution precedence: featured catalog > known-apps.json
  // (by logical key) > generic 'mcp' fallback. The known-apps lookup
  // gives auto-detected MCP servers (Figma, Slack, etc.) their proper
  // category (Design, Communication) instead of falling into the
  // technical 'mcp' bucket that surfaces as "Mcp" in the lobby.
  const logicalKey = deriveLogicalKey('mcp', snap.serverId)
  const knownApp = lookupKnownAppByLogicalKey(logicalKey)
  const resolvedCategory: ConnectorCategory = feat
    ? featuredCategoryToConnectorCategory(feat.category)
    : knownApp
      ? knownAppCategoryToConnectorCategory(knownApp.category)
      : 'mcp'

  const availableModes = deriveAvailableModes(allRequired.length > 0, oauthPreset != null)
  const tokenInputs = allRequired.length > 0
    ? projectTokenInputs([...allRequired, ...optionalVars])
    : []
  const oauthPresetWire = projectOAuthPreset(snap.serverId)

  // F4.c-2 plumbing: project `last_verified_at` from
  // `connector_connections` onto the wire. Null → field omitted (most
  // MCP rows never reach the connections store today; the row only
  // exists for connectors with vendor-side accounts written by an OAuth
  // flow or the Composio reconciler).
  const lastVerifiedMs = lastVerifiedLookup(snap.serverId, 'mcp')
  const lastVerifiedAt = lastVerifiedMs != null
    ? new Date(lastVerifiedMs).toISOString()
    : undefined

  return {
    id: snap.serverId,
    canonicalId: makeCanonicalConnectorId('mcp', snap.serverId),
    logicalKey,
    name: entry?.title ?? feat?.title ?? knownApp?.name ?? snap.name,
    description: entry?.description ?? feat?.description ?? 'MCP server',
    source: 'mcp',
    category: resolvedCategory,
    auth,
    status,
    toolNames: snap.toolsMetadata != null ? snap.toolsMetadata.map(t => t.name) : null,
    ...(actions != null ? { actions } : {}),
    // Featured catalog is the only local source of MCP icons today; the
    // remote MCP registry entry has no icon field. Custom/user-installed
    // servers fall through as null and the UI renders a letter tile.
    iconUrl: feat?.icon ?? null,
    ...(lastVerifiedAt !== undefined ? { lastVerifiedAt } : {}),
    ...(availableModes.length > 0 ? { availableModes } : {}),
    ...(feat?.suggestedPrompts != null && feat.suggestedPrompts.length > 0
      ? { suggestedPrompts: feat.suggestedPrompts }
      : {}),
    ...(tokenInputs.length > 0 ? { tokenInputs } : {}),
    ...(oauthPresetWire != null ? { oauthPreset: oauthPresetWire } : {}),
  }
}

class MCPSourceProvider implements ConnectorSourceProvider {
  readonly name = 'mcp'

  /**
   * @param profileRegistry      The profile registry — provides
   *                             `config.tools.mcp` for each profile.
   * @param state                Optional reader for `mcp_servers` DB rows.
   *                             When provided (Milestone B Phase 15),
   *                             unattached user-registered rows surface in
   *                             the global catalog via this provider —
   *                             replaces the removed
   *                             `CustomMCPSourceProvider`. Omit in tests
   *                             that don't need the DB layer.
   * @param lastVerifiedLookup   Optional callback for
   *                             `connector_connections.last_verified_at`
   *                             lookup (F4.c-2). Defaults to "always
   *                             null" so existing tests + callers without
   *                             a connections store keep working — the
   *                             wire's `lastVerifiedAt` is simply omitted.
   */
  constructor(
    private readonly profileRegistry: ProfileRegistry,
    private readonly state?: CustomMCPStateReader,
    private readonly lastVerifiedLookup: LastVerifiedAtLookup = NO_LAST_VERIFIED,
  ) {}

  async listGlobal(): Promise<Connector[]> {
    // Global view: UNION of
    //   (a) MCP servers referenced by some profile's `profile.config.tools.mcp`
    //       — real installs, status derives from credential presence.
    //   (b) DB-stored user-registered / detected mcp_servers rows
    //       (`registry_id IN ('custom','detected')`). Replaces the
    //       former CustomMCPSourceProvider (Phase 15, 2026-05-01).
    //   (c) Featured curated servers from `getFeaturedServers()` (which
    //       includes dynamic bridge entries since Phase 9) — shown with
    //       status='needs_setup' unless a profile already installed them.
    //
    // Policy: dedup by serverId. Precedence:
    //   profile-referenced > DB row > featured catalog
    // The profile snapshot holds the live install config; DB rows hold
    // the registered install; featured-only entries are catalog metadata.
    const seen = new Map<string, MCPServerSnapshot>()
    const dbRowById = new Map<string, MCPServerRow>()

    // (a) profile-referenced
    for (const p of this.profileRegistry.list()) {
      let profile
      try {
        profile = await this.profileRegistry.get(p.name)
      } catch {
        continue
      }
      for (const [serverId, config] of Object.entries(profile.config.tools.mcp)) {
        if (!seen.has(serverId)) {
          seen.set(serverId, { serverId, name: serverId, config })
        }
      }
    }

    // (b) user-registered / detected DB rows (was CustomMCPSourceProvider)
    if (this.state) {
      const { items } = this.state.listMCPServers({ limit: 200 })
      for (const row of items) {
        if (
          row.registryId !== CUSTOM_MCP_REGISTRY_MARKER &&
          row.registryId !== DETECTED_REGISTRY_MARKER
        ) {
          continue
        }
        dbRowById.set(row.id, row)
        if (seen.has(row.id)) continue
        // Synthesize a minimal MCPServerSnapshot so mcpServerToConnector
        // doesn't crash; the real metadata flows through `mcpRowToConnector`
        // for unattached DB rows below.
        seen.set(row.id, {
          serverId: row.id,
          name: row.name,
          config: { transport: 'stdio', args: [], env: {}, headers: {} },
        })
      }
    }

    // (c) featured catalog (static + bridges via the in-memory cache)
    for (const feat of getFeaturedServers()) {
      if (seen.has(feat.id)) continue
      seen.set(feat.id, {
        serverId: feat.id,
        name: feat.title,
        config: { transport: 'stdio', args: [], env: {}, headers: {} },
      })
    }

    // Resolve each entry. Unattached DB rows route to mcpRowToConnector
    // which preserves the known-apps category enrichment that the old
    // CustomMCPSourceProvider provided. Profile-referenced and featured
    // entries route to the standard mcpServerToConnector.
    return Promise.all(
      [...seen.values()].map(async snap => {
        const dbRow = dbRowById.get(snap.serverId)
        const isProfileAttached = await this.isAttachedToAnyProfile(snap.serverId)
        if (dbRow && !isProfileAttached) {
          return mcpRowToConnector(dbRow, this.lastVerifiedLookup)
        }
        return mcpServerToConnector(snap, this.lastVerifiedLookup)
      }),
    )
  }

  /**
   * Cheap check used to choose between `mcpServerToConnector` (profile
   * snapshot is authoritative) and `mcpRowToConnector` (DB row is
   * authoritative). Returns `true` if any profile references this id.
   * Profile reads are cached by `ProfileRegistry`, so this is fast.
   */
  private async isAttachedToAnyProfile(serverId: string): Promise<boolean> {
    for (const p of this.profileRegistry.list()) {
      try {
        const profile = await this.profileRegistry.get(p.name)
        if (Object.prototype.hasOwnProperty.call(profile.config.tools.mcp, serverId)) {
          return true
        }
      } catch {
        // continue
      }
    }
    return false
  }

  async listForProfile(profileId: string): Promise<Connector[]> {
    if (!this.profileRegistry.has(profileId)) return []
    let profile
    try {
      profile = await this.profileRegistry.get(profileId)
    } catch {
      return []
    }
    const entries = Object.entries(profile.config.tools.mcp).map(
      ([serverId, config]): MCPServerSnapshot => ({ serverId, name: serverId, config }),
    )
    return Promise.all(entries.map(snap => mcpServerToConnector(snap, this.lastVerifiedLookup)))
  }
}

/**
 * Type alias for `mcp_servers` rows the MCPSourceProvider reads. Same
 * shape as the row argument to `mcpRowToConnector`.
 */
type MCPServerRow = ReturnType<CustomMCPStateReader['listMCPServers']>['items'][number]

// ---------------------------------------------------------------------------
// DB-row mapper (was CustomMCPSourceProvider — collapsed into
// MCPSourceProvider in Phase 15, 2026-05-01)
// ---------------------------------------------------------------------------

/**
 * Map a `mcp_servers` row to a `Connector`. Used by `MCPSourceProvider`
 * when a row is unattached to any profile (so the profile snapshot can't
 * carry the live config).
 *
 * Pre-Phase-15 history: this was named `customRowToConnector` and lived
 * inside `CustomMCPSourceProvider`, emitting `source: 'custom_mcp'`. The
 * provider was deleted; this mapper now emits `source: 'mcp'` to unify
 * with the rest of the catalog.
 */
export async function mcpRowToConnector(row: {
  readonly id: string
  readonly name: string
  readonly transport: string
  readonly registryId?: string | null
  readonly env?: Record<string, string> | null
  readonly headers?: Record<string, string> | null
  readonly toolsMetadata?: readonly import('../gateway/types.js').MCPToolMetadata[] | null
  readonly toolCount?: number | null
}, lastVerifiedLookup: LastVerifiedAtLookup = NO_LAST_VERIFIED): Promise<Connector> {
  const actions = row.toolsMetadata != null
    ? row.toolsMetadata.map(t => ({
        name: t.name,
        description: t.description,
        isReadOnly: t.annotations?.readOnlyHint,
        requiresPermission: t.annotations?.destructiveHint === true ? true : undefined,
        uiDescriptor: synthesizeUiDescriptor(t.name),
      }))
    : undefined

  // Resolve metadata: featured catalog > known-apps.json > raw row defaults.
  // The known-apps lookup is the key piece — without it, auto-detected
  // and user-registered apps for Figma/Slack/Notion/etc. fall into the
  // generic 'custom' category which surfaces as "Custom" in the lobby.
  // With it, Figma lands in 'design', Slack in 'communication', etc.
  const feat = getFeaturedServers().find(f => f.id === row.id)
  // Phase 15 (2026-05-01): logical key now resolves under 'mcp' source —
  // the unified label. Pre-Phase-15 used 'custom_mcp' which is gone.
  const logicalKey = deriveLogicalKey('mcp', row.id)
  const knownApp = lookupKnownAppByLogicalKey(logicalKey)
  let auth: AuthMode = { mode: 'none' }
  let category: ConnectorCategory = 'custom'
  let description = `Custom MCP server (${row.transport}).`
  let name = row.name

  if (feat) {
    name = feat.title
    description = feat.description
    category = featuredCategoryToConnectorCategory(feat.category)
    if (feat.requiredEnv.length > 0) {
      auth = {
        mode: 'api_key',
        envVars: feat.requiredEnv.map(v => ({
          name: v.name,
          description: v.description,
          isRequired: v.isRequired,
          isSecret: v.isSecret,
          ...(v.helpUrl !== undefined && { helpUrl: v.helpUrl }),
        })),
      }
    }
  } else if (knownApp) {
    // Known-apps.json data wins over raw row.name (which may be the
    // ugly auto-id like "figma-c4vrjq3w" if registration didn't supply
    // a friendly name). Category gets a real value instead of 'custom'.
    name = knownApp.name
    category = knownAppCategoryToConnectorCategory(knownApp.category)
    description = `${knownApp.name} (${row.transport}).`
  }

  // Fallback for user-registered customs with no featured/known-app match:
  // the user told us at register time which env / header NAMES the server
  // needs. Treat each as a required api-key input. Without this branch
  // auth stays `none` → `computeConnectorStatus` returns `'ready'` and
  // the card lies that no credentials are needed. Phase 16-bis fix.
  if (auth.mode === 'none') {
    const declaredNames =
      row.transport === 'stdio'
        ? Object.keys(row.env ?? {})
        : Object.keys(row.headers ?? {})
    if (declaredNames.length > 0) {
      auth = {
        mode: 'api_key',
        envVars: declaredNames.map(n => ({
          name: n,
          description: row.transport === 'stdio'
            ? `Environment variable required by ${name}.`
            : `HTTP header required by ${name}.`,
          isRequired: true,
          // Names alone don't tell us if a value is sensitive, but the
          // safe default is to mask. Users can paste a non-secret URL
          // into a masked field without harm; the inverse (showing a
          // real token) is a real leak.
          isSecret: true,
        })),
      }
    }
  }

  const isDetected = row.registryId === DETECTED_REGISTRY_MARKER
  if (isDetected && !feat && !knownApp) {
    description = `Detected ${row.transport} server.`
  }

  // Derive Connect-dialog capabilities. The unattached-row path's
  // local `auth` is `none` or `api_key` (never `'oauth'`), but the
  // connector itself may still have an OAuth path available — the
  // dialog needs to know that. We derive directly from the featured
  // entry's requiredEnv plus the raw preset lookup, so `'oauth'`
  // surfaces here just as it does on the connected-server path.
  const availableModes = deriveAvailableModes(
    (feat?.requiredEnv.length ?? 0) > 0,
    getOAuthPreset(row.id) != null,
  )
  // FeaturedMCPServer has no `optionalEnv` field — only `requiredEnv`.
  // Optional env vars enter the wizard only on the registry-entry
  // path (mcpServerToConnector), where they come from the live
  // registry response.
  const tokenInputs = feat != null && feat.requiredEnv.length > 0
    ? projectTokenInputs(feat.requiredEnv)
    : []
  const oauthPresetWire = projectOAuthPreset(row.id)

  // Status: compute from the real vault state via the pure decision in
  // status.ts. For 'none' (which actually means "no declared env or
  // header names anywhere") we keep the historical behaviour of leaving
  // unattached rows as needs_setup — the user still hasn't attached this
  // connector to a profile, so it shouldn't read as fully Ready yet.
  // The earlier `auth.mode === 'none' ? 'needs_setup' : 'needs_setup'`
  // tautology hid the real decision; now it's explicit.
  let status: ConnectorStatus = 'needs_setup'
  if (auth.mode === 'api_key') {
    const requiredNames = auth.envVars
      .filter(v => v.isRequired)
      .map(v => v.name)
    const envCheck = await credentialVault.checkEnvVars(row.id, requiredNames)
    status = computeConnectorStatus({
      auth,
      envCheck,
      requiredVars: auth.envVars.map(v => ({
        name: v.name,
        isRequired: v.isRequired,
      })),
      oauthBundlePresent: false,
      runtimeSetupComplete: false,
    })
  }

  // F4.c-2 plumbing: project `last_verified_at` from
  // `connector_connections` onto the wire. Null → field omitted.
  const lastVerifiedMs = lastVerifiedLookup(row.id, 'mcp')
  const lastVerifiedAt = lastVerifiedMs != null
    ? new Date(lastVerifiedMs).toISOString()
    : undefined

  return {
    id: row.id,
    canonicalId: makeCanonicalConnectorId('mcp', row.id),
    logicalKey,
    name,
    description,
    source: 'mcp',
    category,
    auth,
    status,
    toolNames: row.toolsMetadata != null ? row.toolsMetadata.map(t => t.name) : null,
    ...(actions != null ? { actions } : {}),
    iconUrl: feat?.icon ?? null,
    ...(lastVerifiedAt !== undefined ? { lastVerifiedAt } : {}),
    ...(availableModes.length > 0 ? { availableModes } : {}),
    ...(feat?.suggestedPrompts != null && feat.suggestedPrompts.length > 0
      ? { suggestedPrompts: feat.suggestedPrompts }
      : {}),
    ...(tokenInputs.length > 0 ? { tokenInputs } : {}),
    ...(oauthPresetWire != null ? { oauthPreset: oauthPresetWire } : {}),
  }
}

// ---------------------------------------------------------------------------
// ConnectorRegistry
// ---------------------------------------------------------------------------

export interface ConnectorRegistryOptions {
  /** Optional builder for the enriched `web_search` connector. */
  readonly webSearchBuilder?: () => Promise<Connector>
  /**
   * Persistence-backed source preference store (Phase 2b.2b). When
   * omitted, the registry resolves aliased connectors using the pure
   * resolver's precedence (MCP > Composio > any-ready > cold-start
   * Composio). User overrides require a store.
   */
  readonly sourcePreferences?: SourcePreferences
  /**
   * Optional reader for the `mcp_servers` table. When provided, the
   * registry adds a `CustomMCPSourceProvider` so API-registered
   * custom MCP servers (T04 — `POST /api/v1/mcp/register`) appear in
   * the global catalog with `source: 'custom_mcp'`. Omit in tests or
   * pre-T04 callers that don't expose a state layer.
   */
  readonly customMCPState?: CustomMCPStateReader
  /**
   * F4.c-2 — callback that returns the most recent
   * `connector_connections.last_verified_at` (Unix ms) for a given
   * `(connectorId, source)` pair, or `null` when none exists. Used by
   * `mcpServerToConnector` / `mcpRowToConnector` to project
   * `lastVerifiedAt` onto the wire `Connector`. Omit when the caller
   * has no connections store (tests, pre-Phase-2a code paths) — the
   * wire field is simply absent.
   */
  readonly lastVerifiedAtLookup?: LastVerifiedAtLookup
}

export class ConnectorRegistry {
  private readonly providers: ConnectorSourceProvider[]
  private readonly sourcePreferences: SourcePreferences | null

  constructor(profileRegistry: ProfileRegistry, opts: ConnectorRegistryOptions = {}) {
    // Phase 15 (2026-05-01): MCPSourceProvider absorbed CustomMCPSourceProvider.
    // Pass `customMCPState` through so unattached user-registered DB rows
    // surface in the unified `mcp` source. The legacy provider is gone.
    this.providers = [
      new BuiltinSourceProvider(opts.webSearchBuilder),
      new MCPSourceProvider(
        profileRegistry,
        opts.customMCPState,
        opts.lastVerifiedAtLookup,
      ),
    ]
    this.sourcePreferences = opts.sourcePreferences ?? null
  }

  /** Register an additional source. Exposed for future milestones (Composio). */
  addSource(source: ConnectorSourceProvider): void {
    this.providers.push(source)
  }

  /**
   * Public list. Aggregates every source and collapses aliased
   * connectors (e.g. `mcp:notion` + `composio:notion`) down to ONE
   * winning connector per logical key via `resolveSourceForLogicalKey`.
   * Non-aliased connectors pass through unchanged.
   */
  async list(): Promise<Connector[]> {
    const buckets = await Promise.all(this.providers.map(p => p.listGlobal()))
    return this.dedupeAliases(buckets.flat())
  }

  /** Profile-scoped list — same alias collapse as `list()`. */
  async listForProfile(profileId: string): Promise<Connector[]> {
    const buckets = await Promise.all(
      this.providers.map(p => p.listForProfile(profileId)),
    )
    return this.dedupeAliases(buckets.flat())
  }

  /**
   * Legacy source-local lookup: returns the first connector whose
   * source-local `id` matches. Unchanged from M1 callers.
   */
  async get(id: string): Promise<Connector | null> {
    const all = await this.list()
    return all.find(c => c.id === id) ?? null
  }

  /**
   * Look up a specific source variant by canonicalId, bypassing alias
   * de-dup. Used by the alias-source PATCH handler to resolve the
   * target candidate.
   */
  async getByCanonicalId(canonicalId: string): Promise<Connector | null> {
    const buckets = await Promise.all(this.providers.map(p => p.listGlobal()))
    const flat = buckets.flat()
    return flat.find(c => c.canonicalId === canonicalId) ?? null
  }

  /**
   * Diagnostic: return every source variant for a logical key, pre-resolver.
   * Empty array when the key is not aliased or no source supplies it.
   */
  async listAllForLogicalKey(logicalKey: string): Promise<readonly Connector[]> {
    if (!isAliasLogicalKey(logicalKey)) return []
    const canonIds = new Set(getCanonicalIdsFor(logicalKey))
    const buckets = await Promise.all(this.providers.map(p => p.listGlobal()))
    return buckets.flat().filter(c => canonIds.has(c.canonicalId))
  }

  /**
   * Re-read sources that cache. Today MCP queries run fresh per call so
   * this is a no-op; kept on the interface so Milestone 2 providers
   * (Composio, which will cache its marketplace fetch) have a hook.
   */
  async refresh(): Promise<void> {
    /* intentional no-op — providers are stateless today */
  }

  // -------------------------------------------------------------------------
  // Logical-key + alias de-duplication
  // -------------------------------------------------------------------------

  /**
   * Collapse connectors that represent the same logical app down to one
   * winner per logical key.
   *
   * Two layers of grouping:
   *
   * 1. **`logicalKey` (universal):** Every Connector carries a `logicalKey`
   *    derived per-source via `connector/logical-key.ts`. Connectors sharing
   *    a logicalKey across sources (e.g. `mcp:figma`, `custom_mcp:figma-c4vrjq3w`,
   *    `composio:figma`) belong to the same group and resolve to one winner.
   *    This is the universal dedup that closes the "three Figma cards" bug.
   *
   * 2. **`CONNECTOR_ALIASES` (override):** When two sources use DIFFERENT
   *    slugs for the same product (e.g. hypothetically Composio's
   *    `google_sheets` vs MCP's `gsheets`), the alias table rewrites the
   *    grouping key. Today every alias entry happens to share the slug so
   *    the override is a no-op, but the override preserves the future case.
   *
   * Group order: first the unaliased single-entry groups in original flat
   * order (preserves caller's source ordering for non-grouped entries);
   * then alias-table-order for explicit alias groups; then any logicalKey
   * groups not in the alias table (custom_mcp/mcp dedup) in first-seen
   * order.
   */
  private dedupeAliases(flat: readonly Connector[]): Connector[] {
    // Group every connector by its effective grouping key.
    //
    // Precedence: alias-override > builtin-scoped key > plain logicalKey.
    //
    // The builtin-scoped key is a deliberate exception. `builtin:filesystem`
    // (Loom-native grouped capability) and `mcp:filesystem` (a distinct MCP
    // server that happens to share the slug) are NOT the same product.
    // Per `aliases.ts:58-64` they must stay distinct in the lobby. Without
    // this exception the universal `logicalKey` collapse would (incorrectly)
    // pick one and hide the other. Same logic applies to `builtin:memory`
    // vs a hypothetical `mcp:memory` server.
    const groups = new Map<string, Connector[]>()
    for (const c of flat) {
      const aliasOverride = getAliasesFor(c.canonicalId)
      const key = aliasOverride
        ?? (c.source === 'builtin' ? `__builtin__:${c.logicalKey}` : c.logicalKey)
      const existing = groups.get(key)
      if (existing) existing.push(c)
      else groups.set(key, [c])
    }

    // Resolve each group. Single-entry groups pass through unchanged.
    // Multi-entry groups go through the source resolver.
    const resolved = new Map<string, Connector>()
    for (const [key, candidates] of groups) {
      if (candidates.length === 1) {
        resolved.set(key, candidates[0]!)
        continue
      }
      const userChoice = this.sourcePreferences?.get(key) ?? null
      const winner = resolveSourceForLogicalKey(key, candidates, userChoice)
      // Defensive: resolver should always return one of the candidates,
      // but if it returns null fall back to the first to avoid silent
      // dropping of every variant.
      resolved.set(key, winner ?? candidates[0]!)
    }

    // Output order: alias-table-order for alias groups (compat with prior
    // behaviour and the registry-alias-dedup tests), then any remaining
    // groups in insertion order (preserves source order for non-aliased
    // entries).
    const out: Connector[] = []
    const emitted = new Set<string>()
    for (const aliasKey of Object.keys(CONNECTOR_ALIASES)) {
      const w = resolved.get(aliasKey)
      if (w) {
        out.push(w)
        emitted.add(aliasKey)
      }
    }
    for (const [key, w] of resolved) {
      if (!emitted.has(key)) out.push(w)
    }
    return out
  }
}

// Re-export for convenience so consumers that already import from
// registry.js can pick up the alias-store contract too.
export type { SourcePreferencesStore }
