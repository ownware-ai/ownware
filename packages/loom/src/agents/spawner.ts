/**
 * Agent Spawner
 *
 * Creates and manages sub-agent instances. Each agent gets its own
 * loop() instance with isolated or forked state depending on the
 * spawn mode.
 *
 * @security Each agent gets its own AbortController for proper cancellation.
 * abort() actually kills the running loop — not just a status flag.
 */

import type { LoomConfig } from '../core/config.js'
import type { LoomEvent, AgentSpawnEvent, AgentCompleteEvent, AgentTerminalStatus } from '../core/events.js'
import type { LoopResult } from '../core/loop.js'
import { loop } from '../core/loop.js'
import { createLinkedAbortController } from '../core/abort.js'
import type { Message } from '../messages/types.js'
import { extractText } from '../messages/types.js'
import type { ProviderAdapter } from '../provider/types.js'
import type { Tool } from '../tools/types.js'
import type {
  AgentHandle,
  AgentResult,
  AgentSpec,
  AgentStatus,
  SpawnMode,
} from './types.js'
import { isolateTools, isolateMessages, isolateConfig } from './isolator.js'

// ---------------------------------------------------------------------------
// Spawn options
// ---------------------------------------------------------------------------

export interface SpawnOptions {
  /** Timeout in ms. Agent is auto-aborted after this. Default: none. */
  timeoutMs?: number
}

/**
 * Callback invoked for every event emitted by a non-inline sub-agent.
 *
 * The spawner used to drop all subagent events except `agent.spawn` and
 * `agent.complete`. Consumers that need to persist, stream, or fan-out the
 * full subagent conversation (e.g., the Cortex gateway, a UI client's
 * "View thread" surface) inject this callback to capture every event.
 *
 * Rules:
 * - Called in-order, synchronously with event generation. If the callback
 *   returns a promise, the spawner awaits it before consuming the next
 *   event — back-pressure is the consumer's responsibility (e.g., batch
 *   DB writes, don't block forever).
 * - The `agentId` argument is the sub-agent's handle ID, so the consumer
 *   can tag events by origin without inspecting payload internals.
 * - Exceptions thrown from the callback propagate and abort the subagent
 *   run with the thrown error. Consumers should swallow non-fatal errors
 *   inside the callback.
 */
export type SpawnerEventHook = (
  event: LoomEvent,
  agentId: string,
) => void | Promise<void>

// ---------------------------------------------------------------------------
// Spawner
// ---------------------------------------------------------------------------

export class AgentSpawner {
  private agents = new Map<string, MutableHandle>()
  private provider: ProviderAdapter
  private parentTools: Tool[]
  private parentConfig: LoomConfig
  private onEvent: SpawnerEventHook | undefined

  constructor(opts: {
    provider: ProviderAdapter
    tools: Tool[]
    config: LoomConfig
    /**
     * Optional hook called for every event a non-inline sub-agent emits.
     * Used by Cortex to persist + fan-out subagent events for a client's
     * "View thread" surface. Inline agents deliver events through the
     * generator returned by `getInlineGenerator()` and do NOT call this
     * hook (the consumer already owns the event stream in that mode).
     */
    onEvent?: SpawnerEventHook
  }) {
    this.provider = opts.provider
    this.parentTools = opts.tools
    this.parentConfig = opts.config
    this.onEvent = opts.onEvent
  }

  /**
   * Spawn a sub-agent.
   *
   * Each agent gets its own AbortController so abort() actually stops execution.
   * The loop checks config.abortSignal at every turn boundary.
   *
   * @param spec - What kind of agent to create
   * @param mode - How it relates to the parent
   * @param parentMessages - Current parent messages (for forked mode)
   * @param options - Spawn options (timeout, etc.)
   * @returns Handle to the spawned agent
   */
  async spawn(
    spec: AgentSpec,
    mode: SpawnMode,
    parentMessages?: Message[],
    options?: SpawnOptions,
  ): Promise<AgentHandle> {
    const id = `agent_${crypto.randomUUID().slice(0, 8)}`

    // Each agent gets its own AbortController, LINKED to the parent session's
    // abort signal so a parent "stop" cascades into the sub-agent (R2). Before
    // this it was unlinked (`new AbortController()`), so hitting stop during a
    // foreground sub-agent did nothing — the child ran to its own completion
    // (or was killed only by the 120s agent-tool timeout) and kept spending.
    // `createLinkedAbortController` is a no-op link when the parent has no
    // signal, so non-abortable sessions are unaffected.
    const abortController = createLinkedAbortController(this.parentConfig.abortSignal)

    // Build agent config with the agent's own abort signal
    const agentConfig = buildAgentConfig(spec, this.parentConfig, id, abortController.signal)

    // Resolve tools
    const tools = isolateTools(this.parentTools, spec.tools)

    // Resolve messages based on mode
    const messages = parentMessages ? isolateMessages(parentMessages) : []

    // Create completion promise (resolves when agent finishes)
    let resolveCompletion: () => void
    const completionPromise = new Promise<void>(resolve => { resolveCompletion = resolve })

    // Create handle
    const handle: MutableHandle = {
      id,
      name: spec.name,
      status: 'pending',
      mode,
      startedAt: Date.now(),
      _abortController: abortController,
      _completionPromise: completionPromise,
      _resolveCompletion: resolveCompletion!,
      _collectedEvents: [],
    }
    this.agents.set(id, handle)

    // Set up timeout if specified
    if (options?.timeoutMs) {
      handle._timeoutTimer = setTimeout(() => {
        if (handle.status === 'running' || handle.status === 'pending') {
          handle.error = new Error(`Agent "${spec.name}" timed out after ${options.timeoutMs}ms`)
          this.abort(id)
        }
      }, options.timeoutMs)
    }

    // Run the agent
    if (mode === 'inline') {
      handle.status = 'running'
      handle._generator = this.createGenerator(messages, tools, agentConfig, spec, handle)
    } else {
      handle.status = 'running'
      this.runAgent(messages, tools, agentConfig, spec, handle)
    }

    return toReadonlyHandle(handle)
  }

  /**
   * Get the event generator for an inline agent.
   * Only valid for agents spawned with mode='inline'.
   */
  getInlineGenerator(agentId: string): AsyncGenerator<LoomEvent, AgentResult> | null {
    const handle = this.agents.get(agentId)
    if (!handle || !handle._generator) return null
    return handle._generator
  }

  /** Get a handle by agent ID. */
  getAgent(id: string): AgentHandle | undefined {
    const handle = this.agents.get(id)
    return handle ? toReadonlyHandle(handle) : undefined
  }

  /** Get collected lifecycle events (agent.spawn, agent.complete) for a non-inline agent. */
  getCollectedEvents(id: string): readonly LoomEvent[] {
    const handle = this.agents.get(id)
    return handle ? handle._collectedEvents : []
  }

  /** List all active (non-completed) agents. */
  listActive(): AgentHandle[] {
    return [...this.agents.values()]
      .filter(h => h.status === 'pending' || h.status === 'running')
      .map(toReadonlyHandle)
  }

  /** List all agents. */
  listAll(): AgentHandle[] {
    return [...this.agents.values()].map(toReadonlyHandle)
  }

  /**
   * Abort a running agent.
   *
   * This actually stops the loop — the AbortController signal is checked
   * by the loop at every turn boundary. Any in-flight API call or tool
   * execution will also see the abort signal.
   */
  abort(id: string): void {
    const handle = this.agents.get(id)
    if (!handle) return
    if (handle.status !== 'running' && handle.status !== 'pending') return

    // Signal the loop to stop
    handle._abortController.abort()

    handle.status = 'aborted'
    handle.completedAt = Date.now()

    // Clear timeout if set
    if (handle._timeoutTimer) {
      clearTimeout(handle._timeoutTimer)
      handle._timeoutTimer = undefined
    }

    // Resolve the completion promise so waitForAgent unblocks
    handle._resolveCompletion()
  }

  /**
   * Abort all running agents.
   */
  abortAll(): void {
    for (const [id, handle] of this.agents) {
      if (handle.status === 'running' || handle.status === 'pending') {
        this.abort(id)
      }
    }
  }

  /**
   * Wait for an agent to complete.
   *
   * Uses a Promise — no polling. Resolves when the agent finishes,
   * errors, or is aborted.
   *
   * @param id - Agent ID
   * @param timeoutMs - Optional timeout. Throws if exceeded.
   * @returns The agent's result
   */
  async waitForAgent(id: string, timeoutMs?: number): Promise<AgentResult> {
    const handle = this.agents.get(id)
    if (!handle) throw new Error(`Agent ${id} not found`)

    // Already done?
    if (handle.status === 'completed' && handle.result) return handle.result
    if (handle.status === 'error') throw handle.error ?? new Error(`Agent ${id} failed`)
    if (handle.status === 'aborted') throw new Error(`Agent ${id} was aborted${handle.error ? ': ' + handle.error.message : ''}`)

    // Wait for completion
    if (timeoutMs) {
      const timeout = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`Timed out waiting for agent ${id} after ${timeoutMs}ms`)), timeoutMs)
      })
      await Promise.race([handle._completionPromise, timeout])
    } else {
      await handle._completionPromise
    }

    // Check final status (cast needed — TS narrows after early returns above,
    // but the await can change status to any AgentStatus)
    const finalStatus = handle.status as AgentStatus
    if (finalStatus === 'completed' && handle.result) return handle.result
    if (finalStatus === 'error') throw handle.error ?? new Error(`Agent ${id} failed`)
    throw new Error(`Agent ${id} was aborted${handle.error ? ': ' + handle.error.message : ''}`)
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private async runAgent(
    messages: Message[],
    tools: Tool[],
    config: LoomConfig,
    spec: AgentSpec,
    handle: MutableHandle,
  ): Promise<void> {
    // Reliability invariant: every non-inline worker emits EXACTLY ONE terminal
    // agent.complete (success OR error OR abort). createGenerator emits it on the
    // success path; on error/abort it throws before that yield, so we synthesize
    // one in `finally`. A UI must never show a worker stuck "running" forever.
    let terminalEmitted = false
    try {
      const gen = this.createGenerator(messages, tools, config, spec, handle)
      let iter = await gen.next()
      while (!iter.done) {
        const event = iter.value

        // Always retain lifecycle events on the handle so legacy consumers
        // (getCollectedEvents) keep working.
        if (event.type === 'agent.spawn' || event.type === 'agent.complete') {
          handle._collectedEvents.push(event)
        }
        if (event.type === 'agent.complete') terminalEmitted = true

        // Forward EVERY event to the optional hook — this is what lets
        // Cortex persist the full subagent conversation and stream it
        // live to a client's "View thread" surface. The hook is awaited so
        // slow consumers apply natural back-pressure instead of dropping.
        if (this.onEvent) {
          await this.onEvent(event, handle.id)
        }

        iter = await gen.next()
      }
      // Only set completed if not already aborted
      if (handle.status === 'running') {
        handle.result = iter.value
        handle.status = 'completed'
        handle.completedAt = Date.now()
      }
    } catch (error) {
      if (handle.status === 'running') {
        handle.status = 'error'
        handle.error = error instanceof Error ? error : new Error(String(error))
        handle.completedAt = Date.now()
      }
    } finally {
      // Terminal guarantee: if the success-path agent.complete never fired
      // (error/abort threw first), synthesize one now so the worker always
      // reaches a terminal state in the event stream.
      if (!terminalEmitted) {
        const status: AgentTerminalStatus = handle.status === 'aborted' ? 'aborted' : 'error'
        const terminal: AgentCompleteEvent = {
          type: 'agent.complete',
          agentId: handle.id,
          result: handle.result?.content ?? '',
          durationMs: Date.now() - handle.startedAt,
          turnIndex: handle.result?.turnCount ?? 0,
          status,
          turnCount: handle.result?.turnCount ?? 0,
          ...(handle.error ? { error: handle.error.message } : {}),
        }
        handle._collectedEvents.push(terminal)
        if (this.onEvent) {
          // A failure delivering the terminal must not mask the original error
          // or leave the worker hung — swallow it (the run is already ending).
          try { await this.onEvent(terminal as LoomEvent, handle.id) } catch { /* terminal emit is best-effort */ }
        }
      }
      // Clear timeout
      if (handle._timeoutTimer) {
        clearTimeout(handle._timeoutTimer)
        handle._timeoutTimer = undefined
      }
      // Signal completion
      handle._resolveCompletion()
    }
  }

  private async *createGenerator(
    messages: Message[],
    tools: Tool[],
    config: LoomConfig,
    spec: AgentSpec,
    handle: MutableHandle,
  ): AsyncGenerator<LoomEvent, AgentResult> {
    const systemPrompt = spec.systemPrompt ?? config.systemPrompt

    // Emit agent.spawn event into the event stream
    const spawnEvent: AgentSpawnEvent = {
      type: 'agent.spawn',
      agentId: handle.id,
      profileName: spec.profileName ?? spec.name,
      parentAgentId: config.agentId ?? null,
      turnIndex: 0,
      name: handle.name,
      model: config.model,
      task: digestTask(messages, spec),
    }
    yield spawnEvent as LoomEvent

    const startTime = Date.now()

    const loopResult: LoopResult = yield* loop({
      messages,
      systemPrompt,
      provider: this.provider,
      tools,
      config,
      compaction: null,
      checkpoint: null,
      checkPermission: async () => 'allow',
      requestApproval: async () => true,
      ...(spec.persistentReminder && spec.persistentReminder.trim().length > 0
        ? { persistentReminder: spec.persistentReminder }
        : {}),
    })

    // Extract text from the sub-agent's messages. Try (in order):
    // 1. Last assistant message with text blocks
    // 2. Any assistant message with text blocks (scan all, last first)
    // 3. Last tool_result message content (sub-agent ended on tool use)
    // 4. Empty string (sub-agent produced no readable output)
    let content = ''
    const reversed = [...loopResult.messages].reverse()
    for (const msg of reversed) {
      if (msg.role === 'assistant') {
        const text = extractText(msg)
        if (text) { content = text; break }
      }
    }
    if (!content) {
      // Fallback: scan ALL assistant messages for any text (not just last).
      // Sub-agents with tools may end on a tool-use turn, but an earlier
      // assistant turn may have produced a text summary.
      for (const msg of loopResult.messages) {
        if (msg.role === 'assistant') {
          const text = extractText(msg)
          if (text) { content = text }
          // Don't break — keep going to find the LATEST text
        }
      }
    }
    if (!content) {
      // Last resort: summarize from tool results if no text at all.
      // The sub-agent ran tools but never produced text output.
      // Concatenate the last few tool_result block contents.
      const toolResults: string[] = []
      for (const msg of reversed) {
        if (msg.role === 'user' && Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if ('type' in block && block.type === 'tool_result' && typeof (block as any).content === 'string') {
              toolResults.push((block as any).content)
            }
          }
          if (toolResults.length > 0) break
        }
      }
      if (toolResults.length > 0) {
        content = toolResults.join('\n').slice(0, 4000)
      }
    }

    const result: AgentResult = {
      content,
      usage: loopResult.totalUsage,
      turnCount: loopResult.turnCount,
    }

    handle.result = result
    if (handle.status === 'running') {
      handle.status = 'completed'
      handle.completedAt = Date.now()
    }

    // Emit agent.complete into the event stream. Status reflects the ACTUAL
    // handle state: the loop can unwind gracefully after an abort (status set
    // to 'aborted' by abort()), in which case this terminal must say 'aborted',
    // not a hardcoded 'completed'.
    const termStatus: AgentTerminalStatus =
      handle.status === 'error' ? 'error' : handle.status === 'aborted' ? 'aborted' : 'completed'
    const completeEvent: AgentCompleteEvent = {
      type: 'agent.complete',
      agentId: handle.id,
      result: content,
      durationMs: Date.now() - startTime,
      turnIndex: loopResult.turnCount,
      status: termStatus,
      usage: loopResult.totalUsage,
      turnCount: loopResult.turnCount,
    }
    yield completeEvent as LoomEvent

    return result
  }
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

/**
 * Short, human-readable digest of a worker's task for UI row labels — the last
 * user message (when it's plain text), else the system prompt, else the name.
 * Pure, ≤120 chars, whitespace-collapsed.
 */
function digestTask(messages: Message[], spec: AgentSpec): string {
  const lastUser = [...messages].reverse().find(m => m.role === 'user')
  const raw =
    lastUser && typeof lastUser.content === 'string' && lastUser.content.trim().length > 0
      ? lastUser.content
      : spec.systemPrompt ?? spec.name
  const clean = raw.replace(/\s+/g, ' ').trim()
  return clean.length > 120 ? `${clean.slice(0, 119)}…` : clean
}

function buildAgentConfig(
  spec: AgentSpec,
  parentConfig: LoomConfig,
  agentId: string,
  abortSignal: AbortSignal,
): LoomConfig {
  const overrides: Partial<LoomConfig> = {
    agentId,
    sessionId: `${parentConfig.sessionId}:${agentId}`,
    rootSessionId: parentConfig.rootSessionId ?? parentConfig.sessionId,
    abortSignal,
    ...(spec.model ? { model: spec.model } : {}),
    ...(spec.maxTurns !== undefined ? { maxTurns: spec.maxTurns } : {}),
    ...(spec.systemPrompt ? { systemPrompt: spec.systemPrompt } : {}),
  }

  return isolateConfig(parentConfig, overrides)
}

// ---------------------------------------------------------------------------
// Internal handle type (mutable)
// ---------------------------------------------------------------------------

interface MutableHandle {
  id: string
  name: string
  status: AgentStatus
  mode: SpawnMode
  result?: AgentResult
  error?: Error
  startedAt: number
  completedAt?: number
  _generator?: AsyncGenerator<LoomEvent, AgentResult>
  _abortController: AbortController
  _completionPromise: Promise<void>
  _resolveCompletion: () => void
  _timeoutTimer?: ReturnType<typeof setTimeout>
  _collectedEvents: LoomEvent[]
}

function toReadonlyHandle(h: MutableHandle): AgentHandle {
  return {
    id: h.id,
    name: h.name,
    status: h.status,
    mode: h.mode,
    result: h.result,
    error: h.error,
    startedAt: h.startedAt,
    completedAt: h.completedAt,
  }
}
