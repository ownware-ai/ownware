/**
 * Unit Tests — `request_credential` tool + loop HITL wiring.
 *
 * Covers:
 *   1. Direct generator: tool yields a credentialRequest marker, caller
 *      feeds back a handle or null via `.next()`, tool returns a
 *      value-free ToolResult that tells the model only {status,credentialId}.
 *   2. Input validation: malformed placements are rejected at the tool
 *      boundary with a clear error (no credentialRequest emitted).
 *   3. Loop integration: when a model turn calls `request_credential`,
 *      the loop emits credential.request BEFORE blocking on the outer
 *      callback and credential.response AFTER. The final ToolResult
 *      surfaced to the model contains no value.
 *   4. Default deny: a session with no `credentials.requestCredential`
 *      wired resolves every request to null (spec: "fail loudly" on
 *      unwired dependencies — here loud = visible denied response event).
 */

import { describe, it, expect, vi } from 'vitest'

// Known Bun-test wart: `vi.mock('.../src/core/loop.js')` at module scope in
// any other test file (e.g. tests/unit/agents/spawner.test.ts) leaks across
// files in the same `bun test` run and swaps `loop` for a vi.fn() stub.
// The "loop integration" tests below fail in full-suite runs because of
// that upstream issue (the same condition also makes
// tests/unit/core/session-end-event.test.ts fail in the baseline suite
// today). They pass in isolation — run just this file to verify credential
// HITL behaviour. Bun has no `vi.unmock` escape hatch; the correct fix is
// upstream, not here.
import type { AssistantMessage } from '../../../messages/types.js'
import type {
  CredentialHandle,
  CredentialRequest,
  CredentialValue,
  EnvCredentialEntry,
} from '../../../credentials/types.js'
import type {
  LoomEvent,
  CredentialRequestEvent,
  CredentialResponseEvent,
} from '../../../core/events.js'
import type { ProviderAdapter, ProviderChunk, ProviderRequest } from '../../../provider/types.js'
import { loop, type LoopParams } from '../../../core/loop.js'
import { createDefaultConfig } from '../../../core/config.js'
import { requestCredential } from '../credential.js'
import type { ToolContext, ToolProgress } from '../../types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stubContext(): ToolContext {
  // Zero-wired context — the tool should yield its HITL marker without
  // touching any of these. If a bug causes it to touch `resolveCredential`
  // (for example), the tests will fail loudly.
  return {
    cwd: '/tmp',
    signal: new AbortController().signal,
    sessionId: 'test-session',
    agentId: null,
    workspacePath: '/tmp',
    config: createDefaultConfig('mock:test'),
    requestPermission: async () => false,
    requestCredential: async () => null,
    resolveCredential: () => null,
    listEnvCredentials: () => [],
    listAllCredentialValues: () => [],
  }
}

function isExecuteGenerator(
  value: ReturnType<typeof requestCredential.execute>,
): value is AsyncGenerator<ToolProgress, import('../../types.js').ToolResult> {
  return typeof (value as { next?: unknown }).next === 'function'
}

// ---------------------------------------------------------------------------
// Direct generator tests
// ---------------------------------------------------------------------------

describe('request_credential — direct generator contract', () => {
  it('yields a single credentialRequest progress for a valid env placement', async () => {
    const gen = requestCredential.execute(
      {
        label: 'Admin JWT',
        hint: 'devtools',
        usage: 'test admin endpoint',
        placement: { type: 'env', variableName: 'ADMIN_JWT' },
        isRequired: true,
      },
      stubContext(),
    )
    if (!isExecuteGenerator(gen)) throw new Error('expected generator')

    const first = await gen.next()
    expect(first.done).toBe(false)
    const progress = first.value as ToolProgress
    expect(progress.message).toContain('Admin JWT')
    expect(progress.credentialRequest).toEqual({
      label: 'Admin JWT',
      hint: 'devtools',
      usage: 'test admin endpoint',
      placement: { type: 'env', variableName: 'ADMIN_JWT' },
      isRequired: true,
    })

    // Return a stored handle — tool should return status:stored.
    const handle: CredentialHandle = {
      credentialId: 'runtime_t_ADMIN_JWT',
      label: 'Admin JWT',
      placement: { type: 'env', variableName: 'ADMIN_JWT' },
      storedAt: Date.now(),
    }
    const final = await gen.next(handle as unknown as undefined)
    expect(final.done).toBe(true)
    expect(final.value.isError).toBe(false)
    const parsed = JSON.parse(final.value.content)
    expect(parsed).toEqual({
      status: 'stored',
      credentialId: 'runtime_t_ADMIN_JWT',
      label: 'Admin JWT',
      placement: { type: 'env', variableName: 'ADMIN_JWT' },
    })
    // Crucially: no value in the content — this text is what the model sees.
    expect(final.value.content).not.toMatch(/secret|token|password|plaintext/i)
  })

  it('returns status:denied when caller resumes with null', async () => {
    const gen = requestCredential.execute(
      {
        label: 'Database URL',
        hint: 'Heroku dashboard',
        usage: 'connect to staging',
        placement: { type: 'env', variableName: 'DATABASE_URL' },
        isRequired: true,
      },
      stubContext(),
    )
    if (!isExecuteGenerator(gen)) throw new Error('expected generator')

    await gen.next() // consume credentialRequest progress
    const final = await gen.next(null as unknown as undefined)
    expect(final.done).toBe(true)
    expect(JSON.parse(final.value.content)).toEqual({
      status: 'denied',
      label: 'Database URL',
    })
    expect(final.value.isError).toBe(false)
  })

  it('rejects a malformed env placement without emitting a request', async () => {
    const gen = requestCredential.execute(
      {
        label: 'bad',
        hint: '',
        usage: '',
        placement: { type: 'env' /* no variableName */ },
        isRequired: false,
      },
      stubContext(),
    )
    if (!isExecuteGenerator(gen)) throw new Error('expected generator')

    // Bad input — generator returns immediately with isError:true, no yield.
    const first = await gen.next()
    expect(first.done).toBe(true)
    expect(first.value.isError).toBe(true)
    expect(first.value.content).toMatch(/variableName/)
  })

  it('rejects a variableName that is not a valid POSIX env var', async () => {
    const gen = requestCredential.execute(
      {
        label: 'bad',
        hint: 'h',
        usage: 'u',
        placement: { type: 'env', variableName: '1BAD-NAME' },
        isRequired: false,
      },
      stubContext(),
    )
    if (!isExecuteGenerator(gen)) throw new Error('expected generator')
    const first = await gen.next()
    expect(first.done).toBe(true)
    expect(first.value.isError).toBe(true)
    expect(first.value.content).toMatch(/POSIX/)
  })

  it('accepts every supported placement variant', async () => {
    const variants: CredentialRequest['placement'][] = [
      { type: 'env', variableName: 'X' },
      { type: 'bearer' },
      { type: 'header', name: 'X-API-Key' },
      { type: 'cookie', name: 'sid' },
      { type: 'body', fieldPath: 'auth.token' },
      { type: 'query', paramName: 'apikey' },
      { type: 'basic' },
      { type: 'basic', usernameCredentialId: 'cred-user-1' },
    ]
    for (const placement of variants) {
      const gen = requestCredential.execute(
        { label: 'l', hint: 'h', usage: 'u', placement, isRequired: false },
        stubContext(),
      )
      if (!isExecuteGenerator(gen)) throw new Error('expected generator')
      const first = await gen.next()
      expect(first.done).toBe(false)
      expect((first.value as ToolProgress).credentialRequest?.placement).toEqual(placement)
      // Drain to completion to avoid hanging.
      await gen.next(null as unknown as undefined)
    }
  })
})

// ---------------------------------------------------------------------------
// Loop integration — credential.request/response events around the HITL block
// ---------------------------------------------------------------------------

function makeToolCallingProvider(toolInput: Record<string, unknown>): ProviderAdapter {
  let callCount = 0
  return {
    name: 'mock-tool',
    async *stream(_request: ProviderRequest): AsyncGenerator<ProviderChunk> {
      callCount++
      if (callCount === 1) {
        // First turn: request a credential via the built-in tool.
        yield {
          type: 'tool_use_start',
          id: 'call-1',
          name: 'request_credential',
          input: toolInput,
        } as ProviderChunk
        yield {
          type: 'message_complete',
          content: [
            {
              type: 'tool_use',
              id: 'call-1',
              name: 'request_credential',
              input: toolInput,
            },
          ],
          stopReason: 'tool_use',
          usage: {
            inputTokens: 10,
            outputTokens: 10,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          },
        } as ProviderChunk
        return
      }
      // Second turn: end with a plain text response.
      yield { type: 'text_delta', text: 'done' } as ProviderChunk
      yield {
        type: 'message_complete',
        content: [{ type: 'text', text: 'done' }],
        stopReason: 'end_turn',
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      } as ProviderChunk
    },
    countTokens: vi.fn().mockResolvedValue(100),
    supportsFeature: vi.fn().mockReturnValue(false),
    formatTools: vi.fn((tools) => tools),
    getModelPricing: vi.fn().mockReturnValue(null),
  }
}

async function collectEvents(params: LoopParams): Promise<{
  events: LoomEvent[]
  result: import('../../../core/loop.js').LoopResult
}> {
  const events: LoomEvent[] = []
  const gen = loop(params)
  let step = await gen.next()
  while (!step.done) {
    events.push(step.value)
    step = await gen.next()
  }
  return { events, result: step.value }
}

function baseLoopParams(toolInput: Record<string, unknown>): LoopParams {
  return {
    messages: [{ role: 'user', content: 'please request a credential' }],
    systemPrompt: '',
    provider: makeToolCallingProvider(toolInput),
    tools: [requestCredential],
    config: createDefaultConfig('mock:test'),
    compaction: null,
    checkpoint: null,
    checkPermission: async () => 'allow',
    requestApproval: async () => true,
  }
}

describe('loop integration — credential HITL', () => {
  it('emits credential.request BEFORE blocking and credential.response AFTER', async () => {
    const toolInput = {
      label: 'Admin JWT',
      hint: 'devtools',
      usage: 'bypass admin auth',
      placement: { type: 'env', variableName: 'ADMIN_JWT' },
      isRequired: true,
    }

    const order: string[] = []
    const requestCredentialFn = vi.fn(async (req: CredentialRequest & { requestId: string }) => {
      order.push('callback-invoked')
      return {
        credentialId: `runtime_${req.requestId}`,
        label: req.label,
        placement: req.placement,
        storedAt: Date.now(),
      }
    })

    const params: LoopParams = {
      ...baseLoopParams(toolInput),
      credentials: {
        requestCredential: requestCredentialFn,
        resolveCredential: () => null,
        listEnvCredentials: () => [] as readonly EnvCredentialEntry[],
        listAllCredentialValues: () => [] as readonly CredentialValue[],
      },
    }

    const { events } = await collectEvents(params)

    const reqIdx = events.findIndex(e => e.type === 'credential.request')
    const resIdx = events.findIndex(e => e.type === 'credential.response')
    expect(reqIdx).toBeGreaterThan(-1)
    expect(resIdx).toBeGreaterThan(reqIdx)
    expect(requestCredentialFn).toHaveBeenCalledTimes(1)

    const reqEvent = events[reqIdx] as CredentialRequestEvent
    const resEvent = events[resIdx] as CredentialResponseEvent
    expect(reqEvent.label).toBe('Admin JWT')
    expect(reqEvent.placement).toEqual({ type: 'env', variableName: 'ADMIN_JWT' })
    expect(resEvent.requestId).toBe(reqEvent.requestId)
    expect(resEvent.denied).toBe(false)
    expect(resEvent.credentialId).toBe(`runtime_${reqEvent.requestId}`)
  })

  it('emits denied credential.response when outer callback returns null', async () => {
    const toolInput = {
      label: 'Database URL',
      hint: 'heroku',
      usage: 'connect',
      placement: { type: 'env', variableName: 'DATABASE_URL' },
      isRequired: true,
    }

    const params: LoopParams = {
      ...baseLoopParams(toolInput),
      credentials: {
        requestCredential: async () => null,
      },
    }

    const { events } = await collectEvents(params)
    const resEvent = events.find(e => e.type === 'credential.response') as CredentialResponseEvent
    expect(resEvent).toBeDefined()
    expect(resEvent.denied).toBe(true)
    expect(resEvent.credentialId).toBeNull()
    expect(resEvent.label).toBe('Database URL')
  })

  it('treats a thrown requestCredential callback as a deny (no loop crash)', async () => {
    const toolInput = {
      label: 'X',
      hint: 'h',
      usage: 'u',
      placement: { type: 'env', variableName: 'X' },
      isRequired: false,
    }

    const params: LoopParams = {
      ...baseLoopParams(toolInput),
      credentials: {
        requestCredential: async () => { throw new Error('vault down') },
      },
    }

    const { events, result } = await collectEvents(params)
    const resEvent = events.find(e => e.type === 'credential.response') as CredentialResponseEvent
    expect(resEvent.denied).toBe(true)
    // Loop must still finish cleanly — reason end_turn, no error event
    // with recoverable:false from the credential path.
    expect(result.reason).toBe('end_turn')
  })

  it('defaults to deny when no credentials callbacks are wired', async () => {
    const toolInput = {
      label: 'X',
      hint: 'h',
      usage: 'u',
      placement: { type: 'env', variableName: 'X' },
      isRequired: false,
    }

    // No `credentials` field on LoopParams — the loop must fall back to
    // the no-op defaults (requestCredential returns null). The user sees
    // a denied response event and the tool returns denied.
    const params = baseLoopParams(toolInput)
    const { events } = await collectEvents(params)
    const resEvent = events.find(e => e.type === 'credential.response') as CredentialResponseEvent
    expect(resEvent.denied).toBe(true)
  })

  it('tool result delivered to the model carries no value', async () => {
    const toolInput = {
      label: 'Admin JWT',
      hint: 'devtools',
      usage: 'bypass admin auth',
      placement: { type: 'env', variableName: 'ADMIN_JWT' },
      isRequired: true,
    }

    const params: LoopParams = {
      ...baseLoopParams(toolInput),
      credentials: {
        requestCredential: async () => ({
          credentialId: 'runtime_T_ADMIN_JWT',
          label: 'Admin JWT',
          placement: { type: 'env', variableName: 'ADMIN_JWT' },
          storedAt: Date.now(),
        }),
      },
    }

    const { events } = await collectEvents(params)

    const toolEnd = events.find(e =>
      e.type === 'tool.call.end' && (e as { toolName?: string }).toolName === 'request_credential',
    )
    expect(toolEnd).toBeDefined()
    const result = (toolEnd as { result: string }).result
    // The value is not in the event — and would not be even if we
    // happened to know it, because the loop never stored one.
    expect(result).not.toMatch(/very-secret|password|token=[a-z]+/i)
    expect(result).toContain('stored')
    expect(result).toContain('runtime_T_ADMIN_JWT')
  })
})

// Assistant message shape reference so the import lints clean even if the
// test suite later gains cases that inspect assistant outputs directly.
function _typeRefs(msg: AssistantMessage): AssistantMessage {
  return msg
}
