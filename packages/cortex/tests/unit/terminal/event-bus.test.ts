import { describe, it, expect, vi } from 'vitest'
import {
  TerminalEventBus,
  type TerminalEvent,
} from '../../../src/terminal/event-bus.js'

function outputEvent(overrides: Partial<TerminalEvent> = {}): TerminalEvent {
  return {
    type: 'terminal.output',
    workspaceId: 'ws_a',
    kind: 'agent',
    terminalId: null,
    data: 'hello',
    at: new Date().toISOString(),
    ...overrides,
  } as TerminalEvent
}

describe('TerminalEventBus', () => {
  it('delivers emitted events to subscribers', () => {
    const bus = new TerminalEventBus()
    const spy = vi.fn()
    bus.subscribe(spy)
    const ev = outputEvent()
    bus.emit(ev)
    expect(spy).toHaveBeenCalledWith(ev)
  })

  it('fans out to every subscriber', () => {
    const bus = new TerminalEventBus()
    const a = vi.fn()
    const b = vi.fn()
    bus.subscribe(a)
    bus.subscribe(b)
    bus.emit(outputEvent())
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('unsubscribe is idempotent', () => {
    const bus = new TerminalEventBus()
    const spy = vi.fn()
    const off = bus.subscribe(spy)
    bus.emit(outputEvent())
    off()
    off()
    bus.emit(outputEvent())
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('rejects malformed payloads at the boundary', () => {
    const bus = new TerminalEventBus()
    bus.subscribe(() => {})
    expect(() => {
      bus.emit({
        type: 'terminal.output',
        workspaceId: '',
        kind: 'agent',
        terminalId: null,
        data: '',
        at: '',
      } as TerminalEvent)
    }).toThrow()
  })

  it('rejects events missing the kind discriminator', () => {
    const bus = new TerminalEventBus()
    expect(() => {
      bus.emit({
        type: 'terminal.output',
        workspaceId: 'ws_a',
        data: 'x',
        at: new Date().toISOString(),
      } as unknown as TerminalEvent)
    }).toThrow()
  })

  it('accepts user-kind events with a non-null terminalId', () => {
    const bus = new TerminalEventBus()
    const spy = vi.fn()
    bus.subscribe(spy)
    bus.emit({
      type: 'terminal.output',
      workspaceId: 'ws_a',
      kind: 'user',
      terminalId: 'term-123',
      data: 'hi',
      at: new Date().toISOString(),
    })
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('accepts exit events without signal', () => {
    const bus = new TerminalEventBus()
    const spy = vi.fn()
    bus.subscribe(spy)
    bus.emit({
      type: 'terminal.exit',
      workspaceId: 'ws_a',
      kind: 'agent',
      terminalId: null,
      exitCode: 0,
      at: new Date().toISOString(),
    })
    expect(spy).toHaveBeenCalledTimes(1)
  })
})
