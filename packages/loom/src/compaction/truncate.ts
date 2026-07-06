/**
 * Truncate Compaction Strategy
 *
 * Simplest strategy: drop oldest messages, keep system + recent N.
 * No LLM call needed — fast fallback when summarization is too expensive
 * or when the circuit breaker has tripped on summarization failures.
 *
 * Atomicity: this strategy slices by **API round**, never by raw
 * message count. A round = real user message + every assistant turn
 * and tool_result message that answered it. Dropping whole rounds
 * makes tool_use ↔ tool_result orphaning impossible by construction —
 * the slice boundary always falls on a real-user-message boundary,
 * which is exactly where it's safe. `assertPairing` runs at the end as
 * an invariant check: if it ever throws on the truncate path it means
 * the grouping logic regressed, and we want that to fail loudly rather
 * than silently repair (Principle 20 — diagnose, don't defend).
 */

import type { Message } from '../messages/types.js'
import { assertPairing } from '../messages/pairing.js'
import { estimateMessageTokens } from '../messages/tokens.js'
import {
  groupMessagesByApiRound,
  isRealUserMessage,
  type MessageGroup,
} from './grouping.js'
import type { CompactionResult, CompactionStrategy } from './types.js'
import type { CompactionRetain } from '../core/config.js'
import type { ProviderAdapter } from '../provider/types.js'

/**
 * Truncate older messages, keeping only the most recent rounds.
 *
 * @param messages - Full conversation history
 * @param systemPrompt - System prompt (used for token counting)
 * @param retain - How many messages/tokens/rounds to keep
 * @param provider - Provider adapter for token counting
 * @returns CompactionResult with truncated message array
 */
export async function truncate(
  messages: Message[],
  systemPrompt: string,
  retain: CompactionRetain,
  provider: ProviderAdapter,
): Promise<CompactionResult> {
  const preTokenCount = await provider.countTokens(messages, systemPrompt)

  // Round-aware retention: slice on group boundaries so a tool_use ↔
  // tool_result pair can never end up split. `assertPairing` is an
  // invariant check, not a repair — if grouping ever lets an orphan
  // through it'll throw and the regression surfaces immediately.
  const retained = selectRetainedByRound(messages, retain)
  assertPairing(retained)

  const postTokenCount = await provider.countTokens(retained, systemPrompt)

  return {
    strategy: 'truncate' satisfies CompactionStrategy,
    messages: retained,
    preTokenCount,
    postTokenCount,
  }
}

/**
 * Select rounds to retain based on the retain configuration.
 *
 * - `'messages'` — interpret `retain.count` as a target message count;
 *   keep the newest rounds whose combined message count fits. Always
 *   keep AT LEAST one round (otherwise the model has nothing to
 *   respond to).
 * - `'fraction'` — keep `retain.amount` × N rounds (rounded up).
 * - `'tokens'` — walk newest-to-oldest, accumulating per-round
 *   estimated token cost; stop when the budget would be exceeded.
 *
 * In all cases, system messages (leading group) are preserved.
 *
 * Why round-count over raw message count: a single round can be
 * 1 message (user only — rare) or 10+ messages (multi-step tool
 * chain). Slicing at message-count boundaries split tool chains;
 * slicing at round boundaries doesn't. The trade-off: callers
 * asking for "retain 6 messages" might get 4 or 10 instead — but
 * they never get a broken array.
 */
function selectRetainedByRound(
  messages: Message[],
  retain: CompactionRetain,
): Message[] {
  const groups = groupMessagesByApiRound(messages)
  const systems = groups.filter((g) => g.kind === 'system')
  const rounds = groups.filter((g) => g.kind === 'round')

  if (rounds.length === 0) {
    return [...systems.flatMap((g) => [...g.messages])]
  }

  // Always keep at least the most-recent round.
  const kept: MessageGroup[] = [rounds[rounds.length - 1]!]
  let messageCount = countMessagesInGroups(kept)

  if (retain.type === 'messages') {
    // Pull older rounds in until adding the next one would exceed the
    // budget. The most-recent round is already in `kept`, so the loop
    // is "expand backward from there."
    for (let i = rounds.length - 2; i >= 0; i -= 1) {
      const group = rounds[i]!
      const projected = messageCount + group.messages.length
      if (projected > retain.count) break
      kept.unshift(group)
      messageCount = projected
    }
  } else if (retain.type === 'fraction') {
    // Keep the top fraction of rounds (rounded up), at least 1.
    const target = Math.max(1, Math.ceil(rounds.length * retain.amount))
    while (kept.length < target) {
      const next = rounds.length - 1 - kept.length
      if (next < 0) break
      kept.unshift(rounds[next]!)
    }
  } else {
    // 'tokens' — accumulate per-round estimated cost using the unified
    // `estimateMessageTokens` helper and stop when the next round would
    // push us over. Single source of truth for the chars÷4 heuristic
    // (see messages/tokens.ts).
    let estimatedTokens = estimateMessageTokens([...kept[0]!.messages])
    for (let i = rounds.length - 2; i >= 0; i -= 1) {
      const group = rounds[i]!
      const groupTokens = estimateMessageTokens([...group.messages])
      if (estimatedTokens + groupTokens > retain.count) break
      kept.unshift(group)
      estimatedTokens += groupTokens
    }
  }

  return [...systems, ...kept].flatMap((g) => [...g.messages])
}

function countMessagesInGroups(groups: readonly MessageGroup[]): number {
  let total = 0
  for (const g of groups) total += g.messages.length
  return total
}

// Re-export for callers that want to detect real-user boundaries
// without importing from grouping directly.
export { isRealUserMessage }
