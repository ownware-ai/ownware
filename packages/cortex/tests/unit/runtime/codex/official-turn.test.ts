import { describe, expect, it, vi } from 'vitest'
import {
  CodexOfficialTurnBridge,
  CodexTurnProtocolError,
} from '../../../../src/runtime/codex/official-turn.js'

const THREAD_ID = 'thread-1'
const TURN_ID = 'turn-1'

function notification(method: string, params: Record<string, unknown>) {
  return { method, params }
}

function turn(status: 'inProgress' | 'completed' | 'interrupted' | 'failed') {
  return {
    id: TURN_ID,
    status,
    items: [],
    startedAt: 1_785_067_200,
    completedAt: status === 'inProgress' ? null : 1_785_067_260,
    durationMs: status === 'inProgress' ? null : 60_000,
    error: status === 'failed' ? { message: 'private provider detail' } : null,
  }
}

function bridge(
  overrides: Partial<ConstructorParameters<typeof CodexOfficialTurnBridge>[0]> = {},
) {
  return new CodexOfficialTurnBridge({
    threadId: THREAD_ID,
    turnId: TURN_ID,
    turnIndex: 0,
    model: 'gpt-5.4',
    now: () => Date.parse('2026-07-26T19:30:00.000Z'),
    ...overrides,
  })
}

describe('Codex official turn event authority', () => {
  it('streams in order and closes only on one matching turn/completed', () => {
    const subject = bridge()

    expect(subject.observe(notification('turn/started', {
      threadId: THREAD_ID,
      turn: turn('inProgress'),
    })).events.map(({ event }) => event)).toEqual([
      {
        type: 'session.start',
        sessionId: THREAD_ID,
        model: 'gpt-5.4',
        timestamp: 1_785_067_200_000,
      },
      {
        type: 'turn.start',
        turnIndex: 0,
        timestamp: 1_785_067_200_000,
      },
    ])

    expect(subject.observe(notification('item/started', {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      startedAtMs: 1_785_067_201_000,
      item: { id: 'message-1', type: 'agentMessage', text: '' },
    })).events).toEqual([])

    expect(subject.observe(notification('item/agentMessage/delta', {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      itemId: 'message-1',
      delta: 'Hello',
    })).events[0]?.event).toEqual({
      type: 'text.delta',
      text: 'Hello',
      turnIndex: 0,
    })

    expect(subject.observe(notification('item/completed', {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      completedAtMs: 1_785_067_202_000,
      item: { id: 'message-1', type: 'agentMessage', text: 'Hello' },
    })).events[0]?.event).toEqual({
      type: 'text.complete',
      text: 'Hello',
      turnIndex: 0,
    })

    expect(subject.observe(notification('thread/tokenUsage/updated', {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      tokenUsage: {
        last: {
          inputTokens: 12,
          cachedInputTokens: 3,
          cacheWriteInputTokens: 2,
          outputTokens: 5,
          reasoningOutputTokens: 1,
          totalTokens: 17,
        },
        total: {
          inputTokens: 12,
          cachedInputTokens: 3,
          cacheWriteInputTokens: 2,
          outputTokens: 5,
          reasoningOutputTokens: 1,
          totalTokens: 17,
        },
        modelContextWindow: 100_000,
      },
    })).events).toEqual([])

    const terminal = subject.observe(notification('turn/completed', {
      threadId: THREAD_ID,
      turn: turn('completed'),
    }))
    expect(terminal.events.map(({ event }) => event)).toEqual([
      {
        type: 'turn.end',
        turnIndex: 0,
        stopReason: 'end_turn',
        usage: {
          inputTokens: 12,
          outputTokens: 5,
          cacheReadTokens: 3,
          cacheCreationTokens: 2,
          model: 'gpt-5.4',
          costUsd: 0,
          costBasis: 'subscription_allowance',
        },
        timestamp: 1_785_067_260_000,
      },
      {
        type: 'session.end',
        sessionId: THREAD_ID,
        reason: 'end_turn',
        totalUsage: {
          inputTokens: 12,
          outputTokens: 5,
          cacheReadTokens: 3,
          cacheCreationTokens: 2,
          model: 'gpt-5.4',
          costUsd: 0,
          costBasis: 'subscription_allowance',
        },
        turnCount: 1,
        timestamp: 1_785_067_260_000,
      },
    ])
    expect(terminal.completion).toEqual({
      outcome: 'succeeded',
      authority: 'turn/completed',
    })
    expect(terminal.terminal).toEqual({
      id: TURN_ID,
      status: 'completed',
      completedAt: '2026-07-26T12:01:00.000Z',
      authority: 'turn/completed',
    })

    expect(subject.observe(notification('turn/completed', {
      threadId: THREAD_ID,
      turn: turn('completed'),
    }))).toEqual({ events: [] })
    expect(() => subject.observe(notification('turn/completed', {
      threadId: THREAD_ID,
      turn: { ...turn('failed'), completedAt: 1_785_067_261 },
    }))).toThrowError(expect.objectContaining({ code: 'terminal_conflict' }))
  })

  it('reports retry errors without exposing provider text or ending the turn', () => {
    const subject = bridge()
    subject.observe(notification('turn/started', {
      threadId: THREAD_ID,
      turn: turn('inProgress'),
    }))

    const observed = subject.observe(notification('error', {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      willRetry: true,
      error: {
        message: 'private prompt and account detail',
        additionalDetails: 'private',
      },
    }))

    expect(observed.events[0]?.event).toEqual({
      type: 'error',
      code: 'codex_turn_retrying',
      message: 'Codex reported a recoverable turn error and will retry.',
      recoverable: true,
      turnIndex: 0,
    })
    expect(JSON.stringify(observed)).not.toContain('private')
    expect(observed).not.toHaveProperty('completion')
  })

  it('maps an interrupted terminal separately from failure', () => {
    const subject = bridge()
    subject.observe(notification('turn/started', {
      threadId: THREAD_ID,
      turn: turn('inProgress'),
    }))
    const observed = subject.observe(notification('turn/completed', {
      threadId: THREAD_ID,
      turn: turn('interrupted'),
    }))

    expect(observed.events[0]?.event).toMatchObject({
      type: 'turn.end',
      stopReason: 'aborted',
    })
    expect(observed.completion).toEqual({
      outcome: 'cancelled',
      authority: 'turn/completed',
      reason: 'system',
    })
  })

  it('requires started items, exact scope, and no open item at terminal', () => {
    const subject = bridge()
    subject.observe(notification('turn/started', {
      threadId: THREAD_ID,
      turn: turn('inProgress'),
    }))

    expect(() => subject.observe(notification('item/agentMessage/delta', {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      itemId: 'not-started',
      delta: 'unsafe',
    }))).toThrowError(expect.objectContaining({ code: 'item_not_started' }))
    expect(() => subject.observe(notification('item/started', {
      threadId: 'another-thread',
      turnId: TURN_ID,
      startedAtMs: 1,
      item: { id: 'x', type: 'agentMessage', text: '' },
    }))).toThrowError(expect.objectContaining({ code: 'scope_mismatch' }))

    subject.observe(notification('item/started', {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      startedAtMs: 1,
      item: {
        id: 'command-1',
        type: 'commandExecution',
        command: 'touch result',
        commandActions: [],
        cwd: '/tmp/workspace',
        status: 'inProgress',
      },
    }))
    expect(() => subject.observe(notification('turn/completed', {
      threadId: THREAD_ID,
      turn: turn('completed'),
    }))).toThrowError(expect.objectContaining({
      code: 'open_item_at_terminal',
    }))
  })

  it('correlates MCP item completion only through the run-handle authority', () => {
    const confirmAppServerDelivery = vi.fn(() => ({
      status: 'confirmed' as const,
      consequence: 'effect_confirmed' as const,
      receiptState: 'completed' as const,
    }))
    const subject = bridge({
      mcpRun: {
        confirmAppServerDelivery,
      },
    })
    subject.observe(notification('turn/started', {
      threadId: THREAD_ID,
      turn: turn('inProgress'),
    }))
    const item = {
      id: 'mcp-1',
      type: 'mcpToolCall',
      server: 'ownware_run',
      tool: 'approved_write',
      arguments: { value: 'x' },
      status: 'inProgress',
      result: null,
      error: null,
    }
    expect(subject.observe(notification('item/started', {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      startedAtMs: 1_785_067_201_000,
      item,
    })).events[0]).toMatchObject({
      event: {
        type: 'tool.call.start',
        toolCallId: 'mcp-1',
        toolName: 'approved_write',
      },
    })

    const completed = subject.observe(notification('item/completed', {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      completedAtMs: 1_785_067_202_000,
      item: {
        ...item,
        status: 'completed',
        durationMs: 1_000,
        result: { content: [{ type: 'text', text: 'saved' }] },
      },
    }))
    expect(confirmAppServerDelivery).toHaveBeenCalledWith({
      toolName: 'approved_write',
      input: { value: 'x' },
      status: 'completed',
      authority: 'item/completed',
    })
    expect(completed.events[0]).toMatchObject({
      consequence: 'effect_confirmed',
      event: {
        type: 'tool.call.end',
        result: 'saved',
        isError: false,
      },
    })
  })

  it('surfaces disabled or future native items as unknown without payload data', () => {
    const subject = bridge()
    subject.observe(notification('turn/started', {
      threadId: THREAD_ID,
      turn: turn('inProgress'),
    }))
    const observed = subject.observe(notification('item/started', {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      startedAtMs: 1,
      item: {
        id: 'search-1',
        type: 'webSearch',
        query: 'private customer question',
      },
    }))

    expect(observed).toEqual({
      events: [],
      unknownSourceType: 'item/started:webSearch',
    })
    expect(JSON.stringify(observed)).not.toContain('private customer')
  })
})

describe('CodexTurnProtocolError', () => {
  it('does not retain malformed provider data', () => {
    const error = new CodexTurnProtocolError('invalid_notification')
    expect(error.message).toBe('Codex turn protocol failed (invalid_notification).')
    expect(error).not.toHaveProperty('payload')
  })
})
