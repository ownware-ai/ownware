/**
 * End-to-end: prompt cache actually fires on real Anthropic calls.
 *
 * This is the battle test for the cache-aware system-prompt split.
 * Previous behaviour wrapped the entire assembled prompt in a single
 * cache_control block, which meant any volatile fragment (date, cwd,
 * memory) invalidated the whole cache every turn. With the split in
 * place, the stable prefix caches once and subsequent turns should
 * report non-trivial `cache_read_input_tokens`.
 *
 * The test:
 *   1. Loads a profile whose system prompt is large enough (>~1K tokens)
 *      that the provider's cache minimum is met.
 *   2. Runs two small turns on the same Session (same thread).
 *   3. Asserts turn 2 reports `cacheReadTokens > 0` — the cache hit the
 *      prefix written on turn 1.
 *
 * Skips when `ANTHROPIC_API_KEY` is a sentinel or absent. The minimum
 * cacheable prefix on claude-sonnet is ~1024 tokens; we pad SOUL.md to
 * ensure the prefix crosses that threshold regardless of preset size.
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

/**
 * Drain the event stream to completion and return the aggregated turn
 * usage pulled from the terminal `turn.end` event. The session-level
 * totals live on the session itself but for a single turn the turn.end
 * is the cleanest signal.
 */
async function runTurn(
  session: Session,
  prompt: string,
): Promise<TurnUsage> {
  let lastTurnUsage: TurnUsage | null = null
  const gen: AsyncGenerator<LoomEvent, unknown> = session.submitMessage(prompt)
  let next = await gen.next()
  while (!next.done) {
    const event = next.value
    if (event.type === 'turn.end') {
      lastTurnUsage = event.usage
    }
    next = await gen.next()
  }
  if (!lastTurnUsage) {
    throw new Error('No turn.end event observed — session returned without completing a turn.')
  }
  return lastTurnUsage
}

/**
 * Build a SOUL.md large enough that the stable prefix crosses Anthropic's
 * ~1024-token minimum for ephemeral caching.
 *
 * A unique marker per test run guarantees the server-side cache is cold
 * on turn 1, regardless of whether the same fixture was exercised in the
 * last 5 minutes (the ephemeral TTL). Without this, repeated test runs
 * within the TTL window would observe turn 1 *reading* a warm entry from
 * a prior run, defeating the whole purpose of asserting a cache write.
 */
function paddedSoul(uniqueMarker: string): string {
  const line = 'You are a highly focused assistant. You answer concisely. You prefer plain text.\n'
  // Roughly 80 chars per line × 200 lines ≈ 16KB ≈ ~4K tokens — well above
  // the minimum cacheable prefix size for any current Claude model.
  return `# Test Agent ${uniqueMarker}\n\n` + line.repeat(200)
}

describe('e2e: prompt cache hits on turn 2', () => {
  it('turn 2 reports cacheReadTokens > 0 after turn 1 wrote the prefix', async () => {
    if (skipIfNoKey()) return

    const { dir } = track(
      await createTempProfile({
        'agent.json': JSON.stringify({
          name: 'e2e-cache-test',
          model: 'anthropic:claude-sonnet-4-5',
          tools: { preset: 'none' },
          // Deterministic — no cwd/git/date/os/project/modelInfo.
          // The SOUL.md below is the entire cacheable content; removing
          // volatile context means we are only exercising the stable
          // block path, which is exactly what we want to prove here.
          context: {
            cwd: false,
            datetime: false,
            git: false,
            os: false,
            project: false,
            modelInfo: false,
            contextUsage: false,
          },
          // No AGENTS.md so memory slot is empty — keeps the prompt
          // byte-stable across turns.
          memory: { enabled: false },
        }),
        'SOUL.md': paddedSoul(`run-${Date.now()}-${crypto.randomUUID()}`),
      }),
    )

    const profile = await loadProfile(dir)
    const assembled = await assembleAgent(profile)

    // Sanity: the assembler must have produced at least one cache-marked
    // block. If this assertion trips, the test proves nothing about
    // real-world caching — flag it loudly.
    const marked = assembled.systemPrompt.filter(b => b.cacheControl === true)
    expect(marked.length).toBeGreaterThanOrEqual(1)

    const session = new Session({
      config: { ...assembled.config, maxTokens: 64 },
      provider: assembled.provider,
      tools: [],
    })

    const t1 = await runTurn(session, 'Say the number 1 and nothing else.')
    const t2 = await runTurn(session, 'Say the number 2 and nothing else.')

    // Emit the metrics so a human reader sees the actual win, not just a
    // green check. The numbers are the evidence.
    /* eslint-disable no-console */
    console.log('\n────────────── PROMPT CACHE REPORT ──────────────')
    console.log(`Turn 1 — input(uncached)=${t1.inputTokens}  output=${t1.outputTokens}`
      + `  cache_write=${t1.cacheCreationTokens}  cache_read=${t1.cacheReadTokens}`
      + `  cost=$${t1.costUsd.toFixed(6)}`)
    console.log(`Turn 2 — input(uncached)=${t2.inputTokens}  output=${t2.outputTokens}`
      + `  cache_write=${t2.cacheCreationTokens}  cache_read=${t2.cacheReadTokens}`
      + `  cost=$${t2.costUsd.toFixed(6)}`)
    const turn1Total = t1.inputTokens + t1.cacheCreationTokens + t1.cacheReadTokens
    const turn2Total = t2.inputTokens + t2.cacheCreationTokens + t2.cacheReadTokens
    const turn2HitRate = turn2Total > 0 ? (t2.cacheReadTokens / turn2Total) * 100 : 0
    console.log(`Turn 2 cache-hit rate: ${turn2HitRate.toFixed(1)}% of input tokens served from cache`)
    console.log(`Total cost (both turns): $${(t1.costUsd + t2.costUsd).toFixed(6)}`)
    console.log('─────────────────────────────────────────────────\n')
    /* eslint-enable no-console */

    // --------------------------------------------------------------
    // Turn 1 must write to cache. This is the setup for turn 2; if
    // nothing ever gets written the cache never reads.
    // --------------------------------------------------------------
    expect(t1.cacheCreationTokens).toBeGreaterThan(0)

    // --------------------------------------------------------------
    // The real assertion: turn 2 must READ from cache. Any non-zero
    // value means the cache genuinely hit — the system prefix we wrote
    // on turn 1 was served from cache instead of re-prefilled.
    //
    // In practice we expect cache_read to be roughly the full size of
    // the stable prefix (several thousand tokens). But the test stays
    // tolerant: "> 0" is the engineering invariant. A stricter bound
    // would flake on minor provider-side accounting changes.
    // --------------------------------------------------------------
    expect(t2.cacheReadTokens).toBeGreaterThan(0)

    // Uncached input on turn 2 should be tiny (just the new user
    // message). If the cache didn't hit, this would be on the order of
    // the full prefix (thousands of tokens). A generous ceiling catches
    // a regression without flaking on legitimate small variations.
    expect(t2.inputTokens).toBeLessThan(500)
  }, 120_000)
})
