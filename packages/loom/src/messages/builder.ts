/**
 * Message Builder
 *
 * Fluent API for constructing message arrays with validation.
 * Ensures correct message ordering (system first, proper alternation)
 * and catches structural errors before they hit the API.
 *
 * @example
 * ```typescript
 * const messages = new MessageBuilder()
 *   .system('You are a helpful assistant.')
 *   .user('Read this file')
 *   .assistant([{ type: 'tool_use', id: 't1', name: 'readFile', input: { path: 'index.ts' } }])
 *   .toolResult('t1', 'file contents here')
 *   .build()
 * ```
 */

import type {
  Message,
  SystemMessage,
  UserMessage,
  AssistantMessage,
  ContentBlock,
} from './types.js'

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

export class MessageBuilder {
  private readonly messages: Message[] = []
  private systemFinished = false

  /**
   * Add a system message. Must be called before any user/assistant messages.
   * Multiple system messages are allowed (they stack at the beginning).
   */
  system(content: string): this {
    if (this.systemFinished) {
      throw new Error(
        'MessageBuilder: system messages must come before user/assistant messages',
      )
    }
    if (!content) {
      throw new Error('MessageBuilder: system message content must not be empty')
    }
    this.messages.push({ role: 'system', content } satisfies SystemMessage)
    return this
  }

  /**
   * Add a user message. Content can be a plain string or an array of content blocks.
   */
  user(content: string | ContentBlock[]): this {
    this.systemFinished = true

    if (typeof content === 'string' && !content) {
      throw new Error('MessageBuilder: user message content must not be empty')
    }
    if (Array.isArray(content) && content.length === 0) {
      throw new Error('MessageBuilder: user message content blocks must not be empty')
    }

    this.validateNotConsecutive('user')
    this.messages.push({ role: 'user', content } satisfies UserMessage)
    return this
  }

  /**
   * Add an assistant message with content blocks.
   */
  assistant(content: ContentBlock[] | string): this {
    this.systemFinished = true

    const blocks: ContentBlock[] = typeof content === 'string'
      ? [{ type: 'text', text: content }]
      : content

    if (blocks.length === 0) {
      throw new Error('MessageBuilder: assistant message content must not be empty')
    }

    this.validateNotConsecutive('assistant')
    this.messages.push({ role: 'assistant', content: blocks } satisfies AssistantMessage)
    return this
  }

  /**
   * Add a tool result as a user message (tool results are always user role).
   *
   * Optional `metadata` is the Loom-internal carrier described on
   * `ToolResultBlock.metadata` — useful for compaction-strategy
   * discriminators and other consumers that need typed signal beyond
   * the wire-visible `content`. It never reaches the provider API.
   */
  toolResult(
    toolUseId: string,
    content: string,
    isError = false,
    metadata?: Readonly<Record<string, unknown>>,
  ): this {
    this.systemFinished = true

    if (!toolUseId) {
      throw new Error('MessageBuilder: toolUseId must not be empty')
    }

    // Tool results don't violate alternation — they're user messages that
    // follow assistant tool_use messages
    this.messages.push({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          toolUseId,
          content,
          isError,
          ...(metadata !== undefined ? { metadata } : {}),
        },
      ],
    } satisfies UserMessage)
    return this
  }

  /**
   * Build and return the message array. Validates the overall structure.
   */
  build(): Message[] {
    if (this.messages.length === 0) {
      return []
    }

    // Validate first non-system message is a user message (API requirement)
    const firstNonSystem = this.messages.find(m => m.role !== 'system')
    if (firstNonSystem && firstNonSystem.role !== 'user') {
      throw new Error(
        'MessageBuilder: first non-system message must be a user message',
      )
    }

    return [...this.messages]
  }

  /** Current number of messages in the builder */
  get length(): number {
    return this.messages.length
  }

  /**
   * Validate that we're not adding two consecutive assistant messages.
   * Consecutive user messages are allowed (user text + tool results).
   */
  private validateNotConsecutive(role: 'user' | 'assistant'): void {
    if (this.messages.length === 0) return

    const last = this.messages[this.messages.length - 1]!
    if (last.role === role && role === 'assistant') {
      throw new Error(
        `MessageBuilder: cannot add consecutive ${role} messages`,
      )
    }
  }
}

/**
 * Create a MessageBuilder instance (convenience function).
 */
export function messageBuilder(): MessageBuilder {
  return new MessageBuilder()
}
