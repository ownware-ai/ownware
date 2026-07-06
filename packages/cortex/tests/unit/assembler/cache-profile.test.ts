/**
 * Unit tests — profile.cache → LoomConfig.cacheProfile mapping.
 *
 * The profile schema exposes `cache.ttl` as an opt-in knob. The assembler
 * must translate it into `LoomConfig.cacheProfile` so Loom's loop emits
 * the matching TTL on every cache marker. The default ('5m') is
 * indistinguishable from absence, so we OMIT the field from LoomConfig in
 * that case — that way existing profiles cannot accidentally flip onto a
 * new TTL tier just because the schema gained a field.
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

describe('assembleAgent: profile.cache.ttl mapping', () => {
  it('default profile → LoomConfig.cacheProfile is absent (5m tier)', async () => {
    const { dir } = track(await createMinimalProfile())
    const profile = await loadProfile(dir)
    const agent = await assembleAgent(profile)
    // When the profile didn't opt into anything, the cacheProfile field
    // must be absent from LoomConfig. Loom's loop treats absent as the
    // 5-minute default, and keeping the field absent means the wire
    // shape stays byte-identical to pre-feature behaviour.
    expect(agent.config.cacheProfile).toBeUndefined()
  })

  it('profile with cache.ttl="5m" → LoomConfig.cacheProfile is still absent', async () => {
    // Explicit 5m is the default — no need to propagate it to LoomConfig.
    // If this were forwarded, every profile that declared it explicitly
    // would look different on the wire than a profile that omitted it,
    // which is noisy and misleading.
    const { dir } = track(await createMinimalProfile({ cache: { ttl: '5m' } }))
    const profile = await loadProfile(dir)
    const agent = await assembleAgent(profile)
    expect(agent.config.cacheProfile).toBeUndefined()
  })

  it('profile with cache.ttl="1h" → LoomConfig.cacheProfile = { ttl: "1h" }', async () => {
    const { dir } = track(await createMinimalProfile({ cache: { ttl: '1h' } }))
    const profile = await loadProfile(dir)
    const agent = await assembleAgent(profile)
    expect(agent.config.cacheProfile).toEqual({ ttl: '1h' })
  })

  it('profile with no cache field parses (schema has sensible defaults)', async () => {
    // Backwards compatibility: existing profiles on disk that predate
    // this field must load without erroring. Zod defaults handle this,
    // but we assert it here so a future schema change that removes the
    // default is caught.
    const { dir } = track(await createMinimalProfile())
    const profile = await loadProfile(dir)
    expect(profile.config.cache).toEqual({ ttl: '5m' })
  })
})
