/**
 * Agent event replay + live tail handlers.
 *
 * These power the client's "View thread" modal for sub-agents and, in the
 * future, any secondary consumer that needs to replay a parent or child
 * agent's full event log.
 *
 * Two endpoints are exposed:
 *
 *   GET /api/v1/threads/:threadId/agents/:agentId/events
 *     → Long-lived SSE stream. Replays the DB from `?since=N` (default 0)
 *       then tails the EventBus for live events until the client
 *       disconnects or the agent completes. This is the modal's primary
 *       interface.
 *
 *   GET /api/v1/threads/:threadId/agents/:agentId/events/history
 *     → JSON snapshot of every event currently on disk. Used by tests,
 *       admin tools, and any consumer that wants a one-shot view without
 *       opening an SSE connection.
 *
 * The SSE handler implements the subscribe-before-read race guarantee:
 *
 *   1. subscribe() FIRST — push live events into a buffer
 *   2. read DB up to the current max seq — replay
 *   3. drain the buffer, skipping any seq already replayed — backlog
 *   4. forward live events directly — tail
 *
 * If we read first and subscribed after, any event written between the
 * read and the subscribe would vanish. This is the classic "live + replay
 * merge" problem and the order here is the fix.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendError, sendJSON } from '../router.js'
import { startSSE, writeSSE } from '../sse.js'
import type { GatewayState } from '../state.js'
import type { BusEvent, Unsubscribe } from '../event-bus.js'
import { ROOT_AGENT_ID } from '../event-bus.js'
import { trace, traceEnabled } from '../trace.js'
import type {
  StreamStartEvent,
  StreamReplayCompleteEvent,
  StreamShutdownEvent,
  StreamDoneEvent,
} from '../events.js'

/**
 * Max events returned by the JSON snapshot endpoint. SSE has no cap —
 * replay streams incrementally, so even huge agent runs are fine.
 */
const HISTORY_MAX_EVENTS = 10_000

/**
 * Idle timeout for the SSE handler. If a subagent is done and the client
 * is still connected, we close the stream after N ms of silence so the
 * connection doesn't hang forever. Keepalive comments fire every 30s
 * independently, so this only kicks in once the agent is truly finished.
 */
const IDLE_CLOSE_MS = 60_000
const GATEWAY_SHUTDOWN_RETRY_AFTER_MS = 5_000

/**
 * Backpressure caps for the per-connection SSE pipeline.
 *
 * The handler serialises every write through one promise chain so live
 * events cannot overtake replayed backlog. A frozen consumer (sleeping
 * laptop, hung tab, network black-hole) cannot drain the chain — the
 * pending-write counter grows without bound, pinning event payloads in
 * memory until the socket eventually times out at the OS layer.
 *
 * MAX_PENDING_WRITES caps the live-tail chain depth. MAX_REPLAY_BUFFER
 * caps the phase-1 buffer that holds bus events arriving DURING the DB
 * replay window. Both overflows drop the slow consumer with a typed
 * `slow_consumer` shutdown frame so the client can render an actionable
 * "reconnect" CTA instead of a generic "lost connection" toast.
 *
 * Defaults are sized for a generous live thread (~10 events/sec mid-
 * tool-stream, ~30s replay window) with headroom. A real overflow at
 * defaults means the client is genuinely broken, not just slow.
 *
 * Env overrides exist primarily for tests (lower the cap to trigger
 * the path deterministically) and for ops who want to tighten the
 * cap on memory-constrained deployments.
 */
const DEFAULT_MAX_PENDING_WRITES = 1_000
const DEFAULT_MAX_REPLAY_BUFFER = 5_000
const SLOW_CONSUMER_RETRY_AFTER_MS = 10_000

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw && /^\d+$/.test(raw)) {
    const parsed = parseInt(raw, 10)
    if (parsed > 0) return parsed
  }
  return fallback
}

function toStreamStartEvent(
  threadId: string,
  agentId: string,
  since: number,
  maxSeqAtStart: number,
): StreamStartEvent {
  return {
    type: 'stream.start',
    threadId,
    agentId,
    since,
    maxSeqAtStart,
  }
}

function toStreamReplayCompleteEvent(
  state: GatewayState,
  threadId: string,
  agentId: string,
  since: number,
  replayedThroughSeq: number,
  maxSeqAtStart: number,
): StreamReplayCompleteEvent {
  return {
    type: 'stream.replay.complete',
    threadId,
    agentId,
    since,
    replayedThroughSeq,
    maxSeqAtStart,
    liveTail: state.getRuntime(threadId) != null,
  }
}

function toStreamDoneEvent(status: StreamDoneEvent['status']): StreamDoneEvent {
  return {
    type: 'done',
    status,
  }
}

function toStreamShutdownEvent(
  threadId: string,
  agentId: string,
  reason: StreamShutdownEvent['reason'] = 'gateway_shutdown',
  retryAfterMs: number = GATEWAY_SHUTDOWN_RETRY_AFTER_MS,
): StreamShutdownEvent {
  return {
    type: 'stream.shutdown',
    threadId,
    agentId,
    reason,
    retryAfterMs,
  }
}

export function createAgentEventHandlers(state: GatewayState) {
  /**
   * GET /api/v1/threads/:threadId/agents/:agentId/events
   *
   * SSE replay + live tail. Supports ?since=N for resume.
   */
  async function streamAgentEvents(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const threadId = params['threadId']!
    const agentId = params['agentId']!

    const thread = state.getThreadAnywhere(threadId)
    if (!thread) {
      sendError(res, 404, `Thread "${threadId}" not found`)
      return
    }

    // Parse ?since=N — exclusive cursor, default 0 (start from beginning).
    // Tolerant parse: any garbage collapses to 0 rather than erroring,
    // because a client reconnect is already a stressful moment — we
    // don't want to 400 the modal over a malformed resume query.
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const sinceParam = url.searchParams.get('since')
    const since = sinceParam && /^\d+$/.test(sinceParam) ? parseInt(sinceParam, 10) : 0
    const maxSeqAtStart = state.getAgentEventMaxSeq(threadId, agentId)

    // ── 1. Subscribe FIRST ─────────────────────────────────────────────
    //
    // Any event that arrives while we're reading the DB lands in this
    // buffer. Once replay is done we drain the buffer, skipping events
    // whose seq <= the last replayed seq (those are duplicates — the DB
    // already had them when we read it).
    const buffer: BusEvent[] = []
    let draining = true
    let aborted = false
    let lastDeliveredSeq = since
    let resolveTailWait!: () => void
    const tailWait = new Promise<void>(resolve => {
      resolveTailWait = resolve
    })
    let writeChain = Promise.resolve()
    /**
     * In-flight write count for the live-tail backpressure cap. Bumped
     * on enqueue, decremented when the chained step completes (success
     * or failure). When this exceeds MAX_PENDING_WRITES the consumer
     * has stopped draining — `dropSlowConsumer` fires and tears the
     * connection down with a typed shutdown frame.
     */
    let pendingWrites = 0
    let slowConsumerHandled = false

    const dropSlowConsumer = (): void => {
      if (slowConsumerHandled || aborted) return
      slowConsumerHandled = true
      // Best-effort: write the shutdown frame DIRECTLY to the socket
      // (bypassing the queue, which is the thing that's stuck). Then
      // close. We don't go through enqueueWrite because by definition
      // it's already overflowing.
      try {
        if (!res.writableEnded) {
          const shutdown = toStreamShutdownEvent(
            threadId, agentId, 'slow_consumer', SLOW_CONSUMER_RETRY_AFTER_MS,
          )
          res.write(`event: stream.shutdown\ndata: ${JSON.stringify(shutdown)}\n\n`)
        }
      } catch { /* socket already broken */ }
      onClose()
      if (!res.writableEnded) res.end()
    }

    const maxPendingWrites = readPositiveIntEnv(
      'OWNWARE_SSE_MAX_PENDING_WRITES', DEFAULT_MAX_PENDING_WRITES,
    )
    const maxReplayBuffer = readPositiveIntEnv(
      'OWNWARE_SSE_MAX_REPLAY_BUFFER', DEFAULT_MAX_REPLAY_BUFFER,
    )

    // Crossed-threshold logging for pendingWrites. Emits exactly once per
    // threshold crossing so we see backpressure building without spamming
    // the log. When a "stuck stream" report comes in, the presence (or
    // absence) of these lines tells us whether writes queued up server-
    // side (consumer slow) or never enqueued at all (ingestor stalled).
    const PENDING_THRESHOLDS = [100, 500, 900] as const
    let pendingThresholdIdx = 0
    const enqueueWrite = (eventName: string, data: unknown): Promise<void> => {
      if (slowConsumerHandled) return Promise.resolve()
      pendingWrites++
      if (
        pendingThresholdIdx < PENDING_THRESHOLDS.length &&
        pendingWrites >= PENDING_THRESHOLDS[pendingThresholdIdx]!
      ) {
        // eslint-disable-next-line no-console
        console.warn(
          `[sse ${threadId.slice(-8)}/${agentId}] pendingWrites=${pendingWrites} (threshold ${PENDING_THRESHOLDS[pendingThresholdIdx]!}, cap ${maxPendingWrites})`,
        )
        pendingThresholdIdx++
      }
      if (pendingWrites > maxPendingWrites) {
        dropSlowConsumer()
        return Promise.resolve()
      }
      const next = writeChain.then(async () => {
        if (aborted || res.writableEnded) return
        await writeSSE(res, eventName, data)
      })
      writeChain = next.catch(() => {})
      next.finally(() => { pendingWrites-- }).catch(() => {})
      return next
    }
    const enqueueAgentEvent = (entry: BusEvent): Promise<void> => {
      trace('sse-enqueue', threadId, agentId, entry.event.type, {
        seq: entry.seq,
        pending: pendingWrites + 1,
      })
      // Always-on perm-trace: confirm the event is being handed to the
      // socket write queue. If we see cortex-ingest-bus but never see
      // sse-deliver for the same requestId, the live-tail path is
      // dropping the event (subscriber missing, race during replay,
      // overflow drop).
      const evType = entry.event.type
      if (traceEnabled && (evType === 'permission.request' || evType === 'permission.response')) {
        const reqId = (entry.event as { requestId?: string }).requestId ?? null
        // eslint-disable-next-line no-console
        console.log('[perm-trace] cortex-sse-deliver', {
          threadId,
          requestId: reqId,
          type: evType,
          seq: entry.seq,
          ts: Date.now(),
        })
      }
      return enqueueWrite(entry.event.type, { ...entry.event, seq: entry.seq }).then(() => {
        lastDeliveredSeq = entry.seq
        resetIdleTimer()
      })
    }
    const unsubscribe: Unsubscribe = state.eventBus.subscribe(
      threadId,
      agentId,
      entry => {
        if (draining) {
          // Phase-1 backpressure: while we're reading the DB the bus
          // can deliver events faster than we can replay. Cap the
          // buffer so a long DB read on a chatty agent can't OOM the
          // gateway. Overflow drops the consumer the same way the
          // live-tail overflow does.
          if (buffer.length >= maxReplayBuffer) {
            trace('sse-buffer-overflow', threadId, agentId, entry.event.type, {
              buffered: buffer.length,
              cap: maxReplayBuffer,
            })
            dropSlowConsumer()
            return
          }
          buffer.push(entry)
          trace('sse-buffer-push', threadId, agentId, entry.event.type, {
            seq: entry.seq,
            buffered: buffer.length,
          })
        } else {
          // After replay sync we forward directly to the client, but
          // still serialize writes through one queue so late live events
          // cannot overtake buffered backlog events.
          trace('sse-bus-recv', threadId, agentId, entry.event.type, { seq: entry.seq })
          void enqueueAgentEvent(entry).catch(() => {
            /* socket closed — the close handler will abort */
          })
        }
      },
    )
    trace('sse-subscribe', threadId, agentId, 'stream', { since })

    // ── Start the SSE response ─────────────────────────────────────────
    startSSE(res)
    await enqueueWrite(
      'stream.start',
      toStreamStartEvent(threadId, agentId, since, maxSeqAtStart),
    )

    let unsubscribeShutdown: (() => void) | null = null
    const onClose = () => {
      if (aborted) return
      aborted = true
      trace('sse-close', threadId, agentId, 'stream', {
        lastDeliveredSeq,
        pendingWrites,
        buffered: buffer.length,
      })
      unsubscribe()
      unsubscribeShutdown?.()
      unsubscribeShutdown = null
      clearInterval(keepalive)
      if (idleTimer) clearTimeout(idleTimer)
      resolveTailWait()
    }
    res.on('close', onClose)

    unsubscribeShutdown = state.subscribeToShutdown(async () => {
      if (aborted) return
      try {
        await enqueueWrite(
          'stream.shutdown',
          toStreamShutdownEvent(threadId, agentId),
        )
      } finally {
        onClose()
        if (!res.writableEnded) res.end()
      }
    })

    // Keepalive comment every 30s so proxies / browsers don't close the
    // connection during idle periods (agent thinking between tools).
    const keepalive = setInterval(() => {
      if (!res.writableEnded && !aborted) {
        res.write(':keepalive\n\n')
      }
    }, 30_000)

    // Idle close — applies ONLY to sub-agent streams (modals). The root
    // agent SSE backs the long-lived chat tab and must stay open across
    // user pauses (reading a reply, composing the next message). Closing
    // it after 60s of silence breaks the "send another message" flow:
    // the next POST /run would generate events with nobody listening.
    //
    // Sub-agent streams are different — the user opens a modal to view
    // the helper's transcript. Once the helper is done and the user has
    // had a moment to read, closing is the right move so the modal can
    // detach cleanly.
    const isRootAgent = agentId === ROOT_AGENT_ID
    let idleTimer: ReturnType<typeof setTimeout> | null = null
    const resetIdleTimer = () => {
      if (isRootAgent) return // root chat tab: never idle-close
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        if (aborted) return
        // Constant-time existence check — the previous implementation
        // pulled up to HISTORY_MAX_EVENTS rows just to look for one
        // event type, which scaled badly for long-lived sub-agents.
        const hasTerminal = state.hasAgentEventOfType(
          threadId, agentId, 'agent.complete',
        )
        if (hasTerminal) {
          void enqueueWrite('done', toStreamDoneEvent('complete')).finally(() => {
            onClose()
            if (!res.writableEnded) res.end()
          })
        }
      }, IDLE_CLOSE_MS)
    }
    resetIdleTimer()

    try {
      // ── 2. Read DB → replay to client ──────────────────────────────
      //
      // Stream rows in chunks so massive histories don't all allocate at
      // once. The `seq > since` filter is handled at the SQL layer.
      let cursor = since
      while (!aborted) {
        const rows = state.listAgentEvents({
          threadId,
          agentId,
          since: cursor,
          limit: 500,
        })
        if (rows.length === 0) break
        for (const row of rows) {
          if (aborted) break
          await enqueueAgentEvent({
            seq: row.seq,
            event: row.payload as BusEvent['event'],
          })
        }
        cursor = rows[rows.length - 1]!.seq
        if (rows.length < 500) break
      }

      // ── 3. Drain the buffer ────────────────────────────────────────
      //
      // While we were reading the DB, the bus may have delivered more
      // events. Forward any with seq > lastReplayedSeq. Events whose
      // seq is <= lastReplayedSeq are duplicates — the DB write had
      // already landed before our read query executed.
      let bufferIndex = 0
      while (!aborted) {
        while (bufferIndex < buffer.length) {
          const entry = buffer[bufferIndex++]!
          if (entry.seq <= lastDeliveredSeq) continue
          await enqueueAgentEvent(entry)
        }
        if (bufferIndex === buffer.length) {
          draining = false
          break
        }
      }
      buffer.length = 0

      const replayComplete = toStreamReplayCompleteEvent(
        state,
        threadId,
        agentId,
        since,
        lastDeliveredSeq,
        maxSeqAtStart,
      )
      await enqueueWrite('stream.replay.complete', replayComplete)

      // ── 4. Tail or graceful close ──────────────────────────────────
      //
      // Two consumer classes share this handler and their "close after
      // replay" semantics diverge:
      //
      //   * Root-agent SSE — the long-lived chat tab. A new POST /run
      //     can originate at any moment, so the thread being terminal
      //     right now is NOT a "no future events" guarantee. Closing
      //     here is the bug behind the "second turn stuck" symptom
      //     (see findings CRITICAL-1 in the 2026-04-22 stream audit):
      //     the server sends `done`, the client stops reconnecting,
      //     and the next user message streams into a closed socket.
      //     Root-agent SSE must stay open until the CLIENT closes it.
      //
      //   * Sub-agent SSE — the "View thread" modal. The sub-agent's
      //     lifecycle is bounded by its parent turn. Once the parent
      //     thread is terminal, the sub-agent is guaranteed not to
      //     produce more events (no runtime, no background writer).
      //     Closing via `done` lets the modal detach cleanly without
      //     waiting for the 60s idle timer.
      //
      // The tail path runs `tailWait` — a Promise that only resolves
      // when `onClose` runs (socket close / gateway shutdown / slow-
      // consumer drop). For root-agent SSE that is exactly the
      // behaviour we want.
      const threadStatus = thread.status
      if (!isRootAgent && threadStatus !== 'active') {
        await enqueueWrite('done', toStreamDoneEvent('complete'))
      } else {
        await tailWait
      }
    } catch (err) {
      if (!aborted) {
        try {
          await enqueueWrite('error', {
            type: 'error',
            code: 'stream_error',
            message: err instanceof Error ? err.message : String(err),
            recoverable: false,
            turnIndex: -1,
          })
        } catch {
          /* socket already gone */
        }
      }
    } finally {
      onClose()
      if (!res.writableEnded) res.end()
    }
  }

  /**
   * GET /api/v1/threads/:threadId/agents/:agentId/events/history
   *
   * One-shot JSON dump of every event on disk for this agent. No live
   * tail. Used by the E2E tests and by any consumer that wants a full
   * snapshot without opening an SSE connection.
   */
  async function getAgentEventHistory(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const threadId = params['threadId']!
    const agentId = params['agentId']!

    const thread = state.getThreadAnywhere(threadId)
    if (!thread) {
      sendError(res, 404, `Thread "${threadId}" not found`)
      return
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const sinceParam = url.searchParams.get('since')
    const since = sinceParam && /^\d+$/.test(sinceParam) ? parseInt(sinceParam, 10) : 0

    const events = state.listAgentEvents({
      threadId,
      agentId,
      since,
      limit: HISTORY_MAX_EVENTS,
    })

    sendJSON(res, 200, {
      threadId,
      agentId,
      since,
      count: events.length,
      maxSeq: state.getAgentEventMaxSeq(threadId, agentId),
      events: events.map(e => ({
        seq: e.seq,
        type: e.type,
        payload: e.payload,
        createdAt: e.createdAt,
        parentAgentId: e.parentAgentId,
      })),
    })
  }

  /**
   * GET /api/v1/threads/:threadId/agents
   *
   * Lists every agent_id that has events on a thread — the root agent
   * plus any sub-agents (including nested). Used by the modal to build
   * the tree of "view thread" links.
   */
  async function listThreadAgents(
    _req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ): Promise<void> {
    const threadId = params['threadId']!
    const thread = state.getThreadAnywhere(threadId)
    if (!thread) {
      sendError(res, 404, `Thread "${threadId}" not found`)
      return
    }
    const agents = state.listAgentsForThread(threadId)
    sendJSON(res, 200, {
      threadId,
      count: agents.length,
      agents,
    })
  }

  return {
    streamAgentEvents,
    getAgentEventHistory,
    listThreadAgents,
  }
}
