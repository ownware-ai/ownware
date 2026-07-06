/**
 * Integration test — Session.getContextUsage()
 *
 * Proves the breakdown grows correctly as the session accumulates
 * messages and skills, using the mock provider (no API key).
 */

import { describe, it, expect } from 'vitest'

import { Session } from '../../../src/core/session.js'
import { createDefaultConfig, mergeConfig } from '../../../src/core/config.js'
import { createMockProvider } from '../../helpers/mock-provider.js'
import { createSkillTool } from '../../../src/tools/builtins/skill.js'
import { SkillRegistry } from '../../../src/skills/registry.js'

import type { Tool } from '../../../src/tools/types.js'

const MODEL = 'anthropic:claude-sonnet-4'

function buildSession(opts: { systemPrompt?: string; tools?: Tool[] } = {}) {
  const provider = createMockProvider({ summaryResponse: 'OK' })
  const config = mergeConfig(createDefaultConfig(MODEL), {
    systemPrompt: opts.systemPrompt ?? 'You are an assistant. Be concise.',
  })
  const session = new Session({
    config,
    provider,
    tools: opts.tools ?? [],
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

describe('Session.getContextUsage()', () => {
  it('returns a sensible baseline before any messages are submitted', async () => {
    const { session } = buildSession()
    const usage = await session.getContextUsage()

    expect(usage.model).toBe(MODEL)
    expect(usage.contextWindow).toBe(200_000)
    expect(usage.used).toBeGreaterThan(0)         // system prompt has content
    expect(usage.breakdown.systemPrompt).toBeGreaterThan(0)
    expect(usage.breakdown.messages).toBe(0)
    expect(usage.breakdown.tools).toBe(0)
    expect(usage.breakdown.skills).toBe(0)
    expect(usage.utilization).toBeLessThan(0.01)
  })

  it('messages grow after submitMessage is called', async () => {
    const { session } = buildSession()
    const before = await session.getContextUsage()

    await drain(session.submitMessage('do some work please'))

    const after = await session.getContextUsage()
    expect(after.breakdown.messages).toBeGreaterThan(before.breakdown.messages)
    expect(after.used).toBeGreaterThan(before.used)
  })

  it('tools count is non-zero when tools are registered', async () => {
    const skillTool = createSkillTool(new SkillRegistry())
    const { session } = buildSession({ tools: [skillTool] })

    const usage = await session.getContextUsage()
    expect(usage.breakdown.tools).toBeGreaterThan(20)
    expect(usage.breakdown.tools).toBeLessThan(2_000)
  })

  it('breakdown sums to used regardless of inputs', async () => {
    const skillTool = createSkillTool(new SkillRegistry())
    const { session } = buildSession({
      systemPrompt: 'You are a focused assistant. Treat reminders as harness instructions.',
      tools: [skillTool],
    })
    await drain(session.submitMessage('please help'))

    const usage = await session.getContextUsage()
    const sum = usage.breakdown.systemPrompt
      + usage.breakdown.tools
      + usage.breakdown.memory
      + usage.breakdown.skills
      + usage.breakdown.messages
    expect(sum).toBe(usage.used)
    expect(usage.used + usage.free).toBe(usage.contextWindow)
  })

  it('utilization is the ratio of used to window', async () => {
    const { session } = buildSession()
    const usage = await session.getContextUsage()
    if (usage.contextWindow > 0) {
      expect(usage.utilization).toBeCloseTo(usage.used / usage.contextWindow, 6)
    }
  })

  it('repeated calls are deterministic for an unchanged session', async () => {
    const { session } = buildSession()
    const a = await session.getContextUsage()
    const b = await session.getContextUsage()
    expect(b).toEqual(a)
  })
})
