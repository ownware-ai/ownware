/**
 * Integration test — Session.getMetrics() and Session.getCostBreakdown()
 *
 * Proves the unified metrics shape works through Session against the
 * mock provider. End-to-end: create session, submit messages, ask
 * for metrics, assert the breakdown matches.
 */

import { describe, it, expect } from 'vitest'

import { Session } from '../../../src/core/session.js'
import { createDefaultConfig, mergeConfig } from '../../../src/core/config.js'
import { createMockProvider } from '../../helpers/mock-provider.js'

const MODEL = 'anthropic:claude-sonnet-4'

function buildSession() {
  const provider = createMockProvider({ summaryResponse: 'ok' })
  const config = mergeConfig(createDefaultConfig(MODEL), {
    systemPrompt: 'You are an assistant.',
  })
  const session = new Session({
    config,
    provider,
    tools: [],
    compaction: null,
  })
  return { provider, session }
}

async function drain<T, R>(gen: AsyncGenerator<T, R>): Promise<R> {
  while (true) {
    const next = await gen.next()
    if (next.done) return next.value
  }
}

describe('Session.getCostBreakdown()', () => {
  it('returns zero state for a brand-new session', async () => {
    const { session } = buildSession()
    const cost = await session.getCostBreakdown()

    expect(cost.totalUsd).toBe(0)
    expect(cost.avgUsdPerTurn).toBe(0)
    expect(cost.turnCount).toBe(0)
    expect(cost.tokens.total).toBe(0)
  })

  it('accumulates after a submitMessage', async () => {
    const { session } = buildSession()
    await drain(session.submitMessage('do something useful'))

    const cost = await session.getCostBreakdown()
    expect(cost.turnCount).toBeGreaterThan(0)
    expect(cost.tokens.input).toBeGreaterThan(0)
    expect(cost.tokens.output).toBeGreaterThan(0)
  })
})

describe('Session.getMetrics()', () => {
  it('combines context + cost in one snapshot', async () => {
    const { session } = buildSession()
    const m = await session.getMetrics({ exact: false })

    expect(m.model).toBe(MODEL)
    expect(m.turnCount).toBe(0)
    expect(m.context).toBeDefined()
    expect(m.cost).toBeDefined()
    expect(m.context.contextWindow).toBe(200_000)
    expect(m.cost.totalUsd).toBe(0)
  })

  it('grows as the session accumulates messages', async () => {
    const { session } = buildSession()
    const before = await session.getMetrics({ exact: false })
    await drain(session.submitMessage('hello'))
    const after = await session.getMetrics({ exact: false })

    expect(after.turnCount).toBeGreaterThan(before.turnCount)
    expect(after.context.used).toBeGreaterThan(before.context.used)
    expect(after.cost.tokens.total).toBeGreaterThan(before.cost.tokens.total)
  })

  it('mirrors getContextUsage and getCostBreakdown — no drift', async () => {
    const { session } = buildSession()
    await drain(session.submitMessage('quick task'))

    const m = await session.getMetrics({ exact: false })
    const ctx = await session.getContextUsage({ exact: false })
    const cost = await session.getCostBreakdown()

    expect(m.context).toEqual(ctx)
    expect(m.cost).toEqual(cost)
  })
})
