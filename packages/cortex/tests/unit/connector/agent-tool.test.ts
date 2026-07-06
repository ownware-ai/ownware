/**
 * `connectors()` agent tool — Phase 5-B tests.
 *
 * Exercises every action (search, list_attached, status), the
 * ranking rules, query/filter behaviour, suggestion banners, and
 * the metadata channel the chat UI catches.
 */

if (!process.env['OPENAI_API_KEY']) process.env['OPENAI_API_KEY'] = 'test-dummy'
if (!process.env['ANTHROPIC_API_KEY']) process.env['ANTHROPIC_API_KEY'] = 'test-dummy'
if (!process.env['GOOGLE_API_KEY']) process.env['GOOGLE_API_KEY'] = 'test-dummy'
process.env['OWNWARE_SKIP_MCP_REGISTRY'] = '1'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ConnectorRegistry } from '../../../src/connector/registry.js'
import { ProfileRegistry } from '../../../src/profile/registry.js'
import { __resetMasterKeyCacheForTests, credentialVault } from '../../../src/connector/credentials/vault.js'
import { createConnectorsTool } from '../../../src/connector/agent-tool.js'
import {
  ConnectorAgentToolResultSchema,
  type ConnectorAgentToolResult,
  type ConnectorAttachedListResult,
  type ConnectorStatusResult,
} from '../../../src/connector/agent-tool-results.js'
import { createTempProfile } from '../../helpers/fixtures.js'

let tmpHome: string
let prevHome: string | undefined

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'cortex-agtl-'))
  prevHome = process.env['HOME']
  process.env['HOME'] = tmpHome
  __resetMasterKeyCacheForTests()
})

afterEach(() => {
  if (prevHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = prevHome
  __resetMasterKeyCacheForTests()
  rmSync(tmpHome, { recursive: true, force: true })
})

async function buildRegistryWithMCPs(
  mcp: Record<string, unknown>,
): Promise<{
  registry: ConnectorRegistry
  profileRegistry: ProfileRegistry
  cleanup: () => Promise<void>
  profileName: string
}> {
  const parent = mkdtempSync(join(tmpdir(), 'cortex-agtl-prof-'))
  const { dir: profileDir, cleanup } = await createTempProfile({
    'agent.json': JSON.stringify({
      name: 'test-agent',
      tools: { mcp },
    }),
  })
  const { rename, mkdir } = await import('node:fs/promises')
  await mkdir(parent, { recursive: true })
  const finalPath = join(parent, 'test-agent')
  await rename(profileDir, finalPath)
  const profileRegistry = new ProfileRegistry()
  await profileRegistry.discover(parent)
  const registry = new ConnectorRegistry(profileRegistry)
  return {
    registry,
    profileRegistry,
    profileName: 'test-agent',
    cleanup: async () => {
      await cleanup().catch(() => undefined)
      rmSync(parent, { recursive: true, force: true })
    },
  }
}

/** Run the tool with given input + parse the typed result out of metadata. */
async function runTool(
  registry: ConnectorRegistry,
  profileName: string,
  input: { action: 'list_attached' | 'status'; query?: string; filters?: { source?: 'builtin' | 'mcp' | 'composio'; status?: 'ready' | 'needs_setup' | 'error'; category?: string } },
): Promise<{ result: ConnectorAgentToolResult; isError: boolean; rawContent: string }> {
  const tool = createConnectorsTool({
    registry,
    profileId: profileName,
  })
  const out = await tool.execute(
    input,
    {
      cwd: '/tmp',
      signal: new AbortController().signal,
      sessionId: 'test',
      agentId: null,
      workspacePath: '/tmp',
      additionalWorkspaceRoots: [],
      config: {} as never,
      requestPermission: async () => true,
      requestCredential: async () => null,
      resolveCredential: () => null,
      listEnvCredentials: () => [],
      listAllCredentialValues: () => [],
    } as never,
  ) as { content: string; isError: boolean; metadata?: Record<string, unknown> }

  const meta = (out.metadata ?? {}) as { connectorAgentResult?: ConnectorAgentToolResult }
  // Normal path: parsed result is in metadata. Error path: metadata
  // is empty and content is `{"error": "..."}`.
  const result = meta.connectorAgentResult
    ?? ({ type: 'connector_attached_list', items: [] } as ConnectorAgentToolResult)
  return { result, isError: out.isError, rawContent: out.content }
}

describe('connectors() — search action removed', () => {
  // Removed 2026-05-12 as part of the connector surfaces collapse.
  // Chat is no longer a marketplace; users add connectors via the
  // AbilityRail's +Add button or via Profile abilities. The agent's
  // `connectors()` tool no longer has a `search` action.
  //
  // This describe block previously held 11 tests for search ranking,
  // filtering, trigram similarity, grouping, and suggestion banners.
  // All of that logic was deleted from agent-tool.ts alongside the
  // action itself. The wire types in agent-tool-results.ts
  // (ConnectorSearchResult, ConnectorGroup, ConnectorGroupTier,
  // ConnectorSourceSuggestion) are retained @deprecated so the chat
  // UI can still hydrate `connector_search_result` payloads loaded
  // from chat history that was recorded before 2026-05-12. Slice G
  // of the connector-rail board removes them entirely once history
  // hydration of pre-rip threads is no longer relevant.
  it('does not return a connector_search_result for the removed search action', async () => {
    const { registry, profileName, cleanup } = await buildRegistryWithMCPs({})
    try {
      const tool = createConnectorsTool({ registry, profileId: profileName })
      // The typed Input no longer accepts 'search'; cast through
      // `unknown` to simulate a stale LLM emitting the old action.
      // The switch in execute() has no 'search' arm — any non-
      // success outcome (undefined, throw, error-shaped result) is
      // acceptable; what matters is that no `connector_search_result`
      // payload escapes the tool, so the chat UI cannot render a
      // marketplace card from this path. Belt-and-braces alongside
      // the schema's `enum: ['list_attached', 'status']` validator
      // that fires before execute() is even called in production.
      let escapedSearchResult: unknown = null
      try {
        const out = (await tool.execute(
          { action: 'search', query: 'gmail' } as unknown as { action: 'list_attached' | 'status' },
          {} as never,
        )) as { content?: string } | undefined
        if (out?.content != null) {
          const parsed = JSON.parse(out.content) as { type?: string }
          if (parsed.type === 'connector_search_result') escapedSearchResult = parsed
        }
      } catch {
        // Throwing is also an acceptable rejection path.
      }
      expect(escapedSearchResult).toBeNull()
    } finally {
      await cleanup()
    }
  })
})

describe('connectors() — list_attached', () => {
  it('returns ready connectors only (excludes needs_setup)', async () => {
    const { registry, profileName, cleanup } = await buildRegistryWithMCPs({
      github: {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_PERSONAL_ACCESS_TOKEN}' },
      },
      linear: {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'linear-mcp-server'],
        env: { LINEAR_API_KEY: '${LINEAR_API_KEY}' },
      },
    })
    await credentialVault.save('linear', { LINEAR_API_KEY: 'lin_test' })
    try {
      const { result } = await runTool(registry, profileName, { action: 'list_attached' })
      if (result.type !== 'connector_attached_list') {
        throw new Error('wrong result type')
      }
      // Builtins are excluded by handleListAttached now — no need
      // to filter to source=mcp here (legacy workaround removed
      // 2026-05-07).
      expect(result.items.find((c) => c.id === 'linear')).toBeDefined()
      expect(result.items.find((c) => c.id === 'github')).toBeUndefined()
    } finally {
      await cleanup()
    }
  })

  it('excludes built-in connectors entirely (filesystem, shell, browser, …)', async () => {
    // Surfaced by user e2e on 2026-05-07: clicking "what services
    // do I have connected?" returned every Loom built-in (Filesystem,
    // Shell, Browser, Memory, Web Search, Generate Image, Speak
    // Aloud, Transcribe Audio, etc.) alongside the user's actual
    // connections. Architecturally wrong — built-ins are inherent
    // capabilities, not user-installed connections. The action
    // means "what THIRD-PARTY services have I connected?" and
    // built-ins must never appear.
    const { registry, profileName, cleanup } = await buildRegistryWithMCPs({})
    try {
      const { result } = await runTool(registry, profileName, {
        action: 'list_attached',
      })
      if (result.type !== 'connector_attached_list') {
        throw new Error('wrong result type')
      }
      // Empty profile + no MCP credentials → list_attached must be
      // empty. Specifically NOT a list of all built-ins.
      const builtins = result.items.filter((c) => c.source === 'builtin')
      expect(
        builtins.length,
        `built-ins must not appear in list_attached, got ${builtins.map((b) => b.name).join(', ')}`,
      ).toBe(0)
    } finally {
      await cleanup()
    }
  })

  it('attaches connectedAt + toolCount on each item', async () => {
    const { registry, profileName, cleanup } = await buildRegistryWithMCPs({
      linear: {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'linear-mcp-server'],
        env: { LINEAR_API_KEY: '${LINEAR_API_KEY}' },
      },
    })
    await credentialVault.save('linear', { LINEAR_API_KEY: 'lin_test' })
    try {
      const { result } = await runTool(registry, profileName, { action: 'list_attached' })
      if (result.type !== 'connector_attached_list') {
        throw new Error('wrong result type')
      }
      const linear = result.items.find((c) => c.id === 'linear')
      expect(linear).toBeDefined()
      expect(linear?.connectedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      expect(typeof linear?.toolCount).toBe('number')
    } finally {
      await cleanup()
    }
  })
})

describe('connectors() — status', () => {
  it('returns the status of a known connector by canonicalId', async () => {
    const { registry, profileName, cleanup } = await buildRegistryWithMCPs({
      github: {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_PERSONAL_ACCESS_TOKEN}' },
      },
    })
    try {
      const { result } = await runTool(registry, profileName, {
        action: 'status',
        query: 'mcp:github',
      })
      if (result.type !== 'connector_status') {
        throw new Error('wrong result type')
      }
      expect(result.id).toBe('github')
      expect(result.canonicalId).toBe('mcp:github')
      expect(result.status).toBe('needs_setup')
    } finally {
      await cleanup()
    }
  })

  it('falls back to source-local id when canonicalId not matched', async () => {
    const { registry, profileName, cleanup } = await buildRegistryWithMCPs({
      github: {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_PERSONAL_ACCESS_TOKEN}' },
      },
    })
    try {
      const { result } = await runTool(registry, profileName, {
        action: 'status',
        query: 'github',
      })
      if (result.type !== 'connector_status') {
        throw new Error('wrong result type')
      }
      expect(result.canonicalId).toBe('mcp:github')
    } finally {
      await cleanup()
    }
  })

  it('returns an error result when the id is unknown', async () => {
    const { registry, profileName, cleanup } = await buildRegistryWithMCPs({})
    try {
      const tool = createConnectorsTool({ registry, profileId: profileName })
      const out = await tool.execute(
        { action: 'status', query: 'no-such-thing' },
        {} as never,
      ) as { content: string; isError: boolean }
      expect(out.isError).toBe(true)
      expect(out.content).toContain('No connector matches')
      expect(out.content).toContain('ability rail')
    } finally {
      await cleanup()
    }
  })
})

describe('result shape — content + metadata channels', () => {
  it('packs the same parsed object into metadata.connectorAgentResult and content JSON', async () => {
    const { registry, profileName, cleanup } = await buildRegistryWithMCPs({})
    try {
      const tool = createConnectorsTool({ registry, profileId: profileName })
      // `list_attached` is the always-available non-error path; use it
      // to exercise the content/metadata duplication contract. Pre-2026-
      // 05-12 this used `action: 'search'`; that action no longer exists.
      const out = await tool.execute(
        { action: 'list_attached' },
        {} as never,
      ) as { content: string; isError: boolean; metadata?: Record<string, unknown> }
      const fromContent = JSON.parse(out.content) as ConnectorAgentToolResult
      const fromMetadata = (out.metadata ?? {}).connectorAgentResult as ConnectorAgentToolResult
      expect(fromContent).toEqual(fromMetadata)
      // Round-trips through the wire schema.
      expect(() => ConnectorAgentToolResultSchema.parse(fromContent)).not.toThrow()
    } finally {
      await cleanup()
    }
  })
})
