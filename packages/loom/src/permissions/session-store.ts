/**
 * Session Permission Store
 *
 * Remembers permission decisions for the duration of a session.
 * Supports "always allow/deny X for this session" patterns.
 *
 * Decisions are stored in memory and cleared when the session ends.
 */

import type { PolicyDecision } from './types.js'

// ---------------------------------------------------------------------------
// Session store
// ---------------------------------------------------------------------------

export class SessionPermissionStore {
  /** Map of tool name -> remembered decision */
  private decisions = new Map<string, PolicyDecision>()

  /**
   * Remember a permission decision for a tool.
   *
   * This persists for the lifetime of this store instance
   * (typically one session).
   *
   * @param toolName - The tool to remember a decision for
   * @param decision - The decision to remember
   */
  remember(toolName: string, decision: PolicyDecision): void {
    this.decisions.set(toolName, decision)
  }

  /**
   * Check if there's a remembered decision for a tool.
   *
   * @param toolName - The tool to check
   * @returns The remembered decision, or null if none
   */
  check(toolName: string): PolicyDecision | null {
    return this.decisions.get(toolName) ?? null
  }

  /**
   * Remove a remembered decision for a tool.
   *
   * @param toolName - The tool to forget
   */
  forget(toolName: string): void {
    this.decisions.delete(toolName)
  }

  /** Clear all remembered decisions. */
  clear(): void {
    this.decisions.clear()
  }

  /** Number of remembered decisions. */
  get size(): number {
    return this.decisions.size
  }

  /** Get all remembered decisions (read-only). */
  entries(): ReadonlyMap<string, PolicyDecision> {
    return this.decisions
  }
}
