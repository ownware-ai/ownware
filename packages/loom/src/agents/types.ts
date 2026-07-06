/**
 * Agent System Types
 *
 * Defines the contracts for multi-agent orchestration in Loom.
 * Agents can be spawned in isolation, forked from a parent, or
 * run inline within the parent's event stream.
 */

import type { TurnUsage } from '../core/events.js'

// ---------------------------------------------------------------------------
// Agent specification
// ---------------------------------------------------------------------------

/**
 * Describes an agent to spawn.
 *
 * This is the input to the spawner — it says what kind of agent
 * to create, with what capabilities and constraints.
 */
export interface AgentSpec {
  /** Human-readable agent name */
  readonly name: string
  /** Profile name to load (from profiles/ directory) */
  readonly profileName?: string
  /** System prompt override (used if no profileName, or as addition) */
  readonly systemPrompt?: string
  /** Model override (null = inherit from parent) */
  readonly model?: string
  /** Tool names this agent can access (null = inherit all) */
  readonly tools?: string[]
  /** Maximum turns before the agent stops */
  readonly maxTurns?: number
  /**
   * Optional persistent reminder. When set, the spawned agent's
   * Session injects this string as a `<system-reminder>` on every
   * outgoing user-side message. Domain-neutral mechanism — content
   * comes from the profile, not the engine.
   */
  readonly persistentReminder?: string
}

// ---------------------------------------------------------------------------
// Spawn modes
// ---------------------------------------------------------------------------

/**
 * How a sub-agent relates to its parent.
 *
 * - 'isolated': Fresh context — no shared history, own tools.
 *   Good for independent tasks.
 *
 * - 'forked': Snapshot of parent messages at spawn time, then
 *   independent. Good for parallel exploration of the same context.
 *
 * - 'inline': Events flow through the parent's event stream.
 *   Good for delegation without losing observability.
 */
export type SpawnMode = 'isolated' | 'forked' | 'inline'

// ---------------------------------------------------------------------------
// Agent handle (returned by spawner)
// ---------------------------------------------------------------------------

/**
 * A handle to a running or completed agent.
 * Used to track status and retrieve results.
 */
export interface AgentHandle {
  /** Unique agent identifier */
  readonly id: string
  /** Human-readable name */
  readonly name: string
  /** Current status */
  readonly status: AgentStatus
  /** Spawn mode this agent was created with */
  readonly mode: SpawnMode
  /** Result (available when status is 'completed') */
  readonly result?: AgentResult
  /** Error (available when status is 'error') */
  readonly error?: Error
  /** When the agent was spawned (ms since epoch) */
  readonly startedAt: number
  /** When the agent finished (ms since epoch, undefined if still running) */
  readonly completedAt?: number
}

export type AgentStatus = 'pending' | 'running' | 'completed' | 'error' | 'aborted'

// ---------------------------------------------------------------------------
// Agent result
// ---------------------------------------------------------------------------

/**
 * The final result of an agent's execution.
 */
export interface AgentResult {
  /** The agent's final text output */
  readonly content: string
  /** Token usage across all turns */
  readonly usage: TurnUsage
  /** Number of turns the agent ran */
  readonly turnCount: number
}

// ---------------------------------------------------------------------------
// Inter-agent messages
// ---------------------------------------------------------------------------

/**
 * A message sent between agents via AgentChannel.
 */
export interface AgentMessage {
  /** Sender agent ID */
  readonly from: string
  /** Recipient agent ID */
  readonly to: string
  /** Message content */
  readonly content: string
  /** Optional structured payload */
  readonly payload?: Record<string, unknown>
  /** When the message was sent */
  readonly timestamp: number
}
