/**
 * Build the `web_search` Connector record.
 *
 * The connector is an enriched variant of a plain builtin entry: it still
 * satisfies the base `Connector` schema (so M1 consumers keep working),
 * and adds the optional `providers` / `activeProviderId` /
 * `defaultProviderId` / `activeProviderSource` fields.
 *
 * Status mapping:
 *   active provider resolved, key-free  → 'ready'
 *   active provider resolved, api_key+k → 'ready'
 *   active provider is api_key, no key  → 'needs_setup'
 *   nothing resolvable                  → 'error'
 */

import type { Connector, ConnectorProviderSummary } from '../schema.js'
import { makeCanonicalConnectorId } from '../schema.js'
import {
  DEFAULT_PROVIDER_ID,
  WEB_SEARCH_PROVIDERS,
  vaultIdFor,
  type WebSearchProvider,
} from './providers.js'
import type { WebSearchService } from './service.js'

function toSummary(
  p: WebSearchProvider,
  configured: boolean,
): ConnectorProviderSummary {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    auth: p.auth,
    homepage: p.homepage,
    isDefault: p.isDefault,
    configured,
  }
}

/**
 * Build the enriched `web_search` Connector. Async because it resolves
 * the active provider via the service (which touches the vault).
 */
export async function buildWebSearchConnector(service: WebSearchService): Promise<Connector> {
  const resolved = await service.resolve()

  // Compute which providers are configured (key-free or key available).
  // Reuses the service's already-loaded view via a second pass for clarity.
  const configured = new Map<string, boolean>()
  for (const p of WEB_SEARCH_PROVIDERS) {
    if (p.auth.mode === 'none') {
      configured.set(p.id, true)
      continue
    }
    const envVal = process.env[p.auth.envVar]
    if (envVal && envVal.length > 0) {
      configured.set(p.id, true)
      continue
    }
    const creds = await service['vault'].load(vaultIdFor(p.id))
    configured.set(p.id, !!creds?.env[p.auth.envVar])
  }

  const providers = WEB_SEARCH_PROVIDERS.map(p => toSummary(p, configured.get(p.id) ?? false))

  const base: Connector = {
    id: 'web_search',
    canonicalId: makeCanonicalConnectorId('builtin', 'web_search'),
    logicalKey: 'web_search',
    name: 'Web Search',
    description: 'Search the web for current information.',
    source: 'builtin',
    category: 'search',
    auth:
      resolved.provider.auth.mode === 'none'
        ? { mode: 'none' }
        : {
            mode: 'api_key',
            envVars: [
              {
                name: resolved.provider.auth.envVar,
                description: `${resolved.provider.name} API key`,
                isRequired: true,
                isSecret: true,
              },
            ],
          },
    status: resolved.status,
    toolNames: ['web_search'],
    actions: [{
      name: 'web_search',
      description: 'Search the web for current information.',
      isReadOnly: true,
      requiresPermission: true,
      // Mirrors the Loom builtin's uiDescriptor — bypassing the
      // generic `builtinActionEntry` relay because web-search has a
      // bespoke connector builder (pluggable providers).
      uiDescriptor: {
        kind: 'search',
        summary: { verb: 'Searched web', primaryField: 'query' },
        preview: { contentField: 'results', format: 'markdown', truncateAtLines: 10 },
      },
    }],
    providers,
    activeProviderId: resolved.providerId,
    defaultProviderId: DEFAULT_PROVIDER_ID,
    activeProviderSource: resolved.source,
  }
  if (resolved.status !== 'ready' && resolved.reason) {
    return { ...base, error: resolved.reason }
  }
  return base
}
