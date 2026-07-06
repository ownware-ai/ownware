/**
 * End-to-end tests with REAL API calls.
 *
 * These tests load a profile, assemble it, create a Loom Session,
 * and run actual model calls. They require ANTHROPIC_API_KEY and
 * are skipped automatically if the key is not set.
 *
 * Run: ANTHROPIC_API_KEY=sk-... npx vitest run tests/e2e/
 */

import { describe, it, expect, afterEach } from 'vitest'
import { loadProfile } from '../../src/profile/loader.js'
import { assembleAgent } from '../../src/profile/assembler.js'
import { Session } from '@ownware/loom'
import type { LoomEvent } from '@ownware/loom'
import { createTempProfile, EXAMPLE_PROFILE_DIR } from '../helpers/fixtures.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const apiKey = process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_API_KEY.includes('OWNWARE_TEST_DUMMY') ? process.env.ANTHROPIC_API_KEY : undefined

function skipIfNoKey(): boolean {
  if (!apiKey) {
    console.log('⏭ Skipping e2e test: ANTHROPIC_API_KEY not set')
    return true
  }
  return false
}

async function drainEvents(
  gen: AsyncGenerator<LoomEvent, unknown>,
): Promise<LoomEvent[]> {
  const events: LoomEvent[] = []
  let next = await gen.next()
  while (!next.done) {
    events.push(next.value)
    next = await gen.next()
  }
  return events
}

function extractText(events: LoomEvent[]): string {
  return events
    .filter(e => e.type === 'text.delta')
    .map(e => (e as { text: string }).text)
    .join('')
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('e2e: Cortex profile → Loom Session → real API', () => {
  it('loads example profile and gets a response', async () => {
    if (skipIfNoKey()) return

    const profile = await loadProfile(EXAMPLE_PROFILE_DIR)
    const assembled = await assembleAgent(profile)

    const session = new Session({
      config: { ...assembled.config, maxTokens: 128 },
      provider: assembled.provider,
      tools: [], // No tools for simple text test
    })

    const events = await drainEvents(
      session.submitMessage('What is 2+2? Reply with just the number.'),
    )

    const text = extractText(events)
    expect(text).toContain('4')
  }, 60_000)

  it('respects system prompt from SOUL.md', async () => {
    if (skipIfNoKey()) return

    const { dir } = track(await createTempProfile({
      'agent.json': JSON.stringify({
        name: 'e2e-soul-test',
        model: 'anthropic:claude-sonnet-4-20250514',
        tools: { preset: 'none' },
        context: { cwd: false, datetime: false },
      }),
      'SOUL.md': '# Pirate Agent\n\nYou always respond in pirate speak. Use words like "arr", "matey", "ye".',
    }))

    const profile = await loadProfile(dir)
    const assembled = await assembleAgent(profile)

    const session = new Session({
      config: { ...assembled.config, maxTokens: 256 },
      provider: assembled.provider,
      tools: [],
    })

    const events = await drainEvents(
      session.submitMessage('Say hello.'),
    )

    const text = extractText(events).toLowerCase()
    // The pirate system prompt should influence the response
    const hasPirateWords = ['arr', 'matey', 'ye', 'ahoy', 'pirate'].some(w => text.includes(w))
    expect(hasPirateWords).toBe(true)
  }, 60_000)

  it('streams events in correct order', async () => {
    if (skipIfNoKey()) return

    const profile = await loadProfile(EXAMPLE_PROFILE_DIR)
    const assembled = await assembleAgent(profile)

    const session = new Session({
      config: { ...assembled.config, maxTokens: 64 },
      provider: assembled.provider,
      tools: [],
    })

    const events = await drainEvents(
      session.submitMessage('Say "hello".'),
    )

    const types = events.map(e => e.type)

    // session.start should come first
    expect(types[0]).toBe('session.start')

    // turn.start before any text
    const turnStartIdx = types.indexOf('turn.start')
    const firstTextIdx = types.indexOf('text.delta')
    expect(turnStartIdx).toBeGreaterThanOrEqual(0)
    if (firstTextIdx >= 0) {
      expect(firstTextIdx).toBeGreaterThan(turnStartIdx)
    }
  }, 60_000)

  it('works with inline systemPrompt (no SOUL.md)', async () => {
    if (skipIfNoKey()) return

    const { dir } = track(await createTempProfile({
      'agent.json': JSON.stringify({
        name: 'inline-e2e',
        model: 'anthropic:claude-sonnet-4-20250514',
        systemPrompt: 'You only respond with the word BANANA. Nothing else.',
        tools: { preset: 'none' },
        context: { cwd: false, datetime: false },
      }),
    }))

    const profile = await loadProfile(dir)
    const assembled = await assembleAgent(profile)

    const session = new Session({
      config: { ...assembled.config, maxTokens: 64 },
      provider: assembled.provider,
      tools: [],
    })

    const events = await drainEvents(
      session.submitMessage('Hello'),
    )

    const text = extractText(events).toUpperCase()
    expect(text).toContain('BANANA')
  }, 60_000)

  it('multi-turn retains conversation context', async () => {
    if (skipIfNoKey()) return

    const profile = await loadProfile(EXAMPLE_PROFILE_DIR)
    const assembled = await assembleAgent(profile)

    const session = new Session({
      config: { ...assembled.config, maxTokens: 128 },
      provider: assembled.provider,
      tools: [],
    })

    // Turn 1
    await drainEvents(
      session.submitMessage('Remember the secret word: CORTEX. Just acknowledge.'),
    )

    // Turn 2
    const events2 = await drainEvents(
      session.submitMessage('What was the secret word I told you?'),
    )

    const text = extractText(events2).toUpperCase()
    expect(text).toContain('CORTEX')
  }, 120_000)
})
