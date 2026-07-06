/**
 * Tests for `compaction/grouping.ts` — the message-grouping primitive
 * that compaction strategies use to slice on atomic round boundaries.
 *
 * The grouping logic owns one invariant: no tool_use ↔ tool_result
 * pair ever spans across two groups. If grouping is wrong, every
 * strategy built on top of it is wrong too — so these tests pin the
 * behaviour exhaustively.
 */

import { describe, expect, it } from 'vitest'
import {
  dropOldestRounds,
  groupMessagesByApiRound,
  isRealUserMessage,
  isToolResultMessage,
  keepLastNRounds,
} from '../../../src/compaction/grouping.js'
import { findOrphanToolResults } from '../../../src/messages/pairing.js'
import {
  assistantMsg,
  assistantToolUseMsg,
  systemMsg,
  userMsg,
  userToolResultMsg,
} from '../../helpers/fixtures.js'
import type { Message } from '../../../src/messages/types.js'

// ────────────────────────────────────────────────────────────────────
// isRealUserMessage / isToolResultMessage
// ────────────────────────────────────────────────────────────────────

describe('isRealUserMessage', () => {
  it('returns true for a string-content user message', () => {
    expect(isRealUserMessage(userMsg('hello'))).toBe(true)
  })

  it('returns true for a user message with any non-tool_result content block', () => {
    const msg: Message = {
      role: 'user',
      content: [
        { type: 'text', text: 'hi' },
        { type: 'tool_result', toolUseId: 'x', content: '', isError: false },
      ],
    }
    expect(isRealUserMessage(msg)).toBe(true)
  })

  it('returns false for a user message containing only tool_result blocks', () => {
    expect(isRealUserMessage(userToolResultMsg('x', 'r'))).toBe(false)
  })

  it('returns false for assistant / system messages', () => {
    expect(isRealUserMessage(assistantMsg('a'))).toBe(false)
    expect(isRealUserMessage(systemMsg('sys'))).toBe(false)
  })
})

describe('isToolResultMessage', () => {
  it('returns true when content is all tool_result blocks', () => {
    expect(isToolResultMessage(userToolResultMsg('x', 'r'))).toBe(true)
  })

  it('returns false when ANY block is non-tool_result', () => {
    const mixed: Message = {
      role: 'user',
      content: [
        { type: 'tool_result', toolUseId: 'x', content: '', isError: false },
        { type: 'text', text: 'and a follow up' },
      ],
    }
    expect(isToolResultMessage(mixed)).toBe(false)
  })

  it('returns false for string content (real text)', () => {
    expect(isToolResultMessage(userMsg('hi'))).toBe(false)
  })
})

// ────────────────────────────────────────────────────────────────────
// groupMessagesByApiRound
// ────────────────────────────────────────────────────────────────────

describe('groupMessagesByApiRound', () => {
  it('returns one round per real user message', () => {
    const messages: Message[] = [
      userMsg('q1'),
      assistantMsg('a1'),
      userMsg('q2'),
      assistantMsg('a2'),
    ]
    const groups = groupMessagesByApiRound(messages)
    expect(groups).toHaveLength(2)
    expect(groups[0]!.kind).toBe('round')
    expect(groups[0]!.messages).toHaveLength(2)
    expect(groups[1]!.kind).toBe('round')
    expect(groups[1]!.messages).toHaveLength(2)
  })

  it('keeps system messages in their own leading group', () => {
    const messages: Message[] = [
      systemMsg('You are a coder.'),
      userMsg('q1'),
      assistantMsg('a1'),
    ]
    const groups = groupMessagesByApiRound(messages)
    expect(groups).toHaveLength(2)
    expect(groups[0]!.kind).toBe('system')
    expect(groups[0]!.messages).toHaveLength(1)
    expect(groups[1]!.kind).toBe('round')
    expect(groups[1]!.messages).toHaveLength(2)
  })

  it('keeps tool_result messages attached to the round of their tool_use', () => {
    const messages: Message[] = [
      userMsg('read a file'),
      assistantToolUseMsg('readFile', {}, 'call_1'),
      userToolResultMsg('call_1', 'content'),
      assistantMsg('here is the answer'),
    ]
    const groups = groupMessagesByApiRound(messages)
    expect(groups).toHaveLength(1)
    expect(groups[0]!.messages).toHaveLength(4)
  })

  it('keeps a multi-step tool chain inside one round', () => {
    const messages: Message[] = [
      userMsg('do a lot of things'),
      assistantToolUseMsg('readFile', {}, 'c1'),
      userToolResultMsg('c1', 'r1'),
      assistantToolUseMsg('readFile', {}, 'c2'),
      userToolResultMsg('c2', 'r2'),
      assistantMsg('final'),
    ]
    const groups = groupMessagesByApiRound(messages)
    expect(groups).toHaveLength(1)
    expect(groups[0]!.messages).toHaveLength(6)
  })

  it('splits at every real user message even between tool chains', () => {
    const messages: Message[] = [
      userMsg('first task'),
      assistantToolUseMsg('readFile', {}, 'a1'),
      userToolResultMsg('a1', 'r1'),
      assistantMsg('done with first'),
      userMsg('second task'),
      assistantToolUseMsg('readFile', {}, 'a2'),
      userToolResultMsg('a2', 'r2'),
      assistantMsg('done with second'),
    ]
    const groups = groupMessagesByApiRound(messages)
    expect(groups).toHaveLength(2)
    expect(groups[0]!.messages).toHaveLength(4)
    expect(groups[1]!.messages).toHaveLength(4)
  })

  it('preserves message order — flat concat equals input', () => {
    const messages: Message[] = [
      systemMsg('sys'),
      userMsg('q1'),
      assistantMsg('a1'),
      userMsg('q2'),
      assistantToolUseMsg('t', {}, 'i1'),
      userToolResultMsg('i1', 'r'),
      assistantMsg('a2'),
    ]
    const groups = groupMessagesByApiRound(messages)
    const flat = groups.flatMap((g) => g.messages)
    expect(flat).toEqual(messages)
  })

  it('handles empty input', () => {
    expect(groupMessagesByApiRound([])).toEqual([])
  })

  it('handles a system-only conversation', () => {
    const groups = groupMessagesByApiRound([systemMsg('sys')])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.kind).toBe('system')
  })

  it('handles a conversation that opens with an assistant message (defensive)', () => {
    // Pathological but possible (replay / corrupted state). Should not
    // crash; the assistant message attaches to the first round.
    const messages: Message[] = [assistantMsg('hi'), userMsg('q'), assistantMsg('a')]
    const groups = groupMessagesByApiRound(messages)
    // First group: assistant alone. Second: user+assistant.
    expect(groups).toHaveLength(2)
    expect(groups.flatMap((g) => g.messages)).toEqual(messages)
  })
})

// ────────────────────────────────────────────────────────────────────
// dropOldestRounds + keepLastNRounds — atomicity guarantees
// ────────────────────────────────────────────────────────────────────

describe('keepLastNRounds', () => {
  it('keeps only the most-recent N rounds', () => {
    const messages: Message[] = [
      userMsg('q1'),
      assistantMsg('a1'),
      userMsg('q2'),
      assistantMsg('a2'),
      userMsg('q3'),
      assistantMsg('a3'),
    ]
    const kept = keepLastNRounds(messages, 2)
    expect(kept).toEqual(messages.slice(2))
  })

  it('always keeps system messages in front', () => {
    const messages: Message[] = [
      systemMsg('sys'),
      userMsg('q1'),
      assistantMsg('a1'),
      userMsg('q2'),
      assistantMsg('a2'),
    ]
    const kept = keepLastNRounds(messages, 1)
    expect(kept[0]).toEqual(systemMsg('sys'))
    expect(kept).toHaveLength(3) // system + 1 round (2 messages)
  })

  it('keeps tool_use ↔ tool_result pairs atomic when slicing', () => {
    const messages: Message[] = [
      userMsg('q1 — has tool chain'),
      assistantToolUseMsg('readFile', {}, 'old_t'),
      userToolResultMsg('old_t', 'old content'),
      assistantMsg('done with 1'),
      userMsg('q2'),
      assistantMsg('a2'),
    ]
    const kept = keepLastNRounds(messages, 1)
    // Only round 2 (2 messages) kept.
    expect(kept).toHaveLength(2)
    expect(findOrphanToolResults(kept)).toEqual([])
  })

  it('returns input unchanged when fewer rounds than the cap', () => {
    const messages: Message[] = [userMsg('q'), assistantMsg('a')]
    expect(keepLastNRounds(messages, 5)).toEqual(messages)
  })

  it('throws on maxRounds < 1', () => {
    expect(() => keepLastNRounds([], 0)).toThrow(/maxRounds must be >= 1/)
  })
})

describe('dropOldestRounds', () => {
  it('drops the oldest round when the predicate says yes', () => {
    const messages: Message[] = [
      userMsg('q1'),
      assistantMsg('a1'),
      userMsg('q2'),
      assistantMsg('a2'),
    ]
    let calls = 0
    const result = dropOldestRounds(messages, () => {
      calls += 1
      return calls < 2 // drop one round then stop
    })
    expect(result).toEqual(messages.slice(2))
  })

  it('never drops the last round even if predicate keeps returning true', () => {
    const messages: Message[] = [
      userMsg('q1'),
      assistantMsg('a1'),
      userMsg('q2'),
      assistantMsg('a2'),
    ]
    const result = dropOldestRounds(messages, () => true)
    // 2 rounds total — only 1 can be dropped (the oldest); the most-recent stays.
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual(userMsg('q2'))
  })

  it('preserves system messages across drops', () => {
    const messages: Message[] = [
      systemMsg('sys'),
      userMsg('q1'),
      assistantMsg('a1'),
      userMsg('q2'),
      assistantMsg('a2'),
    ]
    const result = dropOldestRounds(messages, () => true)
    expect(result[0]).toEqual(systemMsg('sys'))
  })

  it('atomicity stress test — random drops never orphan a tool_result', () => {
    // 8 rounds, each with a tool chain.
    const messages: Message[] = [systemMsg('sys')]
    for (let i = 0; i < 8; i += 1) {
      messages.push(userMsg(`q${i}`))
      messages.push(assistantToolUseMsg('readFile', {}, `tool_${i}`))
      messages.push(userToolResultMsg(`tool_${i}`, `content_${i}`))
      messages.push(assistantMsg(`a${i}`))
    }
    // Drop a random number of rounds.
    for (let dropTarget = 0; dropTarget < 8; dropTarget += 1) {
      let dropped = 0
      const result = dropOldestRounds(messages, () => dropped++ < dropTarget)
      expect(findOrphanToolResults(result)).toEqual([])
    }
  })
})
