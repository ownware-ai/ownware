/**
 * End-to-end — pruned-thread hydration still renders.
 *
 * This locks the full retention contract across real HTTP endpoints.
 * The flow:
 *
 *   1. Create a thread, write a user message and a full assistant turn
 *      (text, tools, sub-agent, permission, thinking) to the messages
 *      table, and ingest a matching raw agent_events log.
 *   2. Mark the thread terminal and backdate it past the retention
 *      window.
 *   3. POST /api/v1/admin/retention/run to force a prune pass.
 *   4. GET /api/v1/threads/:id/hydrate and assert the full snapshot
 *      still renders (messages survived).
 *   5. GET /api/v1/threads/:id/agents/root/events and assert the SSE
 *      stream closes gracefully instead of hanging — the thread is
 *      terminal and has zero raw events, but the endpoint MUST NOT
 *      leave a client waiting.
 *
 * This is the single test that proves "the client can drop agent_events
 * without losing history" — the whole reason retention exists.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestGateway, type TestGateway } from '../../framework/harness/index.js'
import type { LoomEvent } from '@ownware/loom'

describe('Retention → Hydrate E2E', () => {
  let gw: TestGateway

  beforeAll(async () => {
    gw = await createTestGateway()
  }, 30_000)

  afterAll(async () => {
    await gw.stop()
  })

  it('pruned terminal thread still hydrates from messages; SSE closes gracefully', async () => {
    // ── 1. Seed a thread with a full turn ──────────────────────────────
    const thread = gw.state.createThread('mini', 'archived thread')

    // User message (what run.ts handler would write).
    gw.state.addMessage(thread.id, {
      id: 'msg_user_1',
      role: 'user',
      content: 'explain x',
      timestamp: new Date().toISOString(),
    })

    // Assistant turn with every rich field so we can prove the snapshot
    // is complete after events are gone.
    gw.state.addMessage(thread.id, {
      id: 'msg_asst_1',
      role: 'assistant',
      content: 'here is x',
      thinking: 'planning the answer',
      tools: [{
        name: 'read_file',
        input: { path: '/foo' },
        output: 'contents',
        isError: false,
        durationMs: 12,
      }],
      subAgents: [{
        agentId: 'sub_1',
        profileName: 'helper',
        status: 'completed',
        result: 'ok',
        durationMs: 50,
      }],
      permissions: [{
        toolName: 'shell_exec',
        reason: 'needs shell',
        decision: 'approved',
        zoneLevel: 3,
        zoneName: 'network',
      }],
      usage: { inputTokens: 10, outputTokens: 20 },
      timestamp: new Date().toISOString(),
    })

    // Matching raw events on disk — these get pruned.
    gw.state.eventIngestor.ingestParentEvent(thread.id, { type: 'turn.start', turnIndex: 0, timestamp: Date.now() } as LoomEvent)
    gw.state.eventIngestor.ingestParentEvent(thread.id, { type: 'text.delta', turnIndex: 0, text: 'here is x' } as LoomEvent)
    gw.state.eventIngestor.ingestParentEvent(thread.id, { type: 'turn.end', turnIndex: 0, stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0, model: 'test', costUsd: 0.01 }, timestamp: Date.now() } as LoomEvent)

    // Mark terminal then backdate the raw root events past the
    // retention window. Post-2026-04-22 stream audit, retention keys
    // off `agent_events.created_at` (INTEGER ms) rather than
    // `threads.updated_at`, so the backdate must land on the event
    // rows themselves.
    gw.state.updateThread(thread.id, { status: 'completed' })
    gw.state.rawDatabase.rawMainHandle
      .prepare(`UPDATE agent_events SET created_at = ?
                WHERE thread_id = ? AND agent_id = 'root'`)
      .run(new Date('2020-01-01T00:00:00Z').getTime(), thread.id)

    // ── 2. Force retention ─────────────────────────────────────────────
    const retentionRes = await fetch(
      `${gw.baseUrl}/api/v1/admin/retention/run`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${gw.token}` },
      },
    )
    expect(retentionRes.status).toBe(200)
    const retentionBody = await retentionRes.json() as {
      stats: { threadsPruned: number; rowsDeleted: number }
    }
    expect(retentionBody.stats.threadsPruned).toBe(1)
    expect(retentionBody.stats.rowsDeleted).toBeGreaterThanOrEqual(3)

    // agent_events for this thread should be gone.
    const rawAfter = gw.state.listAgentEvents({
      threadId: thread.id,
      agentId: 'root',
    })
    expect(rawAfter).toEqual([])

    // ── 3. /hydrate must still return the full snapshot ────────────────
    const hydrateRes = await fetch(
      `${gw.baseUrl}/api/v1/threads/${thread.id}/hydrate`,
      { headers: { Authorization: `Bearer ${gw.token}` } },
    )
    expect(hydrateRes.status).toBe(200)
    const hydrate = await hydrateRes.json() as {
      thread: { id: string; status: string }
      messages: Array<{ role: string; content: string; tools?: unknown[]; subAgents?: unknown[]; permissions?: unknown[]; thinking?: string }>
      runningAgentId: string | null
      maxSeq: number
    }

    // Thread metadata survives.
    expect(hydrate.thread.id).toBe(thread.id)
    expect(hydrate.thread.status).toBe('completed')
    // No live runner on a terminal pruned thread.
    expect(hydrate.runningAgentId).toBeNull()
    // No raw events left, so maxSeq is 0.
    expect(hydrate.maxSeq).toBe(0)

    // Messages — every rich field must be intact.
    expect(hydrate.messages).toHaveLength(2)
    const asst = hydrate.messages.find(m => m.role === 'assistant')!
    expect(asst.content).toBe('here is x')
    expect(asst.thinking).toBe('planning the answer')
    expect(asst.tools).toHaveLength(1)
    expect(asst.subAgents).toHaveLength(1)
    expect(asst.permissions).toHaveLength(1)

    // ── 4. SSE on a terminal pruned thread replays then tails ─────────
    //
    // Post-2026-04-22 stream audit (CRITICAL-1 fix): the ROOT agent
    // SSE is the backing socket for a live chat tab and must stay open
    // across terminal-status windows so a follow-up POST /run streams
    // into it — the "second turn stuck" bug was precisely the server
    // unilaterally closing this stream on `thread.status !== 'active'`.
    // We therefore assert the opposite of the old behaviour: stream.start
    // + stream.replay.complete (zero events) arrive, then the stream
    // stays open for the client to close.
    const sseRes = await fetch(
      `${gw.baseUrl}/api/v1/threads/${thread.id}/agents/root/events`,
      { headers: { Authorization: `Bearer ${gw.token}` } },
    )
    expect(sseRes.status).toBe(200)

    const reader = sseRes.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const eventNames: string[] = []
    const start = Date.now()
    // Short deadline on purpose — we expect to see the replay pair
    // quickly and then the stream to stay OPEN (no `done`).
    const deadline = start + 2_000
    try {
      while (Date.now() < deadline) {
        const { done, value } = await Promise.race([
          reader.read(),
          new Promise<{ done: true; value: undefined }>(resolve =>
            setTimeout(() => resolve({ done: true, value: undefined }), 250),
          ),
        ])
        if (done && value === undefined) {
          // Read timeout (we don't end the stream server-side) — loop
          // again until the outer deadline.
          if (eventNames.includes('stream.replay.complete')) break
          continue
        }
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let idx: number
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          if (!block.trim() || block.startsWith(':')) continue
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) eventNames.push(line.slice(7))
          }
        }
      }
    } finally {
      reader.cancel().catch(() => {})
    }

    expect(eventNames).toContain('stream.start')
    expect(eventNames).toContain('stream.replay.complete')
    // Crucially: NO `done` — the root-agent SSE must stay open so the
    // next run can stream into the same socket.
    expect(eventNames).not.toContain('done')
  })
})
