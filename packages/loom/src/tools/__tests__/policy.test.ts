import { describe, it, expect } from 'vitest'
import { ToolPolicy } from '../policy.js'
import { defineTool } from '../types.js'
import type { Tool } from '../types.js'

function makeTool(
  name: string,
  category?: 'filesystem' | 'shell' | 'browser' | 'search' | 'agent' | 'memory' | 'custom' | 'mcp',
): Tool {
  return defineTool({
    name,
    description: `Test tool: ${name}`,
    category: category ?? 'custom',
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      return { content: 'ok', isError: false }
    },
  })
}

describe('ToolPolicy', () => {
  describe('default behavior', () => {
    it('allows everything by default', () => {
      const policy = new ToolPolicy()
      expect(policy.isAllowed('anything')).toBe(true)
    })

    it('respects defaultAction: deny', () => {
      const policy = new ToolPolicy({ defaultAction: 'deny' })
      expect(policy.isAllowed('anything')).toBe(false)
    })
  })

  describe('exact name matching', () => {
    it('denies specific tool names', () => {
      const policy = new ToolPolicy({
        rules: [{ pattern: 'shell.execute', action: 'deny' }],
      })
      expect(policy.isAllowed('shell.execute')).toBe(false)
      expect(policy.isAllowed('readFile')).toBe(true)
    })

    it('allows specific tool names in deny-default mode', () => {
      const policy = new ToolPolicy({
        defaultAction: 'deny',
        rules: [{ pattern: 'readFile', action: 'allow' }],
      })
      expect(policy.isAllowed('readFile')).toBe(true)
      expect(policy.isAllowed('writeFile')).toBe(false)
    })
  })

  describe('wildcard patterns', () => {
    it('matches prefix wildcards: filesystem.*', () => {
      const policy = new ToolPolicy({
        rules: [{ pattern: 'filesystem.*', action: 'deny' }],
      })
      expect(policy.isAllowed('filesystem.readFile')).toBe(false)
      expect(policy.isAllowed('filesystem.writeFile')).toBe(false)
      expect(policy.isAllowed('shell.execute')).toBe(true)
    })

    it('matches * (everything)', () => {
      const policy = new ToolPolicy({
        defaultAction: 'deny',
        rules: [{ pattern: '*', action: 'allow' }],
      })
      expect(policy.isAllowed('anything')).toBe(true)
    })

    it('matches suffix wildcards: *.read*', () => {
      const policy = new ToolPolicy({
        rules: [{ pattern: '*.read*', action: 'deny' }],
      })
      expect(policy.isAllowed('filesystem.readFile')).toBe(false)
      expect(policy.isAllowed('filesystem.writeFile')).toBe(true)
    })
  })

  describe('deny takes precedence', () => {
    it('denies even when an allow rule also matches', () => {
      const policy = new ToolPolicy({
        rules: [
          { pattern: 'shell.*', action: 'allow' },
          { pattern: 'shell.execute', action: 'deny' },
        ],
      })
      expect(policy.isAllowed('shell.execute')).toBe(false)
      expect(policy.isAllowed('shell.list')).toBe(true)
    })
  })

  describe('category rules', () => {
    it('denies by category', () => {
      const policy = new ToolPolicy({
        categoryRules: [{ category: 'shell', action: 'deny' }],
      })
      expect(policy.isAllowed('anything', 'shell')).toBe(false)
      expect(policy.isAllowed('anything', 'filesystem')).toBe(true)
    })

    it('allows by category in deny-default mode', () => {
      const policy = new ToolPolicy({
        defaultAction: 'deny',
        categoryRules: [{ category: 'filesystem', action: 'allow' }],
      })
      expect(policy.isAllowed('readFile', 'filesystem')).toBe(true)
      expect(policy.isAllowed('exec', 'shell')).toBe(false)
    })

    it('category deny takes precedence over category allow', () => {
      const policy = new ToolPolicy({
        categoryRules: [
          { category: 'shell', action: 'allow' },
          { category: 'shell', action: 'deny' },
        ],
      })
      expect(policy.isAllowed('exec', 'shell')).toBe(false)
    })
  })

  describe('isToolAllowed', () => {
    it('checks tool name and category together', () => {
      const policy = new ToolPolicy({
        categoryRules: [{ category: 'shell', action: 'deny' }],
      })
      const tool = makeTool('shell.exec', 'shell')
      expect(policy.isToolAllowed(tool)).toBe(false)
    })
  })

  describe('filterAllowed', () => {
    it('filters an array of tools', () => {
      const policy = new ToolPolicy({
        categoryRules: [{ category: 'shell', action: 'deny' }],
      })
      const tools = [
        makeTool('read', 'filesystem'),
        makeTool('exec', 'shell'),
        makeTool('glob', 'filesystem'),
      ]

      const allowed = policy.filterAllowed(tools)
      expect(allowed).toHaveLength(2)
      expect(allowed.map((t) => t.name)).toEqual(['read', 'glob'])
    })
  })

  describe('static factories', () => {
    it('allowOnly creates deny-default with allow list', () => {
      const policy = ToolPolicy.allowOnly('readFile', 'glob')
      expect(policy.isAllowed('readFile')).toBe(true)
      expect(policy.isAllowed('glob')).toBe(true)
      expect(policy.isAllowed('writeFile')).toBe(false)
    })

    it('denyOnly creates allow-default with deny list', () => {
      const policy = ToolPolicy.denyOnly('shell.*')
      expect(policy.isAllowed('readFile')).toBe(true)
      expect(policy.isAllowed('shell.execute')).toBe(false)
    })

    it('allowAll permits everything', () => {
      const policy = ToolPolicy.allowAll()
      expect(policy.isAllowed('anything')).toBe(true)
    })
  })
})
