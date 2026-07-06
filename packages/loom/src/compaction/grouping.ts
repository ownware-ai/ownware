/**
 * Message Grouping by API Round
 *
 * Compaction strategies need to slice the conversation without breaking
 * the tool_use ↔ tool_result pairing invariant that every provider
 * enforces. The pre-existing approach (`preserveToolCallPairing` in
 * `messages/pairing.ts`) is REACTIVE: slice freely, then notice orphan
 * tool_results and expand the slice backward to pull missing
 * `tool_use` parents in. That works, but it's surgery after the
 * mistake — the backward-expansion can pull back assistant messages
 * with parallel tool_calls that themselves reference yet-more
 * tool_results outside the slice, defeating the goal of trimming.
 *
 * This module is PROACTIVE: split the conversation into atomic
 * "rounds" up-front, then have strategies drop whole rounds. By
 * construction, every round is internally well-paired — the slice
 * boundary can never fall between a tool_use and its tool_result.
 *
 * ## Round definition
 *
 * A conversation looks like:
 *
 *     [system messages...]
 *     ──── ROUND 1 ────
 *     user (real input, e.g. "fix the auth bug")
 *     assistant (may contain tool_use blocks)
 *     user (tool_result blocks — NOT a "real" user message)
 *     assistant (more tool_use or final reply)
 *     user (more tool_results)
 *     ...
 *     ──── ROUND 2 ────
 *     user (real input, e.g. "now write tests")
 *     ...
 *
 * Rounds split at every **real user message** — one whose content
 * carries non-tool_result blocks (typed text, image, etc.). Tool-only
 * user messages stay attached to the round they answer, because they
 * have no meaning without the preceding assistant `tool_use`.
 *
 * Leading system messages form their own `'system'` group, always
 * retained.
 */

import type { ContentBlock, Message } from '../messages/types.js'

export type GroupKind = 'system' | 'round'

export interface MessageGroup {
  readonly kind: GroupKind
  readonly messages: readonly Message[]
}

/**
 * Split a conversation into atomic groups. See module-level comment
 * for the round definition.
 *
 * Invariants the caller can rely on:
 *   - The flat concatenation of every group's `messages` equals the
 *     input, in order. (Pure rearrangement, no loss.)
 *   - Every `'round'` group starts with a real user message (or, in
 *     the degenerate case of a leading assistant message, with that
 *     assistant message — defensive for malformed histories).
 *   - No tool_use ↔ tool_result pair spans across groups.
 */
export function groupMessagesByApiRound(
  messages: readonly Message[],
): MessageGroup[] {
  const groups: MessageGroup[] = []
  let current: Message[] = []
  let inSystemPrefix = true

  for (const msg of messages) {
    // Leading system messages: collect into one group.
    if (inSystemPrefix && msg.role === 'system') {
      current.push(msg)
      continue
    }

    // First non-system message ends the system prefix.
    if (inSystemPrefix) {
      if (current.length > 0) {
        groups.push({ kind: 'system', messages: current })
        current = []
      }
      inSystemPrefix = false
    }

    // A real user message (any non-tool_result content) starts a new
    // round. Tool-result-only user messages stay attached to the
    // current round (they answer the preceding assistant's tool_use).
    if (isRealUserMessage(msg) && current.length > 0) {
      groups.push({ kind: 'round', messages: current })
      current = []
    }

    current.push(msg)
  }

  if (current.length > 0) {
    groups.push({
      kind: inSystemPrefix ? 'system' : 'round',
      messages: current,
    })
  }

  return groups
}

/**
 * Drop the oldest non-system groups until the predicate returns
 * `false`, then return the surviving message array.
 *
 * System groups are NEVER dropped — they carry the agent's identity
 * and instructions. At least one round is always kept (otherwise the
 * model has nothing to respond to).
 *
 * `predicate(remainingGroups)` is called BEFORE each drop with the
 * current candidate (after dropping the next-oldest round). Return
 * `true` to drop, `false` to stop.
 *
 * Returns the message array in original order.
 */
export function dropOldestRounds(
  messages: readonly Message[],
  predicate: (remainingGroups: readonly MessageGroup[]) => boolean,
): Message[] {
  const groups = groupMessagesByApiRound(messages)
  // Always keep system groups; we only consider rounds for dropping.
  const systems = groups.filter((g) => g.kind === 'system')
  const rounds = groups.filter((g) => g.kind === 'round')

  // Find how many rounds to drop. We never drop the last round —
  // that's the user's current ask + the agent's in-progress answer.
  let dropCount = 0
  while (dropCount < rounds.length - 1) {
    const candidate = [...systems, ...rounds.slice(dropCount + 1)]
    if (!predicate(candidate)) break
    dropCount += 1
  }

  const kept = [...systems, ...rounds.slice(dropCount)]
  return kept.flatMap((g) => [...g.messages])
}

/**
 * Keep at most `maxRounds` of the most-recent rounds. Always keeps
 * system groups in front. If `messages` has fewer rounds than the cap,
 * returns it unchanged.
 *
 * Convenience for the common "keep last N rounds" retention shape.
 */
export function keepLastNRounds(
  messages: readonly Message[],
  maxRounds: number,
): Message[] {
  if (maxRounds < 1) {
    throw new Error(`keepLastNRounds: maxRounds must be >= 1, got ${maxRounds}`)
  }
  const groups = groupMessagesByApiRound(messages)
  const systems = groups.filter((g) => g.kind === 'system')
  const rounds = groups.filter((g) => g.kind === 'round')
  if (rounds.length <= maxRounds) {
    // Nothing to trim — return original message list (preserves identity).
    return [...messages]
  }
  const keptRounds = rounds.slice(-maxRounds)
  return [...systems, ...keptRounds].flatMap((g) => [...g.messages])
}

// ────────────────────────────────────────────────────────────────────
// Predicates
// ────────────────────────────────────────────────────────────────────

/**
 * Is this a "real" user message — one that carries content other than
 * tool_result blocks? Returns true for plain text, mixed text+image,
 * etc. Returns false for messages whose content is purely tool_result
 * blocks (those answer the preceding assistant's tool_use and have no
 * meaning without it).
 *
 * Exported so other compaction strategies (summarize, sliding-window,
 * hierarchical) can share the same notion of "where does a round
 * boundary fall."
 */
export function isRealUserMessage(msg: Message): boolean {
  if (msg.role !== 'user') return false
  if (typeof msg.content === 'string') return true
  return msg.content.some((b: ContentBlock) => b.type !== 'tool_result')
}

/**
 * Inverse of `isRealUserMessage` — true when the user message is
 * purely tool_result blocks. These messages MUST stay attached to the
 * preceding assistant message in their round.
 */
export function isToolResultMessage(msg: Message): boolean {
  if (msg.role !== 'user') return false
  if (typeof msg.content === 'string') return false
  return (
    msg.content.length > 0 &&
    msg.content.every((b: ContentBlock) => b.type === 'tool_result')
  )
}
