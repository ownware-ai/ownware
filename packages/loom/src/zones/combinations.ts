/**
 * Zone Security System — Combination Detection
 *
 * Tracks recent tool calls in a sliding window and detects
 * dangerous cross-zone combinations.
 *
 * Example: Reading .env (Zone 0) + network fetch (Zone 3) = data exfiltration.
 * Each individual action is safe, but the COMBINATION is dangerous.
 *
 * @security Novel feature — no other agent framework has this.
 * Uses declarative rules (serializable, auditable, testable).
 */

import type {
  CombinationBlockReason,
  CombinationRule,
  CombinationToolEntry,
  CombinationTrigger,
  ZoneLevel,
} from './types.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_WINDOW_MS = 60_000
const DEFAULT_MAX_HISTORY = 100

// ---------------------------------------------------------------------------
// Trigger matching
// ---------------------------------------------------------------------------

/**
 * Check if a tool entry matches a trigger condition.
 */
function matchesTrigger(
  entry: { toolName: string; zone: ZoneLevel; input?: Readonly<Record<string, unknown>> },
  trigger: CombinationTrigger,
): boolean {
  // Zone match
  if (trigger.zone !== undefined && entry.zone < trigger.zone) {
    return false
  }

  // Tool pattern match (simple glob: * matches anything)
  if (trigger.toolPattern !== undefined) {
    const pattern = trigger.toolPattern
    if (pattern !== '*') {
      if (pattern.includes('*')) {
        const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$')
        if (!regex.test(entry.toolName)) return false
      } else {
        if (entry.toolName !== pattern) return false
      }
    }
  }

  // Input pattern match
  if (trigger.inputPattern !== undefined && entry.input) {
    const serialized = JSON.stringify(entry.input)
    if (!trigger.inputPattern.test(serialized)) return false
  }

  return true
}

// ---------------------------------------------------------------------------
// CombinationTracker
// ---------------------------------------------------------------------------

/**
 * Sliding window tracker for cross-zone combination detection.
 *
 * Records tool calls with their zone classification and checks
 * if the current + recent calls trigger any combination rules.
 */
export class CombinationTracker {
  private readonly history: Array<CombinationToolEntry & { input?: Readonly<Record<string, unknown>> }> = []
  private readonly maxHistory: number

  constructor(maxHistory = DEFAULT_MAX_HISTORY) {
    this.maxHistory = maxHistory
  }

  /**
   * Record a tool call in the history.
   *
   * @param toolName - Tool that was called
   * @param zone - Zone level it was classified as
   * @param input - Tool input (for input pattern matching)
   */
  record(
    toolName: string,
    zone: ZoneLevel,
    input?: Readonly<Record<string, unknown>>,
  ): void {
    this.history.push({
      toolName,
      zone,
      timestamp: Date.now(),
      tags: [],
      input,
    })

    // Evict oldest entries if over limit
    while (this.history.length > this.maxHistory) {
      this.history.shift()
    }
  }

  /**
   * Check if the current tool call + recent history triggers any combination rule.
   *
   * @param currentTool - Tool about to be called
   * @param currentZone - Zone it was classified as
   * @param currentInput - Tool input parameters
   * @param rules - Combination rules to check
   * @returns Block reason if a rule fires, null otherwise
   */
  check(
    currentTool: string,
    currentZone: ZoneLevel,
    currentInput: Readonly<Record<string, unknown>>,
    rules: readonly CombinationRule[],
  ): CombinationBlockReason | null {
    if (rules.length === 0) return null

    const now = Date.now()
    const currentEntry = { toolName: currentTool, zone: currentZone, input: currentInput }

    for (const rule of rules) {
      const windowMs = rule.windowMs ?? DEFAULT_WINDOW_MS

      // Get recent history within the window
      const recent = this.history.filter(e => (now - e.timestamp) <= windowMs)

      // Check if ALL triggers are satisfied
      const allTriggered = rule.triggers.every(trigger => {
        // Check current call
        if (matchesTrigger(currentEntry, trigger)) return true
        // Check recent history
        return recent.some(entry => matchesTrigger(entry, trigger))
      })

      if (allTriggered) {
        // Find which recent entries contributed
        const contributors = recent.filter(entry =>
          rule.triggers.some(trigger => matchesTrigger(entry, trigger)),
        )

        return {
          rule: rule.name,
          recentTools: contributors.map(e => ({
            toolName: e.toolName,
            zone: e.zone,
            timestamp: e.timestamp,
            tags: rule.triggers
              .filter(t => matchesTrigger(e, t))
              .map(t => t.tag),
          })),
          explanation: rule.description,
        }
      }
    }

    return null
  }

  /**
   * Get entries within a time window.
   */
  getRecent(windowMs: number): readonly CombinationToolEntry[] {
    const cutoff = Date.now() - windowMs
    return this.history
      .filter(e => e.timestamp >= cutoff)
      .map(({ input: _input, ...rest }) => rest)
  }

  /** Number of entries in history. */
  get size(): number {
    return this.history.length
  }

  /** Clear all history. */
  clear(): void {
    this.history.length = 0
  }
}
