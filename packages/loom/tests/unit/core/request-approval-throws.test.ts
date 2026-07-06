/**
 * Unit Test — foundation-hardening R1: a throw from the host's
 * `requestApproval` (HITL) callback must NOT tear the agent loop down.
 *
 * This is the sibling of `permission-classifier-throws.test.ts`. That test
 * guards `checkPermission` (which WAS already wrapped at `loop.ts:1482`);
 * this one guards `requestApproval` (which was NOT — `loop.ts:1530`). The
 * asymmetry was the single most reachable trigger of the "stuck spinner"
 * class: the host approval channel dropping (SSE/IPC disconnect, gateway
 * restart, session teardown, or an abort landing while the prompt is open)
 * threw a rejection that propagated out of `executeTools` (yielded at
 * `loop.ts:1065`, PAST the loop's stream-only try/catch at `:784-886`),
 * discarding the whole turn and leaving every `tool.call.start` unclosed →
 * UI tool cards spin forever (Principle 1).
 *
 * Post-fix behavior: a throw is caught and treated as a denial — fail-closed.
 * The model receives a clean denied `tool_result`, the `tool.call.end`
 * closes the card, and the run continues to a normal terminal reason instead
 * of an unhandled rejection. (Fail-closed, not fail-open: a broken approval
 * channel must NEVER auto-allow a permission-gated tool.)
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

// One tool_use per turn so the permission gate fires exactly once and the
// test exercises the requestApproval seam.
function makeToolUseProvider(toolName: string): ProviderAdapter {
  return {
    name: 'mock',
    async *stream(_req: ProviderRequest): AsyncGenerator<ProviderChunk> {
      const toolCallId = 'tc-1'
      const content = [
        { type: 'tool_use' as const, id: toolCallId, name: toolName, input: {} },
      ]
      yield { type: 'tool_use_start', toolCallId, toolName, input: {} } as ProviderChunk
      yield {
        type: 'message_complete',
        content,
        stopReason: 'tool_use',
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      } as ProviderChunk
    },
    async countTokens() { return 10 },
    supportsFeature(_f: ProviderFeature) { return true },
    formatTools(tools: ToolDefinition[]) { return tools },
    getModelPricing() { return null },
  } as unknown as ProviderAdapter
}

// requiresPermission: true routes through the serial branch
// (executeSingleToolGen directly) — the path that actually awaits
// requestApproval at loop.ts:1530.
function makeGatedTool(): { tool: Tool; executed: () => boolean } {
  let didExecute = false
  const tool = defineTool({
    name: 'gated',
    description: 'requires permission (serial branch — awaits requestApproval)',
    isReadOnly: false,
    requiresPermission: true,
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      didExecute = true
      return { content: 'ran', isError: false }
    },
  })
  return { tool, executed: () => didExecute }
}

async function runOneTurn(session: Session): Promise<{ events: LoomEvent[]; reason: string }> {
  const events: LoomEvent[] = []
  const gen = session.submitMessage('do the thing')
  let next = await gen.next()
  while (!next.done) {
    events.push(next.value)
    next = await gen.next()
  }
  return { events, reason: next.value.reason }
}

describe('R1 — requestApproval throw does NOT kill the turn', () => {
  it('a synchronous throw from requestApproval is treated as a denial, not an uncaught crash', async () => {
    const { tool, executed } = makeGatedTool()
    // checkPermission returns 'ask' so we reach the HITL prompt.
    const checkPermission = vi.fn().mockResolvedValue('ask')
    // The host approval channel explodes synchronously (e.g. the IPC bridge
    // was torn down). Pre-fix this rejected runOneTurn with an unhandled
    // error; post-fix the run completes cleanly.
    const requestApproval = vi.fn().mockImplementation(() => {
      throw new Error('approval channel disconnected')
    })

    const session = new Session({
      config: { ...createDefaultConfig('mock:m'), maxTurns: 1, maxTokens: 100 },
      provider: makeToolUseProvider('gated'),
      tools: [tool],
      permissionMode: 'ask',
      checkPermission,
      requestApproval,
    })

    // The decisive assertion: this resolves instead of rejecting.
    const { events } = await runOneTurn(session)

    // requestApproval was reached (we hit the seam).
    expect(requestApproval).toHaveBeenCalled()

    // Treated as a denial — permission.response granted=false.
    const response = events.find((e): e is Extract<LoomEvent, { type: 'permission.response' }> =>
      e.type === 'permission.response',
    )
    expect(response).toBeDefined()
    expect(response!.granted).toBe(false)

    // tool.call.end closes the card with isError=true — no stuck spinner,
    // and the model sees a result it can react to.
    const callEnd = events.find((e): e is Extract<LoomEvent, { type: 'tool.call.end' }> =>
      e.type === 'tool.call.end',
    )
    expect(callEnd).toBeDefined()
    expect(callEnd!.isError).toBe(true)

    // Fail-closed: the gated tool did NOT execute on a broken channel.
    expect(executed()).toBe(false)

    // The session reached a clean terminal state (no unhandled throw).
    const end = events.find((e): e is Extract<LoomEvent, { type: 'session.end' }> =>
      e.type === 'session.end',
    )
    expect(end).toBeDefined()
  })

  it('an async (rejected promise) throw from requestApproval is also treated as a denial', async () => {
    // Same invariant, the realistic shape — the approval Promise rejects
    // (host process gone, abort fired while the prompt was open).
    const { tool, executed } = makeGatedTool()
    const checkPermission = vi.fn().mockResolvedValue('ask')
    const requestApproval = vi.fn().mockRejectedValue(new Error('session torn down mid-prompt'))

    const session = new Session({
      config: { ...createDefaultConfig('mock:m'), maxTurns: 1, maxTokens: 100 },
      provider: makeToolUseProvider('gated'),
      tools: [tool],
      permissionMode: 'ask',
      checkPermission,
      requestApproval,
    })

    const { events } = await runOneTurn(session)

    expect(requestApproval).toHaveBeenCalled()
    expect(executed()).toBe(false)

    const callEnd = events.find((e): e is Extract<LoomEvent, { type: 'tool.call.end' }> =>
      e.type === 'tool.call.end',
    )
    expect(callEnd).toBeDefined()
    expect(callEnd!.isError).toBe(true)

    const end = events.find((e): e is Extract<LoomEvent, { type: 'session.end' }> =>
      e.type === 'session.end',
    )
    expect(end).toBeDefined()
  })
})
