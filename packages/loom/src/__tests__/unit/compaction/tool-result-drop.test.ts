/**
 * Unit tests for `dropStaleToolResults` — the tool-result-drop primitive.
 *
 * The contract is deliberately narrow: the function rewrites the BODY
 * of old `tool_result` content blocks. It must never touch `tool_use`
 * blocks, must preserve `toolUseId` pairing, must keep the most recent
 * user turns completely intact, must be deterministic, and must not
 * mutate the input array.
 *
 * Each invariant has its own test. If one of these trips, the fix is to
 * restore the invariant — NOT to loosen the test.
 */

import { describe, it, expect } from 'vitest'
import { dropStaleToolResults } from '../../../compaction/tool-result-drop.js'
import type {
  AssistantMessage,
  Message,
  ToolResultBlock,
  ToolUseBlock,
  UserMessage,
} from '../../../messages/types.js'

// ---------------------------------------------------------------------------
// Fixture helpers — keeping them inline and explicit makes the test
// intent self-evident without hopping through a helpers file.
// ---------------------------------------------------------------------------

function userText(text: string): UserMessage {
  return { role: 'user', content: text }
}

function userToolResult(toolUseId: string, text: string, isError = false): UserMessage {
  const block: ToolResultBlock = {
    type: 'tool_result',
    toolUseId,
    content: text,
    isError,
  }
  return { role: 'user', content: [block] }
}

function assistantToolUse(id: string, name: string, input: Record<string, unknown>): AssistantMessage {
  const block: ToolUseBlock = { type: 'tool_use', id, name, input }
  return { role: 'assistant', content: [block] }
}

function assistantText(text: string): AssistantMessage {
  return { role: 'assistant', content: [{ type: 'text', text }] }
}

const BIG_OUTPUT = 'a'.repeat(5000)
const SMALL_OUTPUT = 'hi'

// ---------------------------------------------------------------------------
// Core behaviour
// ---------------------------------------------------------------------------

describe('dropStaleToolResults', () => {
  it('empty input → empty report, no allocations beyond the bookkeeping', () => {
    const report = dropStaleToolResults([], { keepRecentTurns: 3 })
    expect(report.messages).toEqual([])
    expect(report.droppedCount).toBe(0)
    expect(report.bytesReclaimed).toBe(0)
  })

  it('does nothing when there are fewer user turns than keepRecentTurns', () => {
    // Only 2 user turns exist; keeping 3 means nothing is old enough.
    const input: Message[] = [
      userText('hi'),
      assistantToolUse('t1', 'grep', {}),
      userToolResult('t1', BIG_OUTPUT),
      assistantText('done'),
    ]
    const report = dropStaleToolResults(input, { keepRecentTurns: 3 })
    expect(report.droppedCount).toBe(0)
    expect(report.bytesReclaimed).toBe(0)
    // Structural equality — no tool_result should have been rewritten.
    expect(report.messages).toEqual(input)
  })

  it('replaces big tool_result bodies past the keep window', () => {
    const input: Message[] = [
      userText('turn1-ask'),                        // oldest user turn
      assistantToolUse('t1', 'grep', {}),
      userToolResult('t1', BIG_OUTPUT),             // stale — should drop
      assistantText('turn1-done'),
      userText('turn2-ask'),
      assistantToolUse('t2', 'grep', {}),
      userToolResult('t2', BIG_OUTPUT),             // stale — should drop
      assistantText('turn2-done'),
      userText('turn3-ask'),                        // keep from here (keepRecentTurns=1)
      assistantToolUse('t3', 'grep', {}),
      userToolResult('t3', BIG_OUTPUT),             // recent — KEEP
    ]
    const report = dropStaleToolResults(input, { keepRecentTurns: 1 })
    expect(report.droppedCount).toBe(2)
    expect(report.bytesReclaimed).toBeGreaterThan(8000) // 2 × ~5KB minus placeholders

    // Recent tool_result stays verbatim.
    const last = report.messages[10]! as UserMessage
    const lastContent = last.content as ToolResultBlock[]
    expect(lastContent[0]!.content).toBe(BIG_OUTPUT)

    // Old tool_results were replaced with placeholders — not the original text.
    const old1 = report.messages[2]! as UserMessage
    const old1Block = (old1.content as ToolResultBlock[])[0]!
    expect(typeof old1Block.content).toBe('string')
    expect(old1Block.content).not.toBe(BIG_OUTPUT)
    // Placeholder is self-descriptive: names the kind of drop, the
    // tool, and provides a recovery hint.
    expect(old1Block.content as string).toMatch(/output of grep dropped/)
    expect(old1Block.content as string).toContain('Call the tool again')
    expect(old1Block.toolUseId).toBe('t1')
  })

  it('never modifies tool_use blocks, only tool_result content', () => {
    // Every tool_use block must survive byte-identical so the provider
    // does not 400 on an orphaned call record.
    const toolUse1 = assistantToolUse('t1', 'grep', { pattern: 'foo', path: 'x.ts' })
    const toolUse2 = assistantToolUse('t2', 'readFile', { path: 'y.ts' })

    const input: Message[] = [
      userText('q1'),
      toolUse1,
      userToolResult('t1', BIG_OUTPUT),
      assistantText('ok'),
      userText('q2'),
      toolUse2,
      userToolResult('t2', BIG_OUTPUT),
      assistantText('ok'),
      userText('q3'), // recent boundary
    ]
    const report = dropStaleToolResults(input, { keepRecentTurns: 1 })

    // Both tool_use messages must be ref-equal with the input (we took
    // the untouched-pass fast path).
    expect(report.messages[1]).toBe(toolUse1)
    expect(report.messages[5]).toBe(toolUse2)
  })

  it('preserves toolUseId pairing on every rewritten result', () => {
    const input: Message[] = [
      userText('q'),
      assistantToolUse('tool-abc', 'grep', {}),
      userToolResult('tool-abc', BIG_OUTPUT),
      assistantText('ok'),
      userText('q'),
      assistantToolUse('tool-xyz', 'readFile', {}),
      userToolResult('tool-xyz', BIG_OUTPUT),
      assistantText('ok'),
      userText('recent-boundary'),
    ]
    const report = dropStaleToolResults(input, { keepRecentTurns: 1 })

    // Every tool_use id must still have a matching tool_result with the
    // same toolUseId.
    const toolUseIds: string[] = []
    const toolResultIds: string[] = []
    for (const msg of report.messages) {
      if (!Array.isArray(msg.content)) continue
      for (const block of msg.content) {
        if (block.type === 'tool_use') toolUseIds.push(block.id)
        if (block.type === 'tool_result') toolResultIds.push(block.toolUseId)
      }
    }
    expect(toolResultIds.sort()).toEqual(toolUseIds.sort())
  })

  it('preserves the isError flag on replaced tool_results', () => {
    const input: Message[] = [
      userText('q'),
      assistantToolUse('t1', 'grep', {}),
      userToolResult('t1', BIG_OUTPUT, /* isError */ true),
      assistantText('retry'),
      userText('q2'),
      assistantToolUse('t2', 'grep', {}),
      userToolResult('t2', BIG_OUTPUT, /* isError */ false),
      assistantText('ok'),
      userText('recent-boundary'),
    ]
    const report = dropStaleToolResults(input, { keepRecentTurns: 1 })

    const errBlock = (report.messages[2] as UserMessage).content as ToolResultBlock[]
    expect(errBlock[0]!.isError).toBe(true)
    // Error placeholder is different from the success placeholder so the
    // model can still tell the old call failed.
    expect(errBlock[0]!.content as string).toMatch(/error of grep/)
    expect(errBlock[0]!.content as string).toContain('exact error text')

    const okBlock = (report.messages[6] as UserMessage).content as ToolResultBlock[]
    expect(okBlock[0]!.isError).toBe(false)
    expect(okBlock[0]!.content as string).toMatch(/output of grep/)
    expect(okBlock[0]!.content as string).toContain('full content')
  })

  it('skips tool_results smaller than minBytesToDrop', () => {
    // Small result should pass through untouched — placeholder would be
    // comparable in size to the original, no win.
    const input: Message[] = [
      userText('q'),
      assistantToolUse('t1', 'grep', {}),
      userToolResult('t1', SMALL_OUTPUT),
      assistantText('ok'),
      userText('q2'),
      assistantToolUse('t2', 'grep', {}),
      userToolResult('t2', BIG_OUTPUT),
      assistantText('ok'),
      userText('recent-boundary'),
    ]
    const report = dropStaleToolResults(input, {
      keepRecentTurns: 1,
      minBytesToDrop: 500,
    })
    // Only the big one got dropped; the small one stays verbatim.
    expect(report.droppedCount).toBe(1)
    const smallBlock = (report.messages[2] as UserMessage).content as ToolResultBlock[]
    expect(smallBlock[0]!.content).toBe(SMALL_OUTPUT)
  })

  it('is deterministic — same input → same output', () => {
    const input: Message[] = [
      userText('q'),
      assistantToolUse('t1', 'grep', {}),
      userToolResult('t1', BIG_OUTPUT),
      assistantText('ok'),
      userText('recent'),
    ]
    const a = dropStaleToolResults(input, { keepRecentTurns: 1 })
    const b = dropStaleToolResults(input, { keepRecentTurns: 1 })
    expect(b.messages).toEqual(a.messages)
    expect(b.droppedCount).toBe(a.droppedCount)
    expect(b.bytesReclaimed).toBe(a.bytesReclaimed)
  })

  it('does not mutate the input messages array', () => {
    const input: Message[] = [
      userText('q'),
      assistantToolUse('t1', 'grep', {}),
      userToolResult('t1', BIG_OUTPUT),
      assistantText('ok'),
      userText('recent'),
    ]
    const snapshotJson = JSON.stringify(input)
    dropStaleToolResults(input, { keepRecentTurns: 1 })
    expect(JSON.stringify(input)).toBe(snapshotJson)
  })

  it('treats engine-produced tool_result messages as NOT user turns', () => {
    // A user message whose content is a pure tool_result array is not
    // a real user turn — it is the engine returning the tool output
    // back to the model. The counter must skip those.
    //
    // Here keepRecentTurns=2 means we expect turns 2 and 3 to be kept.
    // If the function miscounted tool_result messages as user turns, the
    // cutoff would land too far forward and the first real stale
    // tool_result at index 2 would NOT be rewritten.
    const input: Message[] = [
      userText('real-q-1'),                 // real turn 1 (stale, keep=2 keeps turns 2+3)
      assistantToolUse('t1', 'grep', {}),
      userToolResult('t1', BIG_OUTPUT),     // NOT a user turn
      assistantText('ok'),
      userText('real-q-2'),                 // real turn 2 — KEEP boundary
      assistantToolUse('t2', 'grep', {}),
      userToolResult('t2', BIG_OUTPUT),     // NOT a user turn; recent → keep
      assistantText('ok'),
      userText('real-q-3'),                 // real turn 3 — KEEP
    ]
    const report = dropStaleToolResults(input, { keepRecentTurns: 2 })
    // Only the first tool_result should have dropped.
    expect(report.droppedCount).toBe(1)
    const dropped = (report.messages[2] as UserMessage).content as ToolResultBlock[]
    expect(dropped[0]!.content as string).toMatch(/output of grep/)
    const kept = (report.messages[6] as UserMessage).content as ToolResultBlock[]
    expect(kept[0]!.content).toBe(BIG_OUTPUT)
  })

  // ---------------------------------------------------------------
  // Placeholder content — tool name + preview
  // ---------------------------------------------------------------

  it('placeholder names the tool and its key arguments', () => {
    // The paired tool_use supplies the name + input; the placeholder
    // should surface both so the model knows which call it was without
    // scanning back.
    const input: Message[] = [
      userText('q'),
      assistantToolUse('t1', 'readFile', { file_path: '/src/foo.ts', limit: 500 }),
      userToolResult('t1', BIG_OUTPUT),
      assistantText('ok'),
      userText('recent'),
    ]
    const report = dropStaleToolResults(input, { keepRecentTurns: 1 })
    const block = (report.messages[2] as UserMessage).content as ToolResultBlock[]
    const placeholder = block[0]!.content as string
    expect(placeholder).toContain('readFile(')
    expect(placeholder).toContain('file_path="/src/foo.ts"')
    // Two args max in the label; the third would be truncated with a
    // "+N more" suffix. Here we have two, so no truncation suffix.
    expect(placeholder).not.toContain('more')
  })

  it('placeholder keeps a head-preview of the original content', () => {
    // The preview gives the model a hint of what was returned without
    // re-fetching. Contract: the first N chars of the original text
    // appear inside the placeholder, with whitespace collapsed.
    const readable = 'export const foo = 42\n\n'.repeat(200) // ~5KB
    const input: Message[] = [
      userText('q'),
      assistantToolUse('t1', 'readFile', { file_path: 'foo.ts' }),
      userToolResult('t1', readable),
      assistantText('ok'),
      userText('recent'),
    ]
    const report = dropStaleToolResults(input, {
      keepRecentTurns: 1,
      previewBytes: 80,
    })
    const block = (report.messages[2] as UserMessage).content as ToolResultBlock[]
    const placeholder = block[0]!.content as string
    expect(placeholder).toContain('Preview:')
    expect(placeholder).toContain('export const foo = 42')
    expect(placeholder).toContain('...')
  })

  it('previewBytes=0 suppresses the preview entirely', () => {
    const readable = 'x'.repeat(5000)
    const input: Message[] = [
      userText('q'),
      assistantToolUse('t1', 'grep', {}),
      userToolResult('t1', readable),
      assistantText('ok'),
      userText('recent'),
    ]
    const report = dropStaleToolResults(input, {
      keepRecentTurns: 1,
      previewBytes: 0,
    })
    const block = (report.messages[2] as UserMessage).content as ToolResultBlock[]
    const placeholder = block[0]!.content as string
    // No Preview segment at all — placeholder is just the kind/size/hint.
    expect(placeholder).not.toContain('Preview')
    expect(placeholder).toMatch(/output of grep dropped/)
  })

  it('falls back to a generic "tool" label when the paired tool_use is missing', () => {
    // Malformed history (tool_result with no matching tool_use). We
    // still want a coherent placeholder — just without the name.
    const input: Message[] = [
      userText('q'),
      // intentionally no assistantToolUse for 't1'
      userToolResult('t1', BIG_OUTPUT),
      assistantText('ok'),
      userText('q2'),
      assistantToolUse('t2', 'grep', {}),
      userToolResult('t2', BIG_OUTPUT),
      assistantText('ok'),
      userText('recent'),
    ]
    const report = dropStaleToolResults(input, { keepRecentTurns: 1 })
    const orphan = (report.messages[1] as UserMessage).content as ToolResultBlock[]
    expect(orphan[0]!.content as string).toContain('output of tool dropped')
  })

  it('skips the rewrite when the placeholder would not be meaningfully smaller', () => {
    // A modestly-sized result (~600 chars) where the placeholder would
    // end up roughly as long as the original — no real win. The break-
    // even heuristic should skip it even though the size crosses
    // `minBytesToDrop`.
    const borderline = 'x'.repeat(600)
    const input: Message[] = [
      userText('q'),
      assistantToolUse('t1', 'grep', { pattern: 'xxx' }),
      userToolResult('t1', borderline),
      assistantText('ok'),
      userText('recent'),
    ]
    const report = dropStaleToolResults(input, {
      keepRecentTurns: 1,
      minBytesToDrop: 500,
      // Preview big enough that the placeholder is near-original-size.
      previewBytes: 400,
    })
    expect(report.droppedCount).toBe(0)
    const block = (report.messages[2] as UserMessage).content as ToolResultBlock[]
    expect(block[0]!.content).toBe(borderline)
  })

  it('keepRecentTurns=0 is silently promoted to 1 (current turn always preserved)', () => {
    // Passing 0 would leak out the tool_result from the turn the model
    // just produced — the one it is reasoning about right now. Floor
    // to 1 so the current turn is always safe.
    const input: Message[] = [
      userText('q-old'),
      assistantToolUse('t1', 'grep', {}),
      userToolResult('t1', BIG_OUTPUT),
      assistantText('ok'),
      userText('q-recent'),
      assistantToolUse('t2', 'grep', {}),
      userToolResult('t2', BIG_OUTPUT),
    ]
    const report = dropStaleToolResults(input, { keepRecentTurns: 0 })
    // First tool_result dropped; second (current turn) kept.
    expect(report.droppedCount).toBe(1)
    const kept = (report.messages[6] as UserMessage).content as ToolResultBlock[]
    expect(kept[0]!.content).toBe(BIG_OUTPUT)
  })
})
