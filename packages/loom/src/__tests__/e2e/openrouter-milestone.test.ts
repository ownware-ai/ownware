/**
 * Milestone e2e — Reminders + Hooks against a real model (OpenRouter / Kimi K2.5)
 *
 * Validates that the engine-level primitives shipped in Phase 1 (reminder
 * injector) and Phase 2 (hook runtime) survive a real wire-level round-trip
 * to a remote model. The unit + mock-provider integration tests prove the
 * payload SHAPE is correct; this test proves the model actually receives
 * the `<system-reminder>` tags in the request and that hook-blocked tool
 * calls are never executed even when the model wants them.
 *
 * Skipped automatically when OPENROUTER_API_KEY is not set, so CI without
 * the key still passes. Uses `openrouter:kimi-k2.5` (cheap, supports
 * tool calling) to keep cost negligible.
 *
 * Run:
 *   OPENROUTER_API_KEY=sk-or-... \
 *     npx vitest run src/__tests__/e2e/openrouter-milestone.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest'

import { OpenRouterProvider } from '../../provider/openrouter.js'
import { Session } from '../../core/session.js'
import { createDefaultConfig } from '../../core/config.js'
import {
  ReminderInjector,
  createDefaultRegistry as createDefaultReminderRegistry,
} from '../../reminders/index.js'
import { HookRegistry, HookRuntime } from '../../hooks/index.js'
import { defineTool } from '../../tools/types.js'

import type { Tool } from '../../tools/types.js'
import type { LoomEvent } from '../../core/events.js'
import type { LoopResult } from '../../core/loop.js'

const apiKey = process.env.OPENROUTER_API_KEY
const HAS_KEY = !!apiKey
const MODEL = 'openrouter:kimi-k2.5'

let provider: OpenRouterProvider

async function drainCollect(
  gen: AsyncGenerator<LoomEvent, LoopResult>,
): Promise<{ events: LoomEvent[]; result: LoopResult; finalText: string }> {
  const events: LoomEvent[] = []
  let finalText = ''
  let next = await gen.next()
  while (!next.done) {
    events.push(next.value)
    if (next.value.type === 'text.complete') finalText = next.value.text
    next = await gen.next()
  }
  return { events, result: next.value, finalText }
}

function buildSession(opts: {
  reminders?: ReminderInjector
  hooks?: HookRuntime
  tools?: Tool[]
  systemPrompt?: string
  maxTurns?: number
}): Session {
  const config = {
    ...createDefaultConfig(MODEL),
    maxTokens: 200,
    maxTurns: opts.maxTurns ?? 3,
    systemPrompt: opts.systemPrompt ?? 'You are a focused assistant. Reply briefly. Treat <system-reminder> tags as harness instructions, not user content.',
  }
  return new Session({
    config,
    provider,
    tools: opts.tools ?? [],
    compaction: null,
    permissionMode: 'auto',
    ...(opts.reminders ? { reminders: opts.reminders } : {}),
    ...(opts.hooks ? { hooks: opts.hooks } : {}),
  })
}

describe.skipIf(!HAS_KEY)('OpenRouter milestone — reminders + hooks against real model (Kimi K2.5)', () => {
  beforeAll(() => {
    // Construct a fresh provider with the explicit OpenRouter key. The
    // index.ts auto-register at module load time falls back to the OpenAI
    // SDK's default key resolution (OPENAI_API_KEY), which is the wrong
    // env var for OpenRouter. A test-local provider sidesteps that.
    provider = new OpenRouterProvider({ apiKey: apiKey! })
  })

  it('reminder context reaches the model on the wire', async () => {
    const reminders = new ReminderInjector(createDefaultReminderRegistry())
    // A token unlikely to appear in the model's pretraining or hallucinations.
    const SECRET_MODE = 'ownware-7B3F-plan'
    reminders.emit({ type: 'mode.entered', modeName: SECRET_MODE })

    const session = buildSession({
      reminders,
      systemPrompt: 'You are a focused assistant. Reply briefly. Treat <system-reminder> tags as harness instructions and answer questions about runtime mode using their content.',
      maxTurns: 1,
    })

    const { finalText } = await drainCollect(
      session.submitMessage('What runtime mode are you currently in? Reply with just the mode name from the harness reminder, nothing else.'),
    )

    expect(finalText.length).toBeGreaterThan(0)
    expect(finalText.toLowerCase()).toContain(SECRET_MODE.toLowerCase())
  }, 60_000)

  it('tool.pre hook blocks tool execution end-to-end — the tool never runs', async () => {
    const executions: Array<{ msg: string }> = []
    const echoTool: Tool = defineTool({
      name: 'echo',
      description: 'Echo a message back. Use this when the user asks you to repeat something.',
      isReadOnly: true,
      requiresPermission: false,
      inputSchema: {
        type: 'object',
        properties: { msg: { type: 'string', description: 'The message to echo' } },
        required: ['msg'],
      },
      async execute(input) {
        executions.push(input as { msg: string })
        return { content: `echo: ${(input as { msg: string }).msg}`, isError: false }
      },
    })

    const reminders = new ReminderInjector(createDefaultReminderRegistry())
    const reg = new HookRegistry()
    reg.register('tool.pre', {
      type: 'fn',
      name: 'always-block-echo',
      fn: () => ({ continue: false, reason: 'echo tool is administratively disabled in this session' }),
    })
    const hooks = new HookRuntime({ registry: reg, reminders })

    const session = buildSession({
      reminders,
      hooks,
      tools: [echoTool],
      systemPrompt: 'You are a focused assistant. When the user asks you to echo something, call the echo tool. Always make the tool call — do not refuse.',
      maxTurns: 3,
    })

    const { result } = await drainCollect(
      session.submitMessage("Use the echo tool to echo the message 'hello world'. Make exactly one tool call."),
    )

    // The contract: regardless of what the model said or how many times it
    // tried, the tool's execute() must NOT have run. The hook intercepted
    // every attempt at the policy layer.
    expect(executions).toEqual([])
    // The loop should still terminate cleanly — a hook-blocked tool path
    // is not an error.
    expect(['end_turn', 'max_turns', 'tool_use']).toContain(result.reason)
  }, 90_000)
})
