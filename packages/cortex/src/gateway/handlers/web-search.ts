/**
 * Web-search connector handlers (pluggable-provider subroutes).
 *
 *   GET   /api/v1/connectors/:id/providers
 *   PATCH /api/v1/connectors/:id/provider
 *
 * The only connector with pluggable providers today is `web_search`.
 * Handlers return 404 for any other connector id so the client gets a
 * clean error instead of a 500.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { sendJSON, sendError, readJSON } from '../router.js'
import { WebSearchService } from '../../connector/web-search/service.js'
import {
  WEB_SEARCH_PROVIDERS,
  DEFAULT_PROVIDER_ID,
  getWebSearchProvider,
  vaultIdFor,
} from '../../connector/web-search/providers.js'
import type { ConnectorStatusBus } from '../../connector/status-bus.js'

const PLUGGABLE_CONNECTOR_IDS = new Set(['web_search'])

const PatchProviderBodySchema = z.object({
  providerId: z.string().min(1),
  /** Optional API key. Required for api_key providers with no env/vault key. */
  apiKey: z.string().min(1).optional(),
})

export interface WebSearchHandlersDeps {
  readonly service: WebSearchService
  /**
   * Connector status bus. When present, the PATCH handler emits a
   * `connector.status_changed` event after a successful provider
   * switch, passing the *pre-PATCH* resolved status as
   * `previousStatus`. Omitted in tests that don't care about SSE.
   */
  readonly statusBus?: ConnectorStatusBus
}

export function createWebSearchHandlers(deps: WebSearchHandlersDeps) {
  const { service, statusBus } = deps

  /** GET /api/v1/connectors/:id/providers */
  async function listProviders(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    void req
    const id = params['id']
    if (!id || !PLUGGABLE_CONNECTOR_IDS.has(id)) {
      sendError(res, 404, `Connector "${id ?? ''}" is not pluggable`)
      return
    }

    const resolved = await service.resolve()
    const providers = []
    for (const p of WEB_SEARCH_PROVIDERS) {
      let configured = false
      if (p.auth.mode === 'none') {
        configured = true
      } else {
        const envVal = process.env[p.auth.envVar]
        if (envVal && envVal.length > 0) configured = true
        else {
          // Peek into vault via service — use the same vault instance.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const creds = await (service as unknown as { vault: { load(id: string): Promise<{ env: Record<string, string> } | null> } }).vault.load(vaultIdFor(p.id))
          configured = !!creds?.env[p.auth.envVar]
        }
      }
      providers.push({
        id: p.id,
        name: p.name,
        description: p.description,
        auth: p.auth,
        homepage: p.homepage,
        isDefault: p.isDefault,
        configured,
      })
    }

    sendJSON(res, 200, {
      providers,
      activeProviderId: resolved.providerId,
      defaultProviderId: DEFAULT_PROVIDER_ID,
    })
  }

  /** PATCH /api/v1/connectors/:id/provider */
  async function setProvider(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const id = params['id']
    if (!id || !PLUGGABLE_CONNECTOR_IDS.has(id)) {
      sendError(res, 404, `Connector "${id ?? ''}" is not pluggable`)
      return
    }

    let body: unknown
    try {
      body = await readJSON(req)
    } catch (e) {
      sendError(res, 400, `Invalid JSON body: ${e instanceof Error ? e.message : String(e)}`)
      return
    }
    if (body === null) {
      sendError(res, 400, 'Request body is required')
      return
    }

    const parsed = PatchProviderBodySchema.safeParse(body)
    if (!parsed.success) {
      sendError(res, 400, `Invalid request body: ${parsed.error.message}`)
      return
    }

    const { providerId, apiKey } = parsed.data
    const provider = getWebSearchProvider(providerId)
    if (!provider) {
      sendError(res, 400, `Unknown provider id: ${providerId}`)
      return
    }

    // Snapshot the pre-PATCH resolved status so we can report the true
    // transition on the status bus. Reading resolve() a second time
    // AFTER the save ensures the client sees exactly the state the next
    // session will assemble with.
    const priorResolved = await service.resolve()

    if (provider.auth.mode === 'api_key') {
      // If no apiKey supplied in body, check that env OR vault already has one.
      if (!apiKey) {
        const envVal = process.env[provider.auth.envVar]
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const creds = await (service as unknown as { vault: { load(id: string): Promise<{ env: Record<string, string> } | null> } }).vault.load(vaultIdFor(provider.id))
        const hasKey = !!(envVal && envVal.length > 0) || !!creds?.env[provider.auth.envVar]
        if (!hasKey) {
          sendError(
            res,
            400,
            `Provider "${providerId}" requires an API key. Supply it in the request body as "apiKey" or set ${provider.auth.envVar} in the environment.`,
          )
          return
        }
      } else {
        try {
          await service.saveApiKey(providerId, apiKey)
        } catch (e) {
          sendError(res, 400, e instanceof Error ? e.message : String(e))
          return
        }
      }
    } else if (apiKey) {
      // Key-free provider — but user sent a key. Reject as misuse.
      sendError(res, 400, `Provider "${providerId}" does not accept an API key.`)
      return
    }

    try {
      service.setUserChoice(providerId)
    } catch (e) {
      sendError(res, 400, e instanceof Error ? e.message : String(e))
      return
    }

    const resolved = await service.resolve()

    // Publish a source-agnostic status event. Suppress when nothing
    // actually changed (user clicked "Save" with the already-active
    // provider and the same key state).
    if (statusBus) {
      statusBus.emit({
        connectorId: 'web_search',
        source: 'builtin',
        status: resolved.status,
        previousStatus: priorResolved.status,
        reason: `Provider switched to ${resolved.providerId}`,
      })
    }

    sendJSON(res, 200, {
      providerId: resolved.providerId,
      status: resolved.status,
      source: resolved.source,
    })
  }

  return { listProviders, setProvider }
}
