/**
 * DELETE /api/v1/connectors/:id/connect — the inverse of the
 * connect dispatcher.
 *
 * Revokes a live Composio connection server-side (calls
 * `ComposioClient.deleteConnectedAccount`) and marks the local
 * `connector_connections` row as expired with a "Revoked by user"
 * reason. Emits a `connector.status_changed` event so every client
 * subscriber (abilities tab, tools-bar, preflight) refetches and
 * reflects the new status without a manual reload.
 *
 * Failure mode — Composio rejects the DELETE. Composio's v3 API
 * has inconsistently returned "Failed to delete connected account
 * by id" for legitimate revoke attempts (as of 2026-04-22 testing).
 * Rather than leaving the user stuck at "Connected" forever, we
 * mark the local row revoked anyway and return 200 with a
 * `{ partial: true, vendorError }` flag. The client surfaces an
 * honest warning: "Local connection cleared. Revoke at
 * app.composio.dev if the connection still shows as active there."
 *
 * MCP api-key and MCP OAuth disconnects stay on their existing
 * endpoints (`/mcp/credentials/:serverId`, `/mcp/oauth/cancel/:serverId`).
 * They're fundamentally different flows — this dispatcher is
 * Composio-only today. Keeping MCP on its dedicated paths avoids
 * fighting vendor semantics into a single shape prematurely.
 *
 * Idempotency: safe to replay. If the local row is already
 * `expired` / `failed`, we skip the vendor call and still return 204
 * (the end-state is what the caller asked for).
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendError, sendJSON } from '../router.js'
import type { ConnectorRegistry } from '../../connector/registry.js'
import type { ConnectorConnectionsStore } from '../../connector/connections/store.js'
import type { ConnectorStatusBus } from '../../connector/status-bus.js'
import type { ComposioClient } from '../../connector/composio/client.js'
import type { ConnectionCompletionManager } from '../../connector/completion/manager.js'
import {
  connectionSessionHandle,
  type ConnectionSessionVault,
} from '../../connector/connections/session-vault.js'
import { ConnectorError } from '../../connector/errors.js'

export interface ConnectorDisconnectHandlersDeps {
  readonly registry: ConnectorRegistry
  readonly connections: ConnectorConnectionsStore
  readonly statusBus: ConnectorStatusBus
  readonly completionManager: Pick<ConnectionCompletionManager, 'cancel'>
  readonly connectionSessions: Pick<ConnectionSessionVault, 'remove'>
  /**
   * Null-safe: when Composio is disabled, composio-source requests 501.
   * `client` resolves LIVE (gateway passes a getter) so a key saved after
   * boot works without a restart — see connector-connect.ts.
   */
  readonly composio?: { readonly client: ComposioClient | null } | undefined
  /**
   * Install-scoped identity. Required and non-empty — must be the
   * SAME string the source and connect handler use, otherwise
   * `findActive()` here can't see what `connectComposio` wrote.
   * Resolved at gateway boot via `InstallIdentity.resolve()`.
   */
  readonly entityId: string
}

const REVOKE_REASON = 'Revoked by user'

export function createConnectorDisconnectHandlers(
  deps: ConnectorDisconnectHandlersDeps,
) {
  const {
    registry,
    connections,
    statusBus,
    composio,
    completionManager,
    connectionSessions,
  } = deps
  const entityId = deps.entityId

  async function disconnect(
    _req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const connectorId = params['id']
    if (!connectorId || connectorId.length === 0) {
      sendError(res, 400, 'Connector id required')
      return
    }

    // Resolve the connector to figure out which source's disconnect
    // pathway to take. This also validates the id — a typo or
    // stale-cache id fails fast with a 404.
    let connector
    try {
      const list = await registry.list()
      connector = list.find(
        (c) => c.id === connectorId || c.canonicalId === connectorId,
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'registry lookup failed'
      sendError(res, 500, `Failed to resolve connector: ${msg}`)
      return
    }

    if (!connector) {
      sendError(res, 404, `Connector "${connectorId}" not found`)
      return
    }

    switch (connector.source) {
      case 'builtin':
        sendError(
          res,
          400,
          'Built-in connectors cannot be disconnected — they ship with the kernel.',
        )
        return
      case 'mcp':
        // Phase 16 (2026-05-01): the former `'custom_mcp'` source merged
        // into `'mcp'`. Both pre-attached and user-registered rows route
        // here. MCP keeps its existing dedicated endpoints to preserve
        // transport-specific cleanup semantics (credential vault
        // delete vs OAuth cancel vs live-client teardown). Direct
        // the client at the right path.
        sendError(
          res,
          400,
          'MCP connectors disconnect via DELETE /api/v1/mcp/credentials/:serverId (api-key/none) or the OAuth cancel endpoint. This dispatcher is Composio-only.',
        )
        return
      case 'composio': {
        // Live read — a key saved after boot rebuilds the runtime; reading
        // the client here (not a snapshot) lets disconnect work without a
        // restart. See connector-connect.ts.
        const client = composio?.client ?? null
        if (client === null) {
          sendError(res, 501, 'Composio is not configured on this gateway.')
          return
        }
        const active = connections.findActive(connector.id, 'composio', entityId)
        if (!active) {
          // Nothing to revoke locally; return 204 so the client's
          // optimistic "disconnected" UI doesn't get rolled back.
          res.writeHead(204)
          res.end()
          return
        }

        // Stop any in-flight completion result before beginning revocation.
        // Store transitions also compare-and-swap from pending, but cancelling
        // here avoids needless vendor work and narrows the race window.
        completionManager.cancel(active.connectionId)

        // Pending OAuth continuation material is capability-bearing. It must
        // be verifiably removed before the row loses its opaque handle; if
        // cleanup cannot be proven, keep the row recoverable and ask the user
        // to retry instead of silently orphaning a secret.
        const sessionHandle = connectionSessionHandle(active.metadata)
        if (sessionHandle !== null) {
          try {
            await connectionSessions.remove(sessionHandle)
          } catch {
            sendError(
              res,
              500,
              'The connection session could not be safely cleared. Please retry disconnect.',
            )
            return
          }
        }

        // The Composio call is a best-effort upstream revoke. If it
        // fails, the user still sees "disconnected" locally (which
        // matches their click) and we tell them to double-check at
        // Composio. Ordering: revoke Composio-side first so a flaky vendor
        // response doesn't leave the user with a stale-looking
        // local state while a token still works remotely.
        let vendorError: string | null = null
        try {
          await client.deleteConnectedAccount(active.connectionId)
        } catch (err) {
          vendorError = err instanceof ConnectorError
            ? err.message
            : err instanceof Error
              ? err.message
              : 'Composio revoke failed'
        }

        connections.markRevoked(
          active.connectionId,
          vendorError === null
            ? REVOKE_REASON
            : `${REVOKE_REASON} (provider revocation unconfirmed)`,
          vendorError === null,
        )
        statusBus.emit({
          connectorId: connector.id,
          source: 'composio',
          status: 'needs_setup',
          previousStatus: 'ready',
          reason: REVOKE_REASON,
        })

        if (vendorError !== null) {
          sendJSON(res, 200, {
            partial: true,
            vendorError: 'Composio could not confirm revocation.',
          })
          return
        }
        res.writeHead(204)
        res.end()
        return
      }
    }
  }

  return { disconnect }
}
