/**
 * In-process event bus for per-(thread, agent) live event fan-out.
 *
 * The gateway's "live streaming" model for subagents is:
 *
 *   1. The ingestor writes an event to SQLite (`agent_events` table).
 *   2. The ingestor publishes the same event to this bus.
 *   3. Any SSE handler subscribed to the (thread_id, agent_id) channel
 *      receives it immediately.
 *
 * The bus is stateless — it does NOT buffer events for future subscribers.
 * New subscribers read the DB up to the current seq first, then subscribe
 * here to tail the live tail. The SSE handler is the thing that glues
 * DB replay + bus tail together with a "subscribe-before-read" sequence
 * that guarantees no events are dropped in the window between the two.
 *
 * Pattern: in-process publish + React-style subscription, lifted out of
 * process because UI clients sit across an HTTP boundary.
 *
 * Scope: single-process only. The gateway is a Node process that owns all
 * agent state, so a simple in-memory EventEmitter is sufficient. Do not
 * reach for Redis/NATS/Kafka here — those belong on the day Cortex runs
 * multiple gateway processes, which is not v1.
 */

import { EventEmitter } from 'node:events'
import type { LoomEvent } from '@ownware/loom'

/** A single entry delivered on the bus — event payload plus its DB seq. */
export interface BusEvent {
  readonly seq: number
  readonly event: LoomEvent
}

/** Unsubscribe function returned by `subscribe`. Calling it is idempotent. */
export type Unsubscribe = () => void

/**
 * Channel key format.
 *
 * Centralized here so the ingestor and the SSE handler cannot drift.
 * The root agent (parent of the thread) uses agentId='root'.
 */
function channelKey(threadId: string, agentId: string): string {
  return `${threadId}:${agentId}`
}

/** The agent id used for a thread's root/parent agent (no sub-agent id). */
export const ROOT_AGENT_ID = 'root'

export class EventBus {
  /**
   * One EventEmitter per active (thread, agent) channel.
   *
   * Lazily created on first subscribe OR first publish, whichever comes
   * first. Removed when the last listener unsubscribes so long-lived
   * gateways don't leak channels for finished agents.
   */
  private readonly channels = new Map<string, EventEmitter>()

  /**
   * Publish an event to the (thread, agent) channel.
   *
   * If nobody is subscribed this is a no-op — the event is still durable
   * on disk via the ingestor, so a future subscriber will get it via
   * replay. Publish must be called AFTER the DB write so that any live
   * subscriber sees a seq that exists in the DB (the "write-then-publish"
   * invariant — live is always a suffix of disk).
   */
  publish(threadId: string, agentId: string, entry: BusEvent): void {
    const key = channelKey(threadId, agentId)
    const ch = this.channels.get(key)
    if (!ch) return
    ch.emit('event', entry)
  }

  /**
   * Subscribe to a (thread, agent) channel.
   *
   * Returns an unsubscribe function. IMPORTANT: the SSE handler must call
   * `subscribe()` BEFORE reading the DB. The reason is a classic TOCTOU:
   * if you read the DB first and subscribe after, any event written in
   * between is lost. The correct sequence is:
   *
   *   1. subscribe — buffer incoming events (internal)
   *   2. read DB from `since` seq up to current max — replay
   *   3. forward buffered events with seq > last-replayed — drain
   *   4. continue forwarding live events — tail
   *
   * The bus itself does not buffer — the handler passes a listener that
   * appends to its own array until the replay finishes.
   */
  subscribe(
    threadId: string,
    agentId: string,
    listener: (entry: BusEvent) => void,
  ): Unsubscribe {
    const key = channelKey(threadId, agentId)
    let ch = this.channels.get(key)
    if (!ch) {
      ch = new EventEmitter()
      // Agent streams can have many short-lived listeners over their
      // lifetime. The default max-listeners warning fires at 10, which
      // is too low for a busy gateway — raise it to a sane value and
      // let the handler be responsible for cleanup.
      ch.setMaxListeners(100)
      this.channels.set(key, ch)
    }
    ch.on('event', listener)

    return () => {
      const current = this.channels.get(key)
      if (!current) return
      current.off('event', listener)
      if (current.listenerCount('event') === 0) {
        this.channels.delete(key)
      }
    }
  }

  /**
   * Returns true if the channel has any live listener — useful for the
   * ingestor to skip `publish()` work when nobody is subscribed. Also
   * useful in tests.
   */
  hasSubscribers(threadId: string, agentId: string): boolean {
    const ch = this.channels.get(channelKey(threadId, agentId))
    return !!ch && ch.listenerCount('event') > 0
  }

  /**
   * Clear every channel. Used on gateway shutdown so unclosed listeners
   * don't keep the process alive.
   */
  clear(): void {
    for (const ch of this.channels.values()) {
      ch.removeAllListeners('event')
    }
    this.channels.clear()
  }

  /** Number of currently-open channels. Test/observability helper. */
  get channelCount(): number {
    return this.channels.size
  }
}
