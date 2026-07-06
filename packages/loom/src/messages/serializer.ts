/**
 * Message Serializer
 *
 * Handles serialization/deserialization of message arrays for
 * persistence (checkpoints, logs, exports) and provider format conversion.
 *
 * Defensive: handles undefined fields, empty blocks, and malformed input
 * without throwing where possible.
 */

import type {
  Message,
  SystemMessage,
  UserMessage,
  AssistantMessage,
  ContentBlock,
} from './types.js'

// ---------------------------------------------------------------------------
// JSON serialization
// ---------------------------------------------------------------------------

/**
 * Serialize a message array to a JSON string.
 *
 * Strips undefined fields and protects against circular references.
 */
export function serializeMessages(messages: Message[]): string {
  return JSON.stringify(messages, circularReplacer(), 2)
}

/**
 * Deserialize a JSON string back to a validated message array.
 *
 * @throws Error if the JSON is malformed or doesn't contain a valid array
 */
export function deserializeMessages(json: string): Message[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (err) {
    throw new Error(
      `Failed to parse messages JSON: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  if (!Array.isArray(parsed)) {
    throw new Error(
      `Expected messages to be an array, got ${typeof parsed}`,
    )
  }

  const messages: Message[] = []
  for (let i = 0; i < parsed.length; i++) {
    const validated = validateMessage(parsed[i], i)
    if (validated) {
      messages.push(validated)
    }
  }

  return messages
}

// ---------------------------------------------------------------------------
// Provider format conversion
// ---------------------------------------------------------------------------

/** Supported provider names for format conversion. */
export type ProviderFormat = 'anthropic' | 'openai' | 'google'

/**
 * Convert Loom messages to a provider-specific format.
 *
 * - **anthropic**: Loom's native format — filters out system messages (sent separately)
 * - **openai**: `{ role, content, tool_calls }` format
 * - **google**: `{ role, parts }` format with functionCall/functionResponse
 */
export function serializeForProvider(
  messages: Message[],
  provider: ProviderFormat,
): unknown[] {
  switch (provider) {
    case 'anthropic':
      return serializeForAnthropic(messages)
    case 'openai':
      return serializeForOpenAI(messages)
    case 'google':
      return serializeForGoogle(messages)
  }
}

// ---------------------------------------------------------------------------
// Anthropic format (native — minimal transformation)
// ---------------------------------------------------------------------------

function serializeForAnthropic(messages: Message[]): unknown[] {
  // Anthropic sends system separately; strip it from the messages array
  return messages
    .filter(m => m.role !== 'system')
    .map(msg => ({ role: msg.role, content: msg.content }))
}

// ---------------------------------------------------------------------------
// OpenAI format
// ---------------------------------------------------------------------------

function serializeForOpenAI(messages: Message[]): unknown[] {
  const result: unknown[] = []

  for (const msg of messages) {
    if (msg.role === 'system') {
      result.push({ role: 'system', content: msg.content })
      continue
    }

    if (msg.role === 'user') {
      result.push({ role: 'user', content: normalizeUserContentForOpenAI(msg.content) })
      continue
    }

    // Assistant message
    const textParts: string[] = []
    const toolCalls: unknown[] = []

    for (const block of msg.content) {
      if (block.type === 'text') {
        textParts.push(block.text)
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input),
          },
        })
      }
      // thinking/image blocks have no OpenAI equivalent — skip
    }

    const openAIMsg: Record<string, unknown> = {
      role: 'assistant',
      content: textParts.join('') || null,
    }
    if (toolCalls.length > 0) {
      openAIMsg.tool_calls = toolCalls
    }
    result.push(openAIMsg)
  }

  return result
}

function normalizeUserContentForOpenAI(
  content: string | readonly ContentBlock[],
): string | unknown[] {
  if (typeof content === 'string') return content

  const parts: unknown[] = []
  for (const block of content) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text })
    } else if (block.type === 'image') {
      const url = block.source.type === 'url'
        ? block.source.url
        : `data:${block.source.mediaType};base64,${block.source.data}`
      parts.push({ type: 'image_url', image_url: { url } })
    } else if (block.type === 'tool_result') {
      const text = typeof block.content === 'string'
        ? block.content
        : JSON.stringify(block.content)
      parts.push({ type: 'text', text })
    }
  }

  // If single text part, flatten to string
  if (parts.length === 1) {
    const first = parts[0] as Record<string, unknown>
    if (first.type === 'text' && typeof first.text === 'string') {
      return first.text
    }
  }

  return parts
}

// ---------------------------------------------------------------------------
// Google (Gemini) format
// ---------------------------------------------------------------------------

function serializeForGoogle(messages: Message[]): unknown[] {
  const result: unknown[] = []

  for (const msg of messages) {
    if (msg.role === 'system') {
      // Gemini handles system instructions separately; encode as user marker
      result.push({ role: 'user', parts: [{ text: `[System]: ${msg.content}` }] })
      continue
    }

    const role = msg.role === 'assistant' ? 'model' : 'user'
    const parts: unknown[] = []

    if (typeof msg.content === 'string') {
      parts.push({ text: msg.content })
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        switch (block.type) {
          case 'text':
            parts.push({ text: block.text })
            break
          case 'tool_use':
            parts.push({ functionCall: { name: block.name, args: block.input } })
            break
          case 'tool_result': {
            const response = typeof block.content === 'string'
              ? { result: block.content }
              : block.content
            parts.push({ functionResponse: { name: block.toolUseId, response } })
            break
          }
          case 'image':
            if (block.source.type === 'base64') {
              parts.push({
                inlineData: { mimeType: block.source.mediaType, data: block.source.data },
              })
            }
            break
          // thinking/redacted_thinking — no Gemini equivalent
        }
      }
    }

    if (parts.length > 0) {
      result.push({ role, parts })
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a single raw parsed message and return a typed Message or null.
 */
function validateMessage(raw: unknown, index: number): Message | null {
  if (raw === null || typeof raw !== 'object') {
    console.warn(`Message at index ${index}: expected object, got ${typeof raw}`)
    return null
  }

  const obj = raw as Record<string, unknown>

  if (obj.role === 'system') {
    if (typeof obj.content !== 'string') {
      console.warn(`Message at index ${index}: system message content must be a string`)
      return null
    }
    return { role: 'system', content: obj.content } satisfies SystemMessage
  }

  if (obj.role === 'user') {
    if (typeof obj.content !== 'string' && !Array.isArray(obj.content)) {
      console.warn(`Message at index ${index}: user message content must be string or array`)
      return null
    }
    return { role: 'user', content: obj.content as string | ContentBlock[] } satisfies UserMessage
  }

  if (obj.role === 'assistant') {
    if (!Array.isArray(obj.content)) {
      console.warn(`Message at index ${index}: assistant message content must be an array`)
      return null
    }
    return { role: 'assistant', content: obj.content as ContentBlock[] } satisfies AssistantMessage
  }

  console.warn(`Message at index ${index}: unknown role "${String(obj.role)}"`)
  return null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * JSON replacer that handles circular references gracefully.
 */
function circularReplacer(): (key: string, value: unknown) => unknown {
  const seen = new WeakSet()
  return (_key: string, value: unknown) => {
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '[Circular]'
      seen.add(value)
    }
    return value
  }
}
