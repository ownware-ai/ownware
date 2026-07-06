/**
 * GatewayState event-log persistence tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { GatewayState } from '../../../src/gateway/state.js'
import type { LoomEvent } from '@ownware/loom'

// Explicit per-test db path — a no-arg GatewayState() falls back to the
// OWNWARE_DATA_DIR/~/.ownware default, which a unit test must never touch.
let tmpDir: string
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cortex-state-persist-'))
})
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})
function freshState(): GatewayState {
  return new GatewayState(join(tmpDir, 'test.db'))
}

describe('GatewayState event log', () => {
  it('stores raw events with timestamps', () => {
    const state = freshState()
    const thread = state.createThread('test')
    const event = { type: 'text.delta', text: 'Hello', turnIndex: 0 } as LoomEvent

    state.logEvent(thread.id, event)
    const log = state.getEventLog(thread.id)

    expect(log).toHaveLength(1)
    expect(log[0]!.event).toBe(event)
    expect(log[0]!.ts).toBeGreaterThan(0)
  })

  it('filters by event type', () => {
    const state = freshState()
    const thread = state.createThread('test')

    state.logEvent(thread.id, { type: 'text.delta', text: 'Hi', turnIndex: 0 } as LoomEvent)
    state.logEvent(
      thread.id,
      { type: 'tool.call.start', toolCallId: 'tc1', toolName: 'read', input: {}, turnIndex: 0 } as LoomEvent,
    )
    state.logEvent(thread.id, { type: 'text.delta', text: ' there', turnIndex: 0 } as LoomEvent)

    const filtered = state.getEventLog(thread.id, { type: 'text.delta' })
    expect(filtered).toHaveLength(2)
  })

  it('filters by agentId', () => {
    const state = freshState()
    const thread = state.createThread('test')

    state.logEvent(
      thread.id,
      { type: 'agent.spawn', agentId: 'a1', profileName: 'runner', parentAgentId: null, turnIndex: 0 } as LoomEvent,
    )
    state.logEvent(thread.id, { type: 'text.delta', text: 'Hi', turnIndex: 0 } as LoomEvent)
    state.logEvent(
      thread.id,
      { type: 'agent.complete', agentId: 'a1', result: 'done', durationMs: 100, turnIndex: 0 } as LoomEvent,
    )

    const filtered = state.getEventLog(thread.id, { agentId: 'a1' })
    expect(filtered).toHaveLength(2)
  })

  it('filters by since timestamp', async () => {
    const state = freshState()
    const thread = state.createThread('test')

    state.logEvent(thread.id, { type: 'text.delta', text: 'Old', turnIndex: 0 } as LoomEvent)
    const cutoff = Date.now() + 1
    await new Promise((resolve) => setTimeout(resolve, 5))
    state.logEvent(thread.id, { type: 'text.delta', text: 'New', turnIndex: 0 } as LoomEvent)

    const filtered = state.getEventLog(thread.id, { since: cutoff })
    expect(filtered).toHaveLength(1)
    expect((filtered[0]!.event as { text: string }).text).toBe('New')
  })

  it('respects limit parameter', () => {
    const state = freshState()
    const thread = state.createThread('test')

    for (let i = 0; i < 10; i++) {
      state.logEvent(thread.id, { type: 'text.delta', text: `msg${i}`, turnIndex: 0 } as LoomEvent)
    }

    const limited = state.getEventLog(thread.id, { limit: 3 })
    expect(limited).toHaveLength(3)
    expect((limited[0]!.event as { text: string }).text).toBe('msg7')
  })

  it('enforces max 2000 events per thread', () => {
    const state = freshState()
    const thread = state.createThread('test')

    for (let i = 0; i < 2100; i++) {
      state.logEvent(thread.id, { type: 'text.delta', text: `msg${i}`, turnIndex: 0 } as LoomEvent)
    }

    const log = state.getEventLog(thread.id)
    expect(log.length).toBe(2000)
    expect((log[0]!.event as { text: string }).text).toBe('msg100')
  })

  it('returns empty array for unknown thread', () => {
    const state = freshState()
    expect(state.getEventLog('nonexistent')).toEqual([])
  })

  it('clears event log when thread is deleted', () => {
    const state = freshState()
    const thread = state.createThread('test')
    state.logEvent(thread.id, { type: 'text.delta', text: 'Hi', turnIndex: 0 } as LoomEvent)

    state.deleteThread(thread.id)
    expect(state.getEventLog(thread.id)).toEqual([])
  })
})
