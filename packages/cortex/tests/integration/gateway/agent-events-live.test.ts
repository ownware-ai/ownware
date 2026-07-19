/**
 * Integration test — live tail + replay race for the agent-events SSE endpoint.
 *
 * Runs against a real HTTP gateway but injects events directly via the
 * state.eventIngestor instead of running a live agent. This lets us test
 * the subscribe-before-read race, the drain+tail transition, and the
 * resume-via-?since cursor without burning Anthropic tokens or waiting
 * for an LLM to respond.
 *
 * The scenarios cover the exact sequences the client's "View thread" modal
 * will hit in production:
 *
 *   1. Connect AFTER the agent finished — pure replay from disk
 *   2. Connect WHILE events are still being ingested — replay + live tail
 *   3. Connect, read some events, reconnect with `?since=N` — resume
 *   4. Two concurrent modals on the same subagent — both receive every event
 *
 * This test complements the LLM-backed journey test by focusing on the
 * merge-logic edge cases that are impractical to trigger with a real
 * model (exact seq cursor positioning, concurrent subscribers, etc.).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { createTestGateway, type TestGateway } from '../../framework/harness/index.js'
import { ROOT_AGENT_ID } from '../../../src/gateway/event-bus.js'
import type { LoomEvent } from '@ownware/loom'

/**
 * Read an SSE stream over raw fetch, returning all events until the
 * server closes OR a bounded timeout elapses. We also accept an optional
 * early-exit predicate that lets the test stop reading once it has seen
 * the events it cares about (so we don't wait 60s for the idle close).
 */
async function readSSEWithTimeout(
  res: Response,
  opts: {
    maxMs: number
    exitWhen?: (collected: Array<{ event: string; data: unknown }>) => boolean
  },
): Promise<Array<{ event: string; data: unknown }>> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  const collected: Array<{ event: string; data: unknown }> = []
  let buffer = ''
  const start = Date.now()

  try {
    while (Date.now() - start < opts.maxMs) {
      const remainingMs = opts.maxMs - (Date.now() - start)
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>(resolve =>
          setTimeout(
            () => resolve({ done: true, value: undefined }),
            Math.min(remainingMs, 250),
          ),
        ),
      ])
      if (done) {
        if (value === undefined) {
          // Timed out this round — check exit condition, keep going if
          // we should, otherwise bail.
          if (opts.exitWhen && opts.exitWhen(collected)) break
          continue
        }
        break
      }
      if (value) buffer += decoder.decode(value, { stream: true })

      // Extract complete \n\n-delimited blocks
      let idx: number
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        if (!block.trim() || block.startsWith(':')) continue
        const lines = block.split('\n')
        let eventName = 'message'
        let dataStr = ''
        for (const line of lines) {
          if (line.startsWith('event: ')) eventName = line.slice(7)
          else if (line.startsWith('data: ')) dataStr = line.slice(6)
        }
        if (dataStr) {
          try {
            collected.push({ event: eventName, data: JSON.parse(dataStr) })
          } catch {
            collected.push({ event: eventName, data: dataStr })
          }
        }
      }

      if (opts.exitWhen && opts.exitWhen(collected)) break
    }
  } finally {
    try {
      reader.releaseLock()
      await res.body!.cancel()
    } catch {
      /* already released / cancelled */
    }
  }

  return collected
}

/** Make a LoomEvent of type text.delta. */
function textDelta(text: string): LoomEvent {
  return { type: 'text.delta', text, turnIndex: 0 } as LoomEvent
}

/** Make a LoomEvent of type turn.end (closes a turn). */
function turnEnd(): LoomEvent {
  return {
    type: 'turn.end',
    turnIndex: 0,
    stopReason: 'end_turn',
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      model: 'mock',
      costUsd: 0,
    },
    timestamp: Date.now(),
  } as unknown as LoomEvent
}

describe('Agent events SSE — live tail + replay', () => {
  let gw: TestGateway
  let threadId: string

  beforeAll(async () => {
    gw = await createTestGateway()
    // We don't run any actual agents, so a bare thread with no profile
    // is fine — the SSE handler only checks that the thread row exists.
    const thread = gw.state.createThread('mini')
    threadId = thread.id
  }, 30_000)

  afterAll(async () => {
    await gw.stop()
  })

  it('pure replay: connect after events are on disk, SSE emits them in order', async () => {
    const agentId = 'agent_replay_only'
    for (let i = 0; i < 5; i++) {
      gw.state.eventIngestor.ingestSubagentEvent(threadId, agentId, textDelta(`r${i}`))
    }

    const res = await fetch(
      `${gw.baseUrl}/api/v1/threads/${threadId}/agents/${agentId}/events`,
      { headers: { Authorization: `Bearer ${gw.token}` } },
    )
    expect(res.status).toBe(200)

    // Exit as soon as we've seen 5 text.deltas plus the start envelope.
    const events = await readSSEWithTimeout(res, {
      maxMs: 5_000,
      exitWhen: evts =>
        evts.filter(e => e.event === 'text.delta').length >= 5 &&
        evts.some(e => e.event === 'stream.replay.complete'),
    })

    expect(events[0]!.event).toBe('stream.start')
    expect(events[0]!.data).toEqual({
      type: 'stream.start',
      threadId,
      agentId,
      since: 0,
      maxSeqAtStart: 5,
    })
    const deltas = events.filter(e => e.event === 'text.delta')
    expect(deltas).toHaveLength(5)
    expect(deltas.map(d => (d.data as { text: string }).text)).toEqual([
      'r0', 'r1', 'r2', 'r3', 'r4',
    ])
    expect(events.at(-1)?.event).toBe('stream.replay.complete')
    expect(events.at(-1)?.data).toEqual({
      type: 'stream.replay.complete',
      threadId,
      agentId,
      since: 0,
      replayedThroughSeq: 5,
      maxSeqAtStart: 5,
      liveTail: false,
    })
  })

  it('live tail: events ingested AFTER the SSE connection opens are forwarded', async () => {
    const agentId = 'agent_live_tail'
    // Seed two events on disk before the connection opens (these test
    // the replay half), then after connecting push three more live.
    gw.state.eventIngestor.ingestSubagentEvent(threadId, agentId, textDelta('pre-0'))
    gw.state.eventIngestor.ingestSubagentEvent(threadId, agentId, textDelta('pre-1'))

    const res = await fetch(
      `${gw.baseUrl}/api/v1/threads/${threadId}/agents/${agentId}/events`,
      { headers: { Authorization: `Bearer ${gw.token}` } },
    )
    expect(res.status).toBe(200)

    // Give the handler a moment to subscribe + replay the seed events,
    // then push the live events. We want the live events to arrive
    // through the bus, not the replay path.
    const livePushPromise = new Promise<void>(resolve => {
      setTimeout(() => {
        gw.state.eventIngestor.ingestSubagentEvent(threadId, agentId, textDelta('live-0'))
        gw.state.eventIngestor.ingestSubagentEvent(threadId, agentId, textDelta('live-1'))
        gw.state.eventIngestor.ingestSubagentEvent(threadId, agentId, textDelta('live-2'))
        resolve()
      }, 200)
    })

    const events = await readSSEWithTimeout(res, {
      maxMs: 6_000,
      exitWhen: evts =>
        evts.filter(e => e.event === 'text.delta').length >= 5 &&
        evts.some(e => e.event === 'stream.replay.complete'),
    })

    await livePushPromise

    const deltas = events.filter(e => e.event === 'text.delta')
    const texts = deltas.map(d => (d.data as { text: string }).text)

    // All 5 events must appear, in exact order. Replay first, live second.
    // If live events were forwarded before replay finished, we'd see
    // live before pre — ordering verifies the drain logic.
    expect(texts).toEqual(['pre-0', 'pre-1', 'live-0', 'live-1', 'live-2'])
    const replayCompleteIndex = events.findIndex(e => e.event === 'stream.replay.complete')
    const firstLiveIndex = events.findIndex(
      e => e.event === 'text.delta' && (e.data as { text: string }).text === 'live-0',
    )
    expect(replayCompleteIndex).toBeGreaterThanOrEqual(0)
    expect(firstLiveIndex).toBeGreaterThan(replayCompleteIndex)
  })

  it('resume: connecting with ?since=N skips events already seen', async () => {
    const agentId = 'agent_resume_cursor'
    for (let i = 0; i < 6; i++) {
      gw.state.eventIngestor.ingestSubagentEvent(threadId, agentId, textDelta(`v${i}`))
    }

    // The agent now has seq 1..6 on disk. Reconnect with since=3 —
    // we should see only seq 4..6.
    const res = await fetch(
      `${gw.baseUrl}/api/v1/threads/${threadId}/agents/${agentId}/events?since=3`,
      { headers: { Authorization: `Bearer ${gw.token}` } },
    )
    expect(res.status).toBe(200)

    const events = await readSSEWithTimeout(res, {
      maxMs: 5_000,
      exitWhen: evts =>
        evts.filter(e => e.event === 'text.delta').length >= 3 &&
        evts.some(e => e.event === 'stream.replay.complete'),
    })

    // The start envelope reports the requested cursor.
    expect(events[0]!.event).toBe('stream.start')
    const envelope = events[0]!.data as {
      type: string
      since: number
      maxSeqAtStart: number
    }
    expect(envelope.type).toBe('stream.start')
    expect(envelope.since).toBe(3)
    expect(envelope.maxSeqAtStart).toBe(6)

    const deltas = events.filter(e => e.event === 'text.delta')
    expect(deltas.map(d => (d.data as { text: string }).text)).toEqual(['v3', 'v4', 'v5'])
    expect(events.at(-1)?.data).toEqual({
      type: 'stream.replay.complete',
      threadId,
      agentId,
      since: 3,
      replayedThroughSeq: 6,
      maxSeqAtStart: 6,
      liveTail: false,
    })
  })

  it('rejects a malformed legacy thread cursor instead of replaying from zero', async () => {
    const agentId = 'agent_invalid_cursor'
    gw.state.eventIngestor.ingestSubagentEvent(threadId, agentId, textDelta('must-not-replay'))

    const res = await fetch(
      `${gw.baseUrl}/api/v1/threads/${threadId}/agents/${agentId}/events?since=not-a-cursor`,
      { headers: { Authorization: `Bearer ${gw.token}` } },
    )

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      error: 'cursor_invalid',
      category: 'invalid_request',
    })
  })

  it('resume: since=max-seq returns no existing events, still tails live', async () => {
    const agentId = 'agent_resume_at_tail'
    for (let i = 0; i < 3; i++) {
      gw.state.eventIngestor.ingestSubagentEvent(threadId, agentId, textDelta(`t${i}`))
    }

    const res = await fetch(
      `${gw.baseUrl}/api/v1/threads/${threadId}/agents/${agentId}/events?since=3`,
      { headers: { Authorization: `Bearer ${gw.token}` } },
    )
    expect(res.status).toBe(200)

    // After connecting, push one new event — we should only see that one.
    setTimeout(() => {
      gw.state.eventIngestor.ingestSubagentEvent(threadId, agentId, textDelta('new-after'))
    }, 200)

    const events = await readSSEWithTimeout(res, {
      maxMs: 4_000,
      exitWhen: evts =>
        evts.filter(e => e.event === 'text.delta').length >= 1 &&
        evts.some(e => e.event === 'stream.replay.complete'),
    })

    const deltas = events.filter(e => e.event === 'text.delta')
    expect(deltas.map(d => (d.data as { text: string }).text)).toEqual(['new-after'])
  })

  it('replay boundary marks liveTail=true when the thread still has an active runtime', async () => {
    const agentId = 'agent_live_runtime'
    gw.state.eventIngestor.ingestSubagentEvent(threadId, agentId, textDelta('seed'))
    gw.state.setRuntime(threadId, {} as any)

    const res = await fetch(
      `${gw.baseUrl}/api/v1/threads/${threadId}/agents/${agentId}/events`,
      { headers: { Authorization: `Bearer ${gw.token}` } },
    )
    expect(res.status).toBe(200)

    const events = await readSSEWithTimeout(res, {
      maxMs: 4_000,
      exitWhen: evts => evts.some(e => e.event === 'stream.replay.complete'),
    })

    const replayComplete = events.find(e => e.event === 'stream.replay.complete')
    expect(replayComplete?.data).toEqual({
      type: 'stream.replay.complete',
      threadId,
      agentId,
      since: 0,
      replayedThroughSeq: 1,
      maxSeqAtStart: 1,
      liveTail: true,
    })

    gw.state.deleteRuntime(threadId)
  })

  it('concurrent subscribers: two SSE streams on the same agent both get every event', async () => {
    const agentId = 'agent_concurrent'
    gw.state.eventIngestor.ingestSubagentEvent(threadId, agentId, textDelta('seed-0'))
    gw.state.eventIngestor.ingestSubagentEvent(threadId, agentId, textDelta('seed-1'))

    const url = `${gw.baseUrl}/api/v1/threads/${threadId}/agents/${agentId}/events`
    const headers = { Authorization: `Bearer ${gw.token}` }

    // Open both connections FIRST so their subscribe() happens before
    // any live events are published. In production the modal and a
    // separate consumer might both be viewing the same agent.
    const [res1, res2] = await Promise.all([
      fetch(url, { headers }),
      fetch(url, { headers }),
    ])
    expect(res1.status).toBe(200)
    expect(res2.status).toBe(200)

    setTimeout(() => {
      gw.state.eventIngestor.ingestSubagentEvent(threadId, agentId, textDelta('live-0'))
      gw.state.eventIngestor.ingestSubagentEvent(threadId, agentId, textDelta('live-1'))
    }, 200)

    const [events1, events2] = await Promise.all([
      readSSEWithTimeout(res1, {
        maxMs: 5_000,
        exitWhen: evts => evts.filter(e => e.event === 'text.delta').length >= 4,
      }),
      readSSEWithTimeout(res2, {
        maxMs: 5_000,
        exitWhen: evts => evts.filter(e => e.event === 'text.delta').length >= 4,
      }),
    ])

    const texts1 = events1.filter(e => e.event === 'text.delta').map(d => (d.data as { text: string }).text)
    const texts2 = events2.filter(e => e.event === 'text.delta').map(d => (d.data as { text: string }).text)

    // Both consumers see the same 4 events in the same order.
    expect(texts1).toEqual(['seed-0', 'seed-1', 'live-0', 'live-1'])
    expect(texts2).toEqual(['seed-0', 'seed-1', 'live-0', 'live-1'])
  })

  it('root-agent SSE on a terminal thread tails (no `done`) — keeps the chat tab live across turns', async () => {
    // Regression: the "second turn stuck" bug. Pre-fix, the handler
    // emitted `done` at end of replay whenever thread.status !== 'active'
    // and the client stopped reconnecting — so the next POST /run streamed
    // into a closed socket. Root-agent SSE must stay open on terminal
    // threads until the client closes.
    const localGw = await createTestGateway()
    try {
      const thread = localGw.state.createThread('mini')
      // Simulate a completed prior run by flipping the thread to
      // 'completed' BEFORE the SSE opens. Then push one event so replay
      // has something to deliver.
      localGw.state.updateThread(thread.id, { status: 'completed' })
      localGw.state.eventIngestor.ingestParentEvent(thread.id, textDelta('prior-turn-0'))

      const res = await fetch(
        `${localGw.baseUrl}/api/v1/threads/${thread.id}/agents/${ROOT_AGENT_ID}/events`,
        { headers: { Authorization: `Bearer ${localGw.token}` } },
      )
      expect(res.status).toBe(200)

      const events = await readSSEWithTimeout(res, {
        maxMs: 2_500,
        exitWhen: evts => evts.some(e => e.event === 'stream.replay.complete'),
      })

      // Replay completes…
      expect(events.some(e => e.event === 'stream.replay.complete')).toBe(true)
      // …and critically, `done` is NOT emitted. The stream stays open
      // waiting for the next turn's events.
      expect(events.some(e => e.event === 'done')).toBe(false)
    } finally {
      await localGw.stop()
    }
  })

  it('sub-agent SSE on a terminal thread still emits `done` after replay', async () => {
    // Preserves the modal close-after-replay UX. Sub-agent lifecycle is
    // bounded by its parent turn; once the thread is terminal there is
    // no runtime and no future events. The modal should close promptly.
    const localGw = await createTestGateway()
    try {
      const thread = localGw.state.createThread('mini')
      const agentId = 'sub_agent_terminal'
      localGw.state.eventIngestor.ingestSubagentEvent(thread.id, agentId, textDelta('s0'))
      localGw.state.eventIngestor.ingestSubagentEvent(thread.id, agentId, textDelta('s1'))
      localGw.state.updateThread(thread.id, { status: 'completed' })

      const res = await fetch(
        `${localGw.baseUrl}/api/v1/threads/${thread.id}/agents/${agentId}/events`,
        { headers: { Authorization: `Bearer ${localGw.token}` } },
      )
      expect(res.status).toBe(200)

      const events = await readSSEWithTimeout(res, {
        maxMs: 3_000,
        exitWhen: evts => evts.some(e => e.event === 'done'),
      })

      expect(events.some(e => e.event === 'stream.replay.complete')).toBe(true)
      const done = events.find(e => e.event === 'done')
      expect(done).toBeDefined()
      expect(done?.data).toEqual({ type: 'done', status: 'complete' })
    } finally {
      await localGw.stop()
    }
  })

  it('root-agent SSE on a terminal thread picks up a newly-ingested event live (second-turn scenario)', async () => {
    // End-to-end proof of the fix: terminal thread + open root SSE +
    // late-arriving event = the client receives it. This is the shape
    // of the "turn 2 on an existing thread" flow once Slice 2 also
    // lands (status flips back to 'active'); even in the intermediate
    // state where status is still 'completed', root SSE must deliver.
    const localGw = await createTestGateway()
    try {
      const thread = localGw.state.createThread('mini')
      localGw.state.updateThread(thread.id, { status: 'completed' })

      const res = await fetch(
        `${localGw.baseUrl}/api/v1/threads/${thread.id}/agents/${ROOT_AGENT_ID}/events`,
        { headers: { Authorization: `Bearer ${localGw.token}` } },
      )
      expect(res.status).toBe(200)

      // After replay finishes, ingest a live event. Pre-fix this would
      // never arrive because the server already closed the socket.
      setTimeout(() => {
        localGw.state.eventIngestor.ingestParentEvent(thread.id, textDelta('turn2-delta'))
      }, 200)

      const events = await readSSEWithTimeout(res, {
        maxMs: 3_000,
        exitWhen: evts =>
          evts.some(
            e =>
              e.event === 'text.delta' &&
              (e.data as { text: string }).text === 'turn2-delta',
          ),
      })

      const deltas = events.filter(e => e.event === 'text.delta')
      expect(deltas.map(d => (d.data as { text: string }).text)).toContain('turn2-delta')
      expect(events.some(e => e.event === 'done')).toBe(false)
    } finally {
      await localGw.stop()
    }
  })

  it('404 when the thread does not exist', async () => {
    const res = await fetch(
      `${gw.baseUrl}/api/v1/threads/nonexistent/agents/agent_foo/events`,
      { headers: { Authorization: `Bearer ${gw.token}` } },
    )
    expect(res.status).toBe(404)
  })

  it('emits stream.shutdown before gateway stop closes the SSE stream', async () => {
    const localGw = await createTestGateway()
    try {
      const thread = localGw.state.createThread('mini')
      const agentId = ROOT_AGENT_ID

      const res = await fetch(
        `${localGw.baseUrl}/api/v1/threads/${thread.id}/agents/${agentId}/events`,
        { headers: { Authorization: `Bearer ${localGw.token}` } },
      )
      expect(res.status).toBe(200)

      const stopPromise = new Promise<void>(resolve => {
        setTimeout(() => {
          void localGw.stop().then(() => resolve())
        }, 50)
      })

      const events = await readSSEWithTimeout(res, {
        maxMs: 5_000,
        exitWhen: evts => evts.some(e => e.event === 'stream.shutdown'),
      })

      await stopPromise

      const shutdown = events.find(e => e.event === 'stream.shutdown')
      expect(shutdown?.data).toEqual({
        type: 'stream.shutdown',
        threadId: thread.id,
        agentId,
        reason: 'gateway_shutdown',
        retryAfterMs: 5000,
      })
    } finally {
      await localGw.stop()
    }
  })

  it('sanitizes internal replay failures before emitting a legacy stream error', async () => {
    const agentId = 'agent_sanitized_error'
    const canary = 'secret-path-/private/customer.db'
    const listSpy = vi.spyOn(gw.state, 'listAgentEvents')
      .mockImplementationOnce(() => {
        throw new Error(canary)
      })

    try {
      const res = await fetch(
        `${gw.baseUrl}/api/v1/threads/${threadId}/agents/${agentId}/events`,
        { headers: { Authorization: `Bearer ${gw.token}` } },
      )
      expect(res.status).toBe(200)

      const events = await readSSEWithTimeout(res, {
        maxMs: 3_000,
        exitWhen: evts => evts.some(e => e.event === 'error'),
      })
      const error = events.find(e => e.event === 'error')
      expect(error?.data).toMatchObject({
        type: 'error',
        code: 'stream_error',
        message: 'Event stream failed',
        recoverable: false,
      })
      expect(JSON.stringify(events)).not.toContain(canary)
    } finally {
      listSpy.mockRestore()
    }
  })

  it('history endpoint: JSON dump matches what the SSE stream replays', async () => {
    const agentId = 'agent_history_dump'
    for (let i = 0; i < 4; i++) {
      gw.state.eventIngestor.ingestSubagentEvent(threadId, agentId, textDelta(`h${i}`))
    }
    gw.state.eventIngestor.ingestSubagentEvent(threadId, agentId, turnEnd())

    const histRes = await gw.client.get<{
      count: number
      maxSeq: number
      events: Array<{ seq: number; type: string; payload: { text?: string } }>
    }>(
      `/api/v1/threads/${threadId}/agents/${agentId}/events/history`,
    )
    expect(histRes.status).toBe(200)
    expect(histRes.body.count).toBe(5)
    expect(histRes.body.maxSeq).toBe(5)
    expect(histRes.body.events[0]!.type).toBe('text.delta')
    expect(histRes.body.events[4]!.type).toBe('turn.end')
  })

  it('listThreadAgents groups events by agent_id', async () => {
    // Reuse the thread — it already has many agents from the tests above.
    const listRes = await gw.client.get<{
      threadId: string
      count: number
      agents: Array<{ agentId: string; eventCount: number }>
    }>(
      `/api/v1/threads/${threadId}/agents`,
    )
    expect(listRes.status).toBe(200)
    expect(listRes.body.count).toBeGreaterThanOrEqual(5) // at least the ones we created

    const byId = new Map(listRes.body.agents.map(a => [a.agentId, a]))
    expect(byId.has('agent_replay_only')).toBe(true)
    expect(byId.has('agent_live_tail')).toBe(true)
    expect(byId.has('agent_resume_cursor')).toBe(true)
    // Root agent may also be present if anything landed there from
    // lifecycle rewrites above — but we only pushed text.delta events
    // (non-lifecycle), so root should have 0 rows and NOT appear.
    expect(byId.has(ROOT_AGENT_ID)).toBe(false)

    // Counts match what we inserted earlier.
    expect(byId.get('agent_replay_only')!.eventCount).toBe(5)
    expect(byId.get('agent_resume_cursor')!.eventCount).toBe(6)
  })
})
