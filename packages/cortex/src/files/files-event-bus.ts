/**
 * FilesEventBus — process-wide fan-out for per-workspace file
 * status changes.
 *
 * Shape + discipline follows `tasks/event-bus.ts` and
 * `terminal/event-bus.ts` so every SSE surface in the gateway uses
 * identical primitives.
 *
 * Single-process scope. Multi-process deployment would swap the
 * EventEmitter for Redis/NATS; out of scope for v1.
 */

import { EventEmitter } from 'node:events'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// FileEntry — the wire shape for one row of `git status`.
// ---------------------------------------------------------------------------

export const FileStatusSchema = z.enum([
  'untracked',
  'modified',
  'added',
  'deleted',
  'renamed',
  'copied',
  'conflict',
])
export type FileStatus = z.infer<typeof FileStatusSchema>

export const FileEntrySchema = z.object({
  path: z.string().min(1),
  status: FileStatusSchema,
  /** true when the change is in the index (staged side). */
  staged: z.boolean(),
  /** Source path for `renamed` / `copied` entries. */
  renamedFrom: z.string().min(1).optional(),
})
export type FileEntry = z.infer<typeof FileEntrySchema>

// ---------------------------------------------------------------------------
// FilesUpdatedEvent — the only event type emitted by this bus.
// ---------------------------------------------------------------------------

export const FilesUpdatedEventSchema = z.object({
  type: z.literal('files.updated'),
  workspaceId: z.string().min(1),
  at: z.string().min(1),
  items: z.array(FileEntrySchema),
})
export type FilesUpdatedEvent = z.infer<typeof FilesUpdatedEventSchema>

export type FilesEvent = FilesUpdatedEvent

export type FilesListener = (event: FilesEvent) => void
export type Unsubscribe = () => void

const EVENT_NAME = 'files'

export class FilesEventBus {
  private readonly emitter = new EventEmitter()

  constructor() {
    this.emitter.setMaxListeners(200)
  }

  emit(event: FilesEvent): void {
    const validated = FilesUpdatedEventSchema.parse(event)
    this.emitter.emit(EVENT_NAME, validated)
  }

  subscribe(listener: FilesListener): Unsubscribe {
    this.emitter.on(EVENT_NAME, listener)
    let gone = false
    return () => {
      if (gone) return
      gone = true
      this.emitter.off(EVENT_NAME, listener)
    }
  }
}
