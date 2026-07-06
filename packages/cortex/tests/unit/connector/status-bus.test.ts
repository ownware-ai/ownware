/**
 * ConnectorStatusBus — unit tests.
 *
 * Covers: subscribe/unsubscribe, emit basics, cache-backed previousStatus,
 * no-op suppression, explicit previousStatus override, Zod validation,
 * multi-subscriber fan-out, no-leak on unsubscribe.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  ConnectorStatusBus,
  ConnectorStatusEventSchema,
  createConnectorStatusBus,
  type ConnectorStatusEvent,
} from '../../../src/connector/status-bus.js'

describe('ConnectorStatusBus', () => {
  let bus: ConnectorStatusBus

  beforeEach(() => {
    bus = createConnectorStatusBus()
  })

  it('delivers an emitted event to a subscriber', () => {
    const received: ConnectorStatusEvent[] = []
    bus.subscribe(e => { received.push(e) })

    const ev = bus.emit({
      connectorId: 'x',
      source: 'mcp',
      status: 'ready',
    })

    expect(ev).not.toBeNull()
    expect(received).toHaveLength(1)
    expect(received[0]!.connectorId).toBe('x')
    expect(received[0]!.source).toBe('mcp')
    expect(received[0]!.status).toBe('ready')
    expect(received[0]!.previousStatus).toBeNull()
    expect(received[0]!.type).toBe('connector.status_changed')
    expect(received[0]!.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('produces events that match the Zod schema', () => {
    bus.subscribe(() => { /* noop */ })
    const ev = bus.emit({
      connectorId: 'web_search',
      source: 'builtin',
      status: 'needs_setup',
      reason: 'Missing key',
    })
    expect(ev).not.toBeNull()
    // Parser throws on bad shape.
    const parsed = ConnectorStatusEventSchema.parse(ev)
    expect(parsed.reason).toBe('Missing key')
  })

  it('computes previousStatus from the cache on subsequent emits', () => {
    const received: ConnectorStatusEvent[] = []
    bus.subscribe(e => { received.push(e) })

    bus.emit({ connectorId: 's', source: 'mcp', status: 'needs_setup' })
    bus.emit({ connectorId: 's', source: 'mcp', status: 'ready' })
    bus.emit({ connectorId: 's', source: 'mcp', status: 'error' })

    expect(received.map(e => e.previousStatus)).toEqual([null, 'needs_setup', 'ready'])
    expect(received.map(e => e.status)).toEqual(['needs_setup', 'ready', 'error'])
  })

  it('honours an explicit previousStatus argument', () => {
    const received: ConnectorStatusEvent[] = []
    bus.subscribe(e => { received.push(e) })

    bus.emit({
      connectorId: 's',
      source: 'mcp',
      status: 'ready',
      previousStatus: 'error',
    })
    expect(received[0]!.previousStatus).toBe('error')
  })

  it('treats an explicit null previousStatus as first-observation', () => {
    const received: ConnectorStatusEvent[] = []
    bus.subscribe(e => { received.push(e) })
    // Seed the cache
    bus.emit({ connectorId: 's', source: 'mcp', status: 'ready' })
    // Then emit with explicit null — forced first-observation semantics
    bus.emit({
      connectorId: 's',
      source: 'mcp',
      status: 'needs_setup',
      previousStatus: null,
    })
    expect(received[1]!.previousStatus).toBeNull()
  })

  it('suppresses no-op transitions (previous === new)', () => {
    const received: ConnectorStatusEvent[] = []
    bus.subscribe(e => { received.push(e) })
    const first = bus.emit({ connectorId: 's', source: 'mcp', status: 'ready' })
    const second = bus.emit({ connectorId: 's', source: 'mcp', status: 'ready' })
    expect(first).not.toBeNull()
    expect(second).toBeNull()
    expect(received).toHaveLength(1)
  })

  it('fans out to multiple subscribers', () => {
    const a: ConnectorStatusEvent[] = []
    const b: ConnectorStatusEvent[] = []
    bus.subscribe(e => { a.push(e) })
    bus.subscribe(e => { b.push(e) })
    bus.emit({ connectorId: 's', source: 'mcp', status: 'ready' })
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
  })

  it('removes a listener on unsubscribe (no leak)', () => {
    const received: ConnectorStatusEvent[] = []
    const unsub = bus.subscribe(e => { received.push(e) })
    expect(bus.listenerCount).toBe(1)
    unsub()
    expect(bus.listenerCount).toBe(0)
    bus.emit({ connectorId: 's', source: 'mcp', status: 'ready' })
    expect(received).toHaveLength(0)
  })

  it('unsubscribe is idempotent', () => {
    const unsub = bus.subscribe(() => { /* noop */ })
    unsub()
    expect(() => unsub()).not.toThrow()
    expect(bus.listenerCount).toBe(0)
  })

  it('clear removes every subscriber and resets the cache', () => {
    bus.subscribe(() => { /* noop */ })
    bus.subscribe(() => { /* noop */ })
    bus.emit({ connectorId: 's', source: 'mcp', status: 'ready' })
    expect(bus.listenerCount).toBe(2)
    bus.clear()
    expect(bus.listenerCount).toBe(0)
    // Cache reset — next emit sees null previousStatus again.
    const recv: ConnectorStatusEvent[] = []
    bus.subscribe(e => { recv.push(e) })
    bus.emit({ connectorId: 's', source: 'mcp', status: 'ready' })
    expect(recv[0]!.previousStatus).toBeNull()
  })

  it('peek returns cached status without publishing', () => {
    expect(bus.peek('mcp', 's')).toBeNull()
    bus.emit({ connectorId: 's', source: 'mcp', status: 'ready' })
    expect(bus.peek('mcp', 's')).toBe('ready')
    expect(bus.peek('mcp', 'other')).toBeNull()
  })

  it('keeps cache per (source, connectorId) pair', () => {
    bus.subscribe(() => { /* noop */ })
    bus.emit({ connectorId: 's', source: 'mcp', status: 'ready' })
    bus.emit({ connectorId: 's', source: 'builtin', status: 'error' })
    expect(bus.peek('mcp', 's')).toBe('ready')
    expect(bus.peek('builtin', 's')).toBe('error')
  })
})
