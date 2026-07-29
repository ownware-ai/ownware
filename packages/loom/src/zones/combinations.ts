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

/**
 * Assign every trigger a DISTINCT matching call.
 *
 * A combination rule describes a SEQUENCE ("read secrets, then reach the
 * network"), so satisfying two triggers with one call is not the pattern
 * the rule is trying to describe. Exhaustive backtracking rather than a
 * greedy pass: greedy can consume a call that a later trigger uniquely
 * needed and report no match when one exists. Rules carry two or three
 * triggers, so the search is trivial.
 *
 * @returns One candidate index per trigger, in trigger order, or null
 *          when no complete distinct assignment exists.
 */
function assignTriggersToDistinctCalls(
  triggers: readonly CombinationTrigger[],
  candidates: readonly { toolName: string; zone: ZoneLevel; input?: Readonly<Record<string, unknown>> }[],
  requiredIndex: number,
): number[] | null {
  // The required call must be assigned to SOME trigger. Pin it to each
  // trigger it can satisfy in turn, then solve the rest around it.
  //
  // Searching freely and rejecting assignments that omit the required
  // call is NOT equivalent, and got this wrong once: with a duplicate of
  // an earlier call in the window, the search happily satisfied every
  // trigger from history alone and returned an assignment the current
  // call took no part in — so a genuine "read .env then fetch" sequence
  // reported no combination at all. Caught by the S1 baseline
  // integration test, which encodes exactly that sequence.
  for (let t = 0; t < triggers.length; t++) {
    const pinned = triggers[t]
    if (pinned === undefined) continue
    if (!matchesTrigger(candidates[requiredIndex]!, pinned)) continue

    const used = new Set<number>([requiredIndex])
    const chosen: number[] = new Array(triggers.length).fill(-1) as number[]
    chosen[t] = requiredIndex

    const place = (triggerIndex: number): boolean => {
      if (triggerIndex === triggers.length) return true
      if (triggerIndex === t) return place(triggerIndex + 1)
      const trigger = triggers[triggerIndex]
      if (trigger === undefined) return place(triggerIndex + 1)
      for (let i = 0; i < candidates.length; i++) {
        if (used.has(i)) continue
        if (!matchesTrigger(candidates[i]!, trigger)) continue
        used.add(i)
        chosen[triggerIndex] = i
        if (place(triggerIndex + 1)) return true
        used.delete(i)
        chosen[triggerIndex] = -1
      }
      return false
    }

    if (place(0)) return chosen
  }

  return null
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
    const currentEntry = {
      toolName: currentTool,
      zone: currentZone,
      input: currentInput,
      timestamp: now,
      tags: [] as string[],
    }

    for (const rule of rules) {
      const windowMs = rule.windowMs ?? DEFAULT_WINDOW_MS

      // Get recent history within the window, plus the call being judged.
      const recent = this.history.filter(e => (now - e.timestamp) <= windowMs)
      const candidates = [...recent, currentEntry]
      const currentIndex = candidates.length - 1

      // Each trigger must be satisfied by a DISTINCT call, and the call
      // being judged must be one of them.
      //
      // @security The previous implementation tested the current call
      // against EVERY trigger independently:
      //
      //   rule.triggers.every(t =>
      //     matchesTrigger(currentEntry, t) || recent.some(e => matchesTrigger(e, t)))
      //
      // so one call could satisfy a whole multi-trigger rule by itself,
      // with empty history. Verified: a single `readFile {path:'/app/.env'}`
      // fired `exfiltration-prevention` — a rule whose stated job is
      // "block network access AFTER reading sensitive files" — because
      // zone matching is `>=` and that rule's `network-access` trigger is
      // zone-only with no tool or input constraint, so any sufficiently
      // high-zone call matches it. That is a textbook false positive and
      // is almost certainly what drove the S7 decision to gate the whole
      // set off by default.
      //
      // Requiring the current call to participate keeps the rule about
      // THIS decision rather than firing repeatedly on stale history.
      const assignment = assignTriggersToDistinctCalls(
        rule.triggers,
        candidates,
        currentIndex,
      )
      if (assignment === null) continue

      // Contributors are the assigned calls that came from history — the
      // "here is what you did just before this" evidence for the UI.
      const contributors = assignment
        .filter(i => i !== currentIndex)
        .map(i => candidates[i]!)

      return {
        rule: rule.name,
        recentTools: contributors.map(e => ({
          toolName: e.toolName,
          zone: e.zone,
          timestamp: e.timestamp,
          tags: rule.triggers.filter(t => matchesTrigger(e, t)).map(t => t.tag),
        })),
        explanation: rule.description,
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
