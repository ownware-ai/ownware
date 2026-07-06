/**
 * E2E Tests — MCP with Real Servers
 *
 * Tests the full MCP lifecycle using a real stdio MCP server:
 * connect → discover tools → call tools → read resources → disconnect
 *
 * Uses the echo server in mcp-echo-server.ts as the MCP server.
 * No API keys needed — this tests the MCP layer only.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MCPClient } from '../../mcp/client.js'
import { MCPManager } from '../../mcp/manager.js'
import { adaptMCPTool, adaptAllMCPTools, createListResourcesTool, createReadResourceTool } from '../../mcp/adapter.js'
import type { MCPStdioServerConfig, MCPTool } from '../../mcp/types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_SERVER_PATH = resolve(__dirname, 'mcp-echo-server.ts')

// ---------------------------------------------------------------------------
// Shared config
// ---------------------------------------------------------------------------

const echoServerConfig: MCPStdioServerConfig = {
  name: 'echo',
  transport: 'stdio',
  command: 'npx',
  args: ['tsx', ECHO_SERVER_PATH],
}

// ---------------------------------------------------------------------------
// MCPClient E2E
// ---------------------------------------------------------------------------

describe('MCPClient E2E — stdio transport', () => {
  let client: MCPClient | null = null

  afterEach(async () => {
    if (client) {
      await client.disconnect()
      client = null
    }
  })

  it('connects to a real MCP server and discovers capabilities', async () => {
    client = new MCPClient(echoServerConfig)
    await client.connect()

    expect(client.isConnected).toBe(true)
    expect(client.serverName).toBe('echo')

    const caps = client.getCapabilities()
    expect(caps?.tools).toBe(true)
    expect(caps?.resources).toBe(true)
  }, 15_000)

  it('discovers tools with annotations', async () => {
    client = new MCPClient(echoServerConfig)
    await client.connect()

    const tools = await client.listTools()
    expect(tools.length).toBe(3)

    const echo = tools.find(t => t.name === 'echo')!
    expect(echo.description).toBe('Echo back the input message')
    expect(echo.serverName).toBe('echo')
    expect(echo.annotations?.readOnlyHint).toBe(true)

    const reverse = tools.find(t => t.name === 'reverse')!
    expect(reverse.annotations?.readOnlyHint).toBe(true)

    const uppercase = tools.find(t => t.name === 'uppercase')!
    expect(uppercase.annotations?.destructiveHint).toBe(true)
  }, 15_000)

  it('calls tools and gets correct results', async () => {
    client = new MCPClient(echoServerConfig)
    await client.connect()

    // Echo
    const echoResult = await client.callTool('echo', { message: 'hello world' })
    expect(echoResult).toBe('hello world')

    // Reverse
    const reverseResult = await client.callTool('reverse', { text: 'abcdef' })
    expect(reverseResult).toBe('fedcba')

    // Uppercase
    const upperResult = await client.callTool('uppercase', { text: 'hello' })
    expect(upperResult).toBe('HELLO')
  }, 15_000)

  it('discovers and reads resources', async () => {
    client = new MCPClient(echoServerConfig)
    await client.connect()

    // List resources
    const resources = await client.listResources()
    expect(resources.length).toBe(2)
    expect(resources[0].uri).toBe('test://greeting')
    expect(resources[0].name).toBe('Greeting')
    expect(resources[0].serverName).toBe('echo')

    // Read resource
    const contents = await client.readResource('test://greeting')
    expect(contents.length).toBe(1)
    expect(contents[0].text).toBe('Hello from Echo Server!')
    expect(contents[0].mimeType).toBe('text/plain')
  }, 15_000)

  it('reads JSON resource', async () => {
    client = new MCPClient(echoServerConfig)
    await client.connect()

    const contents = await client.readResource('test://config')
    expect(contents[0].text).toBe('{"version":"1.0","mode":"test"}')
    expect(contents[0].mimeType).toBe('application/json')
  }, 15_000)

  it('handles multiple tool calls in sequence', async () => {
    client = new MCPClient(echoServerConfig)
    await client.connect()

    for (let i = 0; i < 5; i++) {
      const result = await client.callTool('echo', { message: `msg-${i}` })
      expect(result).toBe(`msg-${i}`)
    }
  }, 15_000)

  it('disconnects cleanly', async () => {
    client = new MCPClient(echoServerConfig)
    await client.connect()
    expect(client.isConnected).toBe(true)

    await client.disconnect()
    expect(client.isConnected).toBe(false)
    client = null // Don't disconnect again in afterEach
  }, 15_000)
})

// ---------------------------------------------------------------------------
// MCPManager E2E
// ---------------------------------------------------------------------------

describe('MCPManager E2E — full lifecycle', () => {
  let manager: MCPManager | null = null

  afterEach(async () => {
    if (manager) {
      await manager.shutdown()
      manager = null
    }
  })

  it('manages server lifecycle: add → discover → call → remove', async () => {
    manager = new MCPManager(false)
    await manager.addServer(echoServerConfig)

    expect(manager.size).toBe(1)
    expect(manager.connectedCount).toBe(1)

    // Check server state
    const server = manager.getServer('echo')!
    expect(server.status).toBe('connected')
    expect(server.tools.length).toBe(3)
    expect(server.resources.length).toBe(2)
    expect(server.capabilities?.tools).toBe(true)
    expect(server.capabilities?.resources).toBe(true)

    // Use client directly
    const client = manager.getClient('echo')!
    const result = await client.callTool('echo', { message: 'via manager' })
    expect(result).toBe('via manager')

    // Remove
    await manager.removeServer('echo')
    expect(manager.size).toBe(0)
    manager = null
  }, 15_000)

  it('getAdaptedTools() returns Loom-compatible tools', async () => {
    manager = new MCPManager(false)
    await manager.addServer(echoServerConfig)

    const tools = manager.getAdaptedTools()

    // 3 MCP tools + 2 resource tools = 5
    expect(tools.length).toBe(5)

    const names = tools.map(t => t.name)
    expect(names).toContain('mcp__echo__echo')
    expect(names).toContain('mcp__echo__reverse')
    expect(names).toContain('mcp__echo__uppercase')
    expect(names).toContain('mcp__echo__list_resources')
    expect(names).toContain('mcp__echo__read_resource')

    // Verify annotations are respected
    const echoTool = tools.find(t => t.name === 'mcp__echo__echo')!
    expect(echoTool.isReadOnly).toBe(true)
    expect(echoTool.requiresPermission).toBe(false)
    expect(echoTool.category).toBe('mcp')

    const uppercaseTool = tools.find(t => t.name === 'mcp__echo__uppercase')!
    expect(uppercaseTool.isReadOnly).toBe(false)
    expect(uppercaseTool.requiresPermission).toBe(true)
  }, 15_000)

  it('adapted tools execute correctly through the full chain', async () => {
    manager = new MCPManager(false)
    await manager.addServer(echoServerConfig)

    const tools = manager.getAdaptedTools()

    // Call echo tool through adapted interface
    const echoTool = tools.find(t => t.name === 'mcp__echo__echo')!
    const echoResult = await (echoTool.execute as Function)({ message: 'e2e test' }, {})
    expect(echoResult.isError).toBe(false)
    expect(echoResult.content).toBe('e2e test')
    expect(echoResult.metadata?.serverName).toBe('echo')
    expect(echoResult.metadata?.toolName).toBe('echo')

    // Call reverse tool
    const reverseTool = tools.find(t => t.name === 'mcp__echo__reverse')!
    const reverseResult = await (reverseTool.execute as Function)({ text: 'hello' }, {})
    expect(reverseResult.content).toBe('olleh')

    // Call list_resources
    const listTool = tools.find(t => t.name === 'mcp__echo__list_resources')!
    const listResult = await (listTool.execute as Function)({}, {})
    expect(listResult.isError).toBe(false)
    expect(listResult.content).toContain('Greeting')
    expect(listResult.content).toContain('test://greeting')

    // Call read_resource
    const readTool = tools.find(t => t.name === 'mcp__echo__read_resource')!
    const readResult = await (readTool.execute as Function)({ uri: 'test://greeting' }, {})
    expect(readResult.isError).toBe(false)
    expect(readResult.content).toBe('Hello from Echo Server!')
  }, 15_000)

  it('handles multiple servers simultaneously', async () => {
    manager = new MCPManager(false)

    // Add two instances of the echo server with different names
    await manager.addServers([
      echoServerConfig,
      { ...echoServerConfig, name: 'echo-2' },
    ])

    expect(manager.size).toBe(2)
    expect(manager.connectedCount).toBe(2)

    const tools = manager.getAdaptedTools()
    // 5 tools per server × 2 servers = 10
    expect(tools.length).toBe(10)

    const names = tools.map(t => t.name)
    expect(names).toContain('mcp__echo__echo')
    expect(names).toContain('mcp__echo-2__echo')

    // Both servers work independently
    const echo1 = tools.find(t => t.name === 'mcp__echo__echo')!
    const echo2 = tools.find(t => t.name === 'mcp__echo-2__echo')!

    const r1 = await (echo1.execute as Function)({ message: 'server-1' }, {})
    const r2 = await (echo2.execute as Function)({ message: 'server-2' }, {})

    expect(r1.content).toBe('server-1')
    expect(r2.content).toBe('server-2')
  }, 20_000)

  it('listServers() returns complete server info', async () => {
    manager = new MCPManager(false)
    await manager.addServer(echoServerConfig)

    const servers = manager.listServers()
    expect(servers).toHaveLength(1)
    expect(servers[0].config.name).toBe('echo')
    expect(servers[0].status).toBe('connected')
    expect(servers[0].tools).toHaveLength(3)
    expect(servers[0].resources).toHaveLength(2)
    expect(servers[0].capabilities?.tools).toBe(true)
    expect(servers[0].capabilities?.resources).toBe(true)
    expect(servers[0].error).toBeUndefined()
  }, 15_000)

  it('shutdown() cleanly disconnects all servers', async () => {
    manager = new MCPManager(false)
    await manager.addServers([
      echoServerConfig,
      { ...echoServerConfig, name: 'echo-2' },
    ])

    expect(manager.size).toBe(2)
    await manager.shutdown()
    expect(manager.size).toBe(0)
    manager = null
  }, 15_000)
})

// ---------------------------------------------------------------------------
// Adapter E2E (with real server)
// ---------------------------------------------------------------------------

describe('MCP Adapter E2E — real tool adaptation', () => {
  let client: MCPClient | null = null

  afterEach(async () => {
    if (client) {
      await client.disconnect()
      client = null
    }
  })

  it('adaptMCPTool creates working Loom Tool from real server', async () => {
    client = new MCPClient(echoServerConfig)
    await client.connect()

    const tools = await client.listTools()
    const echoMcpTool = tools.find(t => t.name === 'echo')!

    const loomTool = adaptMCPTool(echoMcpTool, client)
    expect(loomTool.name).toBe('mcp__echo__echo')
    expect(loomTool.category).toBe('mcp')
    expect(loomTool.isReadOnly).toBe(true) // readOnlyHint: true

    // Execute through the adapted tool
    const result = await (loomTool.execute as Function)({ message: 'adapted!' }, {})
    expect(result.isError).toBe(false)
    expect(result.content).toBe('adapted!')
  }, 15_000)

  it('adaptAllMCPTools creates all tools from real server', async () => {
    client = new MCPClient(echoServerConfig)
    await client.connect()

    const mcpTools = await client.listTools()
    const loomTools = adaptAllMCPTools(mcpTools, client)

    expect(loomTools.length).toBe(3)
    expect(loomTools.every(t => t.name.startsWith('mcp__echo__'))).toBe(true)
    expect(loomTools.every(t => t.category === 'mcp')).toBe(true)
  }, 15_000)

  it('resource tools work with real server', async () => {
    client = new MCPClient(echoServerConfig)
    await client.connect()

    const listTool = createListResourcesTool('echo', client)
    const listResult = await (listTool.execute as Function)({}, {})
    expect(listResult.isError).toBe(false)
    expect(listResult.content).toContain('Greeting')
    expect(listResult.content).toContain('Config')

    const readTool = createReadResourceTool('echo', client)
    const readResult = await (readTool.execute as Function)({ uri: 'test://config' }, {})
    expect(readResult.isError).toBe(false)
    expect(readResult.content).toContain('"version"')
    expect(readResult.content).toContain('"1.0"')
  }, 15_000)
})
