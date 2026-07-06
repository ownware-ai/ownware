/**
 * DesignFsEventBus — process-wide fan-out for raw filesystem changes
 * inside a Ownware Design workspace folder.
 *
 * Sibling to `files-event-bus.ts`, intentionally separate because the
 * two concerns are different verticals (Principle 22):
 *
 *   - `FilesEventBus` ships a git-status snapshot per fan-out frame —
 *     consumed by the IDE-style files panel, which wants the whole
 *     working-tree state at once.
 *   - `DesignFsEventBus` ships per-path invalidation hints
 *     `{ designId, path, kind }` — consumed by the canvas to refresh
 *     individual rendered files without re-fetching anything else.
 *
 * The bus carries no file content. Per the gateway realtime contract
 * (`packages/cortex/src/gateway/CLAUDE.md`) SSE channels are
 * invalidation-shaped; clients re-fetch via the existing
 * `/api/v1/designs/:id/raw/*path` endpoint when they need the bytes.
 *
 * Single-process scope. Multi-process deployment would swap the
 * EventEmitter for Redis/NATS; out of scope for v1.
 */

import { EventEmitter } from 'node:events'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Event shape
// ---------------------------------------------------------------------------

export const DesignFsChangeKindSchema = z.enum(['add', 'change', 'unlink'])
export type DesignFsChangeKind = z.infer<typeof DesignFsChangeKindSchema>

export const DesignFsChangedEventSchema = z.object({
  type: z.literal('design-fs.changed'),
  /** The Ownware Design row id that owns the workspace folder. */
  designId: z.string().min(1),
  /** Workspace-relative posix path (forward-slash separated). */
  path: z.string().min(1),
  kind: DesignFsChangeKindSchema,
  /** ISO-8601 timestamp at emission. */
  at: z.string().min(1),
})
export type DesignFsChangedEvent = z.infer<typeof DesignFsChangedEventSchema>

export type DesignFsEvent = DesignFsChangedEvent
export type DesignFsListener = (event: DesignFsEvent) => void
export type Unsubscribe = () => void

const EVENT_NAME = 'design-fs'

export class DesignFsEventBus {
  private readonly emitter = new EventEmitter()

  constructor() {
    this.emitter.setMaxListeners(200)
  }

  emit(event: DesignFsEvent): void {
    const validated = DesignFsChangedEventSchema.parse(event)
    this.emitter.emit(EVENT_NAME, validated)
  }

  subscribe(listener: DesignFsListener): Unsubscribe {
    this.emitter.on(EVENT_NAME, listener)
    let gone = false
    return () => {
      if (gone) return
      gone = true
      this.emitter.off(EVENT_NAME, listener)
    }
  }
}
