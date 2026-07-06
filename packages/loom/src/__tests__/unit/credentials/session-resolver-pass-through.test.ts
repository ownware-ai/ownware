/**
 * Unit tests — Session/Loop credentialResolver pass-through (C21).
 *
 * Pinned:
 *   - The Session accepts an optional `credentialResolver` opt and
 *     stores it without throwing.
 *   - When set, the resolver is forwarded onto every `ToolContext`
 *     visible to a tool's `execute()`.
 *   - When omitted, `context.credentialResolver` is `undefined` —
 *     legacy tools that don't read it work unchanged.
 *
 * NOTE: this test only covers the WIRING. No tool currently consumes
 * the resolver — that wires up at C37 when tool descriptors land.
 * The pass-through tests exist now so a future change that severs
 * the wire trips loudly.
 */

import { describe, it, expect } from 'vitest'
import { Session } from '../../../core/session.js'
import { createDefaultConfig } from '../../../core/config.js'
import type {
  ProviderAdapter,
  ProviderChunk,
  ProviderFeature,
  ProviderRequest,
  ToolDefinition,
} from '../../../provider/types.js'
import type { ModelPricing } from '../../../provider/pricing.js'
import type { Message } from '../../../messages/types.js'
import type { Tool, ToolContext, ToolResult } from '../../../tools/types.js'
import {
  ALWAYS_MISSING_RESOLVER,
  type CredentialResolver,
} from '../../../credentials/resolver.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Provider that emits one tool call then ends. Forces the loop to
 * dispatch the tool so we can capture its `ToolContext`.
 *
 * After the tool result comes back (next turn), emits an empty
 * end_turn so the loop terminates cleanly within `maxTurns`.
 */
class OneToolCallProvider implements ProviderAdapter {
  readonly name = 'fixture'
  private callIndex = 0
  constructor(private readonly toolCallId: string, private readonly toolName: string) {}
  async *stream(_request: ProviderRequest): AsyncGenerator<ProviderChunk> {
    void _request
    if (this.callIndex === 0) {
      this.callIndex++
      yield {
        type: 'message_complete',
        content: [
          { type: 'tool_use', id: this.toolCallId, name: this.toolName, input: {} },
        ],
        stopReason: 'tool_use',
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 },
      }
      return
    }
    yield {
      type: 'message_complete',
      content: [{ type: 'text', text: 'done' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    }
  }
  async countTokens(_messages: Message[]): Promise<number> { void _messages; return 0 }
  supportsFeature(_f: ProviderFeature): boolean { void _f; return false }
  formatTools(_tools: ToolDefinition[]): unknown[] { void _tools; return [] }
  getModelPricing(_model: string): ModelPricing | null { void _model; return null }
}

/**
 * Tool whose `execute()` captures the `ToolContext` it's called with
 * so the test can assert what the loop wired in.
 */
function makeCaptureTool(name: string): {
  readonly tool: Tool
  readonly captured: { context: ToolContext | null }
} {
  const captured: { context: ToolContext | null } = { context: null }
  const tool: Tool = {
    name,
    description: 'capture-context fixture',
    input_schema: { type: 'object', properties: {} },
    isReadOnly: true,
    execute(_input: Record<string, unknown>, context: ToolContext): ToolResult {
      void _input
      captured.context = context
      return { content: 'ok', isError: false }
    },
  }
  return { tool, captured }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Session — credentialResolver pass-through', () => {
  it('forwards a resolver onto ToolContext when supplied', async () => {
    const { tool, captured } = makeCaptureTool('capture')
    const myResolver: CredentialResolver = ALWAYS_MISSING_RESOLVER
    const session = new Session({
      config: createDefaultConfig('claude-sonnet-4-6'),
      provider: new OneToolCallProvider('call_1', 'capture'),
      tools: [tool],
      compaction: null,
      credentialResolver: myResolver,
    })
    const stream = session.submitMessage('go')
    // Drain the generator.
    while (true) {
      const next = await stream.next()
      if (next.done) break
    }
    expect(captured.context).not.toBeNull()
    expect(captured.context!.credentialResolver).toBe(myResolver)
  })

  it('leaves credentialResolver undefined on ToolContext when not supplied', async () => {
    const { tool, captured } = makeCaptureTool('capture')
    const session = new Session({
      config: createDefaultConfig('claude-sonnet-4-6'),
      provider: new OneToolCallProvider('call_1', 'capture'),
      tools: [tool],
      compaction: null,
      // No credentialResolver
    })
    const stream = session.submitMessage('go')
    while (true) {
      const next = await stream.next()
      if (next.done) break
    }
    expect(captured.context).not.toBeNull()
    expect(captured.context!.credentialResolver).toBeUndefined()
  })

  it('the Session constructs without a resolver (legacy)', () => {
    expect(() => {
      new Session({
        config: createDefaultConfig('claude-sonnet-4-6'),
        provider: new OneToolCallProvider('call_1', 'capture'),
        tools: [],
        compaction: null,
      })
    }).not.toThrow()
  })
})
