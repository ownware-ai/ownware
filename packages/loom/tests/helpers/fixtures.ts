/**
 * Test message fixtures for compaction tests.
 */

import type {
  Message,
  UserMessage,
  AssistantMessage,
  SystemMessage,
  ContentBlock,
} from '../../src/messages/types.js'

export function systemMsg(content: string): SystemMessage {
  return { role: 'system', content }
}

export function userMsg(content: string): UserMessage {
  return { role: 'user', content }
}

export function assistantMsg(text: string): AssistantMessage {
  return { role: 'assistant', content: [{ type: 'text', text }] }
}

export function assistantToolUseMsg(
  name: string,
  input: Record<string, unknown> = {},
  id = `tool_${name}_${Date.now()}`,
): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'tool_use', id, name, input }],
  }
}

export function userToolResultMsg(
  toolUseId: string,
  content: string,
  isError = false,
): UserMessage {
  return {
    role: 'user',
    content: [{ type: 'tool_result', toolUseId, content, isError }],
  }
}

export function userImageMsg(): UserMessage {
  return {
    role: 'user',
    content: [
      { type: 'image', source: { type: 'url', url: 'https://example.com/img.png' } },
    ],
  }
}

/**
 * Create a realistic N-turn conversation.
 * Each turn = user message + assistant response.
 */
export function createConversation(
  turns: number,
  opts: { includeSystem?: boolean; includeTools?: boolean } = {},
): Message[] {
  const messages: Message[] = []

  if (opts.includeSystem) {
    messages.push(systemMsg('You are a helpful assistant.'))
  }

  for (let i = 0; i < turns; i++) {
    messages.push(userMsg(`User message for turn ${i + 1}`))

    if (opts.includeTools && i % 2 === 0) {
      const toolId = `tool_${i}`
      messages.push(assistantToolUseMsg('read_file', { path: `/src/file${i}.ts` }, toolId))
      messages.push(userToolResultMsg(toolId, `Contents of file${i}.ts`))
    }

    messages.push(assistantMsg(`Assistant response for turn ${i + 1}`))
  }

  return messages
}
