/**
 * Hierarchical Compaction Strategy
 *
 * Multi-level summarization for very long sessions:
 *   Level 1: Per-topic summaries (group related turns)
 *   Level 2: Session-level summary (combine topic summaries)
 *
 * Keeps recent detail + topic summaries + session summary.
 * Uses two LLM calls: one for topic grouping/summarization,
 * one for the session-level rollup.
 *
 * Best for sessions that span many distinct sub-tasks.
 */

import type { Message, ContentBlock } from '../messages/types.js'
import type { CompactionResult, CompactionStrategy } from './types.js'
import type { CompactionRetain } from '../core/config.js'
import type { ProviderAdapter, ProviderRequest } from '../provider/types.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max output tokens for each summarization call */
const TOPIC_SUMMARY_MAX_TOKENS = 4_096
const SESSION_SUMMARY_MAX_TOKENS = 4_096

/** Minimum messages in a topic group to warrant summarization */
const MIN_TOPIC_GROUP_SIZE = 4

/** Maximum number of topic groups to create */
const MAX_TOPIC_GROUPS = 10

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const TOPIC_SUMMARY_SYSTEM = `You are a conversation analyst. Given a segment of conversation between a user and an AI assistant, produce a concise topic summary.

CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

Your summary must capture:
- What was discussed/accomplished in this segment
- Key file paths, function names, and code changes
- Decisions made and their rationale
- Errors encountered and how they were resolved
- Any explicit user feedback or corrections

Be precise and technical. Preserve exact names and paths.`

const SESSION_SUMMARY_SYSTEM = `You are a session summarizer. Given a series of topic summaries from a long conversation, produce a session-level overview.

CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

Structure your summary as:
1. **Session Overview**: High-level description of the session's goals and progress.
2. **Completed Work**: Topics/tasks that were finished, with key details.
3. **Key Decisions**: Important technical or design decisions across the session.
4. **Active Context**: What was most recently being worked on.
5. **Open Items**: Any explicitly requested but unfinished tasks.

This summary will be used to continue the conversation, so preserve all information needed for seamless continuation.`

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Hierarchical compaction: group messages into topics, summarize each topic,
 * then produce a session-level summary. Recent messages are preserved verbatim.
 *
 * @param messages - Full conversation history
 * @param systemPrompt - System prompt (for token counting)
 * @param retain - How many recent messages to keep verbatim
 * @param provider - Provider adapter for LLM calls and token counting
 * @param summaryModel - Model override for summarization (null = provider default)
 * @returns CompactionResult with hierarchical summary + retained messages
 */
export async function hierarchical(
  messages: Message[],
  systemPrompt: string,
  retain: CompactionRetain,
  provider: ProviderAdapter,
  summaryModel: string | null = null,
): Promise<CompactionResult> {
  const preTokenCount = await provider.countTokens(messages, systemPrompt)
  const model = summaryModel ?? 'default'

  // Split into system, summarize, retain
  const { systemMessages, toSummarize, toRetain } = splitMessages(messages, retain)

  if (toSummarize.length === 0) {
    return {
      strategy: 'hierarchical' satisfies CompactionStrategy,
      messages,
      preTokenCount,
      postTokenCount: preTokenCount,
    }
  }

  // Level 1: Group messages by topic and summarize each group
  const topicGroups = groupByTopic(toSummarize)
  let totalInputTokens = 0
  let totalOutputTokens = 0

  const topicSummaries: string[] = []
  for (const group of topicGroups) {
    if (group.length < MIN_TOPIC_GROUP_SIZE) {
      // Too small to warrant an LLM call — just extract text
      topicSummaries.push(formatGroupBrief(group))
      continue
    }

    const { summary, inputTokens, outputTokens } = await summarizeGroup(
      group, model, provider,
    )
    topicSummaries.push(summary)
    totalInputTokens += inputTokens
    totalOutputTokens += outputTokens
  }

  // Level 2: Session-level summary from topic summaries
  const topicBlock = topicSummaries
    .map((s, i) => `### Topic ${i + 1}\n${s}`)
    .join('\n\n')

  const sessionRequest: ProviderRequest = {
    model,
    system: SESSION_SUMMARY_SYSTEM,
    messages: [{
      role: 'user',
      content: `Here are ${topicSummaries.length} topic summaries from a long conversation session. Produce a session-level overview.\n\n${topicBlock}`,
    }],
    tools: [],
    maxTokens: SESSION_SUMMARY_MAX_TOKENS,
    temperature: 0,
  }

  let sessionSummary = ''
  for await (const chunk of provider.stream(sessionRequest)) {
    if (chunk.type === 'text_delta') {
      sessionSummary += chunk.text
    } else if (chunk.type === 'message_complete') {
      totalInputTokens += chunk.usage.inputTokens
      totalOutputTokens += chunk.usage.outputTokens
    } else if (chunk.type === 'stream_error') {
      throw chunk.error
    }
  }

  if (!sessionSummary) {
    throw new Error('Hierarchical session summarization produced empty output')
  }

  // Build result: system + session summary + topic summaries + retained
  const hierarchicalSummary = [
    `[Automated hierarchical summary of ${toSummarize.length} messages across ${topicSummaries.length} topics]`,
    '',
    '## Session Summary',
    sessionSummary,
    '',
    '## Topic Details',
    topicBlock,
  ].join('\n')

  const summaryMessage: Message = {
    role: 'user',
    content: hierarchicalSummary,
  }

  const compacted: Message[] = [
    ...systemMessages,
    summaryMessage,
    ...toRetain,
  ]

  const postTokenCount = await provider.countTokens(compacted, systemPrompt)

  return {
    strategy: 'hierarchical' satisfies CompactionStrategy,
    messages: compacted,
    preTokenCount,
    postTokenCount,
    summaryUsage: {
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
    },
  }
}

// ---------------------------------------------------------------------------
// Topic grouping
// ---------------------------------------------------------------------------

/**
 * Group messages into topic clusters based on conversation flow.
 *
 * Uses a simple heuristic: a new topic starts when the user sends
 * a message that doesn't look like a follow-up (no tool results,
 * starts fresh). This avoids needing an LLM call for grouping.
 */
function groupByTopic(messages: Message[]): Message[][] {
  if (messages.length === 0) return []

  const groups: Message[][] = [[]]

  for (const msg of messages) {
    const currentGroup = groups[groups.length - 1]!

    // Heuristic: a user message with plain string content (not tool results)
    // that appears after an assistant response signals a potential topic shift
    const isTopicShift =
      msg.role === 'user' &&
      typeof msg.content === 'string' &&
      currentGroup.length >= MIN_TOPIC_GROUP_SIZE &&
      currentGroup[currentGroup.length - 1]?.role === 'assistant'

    if (isTopicShift && groups.length < MAX_TOPIC_GROUPS) {
      groups.push([msg])
    } else {
      currentGroup.push(msg)
    }
  }

  return groups.filter(g => g.length > 0)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Summarize a group of messages using an LLM call.
 */
async function summarizeGroup(
  group: Message[],
  model: string,
  provider: ProviderAdapter,
): Promise<{ summary: string; inputTokens: number; outputTokens: number }> {
  const formatted = group.map(msg => {
    const role = msg.role.toUpperCase()
    const content = typeof msg.content === 'string'
      ? msg.content
      : extractText(msg.content)
    return `[${role}]\n${content}`
  }).join('\n\n')

  const request: ProviderRequest = {
    model,
    system: TOPIC_SUMMARY_SYSTEM,
    messages: [{
      role: 'user',
      content: `Summarize this conversation segment:\n\n${formatted}`,
    }],
    tools: [],
    maxTokens: TOPIC_SUMMARY_MAX_TOKENS,
    temperature: 0,
  }

  let summary = ''
  let inputTokens = 0
  let outputTokens = 0

  for await (const chunk of provider.stream(request)) {
    if (chunk.type === 'text_delta') {
      summary += chunk.text
    } else if (chunk.type === 'message_complete') {
      inputTokens = chunk.usage.inputTokens
      outputTokens = chunk.usage.outputTokens
    } else if (chunk.type === 'stream_error') {
      throw chunk.error
    }
  }

  return { summary: summary || '[Empty summary]', inputTokens, outputTokens }
}

/**
 * Create a brief text summary of a small group without an LLM call.
 */
function formatGroupBrief(group: Message[]): string {
  return group.map(msg => {
    const role = msg.role
    const text = typeof msg.content === 'string'
      ? msg.content.slice(0, 150)
      : extractText(msg.content).slice(0, 150)
    return `${role}: ${text}${text.length >= 150 ? '…' : ''}`
  }).join('\n')
}

/**
 * Extract readable text from content blocks.
 */
function extractText(content: string | readonly ContentBlock[]): string {
  if (typeof content === 'string') return content

  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text') parts.push(block.text)
    else if (block.type === 'tool_use') parts.push(`[Tool: ${block.name}]`)
    else if (block.type === 'tool_result') {
      const rc = typeof block.content === 'string' ? block.content.slice(0, 300) : '[result]'
      parts.push(`[Result: ${rc}]`)
    }
  }
  return parts.join('\n')
}

/**
 * Split messages into system, to-summarize, and to-retain.
 */
function splitMessages(
  messages: Message[],
  retain: CompactionRetain,
): {
  systemMessages: Message[]
  toSummarize: Message[]
  toRetain: Message[]
} {
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
  const retainCount = resolveRetainCount(conversation.length, retain)
  const actualRetain = Math.min(retainCount, conversation.length)
  const splitPoint = conversation.length - actualRetain

  return {
    systemMessages,
    toSummarize: conversation.slice(0, splitPoint),
    toRetain: conversation.slice(splitPoint),
  }
}

function resolveRetainCount(totalMessages: number, retain: CompactionRetain): number {
  switch (retain.type) {
    case 'messages':
      return retain.count
    case 'fraction':
      return Math.max(1, Math.ceil(totalMessages * retain.amount))
    case 'tokens':
      return Math.max(1, Math.floor(retain.count / 500))
  }
}
