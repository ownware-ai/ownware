import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CortexDatabase } from '../../../../src/gateway/db/database.js'
import { ConnectorConnectionsStore } from '../../../../src/connector/connections/store.js'
import {
  createComposioSource,
  type ComposioProfileReader,
} from '../../../../src/connector/composio/source.js'
import type {
  ComposioClient,
  ComposioToolkitSummary,
} from '../../../../src/connector/composio/client.js'
import { ComposioCatalogCache } from '../../../../src/connector/composio/catalog-cache.js'
import { createConnectorStatusBus } from '../../../../src/connector/status-bus.js'
import type { LoadedProfile } from '../../../../src/profile/loader.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string
let db: CortexDatabase
let connections: ConnectorConnectionsStore

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cortex-composio-src-'))
  db = new CortexDatabase(join(tmpDir, 'main.db'), join(tmpDir, 'fx.db'))
  connections = new ConnectorConnectionsStore(db.rawMainHandle)
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

/**
 * Build a `ComposioToolkitSummary` shaped like the Composio v3 API
 * response. The source.ts mapping reads `slug`, `name`, `auth_schemes`,
 * `no_auth`, `meta.categories[0].name`, `meta.logo`, `meta.description`
 * — those are the fields the tests actually need to control.
 */
function summary(opts: {
  slug: string
  name: string
  authSchemes?: readonly string[]
  noAuth?: boolean
  categoryName?: string | null
  logo?: string | null
  description?: string | null
}): ComposioToolkitSummary {
  return {
    slug: opts.slug,
    name: opts.name,
    auth_schemes: opts.authSchemes ?? ['oauth2'],
    is_local_toolkit: false,
    deprecated: false,
    no_auth: opts.noAuth ?? false,
    meta: {
      ...(opts.categoryName != null
        ? { categories: [{ id: opts.categoryName, name: opts.categoryName }] }
        : {}),
      ...(opts.logo != null ? { logo: opts.logo } : {}),
      ...(opts.description != null ? { description: opts.description } : {}),
    },
  } as unknown as ComposioToolkitSummary
}

/**
 * Stub the live HTTP client. The source.ts only ever calls
 * `listToolkits` for catalog reads, so we mock just that method.
 */
function stubClient(items: readonly ComposioToolkitSummary[]): ComposioClient {
  return {
    listToolkits: vi.fn(async () => ({ items: [...items], next_cursor: null })),
  } as unknown as ComposioClient
}

/** Wrap the stub client in a real catalog cache — the shape
 *  `createComposioSource` takes since the catalog-cache refactor. */
function stubCache(items: readonly ComposioToolkitSummary[]): ComposioCatalogCache {
  return new ComposioCatalogCache({ client: stubClient(items) })
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

describe('createComposioSource', () => {
  it('returns null when apiKey is missing; emits exactly one warn line', () => {
    const logs: string[] = []
    const source = createComposioSource({
      apiKey: '',
      catalogCache: stubCache([]),
      connections,
      statusBus: createConnectorStatusBus(),
      warn: m => logs.push(m),
      entityId: 'cortex-default-user',
    })
    expect(source).toBeNull()
    expect(logs).toHaveLength(1)
    expect(logs[0]).toBe('[ownware] composio: disabled (COMPOSIO_API_KEY not set)')
  })

  it('returns null for whitespace-only key', () => {
    const logs: string[] = []
    const source = createComposioSource({
      apiKey: '   ',
      catalogCache: stubCache([]),
      connections,
      statusBus: createConnectorStatusBus(),
      warn: m => logs.push(m),
      entityId: 'cortex-default-user',
    })
    expect(source).toBeNull()
    expect(logs).toHaveLength(1)
  })

  it('returns null when client is missing even if apiKey is set', () => {
    const logs: string[] = []
    const source = createComposioSource({
      apiKey: 'secret',
      catalogCache: null,
      connections,
      statusBus: createConnectorStatusBus(),
      warn: m => logs.push(m),
      entityId: 'cortex-default-user',
    })
    expect(source).toBeNull()
    expect(logs).toHaveLength(1)
  })

  it('with key set + empty toolkit list: source registers, listGlobal returns []', async () => {
    const source = createComposioSource({
      apiKey: 'secret',
      catalogCache: stubCache([]),
      connections,
      statusBus: createConnectorStatusBus(),
      entityId: 'cortex-default-user',
    })
    expect(source).not.toBeNull()
    const list = await source!.listGlobal()
    expect(list).toEqual([])
  })

  it('with one toolkit: emits a Connector with needs_setup status (no connection exists)', async () => {
    const source = createComposioSource({
      apiKey: 'secret',
      catalogCache: stubCache([summary({
        slug: 'notion',
        name: 'Notion',
        categoryName: 'productivity',
        description: 'Notion',
      })]),
      connections,
      statusBus: createConnectorStatusBus(),
      entityId: 'cortex-default-user',
    })
    const list = await source!.listGlobal()
    expect(list).toHaveLength(1)
    expect(list[0]!.id).toBe('notion')
    expect(list[0]!.canonicalId).toBe('composio:notion')
    expect(list[0]!.source).toBe('composio')
    expect(list[0]!.status).toBe('needs_setup')
    expect(list[0]!.category).toBe('productivity')
    expect(list[0]!.auth.mode).toBe('oauth')
  })

  it('reflects connection status from connections store', async () => {
    connections.upsertPending({
      connectionId: 'c1', connectorId: 'slack', source: 'composio', entityId: 'cortex-default-user',
    })
    connections.markReady({ connectionId: 'c1' })

    const source = createComposioSource({
      apiKey: 'secret',
      catalogCache: stubCache([summary({
        slug: 'slack',
        name: 'Slack',
        categoryName: 'communication',
      })]),
      connections,
      statusBus: createConnectorStatusBus(),
      entityId: 'cortex-default-user',
    })
    const list = await source!.listGlobal()
    expect(list[0]!.status).toBe('ready')
  })

  it('threads iconUrl from toolkit logo through to Connector', async () => {
    const source = createComposioSource({
      apiKey: 'secret',
      catalogCache: stubCache([summary({
        slug: 'stripe',
        name: 'Stripe',
        categoryName: 'finance',
        logo: 'https://cdn.composio.dev/logos/stripe.png',
      })]),
      connections,
      statusBus: createConnectorStatusBus(),
      entityId: 'cortex-default-user',
    })
    const list = await source!.listGlobal()
    expect(list[0]!.iconUrl).toBe('https://cdn.composio.dev/logos/stripe.png')
  })

  it('passes null iconUrl through when toolkit has no logo', async () => {
    const source = createComposioSource({
      apiKey: 'secret',
      catalogCache: stubCache([summary({ slug: 'obscure', name: 'Obscure' })]),
      connections,
      statusBus: createConnectorStatusBus(),
      entityId: 'cortex-default-user',
    })
    const list = await source!.listGlobal()
    expect(list[0]!.iconUrl).toBeNull()
  })

  it('api_key auth scheme maps to api_key auth mode', async () => {
    const source = createComposioSource({
      apiKey: 'secret',
      catalogCache: stubCache([summary({
        slug: 'openai',
        name: 'OpenAI',
        authSchemes: ['api_key'],
        categoryName: 'artificial intelligence',
      })]),
      connections,
      statusBus: createConnectorStatusBus(),
      entityId: 'cortex-default-user',
    })
    const list = await source!.listGlobal()
    expect(list[0]!.auth.mode).toBe('api_key')
  })

  it('no_auth=true maps to none', async () => {
    const source = createComposioSource({
      apiKey: 'secret',
      catalogCache: stubCache([summary({
        slug: 'public-tool',
        name: 'Public Tool',
        noAuth: true,
        authSchemes: ['oauth2'], // overridden by no_auth flag
      })]),
      connections,
      statusBus: createConnectorStatusBus(),
      entityId: 'cortex-default-user',
    })
    const list = await source!.listGlobal()
    expect(list[0]!.auth.mode).toBe('none')
  })

  it('caches the toolkit walk for the TTL window', async () => {
    const client = stubClient([summary({ slug: 'notion', name: 'Notion' })])
    const source = createComposioSource({
      apiKey: 'secret',
      catalogCache: new ComposioCatalogCache({
        client,
        ttlMs: 60_000,
        now: () => 1_000_000, // frozen clock
      }),
      connections,
      statusBus: createConnectorStatusBus(),
      entityId: 'cortex-default-user',
    })
    await source!.listGlobal()
    await source!.listGlobal()
    await source!.listGlobal()
    // Three calls to listGlobal but only ONE walk because cache holds.
    expect(client.listToolkits).toHaveBeenCalledTimes(1)
  })

  it('coalesces concurrent cache misses into one network walk', async () => {
    let resolveWalk: ((v: { items: ComposioToolkitSummary[]; next_cursor: null }) => void) | null = null
    const client: ComposioClient = {
      listToolkits: vi.fn(() => new Promise((res) => { resolveWalk = res })),
    } as unknown as ComposioClient
    const source = createComposioSource({
      apiKey: 'secret',
      catalogCache: new ComposioCatalogCache({ client }),
      connections,
      statusBus: createConnectorStatusBus(),
      entityId: 'cortex-default-user',
    })
    // Two concurrent calls hit the source before the walk resolves.
    const a = source!.listGlobal()
    const b = source!.listGlobal()
    resolveWalk!({ items: [summary({ slug: 'notion', name: 'Notion' })], next_cursor: null })
    const [resA, resB] = await Promise.all([a, b])
    expect(resA).toHaveLength(1)
    expect(resB).toHaveLength(1)
    // Only ONE network call despite two concurrent listGlobal invocations.
    expect(client.listToolkits).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// listForProfile — filtered by profile's `tools.composio.toolkits`.
// ---------------------------------------------------------------------------

function stubProfile(toolkits: readonly string[]): LoadedProfile {
  return {
    config: {
      tools: {
        composio: { toolkits: [...toolkits] },
      },
    },
  } as unknown as LoadedProfile
}

function stubReader(
  profiles: Record<string, readonly string[]>,
): ComposioProfileReader {
  return {
    has(id) {
      return Object.prototype.hasOwnProperty.call(profiles, id)
    },
    async get(id) {
      if (!Object.prototype.hasOwnProperty.call(profiles, id)) {
        throw new Error(`Profile "${id}" not found`)
      }
      return stubProfile(profiles[id] ?? [])
    },
  }
}

describe('ComposioSourceProvider.listForProfile', () => {
  function threeToolkits(): ComposioCatalogCache {
    return stubCache([
      summary({ slug: 'gmail', name: 'Gmail', categoryName: 'communication' }),
      summary({ slug: 'slack', name: 'Slack', categoryName: 'communication' }),
      summary({ slug: 'notion', name: 'Notion', categoryName: 'productivity' }),
    ])
  }

  it('profile with empty toolkits → 0 connectors (even when live catalog has rows)', async () => {
    const source = createComposioSource({
      apiKey: 'secret',
      catalogCache: threeToolkits(),
      connections,
      statusBus: createConnectorStatusBus(),
      entityId: 'cortex-default-user',
      profileReader: stubReader({ 'empty-profile': [] }),
    })
    const list = await source!.listForProfile('empty-profile')
    expect(list).toEqual([])
  })

  it('profile declaring two matching slugs → 2 connectors, slugs match', async () => {
    const source = createComposioSource({
      apiKey: 'secret',
      catalogCache: threeToolkits(),
      connections,
      statusBus: createConnectorStatusBus(),
      entityId: 'cortex-default-user',
      profileReader: stubReader({ 'two-tools': ['gmail', 'slack'] }),
    })
    const list = await source!.listForProfile('two-tools')
    expect(list).toHaveLength(2)
    expect(list.map((c) => c.id).sort()).toEqual(['gmail', 'slack'])
    for (const c of list) {
      expect(c.source).toBe('composio')
    }
  })

  it('profile with one known + one unknown slug → 1 connector, no error', async () => {
    const source = createComposioSource({
      apiKey: 'secret',
      catalogCache: threeToolkits(),
      connections,
      statusBus: createConnectorStatusBus(),
      entityId: 'cortex-default-user',
      profileReader: stubReader({
        'mixed': ['gmail', 'nonexistent-toolkit-xyz'],
      }),
    })
    const list = await source!.listForProfile('mixed')
    expect(list).toHaveLength(1)
    expect(list[0]!.id).toBe('gmail')
  })

  it('unknown profileId → empty list (no throw)', async () => {
    const source = createComposioSource({
      apiKey: 'secret',
      catalogCache: threeToolkits(),
      connections,
      statusBus: createConnectorStatusBus(),
      entityId: 'cortex-default-user',
      profileReader: stubReader({ real: ['gmail'] }),
    })
    const list = await source!.listForProfile('ghost-profile')
    expect(list).toEqual([])
  })

  it('no profileReader wired → empty list (safe default, not the global catalog)', async () => {
    const source = createComposioSource({
      apiKey: 'secret',
      catalogCache: threeToolkits(),
      connections,
      statusBus: createConnectorStatusBus(),
      entityId: 'cortex-default-user',
    })
    const list = await source!.listForProfile('anything')
    expect(list).toEqual([])
    // listGlobal remains unchanged — discovery is broad.
    expect(await source!.listGlobal()).toHaveLength(3)
  })
})
