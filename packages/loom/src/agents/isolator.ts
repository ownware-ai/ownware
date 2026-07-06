/**
 * Agent Isolator
 *
 * Ensures sub-agents cannot modify parent state by deep-copying
 * messages and creating independent tool sets and configs.
 */

import type { LoomConfig } from '../core/config.js'
import { mergeConfig } from '../core/config.js'
import type { Message, ContentBlock } from '../messages/types.js'
import type { Tool } from '../tools/types.js'

// ---------------------------------------------------------------------------
// Tool isolation
// ---------------------------------------------------------------------------

/**
 * Create an isolated copy of tools, optionally filtered to a subset.
 *
 * Sub-agents get their own tool references so they can't mutate
 * the parent's tool list.
 *
 * @param parentTools - The parent's tool set
 * @param allowedNames - If provided, only include these tools (by name).
 *   If null/undefined, include all parent tools.
 * @returns Isolated array of tools
 */
export function isolateTools(
  parentTools: Tool[],
  allowedNames?: string[] | null,
): Tool[] {
  const tools = allowedNames
    ? parentTools.filter(t => allowedNames.includes(t.name))
    : [...parentTools]

  return tools
}

// ---------------------------------------------------------------------------
// Message isolation
// ---------------------------------------------------------------------------

/**
 * Deep-copy messages so a sub-agent's mutations don't affect the parent.
 *
 * Performs a structured clone of each message, ensuring content blocks
 * (including nested objects in tool inputs) are fully independent.
 *
 * @param parentMessages - Messages to copy
 * @returns Deep-copied messages
 */
export function isolateMessages(parentMessages: Message[]): Message[] {
  return parentMessages.map(deepCopyMessage)
}

/**
 * Deep-copy a single message.
 */
function deepCopyMessage(msg: Message): Message {
  if (msg.role === 'system') {
    return { role: 'system', content: msg.content }
  }

  if (msg.role === 'user') {
    if (typeof msg.content === 'string') {
      return { role: 'user', content: msg.content }
    }
    return {
      role: 'user',
      content: msg.content.map(deepCopyContentBlock),
    }
  }

  // Assistant
  return {
    role: 'assistant',
    content: msg.content.map(deepCopyContentBlock),
  }
}

/**
 * Deep-copy a content block.
 */
function deepCopyContentBlock(block: ContentBlock): ContentBlock {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text }

    case 'image':
      return {
        type: 'image',
        source: block.source.type === 'base64'
          ? { type: 'base64', mediaType: block.source.mediaType, data: block.source.data }
          : { type: 'url', url: block.source.url },
      }

    case 'tool_use':
      return {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: JSON.parse(JSON.stringify(block.input)),
      }

    case 'tool_result':
      return {
        type: 'tool_result',
        toolUseId: block.toolUseId,
        content: typeof block.content === 'string'
          ? block.content
          : block.content.map(deepCopyContentBlock),
        isError: block.isError,
        // Preserve the Loom-internal metadata carrier (B4a). Spawned
        // sub-agents inherit the parent's typed compaction signal —
        // dropping it here would silently re-broaden the message log.
        ...(block.metadata !== undefined
          ? { metadata: { ...block.metadata } }
          : {}),
      }

    case 'thinking':
      return { type: 'thinking', text: block.text }

    case 'redacted_thinking':
      return { type: 'redacted_thinking', data: block.data }

    case 'document':
      return {
        type: 'document',
        source: { type: 'base64', mediaType: block.source.mediaType, data: block.source.data },
      }
  }
}

// ---------------------------------------------------------------------------
// Config isolation
// ---------------------------------------------------------------------------

/**
 * Create an isolated config for a sub-agent.
 *
 * Merges parent config with overrides, ensuring the child config
 * is a separate object that won't affect the parent.
 *
 * @param parentConfig - The parent's configuration
 * @param overrides - Sub-agent-specific overrides
 * @returns New isolated config
 */
export function isolateConfig(
  parentConfig: LoomConfig,
  overrides: Partial<LoomConfig>,
): LoomConfig {
  return mergeConfig(parentConfig, overrides)
}
