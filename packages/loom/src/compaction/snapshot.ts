/**
 * Snapshot Compaction Strategy
 *
 * Replaces the conversation prefix with a deterministic, priority-ordered
 * XML snapshot derived from the messages themselves — no LLM call.
 *
 * What we extract from `messages`:
 *   1. Last user request (the most recent intent)
 *   2. Files written/edited recently (toolName + path, deduplicated)
 *   3. Last 5 tool calls (toolName + truncated arg summary)
 *   4. Most recent tool error (full error message, head+tail truncated)
 *   5. Last assistant text snippet (their last conclusion or in-progress
 *      response)
 *
 * The output is a single synthetic system message containing one XML
 * block. The most recent N messages (per `retain`) follow unchanged.
 *
 * Why this beats summarize for many use cases:
 *   - Free: no provider call. Cost is one stat-O(messages) walk.
 *   - Deterministic: same inputs → same snapshot, easier to reason about.
 *   - Faster: no network round-trip.
 *
 * Why summarize is still better sometimes:
 *   - Captures *intent* and *reasoning* from long assistant text that
 *     this strategy can't condense (we just take the last snippet).
 *   - Picks up cross-tool patterns ("you've been debugging this auth
 *     issue across 5 files") that pure extraction misses.
 *
 * Pick `summarize` for deep reasoning sessions, `snapshot` for coding
 * loops / ops tasks where the structured facts are what matter.
 */

import type { Message, ContentBlock, ToolUseBlock, ToolResultBlock, AssistantMessage, UserMessage } from '../messages/types.js'
import type { CompactionResult, CompactionStrategy } from './types.js'
import type { CompactionRetain } from '../core/config.js'
import type { ProviderAdapter } from '../provider/types.js'
import { headTailTruncate, capBytes } from '../messages/truncate.js'

const SNAPSHOT_BYTE_BUDGET = 1500
const TOOL_CALL_HISTORY = 5
const FILE_HISTORY = 10
const ARG_PREVIEW_BYTES = 120
const ASSISTANT_SNIPPET_BYTES = 240
const ERROR_SNIPPET_BYTES = 300

const FILE_TOOLS = new Set(['readFile', 'writeFile', 'editFile'])

export async function snapshot(
  messages: Message[],
  systemPrompt: string,
  retain: CompactionRetain,
  provider: ProviderAdapter,
): Promise<CompactionResult> {
  const preTokenCount = await provider.countTokens(messages, systemPrompt)

  // Separate leading system messages from the conversation. System
  // messages are always preserved exactly — they're the contract.
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

  // How many trailing messages to keep verbatim. Mirrors the truncate
  // strategy's logic so retain semantics stay consistent across strategies.
  const retained = selectRetainedTail(conversation, retain)

  // The dropped prefix is what we summarize-into-a-snapshot.
  const droppedCount = conversation.length - retained.length
  const dropped = droppedCount > 0 ? conversation.slice(0, droppedCount) : []

  // If nothing was dropped, snapshot is a no-op — return original messages.
  if (dropped.length === 0) {
    return {
      strategy: 'snapshot' satisfies CompactionStrategy,
      messages,
      preTokenCount,
      postTokenCount: preTokenCount,
    }
  }

  const snapshotXml = buildSnapshot(dropped, conversation)
  const snapshotMsg: Message = {
    role: 'system',
    content: snapshotXml,
  }

  const newMessages: Message[] = [...systemMessages, snapshotMsg, ...retained]
  const postTokenCount = await provider.countTokens(newMessages, systemPrompt)

  return {
    strategy: 'snapshot' satisfies CompactionStrategy,
    messages: newMessages,
    preTokenCount,
    postTokenCount,
  }
}

// ---------------------------------------------------------------------------
// Snapshot builder
// ---------------------------------------------------------------------------

function buildSnapshot(dropped: Message[], allConversation: Message[]): string {
  // Walk the dropped messages to extract structured facts.
  const lastUserText = findLastUserText(dropped)
  const filesTouched = extractFilesTouched(dropped)
  const recentToolCalls = extractRecentToolCalls(dropped)
  const lastError = findLastError(dropped)
  const lastAssistantText = findLastAssistantText(dropped)

  // Sections, priority-ordered. The XML format is for parser-stability
  // when humans (or other agents) read the dropped prefix later — model
  // consumption is unaffected by the wrapper choice.
  const sections: string[] = ['<compaction-snapshot>']

  if (lastUserText) {
    sections.push(
      `  <last-user-request>${escapeXml(capBytes(lastUserText, 400, '…'))}</last-user-request>`,
    )
  }

  if (filesTouched.length > 0) {
    sections.push('  <files-touched>')
    for (const f of filesTouched) {
      sections.push(`    <file action="${f.action}">${escapeXml(f.path)}</file>`)
    }
    sections.push('  </files-touched>')
  }

  if (recentToolCalls.length > 0) {
    sections.push('  <recent-tool-calls>')
    for (const c of recentToolCalls) {
      sections.push(
        `    <call tool="${escapeXml(c.toolName)}">${escapeXml(c.argPreview)}</call>`,
      )
    }
    sections.push('  </recent-tool-calls>')
  }

  if (lastError) {
    sections.push('  <last-error>')
    sections.push(escapeXml(headTailTruncate(lastError, ERROR_SNIPPET_BYTES)))
    sections.push('  </last-error>')
  }

  if (lastAssistantText) {
    sections.push(
      `  <last-assistant-snippet>${escapeXml(capBytes(lastAssistantText, ASSISTANT_SNIPPET_BYTES, '…'))}</last-assistant-snippet>`,
    )
  }

  sections.push(
    `  <meta dropped-messages="${dropped.length}" total-conversation="${allConversation.length}"/>`,
  )
  sections.push('</compaction-snapshot>')

  // Final cap — guarantees we never exceed the budget even if a single
  // section's content was unexpectedly large.
  return capBytes(sections.join('\n'), SNAPSHOT_BYTE_BUDGET, '\n  <truncated/>\n</compaction-snapshot>')
}

// ---------------------------------------------------------------------------
// Extraction helpers
// ---------------------------------------------------------------------------

function findLastUserText(messages: Message[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role !== 'user') continue
    return userMessageText(m)
  }
  return null
}

function userMessageText(m: UserMessage): string {
  if (typeof m.content === 'string') return m.content
  // Multimodal user message — extract text blocks; ignore tool_results
  // (those are tool output, not user intent).
  return m.content
    .filter((b): b is ContentBlock & { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim()
}

interface FileTouched {
  readonly path: string
  readonly action: 'read' | 'write' | 'edit'
}

function extractFilesTouched(messages: Message[]): FileTouched[] {
  // Walk newest → oldest, dedup by path keeping the most recent action.
  const seen = new Map<string, FileTouched>()
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role !== 'assistant') continue
    for (const block of m.content) {
      if (block.type !== 'tool_use') continue
      if (!FILE_TOOLS.has(block.name)) continue
      const path = pathFromToolInput(block)
      if (!path || seen.has(path)) continue
      seen.set(path, {
        path,
        action: block.name === 'readFile' ? 'read' : block.name === 'writeFile' ? 'write' : 'edit',
      })
      if (seen.size >= FILE_HISTORY) break
    }
    if (seen.size >= FILE_HISTORY) break
  }
  return [...seen.values()]
}

function pathFromToolInput(b: ToolUseBlock): string | null {
  // The filesystem builtins use `file_path` / `path` consistently.
  const i = b.input as Record<string, unknown>
  return (i.file_path as string | undefined) ?? (i.path as string | undefined) ?? null
}

interface ToolCallLog {
  readonly toolName: string
  readonly argPreview: string
}

function extractRecentToolCalls(messages: Message[]): ToolCallLog[] {
  const calls: ToolCallLog[] = []
  for (let i = messages.length - 1; i >= 0 && calls.length < TOOL_CALL_HISTORY; i--) {
    const m = messages[i]!
    if (m.role !== 'assistant') continue
    // Walk this assistant message's tool_use blocks newest first.
    for (let j = m.content.length - 1; j >= 0 && calls.length < TOOL_CALL_HISTORY; j--) {
      const block = m.content[j]!
      if (block.type !== 'tool_use') continue
      const argPreview = capBytes(JSON.stringify(block.input), ARG_PREVIEW_BYTES, '…')
      calls.push({ toolName: block.name, argPreview })
    }
  }
  // Reverse so the snapshot reads oldest → newest within the section.
  return calls.reverse()
}

function findLastError(messages: Message[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role !== 'user') continue
    if (typeof m.content === 'string') continue
    for (let j = m.content.length - 1; j >= 0; j--) {
      const block = m.content[j]!
      if (block.type !== 'tool_result') continue
      if (!(block as ToolResultBlock).isError) continue
      const content = (block as ToolResultBlock).content
      return typeof content === 'string'
        ? content
        : content
            .filter((b): b is ContentBlock & { type: 'text'; text: string } => b.type === 'text')
            .map((b) => b.text)
            .join('\n')
    }
  }
  return null
}

function findLastAssistantText(messages: Message[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role !== 'assistant') continue
    const text = assistantMessageText(m)
    if (text.length > 0) return text
  }
  return null
}

function assistantMessageText(m: AssistantMessage): string {
  return m.content
    .filter((b): b is ContentBlock & { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim()
}

// ---------------------------------------------------------------------------
// Tail selection (mirrors truncate.ts so retain semantics are consistent)
// ---------------------------------------------------------------------------

function selectRetainedTail(conversation: Message[], retain: CompactionRetain): Message[] {
  if (retain.type === 'messages') {
    return conversation.slice(-retain.count)
  }
  if (retain.type === 'fraction') {
    const count = Math.max(1, Math.ceil(conversation.length * retain.amount))
    return conversation.slice(-count)
  }
  // tokens — approximate at ~4 chars/token (same as truncate.ts).
  const CHARS_PER_TOKEN = 4
  let estimatedTokens = 0
  let cutIndex = conversation.length
  for (let i = conversation.length - 1; i >= 0; i--) {
    const msg = conversation[i]!
    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
    estimatedTokens += Math.ceil(content.length / CHARS_PER_TOKEN)
    if (estimatedTokens > retain.count) {
      cutIndex = i + 1
      break
    }
    cutIndex = i
  }
  return conversation.slice(cutIndex)
}

// ---------------------------------------------------------------------------
// XML escape
// ---------------------------------------------------------------------------

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}
