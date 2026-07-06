/**
 * Agent Communication Protocol
 *
 * In-process message channels for inter-agent communication.
 * Each agent gets a channel identified by its agent ID.
 * Messages are queued and delivered via AsyncGenerator.
 */

import type { AgentMessage } from './types.js'

// ---------------------------------------------------------------------------
// Channel
// ---------------------------------------------------------------------------

/**
 * A bidirectional message channel for inter-agent communication.
 *
 * Uses an in-process queue (Map of arrays) with AsyncGenerator-based
 * consumption. Messages are held until the recipient reads them.
 */
export class AgentChannel {
  /** Queued messages per agent ID */
  private queues = new Map<string, AgentMessage[]>()
  /** Waiters: agents blocked on receive(), waiting for a message */
  private waiters = new Map<string, Array<(msg: AgentMessage) => void>>()
  /** Whether the channel has been closed */
  private closed = false

  /**
   * Send a message to another agent.
   *
   * If the recipient is waiting (blocked on receive), the message
   * is delivered immediately. Otherwise it's queued.
   *
   * @param from - Sender agent ID
   * @param to - Recipient agent ID
   * @param content - Text content of the message
   * @param payload - Optional structured data
   */
  send(
    from: string,
    to: string,
    content: string,
    payload?: Record<string, unknown>,
  ): void {
    if (this.closed) {
      throw new Error('Channel is closed')
    }

    const message: AgentMessage = {
      from,
      to,
      content,
      payload,
      timestamp: Date.now(),
    }

    // Check if recipient is waiting
    const recipientWaiters = this.waiters.get(to)
    if (recipientWaiters && recipientWaiters.length > 0) {
      const resolve = recipientWaiters.shift()!
      if (recipientWaiters.length === 0) {
        this.waiters.delete(to)
      }
      resolve(message)
      return
    }

    // Queue the message
    let queue = this.queues.get(to)
    if (!queue) {
      queue = []
      this.queues.set(to, queue)
    }
    queue.push(message)
  }

  /**
   * Receive messages for an agent.
   *
   * Yields messages as they arrive. If no messages are queued,
   * blocks until one is sent. Completes when the channel is closed.
   *
   * @param agentId - The agent receiving messages
   */
  async *receive(agentId: string): AsyncGenerator<AgentMessage> {
    while (!this.closed) {
      // Drain queued messages first
      const queue = this.queues.get(agentId)
      if (queue && queue.length > 0) {
        while (queue.length > 0) {
          yield queue.shift()!
        }
        this.queues.delete(agentId)
        continue
      }

      // Wait for the next message
      const message = await this.waitForMessage(agentId)
      if (message === null) {
        // Channel was closed
        return
      }
      yield message
    }

    // Drain any remaining messages after close
    const remaining = this.queues.get(agentId)
    if (remaining) {
      for (const msg of remaining) {
        yield msg
      }
      this.queues.delete(agentId)
    }
  }

  /**
   * Get the number of queued messages for an agent.
   */
  pending(agentId: string): number {
    return this.queues.get(agentId)?.length ?? 0
  }

  /**
   * Close the channel.
   * All pending receive() calls will complete.
   */
  close(): void {
    this.closed = true

    // Resolve all waiters with null to signal close
    for (const [, waiters] of this.waiters) {
      for (const resolve of waiters) {
        resolve(null as unknown as AgentMessage)
      }
    }
    this.waiters.clear()
  }

  /**
   * Whether the channel is closed.
   */
  get isClosed(): boolean {
    return this.closed
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private waitForMessage(agentId: string): Promise<AgentMessage | null> {
    if (this.closed) return Promise.resolve(null)

    return new Promise<AgentMessage | null>((resolve) => {
      let waiters = this.waiters.get(agentId)
      if (!waiters) {
        waiters = []
        this.waiters.set(agentId, waiters)
      }
      waiters.push((msg: AgentMessage) => {
        resolve(msg ?? null)
      })
    })
  }
}

// ---------------------------------------------------------------------------
// Convenience: create a channel hub for a set of agents
// ---------------------------------------------------------------------------

/**
 * Create a shared channel for multiple agents.
 *
 * @param agentIds - IDs of agents that will communicate
 * @returns A shared AgentChannel instance
 */
export function createChannelHub(agentIds: string[]): AgentChannel {
  // The channel itself is agent-agnostic — this is a convenience
  // that documents which agents are expected to use it.
  void agentIds
  return new AgentChannel()
}
