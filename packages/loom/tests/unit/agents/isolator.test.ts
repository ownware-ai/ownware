import { describe, it, expect } from 'vitest'
import { isolateTools, isolateMessages, isolateConfig } from '../../../src/agents/isolator.js'
import { createDefaultConfig } from '../../../src/core/config.js'
import type { Tool } from '../../../src/tools/types.js'
import type { Message } from '../../../src/messages/types.js'

// Minimal tool factory
function makeTool(name: string): Tool {
  return {
    name,
    description: `Tool ${name}`,
    inputSchema: { type: 'object', properties: {} },
    execute: async () => ({ content: 'ok', isError: false }),
  }
}

describe('isolateTools', () => {
  const tools = [makeTool('shell'), makeTool('filesystem.read'), makeTool('browser')]

  it('returns all tools when no filter', () => {
    const isolated = isolateTools(tools)
    expect(isolated).toHaveLength(3)
  })

  it('returns a new array (not same reference)', () => {
    const isolated = isolateTools(tools)
    expect(isolated).not.toBe(tools)
  })

  it('filters by allowed names', () => {
    const isolated = isolateTools(tools, ['shell', 'browser'])
    expect(isolated).toHaveLength(2)
    expect(isolated.map(t => t.name)).toEqual(['shell', 'browser'])
  })

  it('filters with null returns all', () => {
    const isolated = isolateTools(tools, null)
    expect(isolated).toHaveLength(3)
  })

  it('handles empty allowed list', () => {
    const isolated = isolateTools(tools, [])
    expect(isolated).toHaveLength(0)
  })

  it('ignores unknown names in filter', () => {
    const isolated = isolateTools(tools, ['shell', 'nonexistent'])
    expect(isolated).toHaveLength(1)
    expect(isolated[0]!.name).toBe('shell')
  })
})

describe('isolateMessages', () => {
  it('returns empty array for empty input', () => {
    expect(isolateMessages([])).toEqual([])
  })

  it('deep copies text messages', () => {
    const original: Message[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    ]
    const copy = isolateMessages(original)

    expect(copy).toEqual(original)
    expect(copy).not.toBe(original)
    expect(copy[0]).not.toBe(original[0])
  })

  it('deep copies tool_use blocks — mutation is independent', () => {
    const original: Message[] = [
      {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'call_1',
          name: 'shell',
          input: { command: 'ls', nested: { a: 1 } },
        }],
      },
    ]
    const copy = isolateMessages(original)

    // Mutate copy's nested input
    const copyBlock = (copy[0] as { content: Array<{ input: Record<string, unknown> }> }).content[0]!
    ;(copyBlock.input.nested as Record<string, unknown>).a = 999

    // Original should be unaffected
    const origBlock = (original[0] as { content: Array<{ input: Record<string, unknown> }> }).content[0]!
    expect((origBlock.input.nested as Record<string, unknown>).a).toBe(1)
  })

  it('deep copies tool_result blocks', () => {
    const original: Message[] = [
      {
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: 'call_1', content: 'result', isError: false }],
      },
    ]
    const copy = isolateMessages(original)
    expect(copy).toEqual(original)
    expect(copy[0]).not.toBe(original[0])
  })

  it('deep copies image blocks', () => {
    const original: Message[] = [
      {
        role: 'user',
        content: [{
          type: 'image',
          source: { type: 'base64', mediaType: 'image/png', data: 'abc123' },
        }],
      },
    ]
    const copy = isolateMessages(original)
    expect(copy).toEqual(original)
    expect(copy[0]).not.toBe(original[0])
  })

  it('deep copies system messages', () => {
    const original: Message[] = [{ role: 'system', content: 'Be helpful' }]
    const copy = isolateMessages(original)
    expect(copy).toEqual(original)
    expect(copy[0]).not.toBe(original[0])
  })

  it('deep copies thinking blocks', () => {
    const original: Message[] = [
      {
        role: 'assistant',
        content: [{ type: 'thinking', text: 'Let me think...' }],
      },
    ]
    const copy = isolateMessages(original)
    expect(copy).toEqual(original)
  })
})

describe('isolateConfig', () => {
  it('returns a new config with overrides', () => {
    const base = createDefaultConfig('anthropic:claude-sonnet-4-20250514')
    const isolated = isolateConfig(base, { agentId: 'child_1', maxTurns: 5 })

    expect(isolated.agentId).toBe('child_1')
    expect(isolated.maxTurns).toBe(5)
    // Base should be unchanged
    expect(base.agentId).toBeNull()
    expect(base.maxTurns).toBe(100)
  })

  it('preserves base config values when not overridden', () => {
    const base = createDefaultConfig('anthropic:claude-sonnet-4-20250514')
    const isolated = isolateConfig(base, { agentId: 'child_1' })

    expect(isolated.model).toBe(base.model)
    expect(isolated.maxTokens).toBe(base.maxTokens)
    expect(isolated.temperature).toBe(base.temperature)
  })

  it('merges nested retry config', () => {
    const base = createDefaultConfig('test')
    const isolated = isolateConfig(base, {
      retry: { ...base.retry, maxRetries: 10 },
    })
    expect(isolated.retry.maxRetries).toBe(10)
    expect(isolated.retry.baseDelayMs).toBe(base.retry.baseDelayMs)
  })
})
