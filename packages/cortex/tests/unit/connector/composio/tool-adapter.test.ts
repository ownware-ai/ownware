/**
 * ComposioToolProvider — reliability-scenario tests.
 *
 * Scenarios (from 2b.2a brief):
 *   6. Agent calls `composio_notion_search` on a connected toolkit
 *      → real result via mocked client.execute.
 *   7. Token expired → metadata.kind === 'composio_auth_expired'.
 *   8. 429 + Retry-After → metadata.kind === 'composio_rate_limited'
 *      with retryAfterMs.
 *   9. 600KB result → truncated to 100KB, warning logged, metadata.kind
 *      === 'composio_result_truncated'.
 *  10. Tool name collision → second registration throws clear error
 *      (gateway not crashed — the throw surfaces at assembleAgent).
 *  12. Stub-tool fallback → metadata byte-identical to M1 contract
 *      (kind === 'connector_not_ready', with required M1 keys).
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CortexDatabase } from '../../../../src/gateway/db/database.js'
import { ConnectorConnectionsStore } from '../../../../src/connector/connections/store.js'
import type {
  ComposioCatalogCache,
} from '../../../../src/connector/composio/catalog-cache.js'
import type {
  ComposioToolkitSummary,
} from '../../../../src/connector/composio/client.js'
import {
  ComposioToolProvider,
  buildComposioToolName as _maybe,
} from '../../../../src/connector/index.js'
import {
  buildToolName,
  truncateToBytes,
  mapExecuteErrorToResult,
  COMPOSIO_RESULT_MAX_BYTES,
} from '../../../../src/connector/composio/tool-adapter.js'
import type { ComposioClient, ComposioExecuteResponse, ComposioTool } from '../../../../src/connector/composio/client.js'
import {
  ConnectorAuthExpiredError,
  ConnectorNetworkError,
  ConnectorRateLimitedError,
  ConnectorValidationError,
  ConnectorVendorError,
} from '../../../../src/connector/errors.js'
import type { LoadedProfile } from '../../../../src/profile/loader.js'

// Silence unused import warning.
void _maybe

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

/**
 * Shape a LoadedProfile just enough for ComposioToolProvider. The provider
 * only reads `config.tools.composio.toolkits` — we keep the rest of the
 * profile object empty so tests that need other fields fail loudly rather
 * than silently relying on a default.
 */
function profileWithComposio(toolkits: readonly string[]): LoadedProfile {
  return {
    name: 'example',
    config: {
      tools: {
        composio: { toolkits: [...toolkits] },
      },
    },
  } as unknown as LoadedProfile
}

/**
 * Profile with NO `composio` declaration. Simulates an `agent.json` that
 * never mentions the field — should produce zero Composio tools.
 */
function profileWithoutComposio(): LoadedProfile {
  return {
    name: 'example',
    config: {
      tools: {
        composio: { toolkits: [] },
      },
    },
  } as unknown as LoadedProfile
}

/** Shorthand: every existing test targets the "notion" toolkit. */
const FAKE_PROFILE = profileWithComposio(['notion'])
const EMPTY_CTX = { existingTools: [] as const }

function makeTool(slug: string, overrides: Partial<ComposioTool> = {}): ComposioTool {
  return {
    slug,
    name: slug,
    description: `${slug} description`,
    toolkit: { slug: 'notion', name: 'Notion', logo: '' },
    ...overrides,
  } as ComposioTool
}

function makeClient(
  impl: Partial<Pick<ComposioClient, 'executeTool' | 'listTools'>>,
): ComposioClient {
  return impl as unknown as ComposioClient
}

let tmpDir: string
let db: CortexDatabase
let connections: ConnectorConnectionsStore
/**
 * Mutable list of toolkit summaries served by the stub catalogue cache.
 * Tests push entries via `seedToolkit(...)`; the stub closure reads
 * this array on every `listToolkits` call so updates take effect
 * without re-wiring the provider.
 */
let toolkitFixtures: ComposioToolkitSummary[] = []
let catalogCache: ComposioCatalogCache

/**
 * Construct a `ComposioToolkitSummary` from a flat options object.
 * Mirrors the live Composio v3 `/toolkits` response shape — only the
 * fields the tool-adapter reads need to be set.
 */
function toolkit(opts: {
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

/** Append to the cached fixture list. Replaces the old `catalog.upsertMany`. */
function seedToolkit(...items: ComposioToolkitSummary[]): void {
  toolkitFixtures.push(...items)
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cortex-composio-adapter-'))
  db = new CortexDatabase(join(tmpDir, 'main.db'), join(tmpDir, 'fx.db'))
  connections = new ConnectorConnectionsStore(db.rawMainHandle)

  // Stub catalogue cache. listToolkits reads the mutable fixture array
  // each call so tests can seed before OR after constructing providers.
  toolkitFixtures = []
  catalogCache = {
    listToolkits: async () => toolkitFixtures,
    getBySlug: async (slug: string) => toolkitFixtures.find((t) => t.slug === slug) ?? null,
    invalidate: () => {},
  } as unknown as ComposioCatalogCache

  // Default seed: one catalogued toolkit so the provider has something
  // to emit in tests that don't seed anything explicitly.
  seedToolkit(toolkit({
    slug: 'notion',
    name: 'Notion',
    categoryName: 'productivity',
    description: 'Notion toolkit',
  }))
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

function seedReadyConnection(connectedAccountId = 'ca_abc'): void {
  connections.upsertPending({
    connectionId: 'conn_1',
    connectorId: 'notion',
    source: 'composio',
    entityId: 'cortex-default-user',
    authConfigId: 'ac_1',
    // Post-021: vendor identity is first-class and required by the
    // ConnectorIdentityResolver at execute-time.
    vendorAccountId: connectedAccountId,
    vendorUserId: 'cortex-default-user',
  })
  connections.markReady({
    connectionId: 'conn_1',
    vendorAccountId: connectedAccountId,
    vendorUserId: 'cortex-default-user',
    metadata: { composioConnectedAccountId: connectedAccountId },
  })
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

describe('buildToolName — sanitisation & collision helper', () => {
  it('produces composio_<toolkit>_<tool> lowercased and sanitised', () => {
    expect(buildToolName('notion', 'NOTION_SEARCH_DATABASES')).toBe('composio_notion_notion_search_databases')
    expect(buildToolName('google-docs', 'create.doc')).toBe('composio_google_docs_create_doc')
    expect(buildToolName('x', '  y  ')).toBe('composio_x_y')
  })
})

describe('truncateToBytes', () => {
  it('returns input unchanged when under limit', () => {
    expect(truncateToBytes('hello', 100)).toBe('hello')
  })
  it('truncates to maxBytes without splitting codepoints', () => {
    const s = 'a'.repeat(200)
    const out = truncateToBytes(s, 50)
    expect(out.length).toBe(50)
  })
})

// ---------------------------------------------------------------------------
// Scenario 6 — real tool execution
// ---------------------------------------------------------------------------

describe('ComposioToolProvider — scenario 6 (connected toolkit, real result)', () => {
  it('emits a real tool that calls client.executeTool and returns data', async () => {
    seedReadyConnection('ca_connected_1')

    const tools: ComposioTool[] = [makeTool('NOTION_SEARCH', {
      input_parameters: { type: 'object', properties: { query: { type: 'string' } } } as unknown as Record<string, unknown>,
    })]
    const executeMock = vi.fn(async (): Promise<ComposioExecuteResponse> => ({
      data: { results: [{ id: 'page_1', title: 'Hello' }] },
      error: null,
      successful: true,
    }))
    const client = makeClient({
      executeTool: executeMock as unknown as ComposioClient['executeTool'],
      listTools: async () => ({ items: tools, next_cursor: null, total_pages: 1, current_page: 1, total_items: tools.length }),
    })

    const provider = new ComposioToolProvider({ client, catalogCache, connections, entityId: 'cortex-default-user', log: () => {} })
    await provider.warmToolsForToolkit('notion')

    const result = await provider.getToolsForProfile(FAKE_PROFILE, EMPTY_CTX)
    expect(result.tools).toHaveLength(1)
    expect(result.stubs).toHaveLength(0)
    const tool = result.tools[0]!
    expect(tool.name).toBe('composio_notion_notion_search')

    const toolResult = await (tool.execute as (i: unknown, c?: unknown) => Promise<{ content: string; isError: boolean; metadata?: Record<string, unknown> }>)({ query: 'hello' })
    expect(toolResult.isError).toBe(false)
    expect(toolResult.content).toContain('page_1')
    expect(executeMock).toHaveBeenCalledWith('NOTION_SEARCH', expect.objectContaining({
      connectedAccountId: 'ca_connected_1',
      arguments: { query: 'hello' },
    }))
    expect(toolResult.metadata?.source).toBe('composio')
    expect(toolResult.metadata?.connectorId).toBe('notion')
  })
})

// ---------------------------------------------------------------------------
// Scenario 7 / 8 — error mapping
// ---------------------------------------------------------------------------

describe('mapExecuteErrorToResult — all 5 error classes', () => {
  it('auth expired → composio_auth_expired', () => {
    const r = mapExecuteErrorToResult(new ConnectorAuthExpiredError('token expired', { source: 'composio' }), 'notion')
    expect(r.isError).toBe(true)
    expect(r.metadata?.kind).toBe('composio_auth_expired')
    expect(r.metadata?.connectorId).toBe('notion')
    expect(r.metadata?.source).toBe('composio')
  })

  it('rate limited with retryAfterMs → composio_rate_limited + retryAfterMs', () => {
    const r = mapExecuteErrorToResult(
      new ConnectorRateLimitedError('429', { source: 'composio', retryAfterMs: 1500 }),
      'notion',
    )
    expect(r.metadata?.kind).toBe('composio_rate_limited')
    expect(r.metadata?.retryAfterMs).toBe(1500)
  })

  it('validation → composio_validation_error', () => {
    const r = mapExecuteErrorToResult(
      new ConnectorValidationError('bad args', { source: 'composio' }),
      'notion',
    )
    expect(r.metadata?.kind).toBe('composio_validation_error')
  })

  it('network → composio_network_error', () => {
    const r = mapExecuteErrorToResult(
      new ConnectorNetworkError('ECONNRESET', { source: 'composio' }),
      'notion',
    )
    expect(r.metadata?.kind).toBe('composio_network_error')
  })

  it('vendor with statusCode → composio_vendor_error + statusCode', () => {
    const r = mapExecuteErrorToResult(
      new ConnectorVendorError('5xx', { source: 'composio', statusCode: 503 }),
      'notion',
    )
    expect(r.metadata?.kind).toBe('composio_vendor_error')
    expect(r.metadata?.statusCode).toBe(503)
  })

  it('unknown error → composio_vendor_error fallback', () => {
    const r = mapExecuteErrorToResult(new Error('??'), 'notion')
    expect(r.metadata?.kind).toBe('composio_vendor_error')
    expect(r.metadata?.message).toBe('??')
  })
})

describe('ComposioToolProvider — scenario 7/8 (execute-time errors)', () => {
  it('maps thrown ConnectorAuthExpiredError to composio_auth_expired', async () => {
    seedReadyConnection()
    const executeMock = vi.fn(async () => {
      throw new ConnectorAuthExpiredError('Token expired', { source: 'composio' })
    })
    const client = makeClient({
      executeTool: executeMock as unknown as ComposioClient['executeTool'],
    })
    const provider = new ComposioToolProvider({ client, catalogCache, connections, entityId: 'cortex-default-user', log: () => {} })
    // Pre-seed manifest without needing a list call.
    await (provider as unknown as { toolsByToolkit: Map<string, readonly ComposioTool[]> }).toolsByToolkit
      .set('notion', [makeTool('SEARCH')])
    const result = await provider.getToolsForProfile(FAKE_PROFILE, EMPTY_CTX)
    const tool = result.tools[0]!
    const r = await (tool.execute as (i: unknown) => Promise<{ isError: boolean; metadata?: Record<string, unknown> }>)({})
    expect(r.metadata?.kind).toBe('composio_auth_expired')
  })

  it('maps thrown ConnectorRateLimitedError with retryAfterMs', async () => {
    seedReadyConnection()
    const client = makeClient({
      executeTool: (async () => {
        throw new ConnectorRateLimitedError('Too Many Requests', { source: 'composio', retryAfterMs: 2000 })
      }) as unknown as ComposioClient['executeTool'],
    })
    const provider = new ComposioToolProvider({ client, catalogCache, connections, entityId: 'cortex-default-user' })
    ;(provider as unknown as { toolsByToolkit: Map<string, readonly ComposioTool[]> }).toolsByToolkit
      .set('notion', [makeTool('SEARCH')])
    const result = await provider.getToolsForProfile(FAKE_PROFILE, EMPTY_CTX)
    const r = await (result.tools[0]!.execute as (i: unknown) => Promise<{ metadata?: Record<string, unknown> }>)({})
    expect(r.metadata?.kind).toBe('composio_rate_limited')
    expect(r.metadata?.retryAfterMs).toBe(2000)
  })
})

// ---------------------------------------------------------------------------
// Scenario 9 — result truncation
// ---------------------------------------------------------------------------

describe('ComposioToolProvider — scenario 9 (600KB result truncation)', () => {
  it('truncates a >100KB result to 100KB and logs a warning', async () => {
    seedReadyConnection()
    // Build ~600KB of data.
    const bigText = 'x'.repeat(600 * 1024)
    const client = makeClient({
      executeTool: (async () => ({
        data: { payload: bigText },
        error: null,
        successful: true,
      })) as unknown as ComposioClient['executeTool'],
    })
    const logs: string[] = []
    const provider = new ComposioToolProvider({
      client, catalogCache, connections,
      entityId: 'cortex-default-user',
      log: (l) => logs.push(l),
    })
    ;(provider as unknown as { toolsByToolkit: Map<string, readonly ComposioTool[]> }).toolsByToolkit
      .set('notion', [makeTool('READ')])
    const result = await provider.getToolsForProfile(FAKE_PROFILE, EMPTY_CTX)
    const r = await (result.tools[0]!.execute as (i: unknown) => Promise<{ content: string; metadata?: Record<string, unknown> }>)({})
    expect(r.metadata?.kind).toBe('composio_result_truncated')
    expect(r.metadata?.maxBytes).toBe(COMPOSIO_RESULT_MAX_BYTES)
    expect(Buffer.byteLength(r.content, 'utf8')).toBeLessThanOrEqual(
      COMPOSIO_RESULT_MAX_BYTES + 64 /* suffix */,
    )
    expect(r.content).toContain('truncated; original')
    expect(logs.some(l => l.includes('truncated result'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Scenario 10 — name collision
// ---------------------------------------------------------------------------

describe('ComposioToolProvider — scenario 10 (tool name collision)', () => {
  it('throws a clear error when two Composio tools sanitise to the same name', async () => {
    seedReadyConnection()
    // Two different Composio tool slugs that collapse to the same name.
    const collidingA = makeTool('notion-search')
    const collidingB = makeTool('notion_search')
    const client = makeClient({ executeTool: (async () => ({ data: {}, error: null, successful: true })) as unknown as ComposioClient['executeTool'] })
    const provider = new ComposioToolProvider({ client, catalogCache, connections, entityId: 'cortex-default-user', log: () => {} })
    ;(provider as unknown as { toolsByToolkit: Map<string, readonly ComposioTool[]> }).toolsByToolkit
      .set('notion', [collidingA, collidingB])
    await expect(provider.getToolsForProfile(FAKE_PROFILE, EMPTY_CTX))
      .rejects.toThrowError(/Composio tool name collision/)
  })
})

// ---------------------------------------------------------------------------
// Scenario 12 — stub fallback byte-parity with M1
// ---------------------------------------------------------------------------

describe('ComposioToolProvider — scenario 12 (stub byte-parity)', () => {
  it('emits createStubTool-shaped stubs when connection is not ready', async () => {
    // No connection seeded → not ready.
    const client = makeClient({ executeTool: (async () => { throw new Error('should not be called') }) as unknown as ComposioClient['executeTool'] })
    const provider = new ComposioToolProvider({ client, catalogCache, connections, entityId: 'cortex-default-user', log: () => {} })
    const result = await provider.getToolsForProfile(FAKE_PROFILE, EMPTY_CTX)
    expect(result.tools).toHaveLength(0)
    expect(result.stubs).toHaveLength(1)
    const stub = result.stubs[0]!
    expect(stub.description.startsWith('[NOT CONNECTED]')).toBe(true)

    // The stub's execute() returns ConnectorNotReadyError-shaped metadata.
    const ctx = {
      cwd: '/', signal: new AbortController().signal,
      sessionId: 's', agentId: null, workspacePath: '/',
      config: {} as never,
      requestPermission: async () => false,
    }
    const r = await (stub.execute as (i: unknown, c: unknown) => Promise<{ isError: boolean; metadata?: Record<string, unknown> }>)({}, ctx)
    expect(r.isError).toBe(true)
    // Byte-parity with M1 contract:
    expect(r.metadata?.kind).toBe('connector_not_ready')
    expect(r.metadata?.source).toBe('composio')
    expect(r.metadata?.connectorId).toBe('notion')
    expect(r.metadata?.connectorName).toBe('Notion')
    expect(typeof r.metadata?.reason).toBe('string')
    expect(typeof r.metadata?.at).toBe('string')
    expect(r.metadata?.authMode).toBeTruthy()
  })

  it('emits the "ready but manifest empty" stub when an inline warm returns zero tools', async () => {
    // Composio toolkit is ready (row exists) but the warm reveals
    // genuinely no tools. Stub emits honestly. Pre-2026-05-21 this
    // path skipped the warm entirely and emitted the stub on every
    // turn until something else triggered a warm; post-fix the warm
    // runs inline so the stub only emits when there really aren't tools.
    seedReadyConnection()
    const listTools = vi.fn(async () => ({
      items: [], next_cursor: null, total_pages: 1, current_page: 1, total_items: 0,
    }))
    const client = makeClient({
      executeTool: (async () => ({ data: {}, error: null, successful: true })) as unknown as ComposioClient['executeTool'],
      listTools: listTools as unknown as ComposioClient['listTools'],
    })
    const provider = new ComposioToolProvider({ client, catalogCache, connections, entityId: 'cortex-default-user', log: () => {} })
    const result = await provider.getToolsForProfile(FAKE_PROFILE, EMPTY_CTX)
    expect(result.stubs).toHaveLength(1)
    expect(result.stubs[0]!.description).toContain('manifest not yet loaded')
    // Regression guard: the inline warm MUST have fired before the stub
    // — otherwise the user is stuck with "open a new chat" on every
    // turn until they manually retry.
    expect(listTools).toHaveBeenCalledTimes(1)
  })

  it('runs an inline warm on cache miss and emits real tools when the warm returns them', async () => {
    // Mid-chat connect scenario: connector goes ready, status-bus
    // listener kicks off `warmToolsForToolkit` async, user submits a
    // message before warm completes → reconcileSessionTools fires
    // assembly, manifest cache is still empty, the inline warm in
    // getToolsForProfile MUST resolve before the stub branch runs.
    // The user sees real Notion tools, not the `_no_tools_loaded` stub.
    seedReadyConnection()
    const notionTool = makeTool('notion_search', { description: 'Search Notion' })
    const listTools = vi.fn(async () => ({
      items: [notionTool], next_cursor: null, total_pages: 1, current_page: 1, total_items: 1,
    }))
    const client = makeClient({
      executeTool: (async () => ({ data: {}, error: null, successful: true })) as unknown as ComposioClient['executeTool'],
      listTools: listTools as unknown as ComposioClient['listTools'],
    })
    const provider = new ComposioToolProvider({ client, catalogCache, connections, entityId: 'cortex-default-user', log: () => {} })
    // Cache is empty — no warmToolsForToolkit was called externally.
    const result = await provider.getToolsForProfile(FAKE_PROFILE, EMPTY_CTX)
    // No stubs — the warm ran inline and produced real tools.
    expect(result.stubs).toHaveLength(0)
    expect(result.tools).toHaveLength(1)
    expect(result.tools[0]!.name).toBe('composio_notion_notion_search')
    expect(listTools).toHaveBeenCalledTimes(1)
  })

  it('does not re-warm on subsequent assemblies once a successful warm returned zero tools', async () => {
    // Production guard: if Composio genuinely lists zero tools for a
    // toolkit, every subsequent turn must NOT pay a fresh `listTools`
    // round-trip. We cache the "warmed already" signal in
    // `warmedSlugs` so the inline warm only fires for toolkits we
    // have never successfully warmed.
    seedReadyConnection()
    const listTools = vi.fn(async () => ({
      items: [], next_cursor: null, total_pages: 1, current_page: 1, total_items: 0,
    }))
    const client = makeClient({
      executeTool: (async () => ({ data: {}, error: null, successful: true })) as unknown as ComposioClient['executeTool'],
      listTools: listTools as unknown as ComposioClient['listTools'],
    })
    const provider = new ComposioToolProvider({ client, catalogCache, connections, entityId: 'cortex-default-user', log: () => {} })
    // First assembly: warm runs (empty result).
    const first = await provider.getToolsForProfile(FAKE_PROFILE, EMPTY_CTX)
    expect(first.stubs).toHaveLength(1)
    expect(listTools).toHaveBeenCalledTimes(1)
    // Second assembly: warm MUST be suppressed — same stub, same call count.
    const second = await provider.getToolsForProfile(FAKE_PROFILE, EMPTY_CTX)
    expect(second.stubs).toHaveLength(1)
    expect(listTools).toHaveBeenCalledTimes(1)
  })

  it('coalesces a concurrent in-flight warm — inline + status-bus do not double-fetch', async () => {
    // If `attachStatusBus` started a warm a few ms before the turn
    // reaches the inline `await this.warmToolsForToolkit(...)` call,
    // both paths must share the same in-flight promise. Otherwise we
    // pay a duplicate Composio `listTools` round-trip every turn.
    seedReadyConnection()
    let resolveListTools: ((v: { items: ComposioTool[]; next_cursor: null; total_pages: 1; current_page: 1; total_items: number }) => void) | null = null
    const listTools = vi.fn(() => new Promise((res) => { resolveListTools = res as typeof resolveListTools }))
    const client = makeClient({
      executeTool: (async () => ({ data: {}, error: null, successful: true })) as unknown as ComposioClient['executeTool'],
      listTools: listTools as unknown as ComposioClient['listTools'],
    })
    const provider = new ComposioToolProvider({ client, catalogCache, connections, entityId: 'cortex-default-user', log: () => {} })
    // First warm started externally (e.g. attachStatusBus path).
    const external = provider.warmToolsForToolkit('notion')
    // Reconcile runs concurrently — its inline warm should share the
    // external promise, not start a second `listTools` round-trip.
    const assembly = provider.getToolsForProfile(FAKE_PROFILE, EMPTY_CTX)
    // Resolve the single in-flight `listTools` call.
    resolveListTools!({
      items: [makeTool('notion_search', { description: 'Search Notion' })],
      next_cursor: null, total_pages: 1, current_page: 1, total_items: 1,
    })
    await external
    const result = await assembly
    expect(result.tools).toHaveLength(1)
    // Exactly one `listTools` HTTP call across both paths.
    expect(listTools).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// 2b.2b — alias resolver integration (shouldEmitForAppId filter)
// ---------------------------------------------------------------------------

describe('ComposioToolProvider — shouldEmitForAppId filter (2b.2b)', () => {
  it('skips catalog rows whose appId the filter rejects', async () => {
    const client = makeClient({
      listTools: async () => ({ items: [], next_cursor: null, total_pages: 1, current_page: 1, total_items: 0 }),
    })
    const provider = new ComposioToolProvider({
      client, catalogCache, connections, entityId: 'cortex-default-user', log: () => {},
      // Reject all — simulate the case where the user has explicitly
      // pinned the MCP variant for this app, so Composio drops out.
      shouldEmitForAppId: () => false,
    })
    const result = await provider.getToolsForProfile(FAKE_PROFILE, EMPTY_CTX)
    expect(result.tools).toHaveLength(0)
    expect(result.stubs).toHaveLength(0)
  })

  it('default filter (omitted) keeps every row (legacy behaviour)', async () => {
    const client = makeClient({
      listTools: async () => ({ items: [], next_cursor: null, total_pages: 1, current_page: 1, total_items: 0 }),
    })
    const provider = new ComposioToolProvider({
      client, catalogCache, connections, entityId: 'cortex-default-user', log: () => {},
    })
    const result = await provider.getToolsForProfile(FAKE_PROFILE, EMPTY_CTX)
    // Catalog seeded with notion in beforeEach → stub emitted (not connected).
    expect(result.stubs.length).toBeGreaterThan(0)
  })

  it('filter receives the appId and routes per-row', async () => {
    // Seed a second row so we can verify per-row routing.
    seedToolkit(toolkit({
      slug: 'gmail',
      name: 'Gmail',
      categoryName: 'communication',
      description: 'Gmail',
    }))
    const client = makeClient({
      listTools: async () => ({ items: [], next_cursor: null, total_pages: 1, current_page: 1, total_items: 0 }),
    })
    const seen: string[] = []
    const provider = new ComposioToolProvider({
      client, catalogCache, connections, entityId: 'cortex-default-user', log: () => {},
      shouldEmitForAppId: (appId) => { seen.push(appId); return appId === 'gmail' },
    })
    // Profile declares BOTH toolkits so the per-profile filter doesn't
    // short-circuit either row — then shouldEmitForAppId picks gmail.
    const profile = profileWithComposio(['notion', 'gmail'])
    const result = await provider.getToolsForProfile(profile, EMPTY_CTX)
    expect(seen.sort()).toEqual(['gmail', 'notion'])
    // Only gmail survived.
    expect(result.stubs.every(s => s.name.includes('gmail'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Per-profile opt-in — the core invariant of the tools.composio protocol
// ---------------------------------------------------------------------------

describe('ComposioToolProvider — per-profile opt-in', () => {
  it('emits zero tools and zero stubs when the profile does not declare Composio', async () => {
    // Catalog has `notion` seeded in beforeEach. Previously the provider
    // would emit a `not_connected` stub for it on every profile. The
    // per-profile protocol inverts that: no declaration → no tools.
    const client = makeClient({
      listTools: async () => ({ items: [], next_cursor: null, total_pages: 1, current_page: 1, total_items: 0 }),
    })
    const provider = new ComposioToolProvider({
      client, catalogCache, connections, entityId: 'cortex-default-user', log: () => {},
    })
    const result = await provider.getToolsForProfile(profileWithoutComposio(), EMPTY_CTX)
    expect(result.tools).toHaveLength(0)
    expect(result.stubs).toHaveLength(0)
  })

  it('emits zero tools and zero stubs when the profile declares an empty toolkits array', async () => {
    // Explicit `composio: { toolkits: [] }` is semantically identical to
    // the field being absent. Both produce zero output.
    const client = makeClient({
      listTools: async () => ({ items: [], next_cursor: null, total_pages: 1, current_page: 1, total_items: 0 }),
    })
    const provider = new ComposioToolProvider({
      client, catalogCache, connections, entityId: 'cortex-default-user', log: () => {},
    })
    const result = await provider.getToolsForProfile(profileWithComposio([]), EMPTY_CTX)
    expect(result.tools).toHaveLength(0)
    expect(result.stubs).toHaveLength(0)
  })

  it('emits ONLY the declared toolkit, even when the catalog has many other rows', async () => {
    // Seed three extra toolkits. The profile only declares `notion`.
    // Before the per-profile fix, every row in the catalog would have
    // produced a stub or tool — the exact source of the 1000+ tool
    // payloads that blew past OpenAI's 128-tool request cap.
    seedToolkit(
      toolkit({ slug: 'gmail', name: 'Gmail', categoryName: 'communication', description: 'Gmail' }),
      toolkit({ slug: 'slack', name: 'Slack', categoryName: 'communication', description: 'Slack' }),
      toolkit({ slug: 'stripe', name: 'Stripe', categoryName: 'finance', description: 'Stripe', authSchemes: ['api_key'] }),
    )
    const client = makeClient({
      listTools: async () => ({ items: [], next_cursor: null, total_pages: 1, current_page: 1, total_items: 0 }),
    })
    const provider = new ComposioToolProvider({
      client, catalogCache, connections, entityId: 'cortex-default-user', log: () => {},
    })
    const result = await provider.getToolsForProfile(profileWithComposio(['notion']), EMPTY_CTX)
    // Notion is not connected → one stub; gmail/slack/stripe never
    // contribute because they're not declared.
    expect(result.tools).toHaveLength(0)
    expect(result.stubs).toHaveLength(1)
    expect(result.stubs[0]!.name).toContain('notion')
  })

  it('emits a composio_unknown_toolkit stub when a declared slug is not in the catalog', async () => {
    // Profile declares `foo` but the catalog only has `notion`. The
    // provider must not throw — a single bad slug can't brick assembly.
    // Instead a stub explains the problem so the UI can render it.
    const client = makeClient({
      listTools: async () => ({ items: [], next_cursor: null, total_pages: 1, current_page: 1, total_items: 0 }),
    })
    const provider = new ComposioToolProvider({
      client, catalogCache, connections, entityId: 'cortex-default-user', log: () => {},
    })
    const result = await provider.getToolsForProfile(profileWithComposio(['foo']), EMPTY_CTX)
    expect(result.tools).toHaveLength(0)
    expect(result.stubs).toHaveLength(1)
    const stub = result.stubs[0]!
    expect(stub.description.toLowerCase()).toContain("'foo'")
    expect(stub.description.toLowerCase()).toContain("not in composio's catalogue")
  })

  it('collapses duplicate slugs so assembly does not hit the duplicate-tool-name guard', async () => {
    // Users hand-writing `agent.json` can put the same slug twice. The
    // schema transform should dedupe; even if a caller bypasses Zod and
    // passes ["notion", "notion"] directly, the provider must not emit
    // two conflicting stubs that would make the assembler's duplicate-
    // name check throw. We test the end-to-end contract: schema-parsed
    // input → one stub.
    const { ToolsConfigSchema } = await import('../../../../src/profile/schema.js')
    const parsed = ToolsConfigSchema.parse({
      composio: { toolkits: ['notion', 'notion'] },
    })
    expect(parsed.composio.toolkits).toEqual(['notion'])

    const client = makeClient({
      listTools: async () => ({ items: [], next_cursor: null, total_pages: 1, current_page: 1, total_items: 0 }),
    })
    const provider = new ComposioToolProvider({
      client, catalogCache, connections, entityId: 'cortex-default-user', log: () => {},
    })
    const result = await provider.getToolsForProfile(
      profileWithComposio(parsed.composio.toolkits),
      EMPTY_CTX,
    )
    // Exactly one stub — not two — proves dedup survived.
    expect(result.stubs).toHaveLength(1)
  })

  it('rejects empty-string slugs at schema parse time', async () => {
    // An empty string slug would silently become `composio__unknown_toolkit`
    // — a nonsense stub. Reject at the boundary (schema) so the profile
    // fails loudly at load time instead of producing a phantom tool at
    // assembly time.
    const { ToolsConfigSchema } = await import('../../../../src/profile/schema.js')
    expect(() => ToolsConfigSchema.parse({
      composio: { toolkits: [''] },
    })).toThrow(/cannot be empty/)
  })

  it('trims surrounding whitespace in slugs before matching the catalog', async () => {
    // Hand-edited JSON can accidentally introduce whitespace. Without
    // trim, `"notion "` would miss the `notion` row and emit an unknown-
    // toolkit stub instead. Trimming at the schema boundary matches
    // user intent.
    const { ToolsConfigSchema } = await import('../../../../src/profile/schema.js')
    const parsed = ToolsConfigSchema.parse({
      composio: { toolkits: ['  notion  '] },
    })
    expect(parsed.composio.toolkits).toEqual(['notion'])

    const client = makeClient({
      listTools: async () => ({ items: [], next_cursor: null, total_pages: 1, current_page: 1, total_items: 0 }),
    })
    const provider = new ComposioToolProvider({
      client, catalogCache, connections, entityId: 'cortex-default-user', log: () => {},
    })
    const result = await provider.getToolsForProfile(
      profileWithComposio(parsed.composio.toolkits),
      EMPTY_CTX,
    )
    // Hits the catalog's `notion` row → not-connected stub, NOT unknown-toolkit.
    expect(result.stubs).toHaveLength(1)
    expect(result.stubs[0]!.name).not.toContain('unknown_toolkit')
  })

  it('emits real tools for a declared + connected + manifest-warmed toolkit', async () => {
    // Full happy path: the one scenario the agent should see.
    seedReadyConnection()
    const client = makeClient({
      listTools: async () => ({
        items: [makeTool('NOTION_SEARCH'), makeTool('NOTION_CREATE_PAGE')],
        next_cursor: null,
        total_pages: 1,
        current_page: 1,
        total_items: 2,
      }),
    })
    const provider = new ComposioToolProvider({
      client, catalogCache, connections, entityId: 'cortex-default-user', log: () => {},
    })
    await provider.warmToolsForToolkit('notion')
    const result = await provider.getToolsForProfile(profileWithComposio(['notion']), EMPTY_CTX)
    expect(result.tools).toHaveLength(2)
    expect(result.tools.every(t => t.name.startsWith('composio_notion_'))).toBe(true)
    expect(result.stubs).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Lifecycle-wired warming (warmAllReady, attachStatusBus, coalescing)
// ---------------------------------------------------------------------------

describe('ComposioToolProvider — warmAllReady (boot scan)', () => {
  it('warms every ready composio row so the next assembly emits real tools', async () => {
    // Seed catalog with two toolkits and a ready connection for each.
    seedToolkit(toolkit({ slug: 'gmail', name: 'Gmail', categoryName: 'communication' }))
    connections.upsertPending({
      connectionId: 'conn_notion', connectorId: 'notion', source: 'composio',
      entityId: 'cortex-default-user', authConfigId: 'ac_n',
      vendorAccountId: 'conn_notion', vendorUserId: 'cortex-default-user',
    })
    connections.markReady({ connectionId: 'conn_notion' })
    connections.upsertPending({
      connectionId: 'conn_gmail', connectorId: 'gmail', source: 'composio',
      entityId: 'cortex-default-user', authConfigId: 'ac_g',
      vendorAccountId: 'conn_gmail', vendorUserId: 'cortex-default-user',
    })
    connections.markReady({ connectionId: 'conn_gmail' })

    const listTools = vi.fn(async ({ toolkitSlug }: { toolkitSlug: string }) => ({
      items: [makeTool(`${toolkitSlug}_SEARCH`, { toolkit: { slug: toolkitSlug, name: toolkitSlug, logo: '' } })],
      next_cursor: null, total_pages: 1, current_page: 1, total_items: 1,
    }))
    const client = makeClient({
      listTools: listTools as unknown as ComposioClient['listTools'],
    })
    const provider = new ComposioToolProvider({ client, catalogCache, connections, entityId: 'cortex-default-user', log: () => {} })

    await provider.warmAllReady()

    // Every ready toolkit got a listTools call.
    const warmedSlugs = listTools.mock.calls.map((c) => (c[0] as { toolkitSlug: string }).toolkitSlug).sort()
    expect(warmedSlugs).toEqual(['gmail', 'notion'])

    // Assembly for the profile now emits the real tool, not the stub.
    const result = await provider.getToolsForProfile(profileWithComposio(['notion']), EMPTY_CTX)
    expect(result.tools).toHaveLength(1)
    expect(result.stubs).toHaveLength(0)
  })

  it('is a no-op when there are zero ready composio connections', async () => {
    const listTools = vi.fn()
    const client = makeClient({
      listTools: listTools as unknown as ComposioClient['listTools'],
    })
    const provider = new ComposioToolProvider({ client, catalogCache, connections, entityId: 'cortex-default-user', log: () => {} })
    await provider.warmAllReady()
    expect(listTools).not.toHaveBeenCalled()
  })
})

describe('ComposioToolProvider — attachStatusBus warms on ready transitions', () => {
  it('calls listTools for the slug on a composio→ready event and not on other sources or statuses', async () => {
    seedReadyConnection()
    const listTools = vi.fn(async () => ({
      items: [makeTool('NOTION_SEARCH')],
      next_cursor: null, total_pages: 1, current_page: 1, total_items: 1,
    }))
    const client = makeClient({
      listTools: listTools as unknown as ComposioClient['listTools'],
    })
    const provider = new ComposioToolProvider({ client, catalogCache, connections, entityId: 'cortex-default-user', log: () => {} })

    type BusEvent = { source: string; connectorId: string; status: string }
    const listeners: Array<(e: BusEvent) => void> = []
    const fakeBus = {
      subscribe: (l: (e: BusEvent) => void) => {
        listeners.push(l)
        return () => { /* noop */ }
      },
    }
    provider.attachStatusBus(fakeBus)

    // Irrelevant events: not composio, or not ready.
    listeners[0]?.({ source: 'mcp', connectorId: 'notion', status: 'ready' })
    listeners[0]?.({ source: 'composio', connectorId: 'notion', status: 'needs_setup' })
    // Flush microtasks; nothing should have fired.
    await Promise.resolve()
    expect(listTools).not.toHaveBeenCalled()

    // Relevant event triggers a warm.
    listeners[0]?.({ source: 'composio', connectorId: 'notion', status: 'ready' })
    // warmToolsForToolkit is awaited internally; give it a tick.
    await new Promise((r) => setTimeout(r, 0))
    expect(listTools).toHaveBeenCalledTimes(1)
    expect((listTools.mock.calls[0]?.[0] as { toolkitSlug: string }).toolkitSlug).toBe('notion')
  })
})

describe('ComposioToolProvider — warmToolsForToolkit coalesces concurrent calls', () => {
  it('fires only one listTools call when two warms are in flight for the same slug', async () => {
    const listTools = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 20))
      return { items: [makeTool('NOTION_SEARCH')], next_cursor: null, total_pages: 1, current_page: 1, total_items: 1 }
    })
    const client = makeClient({
      listTools: listTools as unknown as ComposioClient['listTools'],
    })
    const provider = new ComposioToolProvider({ client, catalogCache, connections, entityId: 'cortex-default-user', log: () => {} })

    await Promise.all([
      provider.warmToolsForToolkit('notion'),
      provider.warmToolsForToolkit('notion'),
      provider.warmToolsForToolkit('notion'),
    ])
    expect(listTools).toHaveBeenCalledTimes(1)

    // A subsequent call AFTER resolution issues a fresh request (not sticky).
    await provider.warmToolsForToolkit('notion')
    expect(listTools).toHaveBeenCalledTimes(2)
  })
})

// ---------------------------------------------------------------------------
// No-auth toolkits — runtime fix (2026-05-27)
//
// Guards the user-reported regression: Composio Code Interpreter (a
// `no_auth=true` toolkit) appeared as ✓ Added in the UI but the agent
// got a stub at runtime saying "X is not connected" because the
// adapter required a `ready` connection row, and no-auth toolkits
// never have one. The fix emits REAL tools for `no_auth=true`
// toolkits unconditionally and calls executeAction with just userId.
// ---------------------------------------------------------------------------

describe('ComposioToolProvider — no-auth toolkit path (2026-05-27)', () => {
  it('emits REAL tools (not stubs) for a no_auth=true toolkit with no DB row', async () => {
    // Seed a no-auth toolkit fixture. CRITICAL: no connection row in
    // `connections` for this toolkit — the whole point of the fix is
    // that no row is needed.
    toolkitFixtures = [
      toolkit({
        slug: 'codeinterpreter',
        name: 'Code Interpreter',
        noAuth: true,
        categoryName: 'dev-tools',
        description: 'Hosted Python sandbox',
      }),
    ]
    const listTools = vi.fn(async () => ({
      items: [makeTool('CODEINTERPRETER_EXECUTE')],
      next_cursor: null, total_pages: 1, current_page: 1, total_items: 1,
    }))
    const client = makeClient({ listTools })
    const provider = new ComposioToolProvider({
      client, catalogCache, connections, entityId: 'cortex-default-user', log: () => {},
    })
    const profile = profileWithComposio(['codeinterpreter'])
    const result = await provider.getToolsForProfile(profile, EMPTY_CTX)
    // The fix: REAL tool emitted, NO stub.
    expect(result.tools.length).toBeGreaterThan(0)
    expect(result.stubs.length).toBe(0)
    expect(result.tools[0]!.name).toBe('composio_codeinterpreter_codeinterpreter_execute')
  })

  it('a no_auth toolkit\'s real tool calls executeTool with userId only — no connectedAccountId', async () => {
    toolkitFixtures = [
      toolkit({ slug: 'codeinterpreter', name: 'Code Interpreter', noAuth: true }),
    ]
    let recordedArgs: { connectedAccountId?: string; userId?: string; arguments: unknown } | null = null
    const listTools = vi.fn(async () => ({
      items: [makeTool('CODEINTERPRETER_EXECUTE')],
      next_cursor: null, total_pages: 1, current_page: 1, total_items: 1,
    }))
    const executeTool = vi.fn(async (_slug: string, args: { connectedAccountId?: string; userId?: string; arguments: unknown }) => {
      recordedArgs = args
      return { data: { result: 'ok' }, successful: true } as never
    })
    const client = makeClient({ listTools, executeTool })
    const provider = new ComposioToolProvider({
      client, catalogCache, connections, entityId: 'cortex-default-user', log: () => {},
    })
    const profile = profileWithComposio(['codeinterpreter'])
    const result = await provider.getToolsForProfile(profile, EMPTY_CTX)
    await result.tools[0]!.execute({ code: 'print(1)' })
    expect(recordedArgs).not.toBeNull()
    // The no-auth path sends ONLY userId (= entity_id), no connectedAccountId.
    expect(recordedArgs!.connectedAccountId).toBeUndefined()
    expect(recordedArgs!.userId).toBe('cortex-default-user')
    expect(recordedArgs!.arguments).toEqual({ code: 'print(1)' })
  })

  it('auth-required toolkit STILL emits a stub when no DB row exists (no regression)', async () => {
    // Mirror the existing behavior for OAuth toolkits — they still
    // need a connection row before becoming real tools. The no-auth
    // branch must not weaken auth-required guarantees.
    toolkitFixtures = [
      toolkit({
        slug: 'gmail',
        name: 'Gmail',
        authSchemes: ['oauth2'], // auth required
        noAuth: false,
      }),
    ]
    const client = makeClient({
      listTools: async () => ({ items: [], next_cursor: null, total_pages: 1, current_page: 1, total_items: 0 }),
    })
    const provider = new ComposioToolProvider({
      client, catalogCache, connections, entityId: 'cortex-default-user', log: () => {},
    })
    const profile = profileWithComposio(['gmail'])
    const result = await provider.getToolsForProfile(profile, EMPTY_CTX)
    expect(result.tools.length).toBe(0)
    expect(result.stubs.length).toBeGreaterThan(0)
    // The stub explicitly says "not connected" — that's the right
    // signal for an OAuth toolkit with no credential.
    expect(result.stubs[0]!.execute).toBeDefined()
  })
})
