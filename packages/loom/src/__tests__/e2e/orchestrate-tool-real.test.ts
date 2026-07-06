/**
 * L4 — The model-facing `orchestrate` tool, against a REAL model (Kimi K2.5).
 *
 * Proves the single orchestration tool routes a `shape` parameter to real
 * multi-agent runs through the injected AgentSpawner (the same one agent_spawn
 * uses — so per-worker events stream for free):
 *
 *   • fan-out    — 3 independent workers run in parallel; all results returned.
 *   • pipeline   — 3 stages thread output→input: 5 →+10→ 15 →×2→ 30.
 *   • map-reduce — 3 mappers fan out, a reducer merges them into one answer.
 *
 * This drives the tool's execute() with a real spawner (real sub-agent model
 * calls) — the same path the loop takes when a lead agent calls the tool.
 *
 * Skipped automatically when OPENROUTER_API_KEY is not set.
 *
 * Run:
 *   OPENROUTER_API_KEY=sk-or-... \
 *     npx vitest run src/__tests__/e2e/orchestrate-tool-real.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest'

import { OpenRouterProvider } from '../../provider/openrouter.js'
import { AgentSpawner } from '../../agents/spawner.js'
import { orchestrate } from '../../tools/builtins/orchestrate.js'
import { createDefaultConfig } from '../../core/config.js'
import type { LoomConfig } from '../../core/config.js'
import type { ToolContext, ToolResult } from '../../tools/types.js'

const apiKey = process.env.OPENROUTER_API_KEY
const HAS_KEY = !!apiKey
const MODEL = 'openrouter:kimi-k2.5'

let provider: OpenRouterProvider

/** Minimal ToolContext whose config carries the injected spawner (as the gateway wires it). */
function makeContext(spawner: AgentSpawner): ToolContext {
  const config = { ...createDefaultConfig(MODEL), maxTokens: 512, agentSpawner: spawner } as unknown as LoomConfig
  return {
    cwd: process.cwd(),
    signal: new AbortController().signal,
    sessionId: 'l4-test',
    rootSessionId: 'l4-test',
    agentId: null,
    workspacePath: process.cwd(),
    additionalWorkspaceRoots: [],
    config,
    requestPermission: async () => true,
    requestCredential: async () => null,
    resolveCredential: () => null,
    listEnvCredentials: () => [],
    listAllCredentialValues: () => [],
  } as ToolContext
}

function newSpawner(): AgentSpawner {
  return new AgentSpawner({
    provider,
    tools: [],
    config: { ...createDefaultConfig(MODEL), maxTokens: 512, maxTurns: 2 },
  })
}

async function run(input: Record<string, unknown>): Promise<ToolResult> {
  return (await orchestrate.execute(input, makeContext(newSpawner()))) as ToolResult
}

describe.skipIf(!HAS_KEY)('L4 — orchestrate tool against real model (Kimi K2.5)', () => {
  beforeAll(() => {
    provider = new OpenRouterProvider({ apiKey: apiKey! })
  })

  it('shape="fan-out" runs all tasks in parallel and returns every result', async () => {
    const words = ['alpha', 'bravo', 'charlie']
    const result = await run({
      shape: 'fan-out',
      tasks: words.map(w => ({
        name: `worker-${w}`,
        prompt: `Reply with exactly one word and nothing else: ${w}`,
        max_turns: 1,
      })),
    })

    expect(result.isError).toBe(false)
    const text = result.content.toLowerCase()
    words.forEach(w => expect(text).toContain(w))
  }, 70_000)

  it('shape="pipeline" threads output → input (5 →+10→ 15 →×2→ 30)', async () => {
    const result = await run({
      shape: 'pipeline',
      tasks: [
        { name: 'seed', prompt: 'Ignore any previous output. Reply with exactly this and nothing else: 5', max_turns: 1 },
        { name: 'add10', prompt: 'Take the number in the previous output and add 10. Reply with ONLY the resulting number.', max_turns: 1 },
        { name: 'double', prompt: 'Take the number in the previous output and multiply it by 2. Reply with ONLY the resulting number.', max_turns: 1 },
      ],
    })

    expect(result.isError).toBe(false)
    expect(result.content).toContain('30')
  }, 70_000)

  it('shape="map-reduce" fans out tasks then reduces them to one answer', async () => {
    const colors = ['crimson', 'olive', 'indigo']
    const result = await run({
      shape: 'map-reduce',
      tasks: colors.map(c => ({
        name: `map-${c}`,
        prompt: `Reply with exactly one word and nothing else: ${c}`,
        max_turns: 1,
      })),
      reducer: {
        name: 'reduce',
        prompt: 'List every color word from the results below, comma-separated, and nothing else.',
        max_turns: 1,
      },
    })

    expect(result.isError).toBe(false)
    const text = result.content.toLowerCase()
    colors.forEach(c => expect(text).toContain(c))
  }, 70_000)

  it('output_schema makes workers return validated structured objects', async () => {
    const result = await run({
      shape: 'fan-out',
      tasks: ['table', 'elephant'].map(w => ({
        name: `len-${w}`,
        prompt: `The word is "${w}". Report the word and its letter count.`,
        max_turns: 1,
        output_schema: {
          type: 'object',
          properties: { word: { type: 'string' }, length: { type: 'number' } },
          required: ['word', 'length'],
        },
      })),
    })

    expect(result.isError).toBe(false)
    const results = result.metadata?.results as Array<{ ok: boolean; structured: unknown }>
    expect(results).toHaveLength(2)
    for (const r of results) {
      expect(r.ok).toBe(true)
      expect(r.structured).toMatchObject({ word: expect.any(String), length: expect.any(Number) })
    }
    const lengths = results.map(r => (r.structured as { length: number }).length).sort()
    expect(lengths).toEqual([5, 8]) // "table" = 5, "elephant" = 8
  }, 70_000)

  it('shape="map-reduce" without a reducer is a clean, typed error (not a crash)', async () => {
    const result = await run({
      shape: 'map-reduce',
      tasks: [{ name: 'x', prompt: 'reply: hi', max_turns: 1 }],
    })
    expect(result.isError).toBe(true)
    expect(result.metadata?.reason).toBe('no_reducer')
  }, 20_000)
})
