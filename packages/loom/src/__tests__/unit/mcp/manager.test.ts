/**
 * Unit Tests — MCP Manager
 *
 * Tests manager lifecycle, tool/resource aggregation, adapted tools,
 * and server state management using mock clients.
 */

import { describe, it, expect, vi } from 'vitest'
import { MCPManager } from '../../../mcp/manager.js'
import type { MCPServerStateChange } from '../../../mcp/manager.js'
import { MCPError } from '../../../mcp/types.js'
import type { MCPStdioServerConfig, MCPTool, MCPResource, MCPServerCapabilities } from '../../../mcp/types.js'

// ---------------------------------------------------------------------------
// Mock MCPClient
// ---------------------------------------------------------------------------

const mockTools: MCPTool[] = [
  {
    name: 'search',
    description: 'Search things',
    inputSchema: { type: 'object', properties: {} },
    serverName: 'test-server',
    annotations: { readOnlyHint: true },
  },
  {
    name: 'write',
    description: 'Write things',
    inputSchema: { type: 'object', properties: {} },
    serverName: 'test-server',
    annotations: { destructiveHint: true },
  },
]

const mockResources: MCPResource[] = [
  { uri: 'file:///doc.md', name: 'Doc', serverName: 'test-server' },
]

const mockCapabilities: MCPServerCapabilities = {
  tools: true,
  resources: true,
  prompts: false,
}

/** Captures the per-instance unexpected-close listeners the manager
 *  registers via `client.setUnexpectedCloseListener`. Keyed by server
 *  name so tests can target a specific server. */
const closeListeners = new Map<string, ((reason: string) => void) | null>()

/**
 * Test seam: simulate a transport process crash for the given server.
 * Mirrors what `MCPClient.transport.onClose` does when the underlying
 * stdio child dies — invokes the manager's registered handler.
 */
function simulateUnexpectedClose(serverName: string, reason = 'transport_closed'): void {
  const listener = closeListeners.get(serverName)
  if (listener) listener(reason)
}

vi.mock('../../../mcp/client.js', () => ({
  MCPClient: vi.fn().mockImplementation(function (this: any, config: any) {
    this.config = config
    this.connected = false
    this.isConnected = false
    this.serverName = config.name
    this.connect = vi.fn().mockImplementation(async () => {
      this.connected = true
      this.isConnected = true
    })
    this.disconnect = vi.fn().mockImplementation(async () => {
      this.connected = false
      this.isConnected = false
    })
    this.listTools = vi.fn().mockResolvedValue(mockTools)
    this.listResources = vi.fn().mockResolvedValue(mockResources)
    this.readResource = vi.fn().mockResolvedValue([{ uri: 'file:///doc.md', text: 'content' }])
    this.callTool = vi.fn().mockResolvedValue('tool result')
    this.getCapabilities = vi.fn().mockReturnValue(mockCapabilities)
    this.setUnexpectedCloseListener = vi.fn().mockImplementation(
      (listener: ((reason: string) => void) | null) => {
        closeListeners.set(config.name, listener)
      },
    )
  }),
}))

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MCPManager', () => {
  const config: MCPStdioServerConfig = {
    name: 'test-server',
    transport: 'stdio',
    command: 'echo',
  }

  describe('addServer()', () => {
    it('connects and discovers tools', async () => {
      const manager = new MCPManager(false)
      await manager.addServer(config)

      expect(manager.size).toBe(1)
      expect(manager.connectedCount).toBe(1)

      const server = manager.getServer('test-server')
      expect(server?.status).toBe('connected')
      expect(server?.tools).toHaveLength(2)
    })

    it('discovers resources for capable servers', async () => {
      const manager = new MCPManager(false)
      await manager.addServer(config)

      const server = manager.getServer('test-server')
      expect(server?.resources).toHaveLength(1)
      expect(server?.resources[0].uri).toBe('file:///doc.md')
    })

    it('throws on duplicate server name', async () => {
      const manager = new MCPManager(false)
      await manager.addServer(config)
      await expect(manager.addServer(config)).rejects.toThrow(MCPError)
    })
  })

  describe('addServers()', () => {
    it('adds multiple servers in parallel', async () => {
      const manager = new MCPManager(false)
      await manager.addServers([
        config,
        { ...config, name: 'test-server-2' },
      ])
      expect(manager.size).toBe(2)
    })
  })

  describe('getTools()', () => {
    it('returns raw MCP tools from connected servers', async () => {
      const manager = new MCPManager(false)
      await manager.addServer(config)

      const tools = manager.getTools()
      expect(tools).toHaveLength(2)
      expect(tools[0].name).toBe('search')
      expect(tools[1].name).toBe('write')
    })
  })

  describe('getResources()', () => {
    it('returns resources from connected servers', async () => {
      const manager = new MCPManager(false)
      await manager.addServer(config)

      const resources = manager.getResources()
      expect(resources).toHaveLength(1)
      expect(resources[0].uri).toBe('file:///doc.md')
    })
  })

  describe('getAdaptedTools()', () => {
    it('returns Loom Tool[] with mcp__ prefixed names', async () => {
      const manager = new MCPManager(false)
      await manager.addServer(config)

      const tools = manager.getAdaptedTools()
      // 2 MCP tools + list_resources + read_resource = 4
      expect(tools.length).toBe(4)

      const names = tools.map(t => t.name)
      expect(names).toContain('mcp__test-server__search')
      expect(names).toContain('mcp__test-server__write')
      expect(names).toContain('mcp__test-server__list_resources')
      expect(names).toContain('mcp__test-server__read_resource')
    })

    it('respects readOnlyHint annotation', async () => {
      const manager = new MCPManager(false)
      await manager.addServer(config)

      const tools = manager.getAdaptedTools()
      const searchTool = tools.find(t => t.name === 'mcp__test-server__search')
      expect(searchTool?.isReadOnly).toBe(true)

      const writeTool = tools.find(t => t.name === 'mcp__test-server__write')
      expect(writeTool?.isReadOnly).toBe(false)
    })

    it('respects destructiveHint annotation', async () => {
      const manager = new MCPManager(false)
      await manager.addServer(config)

      const tools = manager.getAdaptedTools()
      const writeTool = tools.find(t => t.name === 'mcp__test-server__write')
      expect(writeTool?.requiresPermission).toBe(true)

      const searchTool = tools.find(t => t.name === 'mcp__test-server__search')
      expect(searchTool?.requiresPermission).toBe(false)
    })

    it('resource tools are read-only', async () => {
      const manager = new MCPManager(false)
      await manager.addServer(config)

      const tools = manager.getAdaptedTools()
      const listTool = tools.find(t => t.name === 'mcp__test-server__list_resources')
      const readTool = tools.find(t => t.name === 'mcp__test-server__read_resource')
      expect(listTool?.isReadOnly).toBe(true)
      expect(readTool?.isReadOnly).toBe(true)
    })

    it('returns empty array when no servers', () => {
      const manager = new MCPManager(false)
      expect(manager.getAdaptedTools()).toEqual([])
    })
  })

  describe('removeServer()', () => {
    it('disconnects and removes server', async () => {
      const manager = new MCPManager(false)
      await manager.addServer(config)
      expect(manager.size).toBe(1)

      await manager.removeServer('test-server')
      expect(manager.size).toBe(0)
      expect(manager.getServer('test-server')).toBeUndefined()
    })

    it('is a no-op for unknown servers', async () => {
      const manager = new MCPManager(false)
      await manager.removeServer('nonexistent') // Should not throw
    })
  })

  describe('listServers()', () => {
    it('returns all servers with status', async () => {
      const manager = new MCPManager(false)
      await manager.addServer(config)

      const servers = manager.listServers()
      expect(servers).toHaveLength(1)
      expect(servers[0].config.name).toBe('test-server')
      expect(servers[0].status).toBe('connected')
      expect(servers[0].tools).toHaveLength(2)
      expect(servers[0].resources).toHaveLength(1)
    })
  })

  describe('shutdown()', () => {
    it('removes all servers', async () => {
      const manager = new MCPManager(false)
      await manager.addServers([
        config,
        { ...config, name: 'server-2' },
      ])
      expect(manager.size).toBe(2)

      await manager.shutdown()
      expect(manager.size).toBe(0)
    })
  })

  describe('getClient()', () => {
    it('returns client for known server', async () => {
      const manager = new MCPManager(false)
      await manager.addServer(config)

      const client = manager.getClient('test-server')
      expect(client).toBeDefined()
    })

    it('returns undefined for unknown server', () => {
      const manager = new MCPManager(false)
      expect(manager.getClient('nope')).toBeUndefined()
    })
  })

  // ── F4.b: state-change listener (audit #4 verification) ─────────────
  //
  // Closes the "MCP process death not mirrored back to gateway DB or
  // status bus" finding. The manager owns the state; this listener is
  // the seam cortex subscribes to so transport closures flip the
  // connector status bus without loom touching SSE.
  describe('setStateChangeListener()', () => {
    it('fires on initial connect with previousStatus="connecting"', async () => {
      const events: MCPServerStateChange[] = []
      const manager = new MCPManager(false)
      manager.setStateChangeListener((ev) => events.push(ev))

      await manager.addServer(config)

      expect(events).toEqual([
        {
          serverName: 'test-server',
          status: 'connected',
          previousStatus: 'connecting',
        },
      ])
    })

    it('fires status="error" with reason="transport_closed" when the transport dies', async () => {
      const events: MCPServerStateChange[] = []
      const manager = new MCPManager(false)
      manager.setStateChangeListener((ev) => events.push(ev))

      await manager.addServer(config)
      simulateUnexpectedClose('test-server')

      // Two transitions: connecting→connected (initial), connected→error
      // (transport close). Reason on the error event identifies the cause.
      expect(events).toHaveLength(2)
      expect(events[1]).toMatchObject({
        serverName: 'test-server',
        status: 'error',
        previousStatus: 'connected',
        reason: 'transport_closed',
      })
      expect(events[1].error).toContain('Transport closed unexpectedly')
    })

    it('flips the manager state to "error" when the transport dies', async () => {
      const manager = new MCPManager(false)
      await manager.addServer(config)
      expect(manager.getServer('test-server')?.status).toBe('connected')

      simulateUnexpectedClose('test-server')

      expect(manager.getServer('test-server')?.status).toBe('error')
      expect(manager.connectedCount).toBe(0)
    })

    it('does not fire on caller-initiated removeServer (orderly shutdown)', async () => {
      const manager = new MCPManager(false)
      await manager.addServer(config)

      const events: MCPServerStateChange[] = []
      manager.setStateChangeListener((ev) => events.push(ev))

      await manager.removeServer('test-server')

      // No new event — the listener only fires on status transitions
      // observed in the state map. `removeServer` deletes the entry
      // outright; that's not a transition, it's an absence.
      expect(events).toHaveLength(0)
    })

    it('replaces the previous listener when setStateChangeListener is called again', async () => {
      const first: MCPServerStateChange[] = []
      const second: MCPServerStateChange[] = []
      const manager = new MCPManager(false)

      manager.setStateChangeListener((ev) => first.push(ev))
      manager.setStateChangeListener((ev) => second.push(ev))

      await manager.addServer(config)

      expect(first).toHaveLength(0)
      expect(second).toHaveLength(1)
    })

    it('swallows listener exceptions so manager state stays consistent', async () => {
      const manager = new MCPManager(false)
      manager.setStateChangeListener(() => {
        throw new Error('listener boom')
      })

      // addServer must succeed despite the throwing listener.
      await expect(manager.addServer(config)).resolves.toBeUndefined()
      expect(manager.getServer('test-server')?.status).toBe('connected')
    })

    it('fires status="error" with reason="connect_failed" on initial connect failure', async () => {
      const events: MCPServerStateChange[] = []
      const manager = new MCPManager(false)
      manager.setStateChangeListener((ev) => events.push(ev))

      // Make `connect()` throw for the next instance.
      const { MCPClient: mockedClient } = await import('../../../mcp/client.js')
      const mock = mockedClient as unknown as ReturnType<typeof vi.fn>
      mock.mockImplementationOnce(function (this: any, cfg: any) {
        this.config = cfg
        this.connect = vi.fn().mockRejectedValue(new Error('boom'))
        this.disconnect = vi.fn()
        this.setUnexpectedCloseListener = vi.fn().mockImplementation(
          (listener: ((reason: string) => void) | null) => {
            closeListeners.set(cfg.name, listener)
          },
        )
      })

      await manager.addServer({ ...config, name: 'broken-server' })

      expect(events).toEqual([
        {
          serverName: 'broken-server',
          status: 'error',
          previousStatus: 'connecting',
          reason: 'connect_failed',
          error: 'boom',
        },
      ])
    })
  })
})
