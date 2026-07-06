/**
 * L3 — Per-worker event streaming, against a REAL model (OpenRouter / Kimi K2.5).
 *
 * Before L3, fanOut ran its workers "dark" — it built an internal AgentSpawner
 * with no event hook, so only the final results came back. L3 threads an
 * `onEvent` hook through CoordinationOptions → spawner, delivering every
 * sub-agent event tagged by `agentId`, and enriches the lifecycle events with
 * the metadata a fan-out tree needs (name, model, task / status, usage).
 *
 * This test proves:
 *   1. STREAMING — fanOut(5) with onEvent delivers each worker's events live.
 *   2. ATTRIBUTION — every event carries its worker's agentId (no orphan events).
 *   3. ENRICHED SPAWN — agent.spawn carries name + model + task.
 *   4. ENRICHED TERMINAL — agent.complete carries status:'completed' + usage.
 *   5. NO GHOSTS (reliability) — an ABORTED worker still emits exactly ONE
 *      terminal agent.complete (status:'aborted'). A worker can never hang.
 *
 * Skipped automatically when OPENROUTER_API_KEY is not set.
 *
 * Run:
 *   OPENROUTER_API_KEY=sk-or-... \
 *     npx vitest run src/__tests__/e2e/swarm-events-real.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest'

import { OpenRouterProvider } from '../../provider/openrouter.js'
import { fanOut } from '../../agents/coordinator.js'
import { AgentSpawner } from '../../agents/spawner.js'
import { createDefaultConfig } from '../../core/config.js'
import type { AgentSpec } from '../../agents/types.js'
import type { LoomEvent, AgentSpawnEvent, AgentCompleteEvent } from '../../core/events.js'

const apiKey = process.env.OPENROUTER_API_KEY
const HAS_KEY = !!apiKey
const MODEL = 'openrouter:kimi-k2.5'
const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo'] as const

let provider: OpenRouterProvider

type Captured = { agentId: string; event: LoomEvent }

async function waitFor(cond: () => boolean, timeoutMs = 6000, stepMs = 50): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise(r => setTimeout(r, stepMs))
  }
}

describe.skipIf(!HAS_KEY)('L3 — per-worker event streaming (Kimi K2.5)', () => {
  beforeAll(() => {
    provider = new OpenRouterProvider({ apiKey: apiKey! })
  })

  it('fanOut(5) streams attributed, enriched events for every worker', async () => {
    const captured: Captured[] = []

    const specs: AgentSpec[] = WORDS.map(word => ({
      name: `worker-${word}`,
      systemPrompt: `Reply with exactly one word and nothing else: "${word}".`,
      maxTurns: 1,
    }))

    const results = await fanOut(specs, {
      provider,
      tools: [],
      config: { ...createDefaultConfig(MODEL), maxTokens: 512, maxTurns: 1 },
      parentMessages: [{ role: 'user', content: 'Respond now with your assigned word.' }],
      agentTimeoutMs: 30_000,
      overallTimeoutMs: 60_000,
      onEvent: (event, agentId) => { captured.push({ agentId, event }) },
    })
    expect(results).toHaveLength(5)

    // 1 + 3. Five enriched spawns — each with name, model, task.
    const spawns = captured
      .filter(c => c.event.type === 'agent.spawn')
      .map(c => c.event as AgentSpawnEvent)
    expect(spawns).toHaveLength(5)
    spawns.forEach(s => {
      expect(s.name).toMatch(/^worker-/)
      expect(s.model).toContain('kimi')
      expect((s.task ?? '').length).toBeGreaterThan(0)
    })

    // 4. Five enriched terminals — status completed + real usage.
    const terminals = captured
      .filter(c => c.event.type === 'agent.complete')
      .map(c => c.event as AgentCompleteEvent)
    expect(terminals).toHaveLength(5)
    terminals.forEach(t => {
      expect(t.status).toBe('completed')
      expect(t.usage).toBeDefined() // usage object flows through the terminal event
      expect(t.turnCount ?? 0).toBeGreaterThanOrEqual(1)
    })
    // Real token accounting in aggregate. (Per-worker inputTokens can read 0 on
    // a given call due to provider usage-reporting variance — that's not what
    // L3 verifies; L3 verifies the usage plumbing, so assert the sum is real.)
    const totalInputTokens = terminals.reduce((s, t) => s + (t.usage?.inputTokens ?? 0), 0)
    expect(totalInputTokens).toBeGreaterThan(0)

    // 2. Attribution — spawn ids == terminal ids, 5 distinct workers, no orphans.
    const spawnIds = new Set(captured.filter(c => c.event.type === 'agent.spawn').map(c => c.agentId))
    const termIds = new Set(captured.filter(c => c.event.type === 'agent.complete').map(c => c.agentId))
    expect(spawnIds.size).toBe(5)
    expect([...spawnIds].sort()).toEqual([...termIds].sort())

    // Activity — turn.end events stream live and are attributed (the "running
    // tokens" the tree shows mid-flight). Every captured event has an agentId.
    const turnEnds = captured.filter(c => c.event.type === 'turn.end')
    expect(turnEnds.length).toBeGreaterThanOrEqual(5)
    captured.forEach(c => expect(c.agentId).toBeTruthy())
  }, 70_000)

  it('an aborted worker still emits exactly one terminal (no ghosts)', async () => {
    const captured: Captured[] = []

    // Deterministic abort: kill the worker the instant it spawns (from inside
    // the hook), so the model can never finish first — no timing race.
    const spawner = new AgentSpawner({
      provider,
      tools: [],
      config: { ...createDefaultConfig(MODEL), maxTokens: 2048, maxTurns: 10 },
      onEvent: (event, agentId) => {
        captured.push({ agentId, event })
        if (event.type === 'agent.spawn') spawner.abort(agentId)
      },
    })

    const handle = await spawner.spawn(
      {
        name: 'doomed-essay',
        systemPrompt: 'Write a very long, detailed essay of at least 2000 words.',
        maxTurns: 10,
      },
      'isolated',
      [{ role: 'user', content: 'Write a detailed 2000+ word essay about the history of computing.' }],
    )

    await expect(spawner.waitForAgent(handle.id)).rejects.toThrow(/abort/i)

    // The terminal fires in runAgent's `finally` after the loop unwinds — poll for it.
    await waitFor(() => captured.some(c => c.event.type === 'agent.complete'))

    const terminals = captured
      .filter(c => c.event.type === 'agent.complete')
      .map(c => c.event as AgentCompleteEvent)

    // Exactly one terminal, status 'aborted'. No ghost, no double-emit.
    expect(terminals).toHaveLength(1)
    expect(terminals[0].status).toBe('aborted')
    expect(captured.every(c => c.agentId === handle.id)).toBe(true)
  }, 30_000)
})
