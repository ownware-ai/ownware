/**
 * agent_events retention — prune threads' raw event log by last-event
 * age without touching the `messages` snapshot.
 *
 * These tests lock the safety rails (post-2026-04-22 stream audit
 * CRITICAL-2 fix, where thread.status='active' validly spans idle
 * gaps between turns and is therefore no longer the eligibility
 * signal):
 *   - Threads whose last root-agent event is newer than the cutoff
 *     are never pruned (whether active OR terminal).
 *   - Threads with a live SSE subscriber on the root agent are
 *     skipped.
 *   - The `messages` table survives pruning (the whole point).
 *   - Sub-agent rows (agent_id != 'root') survive pruning.
 *   - Env-gated: default-disabled, opt-in via env.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GatewayState } from '../../../src/gateway/state.js'
import { ROOT_AGENT_ID } from '../../../src/gateway/event-bus.js'
import {
  loadRetentionConfig,
  runRetentionOnce,
  DEFAULT_RETENTION,
} from '../../../src/gateway/retention.js'
import type { LoomEvent } from '@ownware/loom'

function textEvent(text: string): LoomEvent {
  return { type: 'text.delta', text, turnIndex: 0 } as LoomEvent
}

/**
 * Rewrite every root-agent_events row's `created_at` (INTEGER ms
 * epoch) so we can simulate "quiescent for long enough" without
 * waiting real time. The retention query uses a numeric MAX
 * comparison against `cutoffMs`.
 */
function backdateRootEvents(state: GatewayState, threadId: string, ms: number): void {
  state.rawDatabase.rawMainHandle.prepare(
    `UPDATE agent_events SET created_at = ?
     WHERE thread_id = ? AND agent_id = 'root'`,
  ).run(ms, threadId)
}

// Jan 1 2020 in ms — far older than any realistic retentionDays window.
const ANCIENT_MS = new Date('2020-01-01T00:00:00Z').getTime()

describe('agent_events retention', () => {
  let state: GatewayState
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cortex-retention-'))
    state = new GatewayState(join(tmpDir, 'ownware.db'))
  })

  afterEach(() => {
    state.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('loadRetentionConfig defaults to disabled, 7 days', () => {
    const config = loadRetentionConfig({})
    expect(config.enabled).toBe(false)
    expect(config.retentionDays).toBe(DEFAULT_RETENTION.retentionDays)
  })

  it('loadRetentionConfig reads env overrides', () => {
    const config = loadRetentionConfig({
      OWNWARE_EVENT_RETENTION_ENABLED: 'true',
      OWNWARE_EVENT_RETENTION_DAYS: '3',
    } as NodeJS.ProcessEnv)
    expect(config.enabled).toBe(true)
    expect(config.retentionDays).toBe(3)
  })

  it('prunes agent_events for a quiescent thread whose last root event is older than the cutoff', () => {
    const thread = state.createThread('test')
    // Write a few events then mark the thread terminal.
    for (let i = 0; i < 3; i++) {
      state.eventIngestor.ingestParentEvent(thread.id, textEvent(`e${i}`))
    }
    // Snapshot messages must survive.
    state.addMessage(thread.id, {
      id: 'm1', role: 'assistant', content: 'hi',
      timestamp: new Date().toISOString(),
    })
    state.updateThread(thread.id, { status: 'completed' })
    backdateRootEvents(state, thread.id, ANCIENT_MS)

    const stats = runRetentionOnce(state.rawDatabase, state.eventBus, {
      enabled: true,
      retentionDays: 7,
      intervalMs: 0,
    })

    expect(stats.threadsEligible).toBe(1)
    expect(stats.threadsPruned).toBe(1)
    expect(stats.rowsDeleted).toBe(3)

    // Messages table is untouched.
    expect(state.getMessages(thread.id)).toHaveLength(1)
    // Raw events for this thread are gone.
    expect(state.listAgentEvents({ threadId: thread.id, agentId: ROOT_AGENT_ID })).toEqual([])
    // Retention removes replay bytes, not cursor identity. A later turn
    // must continue after the pruned high-water instead of reusing seq 1.
    expect(state.getAgentEventMaxSeq(thread.id, ROOT_AGENT_ID)).toBe(3)
    expect(state.eventIngestor.ingestParentEvent(thread.id, textEvent('later-turn'))).toBe(4)
  })

  it('prunes a stalled active thread (status=active, no root events in the window)', () => {
    // Post-CRITICAL-2 semantic: status='active' is no longer a "do not
    // touch" flag. A thread whose status got flipped to 'active' but
    // then went quiet for >retentionDays is either stuck or abandoned;
    // its raw event log is safe to drop. `messages` survives.
    const thread = state.createThread('test')
    state.eventIngestor.ingestParentEvent(thread.id, textEvent('stalled'))
    // Leave status as 'active' — this is the scenario that pre-fix
    // tests asserted should be untouchable.
    backdateRootEvents(state, thread.id, ANCIENT_MS)

    const stats = runRetentionOnce(state.rawDatabase, state.eventBus, {
      enabled: true,
      retentionDays: 7,
      intervalMs: 0,
    })

    expect(stats.threadsEligible).toBe(1)
    expect(stats.threadsPruned).toBe(1)
    expect(stats.rowsDeleted).toBe(1)
    expect(
      state.listAgentEvents({ threadId: thread.id, agentId: ROOT_AGENT_ID }),
    ).toEqual([])
  })

  it('never prunes a thread whose root events are fresh (active or terminal)', () => {
    // Two threads with recent events — one active, one completed. Both
    // must be untouched. Freshness is the signal; status is not.
    const active = state.createThread('active')
    state.eventIngestor.ingestParentEvent(active.id, textEvent('a'))

    const terminal = state.createThread('terminal')
    state.eventIngestor.ingestParentEvent(terminal.id, textEvent('t'))
    state.updateThread(terminal.id, { status: 'completed' })

    const stats = runRetentionOnce(state.rawDatabase, state.eventBus, {
      enabled: true,
      retentionDays: 7,
      intervalMs: 0,
    })

    expect(stats.threadsEligible).toBe(0)
    expect(stats.rowsDeleted).toBe(0)
    expect(state.listAgentEvents({ threadId: active.id, agentId: ROOT_AGENT_ID })).toHaveLength(1)
    expect(state.listAgentEvents({ threadId: terminal.id, agentId: ROOT_AGENT_ID })).toHaveLength(1)
  })

  it('skips a quiescent thread with a live SSE subscriber on root', () => {
    const thread = state.createThread('test')
    state.eventIngestor.ingestParentEvent(thread.id, textEvent('e1'))
    state.updateThread(thread.id, { status: 'completed' })
    backdateRootEvents(state, thread.id, ANCIENT_MS)

    // Simulate an active SSE reader on the root agent.
    const unsub = state.eventBus.subscribe(thread.id, ROOT_AGENT_ID, () => {})
    try {
      const stats = runRetentionOnce(state.rawDatabase, state.eventBus, {
        enabled: true,
        retentionDays: 7,
        intervalMs: 0,
      })

      expect(stats.threadsEligible).toBe(1)
      expect(stats.threadsSkippedLiveSubscriber).toBe(1)
      expect(stats.threadsPruned).toBe(0)
      expect(
        state.listAgentEvents({ threadId: thread.id, agentId: ROOT_AGENT_ID }),
      ).toHaveLength(1)
    } finally {
      unsub()
    }
  })

  it('preserves sub-agent rows when pruning a quiescent thread', () => {
    const thread = state.createThread('test')
    // Root events — these will be pruned.
    state.eventIngestor.ingestParentEvent(thread.id, textEvent('root-1'))
    state.eventIngestor.ingestParentEvent(thread.id, textEvent('root-2'))
    // Sub-agent events — these must survive.
    state.eventIngestor.ingestSubagentEvent(thread.id, 'sub_helper', textEvent('sub-1'))
    state.eventIngestor.ingestSubagentEvent(thread.id, 'sub_helper', textEvent('sub-2'))

    state.updateThread(thread.id, { status: 'completed' })
    backdateRootEvents(state, thread.id, ANCIENT_MS)

    const stats = runRetentionOnce(state.rawDatabase, state.eventBus, {
      enabled: true,
      retentionDays: 7,
      intervalMs: 0,
    })

    // 2 root rows deleted, 2 sub-agent rows untouched.
    expect(stats.rowsDeleted).toBe(2)
    expect(state.listAgentEvents({ threadId: thread.id, agentId: ROOT_AGENT_ID })).toEqual([])
    const subEvents = state.listAgentEvents({ threadId: thread.id, agentId: 'sub_helper' })
    expect(subEvents).toHaveLength(2)
  })

  it('reports zero when the cutoff is in the future (retentionDays=0 keeps nothing)', () => {
    // Edge case: retentionDays=0 means "prune any thread whose last
    // root event is older than right now." Verifies the cutoff math
    // doesn't misbehave at the boundary.
    const thread = state.createThread('test')
    state.eventIngestor.ingestParentEvent(thread.id, textEvent('e1'))
    state.updateThread(thread.id, { status: 'completed' })
    // Force the event's created_at to be a moment in the past so the
    // strict `<` comparison against "now" matches.
    backdateRootEvents(state, thread.id, Date.now() - 60_000)

    const stats = runRetentionOnce(state.rawDatabase, state.eventBus, {
      enabled: true,
      retentionDays: 0,
      intervalMs: 0,
    })

    expect(stats.rowsDeleted).toBe(1)
  })
})
