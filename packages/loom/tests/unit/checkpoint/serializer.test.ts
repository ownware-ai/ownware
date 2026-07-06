import { describe, it, expect } from 'vitest'
import {
  serializeCheckpoint,
  deserializeCheckpoint,
  createCheckpoint,
  validateCheckpoint,
} from '../../../src/checkpoint/serializer.js'
import type { Checkpoint } from '../../../src/checkpoint/types.js'
import type { SessionState } from '../../../src/core/session.js'

const sampleCheckpoint: Checkpoint = {
  sessionId: 'sess-abc-123',
  messages: [
    { role: 'system', content: 'Be helpful' },
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: [{ type: 'text', text: 'Hi!' }] },
  ],
  turnIndex: 3,
  usage: {
    inputTokens: 500,
    outputTokens: 200,
    cacheReadTokens: 100,
    cacheCreationTokens: 50,
    costUsd: 0.10,
  },
  timestamp: 1700000000000,
}

describe('serializeCheckpoint / deserializeCheckpoint', () => {
  it('roundtrips correctly', () => {
    const json = serializeCheckpoint(sampleCheckpoint)
    const parsed = deserializeCheckpoint(json)
    expect(parsed).toEqual(sampleCheckpoint)
  })

  it('produces pretty-printed JSON', () => {
    const json = serializeCheckpoint(sampleCheckpoint)
    expect(json).toContain('\n')
    expect(json).toContain('  ')
  })

  it('throws on malformed JSON', () => {
    expect(() => deserializeCheckpoint('invalid')).toThrow('Failed to parse checkpoint JSON')
  })

  it('throws on invalid checkpoint structure', () => {
    expect(() => deserializeCheckpoint(JSON.stringify({ foo: 'bar' })))
      .toThrow('Invalid checkpoint data')
  })
})

describe('createCheckpoint', () => {
  it('creates checkpoint from session state', () => {
    const session: SessionState = {
      sessionId: 'sess-123',
      messages: [{ role: 'user', content: 'Hello' }],
      turnCount: 5,
      totalUsage: {
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 200,
        cacheCreationTokens: 100,
        costUsd: 0.50,
        model: 'claude-sonnet-4',
      },
      createdAt: 1700000000000,
      updatedAt: 1700001000000,
    }

    const cp = createCheckpoint(session)

    expect(cp.sessionId).toBe('sess-123')
    expect(cp.messages).toHaveLength(1)
    expect(cp.turnIndex).toBe(5)
    expect(cp.usage.inputTokens).toBe(1000)
    expect(cp.usage.outputTokens).toBe(500)
    expect(cp.usage.cacheReadTokens).toBe(200)
    expect(cp.usage.cacheCreationTokens).toBe(100)
    expect(cp.usage.costUsd).toBe(0.50)
    expect(cp.timestamp).toBe(1700001000000)
  })

  it('creates a copy of messages (not reference)', () => {
    const messages = [{ role: 'user' as const, content: 'Hello' }]
    const session: SessionState = {
      sessionId: 'sess-123',
      messages,
      turnCount: 1,
      totalUsage: {
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
        cacheCreationTokens: 0, costUsd: 0, model: '',
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }

    const cp = createCheckpoint(session)
    expect(cp.messages).not.toBe(messages) // Different reference
    expect(cp.messages).toEqual(messages) // Same content
  })
})

describe('validateCheckpoint', () => {
  it('returns true for valid checkpoint', () => {
    expect(validateCheckpoint(sampleCheckpoint)).toBe(true)
  })

  it('returns false for null', () => {
    expect(validateCheckpoint(null)).toBe(false)
  })

  it('returns false for non-object', () => {
    expect(validateCheckpoint('string')).toBe(false)
    expect(validateCheckpoint(42)).toBe(false)
  })

  it('returns false for missing sessionId', () => {
    expect(validateCheckpoint({ ...sampleCheckpoint, sessionId: undefined })).toBe(false)
  })

  it('returns false for empty sessionId', () => {
    expect(validateCheckpoint({ ...sampleCheckpoint, sessionId: '' })).toBe(false)
  })

  it('returns false for non-array messages', () => {
    expect(validateCheckpoint({ ...sampleCheckpoint, messages: 'not array' })).toBe(false)
  })

  it('returns false for negative turnIndex', () => {
    expect(validateCheckpoint({ ...sampleCheckpoint, turnIndex: -1 })).toBe(false)
  })

  it('returns false for NaN turnIndex', () => {
    expect(validateCheckpoint({ ...sampleCheckpoint, turnIndex: NaN })).toBe(false)
  })

  it('returns false for zero timestamp', () => {
    expect(validateCheckpoint({ ...sampleCheckpoint, timestamp: 0 })).toBe(false)
  })

  it('returns false for missing usage', () => {
    expect(validateCheckpoint({ ...sampleCheckpoint, usage: undefined })).toBe(false)
  })

  it('returns false for incomplete usage', () => {
    expect(validateCheckpoint({
      ...sampleCheckpoint,
      usage: { inputTokens: 100 },
    })).toBe(false)
  })

  it('returns false for NaN in usage fields', () => {
    expect(validateCheckpoint({
      ...sampleCheckpoint,
      usage: { ...sampleCheckpoint.usage, inputTokens: NaN },
    })).toBe(false)
  })
})
