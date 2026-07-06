import { describe, it, expect } from 'vitest'
import {
  serializeMessages,
  deserializeMessages,
  serializeForProvider,
} from '../../../src/messages/serializer.js'
import type { Message } from '../../../src/messages/types.js'

const sampleMessages: Message[] = [
  { role: 'system', content: 'You are helpful' },
  { role: 'user', content: 'Hello' },
  { role: 'assistant', content: [{ type: 'text', text: 'Hi there!' }] },
]

describe('serializeMessages / deserializeMessages', () => {
  it('roundtrips messages correctly', () => {
    const json = serializeMessages(sampleMessages)
    const parsed = deserializeMessages(json)

    expect(parsed).toEqual(sampleMessages)
  })

  it('produces valid JSON', () => {
    const json = serializeMessages(sampleMessages)
    expect(() => JSON.parse(json)).not.toThrow()
  })

  it('handles empty array', () => {
    const json = serializeMessages([])
    expect(deserializeMessages(json)).toEqual([])
  })

  it('throws on malformed JSON', () => {
    expect(() => deserializeMessages('not json')).toThrow('Failed to parse')
  })

  it('throws on non-array JSON', () => {
    expect(() => deserializeMessages('{"role":"user"}')).toThrow('Expected messages to be an array')
  })

  it('skips invalid messages during deserialization', () => {
    const json = JSON.stringify([
      { role: 'user', content: 'Valid' },
      { role: 'unknown', content: 'Invalid' },
      null,
      { role: 'assistant', content: [{ type: 'text', text: 'Also valid' }] },
    ])

    const parsed = deserializeMessages(json)
    expect(parsed).toHaveLength(2)
    expect(parsed[0]!.role).toBe('user')
    expect(parsed[1]!.role).toBe('assistant')
  })

  it('handles circular references without crashing', () => {
    const msg: any = { role: 'user', content: 'Hello' }
    msg.self = msg // Circular reference

    // Should not throw — circular refs are replaced with '[Circular]'
    const json = serializeMessages([msg])
    expect(json).toContain('[Circular]')
  })

  it('handles messages with tool_use and tool_result blocks', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Read file' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'readFile', input: { path: 'x.ts' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: 't1', content: 'file content', isError: false }],
      },
    ]

    const json = serializeMessages(messages)
    const parsed = deserializeMessages(json)
    expect(parsed).toHaveLength(3)
  })
})

describe('serializeForProvider', () => {
  describe('anthropic', () => {
    it('strips system messages', () => {
      const result = serializeForProvider(sampleMessages, 'anthropic') as Array<{ role: string }>
      expect(result.every(m => m.role !== 'system')).toBe(true)
    })

    it('preserves user and assistant messages', () => {
      const result = serializeForProvider(sampleMessages, 'anthropic') as Array<{ role: string }>
      expect(result).toHaveLength(2)
      expect(result[0]!.role).toBe('user')
      expect(result[1]!.role).toBe('assistant')
    })
  })

  describe('openai', () => {
    it('keeps system messages', () => {
      const result = serializeForProvider(sampleMessages, 'openai') as Array<{ role: string }>
      expect(result[0]!.role).toBe('system')
    })

    it('converts tool_use to tool_calls', () => {
      const messages: Message[] = [
        { role: 'user', content: 'Hi' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me check' },
            { type: 'tool_use', id: 't1', name: 'readFile', input: { path: 'x.ts' } },
          ],
        },
      ]

      const result = serializeForProvider(messages, 'openai') as Array<Record<string, unknown>>
      const assistantMsg = result[1]!
      expect(assistantMsg.content).toBe('Let me check')
      expect(Array.isArray(assistantMsg.tool_calls)).toBe(true)
      const toolCall = (assistantMsg.tool_calls as Array<Record<string, unknown>>)[0]!
      expect(toolCall.type).toBe('function')
    })

    it('flattens single-text user content blocks to string', () => {
      const messages: Message[] = [
        { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      ]
      const result = serializeForProvider(messages, 'openai') as Array<{ content: unknown }>
      expect(result[0]!.content).toBe('Hello')
    })
  })

  describe('google', () => {
    it('maps assistant to model role', () => {
      const result = serializeForProvider(sampleMessages, 'google') as Array<{ role: string }>
      const modelMsg = result.find(m => m.role === 'model')
      expect(modelMsg).toBeDefined()
    })

    it('converts system to user with [System] prefix', () => {
      const result = serializeForProvider(sampleMessages, 'google') as Array<{
        role: string
        parts: Array<{ text: string }>
      }>
      expect(result[0]!.parts[0]!.text).toContain('[System]')
    })

    it('converts tool_use to functionCall', () => {
      const messages: Message[] = [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'read', input: { path: 'x' } }],
        },
      ]
      const result = serializeForProvider(messages, 'google') as Array<{
        parts: Array<{ functionCall?: unknown }>
      }>
      expect(result[0]!.parts[0]!.functionCall).toBeDefined()
    })
  })
})
