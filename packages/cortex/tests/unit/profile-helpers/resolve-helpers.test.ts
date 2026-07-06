/**
 * Unit tests for `resolveHelpers` — the gateway-side adapter that turns
 * a parent profile's `subagents` array into the wire shape the client
 * consumes (icon, color, avatar, model, abilityCount fully resolved).
 *
 * Uses a hand-rolled minimal ProfileRegistry stub so the tests stay
 * pure (no filesystem, no real loaders).
 */

import { describe, expect, it } from 'vitest'
import { resolveHelpers } from '../../../src/gateway/handlers/profiles.js'
import type { ProfileRegistry } from '../../../src/profile/registry.js'

interface StubLoaded {
  config: {
    name: string
    description?: string
    model: string
    metadata: { icon?: string; color?: string; avatar?: { bg: string; fg: string; accent: string; symbol: string } | null }
    tools: { preset?: string; allow: string[]; deny: string[]; custom: unknown[]; mcp: Record<string, unknown> }
    security?: { level?: string }
  }
}

function makeRegistry(map: Record<string, StubLoaded>): ProfileRegistry {
  return {
    has: (id: string) => Object.prototype.hasOwnProperty.call(map, id),
    get: async (id: string) => {
      const entry = map[id]
      if (!entry) throw new Error(`profile not found: ${id}`)
      return entry as never
    },
  } as unknown as ProfileRegistry
}

const explorer: StubLoaded = {
  config: {
    name: 'explore',
    description: 'Search the codebase',
    model: 'anthropic:claude-haiku-4-5',
    metadata: { icon: 'search', color: 'teal', avatar: null },
    tools: { preset: 'readonly', allow: [], deny: [], custom: [], mcp: {} },
    security: { level: 'standard' },
  },
}

describe('resolveHelpers', () => {
  it('resolves a linked subagent against the registry', async () => {
    const out = await resolveHelpers(
      [{ name: 'explore', description: '', profile: 'explore' }],
      makeRegistry({ explore: explorer }),
    )
    expect(out).toHaveLength(1)
    const [h] = out
    expect(h?.profileRef).toBe('explore')
    expect(h?.inline).toBe(false)
    expect(h?.icon).toBe('search')
    expect(h?.color).toBe('teal')
    expect(h?.model).toBe('anthropic:claude-haiku-4-5')
    expect(h?.abilityCount).toBe(4) // readonly preset = 4 fs tools
    expect(h?.accessLevel).toBe('scoped') // security.level "standard" → scoped
  })

  it('uses subagent overrides over helper profile defaults', async () => {
    const out = await resolveHelpers(
      [
        {
          name: 'fast-explore',
          description: 'Override description',
          profile: 'explore',
          model: 'anthropic:claude-opus-4-20250514',
        },
      ],
      makeRegistry({ explore: explorer }),
    )
    const [h] = out
    expect(h?.name).toBe('fast-explore')
    expect(h?.description).toBe('Override description')
    expect(h?.model).toBe('anthropic:claude-opus-4-20250514')
  })

  it('treats model="inherit" as no override', async () => {
    const out = await resolveHelpers(
      [{ name: 'explore', description: '', profile: 'explore', model: 'inherit' }],
      makeRegistry({ explore: explorer }),
    )
    expect(out[0]?.model).toBe('anthropic:claude-haiku-4-5')
  })

  it('returns inline shape for subagents without a profile ref', async () => {
    const out = await resolveHelpers(
      [{ name: 'inline', description: 'no shared profile', model: 'anthropic:claude-haiku-4-5' }],
      makeRegistry({}),
    )
    const [h] = out
    expect(h?.profileRef).toBeNull()
    expect(h?.inline).toBe(true)
    expect(h?.abilityCount).toBeNull()
    expect(h?.icon).toBeNull()
    expect(h?.color).toBeNull()
    expect(h?.model).toBe('anthropic:claude-haiku-4-5')
    expect(h?.accessLevel).toBe('scoped')
  })

  it('falls back to inline shape when the referenced profile is missing', async () => {
    const out = await resolveHelpers(
      [{ name: 'ghost', description: 'pointed at a deleted profile', profile: 'gone' }],
      makeRegistry({}),
    )
    const [h] = out
    expect(h?.inline).toBe(true)
    expect(h?.profileRef).toBeNull()
    expect(h?.name).toBe('ghost')
  })

  it('falls back to inline shape when registry.get throws', async () => {
    const reg = {
      has: () => true,
      get: async () => { throw new Error('boom') },
    } as unknown as ProfileRegistry
    const out = await resolveHelpers(
      [{ name: 'broken', description: 'broken helper', profile: 'broken' }],
      reg,
    )
    expect(out[0]?.inline).toBe(true)
    expect(out[0]?.profileRef).toBeNull()
  })

  it('preserves order and resolves multiple helpers in one pass', async () => {
    const planner: StubLoaded = {
      config: {
        name: 'planner',
        model: 'anthropic:claude-sonnet-4-20250514',
        metadata: { icon: 'route', color: 'violet' },
        tools: { preset: 'full', allow: [], deny: [], custom: [], mcp: {} },
        security: { level: 'paranoid' },
      },
    }
    const out = await resolveHelpers(
      [
        { name: 'explore', description: '', profile: 'explore' },
        { name: 'planner', description: '', profile: 'planner' },
      ],
      makeRegistry({ explore: explorer, planner }),
    )
    expect(out.map((h) => h.name)).toEqual(['explore', 'planner'])
    expect(out[1]?.icon).toBe('route')
    expect(out[1]?.color).toBe('violet')
    expect(out[1]?.accessLevel).toBe('strict') // paranoid → strict
    expect(out[1]?.abilityCount).toBeGreaterThan(20) // full preset
  })
})
