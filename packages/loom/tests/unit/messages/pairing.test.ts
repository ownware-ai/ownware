import { describe, it, expect } from 'vitest'
import {
  findOrphanToolResults,
  preserveToolCallPairing,
  assertPairing,
} from '../../../src/messages/pairing.js'
import {
  systemMsg,
  userMsg,
  assistantMsg,
  assistantToolUseMsg,
  userToolResultMsg,
} from '../../helpers/fixtures.js'
import type { Message } from '../../../src/messages/types.js'

describe('findOrphanToolResults', () => {
  it('returns [] when every tool_result has a matching tool_use', () => {
    const messages: Message[] = [
      userMsg('hi'),
      assistantToolUseMsg('readFile', { path: '/x' }, 'call_1'),
      userToolResultMsg('call_1', 'contents'),
      assistantMsg('done'),
    ]
    expect(findOrphanToolResults(messages)).toEqual([])
  })

  it('returns the orphan id when tool_use is missing', () => {
    const messages: Message[] = [
      userToolResultMsg('call_missing', 'orphaned content'),
      assistantMsg('done'),
    ]
    expect(findOrphanToolResults(messages)).toEqual(['call_missing'])
  })

  it('returns multiple orphans in first-appearance order', () => {
    const messages: Message[] = [
      userToolResultMsg('call_a', 'a'),
      userToolResultMsg('call_b', 'b'),
      assistantMsg('text'),
      userToolResultMsg('call_a', 'duplicate id, only counted once'),
    ]
    expect(findOrphanToolResults(messages)).toEqual(['call_a', 'call_b'])
  })

  it('does NOT report a tool_result as orphan when its tool_use is in a parallel-call assistant message earlier', () => {
    const parallelCall: Message = {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'call_a', name: 'readFile', input: {} },
        { type: 'tool_use', id: 'call_b', name: 'readFile', input: {} },
      ],
    }
    const bundledResults: Message = {
      role: 'user',
      content: [
        { type: 'tool_result', toolUseId: 'call_a', content: 'A', isError: false },
        { type: 'tool_result', toolUseId: 'call_b', content: 'B', isError: false },
      ],
    }
    expect(findOrphanToolResults([parallelCall, bundledResults])).toEqual([])
  })
})

describe('preserveToolCallPairing', () => {
  it('is a no-op when retained slice already contains all matching tool_uses', () => {
    const all: Message[] = [
      userMsg('q1'),
      assistantToolUseMsg('readFile', {}, 'call_1'),
      userToolResultMsg('call_1', 'r1'),
      assistantMsg('done'),
    ]
    const retained = all.slice() // entire window
    expect(preserveToolCallPairing(retained, all)).toEqual(retained)
  })

  it('pulls back the assistant tool_use message when only the tool_result was retained', () => {
    const all: Message[] = [
      userMsg('older'),
      assistantToolUseMsg('readFile', { path: '/big' }, 'call_big'),
      userToolResultMsg('call_big', '...100KB...'),
      assistantMsg('summary text'),
      userMsg('newer'),
    ]
    // Simulate slice(-3): drops `userMsg('older')` AND the assistant tool_use
    const retained = all.slice(-3)
    // Pairing should re-introduce the assistant tool_use
    const repaired = preserveToolCallPairing(retained, all)
    expect(repaired).toHaveLength(4)
    expect(repaired[0]).toBe(all[1]) // the assistant tool_use, pulled back
    expect(repaired[1]).toBe(all[2]) // the tool_result
    expect(repaired[2]).toBe(all[3]) // assistant summary
    expect(repaired[3]).toBe(all[4]) // newer user msg
    expect(findOrphanToolResults(repaired)).toEqual([])
  })

  it('handles parallel tool calls — pulling one assistant message restores N tool_results', () => {
    const parallelCall: Message = {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'a', name: 'readFile', input: {} },
        { type: 'tool_use', id: 'b', name: 'readFile', input: {} },
        { type: 'tool_use', id: 'c', name: 'readFile', input: {} },
      ],
    }
    const bundledResults: Message = {
      role: 'user',
      content: [
        { type: 'tool_result', toolUseId: 'a', content: 'A', isError: false },
        { type: 'tool_result', toolUseId: 'b', content: 'B', isError: false },
        { type: 'tool_result', toolUseId: 'c', content: 'C', isError: false },
      ],
    }
    const all: Message[] = [userMsg('q'), parallelCall, bundledResults, assistantMsg('ok')]
    const retained = all.slice(-2) // bundledResults + assistantMsg
    const repaired = preserveToolCallPairing(retained, all)
    expect(repaired).toHaveLength(3)
    expect(repaired[0]).toBe(parallelCall)
    expect(findOrphanToolResults(repaired)).toEqual([])
  })

  it('drops orphan tool_result blocks when no matching tool_use exists anywhere', () => {
    const retained: Message[] = [
      userToolResultMsg('ghost_call', 'orphan'),
      assistantMsg('continued'),
    ]
    const repaired = preserveToolCallPairing(retained, retained)
    // The user message had only the orphan block → message itself is dropped.
    expect(repaired).toEqual([assistantMsg('continued')])
  })

  it('preserves non-orphan tool_result blocks inside a user message that also has an orphan', () => {
    const goodCall = assistantToolUseMsg('readFile', {}, 'good')
    const mixed: Message = {
      role: 'user',
      content: [
        { type: 'tool_result', toolUseId: 'good', content: 'kept', isError: false },
        { type: 'tool_result', toolUseId: 'ghost', content: 'orphan', isError: false },
      ],
    }
    const retained: Message[] = [goodCall, mixed, assistantMsg('done')]
    const repaired = preserveToolCallPairing(retained, retained)
    expect(repaired).toHaveLength(3)
    const repairedMixed = repaired[1]!
    expect(repairedMixed.role).toBe('user')
    const blocks = Array.isArray(repairedMixed.content) ? repairedMixed.content : []
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ type: 'tool_result', toolUseId: 'good' })
  })

  it('preserves order from allMessages when reinserting', () => {
    const a = assistantToolUseMsg('readFile', {}, 'a')
    const ra = userToolResultMsg('a', 'A')
    const mid = assistantMsg('thinking')
    const b = assistantToolUseMsg('readFile', {}, 'b')
    const rb = userToolResultMsg('b', 'B')
    const tail = assistantMsg('done')
    const all: Message[] = [userMsg('q'), a, ra, mid, b, rb, tail]
    // Retain only the two tool_results + tail (both orphaned)
    const retained = [ra, rb, tail]
    const repaired = preserveToolCallPairing(retained, all)
    expect(repaired.map(m => all.indexOf(m))).toEqual([1, 2, 4, 5, 6])
  })

  it('keeps retained system messages where they are', () => {
    const system = systemMsg('sys')
    const a = assistantToolUseMsg('readFile', {}, 'a')
    const ra = userToolResultMsg('a', 'A')
    const all: Message[] = [system, userMsg('q'), a, ra, assistantMsg('done')]
    const retained = [system, ra, assistantMsg('done')]
    const repaired = preserveToolCallPairing(retained, all)
    expect(repaired[0]).toBe(system)
    expect(findOrphanToolResults(repaired)).toEqual([])
  })
})

describe('assertPairing', () => {
  it('does not throw on valid conversation', () => {
    const messages: Message[] = [
      userMsg('q'),
      assistantToolUseMsg('readFile', {}, 'call_1'),
      userToolResultMsg('call_1', 'ok'),
    ]
    expect(() => assertPairing(messages)).not.toThrow()
  })

  it('throws with the offending tool_use_id when invariant is broken', () => {
    const messages: Message[] = [userToolResultMsg('call_orphan', 'oops')]
    expect(() => assertPairing(messages)).toThrow(/call_orphan/)
    expect(() => assertPairing(messages)).toThrow(/orphan tool_result/)
  })

  it('lists up to 3 ids with a "+N more" suffix when there are many', () => {
    const messages: Message[] = [
      userToolResultMsg('a', 'x'),
      userToolResultMsg('b', 'x'),
      userToolResultMsg('c', 'x'),
      userToolResultMsg('d', 'x'),
      userToolResultMsg('e', 'x'),
    ]
    expect(() => assertPairing(messages)).toThrow(/a, b, c, \+2 more/)
  })
})
