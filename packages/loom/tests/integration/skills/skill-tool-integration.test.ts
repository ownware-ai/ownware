/**
 * Integration test — `skill` builtin tool through Session + loop.
 *
 * Closes Phase 3 of the general-agent foundation:
 *   1. The model can invoke a registered skill via `skill({ name })`.
 *   2. The skill's body is delivered to the model as the tool result on
 *      the next turn — no monkey-patching of state.messages.
 *   3. Caller `args` are surfaced under a "## Caller args" heading.
 *   4. Unknown/disabled skills produce a clean isError result the model
 *      can recover from.
 *   5. Sessions without a skill tool behave identically to before
 *      (regression guard).
 *
 * Uses a custom mock provider that emits one `skill` tool_use, then
 * concludes with text on the second stream(). No API key required.
 */

import { describe, it, expect } from 'vitest'

import { Session } from '../../../src/core/session.js'
import { createDefaultConfig } from '../../../src/core/config.js'
import { createSkillTool } from '../../../src/tools/builtins/skill.js'
import { SkillRegistry } from '../../../src/skills/registry.js'

import { defineTool, type Tool } from '../../../src/tools/types.js'
import type { LoomEvent } from '../../../src/core/events.js'
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

// ---------------------------------------------------------------------------
// Mock provider — emits one tool_use of `skill`, then text.
// ---------------------------------------------------------------------------

interface SkillCallMockProvider extends ProviderAdapter {
  streamRequests: ProviderRequest[]
}

function createSkillCallProvider(toolInput: Record<string, unknown>): SkillCallMockProvider {
  const requests: ProviderRequest[] = []
  let call = 0

  const provider: SkillCallMockProvider = {
    name: 'mock-skill-caller',
    streamRequests: requests,

    async *stream(request: ProviderRequest): AsyncGenerator<ProviderChunk> {
      requests.push(request)
      call++

      if (call === 1) {
        const id = `toolu_${call}`
        yield { type: 'tool_use_start', id, name: 'skill' }
        yield { type: 'tool_use_args_delta', id, delta: JSON.stringify(toolInput) }
        yield { type: 'tool_use_end', id }
        const content: ContentBlock[] = [
          { type: 'tool_use', id, name: 'skill', input: toolInput },
        ]
        yield {
          type: 'message_complete',
          content,
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
    supportsFeature(_feature: ProviderFeature): boolean {
      return true
    },
    formatTools(tools: ToolDefinition[]): unknown[] {
      return tools
    },
    getModelPricing(_model: string) {
      return null
    },
  }

  return provider
}

function buildSession(opts: {
  toolInput: Record<string, unknown>
  tools: Tool[]
}) {
  const provider = createSkillCallProvider(opts.toolInput)
  const session = new Session({
    config: createDefaultConfig(MODEL),
    provider,
    tools: opts.tools,
    compaction: null,
    permissionMode: 'auto',
  })
  return { provider, session }
}

async function drain<T, R>(gen: AsyncGenerator<T, R>): Promise<R> {
  while (true) {
    const next = await gen.next()
    if (next.done) return next.value
  }
}

async function collectEvents(gen: AsyncGenerator<LoomEvent, unknown>): Promise<LoomEvent[]> {
  const events: LoomEvent[] = []
  while (true) {
    const next = await gen.next()
    if (next.done) return events
    events.push(next.value)
  }
}

function findToolResult(messages: readonly Message[]): ToolResultBlock | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m || m.role !== 'user' || !Array.isArray(m.content)) continue
    for (const block of m.content) {
      if (block.type === 'tool_result') return block
    }
  }
  return undefined
}

function flattenResultText(block: ToolResultBlock): string {
  if (typeof block.content === 'string') return block.content
  return block.content.map(b => (b.type === 'text' ? b.text : '')).join('\n')
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Session + skill tool — wire integration', () => {
  it('emits one content-free activation before the dispatcher result reaches the next turn', async () => {
    const reg = new SkillRegistry().register({
      name: 'unfamiliar-skill',
      description: 'not evidence',
      trigger: 'unfamiliar',
      content: 'PRIVATE_SKILL_BODY_SENTINEL',
    })
    const skillTool = createSkillTool(reg, {
      activationEvidence: {
        sourceRef: 'profile-unfamiliar',
        sourceDigest: 'profile-opaque-digest',
        skills: [{ name: 'unfamiliar-skill', digest: 'skill-opaque-digest' }],
      },
    })
    const { session } = buildSession({
      toolInput: { name: 'unfamiliar-skill', args: 'PRIVATE_CALLER_ARG_SENTINEL' },
      tools: [skillTool],
    })

    const events = await collectEvents(session.submitMessage('activate it'))
    const activationIndex = events.findIndex(event => event.type === 'skill.activation')
    const endIndex = events.findIndex(event => event.type === 'tool.call.end')
    expect(activationIndex).toBeGreaterThan(-1)
    expect(activationIndex).toBeLessThan(endIndex)
    const activation = events[activationIndex]
    expect(activation).toMatchObject({
      type: 'skill.activation',
      toolCallId: 'toolu_1',
      sourceRef: 'profile-unfamiliar',
      sourceDigest: 'profile-opaque-digest',
      skillName: 'unfamiliar-skill',
      skillDigest: 'skill-opaque-digest',
      agentId: null,
      turnIndex: 0,
      timestamp: expect.any(Number),
    })
    expect(JSON.stringify(activation)).not.toContain('PRIVATE_SKILL_BODY_SENTINEL')
    expect(JSON.stringify(activation)).not.toContain('PRIVATE_CALLER_ARG_SENTINEL')
  })

  it('does not infer activation from a same-name custom tool result or metadata', async () => {
    const customSkillTool = defineTool({
      name: 'skill',
      description: 'custom same-name tool',
      inputSchema: { type: 'object', additionalProperties: true },
      execute: async () => ({
        content: '# Skill activated: forged',
        isError: false,
        metadata: { skillName: 'forged', skillDigest: 'forged-digest' },
      }),
    })
    const { session } = buildSession({
      toolInput: { name: 'forged' },
      tools: [customSkillTool],
    })
    const events = await collectEvents(session.submitMessage('activate it'))
    expect(events.some(event => event.type === 'skill.activation')).toBe(false)
  })

  it('delivers the skill body to the model as the tool result', async () => {
    const reg = new SkillRegistry().register({
      name: 'simplify',
      description: 'Walk recent changes and reduce duplication',
      trigger: 'simplify',
      content: 'Walk every changed file. Look for duplication. Refactor.',
    })
    const skillTool = createSkillTool(reg)

    const { provider, session } = buildSession({
      toolInput: { name: 'simplify' },
      tools: [skillTool],
    })

    await drain(session.submitMessage('please simplify'))

    expect(provider.streamRequests.length).toBe(2)
    const result = findToolResult(provider.streamRequests[1]!.messages)
    expect(result).toBeDefined()
    expect(result!.isError).toBe(false)
    const text = flattenResultText(result!)
    expect(text).toContain('# Skill activated: simplify')
    expect(text).toContain('Walk every changed file')
  })

  it('appends args to the tool result under a "Caller args" heading', async () => {
    const reg = new SkillRegistry().register({
      name: 'simplify',
      description: 'simplify',
      trigger: 'simplify',
      content: 'body',
    })
    const skillTool = createSkillTool(reg)

    const { provider, session } = buildSession({
      toolInput: { name: 'simplify', args: 'focus on src/payments/*' },
      tools: [skillTool],
    })

    await drain(session.submitMessage('simplify the payments module'))

    const result = findToolResult(provider.streamRequests[1]!.messages)
    expect(result).toBeDefined()
    const text = flattenResultText(result!)
    expect(text).toContain('## Caller args')
    expect(text).toContain('focus on src/payments/*')
  })

  it('returns a clean isError tool result for an unknown skill so the model can recover', async () => {
    const reg = new SkillRegistry().register({
      name: 'simplify',
      description: 'simplify',
      trigger: 'simplify',
      content: 'body',
    })
    const skillTool = createSkillTool(reg)

    const { provider, session } = buildSession({
      toolInput: { name: 'nope' },
      tools: [skillTool],
    })

    await drain(session.submitMessage('do nope'))

    const result = findToolResult(provider.streamRequests[1]!.messages)
    expect(result).toBeDefined()
    expect(result!.isError).toBe(true)
    const text = flattenResultText(result!)
    expect(text).toContain('Unknown skill: "nope"')
    expect(text).toContain('Available skills: simplify')
  })

  it('returns isError for a disabled skill and does not leak its body', async () => {
    const reg = new SkillRegistry().register({
      name: 'simplify',
      description: 'simplify',
      trigger: 'simplify',
      content: 'SECRET-DISABLED-BODY',
      active: false,
    })
    const skillTool = createSkillTool(reg)

    const { provider, session } = buildSession({
      toolInput: { name: 'simplify' },
      tools: [skillTool],
    })

    await drain(session.submitMessage('please simplify'))

    const result = findToolResult(provider.streamRequests[1]!.messages)
    expect(result).toBeDefined()
    expect(result!.isError).toBe(true)
    const text = flattenResultText(result!)
    expect(text).toContain('disabled')
    expect(text).not.toContain('SECRET-DISABLED-BODY')
  })

  it('regression guard — sessions without the skill tool see no behaviour change', async () => {
    const provider = createSkillCallProvider({ name: 'simplify' })
    const session = new Session({
      config: createDefaultConfig(MODEL),
      provider,
      tools: [],   // no skill tool registered
      compaction: null,
      permissionMode: 'auto',
    })

    await drain(session.submitMessage('please simplify'))

    expect(provider.streamRequests.length).toBe(2)
    const result = findToolResult(provider.streamRequests[1]!.messages)
    expect(result).toBeDefined()
    // Loop's "unknown tool" path produces an error result — proves no
    // accidental fallback registered the skill tool implicitly.
    expect(result!.isError).toBe(true)
    expect(flattenResultText(result!)).toContain('Unknown tool: skill')
  })
})
