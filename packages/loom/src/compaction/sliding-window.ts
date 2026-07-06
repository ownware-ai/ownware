/**
 * Sliding Window Compaction Strategy
 *
 * Keeps a sliding window of recent messages with configurable overlap.
 * The overlap preserves some context from before the window boundary
 * so the model doesn't lose critical transitions.
 *
 * No LLM call needed — pure message selection.
 */

import type { Message } from '../messages/types.js'
import type { CompactionResult, CompactionStrategy } from './types.js'
import type { CompactionRetain } from '../core/config.js'
import type { ProviderAdapter } from '../provider/types.js'

/** Default overlap: keep 2 messages from before the window for context continuity */
const DEFAULT_OVERLAP = 2

export interface SlidingWindowOptions {
  /** Number of overlap messages to keep from before the window */
  readonly overlap?: number
}

/**
 * Apply a sliding window over the conversation, keeping recent messages
 * plus a small overlap from before the window boundary.
 *
 * @param messages - Full conversation history
 * @param systemPrompt - System prompt (used for token counting)
 * @param retain - How much to retain (defines the window size)
 * @param provider - Provider adapter for token counting
 * @param options - Sliding window options (overlap count)
 * @returns CompactionResult with windowed message array
 */
export async function slidingWindow(
  messages: Message[],
  systemPrompt: string,
  retain: CompactionRetain,
  provider: ProviderAdapter,
  options: SlidingWindowOptions = {},
): Promise<CompactionResult> {
  const overlap = options.overlap ?? DEFAULT_OVERLAP
  const preTokenCount = await provider.countTokens(messages, systemPrompt)

  // Separate leading system messages
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

  const conversation = messages.slice(conversationStart)
  const windowSize = resolveWindowSize(conversation.length, retain)

  // If the conversation fits in the window, no compaction needed
  if (conversation.length <= windowSize) {
    return {
      strategy: 'sliding_window' satisfies CompactionStrategy,
      messages,
      preTokenCount,
      postTokenCount: preTokenCount,
    }
  }

  // Window starts at (length - windowSize), overlap extends before that
  const windowStart = conversation.length - windowSize
  const overlapStart = Math.max(0, windowStart - overlap)

  // Build overlap context: summarize overlap messages into a brief context marker
  const overlapMessages = conversation.slice(overlapStart, windowStart)
  const windowMessages = conversation.slice(windowStart)

  // Create a context bridge from the overlap region
  const result: Message[] = [...systemMessages]

  if (overlapMessages.length > 0) {
    const overlapSummary = buildOverlapSummary(overlapMessages)
    result.push({
      role: 'user',
      content: `[Prior context — ${overlapMessages.length} messages before this window]\n${overlapSummary}`,
    })
  }

  result.push(...windowMessages)

  const postTokenCount = await provider.countTokens(result, systemPrompt)

  return {
    strategy: 'sliding_window' satisfies CompactionStrategy,
    messages: result,
    preTokenCount,
    postTokenCount,
  }
}

/**
 * Resolve the window size from retain config.
 */
function resolveWindowSize(totalMessages: number, retain: CompactionRetain): number {
  switch (retain.type) {
    case 'messages':
      return retain.count
    case 'fraction':
      return Math.max(1, Math.ceil(totalMessages * retain.amount))
    case 'tokens':
      // For token-based, use a heuristic: assume ~500 tokens per message
      return Math.max(1, Math.floor(retain.count / 500))
  }
}

/**
 * Build a brief text summary of overlap messages for context continuity.
 * Extracts the key content from each message without an LLM call.
 */
function buildOverlapSummary(messages: Message[]): string {
  const lines: string[] = []

  for (const msg of messages) {
    const role = msg.role
    let preview: string

    if (typeof msg.content === 'string') {
      preview = msg.content.slice(0, 200)
    } else if (Array.isArray(msg.content)) {
      const textBlocks = msg.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map(b => b.text)
      preview = textBlocks.join(' ').slice(0, 200)

      if (preview.length === 0) {
        const types = msg.content.map(b => b.type).join(', ')
        preview = `[${types}]`
      }
    } else {
      preview = '[content]'
    }

    if (preview.length >= 200) {
      preview += '…'
    }

    lines.push(`- ${role}: ${preview}`)
  }

  return lines.join('\n')
}
