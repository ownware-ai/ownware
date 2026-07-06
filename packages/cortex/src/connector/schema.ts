/**
 * Connector — unified tool-source abstraction.
 *
 * A Connector represents any source of tools available to an agent:
 * built-in Loom tools, MCP servers, Composio (future), and custom user-
 * installed sources (future). Every connector exposes the same readiness
 * contract and the same not-ready error shape so UI clients, the assembler,
 * and the agent loop can handle them uniformly.
 *
 * This file is the public contract: TypeScript types + Zod schemas for
 * everything that crosses the gateway or an agent-loop boundary.
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// Source — which subsystem surfaces this connector
// ---------------------------------------------------------------------------

/**
 * Tool sources known to the kernel. `builtin`, `mcp`, and `composio`.
 *
 * The previous `'custom_mcp'` value was removed 2026-05-01 (Milestone B
 * Phase 16 — connector architecture unification). User-registered MCP
 * servers now flow through the unified `'mcp'` source label; the
 * "user-added vs shipped" distinction is carried elsewhere if needed.
 */
export const ConnectorSourceSchema = z.enum(['builtin', 'mcp', 'composio'])
export type ConnectorSource = z.infer<typeof ConnectorSourceSchema>

// ---------------------------------------------------------------------------
// Auth mode — discriminated on `mode`
// ---------------------------------------------------------------------------

export const AuthModeNoneSchema = z.object({
  mode: z.literal('none'),
})

export const AuthModeApiKeySchema = z.object({
  mode: z.literal('api_key'),
  /** Ordered list of environment variable names the user must provide. */
  envVars: z.array(z.object({
    name: z.string().min(1),
    description: z.string(),
    isRequired: z.boolean(),
    isSecret: z.boolean(),
    helpUrl: z.string().url().optional(),
  })),
})

export const AuthModeOAuthSchema = z.object({
  mode: z.literal('oauth'),
  /** Human-readable provider name (e.g. "Notion", "GitHub"). */
  provider: z.string().min(1),
  /** Whether an OAuth preset exists for this provider. */
  hasPreset: z.boolean(),
})

/**
 * Runtime-setup connectors need a one-time non-credential action at Connect
 * time — browser login (LinkedIn), plugin install (Obsidian), config edit,
 * model download, etc. Distinct from `none` (works immediately) and from
 * credential-based auth modes.
 */
export const AuthModeRuntimeSetupSchema = z.object({
  mode: z.literal('runtime_setup'),
  /** Human-readable hint shown in the dialog ("A LinkedIn sign-in window will open..."). */
  hint: z.string().min(1),
  /**
   * Argv Cortex spawns at Connect time. `null` = manual setup (user does
   * it in another app; the Connect button is an acknowledgment that flips
   * status without spawning anything). Non-null = run this and wait for
   * exit 0.
   */
  command: z.array(z.string()).readonly().nullable(),
})

export const AuthModeSchema = z.discriminatedUnion('mode', [
  AuthModeNoneSchema,
  AuthModeApiKeySchema,
  AuthModeOAuthSchema,
  AuthModeRuntimeSetupSchema,
])
export type AuthMode = z.infer<typeof AuthModeSchema>

// ---------------------------------------------------------------------------
// Transport — discriminated union (internal contract)
// ---------------------------------------------------------------------------

/**
 * Cross-package canonical shape for "how to reach an MCP server."
 *
 * Mirrors `FeaturedTransport` from `connector/mcp/featured.ts` as a Zod
 * schema so other surfaces (gateway, registry, future wire payloads) can
 * validate or echo the shape without importing the featured module.
 *
 * NOT part of the wire `ConnectorSchema` today — builtins have no MCP
 * transport, and no client-side consumer reads it. Exposed here so internal
 * helpers (`computeConnectorStatus`, `buildMCPClientConfig`) share one
 * type. Wire-exposure is a strictly additive future change.
 *
 * Added 2026-04-30 (Milestone A — connector architecture unification).
 */
export const ConnectorTransportSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('stdio'),
    runtime: z.enum(['npx', 'uvx']),
    package: z.string().min(1),
    args: z.array(z.string()).readonly().optional(),
  }),
  z.object({
    kind: z.literal('http_remote'),
    url: z.string().url(),
  }),
  z.object({
    kind: z.literal('http_bridge'),
    bridgeId: z.string().min(1),
  }),
])
export type ConnectorTransport = z.infer<typeof ConnectorTransportSchema>

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * Unified connector readiness.
 *
 * - `ready` — connector is configured and usable right now.
 * - `stale` — connector was ready, but the most recent reachability /
 *   reconciliation signal failed. Distinct from `error`: this is a
 *   transient or unconfirmed loss (wedged MCP transport, an inflight
 *   reconcile that hasn't yet completed). UI shows "Reconnecting…" and
 *   the connector continues to retry automatically; no explicit user
 *   action is required.
 * - `needs_setup` — connector exists but requires credentials/OAuth before
 *   its tools can be called. The assembler injects a stub for tools from
 *   this connector so the agent sees they exist but learns they are not
 *   yet usable.
 * - `auth_error` — the connector's vendor-side authorization is revoked
 *   or otherwise invalid (Composio reports `INACTIVE`/`EXPIRED`, an MCP
 *   server's OAuth token failed SSL/401). Distinct from `error`: this
 *   one requires the user to reauthorize (re-OAuth, paste a new token)
 *   to recover. UI shows "Reauthorize".
 * - `error` — connector failed to initialize (transport error, crashed
 *   process, invalid config). Tools are stubbed with a diagnostic.
 *
 * Wire order is canonical and append-only. The original three values
 * (`'ready'`, `'needs_setup'`, `'error'`) keep their relative positions
 * so any positional consumer (chart legends, sort orders) stays stable;
 * the two new failure-mode values slot next to their semantically
 * adjacent terminal status. The client's `connector-schema.ts` mirror MUST
 * extend in the same order.
 *
 * Added 2026-05-16 (F4.c-1, status taxonomy migration).
 */
export const ConnectorStatusSchema = z.enum([
  'ready',
  'stale',
  'needs_setup',
  'auth_error',
  'error',
])
export type ConnectorStatus = z.infer<typeof ConnectorStatusSchema>

// ---------------------------------------------------------------------------
// Category — rough grouping for UI
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Available Connect-dialog modes (BYO surface — Phase 4-revised-A, 2026-05-06)
// ---------------------------------------------------------------------------

/**
 * Which BYO Connect-dialog modes a connector supports. Drives the unified
 * `ConnectDialog` mode picker in the client:
 *
 *   - `'token'` — the user pastes a personal access token / API key /
 *     integration token. Available when `auth.mode === 'api_key'` (the
 *     connector declares `requiredEnv` entries).
 *   - `'oauth'` — the user runs the BYO OAuth wizard (register their own
 *     vendor app, paste clientId, optional clientSecret per
 *     `OAuthPreset.requiresSecret`). Available when an `OAUTH_PRESETS`
 *     entry exists for the connector id.
 *
 * Derivation rule (in `MCPSourceProvider.mcpServerToConnector`):
 *   - both → connectors with both `requiredEnv` and an OAuth preset
 *     (e.g. GitHub, Notion). Dialog renders a tab picker, default
 *     selection is `'token'` per Phase 4-revised-A locked decision.
 *   - `['token']` → api_key-only connectors (Linear, HubSpot, Stripe).
 *   - `['oauth']` → oauth-only connectors (Microsoft 365, Google,
 *     Slack — Slack carries `requiresSecret: true`).
 *   - empty array → connector is not user-connectable through the
 *     dialog (e.g. `auth.mode === 'none'` builtins, or
 *     `runtime_setup` connectors which have their own setup
 *     surface). The dialog is never opened against these.
 */
export const ConnectorAvailableModeSchema = z.enum(['token', 'oauth'])
export type ConnectorAvailableMode = z.infer<typeof ConnectorAvailableModeSchema>

// ---------------------------------------------------------------------------
// Token-mode input descriptors (Phase 4-revised-A, Chunk 3.d, 2026-05-06)
// ---------------------------------------------------------------------------

/**
 * Per-input metadata the BYO Mode B (Token) wizard renders. Same
 * shape as `AuthModeApiKeySchema.envVars[*]` plus an optional
 * `transform` hint that the wizard applies at save time (e.g.
 * Notion's integration token wraps into a JSON header object).
 *
 * Surfaced on `Connector.tokenInputs` whenever the connector has
 * env-var inputs available, regardless of which `auth.mode` won.
 * For connectors with both modes (GitHub, Notion, Slack), `auth.mode`
 * is `'oauth'` (single-winner discriminated union) so the env-var
 * data wouldn't otherwise reach the wire — `tokenInputs` is the
 * dedicated channel for the dialog.
 */
export const ConnectorTokenInputSchema = z.object({
  /** Env var name as the underlying MCP server reads it. */
  name: z.string().min(1),
  /** Short description; rendered as input placeholder. */
  description: z.string(),
  isRequired: z.boolean(),
  /** Mask in UI, encrypt at rest. */
  isSecret: z.boolean(),
  /**
   * Optional vendor URL where the user obtains the credential
   * (token settings page, OAuth playground, dashboard). Rendered
   * as a "Get your <label> →" inline link.
   */
  helpUrl: z.string().url().optional(),
  /**
   * Optional transform applied to the user's input before save.
   * Today only Notion uses it (`notion-headers` wraps a raw
   * integration token into the JSON headers map the Notion MCP
   * server expects on startup).
   */
  transform: z.literal('notion-headers').optional(),
})
export type ConnectorTokenInput = z.infer<typeof ConnectorTokenInputSchema>

// ---------------------------------------------------------------------------
// OAuth preset reference data (Phase 4-revised-A, Chunk 3.e, 2026-05-06)
// ---------------------------------------------------------------------------

/**
 * Subset of `OAuthPreset` (loom side) exposed to the BYO Mode A
 * wizard. Carries only the fields the wizard renders to instruct the
 * user — `authorizationUrl` / `tokenUrl` / `tokenToEnv` stay
 * server-side because they're consumed only by the gateway during
 * the PKCE handshake.
 *
 * Surfaced on `Connector.oauthPreset` whenever the connector has an
 * OAuth preset registered, regardless of which `auth.mode` won.
 *
 * Invariant: `availableModes.includes('oauth')` ⇔ `oauthPreset != null`.
 */
export const ConnectorOAuthPresetSchema = z.object({
  /**
   * Vendor URL where the user creates their own OAuth app /
   * integration. Rendered as Step 1 of the Mode A wizard's
   * "Open <Provider>'s developer portal →" link.
   */
  registerUrl: z.string().url(),
  /**
   * Scope strings to request. Rendered as Step 3 of the Mode A
   * wizard ("Pick scopes / required permissions"). v1 ships raw
   * vendor strings; humanization (e.g. GitHub `repo` → "Full
   * control of private repositories") is a follow-up.
   */
  scopes: z.array(z.string()).readonly(),
  /**
   * When `true`, the wizard renders a second input field for
   * `clientSecret` alongside `clientId`. Used for vendors whose
   * token-exchange endpoint requires a confidential client (Slack
   * is the only Tier 1 entry that uses this today).
   *
   * Optional on the wire — absent / `false` means clientId-only.
   */
  requiresSecret: z.boolean().optional(),
})
export type ConnectorOAuthPreset = z.infer<typeof ConnectorOAuthPresetSchema>

export const ConnectorCategorySchema = z.enum([
  'filesystem',
  'shell',
  'browser',
  'search',
  'agent',
  'memory',
  'mcp',
  'communication',
  'data',
  'productivity',
  'ai',
  'cloud',
  'finance',
  'dev-tools',
  'research',
  'social',
  'custom',
  'design',
  'security',
  'media',
  'other',
])
export type ConnectorCategory = z.infer<typeof ConnectorCategorySchema>

// ---------------------------------------------------------------------------
// Tool UI Descriptor — drives the client's chat-stream renderer registry
// ---------------------------------------------------------------------------

/**
 * Eight render kinds covering every tool source (Loom builtin, MCP,
 * Composio). Each tool declares exactly one. The dispatcher in the client
 * routes by kind — `conversational` tools opt out of inline tool-row
 * rendering entirely (they have their own card surfaces: QuestionCard,
 * SubAgentCardChat, ConnectorAgentCard, credential strip).
 */
export const ToolUIKindSchema = z.enum([
  'file-write',
  'file-read',
  'file-edit',
  'shell',
  'search',
  'image',
  'external-action',
  'conversational',
])
export type ToolUIKind = z.infer<typeof ToolUIKindSchema>

/**
 * One-line inline summary for the tool row. `verb` is the past-tense
 * action ("Wrote", "Read", "Ran"). `primaryField` is a dotted path
 * into the tool's input that follows the verb. `metaFields` are
 * trailing fields shown after the primary one (line count, exit
 * code, etc.).
 */
export const ToolUISummarySchema = z.object({
  verb: z.string().min(1),
  primaryField: z.string().min(1).optional(),
  metaFields: z.array(z.string().min(1)).readonly().optional(),
})
export type ToolUISummary = z.infer<typeof ToolUISummarySchema>

/**
 * Chevron-expand preview. `contentField` is a dotted path into the
 * tool's OUTPUT (not input — preview shows results). `format` drives
 * the preview surface (code block, diff hunks, markdown, plain text,
 * image thumbnail). `truncateAtLines` caps inline preview size;
 * defaults to 10.
 */
export const ToolUIPreviewSchema = z.object({
  contentField: z.string().min(1),
  format: z.enum(['code', 'diff', 'markdown', 'plain', 'image-thumb']),
  truncateAtLines: z.number().int().positive().optional(),
})
export type ToolUIPreview = z.infer<typeof ToolUIPreviewSchema>

/**
 * Click affordance — the [Open] button next to the inline summary.
 * `target` picks the pane kind (file-pane / terminal-pane /
 * image-pane / search-pane) or `url` for external links. `pathField`
 * is a dotted path resolved against EITHER input OR output (renderer
 * tries both; first non-empty string wins).
 */
export const ToolUIOpenActionSchema = z.object({
  target: z.enum([
    'file-pane',
    'terminal-pane',
    'image-pane',
    'search-pane',
    'url',
  ]),
  pathField: z.string().min(1),
})
export type ToolUIOpenAction = z.infer<typeof ToolUIOpenActionSchema>

/**
 * Full UI descriptor. Lives on Loom Tool definitions for builtins;
 * synthesized by cortex for MCP/Composio actions. Travels the wire
 * unchanged via `/api/v1/connectors`. The client reads it in the chat-
 * stream dispatcher: bespoke renderer wins if registered for the
 * tool name; otherwise the descriptor drives the generic renderer.
 *
 * Forward-compat: every field except `kind` and `summary` is
 * optional. Adding a new field is additive — older consumers ignore.
 */
export const ToolUIDescriptorSchema = z.object({
  kind: ToolUIKindSchema,
  summary: ToolUISummarySchema,
  preview: ToolUIPreviewSchema.optional(),
  openAction: ToolUIOpenActionSchema.optional(),
})
export type ToolUIDescriptor = z.infer<typeof ToolUIDescriptorSchema>

// ---------------------------------------------------------------------------
// Connector — the public record
// ---------------------------------------------------------------------------

/**
 * Pluggable provider summary — surfaced on connectors that can be backed
 * by one of several third-party providers (currently only `web_search`).
 *
 * Optional on `Connector`: non-pluggable connectors simply omit `providers`
 * / `activeProviderId` / `defaultProviderId`. M1 consumers keep parsing a
 * valid object because every added field is optional.
 */
export const ConnectorProviderAuthSchema = z.union([
  z.object({ mode: z.literal('none') }),
  z.object({
    mode: z.literal('api_key'),
    envVar: z.string().min(1),
    signupUrl: z.string().url(),
    freeTier: z.string().min(1),
  }),
])

export const ConnectorProviderSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  auth: ConnectorProviderAuthSchema,
  homepage: z.string().url(),
  isDefault: z.boolean(),
  /** Whether this provider is currently configured (key or key-free). */
  configured: z.boolean(),
})
export type ConnectorProviderSummary = z.infer<typeof ConnectorProviderSummarySchema>

export const ConnectorSchema = z.object({
  /** Stable connector identifier. For builtins, the tool name. For MCP, the server id. */
  id: z.string().min(1),
  /**
   * Cross-source canonical identifier: `<source>:<id>`.
   *
   * `id` alone is source-local and can collide across sources (e.g. an
   * MCP server `gmail` and a Composio app `gmail`). `canonicalId` is the
   * globally unique key callers use for lookup, routing, and persistence
   * that must survive multiple sources being present simultaneously.
   *
   * Derivation rule (per source):
   * - `builtin`     → `builtin:<tool.name>`        e.g. `builtin:read_file`
   * - `mcp`         → `mcp:<serverId>`              e.g. `mcp:github`, `mcp:io.github.user/weather`
   * - `composio`    → `composio:<appId>`            e.g. `composio:gmail`
   * - `custom_mcp`  → `custom_mcp:<serverId>`       (reserved; wired when the source is added)
   *
   * The delimiter `:` never appears in any `ConnectorSource` enum value,
   * so `<source>:<id>` is unambiguous even if `<id>` itself contains a
   * colon (split on the first delimiter).
   */
  canonicalId: z.string().min(1).regex(/^[a-z_]+:.+$/, {
    message: 'canonicalId must be in form "<source>:<id>"',
  }),
  /**
   * Cross-source logical identity. Same logical app across different
   * sources shares the same `logicalKey` (e.g. `mcp:figma`,
   * `custom_mcp:figma-c4vrjq3w`, and `composio:figma` all carry
   * `logicalKey: 'figma'`).
   *
   * Derived via `deriveLogicalKey(source, id, hints)` from
   * `connector/logical-key.ts`. The lobby UI groups by `logicalKey` so
   * one logical app appears as one card with a source picker, regardless
   * of how many sources surface it.
   *
   * Required: every Connector emitted by every source provider MUST set
   * this field. Validation throws if missing or empty.
   */
  logicalKey: z.string().min(1),
  /** Display name. */
  name: z.string().min(1),
  /** Short description (<= ~140 chars). */
  description: z.string(),
  /** Source subsystem. */
  source: ConnectorSourceSchema,
  /** Rough category for UI grouping. */
  category: ConnectorCategorySchema,
  /** Authentication requirements. */
  auth: AuthModeSchema,
  /** Current readiness. */
  status: ConnectorStatusSchema,
  /** Tool names this connector contributes, when known. Null if unknown (e.g. MCP not yet connected). */
  toolNames: z.array(z.string()).nullable(),
  /**
   * Optional brand-logo URL surfaced from the underlying source (Composio
   * catalog, MCP featured list, custom manifest). Optional + nullable for
   * backward compatibility — consumers without a logo fall back to a
   * letter tile via `ToolIcon`. Must be an absolute URL when present.
   */
  iconUrl: z.string().url().nullable().optional(),
  /**
   * Optional per-action metadata for grouped connectors. For a grouped
   * built-in (e.g. "Browser") each action maps 1:1 to an underlying Loom
   * tool. Optional and backward-compatible: non-grouped or pre-1.5a
   * connectors omit this field entirely and consumers ignore it.
   *
   * Added in Session 1.5a (BuiltinSourceProvider grouping by category).
   *
   * `isReadOnly` and `requiresPermission` mirror the Loom `Tool` flags for
   * built-in actions. The client's Abilities tab uses them for behaviour (the
   * `readonly` preset depends on `isReadOnly` to decide which filesystem
   * tools fall inside the preset base) and for the read-only / asks-first
   * badges in the tool list. Both are optional on the wire — when absent
   * consumers must treat them as `false`, matching Loom's `defineTool`
   * defaults. Non-builtin sources omit them.
   */
  actions: z.array(z.object({
    name: z.string().min(1),
    description: z.string(),
    isReadOnly: z.boolean().optional(),
    requiresPermission: z.boolean().optional(),
    /**
     * Optional UI rendering hints for this action. Consumers (the client's
     * chat-stream) read these to pick the right inline renderer
     * without per-tool hardcoded logic. Optional + backward-compatible:
     * absent ⇒ generic ToolLine.
     *
     * Currently carries `fileLine` only — enough to drive `<FileLine>`
     * dispatch for file-shaped tools across builtin, MCP, and Composio
     * sources. Extending later (e.g. shell streaming) widens this
     * object without breaking the wire.
     */
    uiHints: z.object({
      fileLine: z.object({
        op: z.enum(['read', 'write', 'edit']),
        pathField: z.string().min(1),
      }).optional(),
    }).optional(),
    /**
     * Full UI rendering descriptor. Cortex emits this for builtins
     * (relaying `tool.uiDescriptor` declared on the Loom Tool) and
     * synthesizes it for MCP / Composio actions from external
     * metadata. The client's chat-stream dispatcher pairs descriptor +
     * bespoke renderer (if registered) or falls back to the generic
     * descriptor-driven renderer.
     *
     * Coexists with `uiHints` during the C2 → S5 migration. Once S5
     * lands, `uiHints` is removed and `uiDescriptor` is the only
     * render-metadata field on the wire.
     */
    uiDescriptor: ToolUIDescriptorSchema.optional(),
  })).optional(),
  /** Optional human-readable diagnostic if status === 'error' or 'auth_error'. */
  error: z.string().optional(),
  /**
   * ISO 8601 timestamp of the most recent successful reachability /
   * reconciliation check against the connector's source of truth (for
   * Composio: vendor `listConnectedAccounts` returned this account as
   * ACTIVE; for MCP: a `tools/list` round-trip succeeded). Updated by
   * `ComposioReconciler` (F4.c-1) and the MCP status bridge.
   *
   * Optional on the wire — connectors that have never been verified
   * (fresh registrations, builtins with no vendor side) omit it. When
   * present the client UI can show "Last checked 3m ago" beneath
   * `stale` connectors to give a recovery hint.
   *
   * Persistence: stored as `connector_connections.last_verified_at`
   * (Unix-ms integer; migration 028). The reconciler writes via
   * `ConnectorConnectionsStore.touchVerified()`. Wire projection from
   * the row into the registry's `mcpServerToConnector` /
   * `customRowToConnector` projection is wired in F4.c-2; this schema
   * field is intentionally additive so the reconciler can begin
   * writing the column today without forcing the registry plumbing
   * change in the same chunk.
   *
   * Added 2026-05-16 (F4.c-1, status taxonomy migration).
   */
  lastVerifiedAt: z.string().datetime().optional(),
  /**
   * Pluggable-provider fields (M1.5+). All optional — non-pluggable
   * connectors omit them and existing M1 consumers remain compatible.
   */
  providers: z.array(ConnectorProviderSummarySchema).optional(),
  activeProviderId: z.string().optional(),
  defaultProviderId: z.string().optional(),
  /** Source that produced `activeProviderId`. Only set when providers present. */
  activeProviderSource: z.enum(['user', 'env', 'default']).optional(),
  /**
   * BYO Connect-dialog modes this connector supports — drives the
   * unified `ConnectDialog` mode picker in the client.
   *
   * Optional on the wire so pre-Phase-4-revised-A consumers continue
   * to parse. When absent, the dialog falls back to deriving from
   * `auth.mode` (token if `api_key`, oauth if `oauth`, neither
   * otherwise). New emitters (post-2026-05-06) MUST populate this.
   *
   * Empty array = not user-connectable through the dialog. See
   * `ConnectorAvailableMode` for the derivation rule.
   */
  availableModes: z.array(ConnectorAvailableModeSchema).readonly().optional(),
  /**
   * Optional inline UI suggestions surfaced on the success card after
   * a Connect completes ("Try: 'summarize my unread emails'"). Curated
   * per Tier 1 entry on `FeaturedMCPServer`. Two prompts is the typical
   * shape; absent or empty → success card collapses to title only.
   *
   * Optional on the wire — consumers without the field render a plain
   * "Connected" success card.
   */
  suggestedPrompts: z.array(z.string().min(1)).readonly().optional(),
  /**
   * BYO Mode B (Token) wizard inputs. Populated whenever the connector
   * exposes env-var inputs, regardless of which `auth.mode` won the
   * single-winner discriminated union. For connectors with both modes
   * (GitHub, Notion, Slack), `auth.mode` is `'oauth'` so the env-var
   * data would otherwise be lost on the wire — `tokenInputs` is the
   * dedicated channel for the unified Connect dialog.
   *
   * Invariant (enforced by registry test):
   *   `availableModes.includes('token')` ⇔ `tokenInputs.length > 0`
   *
   * Added 2026-05-06 (Phase 4-revised-A, Chunk 3.d).
   */
  tokenInputs: z.array(ConnectorTokenInputSchema).readonly().optional(),
  /**
   * BYO Mode A (OAuth) wizard reference data. Subset of the
   * `OAuthPreset` registered for this connector — only the fields
   * the wizard renders to instruct the user. Server-side fields
   * (`authorizationUrl`, `tokenUrl`, `tokenToEnv`) stay in cortex
   * because they're consumed only during the PKCE handshake.
   *
   * Invariant (enforced by registry test):
   *   `availableModes.includes('oauth')` ⇔ `oauthPreset != null`
   *
   * Added 2026-05-06 (Phase 4-revised-A, Chunk 3.e).
   */
  oauthPreset: ConnectorOAuthPresetSchema.optional(),
})
export type Connector = z.infer<typeof ConnectorSchema>

export const ConnectorListSchema = z.array(ConnectorSchema)

// ---------------------------------------------------------------------------
// canonicalId helpers
// ---------------------------------------------------------------------------

/**
 * Compose a canonical connector id from its `source` and source-local `id`.
 * Use this in every `ConnectorSourceProvider` that emits `Connector` records
 * so the derivation rule lives in exactly one place.
 */
export function makeCanonicalConnectorId(source: ConnectorSource, id: string): string {
  if (id.length === 0) {
    throw new Error('makeCanonicalConnectorId: id must be non-empty')
  }
  return `${source}:${id}`
}

/**
 * Split a canonical id back into `[source, id]`. Splits on the first `:`
 * only — `id` itself may contain colons (reserved for future sources that
 * use URN-shaped ids).
 */
export function parseCanonicalConnectorId(
  canonicalId: string,
): { source: ConnectorSource; id: string } | null {
  const idx = canonicalId.indexOf(':')
  if (idx <= 0 || idx === canonicalId.length - 1) return null
  const src = canonicalId.slice(0, idx)
  const parsed = ConnectorSourceSchema.safeParse(src)
  if (!parsed.success) return null
  return { source: parsed.data, id: canonicalId.slice(idx + 1) }
}

// ---------------------------------------------------------------------------
// ConnectorNotReadyError — metadata attached to ToolResult when a stub fires
// ---------------------------------------------------------------------------

/**
 * Structured metadata placed on `ToolResult.metadata` when an agent calls a
 * tool whose connector is not ready. The client keys off this in Milestone 2
 * to render an inline "Connect …" card.
 *
 * The `kind` discriminator is stable forever: downstream consumers match
 * `metadata.kind === 'connector_not_ready'` regardless of schema evolution.
 */
export const ConnectorNotReadyErrorSchema = z.object({
  kind: z.literal('connector_not_ready'),
  connectorId: z.string().min(1),
  connectorName: z.string().min(1),
  source: ConnectorSourceSchema,
  authMode: AuthModeSchema,
  reason: z.string().min(1),
  /** ISO 8601 timestamp of the failure. */
  at: z.string().datetime(),
  /**
   * Pluggable-connector extensions (M1.5+). Populated only when the
   * connector is provider-pluggable (e.g. web_search). Kept optional so
   * the M1 stub metadata shape on non-pluggable connectors is unchanged.
   */
  providerId: z.string().optional(),
  providerName: z.string().optional(),
  availableProviders: z.array(ConnectorProviderSummarySchema).optional(),
})
export type ConnectorNotReadyError = z.infer<typeof ConnectorNotReadyErrorSchema>

// ---------------------------------------------------------------------------
// Query params for GET /api/v1/connectors
// ---------------------------------------------------------------------------

export const ConnectorsQuerySchema = z.object({
  /** Optional profile id — when set, returns connectors scoped to that profile. */
  profileId: z.string().min(1).optional(),
  /**
   * Gate Composio entries to the curated featured list
   * (`connector/composio/featured.ts`). Defaults to `true` so the lobby
   * stays usable once Composio's 1000+ toolkit catalogue has synced.
   *
   * `false` returns every catalogued Composio toolkit — the pre-filter
   * behaviour, required for the "Show all" expander in the client's Tools
   * lobby. Built-in and MCP entries are unaffected by this flag.
   */
  composioFeatured: z.boolean().optional(),
  /**
   * Paginated-source switch (2026-05-25 — Add Tool modal pagination).
   * When set to `'composio'`, the handler skips the unified MCP+builtin
   * flow and returns a single page of Composio toolkits using the
   * `search` / `limit` / `cursor` params below. Without this flag the
   * legacy unified list is returned (every source, deduped). Only
   * `'composio'` is accepted today — MCP / builtin catalogs are small
   * enough that they don't need pagination.
   */
  source: z.literal('composio').optional(),
  /** Free-text search forwarded to Composio's `/api/v3/toolkits?search=`. Paginated branch only. */
  search: z.string().min(1).optional(),
  /** Page size — defaults to the catalog cache's configured pageSize when absent. Paginated branch only. */
  limit: z.number().int().positive().max(200).optional(),
  /** Opaque cursor from a prior page's `nextCursor`. Paginated branch only. */
  cursor: z.string().min(1).optional(),
})
export type ConnectorsQuery = z.infer<typeof ConnectorsQuerySchema>

/**
 * Wire response for `GET /api/v1/connectors?source=composio&...`. The
 * legacy un-paginated branch returns a flat `Connector[]`; the new
 * paginated branch returns this envelope so clients can drive an
 * infinite-scroll list without holding the full 1000-toolkit catalogue
 * in memory.
 */
export const PaginatedConnectorsResponseSchema = z.object({
  items: z.array(ConnectorSchema),
  nextCursor: z.string().nullable(),
})
export type PaginatedConnectorsResponse = z.infer<typeof PaginatedConnectorsResponseSchema>

// ---------------------------------------------------------------------------
// POST /connectors/:id/connect — thin-dispatcher response (T02)
// ---------------------------------------------------------------------------

/**
 * `POST /api/v1/connectors/:id/connect` is a THIN DISPATCHER. It does not
 * itself run any OAuth handshake or write credentials. It inspects the
 * connector's source + declared auth mode and returns a discriminated
 * response telling the client which downstream endpoint to hit next (or
 * that no further action is needed).
 *
 * Why not fold the OAuth / api_key work into the dispatcher itself? The
 * PKCE state and vendor-specific completion logic already live in
 * `/mcp/oauth/*` and `/mcp/credentials/*`. T02 keeps them intact
 * because:
 *   - `/mcp/oauth/*` has specific state/callback/verifier needs that
 *     would be awkward to multiplex through a generic dispatcher.
 *   - Keeping those endpoints stable reduces the blast radius — this
 *     is purely an additive front door for the client, not a rewrite.
 *
 * Composio is the one branch where the OAuth link creation is
 * synchronous and safe to do in this call — its Composio client's
 * `createConnectionLink` returns the `authorizationUrl` immediately,
 * so Composio's branch inlines it rather than redirecting the client
 * to a separate endpoint.
 *
 * Discriminator note: Zod's `discriminatedUnion` takes a single
 * literal field. We would ideally discriminate on (`provider` +
 * `kind`), but Zod does not support multi-field discriminators. The
 * workaround is to fold both into a single `kind` value with
 * namespaced names — `composio_oauth`, `mcp_oauth`, `mcp_api_key`,
 * `mcp_none`. Clients that only need the "what next?" decision can
 * `switch (res.kind)` without inspecting a second field.
 *
 * Backward compatibility with existing client consumers: pre-T02
 * clients parse the Composio response as a flat
 * `{ connectionId, authorizationUrl, ... }` object via
 * `z.object(...).strip` (the default). Adding `kind: 'composio_oauth'`
 * to the response is invisible to that parser — it strips the
 * unknown `kind` key and keeps parsing the familiar fields. The client
 * adopts the discriminated shape in T09 when the pre-flight screen
 * branches on it.
 */

/**
 * Composio OAuth — authorization URL inlined (Composio's link creation
 * is synchronous). Shape matches the pre-T02 response plus the `kind`
 * discriminator. `status` mirrors the `ConnectionRow.status` value
 * (`'pending' | 'ready' | 'failed' | 'expired'`) kept as a plain
 * string to stay tolerant of future rows the connections store might
 * add without a breaking wire change.
 */
export const ConnectComposioOAuthResponseSchema = z.object({
  kind: z.literal('composio_oauth'),
  connectionId: z.string().min(1),
  status: z.string().min(1),
  authorizationUrl: z.string().url().nullable(),
  // `expiresAt` and `authConfigId` are nullable on the underlying
  // `ConnectionRow` (`connections/store.ts:68,78`). Pre-T02 the
  // handler sent those nulls through unchecked; the new schema
  // preserves that reality rather than inventing non-null placeholders.
  expiresAt: z.number().nullable(),
  authConfigId: z.string().min(1).nullable(),
  reused: z.boolean(),
})

/**
 * MCP OAuth — the PKCE flow lives at `/mcp/oauth/start/:id`. Client
 * POSTs there to receive the actual authorization URL.
 */
export const ConnectMCPOAuthResponseSchema = z.object({
  kind: z.literal('mcp_oauth'),
  startEndpoint: z.string().min(1),
})

/**
 * MCP API-key — caller must POST to `/mcp/credentials/:id` with the
 * env vars. `required` mirrors the connector's `auth.envVars` filtered
 * to the required subset so the client can render a tight form.
 */
export const ConnectMCPApiKeyResponseSchema = z.object({
  kind: z.literal('mcp_api_key'),
  required: z.array(z.object({
    name: z.string().min(1),
    description: z.string(),
    isRequired: z.boolean(),
  })),
  saveEndpoint: z.string().min(1),
})

/**
 * MCP stdio with no auth required — usable immediately. `status:
 * 'ready'` is a promise about the connector, not a transient row.
 */
export const ConnectMCPNoneResponseSchema = z.object({
  kind: z.literal('mcp_none'),
  status: z.literal('ready'),
})

/**
 * Composio toolkit with `no_auth=true` (Code Interpreter, sandboxes,
 * etc.) — there is nothing to authenticate, no connected_account on
 * Composio's side, no row in our connector_connections table. The
 * dispatcher returns this discriminant so the client's Connect dispatcher
 * can close any open dialog and treat the action as instantly
 * successful, and so the agent's `POST .../connect` call gets honest
 * feedback instead of being routed through a meaningless OAuth path
 * that has nothing to do at any step.
 *
 * Added 2026-05-27 (no-auth tool E2E fix).
 */
export const ConnectComposioNoneResponseSchema = z.object({
  kind: z.literal('composio_none'),
  status: z.literal('ready'),
})

/**
 * MCP with runtime setup — caller POSTs to `setupEndpoint` to trigger the
 * one-time setup action (browser login, plugin probe, etc.). Server runs
 * the connector's `setupCommand` and waits for completion. Status flips
 * to `ready` on success.
 */
export const ConnectMCPRuntimeSetupResponseSchema = z.object({
  kind: z.literal('mcp_runtime_setup'),
  hint: z.string().min(1),
  setupEndpoint: z.string().min(1),
  /**
   * `true` when there's a `setupCommand` to spawn — Cortex runs it and
   * blocks. `false` when setup is manual (Obsidian-style) — the endpoint
   * just flips status, the user is acknowledging they did the manual step.
   */
  hasCommand: z.boolean(),
})

export const ConnectConnectorResponseSchema = z.discriminatedUnion('kind', [
  ConnectComposioOAuthResponseSchema,
  ConnectComposioNoneResponseSchema,
  ConnectMCPOAuthResponseSchema,
  ConnectMCPApiKeyResponseSchema,
  ConnectMCPNoneResponseSchema,
  ConnectMCPRuntimeSetupResponseSchema,
])
export type ConnectConnectorResponse = z.infer<
  typeof ConnectConnectorResponseSchema
>

// ---------------------------------------------------------------------------
// GET /catalog query (T01)
// ---------------------------------------------------------------------------

/**
 * Query schema for `GET /api/v1/catalog` — the client's "Add Tool" modal
 * front door. Adds three filters on top of the existing
 * `/api/v1/connectors` aggregation:
 *
 *   - `source`  → narrow to a single tool source (omit for the union)
 *   - `featured` → curated subset only; default `false` (i.e. show all)
 *                  for the catalog because the modal explicitly invites
 *                  the user to discover non-featured tools. This is the
 *                  reverse of `/connectors`, where the lobby defaults
 *                  to featured-only to keep the small-screen view tight.
 *   - `q`       → case-insensitive substring match on `name` + `id`
 *
 * `?source` accepts every value in `ConnectorSourceSchema`. Validation
 * happens via the schema, so a typo (`?source=mcps`) returns 400 with
 * Zod's enum-mismatch error rather than silently returning every
 * source.
 */
export const CatalogQuerySchema = z.object({
  source: ConnectorSourceSchema.optional(),
  featured: z.boolean().optional(),
  /** Free-text search. Min 1 char so an empty `?q=` doesn't accidentally
   *  short-circuit the filter to "match-everything." Stripped at the
   *  handler when empty. */
  q: z.string().min(1).max(128).optional(),
})
export type CatalogQuery = z.infer<typeof CatalogQuerySchema>

// ---------------------------------------------------------------------------
// POST /mcp/register body (T04)
// ---------------------------------------------------------------------------

/**
 * Body schema for `POST /api/v1/mcp/register` — user-supplied custom
 * MCP server registration. The handler persists this into the
 * `mcp_servers` table with `registry_id = 'custom'` and emits it from
 * `CustomMCPSourceProvider` so it shows up in `/connectors` and
 * `/catalog` with `source: 'custom_mcp'` and `status: 'needs_setup'`.
 *
 * ### Security invariants (rule 14 — security boundaries are absolute)
 *
 *   - `env` / `headers` carry **NAMES ONLY**. Values live in the
 *     credential vault and are submitted later via
 *     `/mcp/credentials/:id`. Storing values here would create a second
 *     secret-bearing surface with different lifetime and access rules —
 *     not acceptable.
 *   - The `command` field is stored verbatim. The register handler
 *     does NOT spawn the command at registration time, does NOT
 *     resolve the path against `PATH`, does NOT validate the binary
 *     exists. Execution happens only when a profile references the
 *     server id and the assembler builds a live Session (the same
 *     point where featured servers' commands fire).
 *   - `transport` is an enum, not free-text. An unknown transport
 *     hits the Zod enum-mismatch error before any disk write.
 *
 * ### Transport-specific required fields
 *
 *   - `stdio`  → `command` required; `args` + `env` optional.
 *   - `http`   → `url` required; `headers` optional.
 *   - `sse`    → `url` required; `headers` optional.
 *
 * Enforced in a post-parse refinement so the Zod error message names
 * the specific missing field rather than a generic "discriminated
 * union" failure.
 */
const EnvOrHeaderNameSchema = z
  .string()
  .min(1)
  .max(128)
  // Env var NAMES are [A-Z0-9_] by POSIX; we're permissive on
  // HTTP header names ([A-Za-z0-9-]) but the union of both is
  // narrow enough to reject junk like whitespace or shell meta-chars.
  .regex(/^[A-Za-z0-9_-]+$/, {
    message: 'env/header name must match /^[A-Za-z0-9_-]+$/',
  })

export const RegisterMCPServerBodySchema = z
  .object({
    name: z.string().min(1).max(128),
    description: z.string().max(512).optional(),
    transport: z.enum(['stdio', 'http', 'sse']),
    // stdio fields
    command: z.string().min(1).max(1024).optional(),
    args: z.array(z.string().max(1024)).max(64).optional(),
    env: z.array(EnvOrHeaderNameSchema).max(64).optional(),
    // http/sse fields
    url: z.string().url().optional(),
    headers: z.array(EnvOrHeaderNameSchema).max(64).optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.transport === 'stdio') {
      if (!val.command || val.command.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['command'],
          message: 'command is required for stdio transport',
        })
      }
      if (val.url !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['url'],
          message: 'url is not valid for stdio transport',
        })
      }
      if (val.headers !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['headers'],
          message: 'headers is not valid for stdio transport',
        })
      }
    } else {
      // http | sse
      if (!val.url || val.url.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['url'],
          message: `url is required for ${val.transport} transport`,
        })
      }
      if (val.command !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['command'],
          message: `command is not valid for ${val.transport} transport`,
        })
      }
      if (val.args !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['args'],
          message: `args is not valid for ${val.transport} transport`,
        })
      }
      if (val.env !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['env'],
          message: `env is not valid for ${val.transport} transport — use headers for http/sse`,
        })
      }
    }
  })
export type RegisterMCPServerBody = z.infer<typeof RegisterMCPServerBodySchema>

/** Sentinel stored in `mcp_servers.registry_id` for API-registered
 *  custom servers. Lets `CustomMCPSourceProvider` filter them in and
 *  the featured/registry-attached flows filter them out. */
export const CUSTOM_MCP_REGISTRY_MARKER = 'custom'

/** Sentinel for servers auto-registered from on-disk detection sources. */
export const DETECTED_REGISTRY_MARKER = 'detected'
