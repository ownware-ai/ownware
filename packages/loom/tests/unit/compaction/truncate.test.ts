import { describe, it, expect } from 'vitest'
import { truncate } from '../../../src/compaction/truncate.js'
import { findOrphanToolResults } from '../../../src/messages/pairing.js'
import { createMockProvider } from '../../helpers/mock-provider.js'
import {
  systemMsg,
  userMsg,
  assistantMsg,
  assistantToolUseMsg,
  userToolResultMsg,
  createConversation,
} from '../../helpers/fixtures.js'
import type { Message } from '../../../src/messages/types.js'

describe('truncate strategy', () => {
  it('keeps system messages at the start', async () => {
    const messages = [
      systemMsg('System prompt'),
      ...createConversation(5),
    ]
    const provider = createMockProvider({ tokenCount: 1000 })

    const result = await truncate(messages, '', { type: 'messages', count: 2 }, provider)

    expect(result.messages[0]).toEqual(systemMsg('System prompt'))
    expect(result.messages[0]!.role).toBe('system')
  })

  it('retains correct N messages with retain type = messages', async () => {
    const conv = createConversation(6) // 12 messages (6 user + 6 assistant)
    const provider = createMockProvider({ tokenCount: 1000 })

    const result = await truncate(conv, '', { type: 'messages', count: 4 }, provider)

    // Should keep last 4 messages
    expect(result.messages).toHaveLength(4)
    expect(result.messages).toEqual(conv.slice(-4))
  })

  it('retains correct fraction with retain type = fraction', async () => {
    const conv = createConversation(5) // 10 messages
    const provider = createMockProvider({ tokenCount: 1000 })

    const result = await truncate(conv, '', { type: 'fraction', amount: 0.4 }, provider)

    // 0.4 * 10 = 4 messages
    expect(result.messages).toHaveLength(4)
    expect(result.messages).toEqual(conv.slice(-4))
  })

  it('retains by token estimate with retain type = tokens', async () => {
    const conv = createConversation(10)
    const provider = createMockProvider({ tokenCount: 5000 })

    // Very low token budget forces dropping most messages
    const result = await truncate(conv, '', { type: 'tokens', count: 50 }, provider)

    // Should keep some messages from the end but not all
    expect(result.messages.length).toBeGreaterThan(0)
    expect(result.messages.length).toBeLessThan(conv.length)
    // Last message should always be the final message
    expect(result.messages.at(-1)).toEqual(conv.at(-1))
  })

  it('returns all messages when conversation is shorter than retain count', async () => {
    const conv = createConversation(2) // 4 messages
    const provider = createMockProvider({ tokenCount: 500 })

    const result = await truncate(conv, '', { type: 'messages', count: 10 }, provider)

    expect(result.messages).toHaveLength(4)
    expect(result.messages).toEqual(conv)
  })

  it('handles empty conversation', async () => {
    const provider = createMockProvider({ tokenCount: 0 })

    const result = await truncate([], '', { type: 'messages', count: 5 }, provider)

    expect(result.messages).toHaveLength(0)
  })

  it('returns correct pre/post token counts', async () => {
    let callCount = 0
    const provider = createMockProvider({
      tokenCount: (msgs) => {
        callCount++
        return msgs.length * 100
      },
    })
    const conv = createConversation(5) // 10 messages

    const result = await truncate(conv, '', { type: 'messages', count: 4 }, provider)

    expect(result.preTokenCount).toBe(1000)  // 10 * 100
    expect(result.postTokenCount).toBe(400)  // 4 * 100
  })

  it('does not include summaryUsage (no LLM call)', async () => {
    const conv = createConversation(5)
    const provider = createMockProvider({ tokenCount: 1000 })

    const result = await truncate(conv, '', { type: 'messages', count: 4 }, provider)

    expect(result.summaryUsage).toBeUndefined()
  })

  it('reports strategy as "truncate"', async () => {
    const conv = createConversation(3)
    const provider = createMockProvider({ tokenCount: 500 })

    const result = await truncate(conv, '', { type: 'messages', count: 2 }, provider)

    expect(result.strategy).toBe('truncate')
  })
})

describe('truncate preserves tool_use ↔ tool_result pairing', () => {
  it('keeps tool_use ↔ tool_result pairs atomic via round-based slicing', async () => {
    // Round-aware retention (compaction/grouping.ts) makes the slice
    // boundary fall on a real-user-message — so a tool_use and its
    // tool_result can never end up in different rounds. The orphan
    // case from the old expand-backward path is now impossible by
    // construction. Test guarantees:
    //   - No orphans in the output (the safety property).
    //   - When the only-recent round contains the tool chain, the
    //     entire round is retained — tool_use precedes its tool_result
    //     and the chain stays internally consistent.
    const messages: Message[] = [
      userMsg('first prompt'),
      assistantToolUseMsg('readFile', { path: '/big' }, 'call_big'),
      userToolResultMsg('call_big', 'huge content'),
      assistantMsg('summary text after the read'),
      userMsg('newer prompt'),
    ]
    const provider = createMockProvider({ tokenCount: 1000 })

    // Two rounds here:
    //   Round 1: messages[0..3] (user + tool chain + assistant summary)
    //   Round 2: messages[4]    (newer user prompt only)
    // retain {count: 3} → can fit round 2 alone (1 msg) + can't fit
    // round 1 (4 msgs) within remaining 2 budget → keep just round 2.
    const result = await truncate(messages, '', { type: 'messages', count: 3 }, provider)

    expect(findOrphanToolResults(result.messages)).toEqual([])
    // The most-recent round (the new user prompt) is always retained.
    expect(result.messages.at(-1)).toEqual(userMsg('newer prompt'))
  })

  it('pulls in the whole prior round (with its tool chain) when budget allows', async () => {
    const messages: Message[] = [
      userMsg('first prompt'),
      assistantToolUseMsg('readFile', { path: '/big' }, 'call_big'),
      userToolResultMsg('call_big', 'huge content'),
      assistantMsg('summary text after the read'),
      userMsg('newer prompt'),
      assistantMsg('answer to newer'),
    ]
    const provider = createMockProvider({ tokenCount: 1000 })

    // Two rounds. retain {count: 6} fits both — full conversation kept.
    const result = await truncate(messages, '', { type: 'messages', count: 6 }, provider)

    expect(findOrphanToolResults(result.messages)).toEqual([])
    expect(result.messages).toEqual(messages)
  })

  it('reproduces the GPT-5.5 thread shape from thread_b88319e95521 and yields a valid array', async () => {
    // Shape: small reads, then huge parallel reads, then a model summary.
    // Truncate to a tight window and verify no orphans.
    const parallelCall: Message = {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'p1', name: 'readFile', input: { file_path: 'a.html' } },
        { type: 'tool_use', id: 'p2', name: 'readFile', input: { file_path: 'b.html' } },
        { type: 'tool_use', id: 'p3', name: 'readFile', input: { file_path: 'c.html' } },
        { type: 'tool_use', id: 'p4', name: 'readFile', input: { file_path: 'd.html' } },
      ],
    }
    const bundledResults: Message = {
      role: 'user',
      content: [
        { type: 'tool_result', toolUseId: 'p1', content: 'A'.repeat(88_000), isError: false },
        { type: 'tool_result', toolUseId: 'p2', content: 'B'.repeat(93_000), isError: false },
        { type: 'tool_result', toolUseId: 'p3', content: 'C'.repeat(97_000), isError: false },
        { type: 'tool_result', toolUseId: 'p4', content: 'D'.repeat(98_000), isError: false },
      ],
    }
    const messages: Message[] = [
      systemMsg('You are a coder.'),
      userMsg('read the planner files'),
      assistantToolUseMsg('readFile', { path: 'small.md' }, 'small_1'),
      userToolResultMsg('small_1', 'small content'),
      assistantMsg('I read the small file, now the big ones.'),
      parallelCall,
      bundledResults,
      assistantMsg('summary of everything'),
    ]
    const provider = createMockProvider({ tokenCount: 153_000 })

    // Tight retention forces the slice to land mid-pair on the bundled results.
    const result = await truncate(messages, '', { type: 'messages', count: 2 }, provider)

    expect(findOrphanToolResults(result.messages)).toEqual([])
    // System message must still be at index 0.
    expect(result.messages[0]!.role).toBe('system')
  })

  it('keeps a parallel tool call + its bundled results inside one atomic round', async () => {
    // Round-based slicing never splits a parallel tool call from its
    // bundled tool_results: they live in the same round (the one
    // started by `userMsg('q')`) and either both stay or both go.
    const parallelCall: Message = {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'pa', name: 'readFile', input: {} },
        { type: 'tool_use', id: 'pb', name: 'readFile', input: {} },
      ],
    }
    const bundledResults: Message = {
      role: 'user',
      content: [
        { type: 'tool_result', toolUseId: 'pa', content: 'A', isError: false },
        { type: 'tool_result', toolUseId: 'pb', content: 'B', isError: false },
      ],
    }
    const messages: Message[] = [
      userMsg('q'),
      parallelCall,
      bundledResults,
      assistantMsg('done'),
    ]
    const provider = createMockProvider({ tokenCount: 100 })

    // Single round — retain {count: 2} can't fit 4 msgs, but the floor
    // is "always keep the last round entire" so we get the whole round.
    const result = await truncate(messages, '', { type: 'messages', count: 2 }, provider)

    expect(result.messages).toEqual(messages)
    expect(findOrphanToolResults(result.messages)).toEqual([])
  })

  it('property: random truncations of conversations with tool calls never orphan', async () => {
    const provider = createMockProvider({ tokenCount: 500 })

    // Build a longer conversation with mixed tool patterns
    const messages: Message[] = [systemMsg('sys'), userMsg('start')]
    for (let i = 0; i < 8; i++) {
      const id = `t_${i}`
      messages.push(assistantToolUseMsg('readFile', { i }, id))
      messages.push(userToolResultMsg(id, `result ${i}`))
    }
    messages.push(assistantMsg('final answer'))

    for (let retain = 1; retain <= messages.length; retain++) {
      const result = await truncate(messages, '', { type: 'messages', count: retain }, provider)
      expect(findOrphanToolResults(result.messages)).toEqual([])
    }
  })
})
