/**
 * ConnectorRegistry unit tests.
 *
 * Verifies aggregation of built-in tools + MCP servers referenced by
 * discovered profiles, credential-driven status, and profile-scoped views.
 */

// Loom eagerly constructs provider clients at module load time. Supply
// dummy API keys BEFORE any loom import happens (via our src imports).
if (!process.env['OPENAI_API_KEY']) process.env['OPENAI_API_KEY'] = 'test-dummy'
if (!process.env['ANTHROPIC_API_KEY']) process.env['ANTHROPIC_API_KEY'] = 'test-dummy'
if (!process.env['GOOGLE_API_KEY']) process.env['GOOGLE_API_KEY'] = 'test-dummy'
// Offline: bypass the remote MCP registry — tests only use local featured
// data + the CredentialVault, never the network.
process.env['OWNWARE_SKIP_MCP_REGISTRY'] = '1'

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ConnectorRegistry } from '../../../src/connector/registry.js'
import { ProfileRegistry } from '../../../src/profile/registry.js'
import { CredentialVault, __resetMasterKeyCacheForTests } from '../../../src/connector/credentials/vault.js'
import { credentialVault as defaultVault } from '../../../src/connector/credentials/vault.js'
import { createTempProfile } from '../../helpers/fixtures.js'

let tmpHome: string
let prevHome: string | undefined
let prevOpenAI: string | undefined
let prevAnthropic: string | undefined

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'cortex-creg-'))
  prevHome = process.env['HOME']
  prevOpenAI = process.env['OPENAI_API_KEY']
  prevAnthropic = process.env['ANTHROPIC_API_KEY']
  process.env['HOME'] = tmpHome
  // Loom eagerly constructs provider clients at import time. Supply dummy
  // values so tests that indirectly import loom don't blow up.
  if (!process.env['OPENAI_API_KEY']) process.env['OPENAI_API_KEY'] = 'test-dummy'
  if (!process.env['ANTHROPIC_API_KEY']) process.env['ANTHROPIC_API_KEY'] = 'test-dummy'
  __resetMasterKeyCacheForTests()
})

afterEach(() => {
  if (prevHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = prevHome
  if (prevOpenAI === undefined) delete process.env['OPENAI_API_KEY']
  else process.env['OPENAI_API_KEY'] = prevOpenAI
  if (prevAnthropic === undefined) delete process.env['ANTHROPIC_API_KEY']
  else process.env['ANTHROPIC_API_KEY'] = prevAnthropic
  __resetMasterKeyCacheForTests()
  rmSync(tmpHome, { recursive: true, force: true })
})

async function buildProfileRegistryWithOneMCP(mcp: Record<string, unknown>): Promise<{
  registry: ProfileRegistry
  cleanup: () => Promise<void>
  profileName: string
}> {
  const parent = mkdtempSync(join(tmpdir(), 'cortex-profroot-'))
  const { dir: profileDir, cleanup } = await createTempProfile({
    'agent.json': JSON.stringify({
      name: 'test-agent',
      tools: { mcp },
    }),
  })
  // Move profile under parent so ProfileRegistry.discover() finds it.
  const { rename, mkdir } = await import('node:fs/promises')
  await mkdir(parent, { recursive: true })
  const finalPath = join(parent, 'test-agent')
  await rename(profileDir, finalPath)

  const registry = new ProfileRegistry()
  await registry.discover(parent)
  return {
    registry,
    profileName: 'test-agent',
    cleanup: async () => {
      await cleanup().catch(() => undefined)
      rmSync(parent, { recursive: true, force: true })
    },
  }
}

describe('ConnectorRegistry', () => {
  it('list() returns built-in connectors with source=builtin status=ready', async () => {
    // Session 1.5a: BuiltinSourceProvider now groups Loom builtin tools by
    // `Tool.category` into ONE Connector per category (browser, filesystem,
    // memory, search, shell, agent) with the lone exception `custom` which
    // stays 1:1. `toolNames` is the full member list for grouped cards and
    // `[id]` for custom cards.
    const pr = new ProfileRegistry()
    const cr = new ConnectorRegistry(pr)
    const all = await cr.list()
    const builtins = all.filter(c => c.source === 'builtin')
    expect(builtins.length).toBeGreaterThan(0)
    for (const b of builtins) {
      expect(b.status).toBe('ready')
      expect(b.auth.mode).toBe('none')
      // Every grouped card lists its category's tools; custom-category cards
      // list only themselves. Either way `toolNames` must be non-empty and
      // contain the card's own id for the custom case.
      expect(b.toolNames).not.toBeNull()
      expect(b.toolNames!.length).toBeGreaterThan(0)
      // `actions` is populated for every builtin emitted by 1.5a.
      expect(b.actions).toBeDefined()
      expect(b.actions!.length).toBe(b.toolNames!.length)
      // T15b: per-action Loom flags surface on builtin connectors so the client's
      // Abilities tab can drive the `readonly` preset + the read-only /
      // asks-first badges without a second round-trip to /tools/catalog.
      for (const action of b.actions!) {
        expect(typeof action.isReadOnly).toBe('boolean')
        expect(typeof action.requiresPermission).toBe('boolean')
      }
    }
    // Each grouped category is emitted exactly once.
    const groupedIds = builtins.map(b => b.id)
    for (const cat of ['browser', 'filesystem', 'memory', 'shell', 'agent']) {
      expect(groupedIds.filter(id => id === cat).length).toBe(1)
    }
  })

  it('get(id) finds a built-in connector', async () => {
    const pr = new ProfileRegistry()
    const cr = new ConnectorRegistry(pr)
    const all = await cr.list()
    const first = all[0]!
    const got = await cr.get(first.id)
    expect(got).not.toBeNull()
    expect(got!.id).toBe(first.id)
  })

  it('get(unknown) returns null', async () => {
    const pr = new ProfileRegistry()
    const cr = new ConnectorRegistry(pr)
    expect(await cr.get('no-such-thing')).toBeNull()
  })

  it('listForProfile() marks a known MCP server with required env as needs_setup when unset', async () => {
    // 'github' is in the featured list with required env vars.
    const { registry, cleanup, profileName } = await buildProfileRegistryWithOneMCP({
      'github': {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_PERSONAL_ACCESS_TOKEN}' },
      },
    })
    // Ensure no stray env var from the outer shell
    const prevGhTok = process.env['GITHUB_PERSONAL_ACCESS_TOKEN']
    delete process.env['GITHUB_PERSONAL_ACCESS_TOKEN']
    try {
      const cr = new ConnectorRegistry(registry)
      const scoped = await cr.listForProfile(profileName)
      const mcp = scoped.filter(c => c.source === 'mcp')
      expect(mcp.length).toBe(1)
      expect(mcp[0]!.id).toBe('github')
      expect(mcp[0]!.status).toBe('needs_setup')
      // Built-ins still present
      expect(scoped.filter(c => c.source === 'builtin').length).toBeGreaterThan(0)
    } finally {
      if (prevGhTok !== undefined) process.env['GITHUB_PERSONAL_ACCESS_TOKEN'] = prevGhTok
      await cleanup()
    }
  })

  it('listForProfile() marks MCP as ready when required env vars are set', async () => {
    const { registry, cleanup, profileName } = await buildProfileRegistryWithOneMCP({
      'github': {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_PERSONAL_ACCESS_TOKEN}' },
      },
    })
    const prevGhTok = process.env['GITHUB_PERSONAL_ACCESS_TOKEN']
    process.env['GITHUB_PERSONAL_ACCESS_TOKEN'] = 'gh_test_token'
    try {
      const cr = new ConnectorRegistry(registry)
      const scoped = await cr.listForProfile(profileName)
      const mcp = scoped.find(c => c.source === 'mcp')!
      expect(mcp.id).toBe('github')
      expect(mcp.status).toBe('ready')
    } finally {
      if (prevGhTok === undefined) delete process.env['GITHUB_PERSONAL_ACCESS_TOKEN']
      else process.env['GITHUB_PERSONAL_ACCESS_TOKEN'] = prevGhTok
      await cleanup()
    }
  })

  it('listForProfile() marks a custom unknown MCP server (no known env metadata) as ready', async () => {
    const { registry, cleanup, profileName } = await buildProfileRegistryWithOneMCP({
      'custom-server': {
        transport: 'stdio',
        command: 'echo',
        args: [],
        env: {},
      },
    })
    try {
      // Custom server with no known env vars → always ready by default.
      const cr = new ConnectorRegistry(registry)
      const scoped = await cr.listForProfile(profileName)
      const mcp = scoped.find(c => c.source === 'mcp')!
      expect(mcp.status).toBe('ready')
    } finally {
      await cleanup()
    }
  })

  it('listForProfile() returns [] for unknown profile', async () => {
    const pr = new ProfileRegistry()
    const cr = new ConnectorRegistry(pr)
    const scoped = await cr.listForProfile('does-not-exist')
    // No profile means MCP source yields []; builtin source yields its list
    expect(scoped.filter(c => c.source === 'mcp').length).toBe(0)
  })

  it('list() (global) aggregates MCP servers across every profile', async () => {
    const { registry, cleanup } = await buildProfileRegistryWithOneMCP({
      'server-a': { transport: 'stdio', command: 'echo', args: [], env: {} },
    })
    try {
      const cr = new ConnectorRegistry(registry)
      const all = await cr.list()
      expect(all.find(c => c.id === 'server-a' && c.source === 'mcp')).toBeDefined()
    } finally {
      await cleanup()
    }
  })

  it('refresh() resolves without error (hook for future sources)', async () => {
    const cr = new ConnectorRegistry(new ProfileRegistry())
    await expect(cr.refresh()).resolves.toBeUndefined()
  })

  // ---------------------------------------------------------------------
  // Session 1.5a — D3 (builtin grouping) + D4 (MCP union with featured)
  // ---------------------------------------------------------------------

  it('1.5a/D3: Browser category is emitted as ONE card with actions for every browser_* tool + web_fetch', async () => {
    const pr = new ProfileRegistry()
    const cr = new ConnectorRegistry(pr)
    const all = await cr.list()
    const browser = all.filter(c => c.source === 'builtin' && c.id === 'browser')
    expect(browser.length).toBe(1)
    const card = browser[0]!
    expect(card.canonicalId).toBe('builtin:browser')
    expect(card.name).toBe('Browser')
    expect(card.category).toBe('browser')
    expect(card.status).toBe('ready')
    expect(card.auth.mode).toBe('none')
    // 17 browser.ts tools + 1 web_fetch (category 'browser') = 18 actions.
    expect(card.actions!.length).toBe(18)
    const names = new Set(card.actions!.map(a => a.name))
    expect(names.has('browser_click')).toBe(true)
    expect(names.has('browser_console')).toBe(true)
    expect(names.has('web_fetch')).toBe(true)
    expect(card.toolNames).toEqual(card.actions!.map(a => a.name))
  })

  it('1.5a/D3: Filesystem card has 6 actions, Memory 3', async () => {
    const pr = new ProfileRegistry()
    const cr = new ConnectorRegistry(pr)
    const all = await cr.list()
    const fs = all.find(c => c.source === 'builtin' && c.id === 'filesystem')!
    expect(fs.actions!.length).toBe(6)
    expect(fs.toolNames!.includes('read_file') || fs.toolNames!.includes('readFile')).toBe(true)
    const mem = all.find(c => c.source === 'builtin' && c.id === 'memory')!
    expect(mem.actions!.length).toBe(3)
  })

  it('T15b: filesystem actions mirror Loom Tool.isReadOnly (readFile read-only, writeFile not)', async () => {
    const pr = new ProfileRegistry()
    const cr = new ConnectorRegistry(pr)
    const all = await cr.list()
    const fs = all.find(c => c.source === 'builtin' && c.id === 'filesystem')!
    const readFile = fs.actions!.find(a => a.name === 'readFile')
    const writeFile = fs.actions!.find(a => a.name === 'writeFile')
    expect(readFile).toBeDefined()
    expect(writeFile).toBeDefined()
    // The `readonly` preset in the client's Abilities tab depends on this
    // per-action flag to decide which filesystem tools fall inside the
    // preset base. A regression here silently breaks that UI.
    expect(readFile!.isReadOnly).toBe(true)
    expect(writeFile!.isReadOnly).toBe(false)
    // Both readFile and writeFile gate on permission as of the
    // permission-rule-revocation work — readFile is read-only but
    // still routes through the permission evaluator so users can
    // scope reads (e.g. deny reading from sensitive paths).
    expect(readFile!.requiresPermission).toBe(true)
    expect(writeFile!.requiresPermission).toBe(true)
  })

  it('1.5a/D3: Custom-category tools each appear as their own Connector (ask_user, image_generate, speech_*, request_credential, todo_write)', async () => {
    const pr = new ProfileRegistry()
    const cr = new ConnectorRegistry(pr)
    const all = await cr.list()
    const customs = all.filter(c => c.source === 'builtin' && c.category === 'custom')
    // ask_user + image_generate + speech_synthesize + speech_transcribe
    //   + request_credential (credential-isolation HITL)
    //   + todo_write (T02 — agent plan tracking, renders via Tasks panel).
    expect(customs.length).toBe(6)
    for (const c of customs) {
      expect(c.actions!.length).toBe(1)
      expect(c.actions![0]!.name).toBe(c.id)
      expect(c.toolNames).toEqual([c.id])
    }
    const ids = new Set(customs.map(c => c.id))
    expect(ids.has('ask_user')).toBe(true)
    expect(ids.has('image_generate')).toBe(true)
    expect(ids.has('request_credential')).toBe(true)
    expect(ids.has('todo_write')).toBe(true)
  })

  it('1.5a/D3: Search category delegates to webSearchBuilder and preserves pluggable fields', async () => {
    // When a builder is supplied (production path), the grouped search card
    // is replaced by the enriched web_search connector — canonicalId stays
    // `builtin:web_search` and providers/defaultProviderId survive.
    const pr = new ProfileRegistry()
    const stub = {
      id: 'web_search',
      canonicalId: 'builtin:web_search',
      logicalKey: 'web_search',
      name: 'Web Search',
      description: 'Search',
      source: 'builtin' as const,
      category: 'search' as const,
      auth: { mode: 'none' as const },
      status: 'ready' as const,
      toolNames: ['web_search'],
      actions: [{ name: 'web_search', description: 'Search' }],
      providers: [{
        id: 'duckduckgo', name: 'DuckDuckGo', description: 'd',
        auth: { mode: 'none' as const }, homepage: 'https://duckduckgo.com',
        isDefault: true, configured: true,
      }],
      activeProviderId: 'duckduckgo',
      defaultProviderId: 'duckduckgo',
      activeProviderSource: 'default' as const,
    }
    const cr = new ConnectorRegistry(pr, { webSearchBuilder: async () => stub })
    const all = await cr.list()
    const ws = all.find(c => c.canonicalId === 'builtin:web_search')
    expect(ws).toBeDefined()
    expect(ws!.providers!.length).toBeGreaterThan(0)
    expect(ws!.defaultProviderId).toBe('duckduckgo')
    expect(ws!.actions!.length).toBe(1)
    // No duplicate `builtin:search` emitted alongside the web_search card.
    expect(all.filter(c => c.canonicalId === 'builtin:search').length).toBe(0)
  })

  it('1.5a/D3: Search category falls back to grouped card when no builder is supplied', async () => {
    const pr = new ProfileRegistry()
    const cr = new ConnectorRegistry(pr)
    const all = await cr.list()
    // No webSearchBuilder → generic grouping path produces `builtin:search`.
    const search = all.find(c => c.canonicalId === 'builtin:search')
    expect(search).toBeDefined()
    expect(search!.actions!.length).toBe(1)
    expect(search!.actions![0]!.name).toBe('web_search')
  })

  it('1.5a/D4: featured MCP server appears with status=needs_setup when no profile references it', async () => {
    // `notion` is in FEATURED_SERVERS (requires OPENAPI_MCP_HEADERS).
    // No profile references it → it still surfaces globally, but with
    // `needs_setup` because the required env var is not set.
    const prevHdr = process.env['OPENAPI_MCP_HEADERS']
    delete process.env['OPENAPI_MCP_HEADERS']
    try {
      const pr = new ProfileRegistry()
      const cr = new ConnectorRegistry(pr)
      const all = await cr.list()
      const notion = all.find(c => c.source === 'mcp' && c.id === 'notion')
      expect(notion).toBeDefined()
      expect(notion!.status).toBe('needs_setup')
    } finally {
      if (prevHdr !== undefined) process.env['OPENAPI_MCP_HEADERS'] = prevHdr
    }
  })

  it('1.5a/D4: profile-referenced MCP server wins over featured entry (no duplicates)', async () => {
    // 'github' is in featured AND installed by this profile. Only ONE
    // connector record must surface, and it carries the profile-referenced
    // install state.
    const { registry, cleanup, profileName } = await buildProfileRegistryWithOneMCP({
      'github': {
        transport: 'stdio',
        command: 'npx',
        args: [],
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_PERSONAL_ACCESS_TOKEN}' },
      },
    })
    void profileName
    const prevTok = process.env['GITHUB_PERSONAL_ACCESS_TOKEN']
    delete process.env['GITHUB_PERSONAL_ACCESS_TOKEN']
    try {
      const cr = new ConnectorRegistry(registry)
      const all = await cr.list()
      const github = all.filter(c => c.source === 'mcp' && c.id === 'github')
      expect(github.length).toBe(1) // dedup worked
      expect(github[0]!.status).toBe('needs_setup') // profile-referenced status wins
    } finally {
      if (prevTok !== undefined) process.env['GITHUB_PERSONAL_ACCESS_TOKEN'] = prevTok
      await cleanup()
    }
  })

  it('iconUrl: MCP featured servers surface their featured-catalog icon', async () => {
    const cr = new ConnectorRegistry(new ProfileRegistry())
    const all = await cr.list()
    const github = all.find(c => c.source === 'mcp' && c.id === 'github')
    expect(github).toBeDefined()
    expect(github!.iconUrl).toBe('https://avatars.githubusercontent.com/github')
  })

  it('iconUrl: profile-only MCP (not in featured) has null iconUrl', async () => {
    const { registry, cleanup } = await buildProfileRegistryWithOneMCP({
      'my-unknown-server': {
        transport: 'stdio', command: 'echo', args: [], env: {},
      },
    })
    try {
      const cr = new ConnectorRegistry(registry)
      const all = await cr.list()
      const entry = all.find(c => c.source === 'mcp' && c.id === 'my-unknown-server')
      expect(entry).toBeDefined()
      expect(entry!.iconUrl ?? null).toBeNull()
    } finally {
      await cleanup()
    }
  })

  it('iconUrl: builtin connectors do not carry an iconUrl', async () => {
    const cr = new ConnectorRegistry(new ProfileRegistry())
    const all = await cr.list()
    const builtins = all.filter(c => c.source === 'builtin')
    expect(builtins.length).toBeGreaterThan(0)
    for (const b of builtins) {
      expect(b.iconUrl ?? null).toBeNull()
    }
  })

  it('1.5a/D4: profile-only MCP (not in featured) still emitted', async () => {
    const { registry, cleanup } = await buildProfileRegistryWithOneMCP({
      'my-custom-server': {
        transport: 'stdio', command: 'echo', args: [], env: {},
      },
    })
    try {
      const cr = new ConnectorRegistry(registry)
      const all = await cr.list()
      expect(all.find(c => c.source === 'mcp' && c.id === 'my-custom-server')).toBeDefined()
    } finally {
      await cleanup()
    }
  })

  // ---------------------------------------------------------------------
  // MCP category propagation (featured.category → Connector.category)
  // ---------------------------------------------------------------------

  it('MCP featured servers surface their featured-catalog category, not the generic "mcp" bucket', async () => {
    // Global list() unions profile MCPs + the featured catalog. With no
    // profile installed, every MCP entry comes from the featured list —
    // and each must carry its curated category, NOT the blanket 'mcp'.
    //
    // Tier 1 cull (2026-05-06) shrunk the set of categories that appear:
    // dev-tools, communication, productivity, finance survive. browser,
    // data, research disappeared along with their entries (Puppeteer,
    // Postgres, Brave Search, etc.).
    const cr = new ConnectorRegistry(new ProfileRegistry())
    const all = await cr.list()
    const mcp = all.filter(c => c.source === 'mcp')
    const byId = new Map(mcp.map(c => [c.id, c.category]))
    expect(byId.get('github')).toBe('dev-tools')
    expect(byId.get('gitlab')).toBe('dev-tools')
    expect(byId.get('notion')).toBe('communication')
    expect(byId.get('slack')).toBe('communication')
    expect(byId.get('stripe')).toBe('finance')
    expect(byId.get('linear')).toBe('productivity')
    expect(byId.get('hubspot')).toBe('productivity')
    expect(byId.get('gmail')).toBe('productivity')
    expect(byId.get('google-calendar')).toBe('productivity')
    expect(byId.get('google-drive')).toBe('productivity')
    expect(byId.get('google-sheets')).toBe('productivity')
    expect(byId.get('microsoft-365')).toBe('productivity')
    // figma (category 'design') is `hidden: true` in the featured
    // catalog until its PKCE OAuth phase lands, so it must NOT surface.
    expect(byId.has('figma')).toBe(false)
    // Aggregate sanity: every featured server has a category. None falls
    // through to the blanket 'mcp' bucket. The set of categories below
    // is the closed set surviving the Tier 1 cull ('design' is absent
    // while its only entry, figma, stays hidden).
    const categories = new Set(mcp.map(c => c.category))
    for (const expected of ['dev-tools', 'communication', 'productivity', 'finance']) {
      expect(categories.has(expected as (typeof mcp)[number]['category'])).toBe(true)
    }
  })

  it('MCP servers not in the featured catalog fall back to category="mcp"', async () => {
    // Custom user MCP (not in FEATURED_SERVERS, not in remote registry)
    // should not crash and should land in the generic 'mcp' bucket so the
    // UI still has a stable grouping for unknown/user-authored servers.
    const { registry, cleanup, profileName } = await buildProfileRegistryWithOneMCP({
      'totally-custom-user-mcp': {
        transport: 'stdio',
        command: 'echo',
        args: [],
        env: {},
      },
    })
    try {
      const cr = new ConnectorRegistry(registry)
      const scoped = await cr.listForProfile(profileName)
      const custom = scoped.find(c => c.source === 'mcp' && c.id === 'totally-custom-user-mcp')!
      expect(custom).toBeDefined()
      expect(custom.category).toBe('mcp')
    } finally {
      await cleanup()
    }
  })

  it('listForProfile surfaces the featured category for a profile-installed known MCP', async () => {
    // Reliability: a profile with Notion installed must surface
    // category='communication' (featured), not 'mcp'.
    const { registry, cleanup, profileName } = await buildProfileRegistryWithOneMCP({
      'notion': {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@notionhq/notion-mcp-server'],
        env: {},
      },
    })
    try {
      const cr = new ConnectorRegistry(registry)
      const scoped = await cr.listForProfile(profileName)
      const notion = scoped.find(c => c.source === 'mcp' && c.id === 'notion')!
      expect(notion).toBeDefined()
      expect(notion.category).toBe('communication')
    } finally {
      await cleanup()
    }
  })

  it('defaultVault round-trips to validate its wiring', async () => {
    // Sanity-check that the shared defaultVault still works in the test env.
    const v = new CredentialVault(join(tmpHome, 'c'))
    await v.save('probe', { X: '1' })
    expect((await v.load('probe'))!.env['X']).toBe('1')
    // And that the default export is a real instance.
    expect(defaultVault).toBeInstanceOf(Object)
  })

  // ── F4.c-2 — lastVerifiedAt wire projection ────────────────────────
  //
  // The Composio reconciler writes `connector_connections.last_verified_at`
  // via `ConnectorConnectionsStore.touchVerified()`. The registry's MCP
  // projection (`mcpServerToConnector` and `mcpRowToConnector`) reads
  // that column through the injected `lastVerifiedAtLookup` callback and
  // projects it as an ISO 8601 `lastVerifiedAt` on the wire. Field is
  // optional — when the lookup returns null the projection omits it.
  describe('lastVerifiedAt wire projection (F4.c-2)', () => {
    it('omits lastVerifiedAt when no lookup is supplied (default behaviour)', async () => {
      const { registry, cleanup, profileName } = await buildProfileRegistryWithOneMCP({
        'github': {
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_PERSONAL_ACCESS_TOKEN}' },
        },
      })
      try {
        // No `lastVerifiedAtLookup` → MCP entries must not carry the
        // wire field at all.
        const cr = new ConnectorRegistry(registry)
        const scoped = await cr.listForProfile(profileName)
        const mcp = scoped.find(c => c.source === 'mcp')!
        expect(mcp.lastVerifiedAt).toBeUndefined()
      } finally {
        await cleanup()
      }
    })

    it('projects lastVerifiedAt as ISO 8601 when the lookup returns a timestamp', async () => {
      const { registry, cleanup, profileName } = await buildProfileRegistryWithOneMCP({
        'github': {
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_PERSONAL_ACCESS_TOKEN}' },
        },
      })
      try {
        const verifiedMs = Date.UTC(2026, 4, 17, 12, 0, 0)
        const cr = new ConnectorRegistry(registry, {
          lastVerifiedAtLookup: (id, source) =>
            id === 'github' && source === 'mcp' ? verifiedMs : null,
        })
        const scoped = await cr.listForProfile(profileName)
        const mcp = scoped.find(c => c.source === 'mcp')!
        expect(mcp.lastVerifiedAt).toBe(new Date(verifiedMs).toISOString())
      } finally {
        await cleanup()
      }
    })

    it('omits lastVerifiedAt for connectors whose lookup returns null', async () => {
      const { registry, cleanup, profileName } = await buildProfileRegistryWithOneMCP({
        'github': {
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_PERSONAL_ACCESS_TOKEN}' },
        },
      })
      try {
        // Lookup returns null → registry treats this connector as
        // unverified and omits the field. Distinct from "no lookup
        // supplied at all" which short-circuits to the same outcome.
        const cr = new ConnectorRegistry(registry, {
          lastVerifiedAtLookup: () => null,
        })
        const scoped = await cr.listForProfile(profileName)
        const mcp = scoped.find(c => c.source === 'mcp')!
        expect(mcp.lastVerifiedAt).toBeUndefined()
      } finally {
        await cleanup()
      }
    })
  })
})
