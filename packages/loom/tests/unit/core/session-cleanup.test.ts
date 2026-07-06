/**
 * Unit Tests — Session cleanup()
 *
 * Verifies that Session.cleanup() properly clears internal state
 * including messages, usage counters, and permission store.
 */

import { describe, it, expect, vi } from 'vitest'
import { Session } from '../../../src/core/session.js'
import { createDefaultConfig } from '../../../src/core/config.js'
import type { ProviderAdapter } from '../../../src/provider/types.js'
import { SessionPermissionStore } from '../../../src/permissions/session-store.js'

function makeProvider(): ProviderAdapter {
  return {
    name: 'mock',
    stream: vi.fn() as unknown as ProviderAdapter['stream'],
    countTokens: vi.fn().mockResolvedValue(100),
    supportsFeature: vi.fn().mockReturnValue(false),
    formatTools: vi.fn().mockReturnValue([]),
  }
}

describe('Session.cleanup()', () => {
  it('clears messages', () => {
    const session = new Session({
      config: createDefaultConfig('test:model'),
      provider: makeProvider(),
      tools: [],
      initialMessages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] },
      ],
    })

    expect(session.messageCount).toBe(2)
    session.cleanup()
    expect(session.messageCount).toBe(0)
  })

  it('resets usage counters', () => {
    const session = new Session({
      config: createDefaultConfig('test:model'),
      provider: makeProvider(),
      tools: [],
    })

    // Access state to verify it's clean after cleanup
    session.cleanup()
    const state = session.getState()
    expect(state.turnCount).toBe(0)
    expect(state.totalUsage.inputTokens).toBe(0)
    expect(state.totalUsage.outputTokens).toBe(0)
    expect(state.totalUsage.cacheReadTokens).toBe(0)
    expect(state.totalUsage.cacheCreationTokens).toBe(0)
  })

  it('clears permissions', () => {
    const permissionStore = new SessionPermissionStore()
    const session = new Session({
      config: createDefaultConfig('test:model'),
      provider: makeProvider(),
      tools: [],
      permissionStore,
    })

    session.setPermission('read_file', 'allow')
    expect(session.getPermission('read_file')).toBe('allow')

    session.cleanup()
    expect(session.getPermission('read_file')).toBeNull()
  })

  it('returns empty messages after cleanup', () => {
    const session = new Session({
      config: createDefaultConfig('test:model'),
      provider: makeProvider(),
      tools: [],
      initialMessages: [{ role: 'user', content: 'test' }],
    })

    session.cleanup()
    expect(session.getMessages()).toEqual([])
  })
})
