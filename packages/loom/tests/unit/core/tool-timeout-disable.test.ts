/**
 * Unit Test — foundation-hardening R3: the loop must honor a tool's
 * `disableTimeout` on the Promise execution path.
 *
 * Pre-fix (`loop.ts` else-branch): the wall-clock timeout was armed
 * unconditionally for every Promise tool — `disableTimeout` was read nowhere.
 * `agent_spawn` and `orchestrate` both declare `disableTimeout: true` (their
 * sub-agent delegations legitimately outrun the 120s default), so a long
 * delegation was killed at the default timeout and the child loop was
 * orphaned (kept spending).
 *
 * Post-fix: a `disableTimeout: true` tool runs without the timeout race; a
 * normal tool still times out. (The generator path is intentionally untouched
 * — shell self-protects with its own per-call SIGTERM→SIGKILL timeout.)
 *
 * The test pins this with a tiny `defaultTimeoutMs` and a tool that sleeps
 * past it, so it runs in milliseconds without waiting on a real 120s timer.
 */

import { describe, it, expect, vi } from 'vitest'
import { Session } from '../../../src/core/session.js'
import { createDefaultConfig } from '../../../src/core/config.js'
import { defineTool } from '../../../src/tools/types.js'
import type {
  ProviderAdapter,
  ProviderChunk,
  ProviderRequest,
  ProviderFeature,
  ToolDefinition,
} from '../../../src/provider/types.js'
import type { Tool } from '../../../src/tools/types.js'
import type { LoomEvent } from '../../../src/core/events.js'

function makeToolUseProvider(toolName: string): ProviderAdapter {
  return {
    name: 'mock',
    async *stream(_req: ProviderRequest): AsyncGenerator<ProviderChunk> {
      const toolCallId = 'tc-1'
      yield { type: 'tool_use_start', toolCallId, toolName, input: {} } as ProviderChunk
      yield {
        type: 'message_complete',
        content: [{ type: 'tool_use' as const, id: toolCallId, name: toolName, input: {} }],
        stopReason: 'tool_use',
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
      } as ProviderChunk
    },
    async countTokens() { return 10 },
    supportsFeature(_f: ProviderFeature) { return true },
    formatTools(tools: ToolDefinition[]) { return tools },
    getModelPricing() { return null },
  } as unknown as ProviderAdapter
}

// A plain Promise tool (not a generator) that sleeps past the configured
// timeout, so it exercises the else-branch where disableTimeout is read.
function makeSleeperTool(disableTimeout: boolean): Tool {
  return defineTool({
    name: 'sleeper',
    description: 'sleeps 200ms then returns',
    isReadOnly: false,
    requiresPermission: false,
    ...(disableTimeout ? { disableTimeout: true } : {}),
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      await new Promise(r => setTimeout(r, 200))
      return { content: 'ran', isError: false }
    },
  })
}

async function runOneTurn(session: Session): Promise<LoomEvent[]> {
  const events: LoomEvent[] = []
  const gen = session.submitMessage('go')
  let next = await gen.next()
  while (!next.done) {
    events.push(next.value)
    next = await gen.next()
  }
  return events
}

function makeSession(tool: Tool): Session {
  const base = createDefaultConfig('mock:m')
  return new Session({
    config: {
      ...base,
      maxTurns: 1,
      maxTokens: 100,
      // Tiny timeout so the 200ms sleeper trips it without a real 120s wait.
      toolExecution: { ...base.toolExecution, defaultTimeoutMs: 50 },
    },
    provider: makeToolUseProvider('sleeper'),
    tools: [tool],
    permissionMode: 'ask',
    checkPermission: vi.fn().mockResolvedValue('allow'),
    requestApproval: vi.fn().mockResolvedValue(true),
  })
}

function toolEnd(events: LoomEvent[]) {
  return events.find((e): e is Extract<LoomEvent, { type: 'tool.call.end' }> =>
    e.type === 'tool.call.end',
  )
}

describe('R3 — loop honors tool.disableTimeout on the Promise path', () => {
  it('a normal tool that outruns the timeout is killed (control)', async () => {
    const events = await runOneTurn(makeSession(makeSleeperTool(false)))
    const end = toolEnd(events)
    expect(end).toBeDefined()
    expect(end!.isError).toBe(true)
    expect(String(end!.result)).toMatch(/timed out/i)
  })

  it('a disableTimeout tool runs to completion despite outrunning the timeout', async () => {
    // Fails pre-fix: disableTimeout was ignored, so this also timed out.
    const events = await runOneTurn(makeSession(makeSleeperTool(true)))
    const end = toolEnd(events)
    expect(end).toBeDefined()
    expect(end!.isError).toBe(false)
    expect(String(end!.result)).toBe('ran')
  })
})
