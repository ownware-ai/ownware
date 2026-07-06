/**
 * Event ingestor — the single write path for per-(thread, agent) events.
 *
 * Every subagent LoomEvent that the gateway captures (via the spawner's
 * onEvent hook) and every parent event (via the session runner) flows
 * through one function here. It does exactly two things, in this order:
 *
 *   1. Append to the SQLite `agent_events` table — the durable log.
 *   2. Publish to the in-memory EventBus — the live fan-out to SSE.
 *
 * The ordering is load-bearing. Disk first means any live subscriber only
 * sees events that are already durable, so if a reader reconnects mid-run
 * with `?since=N`, it will never see a seq number that isn't in the DB.
 * This is the "live is always a suffix of disk" invariant that Claude
 * Code's sidechain transcript comment (agentToolUtils.ts:556) describes.
 *
 * The ingestor is stateless — it takes (thread_id, agent_id) on every
 * call so one instance can serve every thread. It also knows the special
 * rewrite rule for lifecycle events: `agent.spawn` and `agent.complete`
 * emitted from inside a sub-agent's generator are re-tagged to the PARENT
 * agent_id so the parent stream sees the "card" marker, while all other
 * events stay on the child's agent_id so the "View thread" modal gets
 * the full conversation.
 */

import type { LoomEvent } from '@ownware/loom'
import type { CortexDatabase } from './db/database.js'
import type { EventBus } from './event-bus.js'
import { ROOT_AGENT_ID } from './event-bus.js'
import { trace, traceEnabled } from './trace.js'

export interface IngestParams {
  readonly threadId: string
  /**
   * The agent that emitted the event. For a parent-emitted event this
   * should be ROOT_AGENT_ID. For a sub-agent-emitted event this is the
   * sub-agent's handle id from the spawner.
   */
  readonly agentId: string
  /**
   * For subagents, the spawning agent's id (usually ROOT_AGENT_ID). null
   * for the root agent itself.
   */
  readonly parentAgentId: string | null
  readonly event: LoomEvent
}

export class EventIngestor {
  constructor(
    private readonly db: CortexDatabase,
    private readonly bus: EventBus,
  ) {}

  /**
   * Ingest one event — durable write then (for main) live publish.
   *
   * Returns the assigned seq so callers can log/trace. Throws if the DB
   * write fails; callers should decide whether to abort the run or log
   * and continue (the gateway currently swallows per-event errors inside
   * the spawner hook to avoid killing an entire agent run over a single
   * bad event, but still reports them).
   */
  ingest(params: IngestParams): number {
    // Decide which agent_id this event actually belongs to on disk.
    // The sub-agent generator in Loom yields its own agent.spawn and
    // agent.complete events — but the parent's UI expects to see the
    // "card" marker on the parent's stream, not on the sub-agent's own
    // stream. Rewrite the tag so both consumers get the right view:
    //
    //   agent.spawn / agent.complete  →  parent's stream (= the card)
    //   everything else               →  the emitter's own stream
    //
    // Note: this is only relevant when parentAgentId is non-null, i.e.
    // the emitter is a sub-agent. For the root agent we keep the event
    // on the root stream regardless of type.
    const isLifecycleRewrite =
      params.parentAgentId !== null &&
      (params.event.type === 'agent.spawn' || params.event.type === 'agent.complete')

    const storageAgentId = isLifecycleRewrite
      ? params.parentAgentId!
      : params.agentId

    const storageParentId = isLifecycleRewrite
      // When rewriting lifecycle events onto the parent's stream, the
      // parent's parent (grandparent) becomes the new parent — but for
      // the root agent that's null. We don't know the grandparent id
      // from here without more plumbing, so leave it null; parent_agent_id
      // is informational for the tree view, not load-bearing.
      ? null
      : params.parentAgentId

    const appendParams = {
      threadId: params.threadId,
      agentId: storageAgentId,
      parentAgentId: storageParentId,
      type: params.event.type,
      payload: params.event,
    }

    // Permission events get an always-on lifecycle log (low volume, high
    // stakes — a dropped permission.request leaves a tool stuck forever).
    // Tagged [perm-trace] so a single grep across cortex stderr +
    // the client's devtools console reconstructs the full handoff chain.
    const isPermEvent = params.event.type === 'permission.request'
      || params.event.type === 'permission.response'
    const permRequestId = isPermEvent
      ? (params.event as { requestId?: string }).requestId ?? null
      : null

    let seq: number
    try {
      seq = this.db.appendAgentEvent(appendParams)
    } catch (err) {
      if (isPermEvent && traceEnabled) {
        // eslint-disable-next-line no-console
        console.log('[perm-trace] cortex-ingest-db-FAIL', {
          threadId: params.threadId,
          requestId: permRequestId,
          type: params.event.type,
          err: err instanceof Error ? err.message : String(err),
          ts: Date.now(),
        })
      }
      throw err
    }
    if (isPermEvent && traceEnabled) {
      // eslint-disable-next-line no-console
      console.log('[perm-trace] cortex-ingest-db', {
        threadId: params.threadId,
        requestId: permRequestId,
        type: params.event.type,
        seq,
        ts: Date.now(),
      })
    }

    trace('ingest-db', params.threadId, storageAgentId, params.event.type, {
      seq,
      ...(isLifecycleRewrite ? { rewrite: `${params.agentId}→${storageAgentId}` } : {}),
    })

    this.bus.publish(params.threadId, storageAgentId, {
      seq,
      event: params.event,
    })
    if (isPermEvent && traceEnabled) {
      // eslint-disable-next-line no-console
      console.log('[perm-trace] cortex-ingest-bus', {
        threadId: params.threadId,
        requestId: permRequestId,
        type: params.event.type,
        seq,
        ts: Date.now(),
      })
    }
    trace('bus-publish', params.threadId, storageAgentId, params.event.type, { seq })

    return seq
  }

  /**
   * Convenience helpers — the two most common call shapes so handlers
   * don't have to spell out the full params object every time.
   */

  ingestParentEvent(threadId: string, event: LoomEvent): number {
    return this.ingest({
      threadId,
      agentId: ROOT_AGENT_ID,
      parentAgentId: null,
      event,
    })
  }

  ingestSubagentEvent(
    threadId: string,
    subagentId: string,
    event: LoomEvent,
  ): number {
    return this.ingest({
      threadId,
      agentId: subagentId,
      parentAgentId: ROOT_AGENT_ID,
      event,
    })
  }
}
