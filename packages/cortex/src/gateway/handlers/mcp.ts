/**
 * MCP Gateway Handlers
 *
 * Surviving MCP surfaces after T21:
 * - Credentials: save / check / delete API keys for MCP servers
 * - Profile MCP (write side): POST/DELETE attach to a profile's
 *   agent.json — the GET listing was retired in favour of
 *   GET /api/v1/connectors?profileId=X&source=mcp
 * - Live connection: standalone POST /mcp/connect/:id ping
 * - OAuth2 PKCE flow: start / wait / status / cancel
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { execFile } from 'node:child_process'
import { sendJSON, sendError, readJSON } from '../router.js'
import { classifyError } from '../../errors/classify.js'
import type { MCPMarketplaceEnvVar } from '../types.js'
import { getRegistryEntry, credentialStore, getFeaturedServers } from '../../connector/index.js'
import { parseCanonicalConnectorId } from '../../connector/schema.js'
import type { MCPRegistryEntry } from '../../connector/types.js'

/**
 * The client sends canonical connector ids (`mcp:gmail`) for entries surfaced by
 * the unified `/connectors` endpoint, but the MCP DB rows + `featured.ts`
 * entries + remote registry all key by bare id (`gmail`). Strip the `mcp:`
 * prefix at the boundary so callers can use either format. Non-mcp prefixes
 * (e.g. `composio:` accidentally hitting an `/mcp/*` endpoint) are returned
 * untouched and will 404 on lookup, which is the correct error.
 */
function resolveMCPServerId(serverId: string): string {
  const parsed = parseCanonicalConnectorId(serverId)
  return parsed?.source === 'mcp' ? parsed.id : serverId
}
import type { ProfileRegistry } from '../../profile/registry.js'
import {
  MCPClient,
  startOAuthFlow,
  discoverOAuthEndpoints,
  registerOAuthClient,
  buildRedirectUri,
  findAvailablePort,
  OAuthDiscoveryError,
  DynamicClientRegistrationError,
} from '@ownware/loom'
import type { MCPServerConfig as LoomMCPServerConfig, OAuthFlowConfig, OAuthTokens } from '@ownware/loom'
import { getOAuthPreset } from '../../connector/mcp/oauth-presets.js'
import { validateClientId } from '../../connector/mcp/oauth-validators.js'
import { resolveEnvStringWithFallback } from '../../profile/env.js'
import type { ConnectorStatusBus } from '../../connector/status-bus.js'
import type { AuthMode, ConnectorStatus } from '../../connector/schema.js'
import { computeConnectorStatus } from '../../connector/status.js'
import { buildMCPClientConfig } from '../../connector/spawn.js'
import { credentialVault } from '../../connector/credentials/vault.js'
import { RUNTIME_SETUP_COMPLETED_KEY } from '../../connector/registry.js'

// ---------------------------------------------------------------------------
// In-memory credential cache (replaces process.env mutation)
// ---------------------------------------------------------------------------

/** Cached credentials from recent saves — avoids mutating process.env. */
const envCache = new Map<string, Record<string, string>>()

// ---------------------------------------------------------------------------
// OAuth flow tracking (in-memory — single-process gateway)
// ---------------------------------------------------------------------------

/** Active OAuth flows. Keyed by serverId. */
interface ActiveFlow {
  readonly promise: Promise<OAuthTokens>
  readonly shutdown: () => void
}
const activeTokenPromises = new Map<string, ActiveFlow>()

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

export interface MCPHandlersDeps {
  /** Status bus — emitted on credential / profile-attachment transitions. */
  readonly statusBus?: ConnectorStatusBus
  /**
   * User profiles directory. ALL writes (add/remove MCP server) target
   * this dir. If a profile is built-in, the registry forks it here on
   * first write. Required when MCP edits are exposed.
   */
  readonly userProfilesDir?: string
  /**
   * Per-thread pending-reconcile tracker. When provided, a successful
   * MCP attach/detach marks every thread on the affected profile so
   * its next turn runs a reconcile. Omitted — existing behaviour
   * unchanged.
   *
   * v1 NOTE: MCP server lifecycle (connect the new server, shut down
   * the removed one) is a v2 concern documented on the reconcile
   * board. Marking the thread is still the right thing today — v2
   * will add the MCPManager handling and the mark propagation is
   * already in place.
   */
  readonly pendingReconciles?: import('../pending-reconcile.js').PendingReconciles
}

/**
 * Compute the current `ConnectorStatus` for an MCP server id from
 * credential state. Delegates to the unified pure function in
 * `connector/status.ts` after hydrating its inputs from the featured
 * catalog + vault. Replaces the pre-Phase 5 inline implementation that
 * had the lying-badge bug for OAuth servers with empty `requiredEnv`.
 */
async function computeMCPStatus(serverId: string): Promise<ConnectorStatus> {
  const bareId = resolveMCPServerId(serverId)
  const feat = getFeaturedServers().find(f => f.id === bareId)
  const skipRemote = process.env['OWNWARE_SKIP_MCP_REGISTRY'] === '1'
  const entry = feat
    ? null
    : skipRemote
      ? null
      : await getRegistryEntry(bareId).catch(() => null)
  const requiredVars = entry?.requiredEnv ?? feat?.requiredEnv ?? []

  // Derive auth mode (mirrors registry.ts mcpServerToConnector). OAuth
  // preset > runtime-setup > api_key (any required vars) > none.
  const oauthPreset = getOAuthPreset(bareId)
  let auth: AuthMode
  if (oauthPreset) {
    auth = { mode: 'oauth', provider: feat?.title ?? entry?.title ?? bareId, hasPreset: true }
  } else if (feat?.authType === 'runtime-setup' && feat.setupHint) {
    auth = { mode: 'runtime_setup', hint: feat.setupHint, command: feat.setupCommand ?? null }
  } else if (requiredVars.length === 0) {
    auth = { mode: 'none' }
  } else {
    auth = {
      mode: 'api_key',
      envVars: requiredVars.map(v => ({
        name: v.name,
        description: v.description,
        isRequired: v.isRequired,
        isSecret: v.isSecret,
        ...(v.helpUrl !== undefined && { helpUrl: v.helpUrl }),
      })),
    }
  }

  const envCheck = requiredVars.length > 0
    ? await credentialStore.checkEnvVars(bareId, requiredVars.map(v => v.name))
    : {}
  const oauthBundle = auth.mode === 'oauth' ? await credentialVault.load(bareId) : null
  const oauthBundlePresent =
    oauthBundle != null && Object.values(oauthBundle.env).some(v => v.length > 0)
  const runtimeSetupCheck = auth.mode === 'runtime_setup'
    ? await credentialVault.checkEnvVars(bareId, [RUNTIME_SETUP_COMPLETED_KEY])
    : { [RUNTIME_SETUP_COMPLETED_KEY]: false }
  const runtimeSetupComplete = runtimeSetupCheck[RUNTIME_SETUP_COMPLETED_KEY] === true

  return computeConnectorStatus({
    auth,
    transport: feat?.transport,
    envCheck,
    requiredVars: requiredVars.map(v => ({ name: v.name, isRequired: v.isRequired })),
    oauthBundlePresent,
    runtimeSetupComplete,
  })
}

export function createMCPHandlers(
  registry: ProfileRegistry,
  state?: import('../state.js').GatewayState,
  deps: MCPHandlersDeps = {},
) {
  const { statusBus, userProfilesDir, pendingReconciles } = deps

  /**
   * Mark every thread on this profile as pending reconcile. Mirrors
   * the helper in `handlers/profiles.ts`; kept local here so the
   * MCP handlers don't need to reach across files for a single
   * routine. No-op when tracker or state isn't wired.
   */
  function markThreadsForProfileReconcile(profileId: string): void {
    if (pendingReconciles === undefined || state === undefined) return
    const threads = state.listThreads(profileId, { limit: 10_000 })
    for (const thread of threads.items) {
      pendingReconciles.mark(thread.id)
    }
  }

  // T21 (2026-04-22): listFeatured / listMarketplace / getMarketplaceEntry
  // removed. The client reads featured + marketplace through the unified
  // GET /api/v1/catalog endpoint (`?source=mcp&featured=true` etc.).

  // ── Credentials ──────────────────────────────────────────────────────

  /**
   * POST /api/v1/mcp/credentials/:serverId
   * Save credentials (env vars) for an MCP server.
   */
  async function saveCredentials(req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const serverId = params['serverId']!
    const bareId = resolveMCPServerId(serverId)
    const body = await readJSON<{ env: Record<string, string> }>(req)

    if (!body?.env || typeof body.env !== 'object') {
      sendError(res, 400, 'Missing required field: env (object of env var name → value)')
      return
    }

    // Filter out empty values
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(body.env)) {
      if (typeof value === 'string' && value.trim()) {
        env[key] = value.trim()
      }
    }

    const priorStatus = statusBus ? await computeMCPStatus(bareId) : null

    await credentialStore.save(bareId, env)

    // Cache in-memory for immediate availability (no process.env mutation)
    envCache.set(bareId, { ...env })

    if (statusBus) {
      const nextStatus = await computeMCPStatus(bareId)
      statusBus.emit({
        connectorId: bareId,
        source: 'mcp',
        status: nextStatus,
        previousStatus: priorStatus,
        reason: 'Credentials saved',
      })
    }

    sendJSON(res, 200, { serverId, saved: Object.keys(env).length })
  }

  /**
   * GET /api/v1/mcp/credentials/:serverId
   * Check which env vars are set for an MCP server.
   * Does NOT return the actual values (security).
   */
  async function checkCredentials(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const serverId = params['serverId']!
    const bareId = resolveMCPServerId(serverId)

    // Featured first, remote registry only as the fallback — and only
    // when not skipped. Mirrors computeMCPStatus: without this guard a
    // cold/expired registry cache turned a credentials check into a
    // multi-page network walk that could hang the request.
    const featured = getFeaturedServers().find(f => f.id === bareId) ?? null
    const skipRemote = process.env['OWNWARE_SKIP_MCP_REGISTRY'] === '1'
    const entry = featured || skipRemote ? null : await getRegistryEntry(bareId).catch(() => null)
    const allVars = entry ? [...(entry.requiredEnv ?? []), ...(entry.optionalEnv ?? [])]
      : featured ? [...featured.requiredEnv] : []
    const varNames = allVars.map(v => v.name)

    const status = await credentialStore.checkEnvVars(bareId, varNames)

    const envStatus: MCPMarketplaceEnvVar[] = allVars.map(v => ({
      name: v.name,
      description: v.description,
      isRequired: v.isRequired,
      isSecret: v.isSecret,
      isSet: status[v.name] ?? false,
      ...(v.helpUrl != null ? { helpUrl: v.helpUrl } : {}),
      ...(v.transform != null ? { transform: v.transform } : {}),
    }))

    const allRequiredSet = allVars
      .filter(v => v.isRequired)
      .every(v => status[v.name])

    sendJSON(res, 200, { serverId, envStatus, isReady: allRequiredSet })
  }

  /**
   * DELETE /api/v1/mcp/credentials/:serverId
   * Delete stored credentials for an MCP server.
   */
  async function deleteCredentials(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const serverId = resolveMCPServerId(params['serverId']!)
    const priorStatus = statusBus ? await computeMCPStatus(serverId) : null
    await credentialStore.delete(serverId)
    envCache.delete(serverId)
    if (statusBus) {
      const nextStatus = await computeMCPStatus(serverId)
      statusBus.emit({
        connectorId: serverId,
        source: 'mcp',
        status: nextStatus,
        previousStatus: priorStatus,
        reason: 'Credentials deleted',
      })
    }
    res.writeHead(204)
    res.end()
  }

  // ── Profile MCP management ──────────────────────────────────────────
  //
  // T21 (2026-04-22): the GET /api/v1/profiles/:profileId/mcp listing
  // handler was removed. The client reads per-profile connector status via
  // GET /api/v1/connectors?profileId=X&source=mcp. The POST/DELETE
  // mutators below survive — they write to the profile's agent.json and
  // have no equivalent on the unified surface.

  /**
   * POST /api/v1/profiles/:profileId/mcp
   * Add an MCP server to a profile.
   * Body: { serverId: "io.github.user/weather" }
   */
  async function addMCPToProfile(req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const profileId = params['profileId']!
    const body = await readJSON<{ serverId: string }>(req)

    if (!body?.serverId) {
      sendError(res, 400, 'Missing required field: serverId')
      return
    }

    if (!registry.has(profileId)) {
      sendError(res, 404, `Profile "${profileId}" not found`)
      return
    }

    // Check local sources first (DB, featured), remote registry last.
    const bareServerId = resolveMCPServerId(body.serverId)
    const customRow = state?.getMCPServer(bareServerId) ?? null
    const featured = getFeaturedServers().find(f => f.id === bareServerId) ?? null
    const skipRemoteAttach = process.env['OWNWARE_SKIP_MCP_REGISTRY'] === '1'
    const entry = (!customRow && !featured && !skipRemoteAttach)
      ? await getRegistryEntry(bareServerId).catch(() => null)
      : null

    // Build MCP config for the profile
    let mcpConfig: Record<string, unknown>
    let displayName: string

    if (customRow) {
      displayName = customRow.name
      // Propagate the declared env / header NAMES into the profile's
      // agent.json so the catalog hydrator sees the same auth surface
      // for attached and unattached states. Without this copy the
      // profile-attached view falls back to auth.mode='none' and the
      // connector card flips to a misleading "Ready" badge regardless
      // of whether credentials were actually entered. Placeholder
      // empty-string values match the same convention the register
      // handler writes — real values are merged from the vault at
      // session-spawn time.
      if (customRow.transport === 'stdio') {
        mcpConfig = {
          transport: 'stdio',
          command: customRow.command ?? '',
          args: customRow.args.length > 0 ? [...customRow.args] : undefined,
          ...(Object.keys(customRow.env).length > 0
            ? { env: { ...customRow.env } }
            : {}),
        }
      } else {
        mcpConfig = {
          transport: customRow.transport === 'http' ? 'streamable_http' : customRow.transport,
          url: customRow.url ?? '',
          ...(Object.keys(customRow.headers).length > 0
            ? { headers: { ...customRow.headers } }
            : {}),
        }
      }
    } else if (entry) {
      // From registry
      displayName = entry.title
      if (entry.transport === 'stdio' && entry.package) {
        mcpConfig = {
          transport: 'stdio',
          command: entry.runtime ?? 'npx',
          args: entry.runtime === 'npx'
            ? ['-y', entry.package, ...entry.packageArgs]
            : [entry.package, ...entry.packageArgs],
          env: buildEnvRefs(entry),
        }
      } else if (entry.remoteUrl) {
        mcpConfig = {
          transport: entry.transport === 'http' ? 'streamable_http' : entry.transport,
          url: entry.remoteUrl,
        }
      } else {
        sendError(res, 422, `Registry entry "${body.serverId}" has no installable package or remote URL`)
        return
      }
    } else if (featured) {
      displayName = featured.title
      const t = featured.transport
      if (!t) {
        sendError(res, 500, `Featured server "${body.serverId}" missing transport definition`)
        return
      }
      if (t.kind === 'stdio') {
        const featArgs = t.runtime === 'npx'
          ? ['-y', t.package, ...(t.args ?? [])]
          : [t.package, ...(t.args ?? [])]
        const envRefs: Record<string, string> = {}
        for (const v of featured.requiredEnv) { envRefs[v.name] = `\${${v.name}}` }
        mcpConfig = {
          transport: 'stdio',
          command: t.runtime,
          args: featArgs,
          env: Object.keys(envRefs).length > 0 ? envRefs : undefined,
        }
      } else if (t.kind === 'http_remote') {
        mcpConfig = { transport: 'streamable_http', url: t.url }
      } else {
        sendError(res, 422, `Featured server "${body.serverId}" uses bridge transport — register via auto-detect`)
        return
      }
    } else {
      sendError(res, 404, `MCP server "${body.serverId}" not found in local database, featured catalog, or registry.`)
      return
    }

    // Add to profile's agent.json
    try {
      if (!userProfilesDir) {
        sendError(res, 500, 'MCP write disabled: gateway constructed without userProfilesDir')
        return
      }
      await registry.updateProfileMCP(profileId, bareServerId, mcpConfig, userProfilesDir)

      // Also populate database tables (for queryable UI)
      if (state) {
        const transport = (mcpConfig.transport === 'streamable_http' ? 'http' : mcpConfig.transport) as string
        if (!state.getMCPServer(bareServerId)) {
          state.createMCPServer({
            id: bareServerId,
            name: displayName,
            transport,
            url: mcpConfig.url as string | undefined,
            command: mcpConfig.command as string | undefined,
            args: mcpConfig.args as string[] | undefined,
            registryId: entry ? bareServerId : undefined,
          })
        }
        state.assignServerToProfile(bareServerId, profileId)
      }

      markThreadsForProfileReconcile(profileId)
      sendJSON(res, 201, {
        serverId: body.serverId,
        name: displayName,
        status: 'configured',
      })
    } catch (err) {
      const classified = classifyError(err)
      sendError(
        res,
        500,
        `Failed to update profile: ${err instanceof Error ? err.message : String(err)}`,
        undefined,
        classified.category,
      )
    }
  }

  /**
   * DELETE /api/v1/profiles/:profileId/mcp/:serverId
   * Remove an MCP server from a profile.
   */
  async function removeMCPFromProfile(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const profileId = params['profileId']!
    const serverId = resolveMCPServerId(params['serverId']!)

    if (!registry.has(profileId)) {
      sendError(res, 404, `Profile "${profileId}" not found`)
      return
    }

    try {
      if (!userProfilesDir) {
        sendError(res, 500, 'MCP write disabled: gateway constructed without userProfilesDir')
        return
      }
      await registry.removeProfileMCP(profileId, serverId, userProfilesDir)

      // Also update database junction
      if (state) {
        state.removeServerFromProfile(serverId, profileId)
      }

      // Disconnect any live MCP managers for this profile that have
      // this server attached. Hazard 21: previously read a never-
      // populated map and skipped the cleanup entirely. Now scans
      // every active thread.
      if (state) {
        for (const { threadId } of state.listActiveRuntimes()) {
          const mgr = state.getMCPManager(threadId)
          if (mgr?.getServer(serverId)) {
            try { await mgr.removeServer(serverId) } catch { /* best-effort */ }
          }
        }
      }

      markThreadsForProfileReconcile(profileId)
      res.writeHead(204)
      res.end()
    } catch (err) {
      const classified = classifyError(err)
      sendError(
        res,
        500,
        `Failed to update profile: ${err instanceof Error ? err.message : String(err)}`,
        undefined,
        classified.category,
      )
    }
  }

  // ── Live connection ──────────────────────────────────────────────────

  /**
   * POST /api/v1/mcp/connect/:serverId
   * Connect to an MCP server and discover its tools.
   * Standalone test connection (not profile-bound).
   */
  async function connectServer(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const serverId = resolveMCPServerId(params['serverId']!)

    // Check local sources first (DB, featured), remote registry last.
    const dbRow = state?.getMCPServer(serverId) ?? null
    const featured = getFeaturedServers().find(f => f.id === serverId) ?? null
    const skipRemoteConnect = process.env['OWNWARE_SKIP_MCP_REGISTRY'] === '1'
    const entry = (!dbRow && !featured && !skipRemoteConnect)
      ? await getRegistryEntry(serverId).catch(() => null)
      : null

    if (!dbRow && !entry && !featured) {
      sendError(res, 404, `MCP server "${serverId}" not found in local database, featured catalog, or registry`)
      return
    }

    // Resolve credentials
    const requiredVars = entry ? entry.requiredEnv : featured ? [...featured.requiredEnv] : []
    const optionalVars = entry ? entry.optionalEnv : []
    const allEnvNames = [...requiredVars, ...optionalVars].map(v => v.name)
    const env = await credentialStore.resolveEnv(serverId, allEnvNames)

    // Check required (DB-only servers have no declared env vars — skip)
    const missing = requiredVars.filter(v => !env[v.name])
    if (missing.length > 0) {
      sendError(res, 422, `Missing required credentials: ${missing.map(v => v.name).join(', ')}`)
      return
    }

    // Build Loom config — DB row first, then registry, then featured
    let config: LoomMCPServerConfig

    if (dbRow) {
      const transport = dbRow.transport === 'http' ? 'http' : dbRow.transport
      if (transport === 'stdio' && dbRow.command) {
        config = {
          name: serverId,
          transport: 'stdio',
          command: dbRow.command,
          args: dbRow.args.length > 0 ? [...dbRow.args] : [],
          env,
        }
      } else if (dbRow.url) {
        config = {
          name: serverId,
          transport: transport as 'http' | 'sse',
          url: dbRow.url,
        }
      } else {
        sendError(res, 422, `MCP server "${serverId}" has no command or URL configured`)
        return
      }
    } else if (entry && entry.transport === 'stdio' && entry.package) {
      const rawArgs = entry.runtime === 'npx'
        ? ['-y', entry.package, ...entry.packageArgs]
        : [entry.package, ...entry.packageArgs]
      const args = rawArgs.map((a, i) =>
        resolveEnvStringWithFallback(a, env, `${serverId}.args[${i}]`),
      )

      config = {
        name: serverId,
        transport: 'stdio',
        command: entry.runtime ?? 'npx',
        args,
        env,
      }
    } else if (entry && entry.remoteUrl) {
      config = {
        name: serverId,
        transport: entry.transport === 'http' ? 'http' : 'sse',
        url: entry.remoteUrl,
      }
    } else if (featured) {
      const t = featured.transport
      if (t.kind === 'http_bridge') {
        sendError(res, 422, `Featured server "${serverId}" uses bridge transport — connect via auto-detect`)
        return
      }
      // Featured servers may declare args templates like `${VAR}` or
      // `--api-key=${VAR}`. Resolve against the stored credential env.
      config = buildMCPClientConfig({
        name: serverId,
        transport: t,
        env,
        transformArg: (a, i) => resolveEnvStringWithFallback(a, env, `${serverId}.args[${i}]`),
      })
    } else {
      sendError(res, 422, `Cannot determine how to connect to "${serverId}"`)
      return
    }

    // Audit Hazard 25 fix (2026-04-11): the previous code only called
    // client.disconnect() on the success path. If listTools or
    // listResources threw mid-flow, the spawned MCP child process was
    // orphaned — the gateway forgot about it but it kept running.
    // Repeating the install several times piled up zombies. The
    // try/finally below guarantees the client is always disconnected,
    // success or failure.
    const client = new MCPClient(config)
    try {
      await client.connect()
      const capabilities = client.getCapabilities()

      // Respect the capabilities declared at initialize time. Calling
      // `tools/list` or `resources/list` on a server that doesn't declare
      // support returns "Method not found" and breaks the whole connect.
      // Servers like filesystem/git/memory/fetch/sequential-thinking only
      // support tools, not resources.
      const tools = capabilities?.tools ? await client.listTools() : []
      const resources = capabilities?.resources ? await client.listResources() : []

      const toolsMetadata = tools.map(t => ({
        name: t.name,
        description: t.description ?? '',
        inputSchema: t.inputSchema,
        annotations: t.annotations,
      }))

      if (state != null) {
        state.updateMCPServer(serverId, {
          status: 'connected',
          toolCount: tools.length,
          toolsJson: JSON.stringify(toolsMetadata),
        })
      }

      sendJSON(res, 200, {
        serverId,
        status: 'connected',
        capabilities,
        tools: toolsMetadata,
        resources: resources.map(r => ({
          uri: r.uri,
          name: r.name,
          description: r.description,
          mimeType: r.mimeType,
        })),
        toolCount: tools.length,
        resourceCount: resources.length,
      })
    } catch (err) {
      sendError(res, 502, `Connection failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      // Best-effort cleanup. disconnect() handles "already disconnected"
      // gracefully, and we never want a cleanup failure to override the
      // primary error reported above.
      try { await client.disconnect() } catch { /* best-effort */ }
    }
  }

  // T21 (2026-04-22): GET /api/v1/mcp/servers (the cross-profile
  // installed listing) was removed. The client reads installed MCP via
  // GET /api/v1/connectors?source=mcp instead — the unified surface
  // already aggregates per-profile MCP rows from every discovered
  // profile and surfaces the same per-row status data.

  // ── OAuth2 flow ────────────────────────────────────────────────────

  /**
   * POST /api/v1/mcp/oauth/start/:serverId
   *
   * Start an OAuth2 PKCE flow for an MCP server.
   * Returns { authUrl, state, serverId } — open authUrl in the browser.
   *
   * Body (optional):
   *   { clientId?: string, clientSecret?: string, scopes?: string[] }
   *   If not provided, uses the preset for this serverId.
   */
  async function startOAuth(req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const serverId = resolveMCPServerId(params['serverId']!)

    // Parse body first so we can validate before doing anything else
    const body = await readJSON<{
      clientId?: string
      clientSecret?: string
      scopes?: string[]
    }>(req)

    const preset = getOAuthPreset(serverId)
    let clientId = body?.clientId ?? preset?.clientId

    // Resolve OAuth endpoints. Three paths:
    //
    //   (a) **Preset path** — `oauth-presets.ts` carries the AS endpoints
    //       and a pre-registered client_id (Notion, GitHub, etc.). This is
    //       the legacy behaviour and keeps working unchanged.
    //   (b) **Dynamic path** — when no preset exists, run the MCP 2025-03-26
    //       discovery flow (`discoverOAuthEndpoints`) against the server's
    //       URL. If the AS supports RFC 7591 dynamic client registration,
    //       call `registerOAuthClient` to obtain a fresh client_id. This
    //       unblocks Figma-MCP and every future dynamic-OAuth MCP without
    //       per-app code.
    //   (c) **Body path** — caller supplies `{ clientId, ... }` and we
    //       trust it (still requires preset endpoints today; the dynamic
    //       path below covers the no-preset case).
    let authorizationUrl: string | undefined = preset?.authorizationUrl
    let tokenUrl: string | undefined = preset?.tokenUrl
    let clientSecret: string | undefined = body?.clientSecret ?? preset?.clientSecret
    let scopesFromDiscovery: readonly string[] | undefined
    let preallocatedCallbackPort: number | undefined

    if (!preset && !clientId) {
      // Path (b): try dynamic discovery + registration.
      const dbRow = state?.getMCPServer(serverId) ?? null
      const serverUrl = dbRow?.url ?? null
      if (!serverUrl) {
        sendJSON(res, 422, {
          error: 'missing_client_id',
          message: `No OAuth preset for "${serverId}" and no server URL on file — cannot run dynamic discovery. Either register an OAuth app and pass { clientId } in the body, or attach the server with a URL first.`,
        })
        return
      }
      try {
        const discovered = await discoverOAuthEndpoints(serverUrl)
        if (!discovered) {
          sendJSON(res, 422, {
            error: 'oauth_not_supported',
            message: `Server at ${serverUrl} did not advertise OAuth metadata (no \`resource_metadata\` on its WWW-Authenticate header). It may not require OAuth, or may use a non-spec auth flow.`,
          })
          return
        }
        if (!discovered.registrationEndpoint) {
          sendJSON(res, 422, {
            error: 'dynamic_registration_unavailable',
            message: `Authorization server at ${discovered.authorizationServerUrl} does not advertise a registration_endpoint — cannot create a client without a pre-registered OAuth app. Register manually and pass { clientId } in the body.`,
          })
          return
        }
        // Register a fresh client. The redirect URI must match the
        // localhost callback the existing PKCE flow will spin up; we
        // pre-allocate a port here and pass it down.
        const callbackPort = await findAvailablePort()
        const redirectUri = buildRedirectUri(callbackPort)
        const registered = await registerOAuthClient(
          discovered.registrationEndpoint,
          {
            redirectUris: [redirectUri],
            scopes: body?.scopes ?? [...(discovered.scopesSupported ?? [])],
            clientName: 'Cortex',
            tokenEndpointAuthMethod: 'none',
          },
        )
        clientId = registered.clientId
        clientSecret = registered.clientSecret ?? undefined
        authorizationUrl = discovered.authorizationEndpoint
        tokenUrl = discovered.tokenEndpoint
        scopesFromDiscovery = discovered.scopesSupported ?? undefined

        // Persist the issued client credentials so a subsequent reconnect
        // doesn't need to re-register. Stored under a dedicated vault key
        // keyed by serverId; the standard `serverId` key holds the env
        // bag the MCP server reads at runtime.
        await credentialStore.save(`${serverId}__oauth_client`, {
          clientId: registered.clientId,
          clientSecret: registered.clientSecret ?? '',
          authorizationEndpoint: discovered.authorizationEndpoint,
          tokenEndpoint: discovered.tokenEndpoint,
          registrationEndpoint: discovered.registrationEndpoint,
          callbackPort: String(callbackPort),
        })

        // Stash the pre-allocated port so the OAuthFlowConfig built below
        // re-uses the port we registered with the AS as the redirect_uri.
        preallocatedCallbackPort = callbackPort
      } catch (err) {
        if (err instanceof OAuthDiscoveryError) {
          sendJSON(res, 502, {
            error: 'oauth_discovery_failed',
            message: `OAuth discovery for "${serverId}" failed at the ${err.hop} hop: ${err.message}`,
          })
          return
        }
        if (err instanceof DynamicClientRegistrationError) {
          sendJSON(res, 502, {
            error: 'dynamic_registration_failed',
            message: `OAuth client registration for "${serverId}" failed${err.status ? ` (HTTP ${err.status})` : ''}: ${err.message}`,
          })
          return
        }
        throw err
      }
    }

    // Error 1: no client_id provided and none in preset / dynamic path
    if (!clientId) {
      sendJSON(res, 422, {
        error: 'missing_client_id',
        message: `No OAuth client_id for "${serverId}". Register an OAuth app and pass { clientId } in the request body.`,
      })
      return
    }

    // Error 2: client_id format validation. Skip when the client_id was
    // freshly issued by RFC 7591 dynamic registration — those values
    // come from the AS itself and have no provider-specific format.
    if (preset && body?.clientId === undefined && scopesFromDiscovery === undefined) {
      // We're on the preset path with the preset's own client_id.
      const validation = validateClientId(serverId, clientId)
      if (!validation.valid) {
        sendJSON(res, 422, {
          error: validation.code ?? 'invalid_client_id',
          message: validation.message ?? 'Client ID is invalid.',
        })
        return
      }
    } else if (body?.clientId !== undefined) {
      // User-supplied client_id — validate.
      const validation = validateClientId(serverId, clientId)
      if (!validation.valid) {
        sendJSON(res, 422, {
          error: validation.code ?? 'invalid_client_id',
          message: validation.message ?? 'Client ID is invalid.',
        })
        return
      }
    }

    // Error 3: endpoints still missing after every resolution path.
    if (!authorizationUrl || !tokenUrl) {
      sendJSON(res, 422, {
        error: 'missing_oauth_endpoints',
        message: `No OAuth endpoints configured for "${serverId}".`,
      })
      return
    }

    // If there's a stale flow, cancel it automatically instead of returning 409.
    // This makes "Try again" just work — stale state gets cleaned up.
    const existing = activeTokenPromises.get(serverId)
    if (existing) {
      existing.shutdown()
      activeTokenPromises.delete(serverId)
    }

    const config: OAuthFlowConfig = {
      serverId,
      clientId,
      clientSecret,
      scopes: body?.scopes ?? preset?.scopes ?? scopesFromDiscovery ?? [],
      authorizationUrl,
      tokenUrl,
      // When we ran dynamic registration we pre-allocated a port for the
      // redirect_uri we registered with the AS; pass it down so the
      // callback server binds to the same one.
      ...(typeof preallocatedCallbackPort === 'number'
        ? { callbackPort: preallocatedCallbackPort }
        : {}),
    }

    try {
      const { authUrl, pendingFlow, waitForTokens, shutdown } = await startOAuthFlow(config)

      // Track the flow so we can clean up
      activeTokenPromises.set(serverId, { promise: waitForTokens, shutdown })

      // When tokens arrive, save them as credentials.
      //
      // 2026-04-11 audit Hazard 22 fix: presets can now provide a
      // `tokenTransform(tokens) → Record<string, string>` so providers
      // whose MCP server expects something other than a bare access
      // token (e.g. Notion's OPENAPI_MCP_HEADERS JSON) can map the
      // OAuth result into the right shape. If a transform is set it
      // wins; otherwise we fall back to the legacy single-env-var
      // mapping via `tokenToEnv`.
      waitForTokens.then(async (tokens) => {
        let env: Record<string, string>
        if (preset?.tokenTransform) {
          env = preset.tokenTransform(tokens)
        } else {
          const envVarName = preset?.tokenToEnv ?? `${serverId.toUpperCase()}_ACCESS_TOKEN`
          env = { [envVarName]: tokens.accessToken }
        }

        // Save as encrypted credentials (same path as manual API key entry)
        await credentialStore.save(serverId, env)
        envCache.set(serverId, env)

        // Also store the full OAuth tokens for refresh support
        await credentialStore.save(`${serverId}__oauth`, {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken ?? '',
          expiresAt: String(tokens.expiresAt),
          scope: tokens.scope ?? '',
          tokenType: tokens.tokenType,
        })
      }).catch(() => {
        // Error handled by the waitForTokens caller
      }).finally(() => {
        activeTokenPromises.delete(serverId)
      })

      // Audit Hazard 20 fix (2026-04-11): use execFile, NOT exec, so the
      // URL is passed as a positional argv element rather than spliced
      // into a shell command line. The previous `exec(\`${openCmd} "${authUrl}"\`)`
      // was URL-encoded today so it was technically safe — but a single
      // future change to the URL builder that bypassed encoding would
      // turn this into a one-shot RCE. execFile takes the binary +
      // argv array directly; no shell, no metachar interpretation.
      //
      // Windows note: `start` is a cmd.exe builtin, not an executable,
      // so we have to invoke it via `cmd.exe /c start "" <url>`. The
      // empty quoted string is the window title that `start` requires
      // when its first arg starts with a quoted URL.
      let openBin: string
      let openArgs: string[]
      if (process.platform === 'darwin') {
        openBin = 'open'
        openArgs = [authUrl]
      } else if (process.platform === 'win32') {
        openBin = 'cmd.exe'
        openArgs = ['/c', 'start', '', authUrl]
      } else {
        openBin = 'xdg-open'
        openArgs = [authUrl]
      }

      execFile(openBin, openArgs, (err) => {
        if (err) {
          // Browser may not open (headless server) — URL is in the response.
          // We don't log the URL itself because it contains the OAuth
          // state token; logging just the error message keeps the
          // session tied to the dialog state, not to disk logs.
          console.warn(`[oauth] Could not open browser: ${err.message}`)
        }
      })

      sendJSON(res, 200, {
        serverId,
        authUrl,
        state: pendingFlow.state,
        callbackPort: pendingFlow.callbackPort,
        message: 'OAuth flow started. Complete authentication in your browser.',
      })
    } catch (err) {
      activeTokenPromises.delete(serverId)
      sendJSON(res, 500, {
        error: 'oauth_start_failed',
        message: `Failed to start OAuth flow: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }

  /**
   * GET /api/v1/mcp/oauth/status/:serverId
   *
   * Check the status of an OAuth flow.
   * Returns { status: 'pending' | 'completed' | 'none' }
   */
  async function oauthStatus(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const serverId = resolveMCPServerId(params['serverId']!)

    if (activeTokenPromises.has(serverId)) {
      sendJSON(res, 200, { serverId, status: 'pending', message: 'Waiting for browser authentication...' })
      return
    }

    // Check if we have stored OAuth tokens
    const oauthCreds = await credentialStore.load(`${serverId}__oauth`)
    if (oauthCreds?.env.accessToken) {
      // Hazard 29 fix (2026-04-11): a corrupted/missing expiresAt
      // would parseInt to NaN, then `Date.now() > NaN === false`
      // and the token reported as authenticated forever. Reject NaN
      // explicitly and treat it as "no expiry info, assume valid".
      const rawExpiresAt = parseInt(oauthCreds.env.expiresAt ?? '0', 10)
      const expiresAt = Number.isFinite(rawExpiresAt) ? rawExpiresAt : 0
      const isExpired = expiresAt > 0 && Date.now() > expiresAt

      sendJSON(res, 200, {
        serverId,
        status: isExpired ? 'expired' : 'authenticated',
        expiresAt: expiresAt || null,
        scope: oauthCreds.env.scope || null,
      })
      return
    }

    sendJSON(res, 200, { serverId, status: 'none' })
  }

  /**
   * POST /api/v1/mcp/oauth/wait/:serverId
   *
   * Long-poll: wait for an active OAuth flow to complete.
   * Returns the result when the user finishes authentication in the browser.
   * Times out after 5 minutes.
   */
  async function oauthWait(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const serverId = resolveMCPServerId(params['serverId']!)

    const activeFlow = activeTokenPromises.get(serverId)
    if (!activeFlow) {
      sendJSON(res, 404, {
        error: 'no_active_flow',
        message: `No active OAuth flow for "${serverId}". Call POST /mcp/oauth/start/${serverId} first.`,
      })
      return
    }

    try {
      const tokens = await activeFlow.promise
      sendJSON(res, 200, {
        serverId,
        status: 'authenticated',
        expiresAt: tokens.expiresAt,
        scope: tokens.scope ?? null,
        message: 'OAuth authentication successful. Credentials saved.',
      })
    } catch (err) {
      // Distinguish specific OAuth failure modes
      const msg = err instanceof Error ? err.message : String(err)
      const code = err instanceof Error && 'code' in err && typeof err.code === 'string'
        ? err.code
        : 'oauth_flow_failed'
      sendJSON(res, 400, {
        error: code,
        message: `OAuth flow failed: ${msg}`,
      })
    }
  }

  /**
   * POST /api/v1/mcp/oauth/cancel/:serverId
   *
   * Cancel a pending OAuth flow. Shuts down the callback server
   * and removes the flow from tracking so a new one can start.
   */
  async function oauthCancel(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const serverId = resolveMCPServerId(params['serverId']!)

    const activeFlow = activeTokenPromises.get(serverId)
    if (!activeFlow) {
      sendJSON(res, 200, { serverId, status: 'none', message: 'No active flow to cancel.' })
      return
    }

    // Shut down the callback server immediately
    activeFlow.shutdown()
    activeTokenPromises.delete(serverId)

    sendJSON(res, 200, { serverId, status: 'cancelled', message: 'OAuth flow cancelled.' })
  }

  return {
    // Credentials
    saveCredentials,
    checkCredentials,
    deleteCredentials,
    // Profile MCP — write side only (T21 retired the GET listing)
    addMCPToProfile,
    removeMCPFromProfile,
    // Live connection
    connectServer,
    // OAuth
    startOAuth,
    oauthStatus,
    oauthWait,
    oauthCancel,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build env var refs for agent.json (uses ${VAR} syntax).
 * These get resolved at runtime via env.ts.
 */
function buildEnvRefs(entry: MCPRegistryEntry): Record<string, string> {
  const env: Record<string, string> = {}
  for (const v of [...entry.requiredEnv, ...entry.optionalEnv]) {
    env[v.name] = `\${${v.name}}`
  }
  return env
}
