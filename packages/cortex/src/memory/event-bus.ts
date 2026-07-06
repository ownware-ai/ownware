/**
 * Memory event bus — in-process fan-out for SSE.
 *
 * Following the gateway's "SSE never carries business payloads" rule
 * (root CLAUDE.md): events shipped here are invalidation HINTS only —
 * `{ type, ids }` shape. Subscribers (UI clients) refetch via HTTP to get
 * the actual data. This keeps ownware.db as the single source of truth.
 */

import type { MemoryEvent } from './schema.js'

export type MemoryEventListener = (event: MemoryEvent) => void

export class MemoryEventBus {
  private readonly listeners = new Set<MemoryEventListener>()

  emit(event: MemoryEvent): void {
    // Snapshot before iterating in case a listener unsubscribes itself.
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch (err) {
        // One bad subscriber must not break the fan-out.
        // eslint-disable-next-line no-console
        console.error('[memory] event listener threw:', err)
      }
    }
  }

  subscribe(listener: MemoryEventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Test helper. */
  get listenerCount(): number {
    return this.listeners.size
  }
}
