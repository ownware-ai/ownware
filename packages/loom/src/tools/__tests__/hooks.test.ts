import { describe, it, expect, vi } from 'vitest'
import { ToolHookRegistry } from '../hooks.js'
import type { ToolContext } from '../types.js'
import type { LoomConfig } from '../../core/config.js'

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

describe('ToolHookRegistry', () => {
  describe('before hooks', () => {
    it('returns unblocked when no hooks registered', async () => {
      const registry = new ToolHookRegistry()
      const result = await registry.runBeforeHooks('readFile', {}, createMockContext())

      expect(result.blocked).toBe(false)
      expect(result.modifiedInput).toBeUndefined()
    })

    it('runs global hooks for all tools', async () => {
      const registry = new ToolHookRegistry()
      const hook = vi.fn().mockResolvedValue({ blocked: false })
      registry.registerBefore('*', hook)

      await registry.runBeforeHooks('readFile', { path: '/foo' }, createMockContext())
      await registry.runBeforeHooks('writeFile', { path: '/bar' }, createMockContext())

      expect(hook).toHaveBeenCalledTimes(2)
    })

    it('runs tool-specific hooks only for matching tools', async () => {
      const registry = new ToolHookRegistry()
      const hook = vi.fn().mockResolvedValue({ blocked: false })
      registry.registerBefore('readFile', hook)

      await registry.runBeforeHooks('readFile', {}, createMockContext())
      await registry.runBeforeHooks('writeFile', {}, createMockContext())

      expect(hook).toHaveBeenCalledTimes(1)
    })

    it('blocks when a hook returns blocked: true', async () => {
      const registry = new ToolHookRegistry()
      registry.registerBefore('*', async () => ({
        blocked: true,
        reason: 'Nope',
      }))

      const result = await registry.runBeforeHooks('anything', {}, createMockContext())

      expect(result.blocked).toBe(true)
      expect(result.reason).toBe('Nope')
    })

    it('stops processing hooks after a block', async () => {
      const registry = new ToolHookRegistry()
      const secondHook = vi.fn().mockResolvedValue({ blocked: false })

      registry.registerBefore('*', async () => ({ blocked: true, reason: 'first' }))
      registry.registerBefore('*', secondHook)

      await registry.runBeforeHooks('tool', {}, createMockContext())

      expect(secondHook).not.toHaveBeenCalled()
    })

    it('chains input modifications across hooks', async () => {
      const registry = new ToolHookRegistry()
      registry.registerBefore('*', async (_name, input) => ({
        blocked: false,
        modifiedInput: { ...input, added: 'by-global' },
      }))
      registry.registerBefore('test', async (_name, input) => ({
        blocked: false,
        modifiedInput: { ...input, also: 'by-specific' },
      }))

      const result = await registry.runBeforeHooks(
        'test',
        { original: true },
        createMockContext(),
      )

      expect(result.blocked).toBe(false)
      expect(result.modifiedInput).toEqual({
        original: true,
        added: 'by-global',
        also: 'by-specific',
      })
    })

    it('runs global hooks before tool-specific hooks', async () => {
      const registry = new ToolHookRegistry()
      const order: string[] = []

      registry.registerBefore('test', async () => {
        order.push('specific')
        return { blocked: false }
      })
      registry.registerBefore('*', async () => {
        order.push('global')
        return { blocked: false }
      })

      await registry.runBeforeHooks('test', {}, createMockContext())

      expect(order).toEqual(['global', 'specific'])
    })
  })

  describe('after hooks', () => {
    it('returns original result when no hooks', async () => {
      const registry = new ToolHookRegistry()
      const result = await registry.runAfterHooks(
        'test',
        {},
        { content: 'original', isError: false },
        createMockContext(),
      )

      expect(result.content).toBe('original')
    })

    it('chains result modifications', async () => {
      const registry = new ToolHookRegistry()
      registry.registerAfter('*', async (_name, _input, result) => ({
        ...result,
        content: result.content + ' +global',
      }))
      registry.registerAfter('test', async (_name, _input, result) => ({
        ...result,
        content: result.content + ' +specific',
      }))

      const result = await registry.runAfterHooks(
        'test',
        {},
        { content: 'base', isError: false },
        createMockContext(),
      )

      expect(result.content).toBe('base +global +specific')
    })
  })

  describe('hook removal', () => {
    it('removes a hook by id', async () => {
      const registry = new ToolHookRegistry()
      const hook = vi.fn().mockResolvedValue({ blocked: false })
      registry.registerBefore('*', hook, 'my-hook')

      expect(registry.remove('my-hook')).toBe(true)

      await registry.runBeforeHooks('test', {}, createMockContext())
      expect(hook).not.toHaveBeenCalled()
    })

    it('returns false for non-existent hook', () => {
      const registry = new ToolHookRegistry()
      expect(registry.remove('nonexistent')).toBe(false)
    })

    it('removes after hooks by id', async () => {
      const registry = new ToolHookRegistry()
      const hook = vi.fn().mockImplementation(async (_n, _i, r) => r)
      registry.registerAfter('test', hook, 'after-1')

      registry.remove('after-1')

      await registry.runAfterHooks(
        'test',
        {},
        { content: 'x', isError: false },
        createMockContext(),
      )
      expect(hook).not.toHaveBeenCalled()
    })
  })
})
