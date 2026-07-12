/**
 * Reducer completeness (messages ↔ agent_events parity).
 *
 * The gateway writes every Loom event through two persistence paths:
 *
 *   1. `agent_events` — raw append-only stream, consumed by SSE live
 *      tail and by `?since=N` mid-run reconnect.
 *   2. `messages` — consolidated UI-ready snapshot, consumed by
 *      `GET /threads/:id/messages`.
 *
 * Retention will eventually prune old `agent_events` rows for terminal
 * threads, so `messages` must carry everything the client's reducer needs
 * to render an archived thread. This suite locks that contract.
 *
 * The approach: drive the SessionRunner with a scripted FakeSession
 * that yields a canned LoomEvent stream, let it write both tables,
 * then assert the `messages` row has every field that the raw events
 * carried. If the reducer drops a field, this test fails — which is
 * the whole point.
 *
 * NOTE: this runs with no Loom provider and no network. The FakeSession
 * just plays back the array of events.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { GatewayState } from '../../../src/gateway/state.js'
import { SessionRunner } from '../../../src/gateway/session-runner.js'
import { GatewayRunStore } from '../../../src/gateway/run-store.js'
import type { LoomEvent } from '@ownware/loom'
import { HumanInTheLoop } from '@ownware/loom'

// ---------------------------------------------------------------------------
// FakeSession — replays a scripted event stream as an async generator.
// ---------------------------------------------------------------------------

interface FakeSessionOpts {
  /** Yield to the event loop between events so external code can abort. */
  readonly stepDelayMs?: number
  /**
   * When the scripted events run out, block inside the generator until
   * `abort()` is called. Used by the partial-turn tests which need to
   * interrupt a run that's paused mid-turn.
   */
  readonly hangAtEnd?: boolean
}

class FakeSession {
  private aborted: 'user' | 'timeout' | 'system' | null = null
  /**
   * Events injected by `queueAfterHang` while the generator is parked
   * in the hangAtEnd loop. The next iteration drains them in order
   * and yields each one before either hanging again or returning.
   */
  private readonly postHangQueue: LoomEvent[] = []
  /** Set true to make the generator return cleanly after draining the queue. */
  private finishedAfterHang = false
  readonly sessionId = 'fake-session'

  constructor(
    private readonly events: readonly LoomEvent[],
    private readonly opts: FakeSessionOpts = {},
  ) {}

  async *submitMessage(): AsyncGenerator<LoomEvent, unknown> {
    const step = this.opts.stepDelayMs ?? 1
    for (const event of this.events) {
      if (this.aborted) {
        // Session.abort rejects the generator with the reason as the
        // error message — match that exact contract so the runner's
        // catch block maps it correctly.
        throw new Error(this.aborted)
      }
      yield event
      // Yield to the event loop so outer code can call abort() between
      // events and the next loop iteration observes it.
      await new Promise(r => setTimeout(r, step))
    }
    if (this.opts.hangAtEnd) {
      // Block until aborted OR until the test feeds events through
      // queueAfterHang. Tests use the abort path to simulate
      // mid-stream interrupts; the queue path lets a test interleave
      // external calls (e.g. notifyParentLifecycleEvent) and then
      // release the run with a clean turn.end.
      while (!this.aborted && !this.finishedAfterHang && this.postHangQueue.length === 0) {
        await new Promise(r => setTimeout(r, 2))
      }
      while (this.postHangQueue.length > 0) {
        if (this.aborted) throw new Error(this.aborted)
        yield this.postHangQueue.shift()!
        await new Promise(r => setTimeout(r, step))
      }
      if (this.aborted) throw new Error(this.aborted)
      // Fall through to clean return.
    }
    return { turnCount: 0, totalUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 }, messages: [] }
  }

  abort(reason: 'user' | 'timeout' | 'system' = 'user'): void {
    this.aborted = reason
  }

  /**
   * Inject an event into the post-hang queue and signal the generator
   * to return cleanly after it drains. Used by tests that need to
   * interleave external runner calls between scripted events and the
   * terminal turn.end.
   */
  queueAfterHang(event: LoomEvent): void {
    this.postHangQueue.push(event)
    this.finishedAfterHang = true
  }
}

/**
 * Register a fake session + runtime on the gateway state so
 * SessionRunner.start() has everything it needs to iterate the stream.
 */
function installFakeSession(
  state: GatewayState,
  threadId: string,
  events: readonly LoomEvent[],
  opts: FakeSessionOpts = {},
): FakeSession {
  const session = new FakeSession(events, opts)
  // The runner only calls session.submitMessage() and session.abort(), so
  // a structural-typed fake is enough. Cast through unknown to skip the
  // full Session class shape (private fields etc.) that we don't need.
  state.setSession(threadId, session as unknown as Parameters<typeof state.setSession>[1])
  state.setRuntime(threadId, {
    session: session as unknown as Parameters<typeof state.setSession>[1],
    hitl: new HumanInTheLoop({ requestPermission: async () => 'allow' }),
    zoneManager: null,
  })
  return session
}

// ---------------------------------------------------------------------------
// Canonical event stream builder
// ---------------------------------------------------------------------------

function mkTurn(turnIndex: number): LoomEvent[] {
  return [
    { type: 'turn.start', turnIndex, timestamp: Date.now() },
    { type: 'thinking.delta', turnIndex, text: 'planning... ' },
    { type: 'thinking.delta', turnIndex, text: 'done.' },
    { type: 'text.delta', turnIndex, text: 'Hello ' },
    { type: 'text.delta', turnIndex, text: 'world.' },
    { type: 'tool.call.start', turnIndex, toolCallId: 'tc_1', toolName: 'read_file', input: { path: '/tmp/a.txt' } },
    { type: 'tool.call.end', turnIndex, toolCallId: 'tc_1', toolName: 'read_file', result: 'file contents', isError: false, durationMs: 42, metadata: { lines: 3 } },
    { type: 'permission.request', turnIndex, requestId: 'req_1', toolName: 'shell_exec', input: { cmd: 'ls' }, reason: 'needs shell', zoneLevel: 3, zoneName: 'network', explanation: 'network-tier' },
    { type: 'permission.response', turnIndex, requestId: 'req_1', granted: true },
    { type: 'agent.spawn', turnIndex, agentId: 'sub_1', profileName: 'helper', parentAgentId: null },
    { type: 'agent.complete', turnIndex, agentId: 'sub_1', result: 'sub done', durationMs: 100 },
    { type: 'turn.end', turnIndex, stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0, model: 'test', costUsd: 0.001 }, timestamp: Date.now() },
  ] as LoomEvent[]
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('reducer parity — messages snapshot carries everything UI needs', () => {
  let state: GatewayState
  let runner: SessionRunner

  beforeEach(() => {
    state = new GatewayState()
    runner = new SessionRunner(state)
  })

  afterEach(() => {
    state.close()
  })

  it('captures text, thinking, tools, permissions, sub-agents, and usage on a clean turn', async () => {
    const thread = state.createThread('test')
    const events = mkTurn(0)
    installFakeSession(state, thread.id, events)

    const handle = runner.start({
      threadId: thread.id,
      profileId: 'test',
      model: 'test:test',
      prompt: 'hello',
    })
    const result = await handle.done
    expect(result.status).toBe('completed')

    const messages = state.getMessages(thread.id)
    // Assistant row is emitted on turn.end; no user row (run.ts handler
    // owns that write path, which we bypass here).
    const assistant = messages.find(m => m.role === 'assistant')
    expect(assistant).toBeDefined()

    expect(assistant!.content).toBe('Hello world.')
    expect(assistant!.thinking).toBe('planning... done.')

    expect(assistant!.tools).toHaveLength(1)
    expect(assistant!.tools![0]).toMatchObject({
      name: 'read_file',
      input: { path: '/tmp/a.txt' },
      output: 'file contents',
      isError: false,
      durationMs: 42,
      metadata: { lines: 3 },
    })
    expect(assistant!.tools![0]!.startedAt).toBeTypeOf('string')

    expect(assistant!.permissions).toHaveLength(1)
    expect(assistant!.permissions![0]).toMatchObject({
      toolName: 'shell_exec',
      input: { cmd: 'ls' },
      reason: 'needs shell',
      decision: 'approved',
      zoneLevel: 3,
      zoneName: 'network',
      explanation: 'network-tier',
    })

    expect(assistant!.subAgents).toHaveLength(1)
    expect(assistant!.subAgents![0]).toMatchObject({
      agentId: 'sub_1',
      profileName: 'helper',
      status: 'completed',
      result: 'sub done',
      durationMs: 100,
    })

    // Migration 027 added cache token columns. session-runner.ts
    // accumulates all four fields universally from Loom's TurnUsage
    // event; the client's context-fill indicator sums cache fields with
    // inputTokens to compute the true window-fill.
    expect(assistant!.usage).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    })
  })

  it('binds a streamed permission request to its run and persists the operation hash', async () => {
    const thread = state.createThread('test')
    const runStore = new GatewayRunStore(state.rawDbHandle, 'synthetic-test-secret')
    runner = new SessionRunner(state, runStore)
    const run = runStore.create({
      threadId: thread.id,
      profileId: 'test',
      model: 'test:test',
      timeoutMs: 60_000,
      startSeq: 0,
    })
    const events: LoomEvent[] = [
      { type: 'turn.start', turnIndex: 0, timestamp: Date.now() },
      { type: 'permission.request', turnIndex: 0, requestId: 'req_exact', toolName: 'send_email', input: { body: 'synthetic private body' }, reason: 'send needs approval' },
      { type: 'permission.response', turnIndex: 0, requestId: 'req_exact', granted: true },
      { type: 'turn.end', turnIndex: 0, stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, model: 'test', costUsd: 0 }, timestamp: Date.now() },
    ]
    installFakeSession(state, thread.id, events)

    const handle = runner.start({
      runId: run.runId,
      threadId: thread.id,
      profileId: 'test',
      model: 'test:test',
      prompt: 'go',
    })
    await handle.done

    const permission = runStore.getPermissionRequest(run.runId, 'req_exact')
    expect(permission).toMatchObject({
      runId: run.runId,
      requestId: 'req_exact',
      toolName: 'send_email',
      status: 'approved',
    })
    expect(permission!.operationHash).toMatch(/^[0-9a-f]{64}$/)

    const persistedRequest = state.listAgentEvents({
      threadId: thread.id,
      agentId: 'root',
    }).find(event => event.type === 'permission.request')
    expect(persistedRequest?.payload).toMatchObject({
      requestId: 'req_exact',
      operationHash: permission!.operationHash,
    })
  })

  it('marks a wall-clock timeout only after the runner finalizer observes it', async () => {
    const thread = state.createThread('test')
    const runStore = new GatewayRunStore(state.rawDbHandle, 'synthetic-test-secret')
    runner = new SessionRunner(state, runStore)
    const run = runStore.create({
      threadId: thread.id,
      profileId: 'test',
      model: 'test:test',
      timeoutMs: 20,
      startSeq: 0,
    })
    installFakeSession(
      state,
      thread.id,
      [{ type: 'turn.start', turnIndex: 0, timestamp: Date.now() }],
      { hangAtEnd: true },
    )

    const handle = runner.start({
      runId: run.runId,
      threadId: thread.id,
      profileId: 'test',
      model: 'test:test',
      prompt: 'wait',
      timeoutMs: 20,
    })
    await expect(handle.done).resolves.toMatchObject({ status: 'aborted' })
    expect(runStore.get(run.runId)).toMatchObject({
      status: 'timed_out',
      terminal: true,
      outcomeKnown: true,
      code: 'run_timeout',
    })
  })

  it('captures enriched sub-agent fields (model/task/usage/status) for orchestrate workers', async () => {
    const thread = state.createThread('test')
    // Two workers spawned INSIDE one `orchestrate` tool call. There is no
    // per-worker `agent_spawn` tool call, so the gateway's agent_spawn-input
    // correlation never fires — the ENRICHED `agent.spawn`/`agent.complete`
    // events (L3) are the only source of name/model/task/status/usage.
    const events: LoomEvent[] = [
      { type: 'turn.start', turnIndex: 0, timestamp: Date.now() },
      { type: 'tool.call.start', turnIndex: 0, toolCallId: 'tc_o', toolName: 'orchestrate', input: { shape: 'fan-out' } },
      { type: 'agent.spawn', turnIndex: 0, agentId: 'w1', profileName: 'explore', parentAgentId: null, name: 'worker-a', model: 'openrouter:kimi-k2.5', task: 'read auth.ts' },
      { type: 'agent.spawn', turnIndex: 0, agentId: 'w2', profileName: 'explore', parentAgentId: null, name: 'worker-b', model: 'openrouter:deepseek', task: 'read cache.ts' },
      { type: 'agent.complete', turnIndex: 0, agentId: 'w1', result: 'A', durationMs: 50, status: 'completed', turnCount: 2, usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0, model: 'openrouter:kimi-k2.5', costUsd: 0.004 } },
      { type: 'agent.complete', turnIndex: 0, agentId: 'w2', result: 'B', durationMs: 60, status: 'aborted', turnCount: 1 },
      { type: 'tool.call.end', turnIndex: 0, toolCallId: 'tc_o', toolName: 'orchestrate', result: 'combined', isError: false, durationMs: 120 },
      { type: 'turn.end', turnIndex: 0, stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, model: 'test', costUsd: 0 }, timestamp: Date.now() },
    ] as LoomEvent[]
    installFakeSession(state, thread.id, events)

    const handle = runner.start({ threadId: thread.id, profileId: 'test', model: 'test:test', prompt: 'go' })
    await handle.done

    const assistant = state.getMessages(thread.id).find(m => m.role === 'assistant')!
    // Both workers (spawned under ONE tool call) become sub-agent records.
    expect(assistant.subAgents).toHaveLength(2)

    const w1 = assistant.subAgents!.find(a => a.agentId === 'w1')!
    expect(w1).toMatchObject({
      model: 'openrouter:kimi-k2.5',
      task: 'read auth.ts',
      status: 'completed',
      turnCount: 2,
    })
    expect(w1.usage).toEqual({ inputTokens: 100, outputTokens: 20, costUsd: 0.004 })

    // Aborted worker → status collapses to 'error' (record has no 'aborted'
    // state yet), but its model/task are still captured. No ghost.
    const w2 = assistant.subAgents!.find(a => a.agentId === 'w2')!
    expect(w2).toMatchObject({ model: 'openrouter:deepseek', task: 'read cache.ts', status: 'error' })
  })

  it('emits a separate system message for each compaction.end, recovery, and security.block', async () => {
    const thread = state.createThread('test')
    const events: LoomEvent[] = [
      { type: 'turn.start', turnIndex: 0, timestamp: Date.now() },
      { type: 'compaction.end', turnIndex: 0, strategy: 'truncate', preTokenCount: 100, postTokenCount: 40, savedPercent: 60 },
      { type: 'recovery', turnIndex: 0, reason: 'rate_limit', attempt: 1, detail: 'backing off' },
      { type: 'security.block', turnIndex: 0, toolName: 'shell_exec', level: 'critical', reason: 'zone denied', command: 'rm -rf /' },
      { type: 'text.delta', turnIndex: 0, text: 'ok' },
      { type: 'turn.end', turnIndex: 0, stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, model: 'test', costUsd: 0 }, timestamp: Date.now() },
    ]
    installFakeSession(state, thread.id, events)

    const handle = runner.start({
      threadId: thread.id,
      profileId: 'test',
      model: 'test:test',
      prompt: 'hi',
    })
    await handle.done

    const msgs = state.getMessages(thread.id)
    const system = msgs.filter(m => m.role === 'system')
    expect(system).toHaveLength(3) // compaction.end, recovery, security.block

    const block = system.find(m => m.content.startsWith('Blocked'))!
    expect(block.content).toContain('shell_exec')
    expect(block.tools).toHaveLength(1)
    // Gap #4 fix — security.block's `command` field is preserved in the
    // persisted tool record so forensic replays aren't empty.
    expect(block.tools![0]!.input).toEqual({ command: 'rm -rf /' })
  })

  it('flushes partial assistant turn on abort (Task #4 finalizer)', async () => {
    const thread = state.createThread('test')
    // Turn starts, text streams, a tool finishes, then the session is
    // aborted mid-turn — no turn.end ever arrives.
    const events: LoomEvent[] = [
      { type: 'turn.start', turnIndex: 0, timestamp: Date.now() },
      { type: 'text.delta', turnIndex: 0, text: 'Working on it' },
      { type: 'tool.call.start', turnIndex: 0, toolCallId: 'tc_1', toolName: 'read_file', input: {} },
      { type: 'tool.call.end', turnIndex: 0, toolCallId: 'tc_1', toolName: 'read_file', result: 'ok', isError: false, durationMs: 5 },
    ]
    const session = installFakeSession(state, thread.id, events, { hangAtEnd: true })

    const handle = runner.start({
      threadId: thread.id,
      profileId: 'test',
      model: 'test:test',
      prompt: 'hi',
    })
    // Let the runner drain all scripted events, then abort while the
    // generator is blocked in hangAtEnd.
    await new Promise(r => setTimeout(r, 30))
    session.abort('user')
    const result = await handle.done

    expect(result.status).toBe('aborted')

    // The finalizer should have flushed the partial assistant turn even
    // though turn.end never arrived. Without the finalizer, messages[]
    // for this thread would be empty — all streamed content lost.
    const msgs = state.getMessages(thread.id)
    const assistant = msgs.find(m => m.role === 'assistant')
    expect(assistant).toBeDefined()
    expect(assistant!.content).toBe('Working on it')
    expect(assistant!.tools).toHaveLength(1)
    expect(assistant!.tools![0]!.name).toBe('read_file')

    // A turn.interrupted marker event must also be in the agent_events log.
    const rawEvents = state.listAgentEvents({ threadId: thread.id, agentId: 'root' })
    const interrupted = rawEvents.find(e => e.type === 'turn.interrupted')
    expect(interrupted).toBeDefined()
    const payload = interrupted!.payload as { reason: string; hadContent: boolean; hadTools: boolean }
    expect(payload.reason).toBe('aborted')
    expect(payload.hadContent).toBe(true)
    expect(payload.hadTools).toBe(true)
  })

  it('marks pending sub-agents as error when parent aborts before agent.complete', async () => {
    const thread = state.createThread('test')
    const events: LoomEvent[] = [
      { type: 'turn.start', turnIndex: 0, timestamp: Date.now() },
      { type: 'text.delta', turnIndex: 0, text: 'launching helper' },
      { type: 'agent.spawn', turnIndex: 0, agentId: 'sub_1', profileName: 'helper', parentAgentId: null },
      // No agent.complete — sub-agent is orphaned when parent aborts.
    ]
    const fake = installFakeSession(state, thread.id, events, { hangAtEnd: true })

    const handle = runner.start({
      threadId: thread.id,
      profileId: 'test',
      model: 'test:test',
      prompt: 'hi',
    })
    await new Promise(r => setTimeout(r, 30))
    fake.abort('user')
    await handle.done

    const msgs = state.getMessages(thread.id)
    const assistant = msgs.find(m => m.role === 'assistant')
    expect(assistant).toBeDefined()
    expect(assistant!.subAgents).toHaveLength(1)
    // Running sub-agent must be downgraded so the client doesn't render a
    // permanent spinner on a dead helper.
    expect(assistant!.subAgents![0]!.status).toBe('error')
    expect(assistant!.subAgents![0]!.result).toContain('interrupted')
  })

  it('captures pending permission request that never got a response', async () => {
    const thread = state.createThread('test')
    const events: LoomEvent[] = [
      { type: 'turn.start', turnIndex: 0, timestamp: Date.now() },
      { type: 'text.delta', turnIndex: 0, text: 'asking' },
      { type: 'permission.request', turnIndex: 0, requestId: 'req_1', toolName: 'shell_exec', input: { cmd: 'ls' }, reason: 'need shell' },
      // Abort before the user responds.
    ]
    const fake = installFakeSession(state, thread.id, events, { hangAtEnd: true })

    const handle = runner.start({
      threadId: thread.id,
      profileId: 'test',
      model: 'test:test',
      prompt: 'hi',
    })
    await new Promise(r => setTimeout(r, 30))
    fake.abort('user')
    await handle.done

    const msgs = state.getMessages(thread.id)
    const assistant = msgs.find(m => m.role === 'assistant')
    expect(assistant).toBeDefined()
    expect(assistant!.permissions).toHaveLength(1)
    // Pending at abort → decision stays 'pending' so the client can render
    // the outstanding request rather than silently dropping it.
    expect(assistant!.permissions![0]!.decision).toBe('pending')
  })

  it('preserves interleaved order in parts (text → tool → text → tool)', async () => {
    const thread = state.createThread('test')
    // The classic case: text, then a tool call, then more text, then
    // another tool. Today's tools[] array would render as
    // "text text" + two trailing tool cards. parts must preserve order.
    const events: LoomEvent[] = [
      { type: 'turn.start', turnIndex: 0, timestamp: Date.now() },
      { type: 'text.delta', turnIndex: 0, text: "Let me check. " },
      { type: 'tool.call.start', turnIndex: 0, toolCallId: 'tc_1', toolName: 'ls', input: { path: '/tmp' } },
      { type: 'tool.call.end', turnIndex: 0, toolCallId: 'tc_1', toolName: 'ls', result: 'a b c', isError: false, durationMs: 1 },
      { type: 'text.delta', turnIndex: 0, text: "Found 3. Reading. " },
      { type: 'tool.call.start', turnIndex: 0, toolCallId: 'tc_2', toolName: 'read', input: { path: '/tmp/a' } },
      { type: 'tool.call.end', turnIndex: 0, toolCallId: 'tc_2', toolName: 'read', result: 'A', isError: false, durationMs: 2 },
      { type: 'text.delta', turnIndex: 0, text: "Done." },
      { type: 'turn.end', turnIndex: 0, stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, model: 'test', costUsd: 0 }, timestamp: Date.now() },
    ]
    installFakeSession(state, thread.id, events)

    const handle = runner.start({
      threadId: thread.id,
      profileId: 'test',
      model: 'test:test',
      prompt: 'hi',
    })
    await handle.done

    const msgs = state.getMessages(thread.id)
    const asst = msgs.find(m => m.role === 'assistant')!
    expect(asst.parts).toBeDefined()
    expect(asst.parts).toEqual([
      { kind: 'text', text: 'Let me check. ' },
      { kind: 'tool', toolCallId: 'tc_1' },
      { kind: 'text', text: 'Found 3. Reading. ' },
      { kind: 'tool', toolCallId: 'tc_2' },
      { kind: 'text', text: 'Done.' },
    ])

    // tools[] still populated for back-compat with stable ids attached
    // so consumers can resolve a `parts` entry.
    expect(asst.tools).toHaveLength(2)
    expect(asst.tools![0]!.toolCallId).toBe('tc_1')
    expect(asst.tools![1]!.toolCallId).toBe('tc_2')
  })

  it('merges consecutive text deltas into one part; drops empty deltas', async () => {
    const thread = state.createThread('test')
    const events: LoomEvent[] = [
      { type: 'turn.start', turnIndex: 0, timestamp: Date.now() },
      { type: 'text.delta', turnIndex: 0, text: 'hel' },
      { type: 'text.delta', turnIndex: 0, text: '' },
      { type: 'text.delta', turnIndex: 0, text: 'lo' },
      { type: 'turn.end', turnIndex: 0, stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, model: 'test', costUsd: 0 }, timestamp: Date.now() },
    ]
    installFakeSession(state, thread.id, events)
    const handle = runner.start({
      threadId: thread.id, profileId: 'test', model: 'test:test', prompt: 'hi',
    })
    await handle.done

    const msgs = state.getMessages(thread.id)
    const asst = msgs.find(m => m.role === 'assistant')!
    expect(asst.parts).toEqual([{ kind: 'text', text: 'hello' }])
  })

  it('partial-flush materializes interrupted tool record so parts.tool refs resolve', async () => {
    const thread = state.createThread('test')
    // tool.call.start fires but tool.call.end never arrives (parent
    // aborts mid-tool). parts has a {kind:'tool', toolCallId:'tc_1'};
    // tools[] must contain tc_1 with isError so the lookup resolves.
    const events: LoomEvent[] = [
      { type: 'turn.start', turnIndex: 0, timestamp: Date.now() },
      { type: 'text.delta', turnIndex: 0, text: 'starting' },
      { type: 'tool.call.start', turnIndex: 0, toolCallId: 'tc_1', toolName: 'long_op', input: { x: 1 } },
    ]
    const fake = installFakeSession(state, thread.id, events, { hangAtEnd: true })

    const handle = runner.start({
      threadId: thread.id, profileId: 'test', model: 'test:test', prompt: 'hi',
    })
    await new Promise(r => setTimeout(r, 30))
    fake.abort('user')
    await handle.done

    const msgs = state.getMessages(thread.id)
    const asst = msgs.find(m => m.role === 'assistant')!
    // parts has a tool entry referring to tc_1
    expect(asst.parts?.some(p => p.kind === 'tool' && p.toolCallId === 'tc_1')).toBe(true)
    // tools[] has a matching record marked interrupted
    const toolRec = asst.tools?.find(t => t.toolCallId === 'tc_1')
    expect(toolRec).toBeDefined()
    expect(toolRec!.isError).toBe(true)
    expect(toolRec!.output).toContain('interrupted')
  })

  it('routes spawner-emitted lifecycle events into parent messages snapshot', async () => {
    // Reproduces a bug caught in live client E2E: agent.spawn /
    // agent.complete are yielded by the spawner's own generator, not
    // by the parent session.submitMessage() generator. Without the
    // SessionRunner.notifyParentLifecycleEvent wiring the parent's
    // accumulator never sees them and messages.subAgents stays empty.
    //
    // We simulate the spawner's onEvent hook by calling
    // notifyParentLifecycleEvent directly while a parent run is in
    // flight. The parent generator only carries text + the
    // tool.call.start for `agent_spawn` (the tool the model invokes
    // to launch a helper) — which mirrors what happens live.
    const thread = state.createThread('test')
    const events: LoomEvent[] = [
      { type: 'turn.start', turnIndex: 0, timestamp: Date.now() },
      { type: 'text.delta', turnIndex: 0, text: "I'll spawn a helper." },
      { type: 'tool.call.start', turnIndex: 0, toolCallId: 'tc_spawn', toolName: 'agent_spawn', input: { name: 'helper' } },
      { type: 'tool.call.end', turnIndex: 0, toolCallId: 'tc_spawn', toolName: 'agent_spawn', result: 'ok', isError: false, durationMs: 10 },
      // turn.end follows AFTER the lifecycle hook fires (below).
    ]
    const fake = installFakeSession(state, thread.id, events, { hangAtEnd: true })

    const handle = runner.start({
      threadId: thread.id,
      profileId: 'test',
      model: 'test:test',
      prompt: 'spawn helper',
    })

    // Let the parent generator drain the scripted events, then fire
    // the lifecycle hook the way the real spawner.onEvent does.
    await new Promise(r => setTimeout(r, 30))
    const SUB_ID = 'sub_helper_42'
    runner.notifyParentLifecycleEvent(thread.id, {
      type: 'agent.spawn',
      agentId: SUB_ID,
      profileName: 'helper',
      parentAgentId: null,
      turnIndex: 0,
    } as LoomEvent)
    runner.notifyParentLifecycleEvent(thread.id, {
      type: 'agent.complete',
      agentId: SUB_ID,
      result: 'helper done',
      durationMs: 250,
      turnIndex: 0,
    } as LoomEvent)

    // Now release the run with a clean turn.end so the assistant row
    // gets saved through the normal reducer path.
    fake.queueAfterHang({
      type: 'turn.end',
      turnIndex: 0,
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, model: 'test', costUsd: 0 },
      timestamp: Date.now(),
    } as LoomEvent)
    await handle.done

    const msgs = state.getMessages(thread.id)
    const asst = msgs.find(m => m.role === 'assistant')
    expect(asst).toBeDefined()

    // subAgents[] now carries the helper, with the spawner-supplied id
    // and the completion result merged in.
    expect(asst!.subAgents).toHaveLength(1)
    expect(asst!.subAgents![0]!.agentId).toBe(SUB_ID)
    expect(asst!.subAgents![0]!.profileName).toBe('helper')
    expect(asst!.subAgents![0]!.status).toBe('completed')
    expect(asst!.subAgents![0]!.result).toBe('helper done')
    expect(asst!.subAgents![0]!.durationMs).toBe(250)

    // parts[] preserves order: text → agent_spawn tool → subagent.
    expect(asst!.parts).toBeDefined()
    const partKinds = asst!.parts!.map(p => p.kind)
    expect(partKinds).toContain('subagent')
    const subPart = asst!.parts!.find(p => p.kind === 'subagent') as { kind: 'subagent'; agentId: string }
    expect(subPart.agentId).toBe(SUB_ID)
    // The subagent part lands AFTER the agent_spawn tool part because
    // the spawner emits agent.spawn after the tool call has started.
    const toolIdx = asst!.parts!.findIndex(p => p.kind === 'tool')
    const subIdx = asst!.parts!.findIndex(p => p.kind === 'subagent')
    expect(subIdx).toBeGreaterThan(toolIdx)
  })

  it('captures sub-agent prompt + task label at tool.call.end (foreground ordering)', async () => {
    // Foreground `agent_spawn` ordering — the real wire order when the
    // parent tool awaits waitForAgent:
    //   tool.call.start → agent.spawn → agent.complete → tool.call.end
    //
    // At tool.call.end, the tool's metadata carries the spawned agentId
    // and acc.toolInputs still has the input (pre-drain). The reducer
    // must pull name+prompt out of the input and patch the matching
    // SubAgentRecord so a refresh-hydrated modal can render the user
    // bubble.
    const thread = state.createThread('test')
    const SUB_ID = 'sub_helper_fg'
    const events: LoomEvent[] = [
      { type: 'turn.start', turnIndex: 0, timestamp: Date.now() },
      { type: 'tool.call.start', turnIndex: 0, toolCallId: 'tc_spawn', toolName: 'agent_spawn', input: { name: 'Research redis', prompt: 'find docs on redis persistence', subagent_type: 'explore' } },
    ]
    const fake = installFakeSession(state, thread.id, events, { hangAtEnd: true })

    const handle = runner.start({
      threadId: thread.id,
      profileId: 'test',
      model: 'test:test',
      prompt: 'delegate',
    })

    // Let the start event drain, then fire the spawner lifecycle hooks.
    await new Promise(r => setTimeout(r, 30))
    runner.notifyParentLifecycleEvent(thread.id, {
      type: 'agent.spawn',
      agentId: SUB_ID,
      profileName: 'explore',
      parentAgentId: null,
      turnIndex: 0,
    } as LoomEvent)
    runner.notifyParentLifecycleEvent(thread.id, {
      type: 'agent.complete',
      agentId: SUB_ID,
      result: 'redis persistence: RDB + AOF',
      durationMs: 120,
      turnIndex: 0,
    } as LoomEvent)

    // Now the parent loop emits tool.call.end with metadata.agentId —
    // this is the point where the reducer must correlate tool input
    // with the spawned record.
    fake.queueAfterHang({
      type: 'tool.call.end',
      turnIndex: 0,
      toolCallId: 'tc_spawn',
      toolName: 'agent_spawn',
      result: 'ok',
      isError: false,
      durationMs: 10,
      metadata: { agentId: SUB_ID, turnCount: 1 },
    } as LoomEvent)
    fake.queueAfterHang({
      type: 'turn.end',
      turnIndex: 0,
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, model: 'test', costUsd: 0 },
      timestamp: Date.now(),
    } as LoomEvent)
    await handle.done

    const msgs = state.getMessages(thread.id)
    const asst = msgs.find(m => m.role === 'assistant')
    expect(asst).toBeDefined()
    expect(asst!.subAgents).toHaveLength(1)
    const sub = asst!.subAgents![0]!
    expect(sub.agentId).toBe(SUB_ID)
    expect(sub.task).toBe('Research redis')
    expect(sub.prompt).toBe('find docs on redis persistence')
    // Status/result from agent.complete still win (spread order preserves them)
    expect(sub.status).toBe('completed')
    expect(sub.result).toBe('redis persistence: RDB + AOF')
  })

  it('captures sub-agent prompt when agent.spawn fires AFTER tool.call.end (background ordering)', async () => {
    // Background mode can put tool.call.end before agent.spawn. The
    // reducer must pre-register the tool input by agentId and then let
    // the agent.spawn handler pick it up when the event finally lands.
    const thread = state.createThread('test')
    const SUB_ID = 'sub_helper_bg'
    const events: LoomEvent[] = [
      { type: 'turn.start', turnIndex: 0, timestamp: Date.now() },
      { type: 'tool.call.start', turnIndex: 0, toolCallId: 'tc_bg', toolName: 'agent_spawn', input: { name: 'Index docs', prompt: 'scan every markdown file', subagent_type: 'indexer' } },
      { type: 'tool.call.end', turnIndex: 0, toolCallId: 'tc_bg', toolName: 'agent_spawn', result: 'launched', isError: false, durationMs: 2, metadata: { agentId: SUB_ID, status: 'launched', background: true } } as LoomEvent,
    ]
    const fake = installFakeSession(state, thread.id, events, { hangAtEnd: true })

    const handle = runner.start({
      threadId: thread.id, profileId: 'test', model: 'test:test', prompt: 'delegate bg',
    })

    // Let the start + end drain so the reducer pre-registers the spawn
    // input by agentId. Only THEN does the helper emit its lifecycle.
    await new Promise(r => setTimeout(r, 30))
    runner.notifyParentLifecycleEvent(thread.id, {
      type: 'agent.spawn',
      agentId: SUB_ID,
      profileName: 'indexer',
      parentAgentId: null,
      turnIndex: 0,
    } as LoomEvent)
    runner.notifyParentLifecycleEvent(thread.id, {
      type: 'agent.complete',
      agentId: SUB_ID,
      result: 'indexed 42 files',
      durationMs: 500,
      turnIndex: 0,
    } as LoomEvent)

    fake.queueAfterHang({
      type: 'turn.end',
      turnIndex: 0,
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, model: 'test', costUsd: 0 },
      timestamp: Date.now(),
    } as LoomEvent)
    await handle.done

    const msgs = state.getMessages(thread.id)
    const asst = msgs.find(m => m.role === 'assistant')!
    expect(asst.subAgents).toHaveLength(1)
    const sub = asst.subAgents![0]!
    expect(sub.agentId).toBe(SUB_ID)
    expect(sub.task).toBe('Index docs')
    expect(sub.prompt).toBe('scan every markdown file')
    expect(sub.status).toBe('completed')
    expect(sub.result).toBe('indexed 42 files')
  })

  it('tool.call.end without metadata.agentId leaves SubAgentRecord untouched', async () => {
    // Defensive: a malformed or failed agent_spawn tool call may emit
    // tool.call.end with no metadata.agentId. The reducer must not
    // throw and must not bind the input to the wrong record.
    const thread = state.createThread('test')
    const SUB_ID = 'sub_no_meta'
    const events: LoomEvent[] = [
      { type: 'turn.start', turnIndex: 0, timestamp: Date.now() },
      { type: 'tool.call.start', turnIndex: 0, toolCallId: 'tc_no_meta', toolName: 'agent_spawn', input: { name: 'lost', prompt: 'will not bind' } },
    ]
    const fake = installFakeSession(state, thread.id, events, { hangAtEnd: true })
    const handle = runner.start({
      threadId: thread.id, profileId: 'test', model: 'test:test', prompt: 'x',
    })
    await new Promise(r => setTimeout(r, 30))
    runner.notifyParentLifecycleEvent(thread.id, {
      type: 'agent.spawn',
      agentId: SUB_ID,
      profileName: 'helper',
      parentAgentId: null,
      turnIndex: 0,
    } as LoomEvent)
    runner.notifyParentLifecycleEvent(thread.id, {
      type: 'agent.complete',
      agentId: SUB_ID,
      result: 'done',
      durationMs: 1,
      turnIndex: 0,
    } as LoomEvent)
    fake.queueAfterHang({
      type: 'tool.call.end',
      turnIndex: 0,
      toolCallId: 'tc_no_meta',
      toolName: 'agent_spawn',
      result: 'err',
      isError: true,
      durationMs: 1,
      // no metadata
    } as LoomEvent)
    fake.queueAfterHang({
      type: 'turn.end',
      turnIndex: 0,
      stopReason: 'end_turn',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, model: 'test', costUsd: 0 },
      timestamp: Date.now(),
    } as LoomEvent)
    await handle.done

    const msgs = state.getMessages(thread.id)
    const asst = msgs.find(m => m.role === 'assistant')!
    const sub = asst.subAgents![0]!
    // prompt/task stay undefined — we refuse to guess the binding
    expect(sub.task).toBeUndefined()
    expect(sub.prompt).toBeUndefined()
  })

  it('late lifecycle events (after run ends) are silently dropped', async () => {
    // Helper completes after the parent already saved its turn.end row.
    // Late events must not throw and must not mutate stale state.
    const thread = state.createThread('test')
    const events: LoomEvent[] = [
      { type: 'turn.start', turnIndex: 0, timestamp: Date.now() },
      { type: 'text.delta', turnIndex: 0, text: 'fire and forget' },
      { type: 'turn.end', turnIndex: 0, stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, model: 'test', costUsd: 0 }, timestamp: Date.now() },
    ]
    installFakeSession(state, thread.id, events)
    const handle = runner.start({
      threadId: thread.id, profileId: 'test', model: 'test:test', prompt: 'go',
    })
    await handle.done

    // Run is finished; lifecycle callback was unregistered.
    expect(() => {
      runner.notifyParentLifecycleEvent(thread.id, {
        type: 'agent.complete',
        agentId: 'sub_late',
        result: 'too late',
        durationMs: 1,
        turnIndex: 0,
      } as LoomEvent)
    }).not.toThrow()

    // Saved row is unchanged.
    const msgs = state.getMessages(thread.id)
    const asst = msgs.find(m => m.role === 'assistant')!
    expect(asst.subAgents).toBeUndefined()
  })

  it('every Loom event type appears in agent_events (raw log is complete)', async () => {
    const thread = state.createThread('test')
    const events = mkTurn(0)
    installFakeSession(state, thread.id, events)

    const handle = runner.start({
      threadId: thread.id,
      profileId: 'test',
      model: 'test:test',
      prompt: 'hi',
    })
    await handle.done

    const raw = state.listAgentEvents({ threadId: thread.id, agentId: 'root' })
    const rawTypes = raw.map(e => e.type)
    // Every event in the scripted stream must be on disk verbatim.
    for (const ev of events) {
      expect(rawTypes).toContain(ev.type)
    }
  })
})
