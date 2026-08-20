import type { ChatState, Message, MessagePart, ToolCall } from './types.js'
import type { ToolUIDescriptor } from './descriptors.js'
import { normalizeToolUIDescriptor } from './descriptors.js'
import { seedReplayCursor } from './reducer.js'

export interface HydratedToolCall {
  readonly toolCallId?: string
  readonly name: string
  readonly input: unknown
  readonly output?: string
  readonly isError?: boolean
  readonly durationMs?: number
  readonly uiDescriptor?: ToolUIDescriptor
}

export interface HydratedMessage {
  readonly id: string
  readonly role: 'user' | 'assistant' | 'tool_result' | 'system' | 'error'
  readonly content: string
  readonly thinking?: string
  readonly tools?: readonly HydratedToolCall[]
  readonly parts?: readonly MessagePart[]
}

export interface ChatHydration {
  readonly messages: readonly HydratedMessage[]
  /** Authoritative cursor immediately after the last closed durable turn. */
  readonly lastClosedTurnEndSeq: number
}

/**
 * Replace transcript rows from an authoritative hydrate response, then seed
 * replay at the last closed turn. Open-turn events are deliberately rebuilt
 * from SSE so pending decisions and partial output retain their exact order.
 */
export function hydrateChatState(state: ChatState, hydration: ChatHydration): ChatState {
  if (
    !Number.isSafeInteger(hydration.lastClosedTurnEndSeq)
    || hydration.lastClosedTurnEndSeq < 0
    || !Array.isArray(hydration.messages)
  ) return state

  const messages: Message[] = []
  for (const row of hydration.messages) {
    if (!isHydratedMessage(row)) return state
    if (row.role !== 'user' && row.role !== 'assistant') continue
    const toolCalls: ToolCall[] = []
    let correlatable = true
    if (row.role === 'assistant') {
      for (const [index, tool] of (row.tools ?? []).entries()) {
        const normalized = normalizeHydratedTool(tool, row.id, index)
        if (!normalized) return state
        // A record without its own id cannot be referenced by a `parts` entry.
        if (tool.toolCallId === undefined) correlatable = false
        toolCalls.push(normalized)
      }
    }
    // `parts` cross-references tools by stable id. If any record in this turn
    // lacks one, every `{kind:'tool'}` entry would miss its record and render
    // as unavailable — worse than the legacy layout, which shows the same
    // tools correctly. Drop the ordering rather than fabricate a correlation.
    const rowParts: readonly MessagePart[] = row.parts ?? []
    const referencesTools = rowParts.some((part) => part.kind === 'tool')
    const parts = row.parts !== undefined && (correlatable || !referencesTools)
      ? rowParts.map(copyMessagePart)
      : undefined
    messages.push({
      id: row.id,
      role: row.role,
      text: row.content,
      ...(row.thinking === undefined ? {} : { thinking: row.thinking }),
      toolCalls,
      ...(parts === undefined ? {} : { parts }),
      streaming: false,
    })
  }

  return seedReplayCursor({
    ...state,
    messages,
    status: 'idle',
    error: undefined,
    pendingApproval: null,
    pendingApprovals: [],
    pendingSensitiveInput: null,
    pendingSensitiveInputs: [],
  }, hydration.lastClosedTurnEndSeq)
}

function isHydratedMessage(value: HydratedMessage): boolean {
  return isRecord(value)
    && typeof value.id === 'string'
    && value.id.length > 0
    && (value.role === 'user'
      || value.role === 'assistant'
      || value.role === 'tool_result'
      || value.role === 'system'
      || value.role === 'error')
    && typeof value.content === 'string'
    && (value.thinking === undefined || typeof value.thinking === 'string')
    && (value.tools === undefined || (
      Array.isArray(value.tools)
      && value.tools.every(tool => isRecord(tool))
    ))
    && (value.parts === undefined || (
      Array.isArray(value.parts)
      && value.parts.every(isMessagePart)
    ))
}

function normalizeHydratedTool(
  tool: HydratedToolCall,
  messageId: string,
  index: number,
): ToolCall | undefined {
  if (
    !isRecord(tool)
    || typeof tool.name !== 'string'
    || tool.name.length === 0
    || (tool.toolCallId !== undefined && (
      typeof tool.toolCallId !== 'string' || tool.toolCallId.length === 0
    ))
    || (tool.output !== undefined && typeof tool.output !== 'string')
    || (tool.isError !== undefined && typeof tool.isError !== 'boolean')
    || (tool.durationMs !== undefined && (
      typeof tool.durationMs !== 'number'
      || !Number.isFinite(tool.durationMs)
      || tool.durationMs < 0
    ))
  ) return undefined
  const descriptor = normalizeToolUIDescriptor(tool.uiDescriptor)
  if (tool.uiDescriptor !== undefined && descriptor === undefined) return undefined
  return {
    id: tool.toolCallId ?? `${messageId}-tool-${index}`,
    name: tool.name,
    input: isRecord(tool.input) ? tool.input : {},
    status: tool.isError === true ? 'error' : 'done',
    ...(tool.output === undefined ? {} : { result: tool.output }),
    ...(tool.isError === undefined ? {} : { isError: tool.isError }),
    ...(tool.durationMs === undefined ? {} : { durationMs: tool.durationMs }),
    ...(descriptor === undefined ? {} : { uiDescriptor: descriptor }),
  }
}

function isMessagePart(value: unknown): value is MessagePart {
  if (!isRecord(value)) return false
  switch (value.kind) {
    case 'text':
    case 'thinking':
      return typeof value.text === 'string'
    case 'tool':
      return typeof value.toolCallId === 'string' && value.toolCallId.length > 0
    case 'subagent':
      return typeof value.agentId === 'string' && value.agentId.length > 0
    case 'permission':
    case 'credential':
      return typeof value.requestId === 'string' && value.requestId.length > 0
    default:
      return false
  }
}

function copyMessagePart(part: MessagePart): MessagePart {
  return { ...part }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
