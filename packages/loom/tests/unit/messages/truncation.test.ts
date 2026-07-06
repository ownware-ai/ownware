import { describe, it, expect } from 'vitest'
import {
  truncateMessages,
  truncateContent,
  shouldTruncateToolResult,
} from '../../../src/messages/truncation.js'
import type { Message } from '../../../src/messages/types.js'

describe('truncateMessages', () => {
  const systemMsg: Message = { role: 'system', content: 'System prompt' }
  const shortConvo: Message[] = [
    systemMsg,
    { role: 'user', content: 'Hi' },
    { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] },
  ]

  it('returns original when under budget', () => {
    const result = truncateMessages(shortConvo, 100_000)
    expect(result).toEqual(shortConvo)
  })

  it('preserves system messages', () => {
    const messages: Message[] = [
      systemMsg,
      ...Array.from({ length: 20 }, (_, i) => ({
        role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
        content: i % 2 === 0 ? `Message ${i}` : [{ type: 'text' as const, text: `Response ${i}` }],
      })),
    ]

    const result = truncateMessages(messages, 50) // Very tight budget
    expect(result[0]).toEqual(systemMsg)
  })

  it('keeps most recent messages', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Old message' },
      { role: 'assistant', content: [{ type: 'text', text: 'Old response' }] },
      { role: 'user', content: 'Recent message' },
      { role: 'assistant', content: [{ type: 'text', text: 'Recent response' }] },
    ]

    // Budget enough for ~2 messages but not 4
    const result = truncateMessages(messages, 20)
    expect(result.length).toBeLessThan(messages.length)
    expect(result[result.length - 1]).toEqual(messages[messages.length - 1])
  })

  it('returns only system messages if budget is exhausted by them', () => {
    const longSystem: Message = { role: 'system', content: 'x'.repeat(10000) }
    const messages: Message[] = [
      longSystem,
      { role: 'user', content: 'Hi' },
    ]

    const result = truncateMessages(messages, 10) // Way too small
    expect(result).toEqual([longSystem])
  })

  it('handles empty array', () => {
    expect(truncateMessages([], 1000)).toEqual([])
  })
})

describe('truncateContent', () => {
  it('returns original if under limit', () => {
    expect(truncateContent('Hello', 100)).toBe('Hello')
  })

  it('truncates with marker', () => {
    const long = 'a'.repeat(200)
    const result = truncateContent(long, 50)
    expect(result.length).toBeLessThanOrEqual(50)
    expect(result).toContain('[Content truncated]')
  })

  it('handles exact-length strings', () => {
    const exact = 'a'.repeat(50)
    expect(truncateContent(exact, 50)).toBe(exact)
  })

  it('honors byte budget even when smaller than marker length', () => {
    // truncateContent now byte-caps strictly — the result must never exceed
    // the requested budget, even if that means the marker itself gets cut.
    // The previous behavior (always include full marker) silently violated
    // the cap, which surprised downstream callers that trusted the limit.
    const result = truncateContent('Hello world', 5)
    expect(Buffer.byteLength(result, 'utf8')).toBeLessThanOrEqual(5)
  })
})

describe('shouldTruncateToolResult', () => {
  it('returns false when under limit', () => {
    expect(shouldTruncateToolResult('short', 100)).toBe(false)
  })

  it('returns true when over limit', () => {
    expect(shouldTruncateToolResult('a'.repeat(200), 100)).toBe(true)
  })

  it('returns false at exact limit', () => {
    expect(shouldTruncateToolResult('a'.repeat(100), 100)).toBe(false)
  })
})
