/**
 * Unit Tests — Session.permissionMode default behavior.
 *
 * Locks the wiring that was previously missing: `Loom.create(...).withPermissionMode('auto')`
 * accepts a value but never threaded it to Session. Now `Session({ permissionMode })`
 * is honored by the default checkPermission/requestApproval pair.
 *
 * If a custom `checkPermission` callback is also provided, it wins —
 * `permissionMode` only governs the no-callback default.
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
// Provider that emits a single tool_use call and then ends.
// We bake in a tool call so each Session.submitMessage exercises the
// permission gate exactly once.
// ---------------------------------------------------------------------------

function makeToolUseProvider(toolName: string): ProviderAdapter {
  return {
    name: 'mock',
    async *stream(_req: ProviderRequest): AsyncGenerator<ProviderChunk> {
      const toolCallId = 'tc-1'
      const content = [
        {
          type: 'tool_use' as const,
          id: toolCallId,
          name: toolName,
          input: {},
        },
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

// Tool that demands permission and records when execute() is reached.
function makeGatedTool(): { tool: Tool; executed: () => boolean } {
  let didExecute = false
  const tool = defineTool({
    name: 'gated',
    description: 'requires permission',
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

// A provider that emits a tool_use with specific input — used by the
// S4 deny-reason tests so the formatted result can reference the
// actual file_path / command.
function makeToolUseProviderWithInput(toolName: string, input: Record<string, unknown>): ProviderAdapter {
  return {
    name: 'mock',
    async *stream(_req: ProviderRequest): AsyncGenerator<ProviderChunk> {
      const toolCallId = 'tc-1'
      const content = [
        { type: 'tool_use' as const, id: toolCallId, name: toolName, input },
      ]
      yield { type: 'tool_use_start', toolCallId, toolName, input } as ProviderChunk
      yield {
        type: 'message_complete',
        content,
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

describe('Session.permissionMode — default checkPermission/requestApproval', () => {
  it("'auto' allows the gated tool to execute", async () => {
    const { tool, executed } = makeGatedTool()
    const session = new Session({
      config: { ...createDefaultConfig('mock:m'), maxTurns: 2, maxTokens: 100 },
      provider: makeToolUseProvider('gated'),
      tools: [tool],
      permissionMode: 'auto',
    })
    await runOneTurn(session)
    expect(executed()).toBe(true)
  })

  it("'deny' blocks the gated tool", async () => {
    const { tool, executed } = makeGatedTool()
    const session = new Session({
      config: { ...createDefaultConfig('mock:m'), maxTurns: 2, maxTokens: 100 },
      provider: makeToolUseProvider('gated'),
      tools: [tool],
      permissionMode: 'deny',
    })
    await runOneTurn(session)
    expect(executed()).toBe(false)
  })

  it("'allowlist' (with no custom checker) denies by default", async () => {
    const { tool, executed } = makeGatedTool()
    const session = new Session({
      config: { ...createDefaultConfig('mock:m'), maxTurns: 2, maxTokens: 100 },
      provider: makeToolUseProvider('gated'),
      tools: [tool],
      permissionMode: 'allowlist',
    })
    await runOneTurn(session)
    expect(executed()).toBe(false)
  })

  it("'ask' (default) blocks the gated tool when no HITL handler is wired", async () => {
    const { tool, executed } = makeGatedTool()
    const session = new Session({
      config: { ...createDefaultConfig('mock:m'), maxTurns: 2, maxTokens: 100 },
      provider: makeToolUseProvider('gated'),
      tools: [tool],
      // permissionMode omitted → defaults to 'ask', requestApproval defaults to false
    })
    await runOneTurn(session)
    expect(executed()).toBe(false)
  })

  it('explicit checkPermission overrides permissionMode (non-auto modes)', async () => {
    const { tool, executed } = makeGatedTool()
    const customCheck = vi.fn().mockResolvedValue('allow')
    const session = new Session({
      config: { ...createDefaultConfig('mock:m'), maxTurns: 2, maxTokens: 100 },
      provider: makeToolUseProvider('gated'),
      tools: [tool],
      permissionMode: 'deny',  // would default to ask (post-redesign coercion)…
      checkPermission: customCheck, // …but the explicit checker wins.
    })
    await runOneTurn(session)
    expect(customCheck).toHaveBeenCalled()
    expect(executed()).toBe(true)
  })

  // -------------------------------------------------------------------------
  // S2 — Real bypass mode
  //
  // 'auto' is the only mode that genuinely skips every check, including
  // host-provided checkPermission. The mode-bypass enforcement lives in
  // Session.submitMessage's checkPermission wrapper (session.ts) so no
  // host can accidentally suppress the user's "I trust this run" choice.
  // -------------------------------------------------------------------------

  it("'auto' short-circuits even when a custom checkPermission would deny", async () => {
    const { tool, executed } = makeGatedTool()
    // Host-style "deny everything" checker — used by hostile or
    // mis-wired hosts. With permissionMode: 'auto' it must never be
    // called; the session decides 'allow' before the wrapper delegates.
    const customCheck = vi.fn().mockResolvedValue('ask')
    const session = new Session({
      config: { ...createDefaultConfig('mock:m'), maxTurns: 2, maxTokens: 100 },
      provider: makeToolUseProvider('gated'),
      tools: [tool],
      permissionMode: 'auto',
      checkPermission: customCheck,
    })
    await runOneTurn(session)
    expect(customCheck).not.toHaveBeenCalled()
    expect(executed()).toBe(true)
  })

  it("'auto' short-circuits requestApproval too (no HITL prompt even if reached)", async () => {
    const { tool, executed } = makeGatedTool()
    // requestApproval should never be reached in auto mode because
    // checkPermission already returned 'allow'. But if some custom
    // host returns 'ask' anyway, the wrapper's defense-in-depth makes
    // requestApproval return true.
    const requestApproval = vi.fn().mockResolvedValue(false)
    const session = new Session({
      config: { ...createDefaultConfig('mock:m'), maxTurns: 2, maxTokens: 100 },
      provider: makeToolUseProvider('gated'),
      tools: [tool],
      permissionMode: 'auto',
      requestApproval,
    })
    await runOneTurn(session)
    expect(requestApproval).not.toHaveBeenCalled()
    expect(executed()).toBe(true)
  })

  // -------------------------------------------------------------------------
  // S4 — Typed `DecisionReason` on permission.response + tool result
  //
  // When the user denies a permission prompt, the model used to get
  // `'User denied this action'` — three words with no recoverable
  // context. After S4 the model receives a structured prose message
  // that names the tool + input target + actionable next step, and
  // the SSE stream carries a typed `DecisionReason` on the
  // permission.response event for the UI/audit log.
  // -------------------------------------------------------------------------

  it("S4: user-denied yields permission.response with typed reason + rich model message", async () => {
    const { tool, executed } = makeGatedTool()
    // checkPermission returns 'ask' to drive the HITL path.
    const checkPermission = vi.fn().mockResolvedValue('ask')
    // requestApproval returns false → user-denied on every call.
    const requestApproval = vi.fn().mockResolvedValue(false)
    const session = new Session({
      config: { ...createDefaultConfig('mock:m'), maxTurns: 2, maxTokens: 100 },
      provider: makeToolUseProviderWithInput('gated', { file_path: '/work/secrets/.env' }),
      tools: [tool],
      permissionMode: 'ask',
      checkPermission,
      requestApproval,
    })
    const { events } = await runOneTurn(session)
    expect(executed()).toBe(false)

    // The mock provider re-emits the same tool_use on every turn, so
    // we get one denied permission.response per turn. Assert at least
    // one was generated and that ALL denied responses carry a typed
    // DecisionReason — the contract we care about.
    const responseEvents = events.filter((e) => e.type === 'permission.response') as
      Array<Extract<LoomEvent, { type: 'permission.response' }>>
    expect(responseEvents.length).toBeGreaterThanOrEqual(1)
    for (const r of responseEvents) {
      expect(r.granted).toBe(false)
      expect(r.reason).toBeDefined()
      expect(r.reason?.type).toBe('user-denied')
      if (r.reason?.type === 'user-denied') {
        expect(r.reason.toolName).toBe('gated')
        expect(r.reason.toolInput).toEqual({ file_path: '/work/secrets/.env' })
      }
    }

    // The tool.call.end result the model sees names the path + gives
    // actionable next steps. No 'User denied this action' literal.
    const callEnd = events.find((e) => e.type === 'tool.call.end') as
      | Extract<LoomEvent, { type: 'tool.call.end' }> | undefined
    expect(callEnd).toBeDefined()
    expect(callEnd!.isError).toBe(true)
    expect(callEnd!.result).toContain('/work/secrets/.env')
    expect(callEnd!.result).toContain('gated')
    expect(callEnd!.result).toMatch(/ask_user|surface|user/i)
    expect(callEnd!.result).not.toBe('User denied this action')
  })
})
