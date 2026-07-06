/**
 * Summarize Compaction Strategy
 *
 * LLM-based summarization: takes older messages, calls the model to
 * generate a structured summary preserving key decisions, file paths,
 * errors encountered, and current task state.
 *
 * Returns: [summary_as_user_message, ...recent_messages]
 *
 * Atomicity: the split between "summarize" and "retain" falls on API
 * round boundaries — never mid tool_use ↔ tool_result pair. A round =
 * real user message + every assistant turn and tool_result that
 * answered it. The retained tail therefore always starts with a real
 * user message, which is the only place a tool chain can begin. This
 * is the same primitive `truncate` uses; see `compaction/grouping.ts`.
 *
 * `assertPairing` at the end is a loud invariant check, not a repair —
 * if it ever throws on the summarize path the round-grouping logic
 * regressed and we want the failure visible (Principle 20).
 */

import type { Message } from '../messages/types.js'
import { assertPairing } from '../messages/pairing.js'
import {
  groupMessagesByApiRound,
  type MessageGroup,
} from './grouping.js'
import type { CompactionResult, CompactionStrategy } from './types.js'
import type { CompactionRetain } from '../core/config.js'
import type { ProviderAdapter, ProviderRequest } from '../provider/types.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum output tokens for the summarization call */
const SUMMARY_MAX_OUTPUT_TOKENS = 8_192

// ---------------------------------------------------------------------------
// Summarization prompt
// ---------------------------------------------------------------------------

const SUMMARIZATION_SYSTEM_PROMPT = `You are a conversation summarizer. Your task is to create a detailed, accurate summary of a conversation between a user and an AI assistant.

CRITICAL: Respond with TEXT ONLY. Do NOT call any tools. Your entire response must be plain text.

Create a summary that preserves all information needed to continue the work seamlessly. Include:

1. **Primary Request & Intent**: What the user asked for and why.
2. **Key Decisions**: Technical decisions made, trade-offs considered, approaches chosen or rejected.
3. **Files & Code**: Specific file paths, function names, code patterns examined or modified. Include snippets for critical changes.
4. **Errors & Fixes**: Problems encountered and how they were resolved. Note any user corrections.
5. **Current State**: What was being worked on immediately before this summary. Include exact file names and what was happening.
6. **Pending Work**: Any remaining tasks explicitly requested by the user.
7. **User Feedback**: Direct quotes of important user instructions, corrections, or preferences.

Be thorough but concise. Preserve technical precision — exact file paths, function signatures, error messages. Do not editorialize or add opinions.`

const SUMMARIZATION_USER_PREFIX = `Summarize the following conversation. Preserve all technical details needed to continue the work without loss of context.

<conversation>
`

const SUMMARIZATION_USER_SUFFIX = `
</conversation>

Provide your summary now.`

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Summarize older messages using an LLM call, keeping recent messages intact.
 *
 * @param messages - Full conversation history
 * @param systemPrompt - System prompt (used for token counting)
 * @param retain - How many recent messages to keep verbatim
 * @param provider - Provider adapter for both summarization and token counting
 * @param summaryModel - Model to use for summarization (null = use provider default)
 * @returns CompactionResult with summary + retained messages
 */
export async function summarize(
  messages: Message[],
  systemPrompt: string,
  retain: CompactionRetain,
  provider: ProviderAdapter,
  summaryModel: string | null = null,
): Promise<CompactionResult> {
  const preTokenCount = await provider.countTokens(messages, systemPrompt)

  // Separate system messages, messages to summarize, and messages to retain
  const { systemMessages, toSummarize, toRetain } = splitMessages(messages, retain)

  // If there's nothing meaningful to summarize, return as-is
  if (toSummarize.length === 0) {
    return {
      strategy: 'summarize' satisfies CompactionStrategy,
      messages,
      preTokenCount,
      postTokenCount: preTokenCount,
    }
  }

  // Build the summarization prompt
  const conversationText = formatMessagesForSummary(toSummarize)
  const userPrompt = SUMMARIZATION_USER_PREFIX + conversationText + SUMMARIZATION_USER_SUFFIX

  // Call the model to generate a summary
  const request: ProviderRequest = {
    model: summaryModel ?? 'default',
    system: SUMMARIZATION_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
    tools: [],
    maxTokens: SUMMARY_MAX_OUTPUT_TOKENS,
    temperature: 0,
  }

  let summaryText = ''
  let inputTokens = 0
  let outputTokens = 0

  for await (const chunk of provider.stream(request)) {
    if (chunk.type === 'text_delta') {
      summaryText += chunk.text
    } else if (chunk.type === 'message_complete') {
      inputTokens = chunk.usage.inputTokens
      outputTokens = chunk.usage.outputTokens
    } else if (chunk.type === 'stream_error') {
      throw chunk.error
    }
  }

  if (!summaryText) {
    throw new Error('Summarization produced empty output')
  }

  // Build compacted message array: system + summary + retained
  const summaryMessage: Message = {
    role: 'user',
    content: `[This is an automated summary of the conversation so far. Continue from where we left off.]\n\n${summaryText}`,
  }

  const compacted: Message[] = [
    ...systemMessages,
    summaryMessage,
    ...toRetain,
  ]

  // Invariant: round-atomic split should make orphan tool_result blocks
  // impossible. Throw loudly (and surface in tests / dev) if it ever
  // doesn't — the bug is in `splitMessages`, not here.
  assertPairing(compacted)

  const postTokenCount = await provider.countTokens(compacted, systemPrompt)

  return {
    strategy: 'summarize' satisfies CompactionStrategy,
    messages: compacted,
    preTokenCount,
    postTokenCount,
    summaryUsage: { inputTokens, outputTokens },
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Split messages into system + older rounds (to summarize) + newer rounds
 * (to retain verbatim). The split falls on API-round boundaries, so a
 * tool_use ↔ tool_result pair can never end up on opposite sides.
 *
 * Retain semantics:
 *   - `'messages'`: target message count; expand backward from the
 *     newest round, never exceeding the count. Always keeps at least
 *     the most-recent round.
 *   - `'fraction'`: keep `amount × N` rounds (rounded up), at least 1.
 *   - `'tokens'`: translate token budget via the same ~500-tokens-per-
 *     message heuristic the old implementation used, then apply the
 *     message-count rule.
 *
 * Trade-off vs the old message-count slice: a caller asking to retain
 * 4 messages may end up with 3 or 6 (whichever round boundary fits
 * under the budget). They never end up with a broken array.
 */
function splitMessages(
  messages: Message[],
  retain: CompactionRetain,
): {
  systemMessages: Message[]
  toSummarize: Message[]
  toRetain: Message[]
} {
  const groups = groupMessagesByApiRound(messages)
  const systemGroups = groups.filter((g) => g.kind === 'system')
  const roundGroups = groups.filter((g) => g.kind === 'round')

  const systemMessages = systemGroups.flatMap((g) => [...g.messages])

  if (roundGroups.length === 0) {
    return { systemMessages, toSummarize: [], toRetain: [] }
  }

  const retainRoundCount = resolveRetainRoundCount(roundGroups, retain)
  const splitPoint = roundGroups.length - retainRoundCount

  const toSummarize = roundGroups
    .slice(0, splitPoint)
    .flatMap((g) => [...g.messages])
  const toRetain = roundGroups
    .slice(splitPoint)
    .flatMap((g) => [...g.messages])

  return { systemMessages, toSummarize, toRetain }
}

/**
 * How many rounds to retain from the tail. Always >= 1 when any round
 * exists — the most-recent round carries the user's current ask.
 */
function resolveRetainRoundCount(
  rounds: readonly MessageGroup[],
  retain: CompactionRetain,
): number {
  if (rounds.length === 0) return 0

  if (retain.type === 'fraction') {
    return Math.max(1, Math.min(rounds.length, Math.ceil(rounds.length * retain.amount)))
  }

  // Both 'messages' and 'tokens' resolve to a target message-count budget.
  const messageBudget =
    retain.type === 'messages'
      ? retain.count
      : Math.max(1, Math.floor(retain.count / 500))

  let kept = 1
  let messageCount = rounds[rounds.length - 1]!.messages.length
  for (let i = rounds.length - 2; i >= 0; i -= 1) {
    const projected = messageCount + rounds[i]!.messages.length
    if (projected > messageBudget) break
    kept += 1
    messageCount = projected
  }
  return kept
}

/**
 * Format messages into a readable text block for the summarizer.
 */
function formatMessagesForSummary(messages: Message[]): string {
  const parts: string[] = []

  for (const msg of messages) {
    const role = msg.role.toUpperCase()
    const content = extractTextContent(msg)
    parts.push(`[${role}]\n${content}`)
  }

  return parts.join('\n\n---\n\n')
}

/**
 * Extract readable text content from a message.
 */
function extractTextContent(message: Message): string {
  if (typeof message.content === 'string') {
    return message.content
  }

  if (!Array.isArray(message.content)) {
    return String(message.content)
  }

  const parts: string[] = []

  for (const block of message.content) {
    switch (block.type) {
      case 'text':
        parts.push(block.text)
        break
      case 'tool_use':
        parts.push(`[Tool call: ${block.name}(${JSON.stringify(block.input).slice(0, 500)})]`)
        break
      case 'tool_result': {
        const resultContent = typeof block.content === 'string'
          ? block.content.slice(0, 1000)
          : '[structured result]'
        parts.push(`[Tool result${block.isError ? ' (error)' : ''}: ${resultContent}]`)
        break
      }
      case 'thinking':
        // Skip thinking blocks — they're internal reasoning
        break
      case 'image':
        parts.push('[image]')
        break
      default:
        parts.push(`[${block.type}]`)
    }
  }

  return parts.join('\n')
}
