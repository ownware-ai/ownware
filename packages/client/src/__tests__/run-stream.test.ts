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

  it('maps tool.call.progress to a progress event (work lines) and keeps the run open', () => {
    const { event, stop, seq } = interpretSseEvent(
      'tool.call.progress',
      {
        type: 'tool.call.progress',
        toolCallId: 'call_1',
        progress: 'Checked the number · it can link without moving anything',
        seq: 5,
      },
      3,
    )
    expect(stop).toBe(false)
    expect(seq).toBe(5)
    expect(event).toEqual({
      type: 'progress',
      toolCallId: 'call_1',
      message: 'Checked the number · it can link without moving anything',
      seq: 5,
    })
  })

  it('drops an empty progress message (nothing to render)', () => {
    const { event, stop } = interpretSseEvent(
      'tool.call.progress',
      { type: 'tool.call.progress', toolCallId: 'call_1', seq: 5 },
      0,
    )
    expect(event).toBeUndefined()
    expect(stop).toBe(false)
  })

  it('maps only a complete metadata-only sensitive-input request', () => {
    const data = {
      type: 'sensitive.input.request',
      requestId: 'sensitive_1',
      toolCallId: 'call_1',
      toolName: 'browser_sensitive_type',
      label: 'Password',
      usage: 'Enter directly into the bound field',
      agentId: null,
      adapterRevision: 'ownware.browser-field-injection.v1',
      seq: 9,
    }
    expect(interpretSseEvent('sensitive.input.request', data, 0)).toEqual({
      event: {
        type: 'sensitive-input',
        requestId: 'sensitive_1',
        toolCallId: 'call_1',
        toolName: 'browser_sensitive_type',
        label: 'Password',
        usage: 'Enter directly into the bound field',
        agentId: null,
        adapterRevision: 'ownware.browser-field-injection.v1',
        seq: 9,
      },
      stop: false,
      seq: 9,
    })
    expect(interpretSseEvent('sensitive.input.request', {
      ...data,
      adapterRevision: undefined,
    }, 0).event).toBeUndefined()
  })

  it('maps only a complete content-free skill activation observation', () => {
    const data = {
      type: 'skill.activation',
      activationId: '55555555-5555-4555-8555-555555555555',
      toolCallId: 'call_skill_1',
      sourceRef: 'assistant',
      sourceDigest: `hmac-sha256:${'a'.repeat(64)}`,
      skillName: '分析',
      skillDigest: `hmac-sha256:${'b'.repeat(64)}`,
      agentId: null,
      turnIndex: 2,
      timestamp: 100,
      seq: 10,
    }
    expect(interpretSseEvent('skill.activation', data, 0)).toEqual({
      event: {
        type: 'skill-activation',
        activationId: data.activationId,
        toolCallId: 'call_skill_1',
        profileId: 'assistant',
        profileDigest: data.sourceDigest,
        skillName: '分析',
        skillDigest: data.skillDigest,
        agentId: null,
        turnIndex: 2,
        activatedAt: 100,
        seq: 10,
      },
      stop: false,
      seq: 10,
    })
    expect(interpretSseEvent('skill.activation', {
      ...data,
      skillDigest: undefined,
    }, 0).event).toBeUndefined()
    expect(interpretSseEvent('skill.activation', {
      ...data,
      sourceDigest: 'caller-says-this-is-proof',
    }, 0).event).toBeUndefined()
    expect(interpretSseEvent('skill.activation', {
      ...data,
      turnIndex: -1,
    }, 0).event).toBeUndefined()
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
