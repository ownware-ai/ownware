/**
 * Unit tests — profile.compaction.toolResultDrop → LoomConfig mapping.
 *
 * The schema exposes `compaction.toolResultDrop` as an opt-in block.
 * The assembler must translate it into `LoomConfig.compaction.toolResultDrop`
 * whenever the user enabled it, and must OMIT the field whenever the
 * user left the default (disabled). That way existing profiles — and
 * any profile that didn't explicitly opt in — keep today's wire shape
 * byte-for-byte; the feature is purely additive.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { assembleAgent } from '../../../src/profile/assembler.js'
import { loadProfile } from '../../../src/profile/loader.js'
import { createMinimalProfile } from '../../helpers/fixtures.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanups) await fn()
  cleanups.length = 0
})

function track<T extends { cleanup: () => Promise<void> }>(p: T): T {
  cleanups.push(p.cleanup)
  return p
}

describe('assembleAgent: compaction.toolResultDrop mapping', () => {
  it('default profile → LoomConfig.compaction.toolResultDrop is absent', async () => {
    // When the profile didn't opt in, the field must be absent. The
    // loop treats absent as "disabled" — same as before the feature
    // landed, so the wire shape is unchanged for every existing profile.
    const { dir } = track(await createMinimalProfile())
    const profile = await loadProfile(dir)
    const agent = await assembleAgent(profile)
    expect(
      (agent.config.compaction as { toolResultDrop?: unknown }).toolResultDrop,
    ).toBeUndefined()
  })

  it('explicit enabled:false → LoomConfig field still absent (no noise)', async () => {
    // An explicit disable is semantically identical to the default.
    // Forwarding it would put `{ enabled: false }` on the wire for
    // every profile that touched the field, adding cosmetic noise to
    // request diffs without any behavioural effect. Skip.
    const { dir } = track(
      await createMinimalProfile({
        compaction: { toolResultDrop: { enabled: false } },
      }),
    )
    const profile = await loadProfile(dir)
    const agent = await assembleAgent(profile)
    expect(
      (agent.config.compaction as { toolResultDrop?: unknown }).toolResultDrop,
    ).toBeUndefined()
  })

  it('enabled:true → LoomConfig field carries the full resolved shape', async () => {
    const { dir } = track(
      await createMinimalProfile({
        compaction: {
          toolResultDrop: {
            enabled: true,
            triggerFraction: 0.5,
            keepRecentTurns: 2,
            minBytesToDrop: 800,
            previewBytes: 80,
          },
        },
      }),
    )
    const profile = await loadProfile(dir)
    const agent = await assembleAgent(profile)
    // Fully-specified: every knob the user set reaches LoomConfig verbatim.
    expect(
      (agent.config.compaction as { toolResultDrop?: unknown }).toolResultDrop,
    ).toEqual({
      enabled: true,
      triggerFraction: 0.5,
      keepRecentTurns: 2,
      minBytesToDrop: 800,
      previewBytes: 80,
    })
  })

  it('enabled with only enabled:true provided → defaults fill in the rest', async () => {
    // Ergonomics: a profile author should not have to repeat every
    // default value to opt in. Zod's defaults populate the missing
    // fields and the mapping forwards them.
    const { dir } = track(
      await createMinimalProfile({
        compaction: { toolResultDrop: { enabled: true } },
      }),
    )
    const profile = await loadProfile(dir)
    const agent = await assembleAgent(profile)
    expect(
      (agent.config.compaction as { toolResultDrop?: unknown }).toolResultDrop,
    ).toEqual({
      enabled: true,
      triggerFraction: 0.6,
      keepRecentTurns: 3,
      minBytesToDrop: 500,
      previewBytes: 150,
    })
  })

  it('profile-on-disk without the field still loads clean', async () => {
    // Back-compat: old profiles that pre-date this schema field must
    // load without erroring. Zod's `.default({})` on the compaction
    // block handles this; the assertion pins it so a future schema
    // change that removes the default is caught immediately.
    const { dir } = track(await createMinimalProfile())
    const profile = await loadProfile(dir)
    expect(profile.config.compaction.toolResultDrop).toEqual({
      enabled: false,
      triggerFraction: 0.6,
      keepRecentTurns: 3,
      minBytesToDrop: 500,
      previewBytes: 150,
    })
  })
})
