import { describe, expect, it } from 'vitest'
import { hydrateChatState, initialChatState } from '../index.js'

describe('hydrateChatState', () => {
  it('loads closed transcript rows and seeds replay at the closed-turn cursor', () => {
    const state = hydrateChatState(initialChatState(), {
      lastClosedTurnEndSeq: 17,
      messages: [
        { id: 'm1', role: 'user', content: 'hello' },
        {
          id: 'm2',
          role: 'assistant',
          content: 'before after',
          tools: [{
            toolCallId: 't1',
            name: 'custom',
            input: { target: 'x' },
            output: 'executor returned',
            isError: false,
          }],
          parts: [
            { kind: 'text', text: 'before ' },
            { kind: 'tool', toolCallId: 't1' },
            { kind: 'text', text: 'after' },
          ],
        },
      ],
    })
    expect(state.messages).toHaveLength(2)
    expect(state.messages[1]!.toolCalls[0]).toMatchObject({
      id: 't1',
      status: 'done',
      result: 'executor returned',
    })
    expect(state.messages[1]!.parts).toEqual([
      { kind: 'text', text: 'before ' },
      { kind: 'tool', toolCallId: 't1' },
      { kind: 'text', text: 'after' },
    ])
    expect(state.connection).toMatchObject({
      phase: 'replaying',
      lastDeliveredSeq: 17,
      expectedNextSeq: 18,
    })
  })

  it('fails closed without replacing state when hydration is malformed', () => {
    const initial = initialChatState()
    const malformed = hydrateChatState(initial, {
      lastClosedTurnEndSeq: -1,
      messages: [],
    })
    expect(malformed).toBe(initial)
  })

  it('rejects malformed historical descriptors instead of trusting presentation metadata', () => {
    const initial = initialChatState()
    const malformed = hydrateChatState(initial, {
      lastClosedTurnEndSeq: 1,
      messages: [{
        id: 'm1',
        role: 'assistant',
        content: '',
        tools: [{
          name: 'unfamiliar_tool',
          input: {},
          uiDescriptor: {
            kind: 'external-action',
            summary: { verb: 'x'.repeat(121) },
          },
        }],
      }],
    })
    expect(malformed).toBe(initial)
  })
  it('drops part ordering rather than fabricate a tool correlation id', () => {
    // A legacy row can carry `parts` (which reference tools by stable id)
    // while a tool record predates `toolCallId`. Synthesizing an id would make
    // every {kind:'tool'} entry miss its record and render as unavailable,
    // even though the tool data is present. Keep the tools, drop the ordering.
    const state = hydrateChatState(initialChatState(), {
      lastClosedTurnEndSeq: 4,
      messages: [{
        id: 'm1',
        role: 'assistant',
        content: 'done',
        tools: [{ name: 'readFile', input: { path: 'a.txt' }, output: 'contents' }],
        parts: [{ kind: 'text', text: 'done' }, { kind: 'tool', toolCallId: 'call-1' }],
      }],
    })
    const message = state.messages[0]!
    expect(message.parts).toBeUndefined()
    expect(message.toolCalls).toHaveLength(1)
    expect(message.toolCalls[0]!.name).toBe('readFile')
    expect(message.toolCalls[0]!.result).toBe('contents')
  })

  it('keeps part ordering when every tool record carries its own id', () => {
    const state = hydrateChatState(initialChatState(), {
      lastClosedTurnEndSeq: 4,
      messages: [{
        id: 'm1',
        role: 'assistant',
        content: 'done',
        tools: [{ toolCallId: 'call-1', name: 'readFile', input: { path: 'a.txt' } }],
        parts: [{ kind: 'text', text: 'done' }, { kind: 'tool', toolCallId: 'call-1' }],
      }],
    })
    const message = state.messages[0]!
    expect(message.parts).toHaveLength(2)
    expect(message.toolCalls[0]!.id).toBe('call-1')
  })

  it('keeps part ordering when the parts carry no tool references', () => {
    const state = hydrateChatState(initialChatState(), {
      lastClosedTurnEndSeq: 4,
      messages: [{
        id: 'm1',
        role: 'assistant',
        content: 'thinking then text',
        tools: [{ name: 'readFile', input: {} }],
        parts: [{ kind: 'thinking', text: 'hm' }, { kind: 'text', text: 'thinking then text' }],
      }],
    })
    expect(state.messages[0]!.parts).toHaveLength(2)
  })
})
