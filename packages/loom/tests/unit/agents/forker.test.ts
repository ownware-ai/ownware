import { describe, it, expect } from 'vitest'
import { forkSession, getChildAdditions, getChildOutput } from '../../../src/agents/forker.js'
import { createDefaultConfig } from '../../../src/core/config.js'
import { createMockProvider } from '../../helpers/mock-provider.js'
import { userMsg, assistantMsg } from '../../helpers/fixtures.js'
import type { Message } from '../../../src/messages/types.js'
import type { Tool } from '../../../src/tools/types.js'

function makeTool(name: string): Tool {
  return {
    name,
    description: `Tool ${name}`,
    inputSchema: { type: 'object', properties: {} },
    execute: async () => ({ content: 'ok', isError: false }),
  }
}

describe('forkSession', () => {
  const parentMessages: Message[] = [
    userMsg('Turn 1'),
    assistantMsg('Response 1'),
    userMsg('Turn 2'),
    assistantMsg('Response 2'),
  ]

  const parentSession = {
    sessionId: 'parent-session',
    getMessages: () => parentMessages,
  }

  const provider = createMockProvider()
  const tools = [makeTool('shell'), makeTool('browser')]
  const config = createDefaultConfig('anthropic:claude-sonnet-4-20250514')

  it('creates a child session with copied messages', () => {
    const { session, forkPoint } = forkSession(
      parentSession,
      { name: 'child' },
      provider,
      tools,
      config,
    )

    expect(session).toBeDefined()
    expect(session.messageCount).toBe(parentMessages.length)
    expect(forkPoint.messageCount).toBe(parentMessages.length)
  })

  it('child messages are independent of parent', () => {
    const { session } = forkSession(
      parentSession,
      { name: 'child' },
      provider,
      tools,
      config,
    )

    // Parent messages should be unchanged
    expect(parentMessages).toHaveLength(4)
    expect(session.messageCount).toBe(4)
  })

  it('fork point tracks parent session ID', () => {
    const { forkPoint } = forkSession(
      parentSession,
      { name: 'child' },
      provider,
      tools,
      config,
    )

    expect(forkPoint.parentSessionId).toBe('parent-session')
    expect(forkPoint.childSessionId).toBeTruthy()
    expect(forkPoint.childSessionId).not.toBe('parent-session')
    expect(forkPoint.timestamp).toBeGreaterThan(0)
  })

  it('filters tools based on spec', () => {
    const { session } = forkSession(
      parentSession,
      { name: 'child', tools: ['shell'] },
      provider,
      tools,
      config,
    )

    // Session was created (tools filtering happens in isolateTools)
    expect(session).toBeDefined()
  })

  it('applies model override from spec', () => {
    const { forkPoint } = forkSession(
      parentSession,
      { name: 'child', model: 'openai:gpt-4o' },
      provider,
      tools,
      config,
    )

    expect(forkPoint.childSessionId).toBeTruthy()
  })
})

describe('getChildAdditions', () => {
  it('returns messages added after fork point', () => {
    const allMessages: Message[] = [
      userMsg('Before fork 1'),
      assistantMsg('Before fork 2'),
      userMsg('After fork 1'),
      assistantMsg('After fork 2'),
    ]

    const forkPoint = {
      parentSessionId: 'parent',
      childSessionId: 'child',
      messageCount: 2,
      turnIndex: 1,
      timestamp: Date.now(),
    }

    const additions = getChildAdditions(
      { getMessages: () => allMessages },
      forkPoint,
    )

    expect(additions).toHaveLength(2)
    expect((additions[0] as { content: string }).content).toBe('After fork 1')
  })

  it('returns empty when no additions', () => {
    const allMessages: Message[] = [
      userMsg('Original'),
      assistantMsg('Original reply'),
    ]

    const forkPoint = {
      parentSessionId: 'parent',
      childSessionId: 'child',
      messageCount: 2,
      turnIndex: 1,
      timestamp: Date.now(),
    }

    const additions = getChildAdditions(
      { getMessages: () => allMessages },
      forkPoint,
    )
    expect(additions).toHaveLength(0)
  })
})

describe('getChildOutput', () => {
  it('extracts text from assistant messages after fork', () => {
    const allMessages: Message[] = [
      userMsg('Before'),
      assistantMsg('Before reply'),
      userMsg('After query'),
      assistantMsg('Child generated this text'),
      userMsg('Another after'),
      assistantMsg('And this too'),
    ]

    const forkPoint = {
      parentSessionId: 'parent',
      childSessionId: 'child',
      messageCount: 2,
      turnIndex: 1,
      timestamp: Date.now(),
    }

    const output = getChildOutput(
      { getMessages: () => allMessages },
      forkPoint,
    )

    expect(output).toContain('Child generated this text')
    expect(output).toContain('And this too')
  })

  it('returns empty string when no assistant messages after fork', () => {
    const allMessages: Message[] = [
      userMsg('Before'),
      assistantMsg('Before reply'),
      userMsg('Only user after fork'),
    ]

    const forkPoint = {
      parentSessionId: 'parent',
      childSessionId: 'child',
      messageCount: 2,
      turnIndex: 1,
      timestamp: Date.now(),
    }

    const output = getChildOutput(
      { getMessages: () => allMessages },
      forkPoint,
    )
    expect(output).toBe('')
  })
})
