/**
 * Session Forker
 *
 * Creates a child session that shares history with its parent
 * at a specific point in time, then diverges independently.
 * Useful for parallel exploration of the same context.
 */

import type { LoomConfig } from '../core/config.js'
import type { Message } from '../messages/types.js'
import type { Tool } from '../tools/types.js'
import type { ProviderAdapter } from '../provider/types.js'
import { Session } from '../core/session.js'
import type { AgentSpec } from './types.js'
import { isolateTools, isolateMessages, isolateConfig } from './isolator.js'

// ---------------------------------------------------------------------------
// Fork point tracking
// ---------------------------------------------------------------------------

/**
 * Metadata about a fork point.
 * Tracks where the child diverged from the parent, enabling
 * later diffing of what the child added.
 */
export interface ForkPoint {
  /** ID of the parent session */
  readonly parentSessionId: string
  /** ID of the child session */
  readonly childSessionId: string
  /** Number of messages at fork time */
  readonly messageCount: number
  /** Turn index at fork time */
  readonly turnIndex: number
  /** When the fork was created */
  readonly timestamp: number
}

// ---------------------------------------------------------------------------
// Fork session
// ---------------------------------------------------------------------------

/**
 * Fork a session from the parent's current state.
 *
 * The child gets:
 * - A deep copy of the parent's messages (shared history)
 * - Filtered tools based on the agent spec
 * - An independent config (with overrides from spec)
 *
 * The parent is NOT modified.
 *
 * @param parentSession - The parent session to fork from
 * @param spec - Agent spec with overrides
 * @param provider - Provider adapter to use
 * @param parentTools - Parent's tool set
 * @param parentConfig - Parent's config
 * @returns The forked child session and fork point metadata
 */
export function forkSession(
  parentSession: {
    sessionId: string
    getMessages(): readonly Message[]
  },
  spec: AgentSpec,
  provider: ProviderAdapter,
  parentTools: Tool[],
  parentConfig: LoomConfig,
): { session: Session; forkPoint: ForkPoint } {
  const parentMessages = parentSession.getMessages()

  // Deep copy messages so child is independent
  const childMessages = isolateMessages([...parentMessages])

  // Filter tools based on spec
  const childTools = isolateTools(parentTools, spec.tools)

  // Build child config
  const childId = `fork_${crypto.randomUUID().slice(0, 8)}`
  const childConfig = isolateConfig(parentConfig, {
    agentId: childId,
    sessionId: `${parentConfig.sessionId}:${childId}`,
    rootSessionId: parentConfig.rootSessionId ?? parentConfig.sessionId,
    ...(spec.model && { model: spec.model }),
    ...(spec.maxTurns !== undefined && { maxTurns: spec.maxTurns }),
    ...(spec.systemPrompt && { systemPrompt: spec.systemPrompt }),
  })

  // Create child session
  const session = new Session({
    config: childConfig,
    provider,
    tools: childTools,
    initialMessages: childMessages,
  })

  // Record fork point
  const forkPoint: ForkPoint = {
    parentSessionId: parentSession.sessionId,
    childSessionId: childConfig.sessionId,
    messageCount: parentMessages.length,
    turnIndex: Math.floor(parentMessages.length / 2), // approximate
    timestamp: Date.now(),
  }

  return { session, forkPoint }
}

// ---------------------------------------------------------------------------
// Fork diffing
// ---------------------------------------------------------------------------

/**
 * Get messages that the child added after the fork point.
 *
 * @param childSession - The forked child session
 * @param forkPoint - Fork point metadata
 * @returns Messages added by the child after fork
 */
export function getChildAdditions(
  childSession: { getMessages(): readonly Message[] },
  forkPoint: ForkPoint,
): readonly Message[] {
  const allMessages = childSession.getMessages()
  return allMessages.slice(forkPoint.messageCount)
}

/**
 * Get the final text output from a forked session.
 *
 * Extracts text from all assistant messages added after the fork point.
 *
 * @param childSession - The forked child session
 * @param forkPoint - Fork point metadata
 * @returns Concatenated text from child's assistant messages
 */
export function getChildOutput(
  childSession: { getMessages(): readonly Message[] },
  forkPoint: ForkPoint,
): string {
  const additions = getChildAdditions(childSession, forkPoint)
  const texts: string[] = []

  for (const msg of additions) {
    if (msg.role !== 'assistant') continue
    for (const block of msg.content) {
      if (block.type === 'text') {
        texts.push(block.text)
      }
    }
  }

  return texts.join('\n')
}
