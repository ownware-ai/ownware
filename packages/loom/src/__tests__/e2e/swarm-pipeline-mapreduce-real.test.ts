/**
 * L2 — Pipeline + Map-reduce proof, against a REAL model (OpenRouter / Kimi K2.5).
 *
 * Companion to L1 (swarm-fanout-real.test.ts). Proves the other two coordination
 * shapes end-to-end on the key we have (OPENROUTER_API_KEY):
 *
 *   • pipeline — output of stage N becomes input of stage N+1.
 *       Designed so the final number ONLY appears if the value threaded through
 *       all 3 stages: 5  →(+10)→ 15  →(×2)→ 30.  Any broken handoff breaks 30.
 *
 *   • mapReduce — 3 parallel mappers each emit one color; one reducer merges.
 *       The reducer's output must contain ALL three colors → proves every map
 *       result reached the reduce step.
 *
 * Skipped automatically when OPENROUTER_API_KEY is not set.
 *
 * Run:
 *   OPENROUTER_API_KEY=sk-or-... \
 *     npx vitest run src/__tests__/e2e/swarm-pipeline-mapreduce-real.test.ts
 *
 * Cost: negligible (a handful of one-turn calls).
 */

import { describe, it, expect, beforeAll } from 'vitest'

import { OpenRouterProvider } from '../../provider/openrouter.js'
import { pipeline, mapReduce } from '../../agents/coordinator.js'
import { createDefaultConfig } from '../../core/config.js'
import type { AgentSpec } from '../../agents/types.js'
import type { CoordinationOptions } from '../../agents/coordinator.js'

const apiKey = process.env.OPENROUTER_API_KEY
const HAS_KEY = !!apiKey
const MODEL = 'openrouter:kimi-k2.5' // owner's choice; proven slug, k2.7 not on OpenRouter

let provider: OpenRouterProvider

function opts(extra?: Partial<CoordinationOptions>): CoordinationOptions {
  return {
    provider,
    tools: [],
    // 512 tokens: enough headroom for a reasoning model to think AND answer
    // (see L1 finding F1 — a tiny budget starves the text block).
    config: { ...createDefaultConfig(MODEL), maxTokens: 512, maxTurns: 1 },
    agentTimeoutMs: 30_000,
    overallTimeoutMs: 60_000,
    ...extra,
  }
}

describe.skipIf(!HAS_KEY)('L2 — pipeline + mapReduce against real model (Kimi K2.5)', () => {
  beforeAll(() => {
    provider = new OpenRouterProvider({ apiKey: apiKey! })
  })

  it('pipeline threads output → input across 3 stages (5 →+10→ 15 →×2→ 30)', async () => {
    const stages: AgentSpec[] = [
      {
        name: 'stage1-seed',
        systemPrompt: 'Ignore the input. Reply with exactly this and nothing else: 5',
        maxTurns: 1,
      },
      {
        name: 'stage2-add10',
        systemPrompt: 'The input is a number. Add 10 to it. Reply with ONLY the resulting number, no words.',
        maxTurns: 1,
      },
      {
        name: 'stage3-double',
        systemPrompt: 'The input is a number. Multiply it by 2. Reply with ONLY the resulting number, no words.',
        maxTurns: 1,
      },
    ]

    const result = await pipeline(stages, 'Begin.', opts())

    // 30 only exists if 5 threaded → 15 threaded → 30. Proves the handoffs.
    expect(result.content).toContain('30')
    expect(result.turnCount).toBeGreaterThanOrEqual(1)
    console.log(`✓ pipeline final = ${JSON.stringify(result.content.slice(0, 40))}`)
  }, 70_000)

  it('mapReduce maps 3 colors in parallel then reduces them into one answer', async () => {
    const COLORS = ['crimson', 'olive', 'indigo'] as const

    const mapSpecs: AgentSpec[] = COLORS.map(c => ({
      name: `map-${c}`,
      systemPrompt: `Reply with exactly one word and nothing else: "${c}".`,
      maxTurns: 1,
    }))

    const reduceSpec: AgentSpec = {
      name: 'reduce-merge',
      systemPrompt:
        'You receive several labeled results, each containing one color word. ' +
        'Reply with all of those color words, comma-separated, and nothing else.',
      maxTurns: 1,
    }

    const result = await mapReduce(mapSpecs, reduceSpec, opts({
      parentMessages: [{ role: 'user', content: 'Respond now with your assigned word.' }],
    }))

    const text = result.content.toLowerCase()
    // Every mapped color must survive into the reduced output → all 3 reached reduce.
    COLORS.forEach(c => expect(text).toContain(c))
    console.log(`✓ mapReduce merged = ${JSON.stringify(result.content.slice(0, 80))}`)
  }, 70_000)
})
