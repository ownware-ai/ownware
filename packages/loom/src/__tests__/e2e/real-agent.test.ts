/**
 * End-to-end tests with REAL Anthropic API calls.
 *
 * These tests call the actual Claude API — they require ANTHROPIC_API_KEY
 * and are skipped automatically if the key is not set.
 *
 * Run: ANTHROPIC_API_KEY=sk-... npx vitest run src/__tests__/e2e/real-agent.test.ts
 */

import { describe, it, expect } from 'vitest'
import { AnthropicProvider } from '../../provider/anthropic.js'
import { createSession } from '../../core/session.js'
import { defineTool } from '../../tools/types.js'
import type { LoomEvent } from '../../core/events.js'
import type { LoopResult } from '../../core/loop.js'
import type { Tool } from '../../tools/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const apiKey = process.env.ANTHROPIC_API_KEY
const MODEL = 'anthropic:claude-sonnet-4-6'
const MODEL_NAME = 'claude-sonnet-4-6'

function skipIfNoKey() {
  if (!apiKey) {
    console.log('⏭ Skipping e2e test: ANTHROPIC_API_KEY not set')
    return true
  }
  return false
}

function createProvider() {
  return new AnthropicProvider({ apiKey: apiKey! })
}

function makeSession(opts: {
  systemPrompt?: string
  tools?: Tool[]
  maxTokens?: number
  model?: string
}) {
  return createSession(opts.model ?? MODEL, {
    provider: createProvider(),
    systemPrompt: opts.systemPrompt ?? 'Be brief.',
    tools: opts.tools,
    config: { maxTokens: opts.maxTokens ?? 128 },
  })
}

async function drainRun(
  gen: AsyncGenerator<LoomEvent, LoopResult>,
): Promise<{ events: LoomEvent[]; result: LoopResult }> {
  const events: LoomEvent[] = []
  let next = await gen.next()
  while (!next.done) {
    events.push(next.value)
    next = await gen.next()
  }
  return { events, result: next.value }
}

function findEvent<T extends LoomEvent>(events: LoomEvent[], type: string): T | undefined {
  return events.find(e => e.type === type) as T | undefined
}

function findEvents<T extends LoomEvent>(events: LoomEvent[], type: string): T[] {
  return events.filter(e => e.type === type) as T[]
}

// ---------------------------------------------------------------------------
// Calculator tool
// ---------------------------------------------------------------------------

const addTool: Tool = defineTool({
  name: 'add',
  description: 'Add two numbers together and return the sum.',
  isReadOnly: true,
  inputSchema: {
    type: 'object',
    properties: {
      a: { type: 'number', description: 'First number' },
      b: { type: 'number', description: 'Second number' },
    },
    required: ['a', 'b'],
  },
  async execute(input) {
    const { a, b } = input as { a: number; b: number }
    return { content: String(a + b), isError: false }
  },
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('e2e: real Anthropic API', () => {
  // ── Test 1: Simple text response ─────────────────────────────────────
  it('returns a simple text response', async () => {
    if (skipIfNoKey()) return

    const session = makeSession({
      systemPrompt: 'You are a helpful assistant. Be extremely brief.',
    })

    const { events } = await drainRun(
      session.submitMessage('What is 2+2? Reply with just the number.'),
    )

    // Should have text delta events
    const textDeltas = findEvents(events, 'text.delta')
    expect(textDeltas.length).toBeGreaterThan(0)

    // Should have text complete event containing "4"
    const textComplete = findEvent(events, 'text.complete')
    expect(textComplete).toBeDefined()
    expect((textComplete as any).text).toContain('4')

    // Should have turn.end with usage
    const turnEnd = findEvent(events, 'turn.end')
    expect(turnEnd).toBeDefined()
    expect((turnEnd as any).usage.inputTokens).toBeGreaterThan(0)
  }, 60_000)

  // ── Test 2: Tool use ─────────────────────────────────────────────────
  it('calls a tool and uses the result', async () => {
    if (skipIfNoKey()) return

    const session = makeSession({
      systemPrompt: 'You are a calculator. Always use the add tool for addition. Be brief.',
      tools: [addTool],
      maxTokens: 256,
    })

    const { events } = await drainRun(
      session.submitMessage('Use the add tool to compute 17 + 25. Tell me the result.'),
    )

    // Should have tool call start
    const toolStart = findEvent(events, 'tool.call.start')
    expect(toolStart).toBeDefined()
    expect((toolStart as any).toolName).toBe('add')

    // Should have tool call end with result "42"
    const toolEnd = findEvent(events, 'tool.call.end')
    expect(toolEnd).toBeDefined()
    expect((toolEnd as any).result).toContain('42')
    expect((toolEnd as any).isError).toBe(false)

    // Should produce text mentioning "42" at some point
    const allTextCompletes = findEvents(events, 'text.complete')
    const allText = allTextCompletes.map((e: any) => e.text).join(' ')
    expect(allText).toContain('42')
  }, 60_000)

  // ── Test 3: Multi-turn conversation ──────────────────────────────────
  it('maintains context across multiple turns', async () => {
    if (skipIfNoKey()) return

    const session = makeSession({
      systemPrompt: 'You are a helpful assistant. Be very brief, one sentence max.',
    })

    // Turn 1: tell it to remember a number
    const { events: events1 } = await drainRun(
      session.submitMessage('Remember the number 42. Just confirm you will remember it.'),
    )
    const text1 = findEvent(events1, 'text.complete')
    expect(text1).toBeDefined()

    // Turn 2: ask it to recall
    const { events: events2 } = await drainRun(
      session.submitMessage('What number did I ask you to remember?'),
    )
    const text2 = findEvent(events2, 'text.complete')
    expect(text2).toBeDefined()
    expect((text2 as any).text).toContain('42')
  }, 120_000)

  // ── Test 4: Streaming event order ────────────────────────────────────
  it('yields events in correct order', async () => {
    if (skipIfNoKey()) return

    const session = makeSession({
      systemPrompt: 'Be brief.',
      maxTokens: 64,
    })

    const { events } = await drainRun(session.submitMessage('Say hello.'))

    const types = events.map(e => e.type)

    // session.start comes first
    expect(types[0]).toBe('session.start')

    // turn.start comes before any text.delta
    const turnStartIdx = types.indexOf('turn.start')
    const firstTextDeltaIdx = types.indexOf('text.delta')
    expect(turnStartIdx).toBeGreaterThanOrEqual(0)
    expect(firstTextDeltaIdx).toBeGreaterThan(turnStartIdx)

    // text.complete comes after text.delta
    const textCompleteIdx = types.indexOf('text.complete')
    expect(textCompleteIdx).toBeGreaterThan(firstTextDeltaIdx)

    // turn.end comes after text.complete
    const turnEndIdx = types.indexOf('turn.end')
    expect(turnEndIdx).toBeGreaterThan(textCompleteIdx)
  }, 60_000)

  // ── Test 5: Error handling ───────────────────────────────────────────
  it('yields error event for invalid model', async () => {
    if (skipIfNoKey()) return

    const session = makeSession({
      model: 'anthropic:nonexistent-model-xyz',
      systemPrompt: 'test',
      maxTokens: 64,
    })

    const { events } = await drainRun(session.submitMessage('hello'))

    // Should have an error event (not a thrown exception)
    const errorEvent = findEvent(events, 'error')
    expect(errorEvent).toBeDefined()
    expect((errorEvent as any).recoverable).toBe(false)
  }, 60_000)

  // ── Test 6: Long conversation never trips the 4-marker cache_control cap ──
  //
  // Regression for the bug where applyMessageCacheMarkers stamped N-1 markers
  // on growing histories, blowing past Anthropic's server-side limit
  // ("A maximum of 4 blocks with cache_control may be provided. Found N.").
  // Also asserts that prompt caching still functions: cache_read_input_tokens
  // must rise above zero by the second turn, proving that one tail marker is
  // enough to seed the cache.
  it('runs a 6-turn conversation without exceeding the cache_control cap', async () => {
    if (skipIfNoKey()) return

    const session = makeSession({
      // System prompt must clear Anthropic's minimum-cacheable prefix length
      // (1024 tokens for Sonnet-class models). Below that, the API silently
      // declines to write or read from cache, making the test useless.
      // We pad with deterministic synthetic rules so the prefix hash is stable
      // across turns (real prompt-cache only matches byte-exact prefixes).
      systemPrompt:
        'You are a careful assistant that answers in one short sentence. ' +
        'Never refuse. Never apologize. Never use lists. Never use markdown. ' +
        'Be concise but always answer in a complete sentence.\n\n' +
        Array.from(
          { length: 220 },
          (_, i) =>
            `Rule ${i + 1}: When asked about topic number ${i + 1}, respond ` +
            `with a single sentence and never include enumerations, headings, ` +
            `or footnotes. Stay strictly inside the requested scope.`,
        ).join('\n'),
      maxTokens: 64,
    })

    const turnPrompts = [
      'Say hi.',
      'Pick a single fruit name and tell me what it is.',
      'Now pick a vegetable name.',
      'Pick a color.',
      'Pick an animal.',
      'Summarize your four picks in one sentence.',
    ]

    const turnUsages: Array<{
      cacheReadTokens: number
      cacheCreationTokens: number
      inputTokens: number
    }> = []

    for (let i = 0; i < turnPrompts.length; i += 1) {
      const { events, result } = await drainRun(session.submitMessage(turnPrompts[i]!))

      // Hard fail: an error event from the API on any turn means the cap
      // (or some other 400) was tripped — surface it loudly with context.
      const errorEvent = findEvent(events, 'error')
      if (errorEvent) {
        const code = (errorEvent as { code?: string }).code
        const message = (errorEvent as { message?: string }).message
        throw new Error(
          `Turn ${i + 1} failed with error event ` +
          `(code=${code}, message=${message}). ` +
          `If message contains "maximum of 4 blocks with cache_control", ` +
          `the regression has returned.`,
        )
      }

      const turnEnd = findEvent(events, 'turn.end')
      expect(turnEnd, `turn ${i + 1} should produce a turn.end event`).toBeDefined()
      const usage = (turnEnd as { usage?: typeof turnUsages[number] }).usage
      expect(usage, `turn ${i + 1} should report usage`).toBeDefined()
      turnUsages.push(usage!)

      // Loop must report a clean stop on every turn — no aborted/error tails.
      expect(['end_turn', 'stop_sequence']).toContain(result.reason)
    }

    // We ran 6 turns; that's 6+ messages of conversation (user + assistant
    // each turn). Under the old code this would have produced ≥6 markers in
    // the final request and the 5th turn would have 400'd. Reaching here
    // without throwing already proves the cap fix works on the wire.
    expect(turnUsages).toHaveLength(turnPrompts.length)

    // Caching must be working: at least one of turns 2..N must report a
    // non-zero cache_read_input_tokens. Anthropic only fills this field when
    // the server hits a cached prefix written by an earlier request.
    const laterTurns = turnUsages.slice(1)
    const someTurnHadCacheRead = laterTurns.some(u => u.cacheReadTokens > 0)
    expect(
      someTurnHadCacheRead,
      `expected at least one of turns 2..${turnPrompts.length} to read from ` +
      `cache. Per-turn usage: ${JSON.stringify(turnUsages, null, 2)}`,
    ).toBe(true)

    // Because we mark every turn's tail, cache_creation_input_tokens should
    // also be non-zero on the cache-write turns — proves the marker is
    // actually reaching the API.
    const someTurnWroteCache = turnUsages.some(u => u.cacheCreationTokens > 0)
    expect(someTurnWroteCache).toBe(true)
  }, 180_000)

  // ── Test 7: Native extended thinking — single turn ──────────────────────
  //
  // Proves the full path: LoomConfig.thinking flows through to the Anthropic
  // API, the provider emits thinking chunks, the loop yields thinking.delta
  // events, and the final message carries a thinking block with a signature.
  //
  // Uses a small budget (1024 — the Anthropic minimum) to keep the API bill
  // tiny. The prompt is intentionally a math-reasoning question so the model
  // actually exercises the reasoning channel rather than skipping it.
  it('streams native extended thinking with signature on a reasoning prompt', async () => {
    if (skipIfNoKey()) return

    const session = makeSession({
      systemPrompt: 'You are a precise reasoning assistant.',
      maxTokens: 4096,
      model: MODEL,
    })

    const { events } = await drainRun(
      session.submitMessage(
        'A farmer has 17 sheep. All but 9 run away. How many sheep are left? ' +
        'Reason briefly, then give the number.',
        { thinking: { enabled: true, budgetTokens: 1024 } },
      ),
    )

    // No unrecoverable error — if the thinking param was rejected by the API
    // (wrong shape, unsupported model, budget >= max_tokens) the loop would
    // surface it as an 'error' event.
    const errorEvent = findEvent(events, 'error')
    if (errorEvent) {
      throw new Error(
        `Unexpected error event: code=${(errorEvent as { code?: string }).code} ` +
        `message=${(errorEvent as { message?: string }).message}`,
      )
    }

    // Streaming: at least one thinking.delta must arrive before thinking.complete.
    const thinkingDeltas = findEvents(events, 'thinking.delta')
    expect(
      thinkingDeltas.length,
      `expected thinking.delta events — the API did not stream a thinking block. ` +
      `Event types seen: ${events.map(e => e.type).join(',')}`,
    ).toBeGreaterThan(0)

    const thinkingComplete = findEvent(events, 'thinking.complete')
    expect(thinkingComplete).toBeDefined()
    const thinkingText = (thinkingComplete as { text: string }).text
    expect(thinkingText.length).toBeGreaterThan(0)
    // The streamed deltas must concatenate to the complete text — otherwise
    // we're losing thinking content somewhere between adapter and loop.
    const concatenated = thinkingDeltas.map(e => (e as { text: string }).text).join('')
    expect(concatenated).toBe(thinkingText)

    // Ordering: every thinking.delta must precede thinking.complete, and the
    // final answer (text.complete) must come after the thinking block.
    const deltaIdx = events.findIndex(e => e.type === 'thinking.delta')
    const completeIdx = events.findIndex(e => e.type === 'thinking.complete')
    const textCompleteIdx = events.findIndex(e => e.type === 'text.complete')
    expect(deltaIdx).toBeGreaterThanOrEqual(0)
    expect(completeIdx).toBeGreaterThan(deltaIdx)
    expect(textCompleteIdx).toBeGreaterThan(completeIdx)

    // The visible answer must contain "9" — if it doesn't, the model spent
    // tokens thinking but returned an empty or malformed answer.
    const textComplete = findEvent(events, 'text.complete')
    expect(textComplete).toBeDefined()
    expect((textComplete as { text: string }).text).toMatch(/\b9\b/)
  }, 120_000)

  // ── Test 8: Extended thinking with tool use across turns ───────────────
  //
  // The hardest case: thinking + tool_use in the same assistant turn requires
  // the thinking block (with signature) to be echoed back on the next request.
  // If we strip it or drop the signature, Anthropic 400s the continuation.
  // This test proves the signature round-trip works end-to-end.
  it('preserves thinking signatures across tool-use continuations', async () => {
    if (skipIfNoKey()) return

    const session = makeSession({
      systemPrompt:
        'You are a calculator. When given an addition problem, ALWAYS call the ' +
        'add tool. Reason briefly first, then call the tool, then state the result.',
      tools: [addTool],
      maxTokens: 4096,
      model: MODEL,
    })

    const { events } = await drainRun(
      session.submitMessage(
        'What is 127 + 246? Think about which tool to use, then compute it.',
        { thinking: { enabled: true, budgetTokens: 1024 } },
      ),
    )

    // If signature round-trip is broken the follow-up turn 400s — surfaces as
    // an 'error' event. Fail loud with context.
    const errorEvent = findEvent(events, 'error')
    if (errorEvent) {
      const message = (errorEvent as { message?: string }).message ?? ''
      throw new Error(
        `Continuation turn failed — likely thinking-block signature round-trip ` +
        `regression. Error: ${message}`,
      )
    }

    // Must have exercised the reasoning channel.
    const thinkingDeltas = findEvents(events, 'thinking.delta')
    expect(
      thinkingDeltas.length,
      'expected thinking.delta events on turn 1',
    ).toBeGreaterThan(0)

    // Must have actually called the tool.
    const toolStart = findEvent(events, 'tool.call.start')
    expect(toolStart).toBeDefined()
    expect((toolStart as { toolName: string }).toolName).toBe('add')

    const toolEnd = findEvent(events, 'tool.call.end')
    expect(toolEnd).toBeDefined()
    expect((toolEnd as { result: string }).result).toContain('373')
    expect((toolEnd as { isError: boolean }).isError).toBe(false)

    // Must have received a final answer containing 373 — proves the
    // continuation turn survived with the preserved thinking block.
    const allTextCompletes = findEvents(events, 'text.complete')
    const allText = allTextCompletes.map(e => (e as { text: string }).text).join(' ')
    expect(allText).toContain('373')
  }, 180_000)
})
