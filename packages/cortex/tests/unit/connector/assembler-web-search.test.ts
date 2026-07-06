/**
 * Assembler web-search wire-in tests.
 *
 * Two end-to-end paths:
 *   1. Default config (no user choice, no env key) → resolver picks
 *      DuckDuckGo → assembler injects a SearchStrategy → invoking the
 *      `web_search` tool returns REAL results (we mock the strategy's
 *      HTTP, not the wire-up).
 *   2. User chose `brave` but no key configured → resolver falls back,
 *      but if brave is the ONLY option (we simulate by stubbing resolve
 *      to return needs_setup), the assembler swaps the real tool for a
 *      stub that emits `connector_not_ready` metadata.
 */

if (!process.env['OPENAI_API_KEY']) process.env['OPENAI_API_KEY'] = 'test-dummy'
if (!process.env['ANTHROPIC_API_KEY']) process.env['ANTHROPIC_API_KEY'] = 'test-dummy'
if (!process.env['GOOGLE_API_KEY']) process.env['GOOGLE_API_KEY'] = 'test-dummy'
process.env['OWNWARE_SKIP_MCP_REGISTRY'] = '1'

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadProfile } from '../../../src/profile/loader.js'
import { assembleAgent } from '../../../src/profile/assembler.js'
import { __resetMasterKeyCacheForTests } from '../../../src/connector/credentials/vault.js'
import { ConnectorNotReadyErrorSchema } from '../../../src/connector/schema.js'
import { WebSearchService, type WebSearchSettingsStore } from '../../../src/connector/web-search/service.js'
import type { WebSearchResolveResult } from '../../../src/connector/web-search/resolver.js'
import { createTempProfile } from '../../helpers/fixtures.js'
import type { ToolContext, ToolResult, SearchStrategyResult } from '@ownware/loom'

let tmpHome: string
let prevHome: string | undefined
let prevOpenRouterKey: string | undefined
let prevBraveKey: string | undefined
let prevTavilyKey: string | undefined

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'cortex-ws-assembler-'))
  prevHome = process.env['HOME']
  process.env['HOME'] = tmpHome
  // Strip search-provider env vars so the resolver picks the data-declared
  // default (DuckDuckGo). Local `.env` may set OPENROUTER_API_KEY for model
  // routing; left unstripped, the resolver auto-picks perplexity-openrouter
  // and the DDG-shaped fetch mock below stops matching.
  prevOpenRouterKey = process.env['OPENROUTER_API_KEY']
  prevBraveKey = process.env['BRAVE_SEARCH_API_KEY']
  prevTavilyKey = process.env['TAVILY_API_KEY']
  delete process.env['OPENROUTER_API_KEY']
  delete process.env['BRAVE_SEARCH_API_KEY']
  delete process.env['TAVILY_API_KEY']
  __resetMasterKeyCacheForTests()
})

afterEach(() => {
  if (prevHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = prevHome
  if (prevOpenRouterKey === undefined) delete process.env['OPENROUTER_API_KEY']
  else process.env['OPENROUTER_API_KEY'] = prevOpenRouterKey
  if (prevBraveKey === undefined) delete process.env['BRAVE_SEARCH_API_KEY']
  else process.env['BRAVE_SEARCH_API_KEY'] = prevBraveKey
  if (prevTavilyKey === undefined) delete process.env['TAVILY_API_KEY']
  else process.env['TAVILY_API_KEY'] = prevTavilyKey
  __resetMasterKeyCacheForTests()
  rmSync(tmpHome, { recursive: true, force: true })
})

function memorySettings(): WebSearchSettingsStore {
  const m = new Map<string, string>()
  return {
    getSetting: (key) => {
      const v = m.get(key)
      return v === undefined ? undefined : { value: v }
    },
    setSetting: (key, value) => { m.set(key, value); return undefined },
  }
}

function makeContext(config: Record<string, unknown>): ToolContext {
  return {
    cwd: process.cwd(),
    signal: new AbortController().signal,
    sessionId: 'test',
    agentId: null,
    workspacePath: process.cwd(),
    config: config as ToolContext['config'],
    requestPermission: async () => true,
  }
}

describe('assembler — web-search wire-in', () => {
  it('injects a working SearchStrategy when the profile is assembled with the service and the default provider is ready', async () => {
    const { dir, cleanup } = await createTempProfile({
      'agent.json': JSON.stringify({
        name: 'web-search-probe',
        tools: { preset: 'full' },
      }),
    })

    try {
      const profile = await loadProfile(dir)
      const service = new WebSearchService({ settings: memorySettings() })

      // Mock the strategy's network call via the shared fetch hook.
      // The real DuckDuckGo strategy issues a POST to
      // https://html.duckduckgo.com/html/ — we intercept to return a
      // tiny HTML body with one result.
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
        async (_input: unknown): Promise<Response> => {
          const body =
            '<html><body>' +
            '<div class="result">' +
            '<a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fpage">Example</a>' +
            '<a class="result__snippet">Example snippet.</a>' +
            '</div>' +
            '</body></html>'
          return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } })
        },
      )

      try {
        const agent = await assembleAgent(profile, { webSearchService: service })

        const webSearchTool = agent.tools.find(t => t.name === 'web_search')
        expect(webSearchTool).toBeDefined()
        // Real tool (not the stub) when ready.
        expect(webSearchTool!.description ?? '').not.toContain('[NOT CONNECTED]')

        // LoomConfig carries the strategy binding.
        const cfg = agent.config as unknown as Record<string, unknown>
        expect(cfg['webSearchStrategy']).toBeDefined()

        const result = await (
          webSearchTool!.execute({ query: 'example' }, makeContext(cfg)) as Promise<ToolResult>
        )
        expect(result.isError).toBe(false)
        expect(typeof result.content).toBe('string')
        expect(String(result.content)).toContain('example.com')

        await agent.mcpManager?.shutdown().catch(() => undefined)
      } finally {
        fetchSpy.mockRestore()
      }
    } finally {
      await cleanup()
    }
  })

  it('replaces the real tool with an enriched stub when the resolver reports needs_setup', async () => {
    const { dir, cleanup } = await createTempProfile({
      'agent.json': JSON.stringify({
        name: 'web-search-stub-probe',
        tools: { preset: 'full' },
      }),
    })

    try {
      const profile = await loadProfile(dir)
      const service = new WebSearchService({ settings: memorySettings() })

      // Force a needs_setup outcome without touching env/vault state.
      // (Exercises the stub branch directly — matches the scenario
      // "user picked Brave, no key anywhere".)
      const resolveSpy = vi.spyOn(service, 'resolve').mockResolvedValue({
        providerId: 'brave',
        provider: {
          id: 'brave',
          name: 'Brave Search',
          description: 'Brave API.',
          homepage: 'https://brave.com',
          auth: { mode: 'api_key', envVar: 'BRAVE_SEARCH_API_KEY' },
          isDefault: false,
        },
        source: 'user',
        status: 'needs_setup',
        reason: 'BRAVE_SEARCH_API_KEY is not set',
      } satisfies WebSearchResolveResult)

      try {
        const agent = await assembleAgent(profile, { webSearchService: service })

        const webSearchTool = agent.tools.find(t => t.name === 'web_search')
        expect(webSearchTool).toBeDefined()
        // Stub sets [NOT CONNECTED] marker.
        expect(webSearchTool!.description ?? '').toContain('[NOT CONNECTED]')

        // Config does NOT carry a strategy binding when we're in stub mode.
        const cfg = agent.config as unknown as Record<string, unknown>
        expect(cfg['webSearchStrategy']).toBeUndefined()

        const result = await (
          webSearchTool!.execute({ query: 'anything' }, makeContext(cfg)) as Promise<ToolResult>
        )
        expect(result.isError).toBe(true)
        const parsed = ConnectorNotReadyErrorSchema.parse(result.metadata)
        expect(parsed.kind).toBe('connector_not_ready')
        expect(parsed.connectorId).toBe('web_search')
        expect(parsed.source).toBe('builtin')
        expect(parsed.providerId).toBe('brave')
        expect(parsed.availableProviders).toBeDefined()
        expect(parsed.availableProviders!.length).toBeGreaterThan(0)

        await agent.mcpManager?.shutdown().catch(() => undefined)
      } finally {
        resolveSpy.mockRestore()
      }
    } finally {
      await cleanup()
    }
  })

  it('is a no-op when the profile has no web_search tool', async () => {
    const { dir, cleanup } = await createTempProfile({
      'agent.json': JSON.stringify({
        name: 'no-ws',
        tools: { preset: 'coding' }, // no web_search in coding preset
      }),
    })
    try {
      const profile = await loadProfile(dir)
      const service = new WebSearchService({ settings: memorySettings() })
      const resolveSpy = vi.spyOn(service, 'resolve')

      const agent = await assembleAgent(profile, { webSearchService: service })
      // Service.resolve() should never be called when web_search isn't in the list.
      expect(resolveSpy).not.toHaveBeenCalled()
      expect(agent.tools.find(t => t.name === 'web_search')).toBeUndefined()
      const cfg = agent.config as unknown as Record<string, unknown>
      expect(cfg['webSearchStrategy']).toBeUndefined()
      await agent.mcpManager?.shutdown().catch(() => undefined)
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      void SearchStrategyResultMarker
    } finally {
      await cleanup()
    }
  })
})

// Keep an (unused) import reference to SearchStrategyResult so tsc --noUnusedParameters
// style checks don't need special handling.
const SearchStrategyResultMarker: SearchStrategyResult | undefined = undefined
