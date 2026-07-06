/**
 * Unit tests for applyMessageCacheMarkers — Anthropic prompt-cache marker placement.
 *
 * Regression context: Loom previously stamped `cache_control` on every message
 * except the last (N-1 markers). Combined with the system block's marker, total
 * markers exceeded Anthropic's 4-block server-side cap once conversations grew
 * past 4 messages, returning a 400 invalid_request_error. The current behavior
 * places exactly one marker on the last message tail.
 */

import { describe, expect, it } from 'vitest'
import {
  CACHE_CONTROL_BLOCK_LIMIT,
  applyMessageCacheMarkers,
} from '../../../src/core/loop.js'
import type { Message } from '../../../src/messages/types.js'
import {
  assistantMsg,
  assistantToolUseMsg,
  createConversation,
  systemMsg,
  userMsg,
  userToolResultMsg,
} from '../../helpers/fixtures.js'

// Total cache_control markers placed across all message content blocks.
function countMarkers(messages: Message[]): number {
  let n = 0
  for (const msg of messages) {
    if (typeof msg.content === 'string') continue
    if (!Array.isArray(msg.content)) continue
    for (const block of msg.content) {
      if ('cache_control' in block && block.cache_control) n += 1
    }
  }
  return n
}

// Index of the message holding the marker (or -1 if none).
function markerMessageIndex(messages: Message[]): number {
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i]!
    if (typeof msg.content === 'string') continue
    if (!Array.isArray(msg.content)) continue
    if (msg.content.some(b => 'cache_control' in b && b.cache_control)) return i
  }
  return -1
}

describe('applyMessageCacheMarkers', () => {
  describe('marker count invariant', () => {
    it('returns empty array unchanged', () => {
      const out = applyMessageCacheMarkers([], 0)
      expect(out).toEqual([])
    })

    it('marks the only message when conversation has exactly one', () => {
      const messages = [userMsg('hello')]
      const out = applyMessageCacheMarkers(messages, 0)
      expect(countMarkers(out)).toBe(1)
      expect(markerMessageIndex(out)).toBe(0)
    })

    it('places exactly one marker for any conversation length', () => {
      for (const turns of [1, 2, 3, 5, 10, 25]) {
        const messages = createConversation(turns)
        const out = applyMessageCacheMarkers(messages, 0)
        expect(countMarkers(out)).toBe(1)
      }
    })

    it('places the marker on the last message', () => {
      const messages = createConversation(8)
      const out = applyMessageCacheMarkers(messages, 0)
      expect(markerMessageIndex(out)).toBe(out.length - 1)
    })

    it('does not exceed Anthropic 4-block cap on long histories', () => {
      // The original bug produced 49 markers here.
      const messages = createConversation(50)
      const out = applyMessageCacheMarkers(messages, 1)
      expect(countMarkers(out) + 1 /* system marker */).toBeLessThanOrEqual(
        CACHE_CONTROL_BLOCK_LIMIT,
      )
    })
  })

  describe('content-shape handling', () => {
    it('wraps string content in a text block carrying the marker', () => {
      const messages: Message[] = [userMsg('hi there')]
      const out = applyMessageCacheMarkers(messages, 0)
      const last = out[0]!
      expect(Array.isArray(last.content)).toBe(true)
      const blocks = last.content as Array<{ type: string; text?: string; cache_control?: unknown }>
      expect(blocks).toHaveLength(1)
      expect(blocks[0]).toMatchObject({
        type: 'text',
        text: 'hi there',
        cache_control: { type: 'ephemeral' },
      })
    })

    it('marks the last block of a multi-block assistant message', () => {
      const messages: Message[] = [
        userMsg('hi'),
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'first' },
            { type: 'text', text: 'second' },
            { type: 'text', text: 'third' },
          ],
        },
      ]
      const out = applyMessageCacheMarkers(messages, 0)
      const lastMsg = out[1]!
      const blocks = lastMsg.content as Array<{ type: string; text?: string; cache_control?: unknown }>
      expect(blocks).toHaveLength(3)
      expect(blocks[0]!.cache_control).toBeUndefined()
      expect(blocks[1]!.cache_control).toBeUndefined()
      expect(blocks[2]!.cache_control).toEqual({ type: 'ephemeral' })
    })

    it('handles tool_use as the last block', () => {
      const messages: Message[] = [
        userMsg('please read the file'),
        assistantToolUseMsg('read_file', { path: '/x' }, 'tool_x'),
      ]
      const out = applyMessageCacheMarkers(messages, 0)
      const blocks = out[1]!.content as Array<{ type: string; cache_control?: unknown }>
      expect(blocks[0]!).toMatchObject({
        type: 'tool_use',
        cache_control: { type: 'ephemeral' },
      })
    })

    it('handles tool_result as the last block', () => {
      const messages: Message[] = [
        userMsg('go'),
        assistantToolUseMsg('read_file', { path: '/x' }, 'tool_x'),
        userToolResultMsg('tool_x', 'file contents'),
      ]
      const out = applyMessageCacheMarkers(messages, 0)
      const blocks = out[2]!.content as Array<{ type: string; cache_control?: unknown }>
      expect(blocks[0]!).toMatchObject({
        type: 'tool_result',
        cache_control: { type: 'ephemeral' },
      })
    })

    it('returns unchanged when last message has empty block array', () => {
      // Real Loom will never emit this, but the function must be defensive.
      const messages: Message[] = [
        userMsg('first'),
        { role: 'assistant', content: [] },
      ]
      const out = applyMessageCacheMarkers(messages, 0)
      expect(out[1]!.content).toEqual([])
      expect(countMarkers(out)).toBe(0)
    })
  })

  describe('immutability', () => {
    it('does not mutate the input messages', () => {
      const messages = createConversation(5)
      const snapshot = JSON.parse(JSON.stringify(messages))
      applyMessageCacheMarkers(messages, 0)
      expect(messages).toEqual(snapshot)
    })

    it('returns a new array (never the same reference)', () => {
      const messages = createConversation(3)
      const out = applyMessageCacheMarkers(messages, 0)
      expect(out).not.toBe(messages)
    })

    it('preserves the original last message object identity', () => {
      // We mutate by returning a new object — the original must be untouched.
      const original = userMsg('hi')
      const messages: Message[] = [original]
      const out = applyMessageCacheMarkers(messages, 0)
      expect(original.content).toBe('hi')
      expect(out[0]).not.toBe(original)
    })
  })

  describe('defense-in-depth cap', () => {
    it('skips marking when reservedMarkers already equals the cap', () => {
      const messages = createConversation(10)
      const out = applyMessageCacheMarkers(messages, CACHE_CONTROL_BLOCK_LIMIT)
      expect(countMarkers(out)).toBe(0)
    })

    it('skips marking when reservedMarkers exceeds the cap', () => {
      const messages = createConversation(10)
      const out = applyMessageCacheMarkers(messages, CACHE_CONTROL_BLOCK_LIMIT + 5)
      expect(countMarkers(out)).toBe(0)
    })

    it('marks normally when reservedMarkers leaves room', () => {
      const messages = createConversation(10)
      const out = applyMessageCacheMarkers(messages, CACHE_CONTROL_BLOCK_LIMIT - 1)
      expect(countMarkers(out)).toBe(1)
    })

    it('exposes a numeric cap matching the Anthropic server limit', () => {
      expect(CACHE_CONTROL_BLOCK_LIMIT).toBe(4)
    })
  })

  describe('regression: original 400-error scenario', () => {
    it('keeps total markers ≤ 4 with system marker present and 6+ messages', () => {
      // Reproduces the exact pattern from the bug report:
      //   "A maximum of 4 blocks with cache_control may be provided. Found 6."
      const messages: Message[] = [
        userMsg('Hi'),
        assistantMsg('Hello!'),
        userMsg('How are you?'),
        assistantMsg('I am doing well.'),
        userMsg('What can you do?'),
        assistantMsg('Lots of things.'),
      ]
      const reservedSystemMarkers = 1
      const out = applyMessageCacheMarkers(messages, reservedSystemMarkers)
      const total = countMarkers(out) + reservedSystemMarkers
      expect(total).toBeLessThanOrEqual(CACHE_CONTROL_BLOCK_LIMIT)
      // And specifically: system + last-message tail = 2 markers exactly.
      expect(total).toBe(2)
    })

    it('mixed user/assistant/tool-result history still yields one marker', () => {
      const messages: Message[] = [
        systemMsg('be brief'),
        userMsg('list files'),
        assistantToolUseMsg('list_files', { dir: '.' }, 'tool_a'),
        userToolResultMsg('tool_a', 'a.ts\nb.ts'),
        assistantMsg('Found two files.'),
        userMsg('read a.ts'),
        assistantToolUseMsg('read_file', { path: 'a.ts' }, 'tool_b'),
        userToolResultMsg('tool_b', 'export const x = 1'),
        assistantMsg('It exports x = 1.'),
      ]
      const out = applyMessageCacheMarkers(messages, 1)
      expect(countMarkers(out)).toBe(1)
      expect(markerMessageIndex(out)).toBe(messages.length - 1)
    })
  })
})
