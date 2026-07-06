/**
 * B4a — `ToolResultBlock.metadata` carrier contract.
 *
 * Verifies that the Loom-internal metadata on tool results survives:
 *   1. `createToolResultMessage()` construction
 *   2. `MessageBuilder.toolResult()` construction
 *   3. The `tool-result-drop` compactor rewrite (placeholder content,
 *      same metadata)
 *
 * Provider-serializer non-leak is verified at compile-time: every
 * serializer picks fields explicitly (no spread of the block), so an
 * unknown `metadata` field is impossible to leak. Adding a runtime
 * test there would just assert what TypeScript already prevents.
 */

import { describe, it, expect } from 'vitest'
import {
  createToolResultMessage,
  type UserMessage,
  type ToolResultBlock,
} from '../../../messages/types.js'
import { MessageBuilder } from '../../../messages/builder.js'
import { dropStaleToolResults } from '../../../compaction/tool-result-drop.js'
import type { Message } from '../../../messages/types.js'

function getToolResultBlock(msg: UserMessage): ToolResultBlock {
  if (!Array.isArray(msg.content)) {
    throw new Error('expected array content')
  }
  const block = msg.content[0]
  if (!block || block.type !== 'tool_result') {
    throw new Error('expected first block to be tool_result')
  }
  return block
}

describe('B4a — tool_result metadata carrier', () => {
  describe('createToolResultMessage', () => {
    it('omits the metadata field when no metadata is supplied (no shape drift)', () => {
      const msg = createToolResultMessage('t1', 'ok', false)
      const block = getToolResultBlock(msg)
      expect(block).toEqual({
        type: 'tool_result',
        toolUseId: 't1',
        content: 'ok',
        isError: false,
      })
      expect('metadata' in block).toBe(false)
    })

    it('carries metadata when supplied', () => {
      const meta = {
        kind: 'browser-snapshot',
        targetId: 'tab-A7F2',
        supersedable: true,
      }
      const msg = createToolResultMessage('t1', 'ok', false, meta)
      const block = getToolResultBlock(msg)
      expect(block.metadata).toEqual(meta)
    })
  })

  describe('MessageBuilder.toolResult', () => {
    it('builds with metadata when supplied', () => {
      const built = new MessageBuilder()
        .user('hi')
        .assistant([
          { type: 'tool_use', id: 't1', name: 'browser_navigate', input: { url: 'https://example.com' } },
        ])
        .toolResult('t1', 'Navigated', false, {
          kind: 'browser-snapshot',
          targetId: 'tab-1',
          supersedable: true,
        })
        .build()

      const last = built[built.length - 1]
      if (!last || last.role !== 'user' || !Array.isArray(last.content)) {
        throw new Error('expected tool_result user message at end')
      }
      const block = last.content[0]
      if (!block || block.type !== 'tool_result') {
        throw new Error('expected tool_result block')
      }
      expect(block.metadata).toEqual({
        kind: 'browser-snapshot',
        targetId: 'tab-1',
        supersedable: true,
      })
    })
  })

  describe('dropStaleToolResults preserves metadata', () => {
    it('keeps the typed metadata on rewritten placeholder blocks', () => {
      const meta = {
        kind: 'browser-snapshot',
        targetId: 'tab-A7F2',
        supersedable: true,
      } as const
      // Construct a history where one stale tool_result is large enough
      // to be rewritten: user prompt → assistant tool_use → user
      // tool_result (LARGE) → assistant reply → 3 more user turns to
      // push past keepRecentTurns=2.
      const big = 'X'.repeat(2000)
      const messages: Message[] = [
        { role: 'user', content: 'first prompt' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 't1', name: 'browser_navigate', input: { url: 'https://example.com' } },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              toolUseId: 't1',
              content: `Navigated to https://example.com\n${big}`,
              isError: false,
              metadata: meta,
            },
          ],
        },
        { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
        { role: 'user', content: 'second prompt' },
        { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
        { role: 'user', content: 'third prompt' },
      ]

      const report = dropStaleToolResults(messages, { keepRecentTurns: 2 })
      expect(report.droppedCount).toBe(1)

      // Find the rewritten block and check its metadata is intact.
      const stale = report.messages[2]
      if (!stale || stale.role !== 'user' || !Array.isArray(stale.content)) {
        throw new Error('expected user-role tool_result message at index 2')
      }
      const block = stale.content[0]
      if (!block || block.type !== 'tool_result') {
        throw new Error('expected tool_result block')
      }
      expect(block.content).not.toContain(big) // content was rewritten
      expect(block.metadata).toEqual(meta) // metadata survived
    })
  })
})
