/**
 * Unit Test — BUG #9 (accuracy audit): a throw from the host's
 * `checkPermission` callback (e.g. ZoneManager classifier failure)
 * must NOT tear the agent loop down.
 *
 * Pre-fix behavior (`packages/loom/src/core/loop.ts:1387` outside the
 * try at `:1518`): the rejection bubbled up through `await gen.next()`
 * in `executeTools` and through `Promise.all` in `parallelExecute`,
 * killing the whole turn. Worse than fail-deny because the user could
 * not see why or re-prompt.
 *
 * Post-fix behavior: the throw is mapped to a synthetic `'ask'`
 * verdict so the HITL path still runs. The session emits a
 * `permission.request` carrying the classifier-error explanation; if
 * the user declines (or no `requestApproval` is wired) the tool
 * surfaces a denied result the model can react to.
 *
 * The permission model doesn't specify behavior for classifier
 * failure; defaulting to `'ask'` preserves
 * user control instead of silently auto-allowing OR killing the run.
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

// ---------------------------------------------------------------------------
// Mock provider that emits one tool_use call per turn so the permission
// gate fires exactly once and the test exercises the seam.
// ---------------------------------------------------------------------------

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

// A read-only + permission-gated tool routes through the parallel
// branch (executeTools:1302) so we cover the `Promise.all` path that
// used to die. A write-gated tool covers the serial branch.
function makeReadOnlyGatedTool(): { tool: Tool; executed: () => boolean } {
  let didExecute = false
  const tool = defineTool({
    name: 'readonly_gated',
    description: 'read-only but requires permission (parallel branch)',
    isReadOnly: false, // requiresPermission forces serial in the partition
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

describe('BUG #9 — checkPermission throw does NOT kill the turn', () => {
  it('a synchronous throw from checkPermission maps to a synthetic ask + emits permission.request', async () => {
    const { tool, executed } = makeReadOnlyGatedTool()
    const checkPermission = vi.fn().mockImplementation(() => {
      throw new Error('ZoneManager.evaluate exploded — bad state')
    })
    // No HITL — defaults to deny on the prompt, but the loop must
    // still reach the prompt instead of dying.
    const requestApproval = vi.fn().mockResolvedValue(false)

    const session = new Session({
      config: { ...createDefaultConfig('mock:m'), maxTurns: 1, maxTokens: 100 },
      provider: makeToolUseProvider('readonly_gated'),
      tools: [tool],
      permissionMode: 'ask',
      checkPermission,
      requestApproval,
    })

    // The pre-fix behavior would reject this promise (Promise.all
    // unwraps the executeSingleTool rejection). Post-fix it resolves
    // normally with a clean turn.
    const { events } = await runOneTurn(session)

    // 1. checkPermission was attempted (proves we hit the seam).
    expect(checkPermission).toHaveBeenCalled()

    // 2. The synthetic verdict is `'ask'`, so a permission.request
    //    must be emitted carrying the classifier-error explanation
    //    and severity. This is the user-visible signal that the
    //    classifier failed.
    const request = events.find((e): e is Extract<LoomEvent, { type: 'permission.request' }> =>
      e.type === 'permission.request',
    )
    expect(request).toBeDefined()
    expect(request!.toolName).toBe('readonly_gated')
    expect(request!.severityTag).toBe('critical')
    expect(request!.severityReason).toBe('classifier-error')
    expect(request!.explanation).toContain('Permission classifier failed')
    expect(request!.explanation).toContain('ZoneManager.evaluate exploded')

    // 3. requestApproval was reached (the HITL path runs).
    expect(requestApproval).toHaveBeenCalled()

    // 4. Tool did not execute (host denied via requestApproval mock).
    //    The key invariant for BUG #9 is that the run did not die —
    //    we got here without an unhandled rejection.
    expect(executed()).toBe(false)

    // 5. permission.response is granted=false with a typed reason —
    //    same shape the model gets for any user-denied call.
    const response = events.find((e): e is Extract<LoomEvent, { type: 'permission.response' }> =>
      e.type === 'permission.response',
    )
    expect(response).toBeDefined()
    expect(response!.granted).toBe(false)

    // 6. tool.call.end is present with isError=true — the UI is not
    //    left spinning, and the model sees an error result it can
    //    react to.
    const callEnd = events.find((e): e is Extract<LoomEvent, { type: 'tool.call.end' }> =>
      e.type === 'tool.call.end',
    )
    expect(callEnd).toBeDefined()
    expect(callEnd!.isError).toBe(true)
  })

  it('an async (rejected promise) throw from checkPermission also maps to ask', async () => {
    // Same invariant, different throw shape — guards the realistic
    // case where ZoneManager.evaluate is wrapped in an async function
    // and the failure surfaces as a rejection rather than a sync throw.
    const { tool, executed } = makeReadOnlyGatedTool()
    const checkPermission = vi
      .fn()
      .mockRejectedValue(new Error('async lookup failed'))
    // This time approve the prompt, proving that recovery is full:
    // classifier dies → user is asked → user approves → tool runs.
    const requestApproval = vi.fn().mockResolvedValue(true)

    const session = new Session({
      config: { ...createDefaultConfig('mock:m'), maxTurns: 1, maxTokens: 100 },
      provider: makeToolUseProvider('readonly_gated'),
      tools: [tool],
      permissionMode: 'ask',
      checkPermission,
      requestApproval,
    })

    const { events } = await runOneTurn(session)

    expect(checkPermission).toHaveBeenCalled()
    expect(requestApproval).toHaveBeenCalled()
    // Tool ran because the user approved the synthetic ask — full
    // recovery from a classifier failure.
    expect(executed()).toBe(true)

    const request = events.find((e): e is Extract<LoomEvent, { type: 'permission.request' }> =>
      e.type === 'permission.request',
    )
    expect(request).toBeDefined()
    expect(request!.explanation).toContain('async lookup failed')
  })
})
