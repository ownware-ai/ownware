/**
 * End-to-end Multi-Agent Tests with REAL API calls.
 *
 * Tests sub-agent spawning, coordination patterns, abort, and event streaming
 * against the actual Anthropic API.
 *
 * Requires: ANTHROPIC_API_KEY environment variable.
 * Run: ANTHROPIC_API_KEY=sk-... npx vitest run src/__tests__/e2e/multi-agent-real.test.ts
 *
 * Cost estimate: ~$0.05–0.15 per full run (uses haiku for speed/cost).
 */

import { describe, it, expect } from 'vitest'
import { AnthropicProvider } from '../../provider/anthropic.js'
import { createSession, Session } from '../../core/session.js'
import { AgentSpawner } from '../../agents/spawner.js'
import { fanOut, pipeline } from '../../agents/coordinator.js'
import { defineTool } from '../../tools/types.js'
import { createDefaultConfig } from '../../core/config.js'
import type { LoomEvent } from '../../core/events.js'
import type { LoopResult } from '../../core/loop.js'
import type { Tool } from '../../tools/types.js'

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const apiKey = process.env.ANTHROPIC_API_KEY
const MODEL = 'anthropic:claude-haiku-4-5-20251001' // Fast + cheap for tests

function skip() {
  if (!apiKey) {
    console.log('⏭ Skipping multi-agent e2e: ANTHROPIC_API_KEY not set')
    return true
  }
  return false
}

function provider() {
  return new AnthropicProvider({ apiKey: apiKey! })
}

function config() {
  return createDefaultConfig(MODEL)
}

// Simple tool: multiply two numbers
const multiplyTool: Tool = defineTool({
  name: 'multiply',
  description: 'Multiply two numbers and return the product.',
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
    return { content: String(a * b), isError: false }
  },
})

// Simple tool: reverse a string
const reverseTool: Tool = defineTool({
  name: 'reverse_string',
  description: 'Reverse a string.',
  isReadOnly: true,
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Text to reverse' },
    },
    required: ['text'],
  },
  async execute(input) {
    const { text } = input as { text: string }
    return { content: text.split('').reverse().join(''), isError: false }
  },
})

async function drainEvents(
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('e2e: multi-agent with real Anthropic API', () => {

  // ── Test 1: Single sub-agent via AgentSpawner ──────────────────────
  it('spawns a sub-agent that answers a question', async () => {
    if (skip()) return

    const spawner = new AgentSpawner({
      provider: provider(),
      tools: [],
      config: { ...config(), maxTokens: 128, maxTurns: 2 },
    })

    const handle = await spawner.spawn(
      {
        name: 'math-agent',
        systemPrompt: 'You are a math tutor. Answer briefly in one sentence.',
        maxTurns: 2,
      },
      'isolated',
      [{ role: 'user', content: 'What is 7 * 8? Just the number.' }],
    )

    expect(handle.status).toBe('running')
    expect(handle.id).toMatch(/^agent_/)

    const result = await spawner.waitForAgent(handle.id)

    expect(result.content).toContain('56')
    expect(result.turnCount).toBeGreaterThanOrEqual(1)
    expect(result.usage.inputTokens).toBeGreaterThan(0)
    expect(result.usage.outputTokens).toBeGreaterThan(0)

    // Handle should be completed
    const finalHandle = spawner.getAgent(handle.id)
    expect(finalHandle?.status).toBe('completed')
  }, 30_000)

  // ── Test 2: Sub-agent with tool use ────────────────────────────────
  it('sub-agent calls a tool and returns result', async () => {
    if (skip()) return

    const spawner = new AgentSpawner({
      provider: provider(),
      tools: [multiplyTool],
      config: { ...config(), maxTokens: 256, maxTurns: 4 },
    })

    const handle = await spawner.spawn(
      {
        name: 'calc-agent',
        systemPrompt: 'You are a calculator. Always use the multiply tool. Reply with just the answer number.',
        tools: ['multiply'],
        maxTurns: 4,
      },
      'isolated',
      [{ role: 'user', content: 'Use the multiply tool to compute 13 * 7. Reply with just the number.' }],
    )

    const result = await spawner.waitForAgent(handle.id)

    expect(result.content).toContain('91')
  }, 30_000)

  // ── Test 3: fanOut — parallel agents ───────────────────────────────
  it('fanOut runs 2 agents in parallel and collects results', async () => {
    if (skip()) return

    const results = await fanOut(
      [
        {
          name: 'agent-add',
          systemPrompt: 'Reply with ONLY the number, nothing else.',
          maxTurns: 2,
        },
        {
          name: 'agent-country',
          systemPrompt: 'Reply with ONLY the answer, one word.',
          maxTurns: 2,
        },
      ],
      {
        provider: provider(),
        tools: [],
        config: { ...config(), maxTokens: 64, maxTurns: 2 },
        parentMessages: [
          { role: 'user', content: 'What is 100 + 200?' },
        ],
        agentTimeoutMs: 20_000,
      },
    )

    expect(results).toHaveLength(2)

    // Both should have content
    expect(results[0].content.length).toBeGreaterThan(0)
    expect(results[1].content.length).toBeGreaterThan(0)

    // Both should have usage
    results.forEach(r => {
      expect(r.usage.inputTokens).toBeGreaterThan(0)
      expect(r.turnCount).toBeGreaterThanOrEqual(1)
    })
  }, 30_000)

  // ── Test 4: pipeline — sequential agents ───────────────────────────
  it('pipeline chains output of one agent to input of next', async () => {
    if (skip()) return

    const result = await pipeline(
      [
        {
          name: 'step1-generate',
          systemPrompt: 'Generate exactly 3 random English words separated by commas. Nothing else.',
          maxTurns: 1,
        },
        {
          name: 'step2-count',
          systemPrompt: 'Count the number of words in the input. Reply with ONLY the number.',
          maxTurns: 1,
        },
      ],
      'Give me 3 words.',
      {
        provider: provider(),
        tools: [],
        config: { ...config(), maxTokens: 64, maxTurns: 1 },
        agentTimeoutMs: 15_000,
      },
    )

    // Step 2 should have counted 3 words
    expect(result.content).toContain('3')
    expect(result.turnCount).toBeGreaterThanOrEqual(1)
  }, 30_000)

  // ── Test 5: Abort a running agent ──────────────────────────────────
  it('abort() stops a running agent', async () => {
    if (skip()) return

    const spawner = new AgentSpawner({
      provider: provider(),
      tools: [],
      config: { ...config(), maxTokens: 4096, maxTurns: 20 },
    })

    const handle = await spawner.spawn(
      {
        name: 'verbose-agent',
        systemPrompt: 'Write a very long essay about the history of computing. Make it at least 2000 words.',
        maxTurns: 20,
      },
      'isolated',
      [{ role: 'user', content: 'Write a detailed 2000+ word essay.' }],
    )

    // Abort after 2 seconds (while it's still generating)
    await new Promise(r => setTimeout(r, 2000))
    spawner.abort(handle.id)

    const finalHandle = spawner.getAgent(handle.id)
    expect(finalHandle?.status).toBe('aborted')

    // waitForAgent should reject
    await expect(spawner.waitForAgent(handle.id)).rejects.toThrow(/aborted/)
  }, 15_000)

  // ── Test 6: Agent timeout ──────────────────────────────────────────
  it('agent auto-aborts after timeoutMs', async () => {
    if (skip()) return

    const spawner = new AgentSpawner({
      provider: provider(),
      tools: [],
      config: { ...config(), maxTokens: 4096, maxTurns: 10 },
    })

    const handle = await spawner.spawn(
      {
        name: 'slow-agent',
        systemPrompt: 'Write an extremely detailed 5000 word essay.',
        maxTurns: 10,
      },
      'isolated',
      [{ role: 'user', content: 'Write a 5000 word essay about philosophy.' }],
      { timeoutMs: 3000 }, // 3 second timeout
    )

    // Wait for timeout to trigger
    await new Promise(r => setTimeout(r, 5000))

    const finalHandle = spawner.getAgent(handle.id)
    expect(finalHandle?.status).toBe('aborted')
  }, 15_000)

  // ── Test 7: SSE event stream verification ──────────────────────────
  it('inline agent yields real SSE events', async () => {
    if (skip()) return

    const spawner = new AgentSpawner({
      provider: provider(),
      tools: [reverseTool],
      config: { ...config(), maxTokens: 256, maxTurns: 4 },
    })

    const handle = await spawner.spawn(
      {
        name: 'inline-agent',
        systemPrompt: 'Use the reverse_string tool to reverse the input. Then reply with the reversed text.',
        tools: ['reverse_string'],
        maxTurns: 4,
      },
      'inline',
      [{ role: 'user', content: 'Reverse this: hello' }],
    )

    const gen = spawner.getInlineGenerator(handle.id)
    expect(gen).not.toBeNull()

    const events: LoomEvent[] = []
    let result
    let iter = await gen!.next()
    while (!iter.done) {
      events.push(iter.value)
      iter = await gen!.next()
    }
    result = iter.value

    // Verify event types present
    const types = events.map(e => e.type)

    expect(types).toContain('session.start')
    expect(types).toContain('turn.start')
    expect(types).toContain('text.delta')
    expect(types).toContain('turn.end')

    // Should have tool call events (used reverse_string)
    const hasToolEvents = types.some(t => t === 'tool.call.start')
    // Model might not use the tool every time, but the events should be valid
    if (hasToolEvents) {
      expect(types).toContain('tool.call.end')
    }

    // Result should exist
    expect(result).toBeDefined()
    expect(result.content.length).toBeGreaterThan(0)

    // Verify event ordering: session.start → turn.start → content → turn.end
    const sessionStartIdx = types.indexOf('session.start')
    const firstTurnStart = types.indexOf('turn.start')
    const lastTurnEnd = types.lastIndexOf('turn.end')
    expect(sessionStartIdx).toBeLessThan(firstTurnStart)
    expect(firstTurnStart).toBeLessThan(lastTurnEnd)
  }, 30_000)

  // ── Test 8: Forked agent has parent context ────────────────────────
  it('forked agent receives parent message history', async () => {
    if (skip()) return

    // Create a parent session with some context
    const parentSession = createSession(MODEL, {
      provider: provider(),
      systemPrompt: 'Be brief.',
      config: { maxTokens: 128, maxTurns: 2 },
    })

    // Simulate parent having a conversation
    const parentMessages = [
      { role: 'user' as const, content: 'Remember: the secret code is ALPHA-7.' },
      { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'Got it, the secret code is ALPHA-7.' }] },
    ]

    // Fork a sub-agent with parent context
    const spawner = new AgentSpawner({
      provider: provider(),
      tools: [],
      config: { ...config(), maxTokens: 128, maxTurns: 2 },
    })

    const handle = await spawner.spawn(
      {
        name: 'recall-agent',
        systemPrompt: 'Answer questions based on the conversation history. Be brief.',
        maxTurns: 2,
      },
      'forked',
      [
        ...parentMessages,
        { role: 'user' as const, content: 'What is the secret code? Reply with just the code.' },
      ],
    )

    const result = await spawner.waitForAgent(handle.id)
    expect(result.content).toContain('ALPHA-7')
  }, 30_000)
})
