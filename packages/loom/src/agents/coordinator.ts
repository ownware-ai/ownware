/**
 * Agent Coordinator
 *
 * Higher-level orchestration patterns for multi-agent workflows:
 * - fanOut: spawn multiple agents in parallel, gather results
 * - pipeline: chain agents sequentially, output -> input
 * - mapReduce: parallel map then sequential reduce
 *
 * All patterns support timeout and proper abort propagation.
 */

import type { LoomConfig } from '../core/config.js'
import type { Message } from '../messages/types.js'
import type { ProviderAdapter } from '../provider/types.js'
import type { Tool } from '../tools/types.js'
import type { AgentResult, AgentSpec } from './types.js'
import { AgentSpawner, type SpawnOptions, type SpawnerEventHook } from './spawner.js'

// ---------------------------------------------------------------------------
// Options shared by all coordination patterns
// ---------------------------------------------------------------------------

export interface CoordinationOptions {
  provider: ProviderAdapter
  tools: Tool[]
  config: LoomConfig
  parentMessages?: Message[]
  /** Timeout per agent in ms. Agents auto-abort after this. */
  agentTimeoutMs?: number
  /** Timeout for the entire coordination operation in ms. */
  overallTimeoutMs?: number
  /**
   * Optional per-worker event hook. Fires for EVERY sub-agent event, tagged
   * with the worker's `agentId` — the live feed a fan-out/pipeline UI renders
   * from (spawn → tool.call.start → turn.end → terminal). Omit it and the
   * patterns behave exactly as before (results-only).
   */
  onEvent?: SpawnerEventHook
}

// ---------------------------------------------------------------------------
// Fan-out: parallel agents
// ---------------------------------------------------------------------------

/**
 * Spawn multiple agents in parallel, wait for all to complete.
 *
 * Each agent runs in isolated mode with its own context.
 * Returns results in the same order as the input specs.
 * If any agent fails, the error is thrown after aborting remaining agents.
 *
 * @param specs - Agent specifications to run in parallel
 * @param opts - Provider, tools, config, timeouts, and optional parent messages
 * @returns Array of results (one per spec, same order)
 */
export async function fanOut(
  specs: AgentSpec[],
  opts: CoordinationOptions,
): Promise<AgentResult[]> {
  const spawner = new AgentSpawner({
    provider: opts.provider,
    tools: opts.tools,
    config: opts.config,
    ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
  })

  const spawnOptions: SpawnOptions | undefined = opts.agentTimeoutMs
    ? { timeoutMs: opts.agentTimeoutMs }
    : undefined

  // Spawn all agents in parallel
  const handles = await Promise.all(
    specs.map(spec => spawner.spawn(spec, 'isolated', opts.parentMessages, spawnOptions)),
  )

  // Set up overall timeout
  let overallTimer: ReturnType<typeof setTimeout> | undefined
  if (opts.overallTimeoutMs) {
    overallTimer = setTimeout(() => {
      spawner.abortAll()
    }, opts.overallTimeoutMs)
  }

  try {
    // Wait for all agents using Promise-based waiting (no polling)
    const results = await Promise.all(
      handles.map(handle => spawner.waitForAgent(handle.id)),
    )
    return results
  } catch (error) {
    // If any agent fails, abort the rest
    spawner.abortAll()
    throw error
  } finally {
    if (overallTimer) clearTimeout(overallTimer)
  }
}

// ---------------------------------------------------------------------------
// Pipeline: sequential agents
// ---------------------------------------------------------------------------

/**
 * Run agents sequentially — the output of agent N becomes the input of agent N+1.
 *
 * The first agent receives `input` as its prompt.
 * Each subsequent agent receives the previous agent's text output as its prompt.
 *
 * @param specs - Agent specifications to run in sequence
 * @param input - Initial input for the first agent
 * @param opts - Provider, tools, config, and timeouts
 * @returns Final result from the last agent in the pipeline
 */
export async function pipeline(
  specs: AgentSpec[],
  input: string,
  opts: CoordinationOptions,
): Promise<AgentResult> {
  let currentInput = input

  let lastResult: AgentResult = {
    content: '',
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      model: opts.config.model,
      costUsd: 0,
    },
    turnCount: 0,
  }

  const spawnOptions: SpawnOptions | undefined = opts.agentTimeoutMs
    ? { timeoutMs: opts.agentTimeoutMs }
    : undefined

  for (const spec of specs) {
    const spawner = new AgentSpawner({
      provider: opts.provider,
      tools: opts.tools,
      config: opts.config,
      ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
    })

    const messages: Message[] = [
      { role: 'user', content: currentInput },
    ]

    const handle = await spawner.spawn(spec, 'isolated', messages, spawnOptions)
    const result = await spawner.waitForAgent(handle.id)

    currentInput = result.content
    lastResult = result
  }

  return lastResult
}

// ---------------------------------------------------------------------------
// Map-reduce: fan-out then combine
// ---------------------------------------------------------------------------

/**
 * Fan-out across agents, then reduce their outputs using a final agent.
 *
 * @param mapSpecs - Agent specs to run in parallel
 * @param reduceSpec - Agent spec that combines the parallel results
 * @param opts - Provider, tools, config, timeouts, and optional parent messages
 * @returns Result from the reduce agent
 */
export async function mapReduce(
  mapSpecs: AgentSpec[],
  reduceSpec: AgentSpec,
  opts: CoordinationOptions,
): Promise<AgentResult> {
  // Fan out
  const mapResults = await fanOut(mapSpecs, opts)

  // Combine results into a prompt for the reduce agent
  const combinedInput = mapResults
    .map((r, i) => `--- Result from ${mapSpecs[i]!.name} ---\n${r.content}`)
    .join('\n\n')

  // Run reduce agent
  return pipeline([reduceSpec], combinedInput, opts)
}
