import { describe, it, expect } from 'vitest'
import { MessageBuilder, messageBuilder } from '../../../src/messages/builder.js'

describe('MessageBuilder', () => {
  it('builds a simple conversation', () => {
    const messages = new MessageBuilder()
      .system('You are helpful')
      .user('Hello')
      .assistant('Hi there!')
      .build()

    expect(messages).toHaveLength(3)
    expect(messages[0]).toEqual({ role: 'system', content: 'You are helpful' })
    expect(messages[1]).toEqual({ role: 'user', content: 'Hello' })
    expect(messages[2]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'Hi there!' }] })
  })

  it('allows multiple system messages at the start', () => {
    const messages = new MessageBuilder()
      .system('Rule 1')
      .system('Rule 2')
      .user('Hello')
      .build()

    expect(messages).toHaveLength(3)
    expect(messages[0]!.role).toBe('system')
    expect(messages[1]!.role).toBe('system')
  })

  it('throws if system message added after user/assistant', () => {
    const builder = new MessageBuilder().user('Hello')
    expect(() => builder.system('Late system')).toThrow('system messages must come before')
  })

  it('supports tool result flow', () => {
    const messages = new MessageBuilder()
      .user('Read the file')
      .assistant([{ type: 'tool_use', id: 't1', name: 'readFile', input: { path: 'index.ts' } }])
      .toolResult('t1', 'file contents')
      .build()

    expect(messages).toHaveLength(3)
    expect(messages[2]!.role).toBe('user')
    const content = messages[2]!.content
    expect(Array.isArray(content) && content[0].type === 'tool_result').toBe(true)
  })

  it('throws on empty user message', () => {
    expect(() => new MessageBuilder().user('')).toThrow('must not be empty')
  })

  it('throws on empty user content blocks', () => {
    expect(() => new MessageBuilder().user([])).toThrow('must not be empty')
  })

  it('throws on empty assistant message', () => {
    expect(() => new MessageBuilder().user('Hi').assistant([])).toThrow('must not be empty')
  })

  it('throws on empty toolUseId', () => {
    expect(() => new MessageBuilder().user('Hi').assistant('Ok').toolResult('', 'content'))
      .toThrow('toolUseId must not be empty')
  })

  it('throws on consecutive assistant messages', () => {
    const builder = new MessageBuilder().user('Hi').assistant('Hello')
    expect(() => builder.assistant('Hello again')).toThrow('consecutive assistant')
  })

  it('allows consecutive user messages (user text + tool results)', () => {
    const messages = new MessageBuilder()
      .user('Hello')
      .user('Another message')
      .build()

    expect(messages).toHaveLength(2)
  })

  it('throws if first non-system message is assistant', () => {
    // Build manually by tricking the builder
    const builder = new MessageBuilder()
    // We need to directly test build() validation
    expect(() => {
      // @ts-expect-error accessing private for test
      builder.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'Hi' }] })
      // @ts-expect-error accessing private for test
      builder.systemFinished = true
      builder.build()
    }).toThrow('first non-system message must be a user message')
  })

  it('returns empty array for empty builder', () => {
    expect(new MessageBuilder().build()).toEqual([])
  })

  it('tracks length', () => {
    const builder = new MessageBuilder().system('sys').user('hi')
    expect(builder.length).toBe(2)
  })

  it('convenience function creates builder', () => {
    const messages = messageBuilder().user('Hi').assistant('Hello').build()
    expect(messages).toHaveLength(2)
  })

  it('assistant accepts string content (wraps in TextBlock)', () => {
    const messages = new MessageBuilder().user('Hi').assistant('Hello').build()
    const content = messages[1]!.content
    expect(Array.isArray(content)).toBe(true)
    expect((content as Array<{ type: string; text: string }>)[0]!.type).toBe('text')
  })

  it('tool result with isError flag', () => {
    const messages = new MessageBuilder()
      .user('Do something')
      .assistant([{ type: 'tool_use', id: 't1', name: 'bash', input: { command: 'exit 1' } }])
      .toolResult('t1', 'Command failed', true)
      .build()

    const lastContent = messages[2]!.content as Array<{ type: string; isError: boolean }>
    expect(lastContent[0]!.isError).toBe(true)
  })
})
