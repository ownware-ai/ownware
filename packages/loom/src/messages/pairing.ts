/**
 * Tool-Call Pairing Invariant
 *
 * Every `tool_result` block (carried in a UserMessage) must be preceded
 * earlier in the conversation by an `assistant` message whose content
 * contains a `tool_use` block with a matching `id`. Anthropic, OpenAI,
 * and OpenRouter all reject conversations where this invariant is broken.
 *
 * This module owns the invariant. Two surfaces:
 *
 * - `preserveToolCallPairing(retained, allMessages)` — used by compaction
 *   strategies after they pick a retention window. If the retained slice
 *   contains an orphan `tool_result` (its matching `tool_use` got
 *   truncated), the helper pulls the missing assistant message back in
 *   from `allMessages`. If the matching `tool_use` cannot be found at
 *   all (data corruption), the orphan `tool_result` is dropped instead.
 *
 * - `findOrphanToolResults(messages)` — pure check, returns the orphan
 *   ids without mutating. Used by the provider-boundary guard
 *   (`assertPairing`) to fail fast with a clear loom-side error instead
 *   of letting OpenAI return a confusing 400.
 *
 * Why expand-backward (not drop) is the default policy: a `tool_result`
 * usually carries the model's only memory of what a tool returned;
 * dropping it loses information the model already paid the round-trip
 * cost to obtain. Pulling the preceding `assistant` message back in
 * costs at most one extra retained message because Anthropic-format
 * parallel tool calls bundle all `tool_use` blocks into ONE assistant
 * message and all `tool_result` blocks into ONE following user
 * message — no cross-message spread.
 */

import type { ContentBlock, Message } from './types.js'

/**
 * Collect every `tool_use.id` referenced by tool_result blocks in the
 * given messages but NOT introduced by any preceding assistant tool_use.
 * Returns the orphan ids in the order they first appear.
 */
export function findOrphanToolResults(messages: readonly Message[]): string[] {
  const haveToolUseIds = new Set<string>()
  const orphans: string[] = []
  const seen = new Set<string>()

  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_use') haveToolUseIds.add(block.id)
      }
      continue
    }
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_result' && !haveToolUseIds.has(block.toolUseId)) {
          if (!seen.has(block.toolUseId)) {
            orphans.push(block.toolUseId)
            seen.add(block.toolUseId)
          }
        }
      }
    }
  }

  return orphans
}

/**
 * Restore the tool_use ↔ tool_result invariant after a compaction
 * strategy has selected a retention window.
 *
 * Algorithm:
 *   1. Identify orphan tool_result ids inside `retained`.
 *   2. Walk `allMessages` in original order; rebuild the kept array as
 *      (retained ∪ any assistant message that introduces a still-orphan
 *      tool_use id).
 *   3. If any orphan ids remain unmatched after the walk (the matching
 *      assistant message doesn't exist anywhere — data corruption or
 *      pre-existing broken history), strip those tool_result blocks
 *      from the retained user messages and drop user messages that
 *      become empty.
 *
 * Order in `allMessages` is preserved. Retained system messages keep
 * their position.
 */
export function preserveToolCallPairing(
  retained: readonly Message[],
  allMessages: readonly Message[],
): Message[] {
  const orphans = findOrphanToolResults(retained)
  if (orphans.length === 0) {
    return [...retained]
  }

  const retainedSet = new Set<Message>(retained)
  const stillOrphan = new Set<string>(orphans)
  const result: Message[] = []

  for (const msg of allMessages) {
    if (retainedSet.has(msg)) {
      result.push(msg)
      continue
    }
    if (stillOrphan.size > 0 && msg.role === 'assistant' && Array.isArray(msg.content)) {
      const matched: string[] = []
      for (const block of msg.content) {
        if (block.type === 'tool_use' && stillOrphan.has(block.id)) {
          matched.push(block.id)
        }
      }
      if (matched.length > 0) {
        result.push(msg)
        for (const id of matched) stillOrphan.delete(id)
      }
    }
  }

  if (stillOrphan.size === 0) {
    return result
  }

  // Unmatched orphans remain. Strip those tool_result blocks from any
  // user message that carries them; drop the user message entirely if it
  // ends up empty.
  return stripOrphanToolResults(result, stillOrphan)
}

function stripOrphanToolResults(
  messages: readonly Message[],
  orphanIds: ReadonlySet<string>,
): Message[] {
  const out: Message[] = []
  for (const msg of messages) {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) {
      out.push(msg)
      continue
    }
    const kept: ContentBlock[] = msg.content.filter(
      block => !(block.type === 'tool_result' && orphanIds.has(block.toolUseId)),
    )
    if (kept.length === 0) {
      continue
    }
    out.push({ ...msg, content: kept })
  }
  return out
}

/**
 * Throws if `messages` violates the tool_use ↔ tool_result pairing
 * invariant. Used by the provider boundary as a last-line guard before
 * shipping the request to OpenAI / OpenRouter / Anthropic.
 *
 * The error message names the offending tool_use_id(s) so the failure
 * is debuggable from a single log line, instead of the opaque
 * `400 Invalid parameter: messages with role 'tool' must be a response
 * to a preceeding message with 'tool_calls'` returned by the API.
 */
export function assertPairing(messages: readonly Message[]): void {
  const orphans = findOrphanToolResults(messages)
  if (orphans.length === 0) return
  const preview = orphans.slice(0, 3).join(', ')
  const suffix = orphans.length > 3 ? `, +${orphans.length - 3} more` : ''
  throw new Error(
    `Tool-call pairing invariant broken: ${orphans.length} orphan tool_result block(s) ` +
      `with no preceding assistant tool_use (ids: ${preview}${suffix}). ` +
      `This typically indicates a compaction step trimmed an assistant message but kept its ` +
      `tool_result(s). Compaction strategies must call preserveToolCallPairing.`,
  )
}
