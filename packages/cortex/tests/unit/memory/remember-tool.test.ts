import { describe, it, expect, vi } from 'vitest'
import { createRememberTool } from '../../../src/memory/index.js'
import type { ToolContext } from '@ownware/loom'

function makeContext(): ToolContext {
  return {
    cwd: '/tmp',
    signal: new AbortController().signal,
    sessionId: 'sess_x',
    agentId: null,
    workspacePath: '/tmp',
    additionalWorkspaceRoots: [],
    config: {} as ToolContext['config'],
    requestPermission: async () => false,
    requestCredential: async () => null,
    resolveCredential: () => null,
    listEnvCredentials: () => [],
    listAllCredentialValues: () => [],
  }
}

describe('createRememberTool', () => {
  it('exposes the right wire shape', () => {
    const tool = createRememberTool({
      hook: { propose: () => ({ proposalId: 'prop_x' }) },
    })
    expect(tool.name).toBe('remember')
    expect(tool.category).toBe('memory')
    expect(tool.isReadOnly).toBe(false)
    expect(tool.requiresPermission).toBe(false)
    expect(tool.inputSchema).toMatchObject({
      type: 'object',
      properties: {
        content: { type: 'string' },
        kind: { type: 'string', enum: ['fact', 'preference', 'correction', 'identity'] },
      },
      required: ['content'],
    })
  })

  it('proposes via the hook and returns a non-error result', async () => {
    const propose = vi.fn(() => ({ proposalId: 'prop_42' }))
    const tool = createRememberTool({ hook: { propose } })
    const result = await tool.execute(
      { content: '   User uses Bun   ', kind: 'preference' },
      makeContext(),
    )

    expect(propose).toHaveBeenCalledWith({ content: 'User uses Bun', kind: 'preference' })
    expect(result.isError).toBe(false)
    expect(result.metadata).toEqual({ proposalId: 'prop_42' })
    expect(result.content).toMatch(/Proposed for the user to review/)
    expect(result.content).toMatch(/NOT yet stored/)
  })

  it('fires onProposed after a successful propose', async () => {
    const onProposed = vi.fn()
    const tool = createRememberTool({
      hook: { propose: () => ({ proposalId: 'prop_99' }) },
      onProposed,
    })
    await tool.execute({ content: 'X' }, makeContext())
    expect(onProposed).toHaveBeenCalledWith('prop_99')
  })

  it('returns isError when input is invalid', async () => {
    const tool = createRememberTool({
      hook: { propose: () => ({ proposalId: 'prop_x' }) },
    })
    const result = await tool.execute({ content: '' }, makeContext())
    expect(result.isError).toBe(true)
    expect(result.metadata).toEqual({ reason: 'validation_failed' })
  })

  it('catches hook errors and surfaces them as tool errors', async () => {
    const tool = createRememberTool({
      hook: {
        propose: () => {
          throw new Error('db down')
        },
      },
    })
    const result = await tool.execute({ content: 'X' }, makeContext())
    expect(result.isError).toBe(true)
    expect(result.content).toContain('db down')
  })
})
