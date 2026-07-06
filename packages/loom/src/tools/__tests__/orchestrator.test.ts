import { describe, it, expect, vi } from 'vitest'
import { partitionToolCalls, executeOrchestrated } from '../orchestrator.js'
import { defineTool } from '../types.js'
import type { Tool, ToolContext } from '../types.js'
import type { ToolUseBlock } from '../../messages/types.js'
import type { LoomConfig } from '../../core/config.js'

function makeToolUse(name: string, input: Record<string, unknown> = {}): ToolUseBlock {
  return { type: 'tool_use', id: `id-${name}-${Math.random()}`, name, input }
}

function createMockContext(): ToolContext {
  return {
    cwd: '/tmp',
    signal: new AbortController().signal,
    sessionId: 'test',
    agentId: null,
    workspacePath: '/tmp',
    config: {} as LoomConfig,
    requestPermission: vi.fn().mockResolvedValue(true),
  }
}

const readTool = defineTool({
  name: 'read',
  description: 'Read-only',
  isReadOnly: true,
  inputSchema: { type: 'object', properties: {} },
  async execute() {
    return { content: 'read-result', isError: false }
  },
})

const writeTool = defineTool({
  name: 'write',
  description: 'Write tool',
  isReadOnly: false,
  inputSchema: { type: 'object', properties: {} },
  async execute() {
    return { content: 'write-result', isError: false }
  },
})

const toolMap = new Map<string, Tool>([
  ['read', readTool],
  ['write', writeTool],
])

describe('partitionToolCalls', () => {
  it('separates read-only and write tools', () => {
    const calls = [makeToolUse('read'), makeToolUse('write'), makeToolUse('read')]
    const result = partitionToolCalls(calls, toolMap)

    expect(result.readOnly).toHaveLength(2)
    expect(result.write).toHaveLength(1)
    expect(result.unknown).toHaveLength(0)
  })

  it('puts unknown tools in unknown bucket', () => {
    const calls = [makeToolUse('nonexistent')]
    const result = partitionToolCalls(calls, toolMap)

    expect(result.unknown).toHaveLength(1)
    expect(result.readOnly).toHaveLength(0)
    expect(result.write).toHaveLength(0)
  })
})

describe('executeOrchestrated', () => {
  it('executes all tools and returns results', async () => {
    const calls = [makeToolUse('read'), makeToolUse('write')]
    const results = await executeOrchestrated(calls, toolMap, createMockContext(), 10)

    expect(results).toHaveLength(2)
    const contents = results.map((r) => r.result.content)
    expect(contents).toContain('read-result')
    expect(contents).toContain('write-result')
  })

  it('returns error for unknown tools', async () => {
    const calls = [makeToolUse('missing')]
    const results = await executeOrchestrated(calls, toolMap, createMockContext(), 10)

    expect(results).toHaveLength(1)
    expect(results[0]!.result.isError).toBe(true)
    expect(results[0]!.result.content).toContain('Unknown tool')
  })

  it('handles tool execution errors', async () => {
    const errorTool = defineTool({
      name: 'error',
      description: 'Throws',
      isReadOnly: true,
      inputSchema: { type: 'object', properties: {} },
      async execute() {
        throw new Error('boom')
      },
    })
    const map = new Map([['error', errorTool as Tool]])
    const calls = [makeToolUse('error')]

    const results = await executeOrchestrated(calls, map, createMockContext(), 10)

    expect(results[0]!.result.isError).toBe(true)
    expect(results[0]!.result.content).toContain('boom')
  })
})
