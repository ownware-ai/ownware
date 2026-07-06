import { describe, it, expect, vi } from 'vitest'
import { TaskEventBus, type TasksUpdatedEvent } from '../../../src/tasks/event-bus.js'

function makeEvent(overrides: Partial<TasksUpdatedEvent> = {}): TasksUpdatedEvent {
  return {
    type: 'tasks.updated',
    threadId: 'thread_abc',
    tasks: [],
    at: new Date().toISOString(),
    ...overrides,
  }
}

describe('TaskEventBus', () => {
  it('delivers emitted events to a subscriber', () => {
    const bus = new TaskEventBus()
    const spy = vi.fn()
    bus.subscribe(spy)
    const ev = makeEvent()
    bus.emit(ev)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith(ev)
  })

  it('fans out to every subscriber', () => {
    const bus = new TaskEventBus()
    const a = vi.fn()
    const b = vi.fn()
    bus.subscribe(a)
    bus.subscribe(b)
    bus.emit(makeEvent())
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('unsubscribe stops further deliveries and is idempotent', () => {
    const bus = new TaskEventBus()
    const spy = vi.fn()
    const off = bus.subscribe(spy)
    bus.emit(makeEvent())
    off()
    off() // second call must not throw
    bus.emit(makeEvent())
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('rejects malformed payloads at the boundary (Zod)', () => {
    const bus = new TaskEventBus()
    bus.subscribe(() => {})
    expect(() => {
      bus.emit({
        type: 'tasks.updated',
        threadId: '',
        tasks: [],
        at: '',
      } as TasksUpdatedEvent)
    }).toThrow()
  })
})
