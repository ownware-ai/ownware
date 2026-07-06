/**
 * Unit Tests — MCP Client
 *
 * Tests the MCPClient with a mock transport to verify JSON-RPC
 * protocol handling, tool discovery, resource operations, and
 * annotation parsing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MCPClient } from '../../../mcp/client.js'
import { MCPError } from '../../../mcp/types.js'
import type { MCPTransportLayer, MCPStdioServerConfig } from '../../../mcp/types.js'

// ---------------------------------------------------------------------------
// Mock transport
// ---------------------------------------------------------------------------

class MockTransport implements MCPTransportLayer {
  private messageHandler: ((msg: string) => void) | null = null
  private errorHandler: ((err: Error) => void) | null = null
  private closeHandler: (() => void) | null = null
  isOpen = false

  /** Simulate incoming messages from the "server" */
  simulateMessage(msg: string): void {
    this.messageHandler?.(msg)
  }

  simulateError(err: Error): void {
    this.errorHandler?.(err)
  }

  simulateClose(): void {
    this.isOpen = false
    this.closeHandler?.()
  }

  send = vi.fn()
  onMessage(handler: (message: string) => void): void { this.messageHandler = handler }
  onError(handler: (error: Error) => void): void { this.errorHandler = handler }
  onClose(handler: () => void): void { this.closeHandler = handler }
  async close(): Promise<void> { this.isOpen = false }
  async start(): Promise<void> { this.isOpen = true }
}

// We need to mock createTransport to return our MockTransport
const mockTransport = new MockTransport()

vi.mock('../../../mcp/transports.js', () => ({
  createTransport: () => mockTransport,
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function respondToNextRequest(transport: MockTransport, result: unknown, delay = 5): void {
  // Watch for the next send() call and respond
  transport.send.mockImplementationOnce((msg: string) => {
    const request = JSON.parse(msg)
    setTimeout(() => {
      transport.simulateMessage(JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result,
      }))
    }, delay)
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MCPClient', () => {
  const config: MCPStdioServerConfig = {
    name: 'test-server',
    transport: 'stdio',
    command: 'echo',
  }

  beforeEach(() => {
    mockTransport.isOpen = false
    mockTransport.send.mockReset()
  })

  describe('connect()', () => {
    it('initializes and sets connected state', async () => {
      const client = new MCPClient(config)
      expect(client.isConnected).toBe(false)

      // Mock initialize response
      respondToNextRequest(mockTransport, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: true, resources: true },
        serverInfo: { name: 'test', version: '1.0' },
      })

      await client.connect()
      expect(client.isConnected).toBe(true)
      expect(client.serverName).toBe('test-server')
    })

    it('parses server capabilities', async () => {
      const client = new MCPClient(config)

      respondToNextRequest(mockTransport, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: true, resources: true, prompts: false },
      })

      await client.connect()
      const caps = client.getCapabilities()
      expect(caps?.tools).toBe(true)
      expect(caps?.resources).toBe(true)
      expect(caps?.prompts).toBe(false)
    })

    it('sends initialized notification after handshake', async () => {
      const client = new MCPClient(config)

      respondToNextRequest(mockTransport, {
        protocolVersion: '2024-11-05',
        capabilities: {},
      })

      await client.connect()

      // First call: initialize request, second call: initialized notification
      expect(mockTransport.send).toHaveBeenCalledTimes(2)
      const notification = JSON.parse(mockTransport.send.mock.calls[1][0])
      expect(notification.method).toBe('notifications/initialized')
      expect(notification.id).toBeUndefined() // Notifications have no id
    })
  })

  describe('listTools()', () => {
    it('returns parsed tools with annotations', async () => {
      const client = new MCPClient(config)

      // Connect
      respondToNextRequest(mockTransport, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: true },
      })
      await client.connect()

      // List tools
      respondToNextRequest(mockTransport, {
        tools: [
          {
            name: 'search',
            description: 'Search things',
            inputSchema: { type: 'object', properties: {} },
            annotations: { readOnlyHint: true, openWorldHint: true },
          },
          {
            name: 'delete',
            description: 'Delete things',
            inputSchema: { type: 'object', properties: {} },
            annotations: { destructiveHint: true },
          },
        ],
      })

      const tools = await client.listTools()
      expect(tools).toHaveLength(2)

      expect(tools[0].name).toBe('search')
      expect(tools[0].serverName).toBe('test-server')
      expect(tools[0].annotations?.readOnlyHint).toBe(true)
      expect(tools[0].annotations?.openWorldHint).toBe(true)

      expect(tools[1].name).toBe('delete')
      expect(tools[1].annotations?.destructiveHint).toBe(true)
    })

    it('handles tools without annotations', async () => {
      const client = new MCPClient(config)

      respondToNextRequest(mockTransport, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: true },
      })
      await client.connect()

      respondToNextRequest(mockTransport, {
        tools: [
          { name: 'basic', description: 'A basic tool', inputSchema: { type: 'object', properties: {} } },
        ],
      })

      const tools = await client.listTools()
      expect(tools[0].annotations).toBeUndefined()
    })

    it('returns empty array when no tools', async () => {
      const client = new MCPClient(config)

      respondToNextRequest(mockTransport, {
        protocolVersion: '2024-11-05',
        capabilities: {},
      })
      await client.connect()

      respondToNextRequest(mockTransport, { tools: [] })
      const tools = await client.listTools()
      expect(tools).toEqual([])
    })

    it('throws when not connected', async () => {
      const client = new MCPClient(config)
      await expect(client.listTools()).rejects.toThrow(MCPError)
    })
  })

  describe('listResources()', () => {
    it('returns parsed resources', async () => {
      const client = new MCPClient(config)

      respondToNextRequest(mockTransport, {
        protocolVersion: '2024-11-05',
        capabilities: { resources: true },
      })
      await client.connect()

      respondToNextRequest(mockTransport, {
        resources: [
          { uri: 'file:///readme.md', name: 'README', description: 'The readme', mimeType: 'text/markdown' },
        ],
      })

      const resources = await client.listResources()
      expect(resources).toHaveLength(1)
      expect(resources[0].uri).toBe('file:///readme.md')
      expect(resources[0].name).toBe('README')
      expect(resources[0].serverName).toBe('test-server')
    })
  })

  describe('readResource()', () => {
    it('reads text resource content', async () => {
      const client = new MCPClient(config)

      respondToNextRequest(mockTransport, {
        protocolVersion: '2024-11-05',
        capabilities: { resources: true },
      })
      await client.connect()

      respondToNextRequest(mockTransport, {
        contents: [
          { uri: 'file:///readme.md', text: '# Hello', mimeType: 'text/markdown' },
        ],
      })

      const contents = await client.readResource('file:///readme.md')
      expect(contents).toHaveLength(1)
      expect(contents[0].text).toBe('# Hello')
      expect(contents[0].mimeType).toBe('text/markdown')
    })

    it('reads binary resource content', async () => {
      const client = new MCPClient(config)

      respondToNextRequest(mockTransport, {
        protocolVersion: '2024-11-05',
        capabilities: { resources: true },
      })
      await client.connect()

      respondToNextRequest(mockTransport, {
        contents: [
          { uri: 'file:///img.png', blob: 'base64data', mimeType: 'image/png' },
        ],
      })

      const contents = await client.readResource('file:///img.png')
      expect(contents[0].blob).toBe('base64data')
    })
  })

  describe('callTool()', () => {
    it('calls tool and returns text content', async () => {
      const client = new MCPClient(config)

      respondToNextRequest(mockTransport, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: true },
      })
      await client.connect()

      respondToNextRequest(mockTransport, {
        content: [{ type: 'text', text: 'result data' }],
      })

      const result = await client.callTool('search', { query: 'test' })
      expect(result).toBe('result data')

      // Verify the request was correct
      const callMsg = JSON.parse(mockTransport.send.mock.calls[2][0])
      expect(callMsg.method).toBe('tools/call')
      expect(callMsg.params.name).toBe('search')
      expect(callMsg.params.arguments).toEqual({ query: 'test' })
    })

    it('throws on tool error', async () => {
      const client = new MCPClient(config)

      respondToNextRequest(mockTransport, {
        protocolVersion: '2024-11-05',
        capabilities: {},
      })
      await client.connect()

      respondToNextRequest(mockTransport, {
        content: [{ type: 'text', text: 'something went wrong' }],
        isError: true,
      })

      await expect(client.callTool('bad-tool', {})).rejects.toThrow(MCPError)
    })
  })

  describe('disconnect()', () => {
    it('disconnects cleanly', async () => {
      const client = new MCPClient(config)

      respondToNextRequest(mockTransport, {
        protocolVersion: '2024-11-05',
        capabilities: {},
      })
      await client.connect()
      expect(client.isConnected).toBe(true)

      await client.disconnect()
      expect(client.isConnected).toBe(false)
    })
  })

  describe('error handling', () => {
    it('rejects pending requests on transport error', async () => {
      const client = new MCPClient(config)

      respondToNextRequest(mockTransport, {
        protocolVersion: '2024-11-05',
        capabilities: {},
      })
      await client.connect()

      // Start a request that won't get a response
      mockTransport.send.mockImplementation(() => {}) // swallow the send
      const toolPromise = client.callTool('search', {})

      // Simulate transport error
      mockTransport.simulateClose()

      await expect(toolPromise).rejects.toThrow()
    })

    it('handles RPC error responses', async () => {
      const client = new MCPClient(config)

      respondToNextRequest(mockTransport, {
        protocolVersion: '2024-11-05',
        capabilities: {},
      })
      await client.connect()

      // Send RPC error response
      mockTransport.send.mockImplementationOnce((msg: string) => {
        const request = JSON.parse(msg)
        setTimeout(() => {
          mockTransport.simulateMessage(JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            error: { code: -32600, message: 'Invalid Request' },
          }))
        }, 5)
      })

      await expect(client.callTool('search', {})).rejects.toThrow('RPC error: Invalid Request')
    })
  })

  // ── F4.b: unexpected-close listener (audit #4 verification) ─────────
  describe('setUnexpectedCloseListener()', () => {
    it('fires when the transport closes after a successful handshake', async () => {
      const client = new MCPClient(config)
      const reasons: string[] = []
      client.setUnexpectedCloseListener((reason) => reasons.push(reason))

      respondToNextRequest(mockTransport, {
        protocolVersion: '2024-11-05',
        capabilities: {},
      })
      await client.connect()
      expect(client.isConnected).toBe(true)

      mockTransport.simulateClose()

      expect(reasons).toEqual(['transport_closed'])
      expect(client.isConnected).toBe(false)
    })

    it('does NOT fire on caller-initiated disconnect() (orderly shutdown)', async () => {
      const client = new MCPClient(config)
      const reasons: string[] = []
      client.setUnexpectedCloseListener((reason) => reasons.push(reason))

      respondToNextRequest(mockTransport, {
        protocolVersion: '2024-11-05',
        capabilities: {},
      })
      await client.connect()

      // Have the transport synchronously close inside its own close().
      // This mirrors what stdio + WebSocket actually do — the orderly
      // close path emits an `onClose` event during teardown.
      mockTransport.close = async () => {
        mockTransport.simulateClose()
      }

      await client.disconnect()

      expect(reasons).toEqual([])
    })

    it('does NOT fire when the transport closes before the handshake completes', async () => {
      const client = new MCPClient(config)
      const reasons: string[] = []
      client.setUnexpectedCloseListener((reason) => reasons.push(reason))

      // No response to initialize — connect will eventually fail.
      mockTransport.send.mockImplementation(() => {
        // Close mid-handshake.
        mockTransport.simulateClose()
      })

      await expect(client.connect()).rejects.toThrow()
      expect(reasons).toEqual([])
    })

    it('clears when set to null', async () => {
      const client = new MCPClient(config)
      const reasons: string[] = []
      client.setUnexpectedCloseListener((reason) => reasons.push(reason))

      respondToNextRequest(mockTransport, {
        protocolVersion: '2024-11-05',
        capabilities: {},
      })
      await client.connect()

      client.setUnexpectedCloseListener(null)
      mockTransport.simulateClose()

      expect(reasons).toEqual([])
    })
  })
})
