/**
 * Human-In-The-Loop (HITL) Approval System
 *
 * Bridges the agent loop with an external approval UI (TUI, web, etc.)
 * using an event emitter pattern. When a tool call requires approval,
 * the loop emits 'approval_needed' and waits for a response.
 */

import { EventEmitter } from 'node:events'
import type { ToolCall } from '../tools/types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The payload emitted when approval is needed. */
export interface ApprovalRequest {
  /** Unique request ID (matches the tool call ID) */
  readonly requestId: string
  /** The tool call awaiting approval */
  readonly toolCall: ToolCall
  /** Human-readable reason for the request */
  readonly reason: string
  /** When the request was created */
  readonly timestamp: number
}

/** The payload emitted when approval is resolved. */
export interface ApprovalResponse {
  /** Matches the request ID */
  readonly requestId: string
  /** Whether the action was approved */
  readonly approved: boolean
}

// ---------------------------------------------------------------------------
// HITL events
// ---------------------------------------------------------------------------

export type HitlEvents = {
  /** Emitted when a tool call needs human approval. */
  approval_needed: [request: ApprovalRequest]
  /** Emitted when an approval response is received. */
  approval_response: [response: ApprovalResponse]
}

// ---------------------------------------------------------------------------
// HumanInTheLoop
// ---------------------------------------------------------------------------

/** Default approval timeout: 5 minutes */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

export class HumanInTheLoop {
  private emitter = new EventEmitter()
  private timeoutMs: number
  private hasHandler = false
  private pendingRequests = new Map<string, {
    resolve: (approved: boolean) => void
    timer: ReturnType<typeof setTimeout>
  }>()

  constructor(opts?: { timeoutMs?: number }) {
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /**
   * Register an approval handler.
   *
   * The handler receives ApprovalRequest events and must call
   * respond() with the decision. Only one handler should be
   * registered at a time.
   *
   * @param handler - Callback invoked when approval is needed
   */
  onApprovalNeeded(handler: (request: ApprovalRequest) => void): void {
    this.hasHandler = true
    this.emitter.on('approval_needed', handler)
  }

  /**
   * Remove the approval handler.
   */
  removeHandler(): void {
    this.emitter.removeAllListeners('approval_needed')
    this.hasHandler = false
  }

  /**
   * Request approval for a tool call.
   *
   * If no handler is registered, defaults to deny.
   * If no response is received within the timeout, defaults to deny.
   *
   * @param toolCall - The tool call to approve
   * @param reason - Why approval is needed
   * @returns Whether the tool call was approved
   */
  async requestApproval(
    toolCall: ToolCall,
    reason = 'Tool requires explicit approval',
  ): Promise<boolean> {
    // No handler registered — default to deny
    if (!this.hasHandler) {
      return false
    }

    const requestId = toolCall.id
    const request: ApprovalRequest = {
      requestId,
      toolCall,
      reason,
      timestamp: Date.now(),
    }

    return new Promise<boolean>((resolve) => {
      // Set up timeout — deny if no response
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId)
        resolve(false)
      }, this.timeoutMs)

      this.pendingRequests.set(requestId, { resolve, timer })

      // Emit the request
      this.emitter.emit('approval_needed', request)
    })
  }

  /**
   * Submit an approval response.
   *
   * Called by the UI layer (TUI, web) to resolve a pending request.
   *
   * @param requestId - The request to respond to
   * @param approved - Whether to allow the action
   */
  respond(requestId: string, approved: boolean): boolean {
    const pending = this.pendingRequests.get(requestId)
    if (!pending) return false

    clearTimeout(pending.timer)
    this.pendingRequests.delete(requestId)
    pending.resolve(approved)

    this.emitter.emit('approval_response', { requestId, approved })
    return true
  }

  /** True only while this exact request can still be decided. */
  hasPending(requestId: string): boolean {
    return this.pendingRequests.has(requestId)
  }

  /**
   * Approve all pending requests.
   * Useful for "trust this agent" UX patterns.
   */
  approveAll(): void {
    for (const [requestId, pending] of this.pendingRequests) {
      clearTimeout(pending.timer)
      pending.resolve(true)
      this.emitter.emit('approval_response', { requestId, approved: true })
    }
    this.pendingRequests.clear()
  }

  /**
   * Deny all pending requests.
   * Useful for abort/cancel patterns.
   */
  denyAll(): void {
    for (const [requestId, pending] of this.pendingRequests) {
      clearTimeout(pending.timer)
      pending.resolve(false)
      this.emitter.emit('approval_response', { requestId, approved: false })
    }
    this.pendingRequests.clear()
  }

  /** Number of requests currently awaiting approval. */
  get pendingCount(): number {
    return this.pendingRequests.size
  }

  /** Clean up all timers and listeners. */
  dispose(): void {
    this.denyAll()
    this.emitter.removeAllListeners()
    this.hasHandler = false
  }
}
