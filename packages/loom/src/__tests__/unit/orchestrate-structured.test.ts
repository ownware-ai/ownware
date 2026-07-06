/**
 * Unit — orchestrate `output_schema` (structured output).
 *
 * Proves the parse / validate / retry path deterministically with a mock
 * spawner, so the logic is covered without a real model:
 *
 *   • valid JSON (with code fences / stray prose) → parsed into metadata.results
 *   • missing a required key → one retry, then success
 *   • never-valid output → ok:false, structured null, failure counted
 *   • no output_schema → unchanged free-text behavior
 *   • the retry carries a sharper "not valid JSON" instruction
 */

import { describe, it, expect } from 'vitest'
import { orchestrate } from '../../tools/builtins/orchestrate.js'
import type { ToolContext, ToolResult } from '../../tools/types.js'

/** A fake AgentSpawner: `script(message, callIndex)` decides each worker's reply. */
function makeSpawner(script: (message: string, callIndex: number) => string) {
  const seen: string[] = []
  const byId = new Map<string, string>()
  let n = 0
  const spawner = {
    async spawn(_spec: unknown, _mode: string, messages: { role: string; content: string }[]) {
      const message = messages[messages.length - 1]!.content
      seen.push(message)
      const id = `a${n}`
      byId.set(id, script(message, n))
      n += 1
      return { id }
    },
    async waitForAgent(id: string) {
      return { content: byId.get(id) ?? '', turnCount: 1, usage: {} }
    },
  }
  return { spawner, seen, calls: () => n }
}

function ctx(spawner: unknown): ToolContext {
  return { config: { agentSpawner: spawner } } as unknown as ToolContext
}

const SCHEMA = {
  type: 'object',
  properties: { city: { type: 'string' }, pop: { type: 'number' } },
  required: ['city', 'pop'],
}

describe('orchestrate — output_schema (structured output)', () => {
  it('parses valid JSON (with code fences) into metadata.results', async () => {
    const { spawner } = makeSpawner(() => '```json\n{"city":"Paris","pop":2}\n```')
    const result = (await orchestrate.execute(
      { shape: 'fan-out', tasks: [{ name: 'w', prompt: 'go', output_schema: SCHEMA }] },
      ctx(spawner),
    )) as ToolResult

    expect(result.isError).toBe(false)
    const results = result.metadata?.results as Array<{ ok: boolean; structured: unknown }>
    expect(results[0]!.ok).toBe(true)
    expect(results[0]!.structured).toEqual({ city: 'Paris', pop: 2 })
  })

  it('tolerates stray prose around the JSON object', async () => {
    const { spawner } = makeSpawner(() => 'Sure! Here you go: {"city":"Rome","pop":3} — done.')
    const result = (await orchestrate.execute(
      { shape: 'fan-out', tasks: [{ name: 'w', prompt: 'go', output_schema: SCHEMA }] },
      ctx(spawner),
    )) as ToolResult
    const results = result.metadata?.results as Array<{ structured: unknown }>
    expect(results[0]!.structured).toEqual({ city: 'Rome', pop: 3 })
  })

  it('retries once when a required key is missing, then succeeds', async () => {
    const ms = makeSpawner((_m, i) => (i === 0 ? '{"city":"Berlin"}' : '{"city":"Berlin","pop":4}'))
    const result = (await orchestrate.execute(
      { shape: 'fan-out', tasks: [{ name: 'w', prompt: 'go', output_schema: SCHEMA }] },
      ctx(ms.spawner),
    )) as ToolResult

    expect(ms.calls()).toBe(2) // first attempt + one retry
    expect(ms.seen[1]).toContain('not valid JSON') // retry got the sharper instruction
    const results = result.metadata?.results as Array<{ ok: boolean; structured: unknown }>
    expect(results[0]!.ok).toBe(true)
    expect(results[0]!.structured).toEqual({ city: 'Berlin', pop: 4 })
  })

  it('marks the worker failed when output never validates', async () => {
    const ms = makeSpawner(() => 'not json at all')
    const result = (await orchestrate.execute(
      { shape: 'fan-out', tasks: [{ name: 'w', prompt: 'go', output_schema: SCHEMA }] },
      ctx(ms.spawner),
    )) as ToolResult

    expect(ms.calls()).toBe(2) // tried twice
    expect(result.metadata?.failures).toBe(1)
    const results = result.metadata?.results as Array<{ ok: boolean; structured: unknown }>
    expect(results[0]!.ok).toBe(false)
    expect(results[0]!.structured).toBeNull()
  })

  it('leaves free-text behavior unchanged when no output_schema is given', async () => {
    const ms = makeSpawner(() => 'plain answer')
    const result = (await orchestrate.execute(
      { shape: 'fan-out', tasks: [{ name: 'w', prompt: 'go' }] },
      ctx(ms.spawner),
    )) as ToolResult

    expect(ms.calls()).toBe(1) // no retry loop
    expect(result.content).toContain('plain answer')
    const results = result.metadata?.results as Array<{ ok: boolean; structured: unknown }>
    expect(results[0]!.ok).toBe(true)
    expect(results[0]!.structured).toBeNull()
  })
})
