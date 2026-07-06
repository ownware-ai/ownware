/**
 * MCP Test: Server Connection + Tool Discovery
 *
 * Tests connecting to the bundled echo MCP server via stdio transport.
 * No credentials needed — the server runs as a local subprocess.
 *
 * Validates:
 * - Server connects successfully
 * - Tools are discovered and adapted to Loom format
 * - Resources are discovered
 * - Tool calls execute correctly
 * - Shutdown cleans up
 */

import { describe, it, expect, afterEach } from 'vitest'
import { join } from 'node:path'
import { MCPManager } from '../../../src/mcp/manager.js'
import type { MCPServerConfig } from '../../../src/mcp/types.js'

// ESM dirname shim
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
const __filename2 = fileURLToPath(import.meta.url)
const __dirname2 = dirname(__filename2)

// Path to the bundled echo server
const ECHO_SERVER = join(__dirname2, '..', '..', '..', 'src', '__tests__', 'e2e', 'mcp-echo-server.ts')

function echoServerConfig(): MCPServerConfig {
  return {
    name: 'echo',
    transport: 'stdio',
    command: 'npx',
    args: ['tsx', ECHO_SERVER],
  }
}

describe('MCP: Echo Server Connection', () => {
  let manager: MCPManager

  afterEach(async () => {
    if (manager) await manager.shutdown()
  })

  it('connects to echo server and discovers tools', async () => {
    manager = new MCPManager()
    await manager.addServers([echoServerConfig()])

    expect(manager.connectedCount).toBe(1)

    // Get adapted tools
    const tools = manager.getAdaptedTools()
    const names = tools.map(t => t.name)

    // Should have 3 tools from the echo server
    expect(names).toContain('mcp__echo__echo')
    expect(names).toContain('mcp__echo__reverse')
    expect(names).toContain('mcp__echo__uppercase')

    // Plus resource tools (list + read)
    expect(names).toContain('mcp__echo__list_resources')
    expect(names).toContain('mcp__echo__read_resource')

    // Total: 3 tools + 2 resource tools = 5
    expect(tools.length).toBe(5)
  }, 15_000)

  it('echo tool returns input message', async () => {
    manager = new MCPManager()
    await manager.addServers([echoServerConfig()])

    const tools = manager.getAdaptedTools()
    const echoTool = tools.find(t => t.name === 'mcp__echo__echo')!
    expect(echoTool).toBeTruthy()

    // Execute the echo tool
    const result = await echoTool.execute(
      { message: 'HELLO_MCP_ECHO' },
      { config: {} as any, messages: [] },
    )
    expect(result.content).toContain('HELLO_MCP_ECHO')
    expect(result.isError).toBe(false)
  }, 15_000)

  it('reverse tool reverses the input string', async () => {
    manager = new MCPManager()
    await manager.addServers([echoServerConfig()])

    const tools = manager.getAdaptedTools()
    const reverseTool = tools.find(t => t.name === 'mcp__echo__reverse')!

    const result = await reverseTool.execute(
      { text: 'ABCDE' },
      { config: {} as any, messages: [] },
    )
    expect(result.content).toContain('EDCBA')
    expect(result.isError).toBe(false)
  }, 15_000)

  it('uppercase tool converts to uppercase', async () => {
    manager = new MCPManager()
    await manager.addServers([echoServerConfig()])

    const tools = manager.getAdaptedTools()
    const uppercaseTool = tools.find(t => t.name === 'mcp__echo__uppercase')!

    const result = await uppercaseTool.execute(
      { text: 'hello world' },
      { config: {} as any, messages: [] },
    )
    expect(result.content).toContain('HELLO WORLD')
    expect(result.isError).toBe(false)
  }, 15_000)

  it('tool annotations are preserved (readOnly, destructive)', async () => {
    manager = new MCPManager()
    await manager.addServers([echoServerConfig()])

    const tools = manager.getAdaptedTools()

    // echo has readOnlyHint: true
    const echoTool = tools.find(t => t.name === 'mcp__echo__echo')!
    expect(echoTool.isReadOnly).toBe(true)

    // uppercase has destructiveHint: true
    const uppercaseTool = tools.find(t => t.name === 'mcp__echo__uppercase')!
    expect(uppercaseTool.requiresPermission).toBe(true)
  }, 15_000)

  it('read_resource tool reads test resources', async () => {
    manager = new MCPManager()
    await manager.addServers([echoServerConfig()])

    const tools = manager.getAdaptedTools()
    const readResource = tools.find(t => t.name === 'mcp__echo__read_resource')!

    const result = await readResource.execute(
      { uri: 'test://greeting' },
      { config: {} as any, messages: [] },
    )
    expect(result.content).toContain('Hello from Echo Server')
    expect(result.isError).toBe(false)
  }, 15_000)

  it('shutdown disconnects cleanly', async () => {
    manager = new MCPManager()
    await manager.addServers([echoServerConfig()])
    expect(manager.connectedCount).toBe(1)

    await manager.shutdown()
    expect(manager.connectedCount).toBe(0)
    manager = undefined as any // Prevent double shutdown in afterEach
  }, 15_000)
})
