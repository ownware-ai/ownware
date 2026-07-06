/**
 * canonicalId derivation — unit tests per source provider.
 *
 * Verifies the `<source>:<id>` rule is applied uniformly by every
 * `Connector`-producing path:
 *
 *   - BuiltinSourceProvider              → `builtin:<tool.name>`
 *   - buildWebSearchConnector (enriched) → `builtin:web_search`
 *   - MCPSourceProvider                  → `mcp:<serverId>`
 *   - ComposioSourceProvider             → `composio:<appId>`
 *
 * Also covers the `makeCanonicalConnectorId` / `parseCanonicalConnectorId`
 * helpers (round-trip, malformed input rejection, URN-shaped ids).
 */

import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  makeCanonicalConnectorId,
  parseCanonicalConnectorId,
} from '../../../src/connector/schema.js'
import { ConnectorRegistry } from '../../../src/connector/registry.js'
import { ProfileRegistry } from '../../../src/profile/registry.js'
import { createComposioSource } from '../../../src/connector/composio/source.js'
import type {
  ComposioToolkitSummary,
} from '../../../src/connector/composio/client.js'
import type { ComposioCatalogCache } from '../../../src/connector/composio/catalog-cache.js'
import { ConnectorConnectionsStore } from '../../../src/connector/connections/store.js'
import { createConnectorStatusBus } from '../../../src/connector/status-bus.js'
import { CortexDatabase } from '../../../src/gateway/db/database.js'
import { CredentialVault } from '../../../src/connector/credentials/vault.js'
import { WebSearchService } from '../../../src/connector/web-search/service.js'
import { buildWebSearchConnector } from '../../../src/connector/web-search/connector.js'
import { createTempProfile } from '../../helpers/fixtures.js'

describe('makeCanonicalConnectorId / parseCanonicalConnectorId', () => {
  it('composes simple ids as <source>:<id>', () => {
    expect(makeCanonicalConnectorId('builtin', 'read_file')).toBe('builtin:read_file')
    expect(makeCanonicalConnectorId('mcp', 'github')).toBe('mcp:github')
    expect(makeCanonicalConnectorId('composio', 'gmail')).toBe('composio:gmail')
    // Phase 16 (2026-05-01): user-registered rows now compose under the
    // unified `mcp` source instead of the removed `custom_mcp`.
    expect(makeCanonicalConnectorId('mcp', 'my-server-c4vrjq3w')).toBe('mcp:my-server-c4vrjq3w')
  })

  it('preserves URN-shaped MCP ids verbatim after the prefix', () => {
    // Real registry form from MCPRegistryEntry.id — reverse-DNS with slash.
    expect(
      makeCanonicalConnectorId('mcp', 'io.github.user/weather'),
    ).toBe('mcp:io.github.user/weather')
  })

  it('rejects empty id', () => {
    expect(() => makeCanonicalConnectorId('builtin', '')).toThrow(/non-empty/)
  })

  it('round-trips through parse for every source', () => {
    // Phase 16 (2026-05-01): `'custom_mcp'` removed from the source enum;
    // user-registered rows round-trip under `'mcp'`.
    const cases = [
      ['builtin', 'read_file'],
      ['mcp', 'github'],
      ['mcp', 'io.github.user/weather'],
      ['mcp', 'my-server-c4vrjq3w'],
      ['composio', 'gmail'],
    ] as const
    for (const [src, id] of cases) {
      const c = makeCanonicalConnectorId(src, id)
      const parsed = parseCanonicalConnectorId(c)
      expect(parsed).toEqual({ source: src, id })
    }
  })

  it('parse splits on the FIRST colon only', () => {
    // MCP id with its own `:` — kept whole in the id half.
    const c = 'mcp:org:server'
    expect(parseCanonicalConnectorId(c)).toEqual({ source: 'mcp', id: 'org:server' })
  })

  it('parse rejects malformed input', () => {
    expect(parseCanonicalConnectorId('readFile')).toBeNull()
    expect(parseCanonicalConnectorId(':foo')).toBeNull()
    expect(parseCanonicalConnectorId('builtin:')).toBeNull()
    expect(parseCanonicalConnectorId('bogus:x')).toBeNull()
  })
})

describe('BuiltinSourceProvider emits canonicalId = builtin:<tool.name>', () => {
  it('every builtin connector has a well-formed canonicalId', async () => {
    const registry = new ConnectorRegistry(new ProfileRegistry())
    const all = await registry.list()
    const builtins = all.filter(c => c.source === 'builtin')
    expect(builtins.length).toBeGreaterThan(0)
    for (const c of builtins) {
      expect(c.canonicalId).toBe(`builtin:${c.id}`)
      expect(c.canonicalId.startsWith('builtin:')).toBe(true)
    }
  })
})

describe('buildWebSearchConnector emits canonicalId = builtin:web_search', () => {
  it('uses the builtin prefix (web_search is an enriched builtin)', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'cortex-canon-ws-'))
    try {
      const store = new Map<string, string>()
      const settings = {
        getSetting: (k: string) => {
          const v = store.get(k)
          return v === undefined ? undefined : { value: v }
        },
        setSetting: (k: string, v: string) => { store.set(k, v); return { value: v } },
      }
      const vault = new CredentialVault(tmp)
      const service = new WebSearchService({ settings, vault })
      const c = await buildWebSearchConnector(service)
      expect(c.canonicalId).toBe('builtin:web_search')
      expect(c.source).toBe('builtin')
      expect(c.id).toBe('web_search')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('MCPSourceProvider emits canonicalId = mcp:<serverId>', () => {
  it('prefixes the raw profile serverId (featured slug form)', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'cortex-canon-mcp-'))
    process.env['OWNWARE_SKIP_MCP_REGISTRY'] = '1'
    try {
      const { dir, cleanup } = await createTempProfile({
        'agent.json': JSON.stringify({
          name: 'p-mcp',
          tools: {
            mcp: {
              github: { transport: 'stdio', command: 'npx', args: [], env: {} },
              'io.github.acme/weather': {
                transport: 'stdio', command: 'npx', args: [], env: {},
              },
            },
          },
        }),
      })
      const { rename } = await import('node:fs/promises')
      await rename(dir, join(parent, 'p-mcp'))
      const profiles = new ProfileRegistry()
      await profiles.discover(parent)

      const registry = new ConnectorRegistry(profiles)
      const list = await registry.listForProfile('p-mcp')
      const mcp = list.filter(c => c.source === 'mcp')
      expect(mcp.length).toBe(2)
      const gh = mcp.find(c => c.id === 'github')!
      const wx = mcp.find(c => c.id === 'io.github.acme/weather')!
      expect(gh.canonicalId).toBe('mcp:github')
      // URN-shaped id is preserved verbatim after the prefix.
      expect(wx.canonicalId).toBe('mcp:io.github.acme/weather')

      await cleanup().catch(() => undefined)
    } finally {
      delete process.env['OWNWARE_SKIP_MCP_REGISTRY']
      rmSync(parent, { recursive: true, force: true })
    }
  })
})

describe('ComposioSourceProvider emits canonicalId = composio:<appId>', () => {
  it('prefixes the row.appId for every catalog entry', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'cortex-canon-cx-'))
    const db = new CortexDatabase(join(tmp, 'main.db'), join(tmp, 'fx.db'))
    const connections = new ConnectorConnectionsStore(db.rawMainHandle)
    const toolkits: ComposioToolkitSummary[] = [
      {
        slug: 'gmail', name: 'Gmail', auth_schemes: ['oauth2'],
        is_local_toolkit: false, deprecated: false, no_auth: false,
        meta: { categories: [{ id: 'communication', name: 'communication' }] },
      } as unknown as ComposioToolkitSummary,
      {
        slug: 'slack', name: 'Slack', auth_schemes: ['oauth2'],
        is_local_toolkit: false, deprecated: false, no_auth: false,
        meta: { categories: [{ id: 'communication', name: 'communication' }] },
      } as unknown as ComposioToolkitSummary,
    ]
    const catalogCache = {
      listToolkits: async () => toolkits,
      getBySlug: async (slug: string) => toolkits.find(t => t.slug === slug) ?? null,
      invalidate: () => {},
    } as unknown as ComposioCatalogCache

    const source = createComposioSource({
      apiKey: 'secret', catalogCache, connections,
      statusBus: createConnectorStatusBus(),
      entityId: 'cortex-default-user',
    })!
    const list = await source.listGlobal()
    expect(list).toHaveLength(2)
    const gmail = list.find(c => c.id === 'gmail')!
    const slack = list.find(c => c.id === 'slack')!
    expect(gmail.canonicalId).toBe('composio:gmail')
    expect(slack.canonicalId).toBe('composio:slack')

    db.close()
    rmSync(tmp, { recursive: true, force: true })
  })
})
