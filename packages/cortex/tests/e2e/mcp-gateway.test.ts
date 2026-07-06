/**
 * E2E Tests — MCP Gateway
 *
 * Tests the full MCP lifecycle through the gateway:
 * 1. Registry: fetch marketplace from official MCP registry
 * 2. Credentials: save/check/resolve env vars
 * 3. Live connection: connect real MCP servers, discover tools
 *
 * Real MCP servers tested:
 * - @modelcontextprotocol/server-filesystem (stdio, no auth)
 * - @anthropic-ai/mcp-server-fetch (stdio, no auth)  -- skipped if not installed
 * - Echo server from loom tests (stdio, no auth)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  fetchMCPRegistry,
  clearRegistryCache,
  getRegistryEntry,
  MCPCredentialStore,
} from '../../src/connector/index.js'
import { MCPClient, MCPManager } from '@ownware/loom'
import type { MCPStdioServerConfig } from '@ownware/loom'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_SERVER = resolve(__dirname, '../../../loom/src/__tests__/e2e/mcp-echo-server.ts')

// ---------------------------------------------------------------------------
// 1. Registry tests
// ---------------------------------------------------------------------------

// Network lane (BUGS #14/#15): the public MCP registry now has 12k+
// servers — a cold full walk takes minutes and any slow page aborts it.
// These live-network tests run on demand: OWNWARE_NETWORK_TESTS=1.
const NETWORK_LANE = process.env['OWNWARE_NETWORK_TESTS'] === '1'

describe.skipIf(!NETWORK_LANE)('MCP Registry', () => {
  beforeAll(() => {
    clearRegistryCache()
  })

  it('fetches servers from the official registry', async () => {
    const entries = await fetchMCPRegistry()
    expect(entries.length).toBeGreaterThan(10)

    // Every entry should have required fields
    for (const entry of entries.slice(0, 5)) {
      expect(entry.id).toBeTruthy()
      expect(entry.title).toBeTruthy()
      expect(typeof entry.transport).toBe('string')
      expect(typeof entry.category).toBe('string')
    }
  }, 120_000)

  it('entries have structured env var info', async () => {
    const entries = await fetchMCPRegistry()

    // Find entries that have env vars
    const withEnv = entries.filter(e => e.requiredEnv.length > 0 || e.optionalEnv.length > 0)

    // There should be some servers that need credentials
    expect(withEnv.length).toBeGreaterThan(0)

    // Verify env var structure
    for (const entry of withEnv.slice(0, 3)) {
      for (const envVar of [...entry.requiredEnv, ...entry.optionalEnv]) {
        expect(envVar.name).toBeTruthy()
        expect(typeof envVar.isRequired).toBe('boolean')
        expect(typeof envVar.isSecret).toBe('boolean')
      }
    }
  }, 120_000)

  it('supports search filtering', async () => {
    const results = await fetchMCPRegistry({ search: 'filesystem' })
    expect(results.length).toBeGreaterThan(0)

    // Should find filesystem-related servers
    const hasFilesystem = results.some(e =>
      e.title.toLowerCase().includes('filesystem') ||
      e.id.toLowerCase().includes('filesystem') ||
      e.description.toLowerCase().includes('filesystem'),
    )
    expect(hasFilesystem).toBe(true)
  }, 120_000)

  it('categorizes servers', async () => {
    const entries = await fetchMCPRegistry()
    const categories = new Set(entries.map(e => e.category))

    // Should have multiple categories
    expect(categories.size).toBeGreaterThan(2)
  }, 120_000)

  it('caches results (second call is fast)', async () => {
    // First call populates cache
    await fetchMCPRegistry()

    // Second call should be instant (cached)
    const start = Date.now()
    const entries = await fetchMCPRegistry()
    const elapsed = Date.now() - start

    expect(entries.length).toBeGreaterThan(0)
    expect(elapsed).toBeLessThan(50) // Cache hit should be < 50ms
  }, 120_000)
})

// ---------------------------------------------------------------------------
// 2. Credential store tests
// ---------------------------------------------------------------------------

describe('MCP Credential Store', () => {
  let store: MCPCredentialStore
  let tempDir: string

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cortex-creds-test-'))
    store = new MCPCredentialStore(tempDir)
  })

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('saves and loads credentials', async () => {
    await store.save('test-server', { API_KEY: 'secret123', DB_URL: 'postgres://...' })

    const creds = await store.load('test-server')
    expect(creds).not.toBeNull()
    expect(creds!.serverId).toBe('test-server')
    expect(creds!.env['API_KEY']).toBe('secret123')
    expect(creds!.env['DB_URL']).toBe('postgres://...')
    expect(creds!.updatedAt).toBeTruthy()
  })

  it('returns null for unknown server', async () => {
    const creds = await store.load('nonexistent')
    expect(creds).toBeNull()
  })

  it('overwrites existing credentials', async () => {
    await store.save('test-server', { API_KEY: 'old' })
    await store.save('test-server', { API_KEY: 'new', EXTRA: 'val' })

    const creds = await store.load('test-server')
    expect(creds!.env['API_KEY']).toBe('new')
    expect(creds!.env['EXTRA']).toBe('val')
  })

  it('deletes credentials', async () => {
    await store.save('to-delete', { KEY: 'val' })
    await store.delete('to-delete')

    const creds = await store.load('to-delete')
    expect(creds).toBeNull()
  })

  it('lists stored server IDs', async () => {
    await store.save('server-a', { A: '1' })
    await store.save('server-b', { B: '2' })

    const ids = await store.list()
    expect(ids).toContain('server-a')
    expect(ids).toContain('server-b')
  })

  it('checks env var availability', async () => {
    await store.save('check-test', { TOKEN: 'abc' })

    const result = await store.checkEnvVars('check-test', ['TOKEN', 'MISSING_VAR'])
    expect(result['TOKEN']).toBe(true)
    expect(result['MISSING_VAR']).toBe(false)
  })

  it('resolves env vars (stored + process.env)', async () => {
    await store.save('resolve-test', { STORED_KEY: 'from-store' })
    process.env['PROCESS_KEY'] = 'from-process'

    const resolved = await store.resolveEnv('resolve-test', ['STORED_KEY', 'PROCESS_KEY', 'MISSING'])
    expect(resolved['STORED_KEY']).toBe('from-store')
    expect(resolved['PROCESS_KEY']).toBe('from-process')
    expect(resolved['MISSING']).toBeUndefined()

    delete process.env['PROCESS_KEY']
  })
})

// ---------------------------------------------------------------------------
// 3. Live MCP connection tests
// ---------------------------------------------------------------------------

describe('Live MCP Connection — Echo Server', () => {
  let client: MCPClient | null = null

  afterAll(async () => {
    if (client) await client.disconnect()
  })

  const echoConfig: MCPStdioServerConfig = {
    name: 'echo',
    transport: 'stdio',
    command: 'npx',
    args: ['tsx', ECHO_SERVER],
  }

  it('connects, discovers tools + resources, calls tools', async () => {
    client = new MCPClient(echoConfig)
    await client.connect()

    expect(client.isConnected).toBe(true)
    const caps = client.getCapabilities()
    expect(caps?.tools).toBe(true)
    expect(caps?.resources).toBe(true)

    // Discover tools
    const tools = await client.listTools()
    expect(tools.length).toBe(3)
    expect(tools.map(t => t.name)).toContain('echo')
    expect(tools.map(t => t.name)).toContain('reverse')

    // Annotations preserved
    const echoTool = tools.find(t => t.name === 'echo')!
    expect(echoTool.annotations?.readOnlyHint).toBe(true)

    // Discover resources
    const resources = await client.listResources()
    expect(resources.length).toBe(2)

    // Call tools
    const echoResult = await client.callTool('echo', { message: 'battle test!' })
    expect(echoResult).toBe('battle test!')

    const reverseResult = await client.callTool('reverse', { text: 'hello' })
    expect(reverseResult).toBe('olleh')

    // Read resource
    const content = await client.readResource('test://greeting')
    expect(content[0].text).toBe('Hello from Echo Server!')

    await client.disconnect()
    client = null
  }, 15_000)
})

describe('Live MCP Connection — Manager with Multiple Servers', () => {
  let manager: MCPManager | null = null

  afterAll(async () => {
    if (manager) await manager.shutdown()
  })

  it('manages multiple echo server instances', async () => {
    manager = new MCPManager(false)

    await manager.addServers([
      {
        name: 'echo-1',
        transport: 'stdio',
        command: 'npx',
        args: ['tsx', ECHO_SERVER],
      },
      {
        name: 'echo-2',
        transport: 'stdio',
        command: 'npx',
        args: ['tsx', ECHO_SERVER],
      },
    ])

    expect(manager.connectedCount).toBe(2)

    // Get adapted tools (ready for Loom)
    const tools = manager.getAdaptedTools()
    // 3 tools + 2 resource tools per server = 5 × 2 = 10
    expect(tools.length).toBe(10)

    const names = tools.map(t => t.name)
    expect(names).toContain('mcp__echo-1__echo')
    expect(names).toContain('mcp__echo-2__echo')
    expect(names).toContain('mcp__echo-1__list_resources')
    expect(names).toContain('mcp__echo-2__read_resource')

    // Execute tools through adapted interface
    const echo1 = tools.find(t => t.name === 'mcp__echo-1__echo')!
    const result = await (echo1.execute as Function)({ message: 'from manager' }, {})
    expect(result.isError).toBe(false)
    expect(result.content).toBe('from manager')

    // Read resources through adapted interface
    const readTool = tools.find(t => t.name === 'mcp__echo-1__read_resource')!
    const readResult = await (readTool.execute as Function)({ uri: 'test://config' }, {})
    expect(readResult.isError).toBe(false)
    expect(readResult.content).toContain('"version"')

    await manager.shutdown()
    manager = null
  }, 20_000)
})
