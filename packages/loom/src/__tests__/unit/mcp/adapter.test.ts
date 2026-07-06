/**
 * Unit Tests — MCP Adapter
 *
 * Tests conversion of MCP tools to Loom Tool interface,
 * including tool annotations and resource tools.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  adaptMCPTool,
  adaptAllMCPTools,
  createListResourcesTool,
  createReadResourceTool,
  sanitizeMCPToolNamePart,
} from '../../../mcp/adapter.js'
import type { MCPTool } from '../../../mcp/types.js'
import type { MCPClient } from '../../../mcp/client.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const mockTool: MCPTool = {
  name: 'search',
  description: 'Search the web for information',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string', description: 'Search query' } },
    required: ['query'],
  },
  serverName: 'web-tools',
}

function mockClient(callResult = 'search result'): MCPClient {
  return {
    callTool: vi.fn().mockResolvedValue(callResult),
    listResources: vi.fn().mockResolvedValue([]),
    readResource: vi.fn().mockResolvedValue([]),
    isConnected: true,
    getCapabilities: vi.fn().mockReturnValue(null),
  } as unknown as MCPClient
}

// ---------------------------------------------------------------------------
// adaptMCPTool
// ---------------------------------------------------------------------------

describe('sanitizeMCPToolNamePart()', () => {
  // LLM provider validation requires `^[a-zA-Z0-9_-]{1,64}$`. Any
  // tool name with `/` or `.` (common in registry namespaces like
  // `io.github.user/server`) is rejected by the provider, killing
  // the entire turn with a misleading 500. The sanitizer rewrites
  // unsafe chars to `_`. Surfaced 2026-05-07.
  const VALID_TOOL_NAME_RE = /^[a-zA-Z0-9_-]+$/

  it('passes through plain alphanumeric + underscore + hyphen', () => {
    expect(sanitizeMCPToolNamePart('web-tools')).toBe('web-tools')
    expect(sanitizeMCPToolNamePart('GitHub_v2')).toBe('GitHub_v2')
  })

  it('rewrites slash and dot to underscore', () => {
    expect(sanitizeMCPToolNamePart('io.github.user/server')).toBe(
      'io_github_user_server',
    )
    expect(sanitizeMCPToolNamePart('com.notion/mcp')).toBe('com_notion_mcp')
  })

  it('rewrites every other unsafe char to underscore', () => {
    expect(sanitizeMCPToolNamePart('foo bar')).toBe('foo_bar')
    expect(sanitizeMCPToolNamePart('a@b#c')).toBe('a_b_c')
  })

  it('every output passes the LLM-provider tool-name regex', () => {
    for (const raw of [
      'io.github.issuecapture/mcp-server',
      'com.notion/mcp',
      'ai.smithery/smithery-notion',
      'plain-name',
    ]) {
      expect(VALID_TOOL_NAME_RE.test(sanitizeMCPToolNamePart(raw))).toBe(true)
    }
  })
})

describe('adaptMCPTool()', () => {
  it('creates a Loom Tool with prefixed name', () => {
    const tool = adaptMCPTool(mockTool, mockClient())
    expect(tool.name).toBe('mcp__web-tools__search')
  })

  it('sanitizes registry-namespace serverName so the prefixed tool name passes provider validation', () => {
    // Regression guard for the issuecapture-style breakage:
    // `io.github.issuecapture/mcp-server` produced
    // `mcp__io.github.issuecapture/mcp-server__install` which the
    // LLM provider rejected. After fix, the prefixed name is safe.
    const registryTool: MCPTool = {
      ...mockTool,
      serverName: 'io.github.issuecapture/mcp-server',
      name: 'install',
    }
    const tool = adaptMCPTool(registryTool, mockClient())
    expect(tool.name).toBe('mcp__io_github_issuecapture_mcp-server__install')
    expect(/^[a-zA-Z0-9_-]+$/.test(tool.name)).toBe(true)
  })

  it('list_resources / read_resource tools also sanitize the server name', () => {
    const list = createListResourcesTool(
      'io.github.user/registry-server',
      mockClient(),
    )
    const read = createReadResourceTool(
      'io.github.user/registry-server',
      mockClient(),
    )
    expect(list.name).toBe('mcp__io_github_user_registry-server__list_resources')
    expect(read.name).toBe('mcp__io_github_user_registry-server__read_resource')
    expect(/^[a-zA-Z0-9_-]+$/.test(list.name)).toBe(true)
    expect(/^[a-zA-Z0-9_-]+$/.test(read.name)).toBe(true)
  })

  it('preserves description', () => {
    const tool = adaptMCPTool(mockTool, mockClient())
    expect(tool.description).toBe('Search the web for information')
  })

  it('preserves input schema', () => {
    const tool = adaptMCPTool(mockTool, mockClient())
    expect(tool.inputSchema).toEqual(mockTool.inputSchema)
  })

  it('sets category to mcp', () => {
    const tool = adaptMCPTool(mockTool, mockClient())
    expect(tool.category).toBe('mcp')
  })

  it('execute() calls client.callTool and returns result', async () => {
    const client = mockClient('result text')
    const tool = adaptMCPTool(mockTool, client)

    const result = await (tool.execute as Function)({ query: 'test' }, {})
    expect(result.content).toBe('result text')
    expect(result.isError).toBe(false)
    expect(client.callTool).toHaveBeenCalledWith('search', { query: 'test' })
  })

  it('execute() returns error result on failure', async () => {
    const client = mockClient()
    ;(client.callTool as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('timeout'))

    const tool = adaptMCPTool(mockTool, client)
    const result = await (tool.execute as Function)({ query: 'test' }, {})
    expect(result.isError).toBe(true)
    expect(result.content).toContain('timeout')
  })

  it('includes server metadata in result', async () => {
    const tool = adaptMCPTool(mockTool, mockClient())
    const result = await (tool.execute as Function)({ query: 'test' }, {})
    expect(result.metadata).toMatchObject({ serverName: 'web-tools', toolName: 'search' })
  })

  it('truncates very long descriptions', () => {
    const longTool = { ...mockTool, description: 'x'.repeat(3000) }
    const tool = adaptMCPTool(longTool, mockClient())
    expect(tool.description.length).toBeLessThanOrEqual(2048)
    expect(tool.description).toMatch(/\.\.\.$/)
  })

  // --- Tool annotation tests ---

  it('defaults to isReadOnly: false when no annotations', () => {
    const tool = adaptMCPTool(mockTool, mockClient())
    expect(tool.isReadOnly).toBe(false)
  })

  it('sets isReadOnly: true when readOnlyHint is true', () => {
    const readOnlyTool: MCPTool = {
      ...mockTool,
      annotations: { readOnlyHint: true },
    }
    const tool = adaptMCPTool(readOnlyTool, mockClient())
    expect(tool.isReadOnly).toBe(true)
  })

  it('sets isReadOnly: false when readOnlyHint is false', () => {
    const writeTool: MCPTool = {
      ...mockTool,
      annotations: { readOnlyHint: false },
    }
    const tool = adaptMCPTool(writeTool, mockClient())
    expect(tool.isReadOnly).toBe(false)
  })

  it('defaults to requiresPermission: false when no annotations', () => {
    const tool = adaptMCPTool(mockTool, mockClient())
    expect(tool.requiresPermission).toBe(false)
  })

  it('sets requiresPermission: true when destructiveHint is true', () => {
    const destructiveTool: MCPTool = {
      ...mockTool,
      annotations: { destructiveHint: true },
    }
    const tool = adaptMCPTool(destructiveTool, mockClient())
    expect(tool.requiresPermission).toBe(true)
  })

  it('includes annotations in result metadata', async () => {
    const annotatedTool: MCPTool = {
      ...mockTool,
      annotations: { readOnlyHint: true, openWorldHint: true },
    }
    const tool = adaptMCPTool(annotatedTool, mockClient())
    const result = await (tool.execute as Function)({ query: 'test' }, {})
    expect(result.metadata?.annotations).toEqual({ readOnlyHint: true, openWorldHint: true })
  })
})

// ---------------------------------------------------------------------------
// adaptAllMCPTools
// ---------------------------------------------------------------------------

describe('adaptAllMCPTools()', () => {
  it('adapts multiple tools', () => {
    const tools: MCPTool[] = [
      mockTool,
      { ...mockTool, name: 'fetch', description: 'Fetch a URL' },
    ]
    const adapted = adaptAllMCPTools(tools, mockClient())
    expect(adapted).toHaveLength(2)
    expect(adapted[0].name).toBe('mcp__web-tools__search')
    expect(adapted[1].name).toBe('mcp__web-tools__fetch')
  })

  it('returns empty array for empty input', () => {
    expect(adaptAllMCPTools([], mockClient())).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Resource tools
// ---------------------------------------------------------------------------

describe('createListResourcesTool()', () => {
  it('creates a read-only tool with correct name', () => {
    const tool = createListResourcesTool('my-server', mockClient())
    expect(tool.name).toBe('mcp__my-server__list_resources')
    expect(tool.isReadOnly).toBe(true)
    expect(tool.category).toBe('mcp')
  })

  it('returns resources list on execute', async () => {
    const client = mockClient()
    ;(client.listResources as ReturnType<typeof vi.fn>).mockResolvedValue([
      { uri: 'file:///readme.md', name: 'README', mimeType: 'text/markdown', description: 'The readme' },
      { uri: 'file:///config.json', name: 'Config', mimeType: 'application/json' },
    ])

    const tool = createListResourcesTool('my-server', client)
    const result = await (tool.execute as Function)({}, {})
    expect(result.isError).toBe(false)
    expect(result.content).toContain('README')
    expect(result.content).toContain('file:///readme.md')
    expect(result.content).toContain('text/markdown')
    expect(result.content).toContain('The readme')
    expect(result.metadata?.resourceCount).toBe(2)
  })

  it('returns friendly message when no resources', async () => {
    const client = mockClient()
    ;(client.listResources as ReturnType<typeof vi.fn>).mockResolvedValue([])

    const tool = createListResourcesTool('my-server', client)
    const result = await (tool.execute as Function)({}, {})
    expect(result.isError).toBe(false)
    expect(result.content).toBe('No resources available.')
  })

  it('returns error on failure', async () => {
    const client = mockClient()
    ;(client.listResources as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('connection lost'))

    const tool = createListResourcesTool('my-server', client)
    const result = await (tool.execute as Function)({}, {})
    expect(result.isError).toBe(true)
    expect(result.content).toContain('connection lost')
  })
})

describe('createReadResourceTool()', () => {
  it('creates a read-only tool with correct name', () => {
    const tool = createReadResourceTool('my-server', mockClient())
    expect(tool.name).toBe('mcp__my-server__read_resource')
    expect(tool.isReadOnly).toBe(true)
    expect(tool.category).toBe('mcp')
  })

  it('reads text resource', async () => {
    const client = mockClient()
    ;(client.readResource as ReturnType<typeof vi.fn>).mockResolvedValue([
      { uri: 'file:///readme.md', text: '# Hello World', mimeType: 'text/markdown' },
    ])

    const tool = createReadResourceTool('my-server', client)
    const result = await (tool.execute as Function)({ uri: 'file:///readme.md' }, {})
    expect(result.isError).toBe(false)
    expect(result.content).toBe('# Hello World')
  })

  it('reports binary content', async () => {
    const client = mockClient()
    ;(client.readResource as ReturnType<typeof vi.fn>).mockResolvedValue([
      { uri: 'file:///image.png', blob: 'iVBOR...', mimeType: 'image/png' },
    ])

    const tool = createReadResourceTool('my-server', client)
    const result = await (tool.execute as Function)({ uri: 'file:///image.png' }, {})
    expect(result.isError).toBe(false)
    expect(result.content).toContain('Binary content')
    expect(result.content).toContain('image/png')
  })

  it('returns error when uri is missing', async () => {
    const tool = createReadResourceTool('my-server', mockClient())
    const result = await (tool.execute as Function)({}, {})
    expect(result.isError).toBe(true)
    expect(result.content).toContain('uri is required')
  })

  it('returns error on failure', async () => {
    const client = mockClient()
    ;(client.readResource as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('not found'))

    const tool = createReadResourceTool('my-server', client)
    const result = await (tool.execute as Function)({ uri: 'file:///nope' }, {})
    expect(result.isError).toBe(true)
    expect(result.content).toContain('not found')
  })
})
