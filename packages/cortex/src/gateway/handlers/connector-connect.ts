/**
 * POST /api/v1/connectors/:id/connect — thin dispatcher (T02).
 *
 * This handler inspects the target connector's `source` + declared
 * `auth.mode` and returns a discriminated response telling the client
 * which downstream flow to enter. It does NOT itself run the OAuth
 * handshake for MCP or persist API keys — those flows stay at
 * `/mcp/oauth/*` and `/mcp/credentials/*` respectively, because their
 * PKCE state + vendor-specific completion logic is awkward to
 * multiplex through a generic dispatcher. The Composio branch is the
 * one exception: Composio's `createConnectionLink` is synchronous and
 * safe to call here, so the authorization URL is inlined in the
 * response.
 *
 * Response shapes are defined in `connector/schema.ts` under
 * `ConnectConnectorResponseSchema` (discriminated union on `kind`).
 * Every outbound body is Zod-validated before `sendJSON` — a handler
 * regression that produces an invalid shape 500s instead of shipping
 * garbage to the client.
 *
 * Behaviour per source:
 *  - `composio` + oauth → create link, persist pending row, dispatch
 *    to ConnectionCompletionManager, return `kind: 'composio_oauth'`
 *    with `authorizationUrl` inlined. Idempotent: an existing live
 *    row short-circuits with `reused: true`.
 *  - `mcp`/`custom_mcp` + oauth (OAuth preset in
 *    `oauth-presets.ts`) → return `kind: 'mcp_oauth'` pointing at
 *    `/api/v1/mcp/oauth/start/:id`. Client POSTs there next.
 *  - `mcp`/`custom_mcp` + api_key → return `kind: 'mcp_api_key'`
 *    with the required env-var list + `/mcp/credentials/:id` pointer.
 *  - `mcp`/`custom_mcp` + none → return `kind: 'mcp_none'`
 *    (status `'ready'`); no follow-up required.
 *  - `builtin` → 400 `builtin_no_connect` (no connect concept).
 *
 * Regression gate (T02 acceptance point 5): no MCP call ever returns
 * `mcp_use_legacy_connect` anymore. That 400 was the pre-T02
 * behaviour and is now a test-asserted non-occurrence.
 *
 * Idempotency (Composio): if a live row (pending or ready) already
 * exists for `(connectorId, composio, entityId)`, the existing row
 * is returned and no new Composio link is created. Safe to re-hit
 * from the client.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { readJSON, sendError, sendJSON } from '../router.js'
import type { ConnectorRegistry } from '../../connector/registry.js'
import type { ConnectorConnectionsStore } from '../../connector/connections/store.js'
import type { ConnectionCompletionManager } from '../../connector/completion/manager.js'
import type { ComposioClient } from '../../connector/composio/client.js'
import {
  connectionSessionHandle,
  type ConnectionSessionMaterial,
  type ConnectionSessionVault,
} from '../../connector/connections/session-vault.js'
import { ConnectorError } from '../../connector/errors.js'
import {
  ConnectConnectorResponseSchema,
  type ConnectConnectorResponse,
  type Connector,
} from '../../connector/schema.js'

export const ConnectConnectorBodySchema = z.object({
  /** Optional callback URL the vendor should redirect to after OAuth. */
  callbackUrl: z.string().url().optional(),
  /** Optional alias for the connected account. */
  alias: z.string().min(1).optional(),
}).strict()
export type ConnectConnectorBody = z.infer<typeof ConnectConnectorBodySchema>

export interface ConnectorConnectHandlersDeps {
  readonly registry: ConnectorRegistry
  readonly connections: ConnectorConnectionsStore
  readonly completionManager: ConnectionCompletionManager
  readonly connectionSessions: ConnectionSessionVault
  /**
   * When set, enables the Composio branch of the dispatcher. When unset
   * (no COMPOSIO_API_KEY), a composio connector id hitting this handler
   * is impossible — the registry never surfaces composio connectors.
   * If it somehow does, we 501 with a clear message.
   */
  readonly composio?: {
    /**
     * Resolved LIVE on every access (the gateway passes a getter backed
     * by its current Composio runtime). `null` when no usable
     * COMPOSIO_API_KEY is configured *right now*. Reading it per-request
     * — rather than snapshotting at route registration — is what lets a
     * key saved after boot (via the unified /credentials path, which
     * rebuilds the runtime) work without a gateway restart.
     */
    readonly client: ComposioClient | null
    /**
     * Install-scoped identity. Used for BOTH the `entity_id` column on
     * the local `connector_connections` row AND the `userId` sent to
     * Composio's API. Resolved at gateway boot via
     * `InstallIdentity.resolve()`. Pre-v19 this was two separately-
     * defaulted values that drifted; they are now the same string so
     * the local row is keyed exactly the way readers (modal +
     * assembler) look it up.
     */
    readonly defaultUserId: string
    /**
     * Shared toolkit catalog cache. Used to detect `no_auth=true`
     * toolkits at connect-time without an extra HTTP round-trip.
     * The connect handler short-circuits no-auth toolkits with an
     * immediate `ready` response — they have nothing to authenticate
     * and forcing them through the auth-config + link flow would
     * fabricate state for no good reason.
     */
    readonly catalogCache?: {
      readonly getBySlug: (slug: string) => Promise<{ readonly no_auth?: boolean } | null>
    }
  }
}

const COMPOSIO_SOURCE = 'composio'
const DEFAULT_LINK_TTL_MS = 10 * 60 * 1000

export function createConnectorConnectHandlers(deps: ConnectorConnectHandlersDeps) {
  async function connect(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const connectorId = params['id']
    if (!connectorId || connectorId.length === 0) {
      sendError(res, 400, 'Connector id is required.')
      return
    }

    const rawBody = await readJSON(req).catch(() => null)
    const bodyParsed = ConnectConnectorBodySchema.safeParse(rawBody ?? {})
    if (!bodyParsed.success) {
      sendError(res, 400, `Invalid body: ${bodyParsed.error.message}`)
      return
    }
    const body = bodyParsed.data

    // Look up the connector across every registered source.
    const connector = await deps.registry.get(connectorId).catch(() => null)
    if (!connector) {
      sendError(res, 404, `Connector "${connectorId}" not found.`)
      return
    }

    switch (connector.source) {
      case 'builtin':
        sendError(
          res,
          400,
          'Built-in connectors are always ready and do not need to be connected.',
          'builtin_no_connect',
        )
        return
      case 'mcp':
        // Phase 16 (2026-05-01): the former `'custom_mcp'` source label
        // collapsed into `'mcp'`. User-registered rows hit the same
        // dispatcher.
        dispatchMCP(res, connector)
        return
      case 'composio': {
        // Identity is server-resolved, never client-provided. The body
        // schema does not accept `entityId`. The same string is used for
        // both the local row's `entity_id` AND the `userId` sent to
        // Composio — write-side and every read-side stay perfectly
        // aligned. When `composio` is unset the registry never surfaces
        // a composio connector, so this branch only runs when
        // `defaultUserId` exists.
        if (deps.composio == null || deps.composio.client === null) {
          sendError(
            res,
            501,
            'Composio is not configured on this gateway (COMPOSIO_API_KEY is unset).',
            'composio_not_configured',
          )
          return
        }
        await connectComposio(res, connectorId, deps.composio.defaultUserId, body)
        return
      }
    }
    sendError(res, 501, `Unsupported connector source: ${connector.source}`)
  }

  /**
   * MCP / custom_mcp dispatcher. Branches on `connector.auth.mode` and
   * returns the appropriate thin-pointer response. The actual OAuth
   * handshake and credential save endpoints (`/mcp/oauth/*`,
   * `/mcp/credentials/*`) are untouched — this just tells the client
   * which one to hit.
   */
  function dispatchMCP(res: ServerResponse, connector: Connector): void {
    let body: ConnectConnectorResponse
    switch (connector.auth.mode) {
      case 'oauth':
        body = {
          kind: 'mcp_oauth',
          startEndpoint: `/api/v1/mcp/oauth/start/${connector.id}`,
        }
        break
      case 'api_key':
        // Include both required AND optional env vars. Callers can
        // decide how to present optional fields; the `isRequired` flag
        // on each entry preserves the distinction.
        body = {
          kind: 'mcp_api_key',
          required: connector.auth.envVars.map((v) => ({
            name: v.name,
            description: v.description,
            isRequired: v.isRequired,
          })),
          saveEndpoint: `/api/v1/mcp/credentials/${connector.id}`,
        }
        break
      case 'none':
        body = { kind: 'mcp_none', status: 'ready' }
        break
      case 'runtime_setup':
        body = {
          kind: 'mcp_runtime_setup',
          hint: connector.auth.hint,
          setupEndpoint: `/api/v1/connectors/${connector.id}/runtime-setup`,
          hasCommand: connector.auth.command !== null,
        }
        break
    }
    sendValidated(res, body)
  }

  /**
   * Validate the outbound body against the shared schema before
   * sending. This catches handler-internal shape drift (e.g. a field
   * missed during a refactor) in dev + tests rather than letting a
   * malformed response ship to the client. Converts a parse failure into
   * a 500 with a clear diagnostic, not a client-visible schema
   * error.
   */
  function sendValidated(
    res: ServerResponse,
    body: ConnectConnectorResponse,
  ): void {
    const check = ConnectConnectorResponseSchema.safeParse(body)
    if (!check.success) {
      sendError(
        res,
        500,
        `Internal: /connectors/:id/connect produced an invalid response shape: ${check.error.message}`,
      )
      return
    }
    sendJSON(res, 200, check.data)
  }

  async function connectComposio(
    res: ServerResponse,
    connectorId: string,
    entityId: string,
    body: ConnectConnectorBody,
  ): Promise<void> {
    // Resolve the Composio client LIVE (the gateway hands us a getter
    // backed by its current runtime). A key saved AFTER boot via the
    // unified /credentials path rebuilds that runtime; reading it here
    // — not a snapshot captured at route registration — is what lets the
    // newly-saved key connect without a gateway restart.
    const client = deps.composio?.client ?? null
    if (deps.composio == null || client === null) {
      sendError(
        res,
        501,
        'Composio is not configured on this gateway (COMPOSIO_API_KEY is unset).',
        'composio_not_configured',
      )
      return
    }

    // Idempotency: return the existing live row if there is one.
    const existing = deps.connections.findActive(connectorId, COMPOSIO_SOURCE, entityId)
    if (existing) {
      const handle = connectionSessionHandle(existing.metadata)
      if (existing.status === 'ready') {
        if (handle !== null) {
          try {
            await deps.connectionSessions.remove(handle)
            deps.connections.markReady({ connectionId: existing.connectionId })
          } catch {
            sendError(res, 500, 'The completed connection session could not be safely cleared.')
            return
          }
        }
        sendValidated(res, {
          kind: 'composio_oauth',
          connectionId: existing.connectionId,
          status: existing.status,
          authorizationUrl: null,
          expiresAt: existing.expiresAt,
          authConfigId: existing.authConfigId,
          reused: true,
        })
        return
      }

      let session: ConnectionSessionMaterial | null = null
      if (handle !== null) {
        try {
          session = await deps.connectionSessions.read(handle, {
            connectionId: existing.connectionId,
            connectorId: existing.connectorId,
            source: existing.source,
            entityId: existing.entityId,
          })
        } catch {
          sendError(res, 500, 'The pending connection session could not be safely inspected.')
          return
        }
      }
      if (session !== null) {
        sendValidated(res, {
          kind: 'composio_oauth',
          connectionId: existing.connectionId,
          status: existing.status,
          authorizationUrl: session.authorizationUrl,
          expiresAt: existing.expiresAt,
          authConfigId: existing.authConfigId,
          reused: true,
        })
        return
      }
      if (handle !== null) {
        try {
          await deps.connectionSessions.remove(handle)
        } catch {
          sendError(res, 500, 'The unavailable connection session could not be safely cleared.')
          return
        }
      }
      deps.connections.markExpired(
        existing.connectionId,
        'Connection setup session is unavailable. Please retry.',
      )
    }

    // No-auth short-circuit (2026-05-27). When the toolkit has
    // `no_auth=true` (Composio Code Interpreter, sandboxes, etc.),
    // there is nothing to authenticate: no auth_config to look up, no
    // OAuth link to create, no connected_account to record. Returning
    // an immediate `none` response tells the client's dispatcher "you
    // can just close the dialog — this tool is already ready" and
    // mirrors the tool-adapter's no-auth runtime path (which also
    // skips the connection-row check and calls executeAction with
    // userId alone).
    //
    // The cache lookup is best-effort: if the cache isn't wired or
    // the toolkit isn't found, we fall through to the existing
    // auth_config + link flow which will surface a clear upstream
    // error if Composio really has nothing for this slug.
    if (deps.composio.catalogCache !== undefined) {
      try {
        const summary = await deps.composio.catalogCache.getBySlug(connectorId)
        if (summary?.no_auth === true) {
          sendValidated(res, {
            kind: 'composio_none',
            status: 'ready',
          })
          return
        }
      } catch {
        // Cache lookup failure isn't fatal — the auth-required flow
        // below will catch the real problem if there is one.
      }
    }

    // Resolve an auth_config_id for this toolkit. Accept either a
    // Composio-managed config (the easy path — shared OAuth app) OR a
    // user-created BYO config (the user's own OAuth app at the vendor).
    // Either kind is a valid input to `createConnectionLink`. When both
    // exist for the same toolkit, prefer the managed one — that's the
    // path most users follow and avoids surprising someone whose BYO
    // config is half-set-up. Pre-2026-05-21 this only accepted managed
    // configs, silently dropping BYO setups (BUGS.md #1).
    let authConfigId: string
    try {
      const list = await client.listAuthConfigs({
        toolkitSlug: connectorId,
        limit: 10,
      })
      const enabled = list.items.filter(x => x.status !== 'DISABLED')
      const managed = enabled.find(x => x.is_composio_managed)
      const match = managed ?? enabled[0]
      if (!match) {
        sendError(
          res,
          400,
          `No enabled auth config exists for toolkit "${connectorId}". Create one in the Composio dashboard — either "Use Composio Managed Auth" (easiest) or register your own OAuth app.`,
          'composio_no_managed_auth',
        )
        return
      }
      authConfigId = match.id
    } catch (err) {
      // Attribution matters in user-facing copy — "Composio's auth
      // config lookup failed" reads as their problem (which it is),
      // not ours. Prevents the client's dialog from showing a generic
      // "we broke it" feel for an upstream issue.
      sendError(
        res,
        502,
        `Composio couldn’t return an auth config for "${connectorId}". Please retry or check its provider setup.`,
        err instanceof ConnectorError ? err.code : undefined,
      )
      return
    }

    // Create the link. The Composio `userId` and the local `entity_id`
    // are the SAME string (both come from InstallIdentity). This is the
    // invariant that guarantees the connection row we persist below can
    // be matched on resync, and that the agent's tool list reads find
    // the same row the modal sees.
    let link
    try {
      link = await client.createConnectionLink({
        authConfigId,
        userId: entityId,
        ...(body.callbackUrl !== undefined ? { callbackUrl: body.callbackUrl } : {}),
        ...(body.alias !== undefined ? { alias: body.alias } : {}),
      })
    } catch (err) {
      // Same attribution principle as the auth-config lookup above —
      // the gateway made a real request to Composio and Composio said
      // no. Frame the failure as Composio's verdict so the client's
      // dialog can offer the right recovery path (open Composio's
      // dashboard to fix the auth_config) instead of "try again."
      sendError(
        res,
        502,
        `Composio couldn’t start the connection for "${connectorId}". Please retry or check its provider setup.`,
        err instanceof ConnectorError ? err.code : undefined,
      )
      return
    }

    const now = Date.now()
    const expiresAtMs = Date.parse(link.expires_at)
    const expiresAt = Number.isFinite(expiresAtMs)
      ? Math.min(expiresAtMs, now + DEFAULT_LINK_TTL_MS)
      : now + DEFAULT_LINK_TTL_MS
    if (expiresAt <= now) {
      sendError(res, 502, 'Composio returned an expired connection session. Please retry.')
      return
    }

    // Persist pending row.
    //
    // Capture vendor identity at the moment of connect:
    //
    //   • vendorAccountId — the link response's connected_account_id IS
    //     the vendor's pointer. Set it now so the resolver at
    //     execute-time has it available even before the OAuth flow
    //     completes (the listener will COALESCE-confirm on markReady).
    //   • vendorUserId    — the userId WE just sent in
    //     createConnectionLink. This is what Composio's record will
    //     store. If their API ever wants user_id back, we send THIS
    //     frozen value, never the live entity_id (which can migrate).
    // Defensive try/catch — `upsertPending` preserves an existing live
    // tuple so its encrypted session handle cannot be orphaned.
    // But ANY future SQLite constraint addition could surface as an
    // uncaught throw here. Catch it explicitly so the user sees a
    // gateway-attributed error message rather than "Composio said:
    // UNIQUE constraint failed: …" lying about whose system broke.
    let sessionHandle: string
    try {
      sessionHandle = await deps.connectionSessions.create({
        connectionId: link.connected_account_id,
        connectorId,
        source: COMPOSIO_SOURCE,
        entityId,
        authorizationUrl: link.redirect_url,
        linkToken: link.link_token,
        expiresAt,
      })
    } catch {
      sendError(res, 500, 'Failed to protect the pending connection session.')
      return
    }

    let row
    try {
      row = deps.connections.upsertPending({
        connectionId: link.connected_account_id,
        connectorId,
        source: COMPOSIO_SOURCE,
        entityId,
        expiresAt,
        authConfigId,
        vendorAccountId: link.connected_account_id,
        vendorUserId: entityId,
        metadata: { sessionHandle },
      })
    } catch {
      try {
        await deps.connectionSessions.remove(sessionHandle)
      } catch {
        sendError(
          res,
          500,
          'The failed connection session could not be safely cleared.',
        )
        return
      }
      sendError(
        res,
        500,
        `Failed to persist the pending connection for "${connectorId}".`,
      )
      return
    }

    // A concurrent request may have completed the tuple between the
    // initial live-row check and this upsert. The store preserves that
    // ready row; its newly-created continuation session is not referenced
    // and must be removed immediately.
    if (row.connectionId !== link.connected_account_id || row.status === 'ready') {
      try {
        await deps.connectionSessions.remove(sessionHandle)
      } catch {
        sendError(res, 500, 'The unused connection session could not be safely cleared.')
        return
      }
      sendValidated(res, {
        kind: 'composio_oauth',
        connectionId: row.connectionId,
        status: row.status,
        authorizationUrl: null,
        expiresAt: row.expiresAt,
        authConfigId: row.authConfigId,
        reused: true,
      })
      return
    }

    // Dispatch for polling.
    try {
      deps.completionManager.dispatch(row.connectionId)
    } catch {
      // The dispatch manager throws if no listener is registered for the
      // source. This is a programmer error at boot time, but we surface
      // it honestly rather than leaving a pending row without a poller.
      try {
        await deps.connectionSessions.remove(sessionHandle)
        deps.connections.markFailed({
          connectionId: row.connectionId,
          reason: 'Connection completion is temporarily unavailable. Please retry.',
        })
      } catch {
        sendError(
          res,
          500,
          'Pending connection created, but its session could not be safely cleared.',
        )
        return
      }
      sendError(
        res,
        500,
        'Connection completion is temporarily unavailable. Please retry.',
      )
      return
    }

    sendValidated(res, {
      kind: 'composio_oauth',
      connectionId: row.connectionId,
      status: row.status,
      authorizationUrl: link.redirect_url,
      expiresAt,
      authConfigId,
      reused: false,
    })
  }

  return {
    /** POST /api/v1/connectors/:id/connect */
    connect,
  }
}

// Re-export for convenience
import type { ComposioClient as _ComposioClientT } from '../../connector/composio/client.js'
type _ComposioClient = _ComposioClientT // silence unused-type check on re-imports
export type { _ComposioClient }
