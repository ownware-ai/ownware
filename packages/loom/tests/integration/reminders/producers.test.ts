/**
 * Integration test — Tier 1 reminder producers
 *
 * Proves the producers wired in `core/loop.ts` actually emit reminders
 * that reach the next outgoing message:
 *   1. `tool.denied` fires on permission denial (policy-deny path).
 *   2. `tool.denied` fires on user-rejected approval (HITL deny path).
 *   3. `extractActiveSkillNames` extracts skill names from message history.
 *
 * Compaction-driven producers (`compaction.done`, `skills.previously-invoked`)
 * and `budget.warn` are intentionally not covered here — they need
 * heavier session setup (forced compaction / context-window saturation)
 * and are validated end-to-end via the OpenRouter milestone.
 */

import { describe, it, expect } from 'vitest'

import { Session } from '../../../src/core/session.js'
import { createDefaultConfig } from '../../../src/core/config.js'
import { extractActiveSkillNames } from '../../../src/core/loop.js'
import {
  ReminderInjector,
  createDefaultRegistry as createDefaultReminderRegistry,
} from '../../../src/reminders/index.js'
import { defineTool } from '../../../src/tools/types.js'

import type { Tool } from '../../../src/tools/types.js'
import type {
  Message,
  ContentBlock,
  ToolResultBlock,
} from '../../../src/messages/types.js'
import type {
  ProviderAdapter,
  ProviderChunk,
  ProviderFeature,
  ProviderRequest,
  ToolDefinition,
} from '../../../src/provider/types.js'

const MODEL = 'mock:test'

interface ToolCallProvider extends ProviderAdapter {
  streamRequests: ProviderRequest[]
}

function createOneToolCallProvider(toolName: string, toolInput: Record<string, unknown>): ToolCallProvider {
  const requests: ProviderRequest[] = []
  let call = 0
  const provider: ToolCallProvider = {
    name: 'mock-deny-test',
    streamRequests: requests,

    async *stream(request: ProviderRequest): AsyncGenerator<ProviderChunk> {
      requests.push(request)
      call++

      if (call === 1) {
        const id = `toolu_${call}`
        yield { type: 'tool_use_start', id, name: toolName }
        yield { type: 'tool_use_args_delta', id, delta: JSON.stringify(toolInput) }
        yield { type: 'tool_use_end', id }
        yield {
          type: 'message_complete',
          content: [{ type: 'tool_use', id, name: toolName, input: toolInput }],
          stopReason: 'tool_use',
          usage: { inputTokens: 50, outputTokens: 25, cacheReadTokens: 0, cacheCreationTokens: 0 },
        }
        return
      }

      yield { type: 'text_delta', text: 'done' }
      yield {
        type: 'message_complete',
        content: [{ type: 'text', text: 'done' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 50, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
      }
    },

    async countTokens(messages: Message[]): Promise<number> {
      return messages.length * 50
    },
    supportsFeature(_feature: ProviderFeature): boolean { return true },
    formatTools(tools: ToolDefinition[]): unknown[] { return tools },
    getModelPricing(_model: string) { return null },
  }
  return provider
}

function flattenText(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content
  return content.map(b => (b.type === 'text' ? b.text : '')).join('\n')
}

function lastUserMessage(messages: readonly Message[]): Message {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m && m.role === 'user') return m
  }
  throw new Error('no user message in payload')
}

function makeRestrictedTool(executions: Array<Record<string, unknown>>): Tool {
  return defineTool({
    name: 'shell',
    description: 'Run a shell command.',
    isReadOnly: false,
    requiresPermission: true,
    inputSchema: {
      type: 'object',
      properties: { cmd: { type: 'string' } },
      required: ['cmd'],
    },
    async execute(input) {
      executions.push(input)
      return { content: 'executed', isError: false }
    },
  })
}

async function drain<T, R>(gen: AsyncGenerator<T, R>): Promise<R> {
  while (true) {
    const next = await gen.next()
    if (next.done) return next.value
  }
}

// ---------------------------------------------------------------------------
// tool.denied producer
// ---------------------------------------------------------------------------

describe('Producer: tool.denied (user-deny path)', () => {
  // Post-2026-05-14 redesign: the "policy deny" path no longer exists
  // — `PolicyDecision` is narrowed to `'allow' | 'ask'` (S1). The only
  // path that produces a tool.denied reminder is the user-driven
  // HITL deny. The earlier "policy deny" test case is deleted; the
  // user-deny case below is the canonical scenario.

  it('fires a tool.denied reminder when HITL approval returns false (with typed S4 reason)', async () => {
    const reminders = new ReminderInjector(createDefaultReminderRegistry())
    const executions: Array<Record<string, unknown>> = []
    const tool = makeRestrictedTool(executions)
    const provider = createOneToolCallProvider('shell', { cmd: 'ls' })

    const session = new Session({
      config: createDefaultConfig(MODEL),
      provider,
      tools: [tool],
      compaction: null,
      checkPermission: async () => 'ask',
      requestApproval: async () => false,
      reminders,
    })

    await drain(session.submitMessage('list files'))

    expect(executions).toEqual([])
    const flat = flattenText(lastUserMessage(provider.streamRequests[1]!.messages).content)
    expect(flat).toContain('"shell" was denied')
    // S4: the reminder body carries the formatted DecisionReason
    // (names the tool + the input + an actionable next step) instead
    // of the bare "User denied this action" literal.
    expect(flat).toMatch(/declined|surface|ask_user/i)
    expect(flat).toContain('shell')
  })

  it('does NOT fire tool.denied when permission is granted (no false positive)', async () => {
    const reminders = new ReminderInjector(createDefaultReminderRegistry())
    const executions: Array<Record<string, unknown>> = []
    const tool = makeRestrictedTool(executions)
    const provider = createOneToolCallProvider('shell', { cmd: 'ls' })

    const session = new Session({
      config: createDefaultConfig(MODEL),
      provider,
      tools: [tool],
      compaction: null,
      checkPermission: async () => 'allow',
      reminders,
    })

    await drain(session.submitMessage('list files'))

    expect(executions).toHaveLength(1)
    const flat = flattenText(lastUserMessage(provider.streamRequests[1]!.messages).content)
    expect(flat).not.toContain('was denied')
  })
})

// ---------------------------------------------------------------------------
// extractActiveSkillNames helper
// ---------------------------------------------------------------------------

describe('extractActiveSkillNames', () => {
  it('returns an empty array when no skill calls are present', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    ]
    expect(extractActiveSkillNames(msgs)).toEqual([])
  })

  it('extracts unique skill names in first-seen order', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'work' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: '1', name: 'skill', input: { name: 'simplify' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: '1', content: '...', isError: false }],
      },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: '2', name: 'skill', input: { name: 'review' } },
          { type: 'tool_use', id: '3', name: 'skill', input: { name: 'simplify' } }, // dupe
        ],
      },
    ]
    expect(extractActiveSkillNames(msgs)).toEqual(['simplify', 'review'])
  })

  it('ignores tool_use blocks for non-skill tools', () => {
    const msgs: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: '1', name: 'shell', input: { cmd: 'ls' } },
          { type: 'tool_use', id: '2', name: 'skill', input: { name: 'simplify' } },
        ],
      },
    ]
    expect(extractActiveSkillNames(msgs)).toEqual(['simplify'])
  })

  it('ignores skill tool_use with non-string name input', () => {
    const msgs: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: '1', name: 'skill', input: { name: 42 } },
          { type: 'tool_use', id: '2', name: 'skill', input: {} },
        ],
      },
    ]
    expect(extractActiveSkillNames(msgs)).toEqual([])
  })
})

// Suppress unused-import warning when ToolResultBlock isn't referenced below.
// (Kept to make the test file self-documenting about the message shape.)
const _toolResultBlockMarker: ToolResultBlock | undefined = undefined
void _toolResultBlockMarker
