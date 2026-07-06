/**
 * Unit tests for `Session.querySide` — the one-shot side-call helper
 * for cheap meta-tasks.
 *
 * The contract is narrow: do ONE provider call with no tools, no
 * loop, no message-history mutation, no event stream. Roll the cost
 * into `session.totalUsage` so dashboards remain correct, and return
 * the text + a per-call usage record so callers that want a separate
 * ledger row can produce one.
 *
 * Each invariant has its own assertion — if one fails, the fix is to
 * restore the invariant, not relax the test.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { Session } from '../../../core/session.js'
import { createDefaultConfig, mergeConfig } from '../../../core/config.js'
import { registerProvider, getProvider } from '../../../core/../provider/registry.js'
import type {
  ProviderAdapter,
  ProviderChunk,
  ProviderRequest,
  ProviderUsage,
  ToolDefinition,
  ProviderFeature,
  JsonSchema,
} from '../../../provider/types.js'
import type { ModelPricing } from '../../../provider/pricing.js'
import type { Message } from '../../../messages/types.js'

// ---------------------------------------------------------------------------
// Tiny mock provider — registered under a unique name so each test can
// configure its response / capture its requests.
// ---------------------------------------------------------------------------

interface MockProvider extends ProviderAdapter {
  reset(): void
  configureNext(opts: {
    text: string
    usage?: Partial<ProviderUsage>
  }): void
  lastRequest: ProviderRequest | null
  callCount: number
}

function makeMock(name: string): MockProvider {
  let nextText = ''
  let nextUsage: ProviderUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  }

  const provider: MockProvider = {
    name,
    callCount: 0,
    lastRequest: null,
    reset() {
      this.callCount = 0
      this.lastRequest = null
      nextText = ''
      nextUsage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      }
    },
    configureNext(opts) {
      nextText = opts.text
      nextUsage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        ...opts.usage,
      }
    },
    async *stream(request: ProviderRequest): AsyncGenerator<ProviderChunk> {
      provider.callCount++
      provider.lastRequest = request
      yield { type: 'text_delta', text: nextText }
      yield {
        type: 'message_complete',
        content: [{ type: 'text', text: nextText }],
        stopReason: 'end_turn',
        usage: nextUsage,
      }
    },
    async countTokens(messages: Message[]): Promise<number> {
      void messages
      return 0
    },
    supportsFeature(_f: ProviderFeature): boolean {
      return false
    },
    formatTools(tools: ToolDefinition[]): unknown[] {
      void tools
      return []
    },
    getModelPricing(_model: string): ModelPricing | null {
      // Cheap deterministic pricing so cost math is verifiable.
      return { input: 1, output: 2, cacheRead: null, cacheWrite: null }
    },
  }
  return provider
}

const MOCK_PROVIDER_NAME = 'querysidemock'
const MOCK_MODEL = `${MOCK_PROVIDER_NAME}:any-model`
let mock: MockProvider

beforeEach(() => {
  // Register lazily so each test gets a clean handle on the same
  // provider instance (re-registering with the same name overwrites).
  if (!getProvider(MOCK_PROVIDER_NAME)) {
    mock = makeMock(MOCK_PROVIDER_NAME)
    registerProvider(mock)
  } else {
    // Already in the registry — reset state and grab the same handle.
    mock = getProvider(MOCK_PROVIDER_NAME) as MockProvider
    mock.reset()
  }
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(): Session {
  // The session's MAIN provider can be different from the side-call
  // provider; querySide resolves a fresh one per call. Use the same
  // mock for simplicity here.
  const config = mergeConfig(createDefaultConfig(MOCK_MODEL), {})
  return new Session({
    config,
    provider: mock,
    tools: [],
  })
}

const noopSchema: JsonSchema = { type: 'object', properties: {} }
void noopSchema // imported so future tests can extend without re-importing

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Session.querySide', () => {
  it('returns the model text', async () => {
    mock.configureNext({ text: 'Bug fix in baz.ts' })
    const session = makeSession()
    const result = await session.querySide({
      model: MOCK_MODEL,
      prompt: 'Generate a title',
    })
    expect(result.text).toBe('Bug fix in baz.ts')
  })

  it('makes exactly one provider call', async () => {
    mock.configureNext({ text: 'one' })
    const session = makeSession()
    await session.querySide({ model: MOCK_MODEL, prompt: 'hi' })
    expect(mock.callCount).toBe(1)
  })

  it('does NOT mutate session.messages', async () => {
    mock.configureNext({ text: 'whatever' })
    const session = makeSession()
    const before = session.getMessages()
    await session.querySide({ model: MOCK_MODEL, prompt: 'side-call prompt' })
    const after = session.getMessages()
    // Length and identity preserved — no user/assistant messages
    // appended for the side call.
    expect(after.length).toBe(before.length)
  })

  it('rolls usage and cost into session.totalUsage', async () => {
    mock.configureNext({
      text: 'reply',
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    })
    const session = makeSession()
    const before = session.getState().totalUsage
    const result = await session.querySide({
      model: MOCK_MODEL,
      prompt: 'p',
    })

    // Mock pricing: input=1/M, output=2/M.
    // Expected cost: 100 * 1/1e6 + 50 * 2/1e6 = 0.0001 + 0.0001 = 0.0002
    expect(result.usage.costUsd).toBeCloseTo(0.0002, 8)
    expect(result.usage.inputTokens).toBe(100)
    expect(result.usage.outputTokens).toBe(50)

    const after = session.getState().totalUsage
    expect(after.inputTokens).toBe(before.inputTokens + 100)
    expect(after.outputTokens).toBe(before.outputTokens + 50)
    expect(after.costUsd).toBeCloseTo(before.costUsd + 0.0002, 8)
  })

  it('passes empty tool list to the provider (no tools allowed)', async () => {
    mock.configureNext({ text: 'ok' })
    const session = makeSession()
    await session.querySide({ model: MOCK_MODEL, prompt: 'p' })
    expect(mock.lastRequest?.tools).toEqual([])
  })

  it('passes prompt as a single user message', async () => {
    mock.configureNext({ text: 'ok' })
    const session = makeSession()
    await session.querySide({
      model: MOCK_MODEL,
      prompt: 'the actual prompt',
    })
    expect(mock.lastRequest?.messages).toHaveLength(1)
    const msg = mock.lastRequest!.messages[0]!
    expect(msg.role).toBe('user')
    expect(msg.content).toBe('the actual prompt')
  })

  it('forwards systemPrompt to the provider', async () => {
    mock.configureNext({ text: 'ok' })
    const session = makeSession()
    await session.querySide({
      model: MOCK_MODEL,
      prompt: 'p',
      systemPrompt: 'You are a title generator.',
    })
    expect(mock.lastRequest?.system).toBe('You are a title generator.')
  })

  it('omits systemPrompt cleanly when not provided', async () => {
    mock.configureNext({ text: 'ok' })
    const session = makeSession()
    await session.querySide({ model: MOCK_MODEL, prompt: 'p' })
    expect(mock.lastRequest?.system).toBe('')
  })

  it('respects maxTokens override', async () => {
    mock.configureNext({ text: 'ok' })
    const session = makeSession()
    await session.querySide({
      model: MOCK_MODEL,
      prompt: 'p',
      maxTokens: 16,
    })
    expect(mock.lastRequest?.maxTokens).toBe(16)
  })

  it('uses default maxTokens (256) when not provided', async () => {
    mock.configureNext({ text: 'ok' })
    const session = makeSession()
    await session.querySide({ model: MOCK_MODEL, prompt: 'p' })
    expect(mock.lastRequest?.maxTokens).toBe(256)
  })

  it('strips the provider prefix from the model string for the wire request', async () => {
    mock.configureNext({ text: 'ok' })
    const session = makeSession()
    await session.querySide({ model: MOCK_MODEL, prompt: 'p' })
    // The provider sees the bare model id, not "querysidemock:any-model".
    expect(mock.lastRequest?.model).toBe('any-model')
  })

  it('does not change turnCount or message count', async () => {
    mock.configureNext({ text: 'ok' })
    const session = makeSession()
    const stateBefore = session.getState()
    await session.querySide({ model: MOCK_MODEL, prompt: 'p' })
    const stateAfter = session.getState()
    expect(stateAfter.turnCount).toBe(stateBefore.turnCount)
    expect(stateAfter.messages.length).toBe(stateBefore.messages.length)
  })

  it('multiple side calls accumulate cost without losing prior totals', async () => {
    const session = makeSession()

    mock.configureNext({
      text: 'a',
      usage: { inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    })
    await session.querySide({ model: MOCK_MODEL, prompt: '1' })

    mock.configureNext({
      text: 'b',
      usage: { inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    })
    await session.querySide({ model: MOCK_MODEL, prompt: '2' })

    const total = session.getState().totalUsage
    expect(total.inputTokens).toBe(200)
    expect(mock.callCount).toBe(2)
  })
})
