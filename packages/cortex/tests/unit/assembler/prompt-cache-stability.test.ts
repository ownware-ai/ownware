/**
 * Prompt-cache stability tests.
 *
 * Anthropic's prompt cache does exact-prefix matching. If any fragment
 * of the assembled system prompt varies between two calls with the same
 * profile, the cache misses on every turn and the session pays the
 * 1.25× cache-write premium on the whole system block — effectively
 * making caching worse than no caching.
 *
 * Two invariants this file pins:
 *   1. Two back-to-back `assembleAgent` calls against the same profile
 *      produce byte-identical block arrays (same count, same text in
 *      each position, same cacheControl flag).
 *   2. The assembler splits the prompt into at least one stable
 *      (cacheControl: true) block — otherwise there is nothing for the
 *      cache to hold, and the whole design premise is broken.
 *
 * If one fails, the fix is to stabilize whatever fragment regressed or
 * to restore the cache-flag on the stable slots — NOT to relax the
 * assertion.
 *
 * Concrete cache-busters these tests have caught in the past:
 *   - `getDateContext` embedding a full ISO timestamp with milliseconds
 *   - `getGitContext` embedding `git status --short` output that
 *     changes on every file edit
 */

import { describe, it, expect, afterEach } from 'vitest'
import type { SystemPromptBlock } from '@ownware/loom'
import { systemPromptToText } from '@ownware/loom'
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

/** Deep-equality check on two block arrays with a helpful failure message. */
function expectBlocksEqual(
  actual: readonly SystemPromptBlock[],
  expected: readonly SystemPromptBlock[],
): void {
  expect(actual.length).toBe(expected.length)
  for (let i = 0; i < expected.length; i++) {
    expect(actual[i]!.text).toBe(expected[i]!.text)
    expect(actual[i]!.cacheControl).toBe(expected[i]!.cacheControl)
  }
}

describe('prompt-cache stability', () => {
  it('two assembleAgent calls produce byte-identical blocks (minimal)', async () => {
    const { dir } = track(await createMinimalProfile())
    const profile = await loadProfile(dir)
    const a = await assembleAgent(profile)
    const b = await assembleAgent(profile)
    expectBlocksEqual(b.systemPrompt, a.systemPrompt)
  })

  it('two assembleAgent calls produce byte-identical blocks with full context', async () => {
    // All context flags enabled — this is the worst case for cache
    // stability because every fragment runs.
    const { dir } = track(await createMinimalProfile({
      context: {
        git: true,
        os: true,
        cwd: true,
        datetime: true,
        project: true,
        modelInfo: true,
        contextUsage: false,
      },
    }))
    const profile = await loadProfile(dir)
    const a = await assembleAgent(profile)
    const b = await assembleAgent(profile)
    expectBlocksEqual(b.systemPrompt, a.systemPrompt)
  })

  it('emits at least one cache-marked stable block', async () => {
    // If the assembler ever stops marking any block as cacheable the
    // entire cache strategy collapses silently. Pin the lower bound.
    const { dir } = track(await createMinimalProfile())
    const profile = await loadProfile(dir)
    const { systemPrompt } = await assembleAgent(profile)
    const stable = systemPrompt.filter(b => b.cacheControl === true)
    expect(stable.length).toBeGreaterThanOrEqual(1)
    expect(stable[0]!.text.length).toBeGreaterThan(0)
  })

  it('never emits more cache-marked blocks than the 3-slot system budget', async () => {
    // The 4-marker API cap is shared with the one marker we place on the
    // last conversation message. Leaving at least one marker for the
    // message means the system side must stay <= 3 marked blocks.
    const { dir } = track(await createMinimalProfile({
      context: { git: true, os: true, cwd: true, datetime: true, project: true, modelInfo: true, contextUsage: false },
    }))
    const profile = await loadProfile(dir)
    const { systemPrompt } = await assembleAgent(profile)
    const marked = systemPrompt.filter(b => b.cacheControl === true).length
    expect(marked).toBeLessThanOrEqual(3)
  })

  it('concatenated block text exists and is non-empty', async () => {
    const { dir } = track(await createMinimalProfile())
    const profile = await loadProfile(dir)
    const { systemPrompt } = await assembleAgent(profile)
    const flat = systemPromptToText(systemPrompt)
    expect(flat.length).toBeGreaterThan(0)
  })

  it('system prompt contains no sub-day timestamp', async () => {
    const { dir } = track(await createMinimalProfile({
      context: { datetime: true },
    }))
    const profile = await loadProfile(dir)
    const { systemPrompt } = await assembleAgent(profile)
    const flat = systemPromptToText(systemPrompt)

    // ISO timestamp with T separator — the exact shape of the old bug.
    expect(flat).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/)
    // HH:MM:SS anywhere is suspicious — reject it to catch a future
    // regression that uses a different time format.
    expect(flat).not.toMatch(/\b\d{2}:\d{2}:\d{2}\b/)
  })

  it('system prompt does not leak git working-tree status', async () => {
    const { dir } = track(await createMinimalProfile({
      context: { git: true },
    }))
    const profile = await loadProfile(dir)
    const { systemPrompt } = await assembleAgent(profile)
    const flat = systemPromptToText(systemPrompt)
    // Old format — if someone re-adds status, this catches it.
    expect(flat).not.toContain('Git status:')
  })

  it('back-to-back calls remain byte-identical across a small delay', async () => {
    // A short sleep would have exposed a ms-level timestamp regression.
    // With day-level truncation in place the block arrays must stay
    // deeply equal.
    const { dir } = track(await createMinimalProfile({
      context: { datetime: true, git: true, os: true, cwd: true },
    }))
    const profile = await loadProfile(dir)
    const a = await assembleAgent(profile)
    await new Promise(r => setTimeout(r, 50))
    const b = await assembleAgent(profile)
    expectBlocksEqual(b.systemPrompt, a.systemPrompt)
  })

  it('cache-marked blocks come BEFORE uncached blocks (prefix-first ordering)', async () => {
    // For the prompt cache to actually be useful, every cache-marked
    // block must sit at the start of the system array. If an uncached
    // (volatile) block appears between two marked blocks, the second
    // marker almost never hits — by the time the server walks past the
    // volatile section its tokens have diverged from the prior request,
    // and the longest-prefix match stops early. Flag that shape here so
    // a future reordering of slots doesn't quietly destroy caching.
    const { dir } = track(await createMinimalProfile({
      context: { git: true, os: true, cwd: true, datetime: true, project: true, modelInfo: true, contextUsage: false },
    }))
    const profile = await loadProfile(dir)
    const { systemPrompt } = await assembleAgent(profile)
    let sawVolatile = false
    for (const b of systemPrompt) {
      if (b.cacheControl !== true) {
        sawVolatile = true
      } else if (sawVolatile) {
        throw new Error(
          'A cache-marked block appears AFTER a volatile block. Every ' +
          'marker past the first volatile block is effectively useless ' +
          '— the server cannot cache a prefix that is no longer identical.',
        )
      }
    }
  })
})
