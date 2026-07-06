import { describe, it, expect } from 'vitest'
import { createStubTool } from '../../../src/connector/stub-tool.js'
import { ConnectorNotReadyErrorSchema } from '../../../src/connector/schema.js'
import type { ToolContext, ToolResult } from '@ownware/loom'

function fakeContext(): ToolContext {
  return {
    cwd: process.cwd(),
    signal: new AbortController().signal,
    sessionId: 'test',
    agentId: null,
    workspacePath: process.cwd(),
    config: {} as ToolContext['config'],
    requestPermission: async () => true,
  }
}

describe('createStubTool', () => {
  it('returns a Tool with the requested name and schema', () => {
    const schema = { type: 'object' as const, properties: { q: { type: 'string' as const } } }
    const tool = createStubTool({
      toolName: 'notion_search',
      description: 'Search Notion',
      inputSchema: schema,
      connectorId: 'notion',
      connectorName: 'Notion',
      source: 'mcp',
      authMode: { mode: 'oauth', provider: 'Notion', hasPreset: true },
      reason: 'Not authenticated',
    })
    expect(tool.name).toBe('notion_search')
    expect(tool.isReadOnly).toBe(true)
    expect(tool.requiresPermission).toBe(false)
    expect(tool.inputSchema).toEqual(schema)
    expect(tool.description).toContain('[NOT CONNECTED]')
    expect(tool.description).toContain('Search Notion')
  })

  it('falls back to a permissive schema when none is supplied', () => {
    const tool = createStubTool({
      toolName: 'unknown_tool',
      connectorId: 'c',
      connectorName: 'C',
      source: 'mcp',
      authMode: { mode: 'none' },
      reason: 'server not started',
    })
    expect(tool.inputSchema).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: true,
    })
  })

  it('execute() yields a ToolResult with ConnectorNotReadyError metadata', async () => {
    const tool = createStubTool({
      toolName: 't',
      connectorId: 'weather',
      connectorName: 'Weather',
      source: 'mcp',
      authMode: {
        mode: 'api_key',
        envVars: [{ name: 'WEATHER_API_KEY', description: 'k', isRequired: true, isSecret: true }],
      },
      reason: 'Credentials not configured',
    })
    const result = await (tool.execute({}, fakeContext()) as Promise<ToolResult>)
    expect(result.isError).toBe(true)
    expect(result.metadata).toBeDefined()
    const parsed = ConnectorNotReadyErrorSchema.parse(result.metadata)
    expect(parsed.kind).toBe('connector_not_ready')
    expect(parsed.connectorId).toBe('weather')
    expect(parsed.connectorName).toBe('Weather')
    expect(parsed.source).toBe('mcp')
    expect(parsed.reason).toBe('Credentials not configured')
    if (parsed.authMode.mode !== 'api_key') throw new Error('wrong mode')
    expect(parsed.authMode.envVars[0]!.name).toBe('WEATHER_API_KEY')
  })
})
