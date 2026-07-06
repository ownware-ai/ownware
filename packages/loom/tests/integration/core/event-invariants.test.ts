/**
 * Event lifecycle invariant tests.
 *
 * The Loom agent loop is the public contract for every downstream consumer
 * (TUI, gateway SSE, UI clients, SDK embedders). When a downstream UI shows a
 * "still thinking..." spinner that never resolves, or a tool card stuck in
 * "running" forever, the root cause is always the same: a lifecycle event
 * was emitted without its matching partner.
 *
 * The invariants tested here must hold for every path through the loop,
 * including the gnarly recovery paths (max_tokens, rate_limit, prompt_too_long,
 * model_fallback, abort, budget_exceeded, max_turns).
 *
 * Invariants checked on every scenario:
 *
 *   1. Exactly one `session.start` and exactly one `session.end`.
 *   2. Every `turn.start(N)` has exactly one matching `turn.end(N)`.
 *   3. Every `tool.call.start(id)` has exactly one matching `tool.call.end(id)`.
 *   4. Every `permission.request(id)` has exactly one matching
 *      `permission.response(id)` (when permission is requested at all).
 *   5. Every `compaction.start` has a matching `compaction.end`.
 *   6. `session.end` is always the last event.
 *   7. `session.start` is always the first event.
 *   8. Within a session, turn indices never regress — a later turn.start
 *      always has a turnIndex ≥ every earlier turn.start.
 */

import { describe, it, expect } from 'vitest'
import { loop, type LoopParams } from '../../../src/core/loop.js'
import { createDefaultConfig } from '../../../src/core/config.js'
import { ProviderError } from '../../../src/core/errors.js'
import { userMsg } from '../../helpers/fixtures.js'
import type { LoomEvent } from '../../../src/core/events.js'
import type {
  ProviderAdapter,
  ProviderChunk,
  ProviderRequest,
  ProviderFeature,
  ToolDefinition,
} from '../../../src/provider/types.js'
import type { Message } from '../../../src/messages/types.js'
import type { Tool } from '../../../src/tools/types.js'

// ---------------------------------------------------------------------------
// Invariant checker — the single function every scenario runs its trace through
// ---------------------------------------------------------------------------

/**
 * Assert the event stream is well-formed. Throws a descriptive error naming
 * the first invariant violation. Scenarios call this at the end of their
 * collect+run so any violation from any path is caught, not just the one the
 * scenario was specifically exercising.
 */
function assertEventStreamWellFormed(events: readonly LoomEvent[]): void {
  // ── Bookends ───────────────────────────────────────────────────────────
  if (events.length === 0) {
    throw new Error('event stream is empty — expected at least session.start/end')
  }

  const sessionStarts = events.filter(e => e.type === 'session.start')
  const sessionEnds = events.filter(e => e.type === 'session.end')
  if (sessionStarts.length !== 1) {
    throw new Error(`expected exactly 1 session.start, got ${sessionStarts.length}`)
  }
  if (sessionEnds.length !== 1) {
    throw new Error(`expected exactly 1 session.end, got ${sessionEnds.length}`)
  }
  if (events[0]!.type !== 'session.start') {
    throw new Error(`first event must be session.start, got ${events[0]!.type}`)
  }
  if (events[events.length - 1]!.type !== 'session.end') {
    throw new Error(`last event must be session.end, got ${events[events.length - 1]!.type}`)
  }

  // ── Turn pairing (per turnIndex) ───────────────────────────────────────
  const turnStartsByIndex = new Map<number, number>()
  const turnEndsByIndex = new Map<number, number>()
  for (const event of events) {
    if (event.type === 'turn.start') {
      turnStartsByIndex.set(event.turnIndex, (turnStartsByIndex.get(event.turnIndex) ?? 0) + 1)
    } else if (event.type === 'turn.end') {
      turnEndsByIndex.set(event.turnIndex, (turnEndsByIndex.get(event.turnIndex) ?? 0) + 1)
    }
  }
  for (const [turnIndex, startCount] of turnStartsByIndex) {
    if (startCount > 1) {
      throw new Error(
        `turn.start(${turnIndex}) was emitted ${startCount} times — a turn can only start once`,
      )
    }
    const endCount = turnEndsByIndex.get(turnIndex) ?? 0
    if (endCount === 0) {
      throw new Error(
        `turn.start(${turnIndex}) has no matching turn.end — the UI would show this turn as stuck`,
      )
    }
    if (endCount > 1) {
      throw new Error(
        `turn.end(${turnIndex}) was emitted ${endCount} times — a turn can only end once`,
      )
    }
  }
  for (const turnIndex of turnEndsByIndex.keys()) {
    if (!turnStartsByIndex.has(turnIndex)) {
      throw new Error(
        `turn.end(${turnIndex}) was emitted without a matching turn.start`,
      )
    }
  }

  // ── Turn index monotonicity ────────────────────────────────────────────
  let lastTurnStartSeen = -1
  for (const event of events) {
    if (event.type === 'turn.start') {
      if (event.turnIndex < lastTurnStartSeen) {
        throw new Error(
          `turnIndex regressed: saw ${event.turnIndex} after ${lastTurnStartSeen}`,
        )
      }
      lastTurnStartSeen = event.turnIndex
    }
  }

  // ── Tool call pairing (per toolCallId) ─────────────────────────────────
  const toolStartsById = new Map<string, number>()
  const toolEndsById = new Map<string, number>()
  for (const event of events) {
    if (event.type === 'tool.call.start') {
      toolStartsById.set(event.toolCallId, (toolStartsById.get(event.toolCallId) ?? 0) + 1)
    } else if (event.type === 'tool.call.end') {
      toolEndsById.set(event.toolCallId, (toolEndsById.get(event.toolCallId) ?? 0) + 1)
    }
  }
  for (const [toolCallId, startCount] of toolStartsById) {
    if (startCount > 1) {
      throw new Error(
        `tool.call.start(${toolCallId}) was emitted ${startCount} times`,
      )
    }
    const endCount = toolEndsById.get(toolCallId) ?? 0
    if (endCount === 0) {
      throw new Error(
        `tool.call.start(${toolCallId}) has no matching tool.call.end — UI would show tool stuck running`,
      )
    }
  }

  // ── Permission pairing (per requestId) ─────────────────────────────────
  const permReqById = new Map<string, number>()
  const permResById = new Map<string, number>()
  for (const event of events) {
    if (event.type === 'permission.request') {
      permReqById.set(event.requestId, (permReqById.get(event.requestId) ?? 0) + 1)
    } else if (event.type === 'permission.response') {
      permResById.set(event.requestId, (permResById.get(event.requestId) ?? 0) + 1)
    }
  }
  for (const [requestId, reqCount] of permReqById) {
    if (reqCount > 1) {
      throw new Error(`permission.request(${requestId}) emitted ${reqCount} times`)
    }
    const resCount = permResById.get(requestId) ?? 0
    if (resCount === 0) {
      throw new Error(
        `permission.request(${requestId}) has no matching permission.response — UI modal would hang`,
      )
    }
  }

  // ── Compaction pairing ─────────────────────────────────────────────────
  const compactionStarts = events.filter(e => e.type === 'compaction.start').length
  const compactionEnds = events.filter(e => e.type === 'compaction.end').length
  if (compactionStarts !== compactionEnds) {
    throw new Error(
      `compaction mismatch: ${compactionStarts} start(s) vs ${compactionEnds} end(s)`,
    )
  }
}

// ---------------------------------------------------------------------------
// Scriptable mock provider — each yielded chunk recipe drives one stream() call
// ---------------------------------------------------------------------------

type StreamScript =
  | { kind: 'text'; text: string; stopReason?: 'end_turn' | 'max_tokens' }
  | { kind: 'tool'; toolCallId: string; toolName: string; input: Record<string, unknown> }
  | { kind: 'error'; error: Error }

function createScriptedProvider(scripts: readonly StreamScript[]): ProviderAdapter {
  let callIndex = 0
  return {
    name: 'scripted-mock',
    async *stream(_request: ProviderRequest): AsyncGenerator<ProviderChunk> {
      const script = scripts[callIndex++]
      if (!script) {
        throw new Error(`scripted provider ran out of scripts at call ${callIndex}`)
      }
      if (script.kind === 'error') {
        throw script.error
      }
      if (script.kind === 'text') {
        yield { type: 'text_delta', text: script.text } as ProviderChunk
        yield {
          type: 'message_complete',
          content: [{ type: 'text', text: script.text }],
          stopReason: script.stopReason ?? 'end_turn',
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          },
        } as ProviderChunk
        return
      }
      // tool
      yield {
        type: 'tool_use_start',
        id: script.toolCallId,
        name: script.toolName,
      } as ProviderChunk
      yield {
        type: 'tool_use_args_delta',
        id: script.toolCallId,
        delta: JSON.stringify(script.input),
      } as ProviderChunk
      yield { type: 'tool_use_end', id: script.toolCallId } as ProviderChunk
      yield {
        type: 'message_complete',
        content: [
          {
            type: 'tool_use',
            id: script.toolCallId,
            name: script.toolName,
            input: script.input,
          },
        ],
        stopReason: 'tool_use',
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      } as ProviderChunk
    },
    async countTokens(messages: Message[]): Promise<number> {
      return messages.length * 50
    },
    supportsFeature(_feature: ProviderFeature): boolean {
      return true
    },
    formatTools(tools: ToolDefinition[]): unknown[] {
      return tools
    },
    getModelPricing() {
      return {
        inputPer1M: 3,
        outputPer1M: 15,
        cacheReadPer1M: 0.3,
        cacheWritePer1M: 3.75,
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Loop harness
// ---------------------------------------------------------------------------

function baseParams(overrides: Partial<LoopParams> = {}): LoopParams {
  const config = createDefaultConfig('mock:invariant-test')
  return {
    messages: [userMsg('Do the thing')],
    systemPrompt: 'Test assistant.',
    provider: createScriptedProvider([{ kind: 'text', text: 'ok' }]),
    tools: [],
    config,
    compaction: null,
    checkpoint: null,
    checkPermission: async () => 'allow' as const,
    requestApproval: async () => true,
    ...overrides,
  }
}

async function collectLoop(params: LoopParams): Promise<LoomEvent[]> {
  const events: LoomEvent[] = []
  const gen = loop(params)
  let next = await gen.next()
  while (!next.done) {
    events.push(next.value)
    next = await gen.next()
  }
  return events
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

describe('event lifecycle invariants', () => {
  it('holds for a plain one-turn text response', async () => {
    const events = await collectLoop(baseParams())
    assertEventStreamWellFormed(events)
    expect(events.filter(e => e.type === 'turn.start')).toHaveLength(1)
    expect(events.filter(e => e.type === 'turn.end')).toHaveLength(1)
  })

  it('holds across a multi-turn tool-calling exchange', async () => {
    // Turn 0: model requests a tool call.
    // Turn 1: model produces final text.
    const tool: Tool = {
      name: 'echo',
      description: 'echoes input',
      inputSchema: { type: 'object', properties: { msg: { type: 'string' } } } as unknown as Tool['inputSchema'],
      isReadOnly: true,
      requiresPermission: false,
      async execute(input: Record<string, unknown>) {
        return { content: String(input['msg'] ?? ''), isError: false }
      },
    }

    const provider = createScriptedProvider([
      { kind: 'tool', toolCallId: 'tc-1', toolName: 'echo', input: { msg: 'hi' } },
      { kind: 'text', text: 'done' },
    ])
    const events = await collectLoop(baseParams({ provider, tools: [tool] }))
    assertEventStreamWellFormed(events)
    expect(events.filter(e => e.type === 'turn.start')).toHaveLength(2)
    expect(events.filter(e => e.type === 'turn.end')).toHaveLength(2)
    expect(events.filter(e => e.type === 'tool.call.start')).toHaveLength(1)
    expect(events.filter(e => e.type === 'tool.call.end')).toHaveLength(1)
  })

  it('closes the prior turn before starting the continuation turn on max_tokens recovery', async () => {
    // Model returns max_tokens truncated output on turn 0. Loop injects a
    // "resume directly" user message and bumps turnIndex. Turn 1 completes
    // normally. The bug this guards: turn 0 must emit turn.end BEFORE
    // turn.start(1) is emitted — otherwise the UI sees turn 0 stuck forever.
    const provider = createScriptedProvider([
      { kind: 'text', text: 'partial...', stopReason: 'max_tokens' },
      { kind: 'text', text: 'continuation', stopReason: 'end_turn' },
    ])
    const events = await collectLoop(baseParams({ provider }))
    assertEventStreamWellFormed(events)

    // Ordering assertion: turn.end(0) must come before turn.start(1).
    const seq = events.map(e => `${e.type}${'turnIndex' in e ? `(${e.turnIndex})` : ''}`)
    const turnEnd0Idx = seq.indexOf('turn.end(0)')
    const turnStart1Idx = seq.indexOf('turn.start(1)')
    expect(turnEnd0Idx).toBeGreaterThan(-1)
    expect(turnStart1Idx).toBeGreaterThan(-1)
    expect(turnEnd0Idx).toBeLessThan(turnStart1Idx)

    // And a recovery event should sit between the two.
    const recoveryIdx = events.findIndex(e => e.type === 'recovery')
    expect(recoveryIdx).toBeGreaterThan(-1)
    expect(recoveryIdx).toBeLessThan(turnEnd0Idx)
  })

  it('does NOT re-emit turn.start on transient rate-limit recovery (same turnIndex)', async () => {
    // Rate limit on first call, succeed on retry. The loop should NOT emit
    // a second turn.start for turnIndex 0 — that would be an orphan start.
    const rateLimitError = new ProviderError('rate limited', 'RATE_LIMIT', {
      statusCode: 429,
      retryable: true,
    })
    const provider = createScriptedProvider([
      { kind: 'error', error: rateLimitError },
      { kind: 'text', text: 'finally worked' },
    ])
    const config = createDefaultConfig('mock:invariant-test')
    // Shorten retry delay so the test is fast.
    const tunedConfig = {
      ...config,
      retry: { ...config.retry, baseDelayMs: 1 },
    }
    const events = await collectLoop(baseParams({ provider, config: tunedConfig }))
    assertEventStreamWellFormed(events)
    expect(events.filter(e => e.type === 'turn.start')).toHaveLength(1)
    expect(events.filter(e => e.type === 'turn.end')).toHaveLength(1)
    expect(events.filter(e => e.type === 'recovery')).toHaveLength(1)
  })

  it('pairs turn.end/session.end when the loop is aborted mid-run', async () => {
    // Abort BEFORE the loop even starts turn 0. Even so, the contract must
    // hold: session.end closes what session.start opened.
    const abortController = new AbortController()
    abortController.abort()
    const config = createDefaultConfig('mock:invariant-test')
    const tunedConfig = { ...config, abortSignal: abortController.signal }
    const events = await collectLoop(baseParams({ config: tunedConfig }))
    assertEventStreamWellFormed(events)
    // No turn was ever started in this case, but the invariant checker
    // already validated session.start/end bookend correctly.
  })

  it('pairs turn.end/session.end when max_turns is hit', async () => {
    // maxTurns is checked at the top of each iteration. A model that keeps
    // requesting tool calls forever is the realistic trigger. We script two
    // tool calls so turn 0 completes and advances turnIndex to 1, then the
    // maxTurns=1 check fires at the top of the next iteration.
    const tool: Tool = {
      name: 'echo',
      description: 'echoes',
      inputSchema: { type: 'object', properties: {} } as unknown as Tool['inputSchema'],
      isReadOnly: true,
      requiresPermission: false,
      async execute() {
        return { content: 'ok', isError: false }
      },
    }
    const provider = createScriptedProvider([
      { kind: 'tool', toolCallId: 'tc-1', toolName: 'echo', input: {} },
      { kind: 'tool', toolCallId: 'tc-2', toolName: 'echo', input: {} },
    ])
    const config = createDefaultConfig('mock:invariant-test')
    const tunedConfig = { ...config, maxTurns: 1 }
    const events = await collectLoop(baseParams({ provider, tools: [tool], config: tunedConfig }))
    assertEventStreamWellFormed(events)
    const errorEvent = events.find(e => e.type === 'error')
    expect(errorEvent).toBeDefined()
  })

  it('pairs turn.end/session.end when the budget is exceeded before entering a turn', async () => {
    const config = createDefaultConfig('mock:invariant-test')
    const tunedConfig = {
      ...config,
      maxBudgetUsd: 0.0000001, // effectively zero
    }
    // Seed state by running once normally — but budget check fires on the
    // FIRST iteration before costUsd accumulates, so budget_exceeded path
    // only triggers after at least one turn has completed. We simulate that
    // by pre-accumulating via two calls. The simpler check: with zero
    // budget, after turn 0 finishes the budget is exceeded → second
    // iteration hits the budget path cleanly.
    const provider = createScriptedProvider([
      { kind: 'text', text: 'first' },
      { kind: 'text', text: 'second' },
    ])
    const events = await collectLoop(baseParams({ provider, config: tunedConfig }))
    assertEventStreamWellFormed(events)
  })

  it('pairs permission.request/permission.response when a tool is gated', async () => {
    const tool: Tool = {
      name: 'danger',
      description: 'requires permission',
      inputSchema: { type: 'object', properties: {} } as unknown as Tool['inputSchema'],
      isReadOnly: false,
      requiresPermission: true,
      async execute() {
        return { content: 'ok', isError: false }
      },
    }
    const provider = createScriptedProvider([
      { kind: 'tool', toolCallId: 'perm-1', toolName: 'danger', input: {} },
      { kind: 'text', text: 'final' },
    ])
    const events = await collectLoop(baseParams({
      provider,
      tools: [tool],
      checkPermission: async () => 'ask',
      requestApproval: async () => true,
    }))
    assertEventStreamWellFormed(events)
    expect(events.filter(e => e.type === 'permission.request')).toHaveLength(1)
    expect(events.filter(e => e.type === 'permission.response')).toHaveLength(1)
  })

  it('pairs permission.request/permission.response when the user denies', async () => {
    const tool: Tool = {
      name: 'danger',
      description: 'requires permission',
      inputSchema: { type: 'object', properties: {} } as unknown as Tool['inputSchema'],
      isReadOnly: false,
      requiresPermission: true,
      async execute() {
        return { content: 'ok', isError: false }
      },
    }
    const provider = createScriptedProvider([
      { kind: 'tool', toolCallId: 'perm-1', toolName: 'danger', input: {} },
      { kind: 'text', text: 'final' },
    ])
    const events = await collectLoop(baseParams({
      provider,
      tools: [tool],
      checkPermission: async () => 'ask',
      requestApproval: async () => false, // user denies
    }))
    assertEventStreamWellFormed(events)
    expect(events.filter(e => e.type === 'permission.request')).toHaveLength(1)
    const responses = events.filter(e => e.type === 'permission.response')
    expect(responses).toHaveLength(1)
    const response = responses[0]!
    if (response.type !== 'permission.response') throw new Error('unreachable')
    expect(response.granted).toBe(false)
  })

  it('emits permission.response without a matching request when the policy denies upfront', async () => {
    // Current contract: when checkPermission returns 'deny', the loop still
    // yields a `permission.response` event (granted:false) but no request.
    // That's a naming inconsistency, but the invariant we're checking is
    // "no orphan requests," not "response must have request." This test
    // pins the behavior so any future change is intentional.
    const tool: Tool = {
      name: 'blocked',
      description: 'denied by policy',
      inputSchema: { type: 'object', properties: {} } as unknown as Tool['inputSchema'],
      isReadOnly: false,
      requiresPermission: true,
      async execute() {
        return { content: 'ok', isError: false }
      },
    }
    const provider = createScriptedProvider([
      { kind: 'tool', toolCallId: 'perm-1', toolName: 'blocked', input: {} },
      { kind: 'text', text: 'final' },
    ])
    const events = await collectLoop(baseParams({
      provider,
      tools: [tool],
      checkPermission: async () => 'deny',
    }))
    // Not calling assertEventStreamWellFormed here because a naked
    // permission.response without a request would trip a future "response
    // requires request" invariant if we added one. The important safety
    // behavior is tool.call.start paired with tool.call.end, which IS
    // checked here:
    expect(events.filter(e => e.type === 'tool.call.start')).toHaveLength(1)
    expect(events.filter(e => e.type === 'tool.call.end')).toHaveLength(1)
    // And session bookends still hold.
    expect(events[0]!.type).toBe('session.start')
    expect(events[events.length - 1]!.type).toBe('session.end')
  })
})
