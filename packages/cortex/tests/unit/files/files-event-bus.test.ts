import { describe, expect, it, vi } from 'vitest'
import {
  FilesEventBus,
  type FilesUpdatedEvent,
} from '../../../src/files/files-event-bus.js'

function event(overrides: Partial<FilesUpdatedEvent> = {}): FilesUpdatedEvent {
  return {
    type: 'files.updated',
    workspaceId: 'ws1',
    at: new Date().toISOString(),
    items: [],
    ...overrides,
  }
}

describe('FilesEventBus', () => {
  it('delivers emitted events to subscribers', () => {
    const bus = new FilesEventBus()
    const spy = vi.fn()
    bus.subscribe(spy)
    const ev = event({
      items: [{ path: 'README.md', status: 'modified', staged: false }],
    })
    bus.emit(ev)
    expect(spy).toHaveBeenCalledWith(ev)
  })

  it('fans out to every subscriber', () => {
    const bus = new FilesEventBus()
    const a = vi.fn()
    const b = vi.fn()
    bus.subscribe(a)
    bus.subscribe(b)
    bus.emit(event())
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('unsubscribe is idempotent', () => {
    const bus = new FilesEventBus()
    const spy = vi.fn()
    const off = bus.subscribe(spy)
    bus.emit(event())
    off()
    off()
    bus.emit(event())
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('rejects malformed events at emit time', () => {
    const bus = new FilesEventBus()
    bus.subscribe(() => {})
    expect(() =>
      bus.emit({
        type: 'files.updated',
        workspaceId: '',
        at: new Date().toISOString(),
        items: [],
      } as FilesUpdatedEvent),
    ).toThrow()
  })

  it('rejects items with unknown status', () => {
    const bus = new FilesEventBus()
    expect(() =>
      bus.emit({
        type: 'files.updated',
        workspaceId: 'ws1',
        at: new Date().toISOString(),
        items: [{ path: 'x', status: 'banana', staged: false }],
      } as unknown as FilesUpdatedEvent),
    ).toThrow()
  })

  it('accepts rename entries with renamedFrom', () => {
    const bus = new FilesEventBus()
    const spy = vi.fn()
    bus.subscribe(spy)
    bus.emit(
      event({
        items: [
          { path: 'b.ts', status: 'renamed', staged: true, renamedFrom: 'a.ts' },
        ],
      }),
    )
    expect(spy).toHaveBeenCalledTimes(1)
  })
})
