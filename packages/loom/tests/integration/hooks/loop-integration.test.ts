/**
 * Integration test — Hook runtime wired through Session + loop.
 *
 * Closes Phase 2 of the general-agent foundation:
 *   1. session.start hooks fire once at the top of every Session run.
 *   2. tool.pre hooks gate tool execution. A block synthesizes a
 *      denied tool_result; the actual tool never executes.
 *   3. tool.post hooks observe successful tool runs. Their
 *      additionalContext flows back to the model as a `hook.context`
 *      reminder on the next turn.
 *   4. tool.post does NOT fire when tool.pre blocks (semantically
 *      correct: nothing executed, so nothing to post-process).
 *   5. Sessions without a hook runtime behave identically to before
 *      (regression guard).
 *
 * Uses a custom mock provider that emits a single tool call on the
 * first stream(), then concludes with text on the second stream().
 * No API key required.
 */

import { describe, it, expect } from 'vitest'

import { Session } from '../../../src/core/session.js'
import { createDefaultConfig } from '../../../src/core/config.js'
import {
  ReminderInjector,
  createDefaultRegistry as createDefaultReminderRegistry,
} from '../../../src/reminders/index.js'
import {
  HookRegistry,
  HookRuntime,
} from '../../../src/hooks/index.js'

import type { Tool } from '../../../src/tools/types.js'
import type { Message, ContentBlock } from '../../../src/messages/types.js'
import type {
  ProviderAdapter,
  ProviderChunk,
  ProviderFeature,
  ProviderRequest,
  ToolDefinition,
} from '../../../src/provider/types.js'

const MODEL = 'mock:test'

// ---------------------------------------------------------------------------
// Mock provider that emits one tool_use, then concludes with text.
// ---------------------------------------------------------------------------

interface ToolThenTextMockProvider extends ProviderAdapter {
  streamRequests: ProviderRequest[]
}

function createToolThenTextProvider(
  toolName: string,
  toolInput: Record<string, unknown>,
): ToolThenTextMockProvider {
  const requests: ProviderRequest[] = []
  let call = 0

  const provider: ToolThenTextMockProvider = {
    name: 'mock-tool-then-text',
    streamRequests: requests,

    async *stream(request: ProviderRequest): AsyncGenerator<ProviderChunk> {
      requests.push(request)
      call++

      if (call === 1) {
        const toolUseId = `toolu_${call}`
        yield { type: 'tool_use_start', id: toolUseId, name: toolName }
        yield { type: 'tool_use_args_delta', id: toolUseId, delta: JSON.stringify(toolInput) }
        yield { type: 'tool_use_end', id: toolUseId }
        const content: ContentBlock[] = [
          { type: 'tool_use', id: toolUseId, name: toolName, input: toolInput },
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
      const content: ContentBlock[] = [{ type: 'text', text: 'done' }]
      yield {
        type: 'message_complete',
        content,
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

// A minimal "shell" tool. Records executions so tests can assert on them.
function createShellTool(): { tool: Tool; executions: Array<Record<string, unknown>> } {
  const executions: Array<Record<string, unknown>> = []
  const tool: Tool = {
    name: 'shell',
    description: 'Run a shell command',
    inputSchema: {
      type: 'object',
      properties: { cmd: { type: 'string' } },
      required: ['cmd'],
    },
    isReadOnly: false,
    requiresPermission: false,
    async execute(input) {
      executions.push(input)
      return { content: `executed: ${String((input as { cmd: string }).cmd)}`, isError: false }
    },
  }
  return { tool, executions }
}

function buildSession(opts: {
  hooks?: HookRuntime
  reminders?: ReminderInjector
  toolName: string
  toolInput: Record<string, unknown>
  tools: Tool[]
}) {
  const provider = createToolThenTextProvider(opts.toolName, opts.toolInput)
  const config = createDefaultConfig(MODEL)
  const session = new Session({
    config,
    provider,
    tools: opts.tools,
    compaction: null,
    permissionMode: 'auto',
    ...(opts.hooks ? { hooks: opts.hooks } : {}),
    ...(opts.reminders ? { reminders: opts.reminders } : {}),
  })
  return { provider, session }
}

async function drain<T, R>(gen: AsyncGenerator<T, R>): Promise<R> {
  while (true) {
    const next = await gen.next()
    if (next.done) return next.value
  }
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Session + HookRuntime — wire integration', () => {
  it('runs session.start hooks once per loop run', async () => {
    let hits = 0
    const reg = new HookRegistry()
    reg.register('session.start', {
      type: 'fn',
      name: 'count-starts',
      fn: () => {
        hits++
        return { continue: true }
      },
    })
    const hooks = new HookRuntime({ registry: reg })

    const { tool } = createShellTool()
    const { session } = buildSession({
      hooks,
      toolName: 'shell',
      toolInput: { cmd: 'ls' },
      tools: [tool],
    })

    await drain(session.submitMessage('do work'))
    expect(hits).toBe(1)

    await drain(session.submitMessage('more work'))
    expect(hits).toBe(2)
  })

  it('blocks tool execution when tool.pre returns continue:false', async () => {
    const reg = new HookRegistry()
    reg.register('tool.pre', {
      type: 'fn',
      name: 'no-rm',
      fn: (ctx) => {
        if (ctx.event !== 'tool.pre') return { continue: true }
        const cmd = String((ctx.toolInput as { cmd?: unknown }).cmd ?? '')
        if (cmd.includes('rm')) return { continue: false, reason: 'destructive command refused' }
        return { continue: true }
      },
    })
    const hooks = new HookRuntime({ registry: reg })
    const { tool, executions } = createShellTool()

    const { session, provider } = buildSession({
      hooks,
      toolName: 'shell',
      toolInput: { cmd: 'rm -rf /' },
      tools: [tool],
    })

    await drain(session.submitMessage('clean up'))

    // Tool MUST NOT have executed
    expect(executions).toEqual([])

    // Provider must have been called twice (initial tool_use, then resume)
    expect(provider.streamRequests.length).toBe(2)

    // The second request's tool_result content carries the block reason
    const secondRequest = provider.streamRequests[1]!
    const toolResultMsg = secondRequest.messages.find(
      m => m.role === 'user' && Array.isArray(m.content) && m.content.some(b => b.type === 'tool_result'),
    )
    expect(toolResultMsg).toBeDefined()
    const toolResult = (toolResultMsg!.content as ContentBlock[]).find(b => b.type === 'tool_result')
    expect(toolResult).toBeDefined()
    if (toolResult && toolResult.type === 'tool_result') {
      const content = typeof toolResult.content === 'string'
        ? toolResult.content
        : flattenText(toolResult.content)
      expect(content).toContain('destructive command refused')
    }
  })

  it('emits hook.blocked reminder onto the next turn when tool.pre blocks', async () => {
    const reminders = new ReminderInjector(createDefaultReminderRegistry())
    const reg = new HookRegistry()
    reg.register('tool.pre', {
      type: 'fn',
      name: 'no-rm',
      fn: () => ({ continue: false, reason: 'destructive command refused' }),
    })
    const hooks = new HookRuntime({ registry: reg, reminders })
    const { tool } = createShellTool()

    const { session, provider } = buildSession({
      hooks,
      reminders,
      toolName: 'shell',
      toolInput: { cmd: 'rm -rf /' },
      tools: [tool],
    })

    await drain(session.submitMessage('clean up'))

    // The 2nd request's last user message should contain a hook.blocked reminder
    const flat = flattenText(lastUserMessage(provider.streamRequests[1]!.messages).content)
    expect(flat).toContain('<system-reminder>')
    expect(flat).toContain('Hook "no-rm" blocked the action: destructive command refused')
  })

  it('runs tool.post after a successful tool execution and surfaces additionalContext', async () => {
    const reminders = new ReminderInjector(createDefaultReminderRegistry())
    const reg = new HookRegistry()
    let postCalled = 0
    reg.register('tool.post', {
      type: 'fn',
      name: 'audit',
      fn: (ctx) => {
        postCalled++
        if (ctx.event !== 'tool.post') return { continue: true }
        return { continue: true, additionalContext: `audited ${ctx.toolName}` }
      },
    })
    const hooks = new HookRuntime({ registry: reg, reminders })
    const { tool, executions } = createShellTool()

    const { session, provider } = buildSession({
      hooks,
      reminders,
      toolName: 'shell',
      toolInput: { cmd: 'ls' },
      tools: [tool],
    })

    await drain(session.submitMessage('list'))

    expect(executions).toEqual([{ cmd: 'ls' }])
    expect(postCalled).toBe(1)

    const flat = flattenText(lastUserMessage(provider.streamRequests[1]!.messages).content)
    expect(flat).toContain('Additional context from hook "audit"')
    expect(flat).toContain('audited shell')
  })

  it('does NOT fire tool.post when tool.pre blocked the call', async () => {
    const reg = new HookRegistry()
    let postCalled = 0
    reg.register('tool.pre', {
      type: 'fn',
      name: 'gatekeeper',
      fn: () => ({ continue: false, reason: 'always block' }),
    })
    reg.register('tool.post', {
      type: 'fn',
      name: 'should-not-run',
      fn: () => {
        postCalled++
        return { continue: true }
      },
    })
    const hooks = new HookRuntime({ registry: reg })
    const { tool } = createShellTool()

    const { session } = buildSession({
      hooks,
      toolName: 'shell',
      toolInput: { cmd: 'ls' },
      tools: [tool],
    })

    await drain(session.submitMessage('list'))

    expect(postCalled).toBe(0)
  })

  it('fires model.pre before each provider call and model.post after each response', async () => {
    const pres: Array<{ model: string; messageCount: number }> = []
    const posts: Array<{ stopReason: string; toolCallCount: number; outputTokens: number }> = []
    const reg = new HookRegistry()
    reg.register('model.pre', {
      type: 'fn',
      name: 'pre-meter',
      fn: (ctx) => {
        if (ctx.event === 'model.pre') pres.push({ model: ctx.model, messageCount: ctx.messageCount })
        return { continue: true }
      },
    })
    reg.register('model.post', {
      type: 'fn',
      name: 'post-meter',
      fn: (ctx) => {
        if (ctx.event === 'model.post') {
          posts.push({ stopReason: ctx.stopReason, toolCallCount: ctx.toolCallCount, outputTokens: ctx.outputTokens })
        }
        return { continue: true }
      },
    })
    const hooks = new HookRuntime({ registry: reg })
    const { tool } = createShellTool()
    const { session } = buildSession({
      hooks,
      toolName: 'shell',
      toolInput: { cmd: 'ls' },
      tools: [tool],
    })

    await drain(session.submitMessage('list'))

    // The mock provider is called twice (tool_use turn, then final text).
    expect(pres).toHaveLength(2)
    expect(pres[0]!.model).toBe(MODEL)
    expect(pres[0]!.messageCount).toBeGreaterThan(0)
    expect(posts).toHaveLength(2)
    expect(posts[0]).toMatchObject({ stopReason: 'tool_use', toolCallCount: 1 })
    expect(posts[1]).toMatchObject({ stopReason: 'end_turn', toolCallCount: 0 })
    expect(posts[0]!.outputTokens).toBe(25)
  })

  it('model.pre additionalContext lands on THIS request (fired before the reminder drain)', async () => {
    const reminders = new ReminderInjector(createDefaultReminderRegistry())
    const reg = new HookRegistry()
    reg.register('model.pre', {
      type: 'fn',
      name: 'fresh-data',
      fn: () => ({ continue: true, additionalContext: 'inventory: 42 units in stock' }),
    })
    const hooks = new HookRuntime({ registry: reg, reminders })
    const { tool } = createShellTool()
    const { session, provider } = buildSession({
      hooks,
      reminders,
      toolName: 'shell',
      toolInput: { cmd: 'ls' },
      tools: [tool],
    })

    await drain(session.submitMessage('how much stock?'))

    // The FIRST request already carries the injected context — not the next one.
    const flat = flattenText(lastUserMessage(provider.streamRequests[0]!.messages).content)
    expect(flat).toContain('inventory: 42 units in stock')
  })

  it('ignores continue:false from model hooks — informational, the call proceeds', async () => {
    const reg = new HookRegistry()
    reg.register('model.pre', {
      type: 'fn',
      name: 'futile-veto',
      fn: () => ({ continue: false, reason: 'trying to stop the model' }),
    })
    const hooks = new HookRuntime({ registry: reg })
    const { tool, executions } = createShellTool()
    const { session, provider } = buildSession({
      hooks,
      toolName: 'shell',
      toolInput: { cmd: 'ls' },
      tools: [tool],
    })

    await drain(session.submitMessage('list'))

    // The run completed normally despite the "block".
    expect(provider.streamRequests.length).toBe(2)
    expect(executions).toEqual([{ cmd: 'ls' }])
  })

  it('fires session.end hooks once, with reason end_turn, on a normal run', async () => {
    const seen: Array<{ event: string; reason?: string; sessionId?: string }> = []
    const reg = new HookRegistry()
    reg.register('session.end', {
      type: 'fn',
      name: 'on-complete',
      fn: (ctx) => {
        if (ctx.event === 'session.end') {
          seen.push({ event: ctx.event, reason: ctx.reason, sessionId: ctx.sessionId })
        }
        return { continue: true }
      },
    })
    const hooks = new HookRuntime({ registry: reg })
    const { tool } = createShellTool()
    const { session } = buildSession({
      hooks,
      toolName: 'shell',
      toolInput: { cmd: 'ls' },
      tools: [tool],
    })

    await drain(session.submitMessage('list'))

    expect(seen).toHaveLength(1)
    expect(seen[0]!.reason).toBe('end_turn')
    expect(seen[0]!.sessionId).toBeTruthy()
  })

  it('fires session.end hooks with reason aborted — an aborted run still owes its audit hook', async () => {
    const reasons: string[] = []
    const reg = new HookRegistry()
    reg.register('session.end', {
      type: 'fn',
      name: 'abort-audit',
      fn: (ctx) => {
        if (ctx.event === 'session.end') reasons.push(ctx.reason)
        return { continue: true }
      },
    })
    const hooks = new HookRuntime({ registry: reg })
    const { tool } = createShellTool()
    const { session } = buildSession({
      hooks,
      toolName: 'shell',
      toolInput: { cmd: 'ls' },
      tools: [tool],
    })

    const gen = session.submitMessage('work')
    await gen.next() // consume session.start, then abort mid-run
    session.abort('user')
    await drain(gen)

    expect(reasons).toEqual(['aborted'])
  })

  it('fires error hooks then session.end(reason=error) on an unrecoverable provider failure', async () => {
    const fired: string[] = []
    let errorCtx: { code: string; message: string } | null = null
    const reg = new HookRegistry()
    reg.register('error', {
      type: 'fn',
      name: 'on-error',
      fn: (ctx) => {
        fired.push('error')
        if (ctx.event === 'error') errorCtx = { code: ctx.code, message: ctx.message }
        return { continue: true }
      },
    })
    reg.register('session.end', {
      type: 'fn',
      name: 'on-end',
      fn: (ctx) => {
        if (ctx.event === 'session.end') fired.push(`session.end:${ctx.reason}`)
        return { continue: true }
      },
    })
    const hooks = new HookRuntime({ registry: reg })

    const throwingProvider: ProviderAdapter = {
      name: 'mock-throwing',
      // eslint-disable-next-line require-yield
      async *stream(): AsyncGenerator<ProviderChunk> {
        throw new Error('provider exploded')
      },
      async countTokens(): Promise<number> {
        return 0
      },
      supportsFeature(): boolean {
        return true
      },
      formatTools(tools: ToolDefinition[]): unknown[] {
        return tools
      },
      getModelPricing() {
        return null
      },
    }
    const session = new Session({
      config: createDefaultConfig(MODEL),
      provider: throwingProvider,
      tools: [],
      compaction: null,
      permissionMode: 'auto',
      hooks,
    })

    await drain(session.submitMessage('boom'))

    // error hook fires BEFORE the session.end hook, exactly once each.
    expect(fired).toEqual(['error', 'session.end:error'])
    expect(errorCtx).not.toBeNull()
    expect(errorCtx!.message).toContain('provider exploded')
  })

  it('ignores continue:false from session.end hooks — informational, post-hooks cannot abort', async () => {
    const reg = new HookRegistry()
    reg.register('session.end', {
      type: 'fn',
      name: 'futile-block',
      fn: () => ({ continue: false, reason: 'trying to block the past' }),
    })
    const hooks = new HookRuntime({ registry: reg })
    const { tool, executions } = createShellTool()
    const { session } = buildSession({
      hooks,
      toolName: 'shell',
      toolInput: { cmd: 'ls' },
      tools: [tool],
    })

    // Must complete normally — the block result is ignored, nothing throws,
    // the session.end event still reaches consumers.
    const events: string[] = []
    const gen = session.submitMessage('list')
    while (true) {
      const next = await gen.next()
      if (next.done) break
      events.push(next.value.type)
    }
    expect(executions).toEqual([{ cmd: 'ls' }])
    expect(events).toContain('session.end')
  })

  it('sessions without a hook runtime behave identically to before — regression guard', async () => {
    const { tool, executions } = createShellTool()
    const { session, provider } = buildSession({
      toolName: 'shell',
      toolInput: { cmd: 'ls' },
      tools: [tool],
    })

    const events: string[] = []
    const gen = session.submitMessage('list')
    while (true) {
      const next = await gen.next()
      if (next.done) break
      events.push(next.value.type)
    }

    // diagnostic: surface what actually happened in the loop
    expect(executions).toEqual([{ cmd: 'ls' }])
    expect(provider.streamRequests.length).toBe(2)
    const flat = flattenText(lastUserMessage(provider.streamRequests[1]!.messages).content)
    expect(flat).not.toContain('<system-reminder>')
  })
})
