/**
 * B4b — `compactSupersededBrowserSnapshots` behavior.
 *
 * Builds synthetic message histories with typed snapshot metadata
 * and verifies:
 *   - The most recent K snapshots per `targetId` survive verbatim.
 *   - Older snapshots of the same tab are rewritten to a breadcrumb.
 *   - Snapshots from different tabs are independent (per-tab grouping).
 *   - Non-browser tool results are NEVER touched.
 *   - The current turn's tool_results stay verbatim.
 *   - cache_control and metadata survive the rewrite.
 *   - `supersedable !== true` snapshots are immutable.
 *   - Snapshots without a `targetId` are skipped (can't group).
 */

import { describe, it, expect } from 'vitest'
import { compactSupersededBrowserSnapshots } from '../../../compaction/browser-snapshot-supersede.js'
import type { Message, ContentBlock } from '../../../messages/types.js'

const BIG = 'X'.repeat(2000)
const SMALL = 'x'.repeat(100)

function snapshotResult(
  toolUseId: string,
  targetId: string,
  size: 'big' | 'small' = 'big',
  overrides: Record<string, unknown> = {},
): ContentBlock {
  return {
    type: 'tool_result',
    toolUseId,
    content: `Page snapshot...\n${size === 'big' ? BIG : SMALL}`,
    isError: false,
    metadata: {
      kind: 'browser-snapshot',
      targetId,
      supersedable: true,
      url: `https://example.com/${targetId}`,
      title: `Page ${targetId}`,
      ...overrides,
    },
  }
}

function toolUse(id: string, name = 'browser_click', input: Record<string, unknown> = {}): ContentBlock {
  return { type: 'tool_use', id, name, input }
}

function userPrompt(text: string): Message {
  return { role: 'user', content: text }
}

function assistantWith(blocks: ContentBlock[]): Message {
  return { role: 'assistant', content: blocks }
}

function userToolResult(blocks: ContentBlock[]): Message {
  return { role: 'user', content: blocks }
}

describe('compactSupersededBrowserSnapshots', () => {
  it('returns empty input unchanged', () => {
    const r = compactSupersededBrowserSnapshots([])
    expect(r).toEqual({ messages: [], droppedCount: 0, bytesReclaimed: 0 })
  })

  it('keeps only the latest snapshot per tab and rewrites older ones', () => {
    // 5 snapshots: tab-A ×4 at indices 2, 4, 8, 11; tab-B ×1 at index 6.
    // keepRecentTurns=1 protects only the current turn (the trailing
    // userPrompt at the end). With keepLatestPerTarget=1, expect:
    //   - tab-A: keep index 11 (newest in scope), rewrite 2/4/8.
    //   - tab-B: keep index 6 (only one).
    // → 3 rewrites total.
    const messages: Message[] = [
      userPrompt('start'),
      assistantWith([toolUse('u1', 'browser_navigate', { url: 'a' })]),
      userToolResult([snapshotResult('u1', 'tab-A')]),
      assistantWith([toolUse('u2')]),
      userToolResult([snapshotResult('u2', 'tab-A')]),
      assistantWith([toolUse('u3', 'browser_tab_open', { url: 'b' })]),
      userToolResult([snapshotResult('u3', 'tab-B')]),
      assistantWith([toolUse('u4')]),
      userToolResult([snapshotResult('u4', 'tab-A')]),
      userPrompt('middle turn'),
      assistantWith([toolUse('u5')]),
      userToolResult([snapshotResult('u5', 'tab-A')]),
      userPrompt('current turn'),
    ]
    const r = compactSupersededBrowserSnapshots(messages, {
      keepLatestPerTarget: 1,
      keepRecentTurns: 1,
    })
    expect(r.droppedCount).toBe(3)
    expect(r.bytesReclaimed).toBeGreaterThan(0)

    // Three older tab-A snapshots (indices 2, 4, 8) are breadcrumbs.
    for (const idx of [2, 4, 8]) {
      const stale = (r.messages[idx] as { content: ContentBlock[] }).content[0]
      if (stale?.type !== 'tool_result') throw new Error('shape')
      expect(stale.content).toContain('compacted — superseded')
      expect(stale.content).not.toContain(BIG)
    }

    // tab-A snapshot at index 11 is the most recent inside the stale
    // pool — it survives verbatim.
    const fresh = (r.messages[11] as { content: ContentBlock[] }).content[0]
    if (fresh?.type !== 'tool_result') throw new Error('shape')
    expect(fresh.content).toContain(BIG)

    // tab-B's only snapshot is untouched.
    const tabB = (r.messages[6] as { content: ContentBlock[] }).content[0]
    if (tabB?.type !== 'tool_result') throw new Error('shape')
    expect(tabB.content).toContain(BIG)
  })

  it('keeps the current turn untouched (keepRecentTurns boundary)', () => {
    // Current turn has the most recent snapshot. keepRecentTurns=1 by
    // default — that snapshot must survive even if a "newer" one
    // wouldn't exist (the cutoff guards the working set).
    const messages: Message[] = [
      userPrompt('first turn'),
      assistantWith([toolUse('u1')]),
      userToolResult([snapshotResult('u1', 'tab-A')]),
      userPrompt('second turn — this is the current turn'),
      assistantWith([toolUse('u2')]),
      userToolResult([snapshotResult('u2', 'tab-A')]),
    ]
    const r = compactSupersededBrowserSnapshots(messages)
    // Only one snapshot is in the stale pool (index 2). The current
    // turn's snapshot (index 5) is past the cutoff, so it isn't
    // counted toward the per-target limit — the stale-pool snapshot
    // is the latest *in scope* and survives.
    expect(r.droppedCount).toBe(0)
  })

  it('never touches non-browser tool results', () => {
    const fileRead: ContentBlock = {
      type: 'tool_result',
      toolUseId: 'u-file',
      content: `file contents:\n${BIG}`,
      isError: false,
      // No metadata at all — typical of filesystem tools.
    }
    const messages: Message[] = [
      userPrompt('start'),
      assistantWith([toolUse('u-file', 'readFile', { path: '/a' })]),
      userToolResult([fileRead]),
      assistantWith([toolUse('u1')]),
      userToolResult([snapshotResult('u1', 'tab-A')]),
      assistantWith([toolUse('u2')]),
      userToolResult([snapshotResult('u2', 'tab-A')]),
      userPrompt('current'),
    ]
    const r = compactSupersededBrowserSnapshots(messages)
    // Only the older snapshot is rewritten — file read survives.
    expect(r.droppedCount).toBe(1)
    const fileStill = (r.messages[2] as { content: ContentBlock[] }).content[0]
    if (fileStill?.type !== 'tool_result') throw new Error('shape')
    expect(fileStill.content).toContain(BIG)
  })

  it('does not rewrite blocks marked supersedable: false', () => {
    const messages: Message[] = [
      userPrompt('start'),
      assistantWith([toolUse('u1')]),
      userToolResult([snapshotResult('u1', 'tab-A', 'big', { supersedable: false })]),
      assistantWith([toolUse('u2')]),
      userToolResult([snapshotResult('u2', 'tab-A')]),
      userPrompt('current'),
    ]
    const r = compactSupersededBrowserSnapshots(messages)
    expect(r.droppedCount).toBe(0)
  })

  it('skips snapshots without a targetId (cannot safely group)', () => {
    const noTarget: ContentBlock = {
      type: 'tool_result',
      toolUseId: 'u1',
      content: BIG,
      isError: false,
      metadata: { kind: 'browser-snapshot', supersedable: true }, // missing targetId
    }
    const messages: Message[] = [
      userPrompt('start'),
      assistantWith([toolUse('u1')]),
      userToolResult([noTarget]),
      assistantWith([toolUse('u2')]),
      userToolResult([snapshotResult('u2', 'tab-A')]),
      userPrompt('current'),
    ]
    const r = compactSupersededBrowserSnapshots(messages)
    expect(r.droppedCount).toBe(0)
  })

  it('preserves cache_control and metadata on rewritten blocks', () => {
    const withCache: ContentBlock = {
      type: 'tool_result',
      toolUseId: 'u1',
      content: BIG,
      isError: false,
      metadata: {
        kind: 'browser-snapshot',
        targetId: 'tab-A',
        supersedable: true,
        url: 'https://example.com',
        title: 'Old',
      },
      cache_control: { type: 'ephemeral' },
    }
    const messages: Message[] = [
      userPrompt('start'),
      assistantWith([toolUse('u1')]),
      userToolResult([withCache]),
      assistantWith([toolUse('u2')]),
      userToolResult([snapshotResult('u2', 'tab-A')]),
      userPrompt('current'),
    ]
    const r = compactSupersededBrowserSnapshots(messages)
    expect(r.droppedCount).toBe(1)
    const rewritten = (r.messages[2] as { content: ContentBlock[] }).content[0]
    if (rewritten?.type !== 'tool_result') throw new Error('shape')
    expect(rewritten.cache_control).toEqual({ type: 'ephemeral' })
    expect(rewritten.metadata).toMatchObject({
      kind: 'browser-snapshot',
      targetId: 'tab-A',
      supersedable: true,
    })
  })

  it('keepLatestPerTarget=2 keeps two snapshots per tab', () => {
    const messages: Message[] = [
      userPrompt('start'),
      assistantWith([toolUse('u1')]),
      userToolResult([snapshotResult('u1', 'tab-A')]), // oldest — drop
      assistantWith([toolUse('u2')]),
      userToolResult([snapshotResult('u2', 'tab-A')]), // 2nd-most-recent — keep
      assistantWith([toolUse('u3')]),
      userToolResult([snapshotResult('u3', 'tab-A')]), // most recent — keep
      userPrompt('current'),
    ]
    const r = compactSupersededBrowserSnapshots(messages, {
      keepLatestPerTarget: 2,
    })
    expect(r.droppedCount).toBe(1)
    const oldest = (r.messages[2] as { content: ContentBlock[] }).content[0]
    if (oldest?.type !== 'tool_result') throw new Error('shape')
    expect(oldest.content).toContain('compacted — superseded')
  })

  it('keepLatestPerTarget=0 compacts every snapshot in the stale pool', () => {
    const messages: Message[] = [
      userPrompt('start'),
      assistantWith([toolUse('u1')]),
      userToolResult([snapshotResult('u1', 'tab-A')]),
      assistantWith([toolUse('u2')]),
      userToolResult([snapshotResult('u2', 'tab-A')]),
      userPrompt('current'),
    ]
    const r = compactSupersededBrowserSnapshots(messages, {
      keepLatestPerTarget: 0,
    })
    expect(r.droppedCount).toBe(2)
  })

  it('does not rewrite snapshots smaller than minBytesToDrop', () => {
    const messages: Message[] = [
      userPrompt('start'),
      assistantWith([toolUse('u1')]),
      userToolResult([snapshotResult('u1', 'tab-A', 'small')]),
      assistantWith([toolUse('u2')]),
      userToolResult([snapshotResult('u2', 'tab-A')]),
      userPrompt('current'),
    ]
    const r = compactSupersededBrowserSnapshots(messages, {
      minBytesToDrop: 500,
    })
    expect(r.droppedCount).toBe(0)
  })

  it('breadcrumb names the tool from the paired tool_use', () => {
    const messages: Message[] = [
      userPrompt('start'),
      assistantWith([toolUse('u1', 'browser_navigate', { url: 'https://a' })]),
      userToolResult([snapshotResult('u1', 'tab-A')]),
      assistantWith([toolUse('u2', 'browser_click')]),
      userToolResult([snapshotResult('u2', 'tab-A')]),
      userPrompt('current'),
    ]
    const r = compactSupersededBrowserSnapshots(messages)
    const stale = (r.messages[2] as { content: ContentBlock[] }).content[0]
    if (stale?.type !== 'tool_result') throw new Error('shape')
    expect(stale.content).toContain('browser_navigate')
    expect(stale.content).toContain('Page tab-A')
    expect(stale.content).toContain('https://example.com/tab-A')
  })

  it('is deterministic — same input yields same output', () => {
    const messages: Message[] = [
      userPrompt('start'),
      assistantWith([toolUse('u1')]),
      userToolResult([snapshotResult('u1', 'tab-A')]),
      assistantWith([toolUse('u2')]),
      userToolResult([snapshotResult('u2', 'tab-A')]),
      userPrompt('current'),
    ]
    const a = compactSupersededBrowserSnapshots(messages)
    const b = compactSupersededBrowserSnapshots(messages)
    expect(JSON.stringify(a.messages)).toBe(JSON.stringify(b.messages))
    expect(a.droppedCount).toBe(b.droppedCount)
  })
})
