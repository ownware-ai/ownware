import { describe, it, expect } from 'vitest'
import {
  initialChatState,
  chatReducer,
  applyEvents,
  addUserMessage,
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
    let s = applyEvents(initialChatState(), [
      ev('user.message', { text: 'connect slack' }, 1),
      ev('permission.request', { requestId: 'r1', toolName: 'slack_connect', reason: 'read + reply in #support only' }, 2),
    ])
    expect(s.status).toBe('awaiting_approval')
    expect(s.pendingApproval).toMatchObject({ requestId: 'r1', toolName: 'slack_connect', reason: 'read + reply in #support only' })

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

  it('tracks the highest seq as the resume cursor, ignoring unknown events', () => {
    const s = applyEvents(initialChatState(), [ev('cache.status', {}, 7), ev('something.unknown', {}, 3)])
    expect(s.lastSeq).toBe(7)
    expect(s.messages).toHaveLength(0)
  })
})
