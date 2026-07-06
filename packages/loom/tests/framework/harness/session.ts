/**
 * Test Session
 *
 * THE KEY FILE. Creates a fully-configured Loom Session for testing.
 * This is the Loom framework's equivalent of the Cortex framework's
 * createTestGateway().
 *
 * Instead of starting an HTTP server, this wraps Session directly.
 * Tests interact with the engine — no HTTP layer, no gateway, no DB.
 */

import {
  Session,
  resolveProvider,
  createDefaultConfig,
  mergeConfig,
  HumanInTheLoop,
  AgentSpawner,
} from '../../../src/index.js'
import type {
  LoomConfig,
  ProviderAdapter,
  Tool,
  LoomEvent,
} from '../../../src/index.js'
import type { LoopResult } from '../../../src/core/loop.js'

import { createSandbox, type Sandbox } from './sandbox.js'
import { resolveTools, type ToolPreset } from './tools-fixture.js'
import { collectEvents, collectEventsWithResponder, type EventStream } from './event-collector.js'
import { FixtureRecorder, type FixtureMetadata } from './fixture-recorder.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TestSessionOptions {
  /** Model string. Default: 'anthropic:claude-haiku-4-5-20251001' (cheapest). */
  readonly model?: string

  /** Tool preset or array of tools. Default: 'none'. */
  readonly tools?: ToolPreset | Tool[]

  /** System prompt. Default: 'You are a concise test assistant.' */
  readonly systemPrompt?: string

  /** Max turns per run. Default: 5 (safety limit for tests). */
  readonly maxTurns?: number

  /** Max output tokens per turn. Default: 1024. */
  readonly maxTokens?: number

  /** Max budget in USD. Default: 0.10 (safety limit). */
  readonly maxBudgetUsd?: number

  /**
   * Permission mode:
   * - 'allow-all': All tools auto-approved (default for most tests)
   * - 'deny-all': All tools denied
   * - 'ask': Tools require HITL approval (for permission tests)
   */
  readonly permissionMode?: 'allow-all' | 'deny-all' | 'ask'

  /** Whether to create a sandbox workspace. Default: true. */
  readonly createSandbox?: boolean

  /** Whether to create an AgentSpawner. Default: false. */
  readonly enableAgentSpawning?: boolean

  /** Whether to record fixtures. Default: env RECORD_FIXTURES=1. */
  readonly recordFixtures?: boolean

  /** Additional config overrides merged into LoomConfig. */
  readonly configOverrides?: Partial<LoomConfig>
}

export interface TestSession {
  /** The Loom Session instance. */
  readonly session: Session

  /** The resolved provider adapter. */
  readonly provider: ProviderAdapter

  /** The active tools. */
  readonly tools: Tool[]

  /** The sandbox workspace (null if createSandbox was false). */
  readonly sandbox: Sandbox | null

  /** The HITL handler (for permission tests). */
  readonly hitl: HumanInTheLoop

  /** The agent spawner (null if enableAgentSpawning was false). */
  readonly spawner: AgentSpawner | null

  /** The fixture recorder. */
  readonly recorder: FixtureRecorder

  /** The resolved LoomConfig. */
  readonly config: LoomConfig

  /**
   * Run a prompt and collect all events.
   * This is the main test method — submit a message and get back
   * a typed EventStream with helper methods.
   *
   * @param prompt - The user message
   * @param timeoutMs - Optional timeout (default: 120_000)
   */
  run(prompt: string, timeoutMs?: number): Promise<EventStream>

  /**
   * Run a prompt with an automated permission responder.
   * The responder is called each time a permission.request fires.
   *
   * @param prompt - The user message
   * @param decide - Returns true (approve) or false (deny) for each request
   * @param timeoutMs - Optional timeout (default: 120_000)
   */
  runWithResponder(
    prompt: string,
    decide: (req: { requestId: string; toolName: string }) => boolean,
    timeoutMs?: number,
  ): Promise<EventStream>

  /**
   * Get the raw AsyncGenerator for manual event processing.
   * Use this when you need to interact with events mid-stream
   * in ways that collectEvents() doesn't support.
   */
  submit(prompt: string): AsyncGenerator<LoomEvent, LoopResult>

  /**
   * Record an event stream as a fixture for LLM review.
   */
  recordFixture(name: string, stream: EventStream, metadata?: FixtureMetadata): void

  /**
   * Clean up all resources (sandbox, recorder, HITL).
   * Call this in afterAll() or afterEach().
   */
  cleanup(): Promise<void>
}

// ---------------------------------------------------------------------------
// createTestSession
// ---------------------------------------------------------------------------

/**
 * Create a fully-configured test session.
 *
 * @param opts - Configuration options. All have sensible defaults.
 * @returns TestSession with run(), cleanup(), and direct access to internals.
 */
export async function createTestSession(opts: TestSessionOptions = {}): Promise<TestSession> {
  const {
    model = 'anthropic:claude-haiku-4-5-20251001',
    tools: toolsOpt = 'none',
    systemPrompt = 'You are a concise test assistant. Answer briefly. When asked to use tools, use them.',
    maxTurns = 5,
    maxTokens = 1024,
    maxBudgetUsd = 0.10,
    permissionMode = 'allow-all',
    createSandbox: shouldCreateSandbox = true,
    enableAgentSpawning = false,
    recordFixtures,
    configOverrides = {},
  } = opts

  // 1. Create sandbox (if requested)
  const sandbox = shouldCreateSandbox ? await createSandbox() : null

  // 2. Resolve provider
  const { provider } = resolveProvider(model)

  // 3. Resolve tools — include agent_spawn if spawning is enabled
  let tools = resolveTools(toolsOpt)
  if (enableAgentSpawning) {
    const { agentSpawn } = await import('../../../src/tools/builtins/agent.js')
    const hasAgentSpawn = tools.some(t => t.name === 'agent_spawn')
    if (!hasAgentSpawn) {
      tools = [...tools, agentSpawn]
    }
  }

  // 4. Build config
  const baseConfig = createDefaultConfig(model)
  const config = mergeConfig(baseConfig, {
    model,
    maxTurns,
    maxTokens,
    maxBudgetUsd,
    systemPrompt,
    workspacePath: sandbox?.path ?? null,
    ...configOverrides,
  })

  // 5. Set up permissions
  const hitl = new HumanInTheLoop()

  // Register a no-op handler so HITL doesn't auto-deny.
  // The actual respond() calls come from the test's responder callback
  // in runWithResponder(), or from onApprovalNeeded handlers set by tests.
  hitl.onApprovalNeeded(() => {
    // The event-collector's responder will call hitl.respond()
  })

  const checkPermission = async () => {
    switch (permissionMode) {
      case 'allow-all': return 'allow' as const
      case 'deny-all': return 'deny' as const
      case 'ask': return 'ask' as const
    }
  }

  const requestApproval = async (toolCall: { id: string; name: string; input: Record<string, unknown> }) => {
    return hitl.requestApproval(toolCall as any, 'Test permission request')
  }

  // 6. Set up agent spawner (if requested)
  let spawner: AgentSpawner | null = null
  let sessionConfig = config
  if (enableAgentSpawning) {
    spawner = new AgentSpawner({ provider, tools, config })
    sessionConfig = Object.assign({}, config, { agentSpawner: spawner })
  }

  // 7. Create session
  const session = new Session({
    config: sessionConfig,
    provider,
    tools,
    checkPermission,
    requestApproval,
  })

  // 8. Set up fixture recorder
  const recorder = new FixtureRecorder({ enabled: recordFixtures })

  // 9. Build TestSession interface
  return {
    session,
    provider,
    tools,
    sandbox,
    hitl,
    spawner,
    recorder,
    config: sessionConfig,

    async run(prompt: string, timeoutMs = 120_000): Promise<EventStream> {
      const gen = session.submitMessage(prompt)
      return collectEvents(gen, timeoutMs)
    },

    async runWithResponder(
      prompt: string,
      decide: (req: { requestId: string; toolName: string }) => boolean,
      timeoutMs = 120_000,
    ): Promise<EventStream> {
      const gen = session.submitMessage(prompt)
      return collectEventsWithResponder(gen, decide, hitl, timeoutMs)
    },

    submit(prompt: string): AsyncGenerator<LoomEvent, LoopResult> {
      return session.submitMessage(prompt)
    },

    recordFixture(name: string, stream: EventStream, metadata?: FixtureMetadata): void {
      recorder.record(name, stream, metadata)
    },

    async cleanup(): Promise<void> {
      hitl.dispose()
      spawner?.abortAll()
      await recorder.flush()
      if (sandbox) await sandbox.cleanup()
    },
  }
}
