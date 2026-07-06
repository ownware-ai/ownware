/**
 * TaskEventBus — process-wide fan-out for task list mutations.
 *
 * Shape + discipline follows `connector/status-bus.ts` so every event
 * stream in the gateway uses the same primitives.
 *
 * Single-process scope. The gateway runs as one Node process today;
 * a multi-process deployment would replace this with Redis/NATS, out
 * of scope for v1.
 */

import { EventEmitter } from 'node:events'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Event schema
// ---------------------------------------------------------------------------

export const TaskStatusSchema = z.enum(['pending', 'in_progress', 'completed'])
export type TaskStatusWire = z.infer<typeof TaskStatusSchema>

export const TaskDtoSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  content: z.string().min(1),
  status: TaskStatusSchema,
  order: z.number().int().nonnegative(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
})
export type TaskDto = z.infer<typeof TaskDtoSchema>

export const TasksUpdatedEventSchema = z.object({
  type: z.literal('tasks.updated'),
  threadId: z.string().min(1),
  tasks: z.array(TaskDtoSchema),
  at: z.string().min(1),
})
export type TasksUpdatedEvent = z.infer<typeof TasksUpdatedEventSchema>

// ---------------------------------------------------------------------------
// Bus
// ---------------------------------------------------------------------------

export type TaskEventListener = (event: TasksUpdatedEvent) => void
export type Unsubscribe = () => void

const EVENT_NAME = 'tasks.updated'

export class TaskEventBus {
  private readonly emitter = new EventEmitter()

  constructor() {
    // Subscribers (one per SSE connection) may come and go; keep the
    // warning ceiling generous so the dev console isn't spammed.
    this.emitter.setMaxListeners(200)
  }

  emit(event: TasksUpdatedEvent): void {
    // Validate at the boundary so an upstream mistake surfaces here
    // rather than in every subscriber.
    const validated = TasksUpdatedEventSchema.parse(event)
    this.emitter.emit(EVENT_NAME, validated)
  }

  subscribe(listener: TaskEventListener): Unsubscribe {
    this.emitter.on(EVENT_NAME, listener)
    let unsubscribed = false
    return () => {
      if (unsubscribed) return
      unsubscribed = true
      this.emitter.off(EVENT_NAME, listener)
    }
  }
}
