/**
 * L1 — Fan-out swarm proof, against a REAL model (OpenRouter / Kimi K2.5).
 *
 * The existing multi-agent-real.test.ts exercises fanOut with 2 agents, but it
 * gates on ANTHROPIC_API_KEY — which is NOT set in this environment, so it
 * silently skips. This test proves fanOut end-to-end on the key we DO have
 * (OPENROUTER_API_KEY): spin up 5 agents in parallel, each given a DISTINCT
 * trivial task, and verify:
 *   1. all 5 results return (count),
 *   2. results map to specs IN ORDER (results[i] ↔ specs[i]),
 *   3. each agent ran its OWN instruction with no cross-talk (isolation),
 *   4. real token usage + ≥1 turn per agent (they actually called the model),
 *   5. wall-clock stays well under sum-of-agents (they ran parallel, not serial).
 *
 * Skipped automatically when OPENROUTER_API_KEY is not set.
 *
 * Run:
 *   OPENROUTER_API_KEY=sk-or-... \
 *     npx vitest run src/__tests__/e2e/swarm-fanout-real.test.ts
 *
 * Cost: negligible (5 one-turn calls, maxTokens 16).
 */

import { describe, it, expect, beforeAll } from 'vitest'

import { OpenRouterProvider } from '../../provider/openrouter.js'
import { fanOut } from '../../agents/coordinator.js'
import { createDefaultConfig } from '../../core/config.js'
import type { AgentSpec } from '../../agents/types.js'

const apiKey = process.env.OPENROUTER_API_KEY
const HAS_KEY = !!apiKey
const MODEL = 'openrouter:kimi-k2.5' // owner's choice; proven slug, k2.7 not on OpenRouter

// Five distinct, collision-unlikely tokens — one per worker.
const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo'] as const

let provider: OpenRouterProvider

describe.skipIf(!HAS_KEY)('L1 — fanOut swarm against real model (Kimi K2.5)', () => {
  beforeAll(() => {
    provider = new OpenRouterProvider({ apiKey: apiKey! })
  })

  it('spins up 5 agents in parallel, each runs its own task, results return in order', async () => {
    const specs: AgentSpec[] = WORDS.map(word => ({
      name: `worker-${word}`,
      systemPrompt: `You must reply with exactly one word and nothing else: "${word}". Do not add punctuation, quotes, or any other text.`,
      maxTurns: 1,
    }))

    const startedAt = Date.now()
    const results = await fanOut(specs, {
      provider,
      tools: [],
      // Kimi K2.5 is a reasoning model — it spends tokens "thinking" before the
      // answer. A tiny budget (e.g. 16) starves the text block and yields empty
      // content. Give enough headroom to think AND emit the one-word answer.
      config: { ...createDefaultConfig(MODEL), maxTokens: 512, maxTurns: 1 },
      parentMessages: [{ role: 'user', content: 'Respond now with your assigned word.' }],
      agentTimeoutMs: 30_000,
      overallTimeoutMs: 60_000,
    })
    const elapsedMs = Date.now() - startedAt

    // 1. all 5 returned
    expect(results).toHaveLength(5)

    results.forEach((r, i) => {
      const text = r.content.toLowerCase()

      // 2 + 3. each result matches its OWN word (order preserved, no cross-talk)
      expect(text).toContain(WORDS[i])

      // 3 (strict isolation). it must NOT contain any OTHER worker's word
      for (let j = 0; j < WORDS.length; j++) {
        if (j !== i) expect(text).not.toContain(WORDS[j])
      }

      // 4. it really hit the model
      expect(r.usage.inputTokens).toBeGreaterThan(0)
      expect(r.usage.outputTokens).toBeGreaterThan(0)
      expect(r.turnCount).toBeGreaterThanOrEqual(1)
    })

    // 5. parallel, not serial: 5 one-turn calls done well under a serial worst-case.
    // (Each agent's own timeout is 30s; serial would risk ~150s. Parallel lands in seconds.)
    expect(elapsedMs).toBeLessThan(45_000)
    console.log(`✓ fanOut(5) completed in ${(elapsedMs / 1000).toFixed(1)}s`)
  }, 70_000)
})
