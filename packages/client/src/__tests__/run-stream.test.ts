/**
 * interpretSseEvent — the pure SSE→RunStreamEvent mapping, including the
 * H6 `permission` member (a paused run surfaces the decision instead of
 * hanging silently until the gateway's HITL timeout denies it).
 */

import { describe, it, expect } from 'vitest'
import { interpretSseEvent } from '../run-stream.js'

describe('interpretSseEvent — permission.request (H6)', () => {
  it('maps permission.request to a permission event and keeps the run open', () => {
    const { event, stop, seq } = interpretSseEvent(
      'permission.request',
      {
        type: 'permission.request',
        requestId: 'hookapproval_abc123',
        toolName: 'send_refund',
        reason: 'Profile "shop" requires approval before running "send_refund".',
        seq: 7,
      },
      3,
    )
    expect(stop).toBe(false)
    expect(seq).toBe(7)
    expect(event).toEqual({
      type: 'permission',
      requestId: 'hookapproval_abc123',
      toolName: 'send_refund',
      reason: 'Profile "shop" requires approval before running "send_refund".',
      seq: 7,
    })
  })

  it('defaults the reason and tool name when absent', () => {
    const { event } = interpretSseEvent(
      'permission.request',
      { type: 'permission.request', requestId: 'r1', seq: 2 },
      0,
    )
    expect(event).toMatchObject({
      type: 'permission',
      toolName: 'unknown',
      reason: 'Tool requires explicit approval',
    })
  })

  it('drops a malformed permission.request without a requestId (nothing to answer)', () => {
    const { event, stop } = interpretSseEvent(
      'permission.request',
      { type: 'permission.request', toolName: 'x', seq: 2 },
      0,
    )
    expect(event).toBeUndefined()
    expect(stop).toBe(false)
  })

  it('regression: deltas and terminal events are unchanged', () => {
    expect(
      interpretSseEvent('text.delta', { type: 'text.delta', text: 'hi', seq: 1 }, 0).event,
    ).toEqual({ type: 'delta', text: 'hi', seq: 1 })
    expect(
      interpretSseEvent('turn.end', { type: 'turn.end', stopReason: 'end_turn', seq: 2 }, 1).stop,
    ).toBe(true)
    expect(
      interpretSseEvent('turn.end', { type: 'turn.end', stopReason: 'tool_use', seq: 2 }, 1).stop,
    ).toBe(false)
  })
})
