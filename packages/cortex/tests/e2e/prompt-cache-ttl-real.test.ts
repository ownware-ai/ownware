/**
 * End-to-end: profile.cache.ttl='1h' opts into the 1-hour cache tier and
 * the real API accepts it end-to-end.
 *
 * Why this lives separately from the 5m prompt-cache-real test:
 *   - The 5m test proves the architecture works at all (caching hits on
 *     turn 2). This test layers on the TTL-tier opt-in and confirms the
 *     live API does not reject the request when we attach `ttl: '1h'`
 *     on cache markers.
 *   - We cannot prove a 1-hour TTL actually held without sleeping past
 *     the 5-minute default TTL inside a test. What we CAN prove: the
 *     request body with `ttl: '1h'` is accepted (no 400) and cache
 *     still reads on turn 2 (so the tier opt-in didn't break anything).
 *   - Observing which tier was written would require the newer SDK that
 *     splits `ephemeral_1h_input_tokens` / `ephemeral_5m_input_tokens`
 *     in the usage response. The SDK bump is deferred as a separate
 *     piece of work; this test runs on the currently-pinned SDK.
 *
 * Skips without `ANTHROPIC_API_KEY`. The padded SOUL.md uses a fresh
 * UUID so the cache entry is always cold on turn 1, making assertions
 * deterministic across reruns inside the 5-minute ephemeral window.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { loadProfile } from '../../src/profile/loader.js'
import { assembleAgent } from '../../src/profile/assembler.js'
import { Session } from '@ownware/loom'
import type { LoomEvent, TurnUsage } from '@ownware/loom'
import { createTempProfile } from '../helpers/fixtures.js'

const apiKey =
  process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_API_KEY.includes('OWNWARE_TEST_DUMMY')
    ? process.env.ANTHROPIC_API_KEY
    : undefined

function skipIfNoKey(): boolean {
  if (!apiKey) {
    console.log('⏭ Skipping e2e test: ANTHROPIC_API_KEY not set')
    return true
  }
  return false
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanups) await fn()
  cleanups.length = 0
})

function track<T extends { cleanup: () => Promise<void> }>(p: T): T {
  cleanups.push(p.cleanup)
  return p
}

async function runTurn(session: Session, prompt: string): Promise<TurnUsage> {
  let last: TurnUsage | null = null
  const gen: AsyncGenerator<LoomEvent, unknown> = session.submitMessage(prompt)
  let next = await gen.next()
  while (!next.done) {
    if (next.value.type === 'turn.end') last = next.value.usage
    next = await gen.next()
  }
  if (!last) throw new Error('No turn.end observed')
  return last
}

function paddedSoul(uniqueMarker: string): string {
  const line = 'You are a highly focused assistant. You answer concisely. You prefer plain text.\n'
  return `# Test Agent ${uniqueMarker}\n\n` + line.repeat(200)
}

describe('e2e: profile.cache.ttl="1h" is accepted by real API and caching still works', () => {
  it('turn 1 writes cache, turn 2 reads cache, API accepts ttl=1h markers', async () => {
    if (skipIfNoKey()) return

    const { dir } = track(
      await createTempProfile({
        'agent.json': JSON.stringify({
          name: 'e2e-cache-ttl-test',
          model: 'anthropic:claude-sonnet-4-5',
          tools: { preset: 'none' },
          context: {
            cwd: false, datetime: false, git: false, os: false,
            project: false, modelInfo: false, contextUsage: false,
          },
          memory: { enabled: false },
          cache: { ttl: '1h' },
        }),
        'SOUL.md': paddedSoul(`ttl-1h-${Date.now()}-${crypto.randomUUID()}`),
      }),
    )

    const profile = await loadProfile(dir)
    expect(profile.config.cache.ttl).toBe('1h')

    const assembled = await assembleAgent(profile)
    // The assembler must have propagated the opt-in to LoomConfig,
    // otherwise the downstream marker emission never sees the tier.
    expect(assembled.config.cacheProfile).toEqual({ ttl: '1h' })

    const session = new Session({
      config: { ...assembled.config, maxTokens: 64 },
      provider: assembled.provider,
      tools: [],
    })

    // If the real API rejected the extended marker shape, this throws
    // and the test fails loud. A thrown error is more diagnostic than
    // a silent skip, so no try/catch here.
    const t1 = await runTurn(session, 'Say the number 1 and nothing else.')
    const t2 = await runTurn(session, 'Say the number 2 and nothing else.')

    /* eslint-disable no-console */
    console.log('\n──────── 1-HOUR TTL CACHE REPORT ────────')
    console.log(`Turn 1 — input=${t1.inputTokens}  output=${t1.outputTokens}`
      + `  cache_write=${t1.cacheCreationTokens}  cache_read=${t1.cacheReadTokens}`
      + `  cost=$${t1.costUsd.toFixed(6)}`)
    console.log(`Turn 2 — input=${t2.inputTokens}  output=${t2.outputTokens}`
      + `  cache_write=${t2.cacheCreationTokens}  cache_read=${t2.cacheReadTokens}`
      + `  cost=$${t2.costUsd.toFixed(6)}`)
    console.log(`Total (both turns): $${(t1.costUsd + t2.costUsd).toFixed(6)}`)
    console.log('───────────────────────────────────────────\n')
    /* eslint-enable no-console */

    // Turn 1 wrote the prefix to cache.
    expect(t1.cacheCreationTokens).toBeGreaterThan(0)

    // Turn 2 read from cache. This is the real assertion: if the API
    // rejected the 1h marker shape we would have thrown already; if it
    // silently fell back to 5m we would still see a cache read here.
    // Either way, this assertion holding means the feature did not
    // regress the cache mechanic.
    expect(t2.cacheReadTokens).toBeGreaterThan(0)

    // Uncached input on turn 2 stays tiny.
    expect(t2.inputTokens).toBeLessThan(500)
  }, 120_000)
})
