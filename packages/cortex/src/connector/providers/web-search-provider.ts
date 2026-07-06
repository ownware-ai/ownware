/**
 * WebSearchToolProvider — wraps the M1.5 `WebSearchService` into a
 * `ConnectorToolProvider`.
 *
 * Runtime behaviour is byte-identical to the M1.5 assembler's inline
 * `resolveWebSearchBinding()`/`applyWebSearchBinding()` pair:
 *
 *   - If the profile has no `web_search` tool → this provider
 *     contributes nothing (no tools, no stubs, no config overlay).
 *   - If the active provider resolves to `ready` → configOverlay
 *     carries `webSearchStrategy: { strategy, apiKey? }`.
 *   - Otherwise → a stub tool replaces `web_search` with the full
 *     enriched `ConnectorNotReadyError` metadata (providerId,
 *     providerName, availableProviders).
 *
 * The provider takes the same `WebSearchService` the gateway already
 * hands to `createConnectorHandlers` — one service instance, one
 * source of truth for the user's provider choice.
 */

import type { Tool } from '@ownware/loom'
import type { WebSearchService } from '../web-search/service.js'
import type {
  ConnectorToolProvider,
  ConnectorToolProviderContext,
  ConnectorToolProviderResult,
} from './types.js'
import type { LoadedProfile } from '../../profile/loader.js'
import { createStubTool } from '../stub-tool.js'
import type { AuthMode, ConnectorProviderSummary } from '../schema.js'
import {
  WEB_SEARCH_PROVIDERS,
  vaultIdFor as webSearchVaultIdFor,
} from '../web-search/providers.js'

export class WebSearchToolProvider implements ConnectorToolProvider {
  readonly source = 'web_search'

  constructor(private readonly service: WebSearchService) {}

  async getToolsForProfile(
    _profile: LoadedProfile,
    ctx: ConnectorToolProviderContext,
  ): Promise<ConnectorToolProviderResult> {
    const hasWebSearch = ctx.existingTools.some(t => t.name === 'web_search')
    if (!hasWebSearch) {
      return { tools: [], stubs: [] }
    }

    const resolved = await this.service.resolve()

    if (resolved.status === 'ready') {
      const strategy = this.service.buildStrategy(resolved.providerId)
      const overlay: Record<string, unknown> = {
        webSearchStrategy: {
          strategy,
          ...(resolved.apiKey !== undefined ? { apiKey: resolved.apiKey } : {}),
        },
      }
      return {
        tools: [],
        stubs: [],
        configOverlay: overlay,
      }
    }

    // needs_setup / error → enriched stub replaces the built-in tool.
    const providers = await this.buildProviderSummaries()
    const provider = resolved.provider
    const authMode: AuthMode =
      provider.auth.mode === 'none'
        ? { mode: 'none' }
        : {
            mode: 'api_key',
            envVars: [{
              name: provider.auth.envVar,
              description: `${provider.name} API key`,
              isRequired: true,
              isSecret: true,
            }],
          }

    const stub: Tool = createStubTool({
      toolName: 'web_search',
      description: 'Search the web for current information.',
      connectorId: 'web_search',
      connectorName: 'Web Search',
      source: 'builtin',
      authMode,
      reason: resolved.reason || `Provider "${resolved.providerId}" is not configured`,
      providerId: resolved.providerId,
      providerName: provider.name,
      availableProviders: providers,
    })

    return {
      tools: [],
      stubs: [stub],
      replaceToolNames: new Set(['web_search']),
    }
  }

  private async buildProviderSummaries(): Promise<readonly ConnectorProviderSummary[]> {
    const out: ConnectorProviderSummary[] = []
    for (const p of WEB_SEARCH_PROVIDERS) {
      let configured: boolean
      if (p.auth.mode === 'none') {
        configured = true
      } else {
        const envVal = process.env[p.auth.envVar]
        if (envVal && envVal.length > 0) {
          configured = true
        } else {
          const creds = await (this.service as unknown as {
            vault: { load(id: string): Promise<{ env: Record<string, string> } | null> }
          }).vault.load(webSearchVaultIdFor(p.id))
          configured = !!creds?.env[p.auth.envVar]
        }
      }
      out.push({
        id: p.id,
        name: p.name,
        description: p.description,
        auth: p.auth,
        homepage: p.homepage,
        isDefault: p.isDefault,
        configured,
      })
    }
    return out
  }
}
