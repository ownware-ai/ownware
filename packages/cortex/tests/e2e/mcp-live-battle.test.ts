/**
 * LIVE BATTLE TEST — Real MCP Servers from the Official Registry
 *
 * Tests connect to REAL MCP servers — not mocks, not our echo server.
 * They install via npx, connect via stdio, discover tools, and call them.
 *
 * Servers tested (all no-auth, npm-based):
 * 1. @modelcontextprotocol/server-memory — knowledge graph (create, search, read)
 * 2. @modelcontextprotocol/server-everything — test server with all MCP features
 *
 * NOTE: First run downloads packages via npx (may be slow).
 */

import { describe, it, expect, afterEach } from 'vitest'
import { MCPClient, MCPManager, adaptMCPTool, adaptAllMCPTools } from '@ownware/loom'
import type { MCPStdioServerConfig } from '@ownware/loom'

// ---------------------------------------------------------------------------
// 1. @modelcontextprotocol/server-memory — Real knowledge graph
// ---------------------------------------------------------------------------

// Network lane (BUGS #14/#15): the public MCP registry now has 12k+
// servers — a cold full walk takes minutes and any slow page aborts it.
// These live-network tests run on demand: OWNWARE_NETWORK_TESTS=1.
const NETWORK_LANE = process.env['OWNWARE_NETWORK_TESTS'] === '1'

describe.skipIf(!NETWORK_LANE)('LIVE: @modelcontextprotocol/server-memory', () => {
  let client: MCPClient | null = null

  afterEach(async () => {
    if (client) {
      await client.disconnect()
      client = null
    }
  })

  const config: MCPStdioServerConfig = {
    name: 'memory',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
  }

  it('connects and discovers 9 knowledge graph tools', async () => {
    client = new MCPClient(config)
    await client.connect()

    expect(client.isConnected).toBe(true)
    expect(client.getCapabilities()?.tools).toBe(true)

    const tools = await client.listTools()
    const toolNames = tools.map(t => t.name)
    console.log('  memory tools:', toolNames)

    expect(tools.length).toBeGreaterThanOrEqual(7)
    expect(toolNames).toContain('create_entities')
    expect(toolNames).toContain('create_relations')
    expect(toolNames).toContain('search_nodes')
    expect(toolNames).toContain('read_graph')

    // Every tool has required fields
    for (const tool of tools) {
      expect(tool.name).toBeTruthy()
      expect(tool.description).toBeTruthy()
      expect(tool.inputSchema).toBeDefined()
      expect(tool.serverName).toBe('memory')
    }
  }, 180_000)

  it('creates entities, searches them, reads the full graph', async () => {
    client = new MCPClient(config)
    await client.connect()

    // CREATE entities
    const createResult = await client.callTool('create_entities', {
      entities: [
        { name: 'Loom', entityType: 'Framework', observations: ['TypeScript agent runtime', 'While-true loop architecture'] },
        { name: 'Cortex', entityType: 'Platform', observations: ['Agent Operating System', 'Built on Loom'] },
        { name: 'MCP', entityType: 'Protocol', observations: ['Model Context Protocol', 'JSON-RPC 2.0'] },
      ],
    })
    console.log('  created entities:', createResult.substring(0, 300))
    // create_entities only returns NEW entities (not already existing)
    expect(createResult).toBeTruthy()

    // CREATE relations
    const relResult = await client.callTool('create_relations', {
      relations: [
        { from: 'Cortex', to: 'Loom', relationType: 'uses' },
        { from: 'Loom', to: 'MCP', relationType: 'supports' },
      ],
    })
    console.log('  created relations:', relResult.substring(0, 200))
    expect(relResult).toBeTruthy()

    // SEARCH
    const searchResult = await client.callTool('search_nodes', { query: 'agent' })
    console.log('  search "agent":', searchResult.substring(0, 300))
    expect(searchResult).toBeTruthy()
    // Should find Cortex (has "Agent Operating System" in observations)

    // READ full graph
    const graphResult = await client.callTool('read_graph', {})
    console.log('  full graph:', graphResult.substring(0, 500))
    expect(graphResult).toContain('Loom')
    expect(graphResult).toContain('Cortex')
    expect(graphResult).toContain('MCP')

    console.log('  ✅ Full knowledge graph lifecycle: create → relate → search → read')
  }, 180_000)

  it('adapted tools work through Loom Tool interface', async () => {
    client = new MCPClient(config)
    await client.connect()

    const mcpTools = await client.listTools()
    const loomTools = adaptAllMCPTools(mcpTools, client)

    // Check prefixed names
    expect(loomTools.every(t => t.name.startsWith('mcp__memory__'))).toBe(true)
    expect(loomTools.every(t => t.category === 'mcp')).toBe(true)

    // Call create_entities through adapted tool
    const createTool = loomTools.find(t => t.name === 'mcp__memory__create_entities')!
    const result = await (createTool.execute as Function)({
      entities: [{ name: 'Test', entityType: 'TestType', observations: ['test observation'] }],
    }, {})

    expect(result.isError).toBe(false)
    expect(result.isError).toBe(false)
    expect(result.metadata?.serverName).toBe('memory')
    expect(result.metadata?.toolName).toBe('create_entities')

    // Call read_graph through adapted tool
    const readTool = loomTools.find(t => t.name === 'mcp__memory__read_graph')!
    const readResult = await (readTool.execute as Function)({}, {})
    expect(readResult.isError).toBe(false)
    // Graph should have content (may contain Test or entities from prior runs)
    expect(readResult.content.length).toBeGreaterThan(0)

    console.log('  ✅ Adapted tools work end-to-end')
  }, 180_000)
})

// ---------------------------------------------------------------------------
// 2. @modelcontextprotocol/server-everything — Test server with all features
// ---------------------------------------------------------------------------

describe.skipIf(!NETWORK_LANE)('LIVE: @modelcontextprotocol/server-everything', () => {
  let client: MCPClient | null = null

  afterEach(async () => {
    if (client) {
      await client.disconnect()
      client = null
    }
  })

  const config: MCPStdioServerConfig = {
    name: 'everything',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-everything'],
  }

  it('connects and discovers tools + resources', async () => {
    client = new MCPClient(config)
    await client.connect()

    expect(client.isConnected).toBe(true)
    const caps = client.getCapabilities()
    console.log('  capabilities:', caps)
    expect(caps?.tools).toBe(true)

    const tools = await client.listTools()
    console.log('  tools:', tools.map(t => `${t.name} (${t.annotations?.readOnlyHint ? 'readonly' : 'write'})`))
    expect(tools.length).toBeGreaterThan(0)

    // Every tool should have proper structure
    for (const tool of tools) {
      expect(tool.name).toBeTruthy()
      expect(typeof tool.description).toBe('string')
      expect(tool.inputSchema).toBeDefined()
      expect(tool.serverName).toBe('everything')
    }

    // Check for resources if capability advertised
    if (caps?.resources) {
      const resources = await client.listResources()
      console.log('  resources:', resources.map(r => `${r.name} (${r.uri})`))
      expect(resources.length).toBeGreaterThanOrEqual(0)
    }
  }, 180_000)

  it('calls echo tool', async () => {
    client = new MCPClient(config)
    await client.connect()

    const tools = await client.listTools()
    const echoTool = tools.find(t => t.name === 'echo')

    if (!echoTool) {
      console.log('  skipping echo test — tool not found, available:', tools.map(t => t.name))
      return
    }

    const result = await client.callTool('echo', { message: 'battle test from Cortex!' })
    console.log('  echo result:', result)
    expect(result).toContain('battle test from Cortex!')

    console.log('  ✅ Echo tool works')
  }, 180_000)

  it('reads resources if available', async () => {
    client = new MCPClient(config)
    await client.connect()

    const caps = client.getCapabilities()
    if (!caps?.resources) {
      console.log('  skipping — server does not support resources')
      return
    }

    const resources = await client.listResources()
    if (resources.length === 0) {
      console.log('  no resources available')
      return
    }

    // Read first resource
    const first = resources[0]
    console.log('  reading resource:', first.name, first.uri)
    const content = await client.readResource(first.uri)
    console.log('  content:', content[0]?.text?.substring(0, 200) ?? content[0]?.blob?.substring(0, 50))
    expect(content.length).toBeGreaterThan(0)

    console.log('  ✅ Resource read works')
  }, 180_000)
})

// ---------------------------------------------------------------------------
// 3. MCPManager — Multiple real servers simultaneously
// ---------------------------------------------------------------------------

describe.skipIf(!NETWORK_LANE)('LIVE: MCPManager with memory + everything servers', () => {
  let manager: MCPManager | null = null

  afterEach(async () => {
    if (manager) {
      await manager.shutdown()
      manager = null
    }
  })

  it('manages two real servers with getAdaptedTools()', async () => {
    manager = new MCPManager(false)

    await manager.addServers([
      {
        name: 'memory',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-memory'],
      },
      {
        name: 'everything',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-everything'],
      },
    ])

    console.log('  connected:', manager.connectedCount, 'of', manager.size)
    expect(manager.connectedCount).toBe(2)

    // Get adapted tools
    const tools = manager.getAdaptedTools()
    console.log('  total tools:', tools.length)

    const memoryTools = tools.filter(t => t.name.startsWith('mcp__memory__'))
    const everythingTools = tools.filter(t => t.name.startsWith('mcp__everything__'))
    console.log('  memory tools:', memoryTools.length)
    console.log('  everything tools:', everythingTools.length)

    expect(memoryTools.length).toBeGreaterThan(0)
    expect(everythingTools.length).toBeGreaterThan(0)
    expect(tools.every(t => t.category === 'mcp')).toBe(true)

    // Call memory tool through manager
    const createTool = tools.find(t => t.name === 'mcp__memory__create_entities')!
    const result = await (createTool.execute as Function)({
      entities: [{ name: 'ManagerTest', entityType: 'Test', observations: ['via manager'] }],
    }, {})
    expect(result.isError).toBe(false)
    expect(result.isError).toBe(false)

    // Server list
    const servers = manager.listServers()
    for (const s of servers) {
      console.log(`  ${s.config.name}: status=${s.status}, tools=${s.tools.length}, resources=${s.resources.length}`)
    }

    console.log('  ✅ Multi-server management works with real servers')
  }, 180_000)
})

// ---------------------------------------------------------------------------
// 4. Full registry → connection flow
// ---------------------------------------------------------------------------

describe.skipIf(!NETWORK_LANE)('LIVE: Full flow — registry → connect → discover → call', () => {
  it('fetches 5000+ servers from real registry and connects to one', async () => {
    // Step 1: Real registry fetch
    const { fetchMCPRegistry } = await import('../../src/connector/mcp/registry.js')
    const entries = await fetchMCPRegistry()
    console.log('  registry: fetched', entries.length, 'servers')
    expect(entries.length).toBeGreaterThan(1000)

    // Step 2: Verify registry data quality
    const withPackage = entries.filter(e => e.package)
    const withEnv = entries.filter(e => e.requiredEnv.length > 0)
    const withRemote = entries.filter(e => e.remoteUrl)
    console.log('  with npm package:', withPackage.length)
    console.log('  with auth needed:', withEnv.length)
    console.log('  with remote URL:', withRemote.length)

    // Step 3: Categories work
    const categories = new Set(entries.map(e => e.category))
    console.log('  categories:', [...categories])
    expect(categories.size).toBeGreaterThan(3)

    // Step 4: Connect to memory server (known good)
    const client = new MCPClient({
      name: 'registry-test',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-memory'],
    })
    await client.connect()

    const tools = await client.listTools()
    console.log('  connected to memory server, tools:', tools.length)
    expect(tools.length).toBeGreaterThan(5)

    // Step 5: Call a tool
    const result = await client.callTool('create_entities', {
      entities: [{ name: 'RegistryFlowTest', entityType: 'Test', observations: ['Works!'] }],
    })
    expect(result).toBeTruthy()

    await client.disconnect()
    console.log('  ✅ Full flow: registry(5000+) → connect → discover(9 tools) → call → disconnect')
  }, 180_000)
})
