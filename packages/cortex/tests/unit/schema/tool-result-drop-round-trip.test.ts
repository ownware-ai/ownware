/**
 * Round-trip test — `compaction.toolResultDrop` survives every traversal
 * the gateway performs between an `agent.json` on disk and a Session
 * running in memory.
 *
 * The concern the test closes: a UI client (or any future profile editor)
 * will read a profile, mutate one unrelated field, and PUT the result
 * back. If the Zod schema silently dropped `toolResultDrop` on the way
 * through — because the field is deeply nested inside `compaction`, or
 * because a default rewrote the user's choice — the edit would
 * DISABLE the feature without any error being surfaced.
 *
 * These tests pin the two traversals that matter:
 *   1. Parse → Serialize → Parse yields the same value byte-for-byte.
 *   2. The default `enabled: false` is preserved through the round-trip
 *      (not silently dropped and re-defaulted).
 *
 * Runs at the schema layer, not the HTTP layer, because the HTTP layer
 * is a thin pass-through — validating the schema is the load-bearing
 * piece.
 */

import { describe, it, expect } from 'vitest'
import { ProfileSchema } from '../../../src/profile/schema.js'

const MINIMAL_WITH_DROP_ON = {
  name: 'round-trip-on',
  compaction: {
    toolResultDrop: {
      enabled: true,
      triggerFraction: 0.55,
      keepRecentTurns: 4,
      minBytesToDrop: 700,
      previewBytes: 120,
    },
  },
}

const MINIMAL_WITH_DROP_OFF = {
  name: 'round-trip-off',
  compaction: {
    toolResultDrop: {
      enabled: false,
    },
  },
}

describe('profile round-trip: compaction.toolResultDrop', () => {
  it('parse → serialize → parse yields byte-identical output (fully specified)', () => {
    const first = ProfileSchema.parse(MINIMAL_WITH_DROP_ON)
    // The first parse fills in schema defaults for every other field.
    // Serialize via JSON (what the gateway does when returning to the
    // client or writing back to disk) and re-parse.
    const serialized = JSON.parse(JSON.stringify(first))
    const second = ProfileSchema.parse(serialized)

    expect(second.compaction.toolResultDrop).toEqual({
      enabled: true,
      triggerFraction: 0.55,
      keepRecentTurns: 4,
      minBytesToDrop: 700,
      previewBytes: 120,
    })
    // The exact values we set must survive — not just be equal to some
    // default. If the schema's default rewrote our choice, this breaks.
    expect(second.compaction.toolResultDrop).toEqual(
      first.compaction.toolResultDrop,
    )
  })

  it('explicit enabled:false round-trips without being upgraded to a partial default', () => {
    // A user who explicitly disabled the feature (e.g., to avoid it on
    // a content-comparison profile) must have that choice respected
    // through every round-trip. An "all defaults" fallback that
    // silently flipped `enabled` back to `true` would be a correctness
    // bug.
    const first = ProfileSchema.parse(MINIMAL_WITH_DROP_OFF)
    const second = ProfileSchema.parse(JSON.parse(JSON.stringify(first)))
    expect(second.compaction.toolResultDrop.enabled).toBe(false)
  })

  it('profiles without the field parse to the safe default (enabled:false)', () => {
    // Existing agent.json files predating this schema must load clean
    // and converge on `enabled: false`. This is the back-compat
    // guarantee we made on the board.
    const first = ProfileSchema.parse({ name: 'legacy-profile' })
    expect(first.compaction.toolResultDrop.enabled).toBe(false)
    // And round-tripping the FULL parsed config (with every default
    // filled in) still converges on the same value.
    const second = ProfileSchema.parse(JSON.parse(JSON.stringify(first)))
    expect(second.compaction.toolResultDrop.enabled).toBe(false)
  })

  it('editing an unrelated field does not change toolResultDrop', () => {
    // Simulate what a profile editor would do: read → mutate one
    // field → write back. The compaction knobs must not shift.
    const loaded = ProfileSchema.parse(MINIMAL_WITH_DROP_ON)
    const edited = {
      ...JSON.parse(JSON.stringify(loaded)),
      description: 'changed description',
    }
    const reparsed = ProfileSchema.parse(edited)
    expect(reparsed.compaction.toolResultDrop).toEqual(
      loaded.compaction.toolResultDrop,
    )
    expect(reparsed.description).toBe('changed description')
  })

  it('rejects invalid values with a clear error (not silent defaulting)', () => {
    // If a client sends a malformed value — e.g., triggerFraction > 1
    // — Zod must throw. Silent coercion to a default would be a
    // security-shaped concern (an operator could think they set a
    // tight limit when they actually got the default).
    expect(() =>
      ProfileSchema.parse({
        name: 'bad',
        compaction: {
          toolResultDrop: { enabled: true, triggerFraction: 1.5 },
        },
      }),
    ).toThrow()
    expect(() =>
      ProfileSchema.parse({
        name: 'bad',
        compaction: {
          toolResultDrop: { enabled: true, keepRecentTurns: 0 },
        },
      }),
    ).toThrow()
    expect(() =>
      ProfileSchema.parse({
        name: 'bad',
        compaction: {
          toolResultDrop: { enabled: true, keepRecentTurns: -1 },
        },
      }),
    ).toThrow()
  })
})
