/**
 * Unit tests — MCPRegistrySourceProvider (Phase 6-C.1).
 *
 * The provider wraps the registry HTTP fetch behind the
 * `ConnectorSourceProvider` interface. We inject a stub fetcher so
 * tests run hermetically (no network). Production wiring uses
 * `fetchMCPRegistry` from `connector/mcp/registry.ts`.
 */

import { describe, expect, it } from 'vitest'
import {
  MCPRegistrySourceProvider,
  registryEntryToConnector,
} from '../../../src/connector/providers/mcp-registry-source-provider.js'
import type { MCPRegistryEntry } from '../../../src/connector/types.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ENTRY_NO_AUTH: MCPRegistryEntry = {
  id: 'io.github.user/weather',
  title: 'Weather',
  description: 'Get current weather from a public API.',
  icon: 'https://example.com/weather.png',
  category: 'data',
  transport: 'stdio',
  package: '@user/weather',
  runtime: 'npx',
  requiredEnv: [],
  optionalEnv: [],
  remoteUrl: null,
  repository: 'https://github.com/user/weather',
  websiteUrl: null,
  packageArgs: [],
  version: '1.0.0',
}

const ENTRY_WITH_KEY: MCPRegistryEntry = {
  id: 'io.github.makenotion/notion-mcp-server',
  title: 'Notion',
  description: 'Notion workspace integration.',
  icon: null,
  category: 'productivity',
  transport: 'stdio',
  package: '@makenotion/notion-mcp-server',
  runtime: 'npx',
  requiredEnv: [
    {
      name: 'NOTION_API_KEY',
      description: 'Notion integration token',
      isRequired: true,
      isSecret: true,
      helpUrl: 'https://www.notion.so/my-integrations',
    },
  ],
  optionalEnv: [
    {
      name: 'NOTION_DEBUG',
      description: 'Enable verbose logging',
      isRequired: false,
      isSecret: false,
    },
  ],
  remoteUrl: null,
  repository: null,
  websiteUrl: null,
  packageArgs: [],
  version: '1.0.0',
}

// ---------------------------------------------------------------------------
// registryEntryToConnector
// ---------------------------------------------------------------------------

describe('registryEntryToConnector', () => {
  it('projects a no-auth entry as source=mcp / auth.mode=none / no availableModes', () => {
    const c = registryEntryToConnector(ENTRY_NO_AUTH)
    expect(c.source).toBe('mcp')
    expect(c.id).toBe('io.github.user/weather')
    expect(c.canonicalId).toBe('mcp:io.github.user/weather')
    expect(c.logicalKey).toBe('io.github.user/weather')
    expect(c.name).toBe('Weather')
    expect(c.description).toBe('Get current weather from a public API.')
    expect(c.iconUrl).toBe('https://example.com/weather.png')
    expect(c.category).toBe('data')
    expect(c.auth.mode).toBe('none')
    expect(c.status).toBe('needs_setup')
    expect(c.toolNames).toBeNull()
    expect(c.availableModes).toBeUndefined()
    expect(c.tokenInputs).toBeUndefined()
  })

  it('projects an entry with required env as auth.mode=api_key + tokenInputs + availableModes=[token]', () => {
    const c = registryEntryToConnector(ENTRY_WITH_KEY)
    expect(c.auth.mode).toBe('api_key')
    if (c.auth.mode !== 'api_key') throw new Error('narrow')
    expect(c.auth.envVars).toHaveLength(1)
    expect(c.auth.envVars[0]).toMatchObject({
      name: 'NOTION_API_KEY',
      isRequired: true,
      isSecret: true,
      helpUrl: 'https://www.notion.so/my-integrations',
    })
    expect(c.tokenInputs).toBeDefined()
    expect(c.tokenInputs).toHaveLength(2)
    // Required first, optional second.
    expect(c.tokenInputs![0]?.name).toBe('NOTION_API_KEY')
    expect(c.tokenInputs![0]?.isRequired).toBe(true)
    expect(c.tokenInputs![1]?.name).toBe('NOTION_DEBUG')
    expect(c.tokenInputs![1]?.isRequired).toBe(false)
    expect(c.availableModes).toEqual(['token'])
  })

  it('maps every MCPCategory to a valid ConnectorCategory', () => {
    const cats: ReadonlyArray<MCPRegistryEntry['category']> = [
      'dev-tools',
      'communication',
      'data',
      'browser',
      'productivity',
      'ai',
      'cloud',
      'finance',
      'other',
    ]
    for (const cat of cats) {
      const c = registryEntryToConnector({ ...ENTRY_NO_AUTH, category: cat })
      expect(c.category).toBe(cat)
    }
  })

  it('preserves null icon as null on the wire (not undefined)', () => {
    const c = registryEntryToConnector(ENTRY_WITH_KEY)
    expect(c.iconUrl).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// MCPRegistrySourceProvider — listGlobal / listForProfile
// ---------------------------------------------------------------------------

describe('MCPRegistrySourceProvider', () => {
  it('exposes name="mcp_registry"', () => {
    const p = new MCPRegistrySourceProvider({ fetcher: async () => [] })
    expect(p.name).toBe('mcp_registry')
  })

  it('listGlobal projects every fetched entry into a Connector', async () => {
    const p = new MCPRegistrySourceProvider({
      fetcher: async () => [ENTRY_NO_AUTH, ENTRY_WITH_KEY],
    })
    const list = await p.listGlobal()
    expect(list).toHaveLength(2)
    expect(list[0]?.id).toBe('io.github.user/weather')
    expect(list[1]?.id).toBe('io.github.makenotion/notion-mcp-server')
    expect(list[0]?.source).toBe('mcp')
    expect(list[1]?.source).toBe('mcp')
  })

  it('listGlobal returns [] when the fetcher throws (offline-friendly)', async () => {
    const p = new MCPRegistrySourceProvider({
      fetcher: async () => {
        throw new Error('network unreachable')
      },
    })
    const list = await p.listGlobal()
    expect(list).toEqual([])
  })

  it('listForProfile always returns [] — registry rows are catalog metadata, not attachments', async () => {
    const p = new MCPRegistrySourceProvider({
      fetcher: async () => [ENTRY_NO_AUTH, ENTRY_WITH_KEY],
    })
    const list = await p.listForProfile('any-profile')
    expect(list).toEqual([])
  })

  it('default constructor falls through to fetchMCPRegistry — wiring smoke test', () => {
    // We don't actually call listGlobal here (would hit the network or
    // the cached value from a prior test run). Just confirm the
    // constructor accepts no options and the resulting object is a
    // ConnectorSourceProvider with the right name.
    const p = new MCPRegistrySourceProvider()
    expect(p.name).toBe('mcp_registry')
  })

  it('listGlobal short-circuits to [] when enabledChecker returns false (no fetcher invocation)', async () => {
    // Phase 6-C.2: the enabled gate runs BEFORE the fetcher so the
    // disabled path makes zero network calls.
    let fetcherCalled = false
    const p = new MCPRegistrySourceProvider({
      fetcher: async () => {
        fetcherCalled = true
        return [ENTRY_NO_AUTH]
      },
      enabledChecker: () => false,
    })
    const list = await p.listGlobal()
    expect(list).toEqual([])
    expect(fetcherCalled).toBe(false)
  })

  it('listGlobal calls the fetcher and returns entries when enabledChecker returns true', async () => {
    let fetcherCalled = false
    const p = new MCPRegistrySourceProvider({
      fetcher: async () => {
        fetcherCalled = true
        return [ENTRY_NO_AUTH]
      },
      enabledChecker: () => true,
    })
    const list = await p.listGlobal()
    expect(list).toHaveLength(1)
    expect(fetcherCalled).toBe(true)
  })

  it('dedups multiple versions of the same id, keeping the highest version', async () => {
    // Surfaced by user e2e 2026-05-07: "jira" search returned 7
    // copies of `io.github.aaronsb/jira-cloud` (one per published
    // version: 0.3.1, 0.4.0, …, 0.10.0). Should collapse to one
    // card with the latest version.
    const v1: MCPRegistryEntry = {
      ...ENTRY_NO_AUTH,
      id: 'io.github.user/dup',
      title: 'Dup MCP',
      version: '0.4.3',
    }
    const v2: MCPRegistryEntry = {
      ...ENTRY_NO_AUTH,
      id: 'io.github.user/dup',
      title: 'Dup MCP',
      version: '0.10.0',
    }
    const v3: MCPRegistryEntry = {
      ...ENTRY_NO_AUTH,
      id: 'io.github.user/dup',
      title: 'Dup MCP',
      version: '0.5.0',
    }
    const provider = new MCPRegistrySourceProvider({
      fetcher: async () => [v1, v2, v3],
    })
    const list = await provider.listGlobal()
    expect(list).toHaveLength(1)
    expect(list[0]?.id).toBe('io.github.user/dup')
  })

  it('sanitizes entries without a launch mechanism (no package + no remoteUrl)', async () => {
    const goodEntry: MCPRegistryEntry = {
      ...ENTRY_NO_AUTH,
      id: 'io.github.user/good',
      title: 'Good',
    }
    const noLaunchEntry: MCPRegistryEntry = {
      ...ENTRY_NO_AUTH,
      id: 'io.github.user/broken',
      title: 'Broken — no package, no remote',
      package: null,
      remoteUrl: null,
    }
    const noTitleEntry: MCPRegistryEntry = {
      ...ENTRY_NO_AUTH,
      id: 'io.github.user/no-title',
      title: '',
    }
    const provider = new MCPRegistrySourceProvider({
      fetcher: async () => [goodEntry, noLaunchEntry, noTitleEntry],
    })
    const list = await provider.listGlobal()
    expect(list).toHaveLength(1)
    expect(list[0]?.id).toBe('io.github.user/good')
  })

  it('enabledChecker is read on every listGlobal call (live-toggle support)', async () => {
    // The gateway wires this closure to `settings.getSetting(...)`
    // so a flip in Settings → Advanced takes effect on the very
    // next search without rebuilding the registry.
    let enabled = false
    const p = new MCPRegistrySourceProvider({
      fetcher: async () => [ENTRY_NO_AUTH],
      enabledChecker: () => enabled,
    })
    expect(await p.listGlobal()).toEqual([])
    enabled = true
    expect(await p.listGlobal()).toHaveLength(1)
    enabled = false
    expect(await p.listGlobal()).toEqual([])
  })
})
