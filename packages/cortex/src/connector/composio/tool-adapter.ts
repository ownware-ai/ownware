/**
 * ComposioToolProvider — injects Composio toolkit actions into the
 * assembled Loom tool list.
 *
 * Behaviour
 * ---------
 * Composio toolkits are injected ONLY for toolkits the profile has
 * explicitly opted into via `tools.composio.toolkits` in `agent.json`.
 * A profile that omits the field (or lists an empty array) receives
 * zero Composio tools. This is the inverse of the pre-2026-04 behaviour,
 * which injected every catalogued toolkit into every profile globally —
 * an architectural drift that routinely produced 1000+ tool payloads and
 * blew past OpenAI's 128-tool request cap.
 *
 * For each slug declared by the profile:
 *   - If the slug is in the Composio catalog AND the user has a `ready`
 *     connection, emit REAL tools named `composio_<toolkit>_<tool>`
 *     (sanitized) that call `client.executeTool()` with the
 *     connected_account_id.
 *   - If the slug is in the catalog but NOT connected, emit a STUB
 *     tool with `kind='connector_not_ready'` — the client renders an
 *     inline "Connect …" card.
 *   - If the slug is NOT in the catalog at all, emit a STUB tool
 *     with `kind='composio_unknown_toolkit'` so the user sees a
 *     clear error ("'foo' isn't a valid Composio toolkit slug")
 *     instead of a silent drop. Safer than throwing at assembly.
 *
 * Tool naming (`composio_<toolkit>_<tool>`)
 * -----------------------------------------
 * Composio's own tool slugs are mixed-case with underscores, e.g.
 * `NOTION_SEARCH_DATABASES`. We lowercase, prefix with `composio_`,
 * prefix with the toolkit slug, and collapse any non-`[a-z0-9_]` run
 * into a single underscore. Hard collisions (two Composio toolkits
 * producing the same final name AFTER sanitisation — extremely unlikely)
 * throw a clear error at provider construction time rather than
 * silently shadowing.
 *
 * Error mapping (5 classes → ToolResult.metadata.kind)
 * ----------------------------------------------------
 *   - ConnectorAuthExpiredError → `composio_auth_expired`
 *   - ConnectorRateLimitedError → `composio_rate_limited`    (+retryAfterMs)
 *   - ConnectorValidationError  → `composio_validation_error`
 *   - ConnectorNetworkError     → `composio_network_error`
 *   - ConnectorVendorError      → `composio_vendor_error`    (+statusCode)
 *
 * Every metadata payload includes:
 *   - `kind` — one of the five above
 *   - `source: 'composio'`
 *   - `connectorId` — the toolkit slug
 *   - `message` — human-readable
 *
 * Result truncation
 * -----------------
 * A single Composio action result larger than 100 KB of serialised JSON
 * is truncated. The tool result content becomes
 * `<first 100 KB> …[truncated; original <N> bytes]` and
 * `metadata.kind === 'composio_result_truncated'` is added alongside
 * the original `data`/`successful` fields. A warning is logged.
 *
 * Stub fallback (M1 byte-parity)
 * ------------------------------
 * When a Composio connector is not ready, the stub tool emits EXACTLY
 * the M1 `ConnectorNotReadyError` shape — `kind: 'connector_not_ready'`,
 * NOT one of the five `composio_*` kinds above. Runtime errors and
 * not-ready states are different concerns; keeping them distinct lets
 * the client render a single "Connect X" card for not-ready regardless of
 * source while still surfacing vendor-specific runtime failures.
 */

import type { Tool, ToolResult } from '@ownware/loom'
import type { JsonSchema } from '@ownware/loom'
import type {
  ConnectorToolProvider,
  ConnectorToolProviderContext,
  ConnectorToolProviderResult,
} from '../providers/types.js'
import type { LoadedProfile } from '../../profile/loader.js'
import type { ConnectorConnectionsStore } from '../connections/store.js'
import type {
  ComposioClient,
  ComposioTool,
  ComposioToolkitSummary,
} from './client.js'
import type { ComposioCatalogCache } from './catalog-cache.js'
import {
  ConnectorAuthExpiredError,
  ConnectorNetworkError,
  ConnectorRateLimitedError,
  ConnectorValidationError,
  ConnectorVendorError,
  type ConnectorError,
} from '../errors.js'
import { createStubTool } from '../stub-tool.js'
import type { AuthMode } from '../schema.js'
import {
  ComposioIdentityResolver,
  type ExecuteIdentity,
} from '../identity/resolver.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** 100 KB result cap. */
export const COMPOSIO_RESULT_MAX_BYTES = 100 * 1024

const EMPTY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {},
  additionalProperties: true,
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ComposioToolProviderOptions {
  readonly client: ComposioClient
  readonly catalogCache: ComposioCatalogCache
  readonly connections: ConnectorConnectionsStore
  /**
   * Install-scoped identity governing "my" connections. Required and
   * non-empty — callers resolve via `InstallIdentity.resolve()` at
   * gateway boot so the read-side here matches the write-side in the
   * connect handler. Pre-v19 this defaulted to `'cortex-default-user'`
   * here while the connect handler defaulted to `null`, which produced
   * the "modal says ready but agent says not_connected" bug.
   */
  readonly entityId: string
  /**
   * Whether to preload the tool manifest per ready toolkit at assembly.
   * v1 default `false`: we discover tools lazily on first catalog hit,
   * OR the caller pre-populates via `warmToolsForToolkit()`. Keeping
   * assembly fast matters more than exhaustive tool coverage on boot.
   */
  readonly preloadTools?: boolean
  /** Test seam — override the log sink. */
  readonly log?: (line: string) => void
  /**
   * Optional filter consulted once per catalog row. Return `false` to
   * drop the row from this assembly (no real tool, no stub). Phase 2b.2b
   * wires this to the source-resolver so a toolkit whose logical key
   * resolves to an MCP source in the alias registry is NOT emitted by
   * the Composio side — preventing double-tool coverage of the same
   * logical app. When omitted, every row is kept (legacy behaviour).
   */
  readonly shouldEmitForAppId?: (appId: string) => boolean
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class ComposioToolProvider implements ConnectorToolProvider {
  readonly source = 'composio'
  private readonly client: ComposioClient
  private readonly catalogCache: ComposioCatalogCache
  private readonly connections: ConnectorConnectionsStore
  private readonly entityId: string
  private readonly logFn: (line: string) => void
  private readonly shouldEmitForAppId: (appId: string) => boolean
  /**
   * Single source of truth for "what identifier do we send to Composio
   * at execute-time?" — see src/connector/identity/resolver.ts. Holding
   * an instance here keeps the rule "vendor-frozen values only" enforced
   * by the type system: every executeTool path must go through this
   * resolver, and the resolver only reads vendor-frozen columns from
   * the row.
   */
  private readonly identityResolver: ComposioIdentityResolver
  /**
   * Per-toolkit cached tool manifests. Populated on demand. A full
   * refresh happens only via `warmToolsForToolkit()`; we never refetch
   * automatically mid-assembly (too slow for the run path).
   */
  private readonly toolsByToolkit = new Map<string, readonly ComposioTool[]>()
  /**
   * Per-slug in-flight warm promise. Protects against the boot scan
   * and a near-simultaneous status-bus ready event from firing two
   * parallel `listTools` calls for the same toolkit. Cleared in the
   * `finally` of `warmToolsForToolkit` so later re-warms still go out.
   */
  private readonly warmInflight = new Map<string, Promise<void>>()
  /**
   * Slugs that completed at least one successful warm (with any number
   * of tools, including zero). Read at assembly time to suppress a
   * redundant inline warm for toolkits Composio genuinely lists zero
   * tools for — without this set, every turn would pay one
   * `listTools` round-trip per empty toolkit. Populated regardless of
   * how the warm was triggered (boot scan, status-bus ready event,
   * inline reconcile). Stale-recovery is via reconnect (status-bus
   * emits ready, attachStatusBus re-warms) or gateway restart.
   */
  private readonly warmedSlugs = new Set<string>()

  constructor(opts: ComposioToolProviderOptions) {
    this.client = opts.client
    this.catalogCache = opts.catalogCache
    this.connections = opts.connections
    this.entityId = opts.entityId
    this.logFn = opts.log ?? ((line) => { console.warn(line) })
    this.shouldEmitForAppId = opts.shouldEmitForAppId ?? (() => true)
    this.identityResolver = new ComposioIdentityResolver()
  }

  /**
   * Pre-warm the in-memory tool manifest for a toolkit. The provider
   * uses the cached result during the next assembly. Safe to call at
   * any time; errors are swallowed to a single log line.
   *
   * Coalesces concurrent calls for the same slug — two simultaneous
   * `warmToolsForToolkit('gmail')` calls share one network round-trip
   * and both resolve off the same promise. Stops a boot scan from
   * racing a status-bus warm firing on the same toolkit.
   */
  async warmToolsForToolkit(toolkitSlug: string): Promise<void> {
    const existing = this.warmInflight.get(toolkitSlug)
    if (existing !== undefined) return existing
    const p = (async () => {
      try {
        const page = await this.client.listTools({ toolkitSlug, limit: 100 })
        this.toolsByToolkit.set(toolkitSlug, page.items)
        // Mark as warmed regardless of result count — a successful call
        // that returned zero tools is still a valid answer ("this
        // toolkit ships no actions"). Without this, assembly would
        // re-fire the inline warm on every turn for such toolkits.
        this.warmedSlugs.add(toolkitSlug)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        this.logFn(`[ownware] composio.adapter: warmToolsForToolkit('${toolkitSlug}') failed: ${msg}`)
      } finally {
        this.warmInflight.delete(toolkitSlug)
      }
    })()
    this.warmInflight.set(toolkitSlug, p)
    return p
  }

  /**
   * Boot-time scan: walks every `ready` composio row in
   * `connector_connections` and warms its toolkit manifest in
   * parallel. Without this, profiles that were already attached to
   * ready toolkits before a gateway restart would assemble with the
   * `no_tools_loaded` stub until the status-bus subscriber (see
   * `attachStatusBus`) eventually re-emits a ready transition — which
   * never happens for rows that were already ready at boot.
   *
   * Returns once every warm has settled (success or logged failure).
   * Intended to be awaited inside the gateway's boot sequence so the
   * first chat session after a restart sees real tools.
   */
  async warmAllReady(): Promise<void> {
    const ready = this.connections.listActiveByStatus('composio', 'ready', this.entityId)
    if (ready.length === 0) return
    await Promise.all(
      ready.map((row) => this.warmToolsForToolkit(row.connectorId)),
    )
  }

  /**
   * Subscribe to a `ConnectorStatusBus` and warm the toolkit manifest
   * every time a composio connection transitions into `ready`. Covers:
   *   - A fresh connect completing OAuth (poller emits ready).
   *   - The resync endpoint reconciling externally-created
   *     connections (the reconcile pass emits ready).
   *
   * Returns the unsubscribe handle. The gateway calls this during
   * boot and ignores the handle (bus lifetime matches gateway
   * lifetime).
   */
  attachStatusBus(bus: {
    subscribe: (listener: (event: { source: string; connectorId: string; status: string }) => void) => () => void
  }): () => void {
    return bus.subscribe((event) => {
      if (event.source !== 'composio') return
      if (event.status !== 'ready') return
      // Fire-and-forget. Errors are logged inside warmToolsForToolkit.
      void this.warmToolsForToolkit(event.connectorId)
    })
  }

  async getToolsForProfile(
    profile: LoadedProfile,
    _ctx: ConnectorToolProviderContext,
  ): Promise<ConnectorToolProviderResult> {
    const tools: Tool[] = []
    const stubs: Tool[] = []
    const seen = new Set<string>()

    // Per-profile opt-in. The profile's `tools.composio.toolkits` is the
    // single source of truth for which toolkits this profile sees.
    // Default is `[]` (see ComposioToolsConfigSchema), which short-
    // circuits here to zero output. An `agent.json` that never mentions
    // Composio therefore contributes zero Composio tools — matching the
    // MCP and custom-tool contracts (explicit declaration required).
    const declaredSlugs = profile.config.tools.composio.toolkits
    if (declaredSlugs.length === 0) {
      return { tools, stubs }
    }

    // Resolve declared slugs against Composio's live catalogue in one
    // pass. The cache returns the full toolkit list paginated from
    // `/api/v3/toolkits`, behind a 60s TTL + in-flight coalescing —
    // one network walk per gateway-minute regardless of how many
    // profiles assemble.
    const allToolkits = await this.catalogCache.listToolkits()
    const catalogBySlug = new Map<string, ComposioToolkitSummary>()
    for (const item of allToolkits) {
      catalogBySlug.set(item.slug, item)
    }

    for (const slug of declaredSlugs) {
      const item = catalogBySlug.get(slug)
      if (!item) {
        // Declared slug missing from Composio's live catalogue — either
        // a typo, a deprecated toolkit, or one Composio hasn't published
        // yet. Emit a stub with a distinct kind so the UI can
        // differentiate "typo" from "not connected." Safer than throwing
        // at assembly: one bad slug must not brick an otherwise valid
        // profile.
        const name = buildToolName(slug, 'unknown_toolkit')
        stubs.push(createStubTool({
          toolName: name,
          description: `Composio toolkit '${slug}' is not in Composio's catalogue`,
          connectorId: slug,
          connectorName: slug,
          source: 'composio',
          authMode: { mode: 'none' },
          reason:
            `Composio toolkit '${slug}' was declared in tools.composio.toolkits ` +
            `but Composio's API doesn't recognise the slug. Check the spelling ` +
            `against your Composio dashboard.`,
        }))
        continue
      }

      // For Composio, appId === slug; alias the names locally to make
      // the rest of this block read like the original catalogue-row
      // version. Same callees, same identity rules — only the source
      // of metadata changed.
      const appId = item.slug
      const toolkitSlug = item.slug
      const toolkitName = item.name
      const toolkitDescription = summaryDescription(item)
      const toolkitAuthRaw = summaryAuthRaw(item)

      // Alias resolver: if this appId resolves to a different source right
      // now (user has MCP + Composio for the same logical app, MCP wins),
      // skip — the winning source contributes the tools. Prevents double-
      // registration with colliding names.
      if (!this.shouldEmitForAppId(appId)) continue

      // ── No-auth path (2026-05-27) ───────────────────────────────────
      //
      // Composio toolkits with `no_auth=true` (Code Interpreter, hosted
      // sandboxes, etc.) have no credential to authenticate, no
      // connected_account on Composio's side, no row in our
      // connector_connections table — and crucially, none of those
      // ARE NEEDED for executeAction. Composio's API accepts userId
      // alone for no_auth toolkits.
      //
      // Pre-fix: the adapter required a `ready` row + authConfigId to
      // build real tools. No-auth toolkits never had a row, so the
      // adapter emitted a stub ("X is not connected. Use POST /...
      // /connect"). The user added Code Interpreter, the chip said
      // ✓ Added, but the agent only ever saw a stub at runtime.
      //
      // Honest schema (Ownware Principle 22): `connector_connections`
      // is the auth-credential ledger. A no-auth tool has nothing
      // to authenticate → no row. The runtime should reflect that.
      // We still warm the manifest cache and emit real callable
      // tools — the user's intent ("I added this, let me use it")
      // matches what the runtime now delivers.
      if (toolkitAuthRaw === 'none') {
        let manifest = this.toolsByToolkit.get(toolkitSlug) ?? []
        if (manifest.length === 0 && !this.warmedSlugs.has(toolkitSlug)) {
          await this.warmToolsForToolkit(toolkitSlug)
          manifest = this.toolsByToolkit.get(toolkitSlug) ?? []
        }
        if (manifest.length === 0) {
          stubs.push(this.buildReadyButEmptyStub(appId, toolkitName))
          continue
        }
        // For no-auth toolkits we pass only `vendorUserId` (the
        // install entity_id). Composio's executeAction shape for
        // `no_auth=true` accepts userId alone; no
        // connectedAccountId is required or even meaningful since
        // there's no connected account to point at.
        const noAuthIdentity: ExecuteIdentity = {
          vendorUserId: this.entityId,
        }
        for (const t of manifest) {
          const name = buildToolName(toolkitSlug, t.slug)
          if (seen.has(name)) {
            throw new Error(
              `Composio tool name collision: '${name}' (toolkit '${toolkitSlug}', ` +
                `tool '${t.slug}'). Two Composio tools cannot register under the same Loom tool name.`,
            )
          }
          seen.add(name)
          tools.push(this.buildRealTool({
            toolName: name,
            toolkitSlug,
            composioToolSlug: t.slug,
            description: t.description ?? `${toolkitName} — ${t.slug}`,
            inputSchema: extractJsonSchema(t.input_parameters) ?? EMPTY_SCHEMA,
            executeIdentity: noAuthIdentity,
          }))
        }
        continue
      }

      const active = this.connections.findActive(appId, 'composio', this.entityId)
      if (active?.status === 'ready' && active.authConfigId) {
        // Route identity through the resolver — never derive inline.
        // The resolver reads vendor-frozen columns (vendor_account_id,
        // vendor_user_id) populated at connect-time. Falling back to
        // the live entity_id here was the bug we killed; the resolver
        // throws (loud, attributable) if those columns are missing
        // rather than silently sending a stale entity_id and watching
        // the vendor reject three hops away.
        let executeIdentity: ExecuteIdentity
        try {
          executeIdentity = this.identityResolver.resolveExecuteIdentity(active)
        } catch (err) {
          // Surface as a stub instead of crashing assembly — the user
          // sees a clear "reconnect" message in chat. Other connectors'
          // tools still work.
          this.logFn(
            `[ownware] composio.adapter: identity resolution failed for ${appId}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
          )
          stubs.push(createStubTool({
            toolName: buildToolName(toolkitSlug, 'not_connected'),
            description: `${toolkitName} — vendor identity missing, reconnect required`,
            connectorId: appId,
            connectorName: toolkitName,
            source: 'composio',
            authMode: authModeFor(toolkitAuthRaw, toolkitSlug, toolkitName),
            reason: `${toolkitName} is connected but its vendor identity wasn't recorded. ` +
              `This affects very old connections; reconnect to resolve.`,
          }))
          continue
        }
        let manifest = this.toolsByToolkit.get(toolkitSlug) ?? []
        if (manifest.length === 0 && !this.warmedSlugs.has(toolkitSlug)) {
          // Race window: the toolkit just flipped to `ready` (e.g. user
          // attached + connected mid-chat) and the status-bus listener
          // kicked off `warmToolsForToolkit(slug)` — but the warm hasn't
          // completed yet, so the manifest cache is still empty when
          // this assembly runs.
          //
          // Pre-2026-05-21 we emitted the `_no_tools_loaded` stub here,
          // and the agent dutifully told the user to "open a new chat."
          // The stub was honest (manifest IS empty right now) but
          // misleading (the user had no good way to wait it out).
          //
          // Wait for the warm instead. `warmToolsForToolkit` coalesces
          // an in-flight call from `attachStatusBus`, so if a warm is
          // already running we share its promise — no double network
          // round-trip. On warm failure (network 5xx, vendor 401), the
          // cache stays empty and we fall through to the stub below.
          // Worst-case adds one `listTools` HTTP call (~200ms) to the
          // first reconciled turn after a fresh connect.
          //
          // `warmedSlugs.has(...)` short-circuits the warm on subsequent
          // turns when a prior warm already succeeded — even if it
          // returned zero tools — so toolkits Composio genuinely lists
          // empty don't burn one round-trip per turn forever.
          await this.warmToolsForToolkit(toolkitSlug)
          manifest = this.toolsByToolkit.get(toolkitSlug) ?? []
        }
        if (manifest.length === 0) {
          // Warm either was suppressed (already-warmed-but-empty path),
          // completed with zero tools, or failed and left the cache
          // empty. Surface the stub honestly; the agent can suggest a
          // retry instead of "open a new chat."
          stubs.push(this.buildReadyButEmptyStub(appId, toolkitName))
          continue
        }
        for (const t of manifest) {
          const name = buildToolName(toolkitSlug, t.slug)
          if (seen.has(name)) {
            throw new Error(
              `Composio tool name collision: '${name}' (toolkit '${toolkitSlug}', ` +
                `tool '${t.slug}'). Two Composio tools cannot register under the same Loom tool name.`,
            )
          }
          seen.add(name)
          tools.push(this.buildRealTool({
            toolName: name,
            toolkitSlug,
            composioToolSlug: t.slug,
            description: t.description ?? `${toolkitName} — ${t.slug}`,
            inputSchema: extractJsonSchema(t.input_parameters) ?? EMPTY_SCHEMA,
            executeIdentity,
          }))
        }
      } else {
        // Declared but not connected → byte-parity M1 stub. The client
        // renders an inline "Connect X" card from this.
        const name = buildToolName(toolkitSlug, 'not_connected')
        stubs.push(createStubTool({
          toolName: name,
          description: toolkitDescription ?? `${toolkitName} — not connected`,
          connectorId: appId,
          connectorName: toolkitName,
          source: 'composio',
          authMode: authModeFor(toolkitAuthRaw, toolkitSlug, toolkitName),
          reason: `${toolkitName} is not connected. Use POST /api/v1/connectors/${appId}/connect.`,
        }))
      }
    }

    return { tools, stubs }
  }

  private buildRealTool(spec: {
    readonly toolName: string
    readonly toolkitSlug: string
    readonly composioToolSlug: string
    readonly description: string
    readonly inputSchema: JsonSchema
    /**
     * Vendor identity resolved at assembly time by
     * ConnectorIdentityResolver. Frozen for the life of this Tool
     * instance — `executeTool` sends exactly these fields, never
     * derives anything from current state. The resolver guarantees
     * `connectedAccountId` is set for any ready Composio row (or
     * throws upstream); the execute closure trusts that.
     */
    readonly executeIdentity: ExecuteIdentity
  }): Tool {
    const client = this.client
    const logFn = this.logFn
    const executeIdentity = spec.executeIdentity
    return {
      name: spec.toolName,
      description: spec.description,
      inputSchema: spec.inputSchema,
      isReadOnly: false,
      requiresPermission: true,
      category: 'custom',
      async execute(input): Promise<ToolResult> {
        try {
          // Forward EVERY vendor-frozen identity field the resolver
          // provides. Both `connectedAccountId` and `vendorUserId` are
          // captured at connect-time from the same OAuth handshake, so
          // they can't drift relative to each other; Composio's cross-
          // check (when it runs) sees the values it has on file.
          //
          // Some Composio toolkits (Google Sheets, others) require both
          // together. Sending both universally fixes those without
          // per-toolkit branches and remains safe for toolkits that
          // only need one.
          //
          // We never synthesize identity from local state. See the
          // ConnectorIdentityResolver doc-block for the architectural
          // rule this enforces.
          const resp = await client.executeTool(spec.composioToolSlug, {
            ...(executeIdentity.connectedAccountId !== undefined
              ? { connectedAccountId: executeIdentity.connectedAccountId }
              : {}),
            ...(executeIdentity.vendorUserId !== undefined
              ? { userId: executeIdentity.vendorUserId }
              : {}),
            arguments: input,
          })
          const serialised = JSON.stringify(resp.data ?? {})
          const bytes = Buffer.byteLength(serialised, 'utf8')
          if (bytes > COMPOSIO_RESULT_MAX_BYTES) {
            const head = truncateToBytes(serialised, COMPOSIO_RESULT_MAX_BYTES)
            logFn(
              `[ownware] composio.adapter: truncated result for ${spec.toolName} ` +
                `from ${bytes} to ${COMPOSIO_RESULT_MAX_BYTES} bytes`,
            )
            return {
              content: `${head} …[truncated; original ${bytes} bytes]`,
              isError: !resp.successful,
              metadata: {
                kind: 'composio_result_truncated',
                source: 'composio',
                connectorId: spec.toolkitSlug,
                originalBytes: bytes,
                maxBytes: COMPOSIO_RESULT_MAX_BYTES,
                successful: resp.successful,
              },
            }
          }
          return {
            content: serialised,
            isError: !resp.successful,
            metadata: {
              source: 'composio',
              connectorId: spec.toolkitSlug,
              successful: resp.successful,
              ...(resp.error !== null ? { error: resp.error } : {}),
            },
          }
        } catch (err) {
          return mapExecuteErrorToResult(err, spec.toolkitSlug)
        }
      },
    }
  }

  private buildReadyButEmptyStub(appId: string, name: string): Tool {
    // Uses createStubTool for M1 byte-parity. The "ready but empty
    // manifest" case is a race between connect-success and first sync
    // of the per-toolkit tool list; stub keeps the agent honest.
    return createStubTool({
      toolName: buildToolName(appId, 'no_tools_loaded'),
      description: `${name} — tool manifest not yet loaded`,
      connectorId: appId,
      connectorName: name,
      source: 'composio',
      authMode: { mode: 'oauth', provider: name, hasPreset: false },
      reason: `${name} is connected but its tool manifest has not been loaded yet. Retry shortly.`,
    })
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the Loom tool name: `composio_<toolkit>_<tool>`, sanitised to
 * `[a-z0-9_]+` and deduplicated underscore runs. Exported for tests.
 */
export function buildToolName(toolkitSlug: string, toolSlug: string): string {
  const raw = `composio_${toolkitSlug}_${toolSlug}`
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
}

/** Exported for tests. */
export function mapExecuteErrorToResult(
  err: unknown,
  connectorId: string,
): ToolResult {
  const base = {
    source: 'composio' as const,
    connectorId,
  }
  if (err instanceof ConnectorAuthExpiredError) {
    return errorResult('composio_auth_expired', err, base)
  }
  if (err instanceof ConnectorRateLimitedError) {
    const extra = err.retryAfterMs !== undefined ? { retryAfterMs: err.retryAfterMs } : {}
    return errorResult('composio_rate_limited', err, { ...base, ...extra })
  }
  if (err instanceof ConnectorValidationError) {
    return errorResult('composio_validation_error', err, base)
  }
  if (err instanceof ConnectorNetworkError) {
    return errorResult('composio_network_error', err, base)
  }
  if (err instanceof ConnectorVendorError) {
    const extra = err.statusCode !== undefined ? { statusCode: err.statusCode } : {}
    return errorResult('composio_vendor_error', err, { ...base, ...extra })
  }
  // Unknown — surface as vendor error.
  const message = err instanceof Error ? err.message : String(err)
  return {
    content: `Composio tool failed: ${message}`,
    isError: true,
    metadata: {
      kind: 'composio_vendor_error',
      source: 'composio',
      connectorId,
      message,
    },
  }
}

function errorResult(
  kind: string,
  err: ConnectorError,
  extra: Record<string, unknown>,
): ToolResult {
  return {
    content: `Composio tool failed: ${err.message}`,
    isError: true,
    metadata: {
      kind,
      ...extra,
      message: err.message,
    },
  }
}

function extractJsonSchema(params: Record<string, unknown> | undefined): JsonSchema | null {
  if (!params) return null
  // Composio's `input_parameters` is already a JSON schema fragment.
  // Trust it at the boundary; the runtime validator will reject bad
  // shapes, but we do not re-Zod-validate here (vendor-defined open
  // schema).
  return params as unknown as JsonSchema
}

/**
 * Pull the human description from a Composio toolkit summary, falling
 * back to `null` when absent or empty. Matches the historical
 * `ComposioCatalogEntry.description` contract (string | null).
 */
function summaryDescription(item: ComposioToolkitSummary): string | null {
  const d = item.meta?.description
  return typeof d === 'string' && d.length > 0 ? d : null
}

/**
 * Pick the highest-priority auth scheme from a toolkit summary and
 * return it as the raw string `authModeFor` expects ('oauth2',
 * 'oauth1', 'api_key', 'none'). `no_auth=true` overrides everything.
 * Mirrors the same selection logic the source provider uses for the
 * `AuthMode` of UI connector rows.
 */
function summaryAuthRaw(item: ComposioToolkitSummary): string {
  if (item.no_auth === true) return 'none'
  const schemes = (item.auth_schemes ?? []).map((s) => s.toLowerCase())
  if (
    schemes.includes('oauth2') ||
    schemes.includes('s2s_oauth2') ||
    schemes.includes('dcr_oauth')
  ) {
    return 'oauth2'
  }
  if (schemes.includes('oauth1')) return 'oauth1'
  if (
    schemes.includes('api_key') ||
    schemes.includes('bearer_token') ||
    schemes.includes('basic') ||
    schemes.includes('basic_with_jwt')
  ) {
    return 'api_key'
  }
  if (schemes.includes('no_auth')) return 'none'
  return schemes.length === 0 ? 'none' : 'oauth2'
}

function authModeFor(raw: string, slug: string, name: string): AuthMode {
  switch (raw) {
    case 'oauth2':
    case 'oauth1':
      return { mode: 'oauth', provider: name, hasPreset: false }
    case 'api_key':
    case 'apikey':
      return {
        mode: 'api_key',
        envVars: [{
          name: `${slug.toUpperCase()}_API_KEY`,
          description: `${name} API key`,
          isRequired: true,
          isSecret: true,
        }],
      }
    case 'none':
      return { mode: 'none' }
    default:
      return { mode: 'oauth', provider: name, hasPreset: false }
  }
}

/**
 * Truncate a UTF-8 string to a maximum byte length without splitting a
 * multi-byte codepoint. Binary-safe; returns the unmodified input when
 * `maxBytes` is already sufficient.
 */
export function truncateToBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  // Walk codepoints until the cumulative byte length would exceed maxBytes.
  let bytes = 0
  let out = ''
  for (const ch of text) {
    const chBytes = Buffer.byteLength(ch, 'utf8')
    if (bytes + chBytes > maxBytes) break
    out += ch
    bytes += chBytes
  }
  return out
}
