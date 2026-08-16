import { describe, it, expect } from 'vitest'
import {
  initialChatState,
  chatReducer,
  applyEvents,
  addUserMessage,
  seedReplayCursor,
  type AgentEvent,
} from '../index.js'

const ev = (type: string, data: Record<string, unknown>, seq: number): AgentEvent => ({ type, seq, data })

describe('chatReducer', () => {
  it('streams a plain text reply into a closed assistant row', () => {
    let s = initialChatState()
    s = chatReducer(s, ev('user.message', { text: 'Hi' }, 1))
    s = chatReducer(s, ev('text.delta', { text: 'Hello ' }, 2))
    s = chatReducer(s, ev('text.delta', { text: 'world' }, 3))
    s = chatReducer(s, ev('turn.end', { stopReason: 'end_turn', usage: { model: 'openai:gpt-5.5' } }, 4))

    expect(s.messages).toHaveLength(2)
    expect(s.messages[0]).toMatchObject({ role: 'user', text: 'Hi' })
    expect(s.messages[1]).toMatchObject({ role: 'assistant', text: 'Hello world', streaming: false })
    expect(s.status).toBe('idle')
    expect(s.model).toBe('openai:gpt-5.5')
    expect(s.lastSeq).toBe(4)
  })

  it('keeps ONE assistant reply across a tool round-trip and captures the tool card', () => {
    const s = applyEvents(initialChatState(), [
      ev('user.message', { text: 'search the web' }, 1),
      ev('tool.call.start', { toolCallId: 't1', toolName: 'web_search', input: { q: 'flowers' } }, 2),
      ev('tool.call.end', { toolCallId: 't1', result: '5 results', isError: false, durationMs: 400 }, 3),
      ev('turn.end', { stopReason: 'tool_use' }, 4), // loop continues
      ev('text.delta', { text: 'Found it.' }, 5),
      ev('turn.end', { stopReason: 'end_turn' }, 6), // terminal
    ])

    expect(s.messages).toHaveLength(2) // user + ONE assistant reply (not two)
    const reply = s.messages[1]!
    expect(reply).toMatchObject({ role: 'assistant', text: 'Found it.', streaming: false })
    expect(reply.toolCalls).toHaveLength(1)
    expect(reply.toolCalls[0]).toMatchObject({
      name: 'web_search',
      input: { q: 'flowers' },
      status: 'done',
      result: '5 results',
      durationMs: 400,
    })
    expect(s.status).toBe('idle')
  })

  it('marks a failed tool call as error', () => {
    const s = applyEvents(initialChatState(), [
      ev('tool.call.start', { toolCallId: 't1', toolName: 'shell_execute', input: {} }, 1),
      ev('tool.call.end', { toolCallId: 't1', result: 'boom', isError: true }, 2),
    ])
    expect(s.messages[0]!.toolCalls[0]).toMatchObject({ status: 'error', isError: true, result: 'boom' })
  })

  it('pauses on a permission request and resumes on the response', () => {
    const operationHash = 'a'.repeat(64)
    let s = applyEvents(initialChatState(), [
      ev('user.message', { text: 'connect slack' }, 1),
      ev('permission.request', {
        requestId: 'r1',
        toolName: 'slack_connect',
        reason: 'read + reply in #support only',
        operationHash,
        intentRevision: 1,
      }, 2),
    ])
    expect(s.status).toBe('awaiting_approval')
    expect(s.pendingApproval).toMatchObject({
      requestId: 'r1',
      toolName: 'slack_connect',
      reason: 'read + reply in #support only',
      operationHash,
      intentRevision: 1,
    })

    s = chatReducer(s, ev('permission.response', { requestId: 'r1', approved: true }, 3))
    expect(s.status).toBe('streaming')
    expect(s.pendingApproval).toBeNull()
  })

  it('closes the open reply and surfaces the message on error', () => {
    const s = applyEvents(initialChatState(), [
      ev('user.message', { text: 'go' }, 1),
      ev('text.delta', { text: 'partial' }, 2),
      ev('error', { message: 'provider overloaded' }, 3),
    ])
    expect(s.status).toBe('error')
    expect(s.error).toBe('provider overloaded')
    expect(s.messages[1]).toMatchObject({ role: 'assistant', text: 'partial', streaming: false })
  })

  it('supports an optimistic user message, then the streamed reply', () => {
    let s = addUserMessage(initialChatState(), 'hello')
    expect(s.messages[0]).toMatchObject({ role: 'user', text: 'hello' })
    expect(s.status).toBe('streaming')

    s = chatReducer(s, ev('text.delta', { text: 'hi there' }, 1))
    s = chatReducer(s, ev('turn.end', { stopReason: 'end_turn' }, 2))
    expect(s.messages).toHaveLength(2)
    expect(s.messages[1]).toMatchObject({ role: 'assistant', text: 'hi there', streaming: false })
  })

  it('is pure — does not mutate the input state', () => {
    const s0 = initialChatState()
    const s1 = applyEvents(s0, [ev('user.message', { text: 'a' }, 1), ev('text.delta', { text: 'b' }, 2)])
    expect(s0.messages).toHaveLength(0) // original untouched
    expect(s1.messages).toHaveLength(2)
    expect(s1.messages[1]).toMatchObject({ role: 'assistant', text: 'b' })
  })

  it('tracks unknown additive observations without replaying lower sequences', () => {
    const s = applyEvents(initialChatState(), [ev('cache.status', {}, 7), ev('something.unknown', {}, 3)])
    expect(s.lastSeq).toBe(7)
    expect(s.messages).toHaveLength(0)
    expect(s.connection.unsupportedEventTypes).toEqual(['cache.status'])
  })

  it('seeds arbitrary replay cursors and refuses to apply a sequence gap', () => {
    let s = seedReplayCursor(initialChatState(), 41)
    s = chatReducer(s, ev('text.delta', { text: 'expected' }, 42))
    const beforeGap = s
    s = chatReducer(s, ev('text.delta', { text: 'must not apply' }, 44))
    expect(s.messages).toEqual(beforeGap.messages)
    expect(s.lastSeq).toBe(42)
    expect(s.connection).toMatchObject({ phase: 'resync_required', expectedNextSeq: 43 })
  })

  it('uses transport envelopes to move from replay to live without consuming a sequence', () => {
    let s = chatReducer(initialChatState(), ev('stream.start', {
      since: 50,
      maxSeqAtStart: 51,
    }, 0))
    expect(s.connection.phase).toBe('replaying')
    expect(s.lastSeq).toBe(50)
    s = chatReducer(s, ev('text.delta', { text: 'replayed' }, 51))
    s = chatReducer(s, ev('stream.replay.complete', {
      since: 50,
      replayedThroughSeq: 51,
      maxSeqAtStart: 51,
      liveTail: true,
    }, 51))
    expect(s.connection).toMatchObject({
      phase: 'live',
      lastDeliveredSeq: 51,
      expectedNextSeq: 52,
    })
  })

  it('keeps concurrent exact approvals independent and ignores malformed responses', () => {
    const hash = 'b'.repeat(64)
    let s = applyEvents(initialChatState(), [
      ev('permission.request', { requestId: 'r1', toolName: 'one', operationHash: hash, intentRevision: 1 }, 1),
      ev('permission.request', { requestId: 'r2', toolName: 'two', operationHash: hash, intentRevision: 1 }, 2),
    ])
    s = chatReducer(s, ev('permission.response', {}, 3))
    expect(s.pendingApprovals.map(item => item.requestId)).toEqual(['r1', 'r2'])
    s = chatReducer(s, ev('permission.response', { requestId: 'r2' }, 4))
    expect(s.pendingApprovals.map(item => item.requestId)).toEqual(['r1'])
    expect(s.status).toBe('awaiting_approval')
  })

  it('retains sensitive metadata only and never stores a supplied value field', () => {
    const canary = 'sensitive-canary-must-not-enter-state'
    let s = chatReducer(initialChatState(), ev('sensitive.input.request', {
      requestId: 's1',
      toolCallId: 't1',
      toolName: 'browser_type',
      label: 'Password',
      usage: 'Enter in the selected password field.',
      agentId: null,
      adapterRevision: 'managed-browser.v1',
      value: canary,
    }, 1))
    expect(s.status).toBe('awaiting_sensitive_input')
    expect(JSON.stringify(s)).not.toContain(canary)
    s = chatReducer(s, ev('sensitive.input.response', { requestId: 's1' }, 2))
    expect(s.pendingSensitiveInputs).toEqual([])
  })

  it('records only structurally valid skill placement evidence', () => {
    const digest = `hmac-sha256:${'a'.repeat(64)}`
    let s = chatReducer(initialChatState(), ev('skill.activation', {
      activationId: '123e4567-e89b-42d3-a456-426614174000',
      toolCallId: 'call-1',
      sourceRef: 'profile-1',
      sourceDigest: digest,
      skillName: 'research',
      skillDigest: digest,
      agentId: null,
      turnIndex: 0,
      timestamp: 100,
    }, 1))
    expect(s.skillActivations).toHaveLength(1)
    s = chatReducer(s, ev('skill.activation', {
      activationId: 'not-an-authoritative-id',
      toolCallId: null,
      sourceRef: 'profile-1',
      sourceDigest: digest,
      skillName: 'research',
      skillDigest: digest,
      agentId: null,
      turnIndex: 0,
      timestamp: 100,
    }, 2))
    expect(s.skillActivations).toHaveLength(1)
    expect(s.connection.unsupportedEventTypes).toContain('skill.activation')
  })

  it('creates an honest partial tool lifecycle when retention omitted the start', () => {
    const s = chatReducer(initialChatState(), ev('tool.call.end', {
      toolCallId: 't1',
      toolName: 'custom',
      result: 'executor returned',
      isError: false,
    }, 80))
    expect(s.messages[0]!.toolCalls[0]).toMatchObject({
      id: 't1',
      status: 'done',
      partial: true,
    })
  })

  it('treats transport shutdown as reconnect or rehydrate state, not run failure', () => {
    const gateway = chatReducer(initialChatState(), ev('stream.shutdown', {
      reason: 'gateway_shutdown',
      retryAfterMs: 1000,
    }, 0))
    expect(gateway.connection.phase).toBe('reconnecting')
    expect(gateway.status).toBe('idle')

    const slow = chatReducer(seedReplayCursor(initialChatState(), 9), ev('stream.shutdown', {
      reason: 'slow_consumer',
      retryAfterMs: 1000,
    }, 9))
    expect(slow.connection).toMatchObject({ phase: 'resync_required', expectedNextSeq: 10 })
  })
})
