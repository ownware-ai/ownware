/**
 * Message Truncation
 *
 * Utilities for truncating messages and content to fit within limits.
 * Used by compaction, tool result capping, and display formatting.
 */

import type { Message } from './types.js'
import { estimateMessageTokens } from './tokens.js'
import { capBytes } from './truncate.js'

// ---------------------------------------------------------------------------
// Message truncation
// ---------------------------------------------------------------------------

/**
 * Truncate a message array to fit within a token budget.
 *
 * Preserves system messages at the start and keeps the most recent
 * messages that fit. This is a simpler, synchronous alternative to
 * the compaction system — use it for quick trimming without provider calls.
 *
 * @param messages - Full message array
 * @param maxTokens - Maximum estimated token budget
 * @returns Truncated message array (system messages + recent messages)
 */
export function truncateMessages(messages: Message[], maxTokens: number): Message[] {
  const currentEstimate = estimateMessageTokens(messages)
  if (currentEstimate <= maxTokens) {
    return messages
  }

  // Separate system messages from conversation
  const systemMessages: Message[] = []
  let conversationStart = 0
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.role === 'system') {
      systemMessages.push(messages[i]!)
      conversationStart = i + 1
    } else {
      break
    }
  }

  const systemTokens = estimateMessageTokens(systemMessages)
  const remainingBudget = maxTokens - systemTokens
  if (remainingBudget <= 0) {
    return systemMessages
  }

  // Walk backwards from the end, accumulating messages until budget is spent
  const conversation = messages.slice(conversationStart)
  const kept: Message[] = []
  let usedTokens = 0

  for (let i = conversation.length - 1; i >= 0; i--) {
    const msgTokens = estimateMessageTokens([conversation[i]!])
    if (usedTokens + msgTokens > remainingBudget) {
      break
    }
    kept.unshift(conversation[i]!)
    usedTokens += msgTokens
  }

  return [...systemMessages, ...kept]
}

// ---------------------------------------------------------------------------
// Content truncation
// ---------------------------------------------------------------------------

/**
 * Truncate a string to a maximum byte budget (UTF-8) with a trailing marker.
 *
 * Backed by `capBytes` from ./truncate — byte-safe, surrogate-safe. The
 * `maxChars` parameter name is preserved for compatibility but is now
 * interpreted as bytes (for ASCII content the two are identical; for
 * multi-byte content this is the safer direction for budget purposes).
 *
 * @param content - String to truncate
 * @param maxChars - Maximum size in UTF-8 bytes
 * @returns Truncated string, or original if it fits
 */
export function truncateContent(content: string, maxChars: number): string {
  return capBytes(content, maxChars, '\n\n[Content truncated]')
}

// ---------------------------------------------------------------------------
// Tool result check
// ---------------------------------------------------------------------------

/**
 * Check whether a tool result string should be truncated.
 *
 * @param result - Tool result content
 * @param maxSize - Maximum allowed size in characters
 * @returns true if the result exceeds maxSize
 */
export function shouldTruncateToolResult(result: string, maxSize: number): boolean {
  return result.length > maxSize
}
