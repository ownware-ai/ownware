/**
 * The Loom Agent Loop
 *
 * This is the heart of the framework. A while(true) AsyncGenerator
 * that calls the model, executes tools, and loops until done.
 *
 * Supports multi-provider, multi-agent, compaction, recovery,
 * streaming tool execution, human-in-the-loop, checkpointing.
 *
 * The loop is DUMB. The prompt is SMART.
 * If your agent framework has more logic than your prompts, reconsider.
 */

import type { LoomEvent, SessionEndEvent, StopReason, TurnUsage } from './events.js'
import type { LoomConfig } from './config.js'
import type { ProviderAdapter, ProviderChunk, ProviderRequest } from '../provider/types.js'
import type { Message, AssistantMessage, ContentBlock, ToolUseBlock } from '../messages/types.js'
import { extractToolCalls, createToolResultMessage } from '../messages/types.js'
import type { ReminderInjector } from '../reminders/index.js'
import { LOOM_TRACE } from '../observability/debug-trace.js'
import type { HookRuntime } from '../hooks/index.js'
import type { Tool, ToolCall, ToolContext, ToolResult } from '../tools/types.js'
import type { CredentialResolver } from '../credentials/resolver.js'
import type { CheckPermissionResult, DecisionReason } from '../permissions/types.js'
import { formatDecisionReason } from '../permissions/types.js'
import type {
  CredentialHandle,
  CredentialRequest,
  CredentialValue,
  EnvCredentialEntry,
} from '../credentials/types.js'
import type { CompactionManager } from '../compaction/manager.js'
import type { CheckpointStore } from '../checkpoint/types.js'
import { ProviderError, ToolError, ContextWindowExceededError } from './errors.js'
import { resolveProvider } from '../provider/registry.js'
import { computeCostWithFallback } from '../provider/pricing.js'
import {
  getEffectiveContextUsage,
  type UsageBaseline,
} from '../messages/tokens.js'
import { headTailTruncate } from '../messages/truncate.js'
import { ToolResultCache } from '../tools/result-cache.js'
import { spillToolResult, spillMarker } from '../tools/result-spill.js'
import type { SystemPrompt } from './system-prompt.js'
import {
  CACHE_CONTROL_MARKER_LIMIT,
  normalizeSystemPrompt,
  systemPromptToText,
} from './system-prompt.js'
import type { CacheProfile } from './cache-control.js'
import { buildCacheMarker } from './cache-control.js'
import { dropStaleToolResults } from '../compaction/tool-result-drop.js'
import { compactSupersededBrowserSnapshots } from '../compaction/browser-snapshot-supersede.js'

// ---------------------------------------------------------------------------
// Credential callback types (injectable at session level)
// ---------------------------------------------------------------------------

/**
 * Callback that blocks until the user provides a credential value (handle
 * returned) or denies (null returned). Identified by `requestId` so
 * consumers can correlate with the `credential.request` / `credential.response`
 * events the loop yields around each call.
 */
export type RequestCredentialFn = (
  request: CredentialRequest & { readonly requestId: string },
) => Promise<CredentialHandle | null>

/** Synchronous plaintext lookup — used by shell env-injection and redaction. */
export type ResolveCredentialFn = (credentialId: string) => string | null

/** Enumerate credentials that should be merged into every subprocess env. */
export type ListEnvCredentialsFn = () => readonly EnvCredentialEntry[]

/** Enumerate every credential value for output redaction. */
export type ListAllCredentialValuesFn = () => readonly CredentialValue[]

/**
 * Bundle of credential callbacks wired into the loop. All four are
 * independently optional so consumers (tests, embedded CLI) can opt into
 * a subset. Defaults are applied in the loop: everything is a no-op /
 * returns empty until a consumer wires real implementations.
 */
export interface CredentialCallbacks {
  readonly requestCredential?: RequestCredentialFn
  readonly resolveCredential?: ResolveCredentialFn
  readonly listEnvCredentials?: ListEnvCredentialsFn
  readonly listAllCredentialValues?: ListAllCredentialValuesFn
}

/** Every field non-optional after defaults applied in `loop()`. */
interface ResolvedCredentialCallbacks {
  readonly requestCredential: RequestCredentialFn
  readonly resolveCredential: ResolveCredentialFn
  readonly listEnvCredentials: ListEnvCredentialsFn
  readonly listAllCredentialValues: ListAllCredentialValuesFn
}

// Frozen empties reused across every tool call that has no credentials
// wired. Saves per-call allocations without risking mutation since the
// returned type is `readonly`.
const EMPTY_ENV_CREDENTIALS: readonly EnvCredentialEntry[] = Object.freeze([])
const EMPTY_CREDENTIAL_VALUES: readonly CredentialValue[] = Object.freeze([])

// ---------------------------------------------------------------------------
// Loop parameters
// ---------------------------------------------------------------------------

export interface LoopParams {
  /** Initial messages (conversation history) */
  messages: Message[]
  /**
   * Assembled system prompt. A bare string is treated as one cache-marked
   * block (legacy behaviour). An array of `SystemPromptBlock` lets the
   * caller split the prompt into stable (cache-marked) and volatile
   * (unmarked) sections so the cache survives tail changes.
   */
  systemPrompt: SystemPrompt
  /** Resolved provider adapter */
  provider: ProviderAdapter
  /** Available tools */
  tools: Tool[]
  /** Full config */
  config: LoomConfig
  /** Compaction manager (null = no compaction) */
  compaction: CompactionManager | null
  /** Checkpoint store (null = no checkpointing) */
  checkpoint: CheckpointStore | null
  /**
   * Host-supplied permission gate. Returns either the bare verdict
   * (back-compat) or a rich object carrying classification metadata
   * (zone level, severity tag, severity reason) that the loop attaches
   * to the `permission.request` event so the UI can render an
   * appropriate badge + warning copy. Cortex's wired closure returns
   * the rich form; tests and CLI hosts still return the bare string.
   */
  checkPermission: (tool: ToolCall) => Promise<'allow' | 'ask' | CheckPermissionResult>
  /** HITL approval handler (called when checkPermission returns 'ask') */
  requestApproval: (tool: ToolCall) => Promise<boolean>
  /**
   * Credential callbacks. When omitted, the loop installs no-op defaults:
   * `requestCredential` denies, `resolveCredential` returns null, and the
   * list callbacks return empty arrays. Consumers that want real HITL +
   * vault integration (Cortex) must wire all four.
   */
  credentials?: CredentialCallbacks
  /**
   * Unified credential resolver (board: credentials-unification — C20).
   * When set, the loop forwards it onto every `ToolContext` so tools
   * with a `requires: CredentialDescriptor[]` declaration can resolve
   * their credentials by canonical variable name.
   *
   * Coexists with the legacy `credentials` callbacks during the
   * cutover. Tools that don't read `context.credentialResolver` keep
   * working unchanged.
   */
  credentialResolver?: CredentialResolver
  /**
   * Optional override for the per-loop tool result cache. When omitted,
   * the loop creates a default `ToolResultCache()` with built-in size
   * limits. Pass an instance to share a cache across loops, or pass
   * one with `maxEntries: 0` to effectively disable caching for
   * benchmarks and tests that want to measure baseline behavior.
   */
  toolResultCache?: ToolResultCache
  /**
   * Optional reminder injector. When supplied, the loop drains any
   * queued reminder events at the top of every provider call and
   * attaches the rendered `<system-reminder>` text fragments to the
   * last user-side message in the request payload. The session's
   * stored message history is NOT mutated — only the wire payload
   * carries the reminders.
   *
   * Reminders are emitted by other runtime sources (mode transitions,
   * hooks, compaction, permissions, …) via `injector.emit(event)`.
   * When omitted, reminder behaviour is fully off — existing callers
   * see no behaviour change.
   */
  reminders?: ReminderInjector
  /**
   * Optional hook runtime. When supplied, the loop runs hooks at
   * lifecycle points: `session.start` once at the top, `tool.pre`
   * before every tool execution (a block synthesizes a denied
   * tool_result), and `tool.post` after every successful execution.
   * Hook outcomes flow through the reminder injector when both are
   * configured. When omitted, the loop's behaviour is unchanged.
   */
  hooks?: HookRuntime
  /**
   * Optional persistent reminder text. When set, the loop wraps it in
   * `<system-reminder>...</system-reminder>` and attaches it to every
   * outgoing user-side message — every turn — in addition to any
   * event-driven reminders drained from the `reminders` injector.
   *
   * The string is applied verbatim. Loom carries no content of its own
   * here; the field is a pure mechanism that lets a profile pin a
   * hard guarantee onto every turn (e.g. a verifier subagent pinning
   * "you must end with VERDICT: PASS|FAIL|PARTIAL"). Domain content
   * lives in the profile, not in the engine.
   *
   * When omitted or empty, the loop's behaviour is unchanged.
   */
  persistentReminder?: string
}

// ---------------------------------------------------------------------------
// Loop result
// ---------------------------------------------------------------------------

export interface LoopResult {
  readonly reason: StopReason
  readonly messages: Message[]
  readonly totalUsage: TurnUsage
  readonly turnCount: number
  /**
   * Snapshot of the most-recent provider `usage` response + message-
   * count bookmark. Carried back so the Session can use it as the
   * baseline for its own pre-call context-size checks (proactive
   * compaction scheduler) — keeping every "how big is the conversation"
   * decision on the same exact-baseline + delta-estimate math.
   *
   * `null` when the loop finished without any successful provider call
   * (e.g. immediate abort / error on turn 1).
   */
  readonly lastUsage: UsageBaseline | null
}

// ---------------------------------------------------------------------------
// Mutable loop state (carried between iterations)
// ---------------------------------------------------------------------------

interface LoopState {
  messages: Message[]
  turnIndex: number
  totalUsage: MutableUsage
  /**
   * Snapshot of the LAST successful provider call's usage + message
   * bookmark. Replaced on every `usage` event. Used by
   * `getEffectiveContextUsage` to compute pre-call context size cheaply
   * (exact baseline + chars÷4 estimate of messages added since).
   */
  lastUsage: UsageBaseline | null
  maxOutputTokensRecoveryCount: number
  rateLimitRetryCount: number
  /**
   * Reactive-compaction attempts in the CURRENT turn (reset each turn).
   * Gates the post-overflow forceCompact so a second overflow can still
   * recover, bounded by MAX_COMPACTION_RECOVERY.
   */
  compactionRecoveryCount: number
  hasAttemptedCompaction: boolean
  hasAttemptedFallback: boolean
  activeProvider: ProviderAdapter
  activeModel: string
  /**
   * Session-scoped cache for tool results. Tools opt in by defining
   * `cacheKey(input, context)` on their definition. Tools without a
   * cacheKey are never consulted against the cache. Created once per
   * loop run and discarded with the LoopState — never persisted.
   */
  toolResultCache: ToolResultCache
  /**
   * True once `turn.start` has been emitted for the current `turnIndex`
   * and a matching `turn.end` has NOT yet been emitted.
   *
   * Without this flag, a provider error that triggers a retry (compaction,
   * rate limit, model fallback) would re-yield `turn.start` at the top of
   * the next iteration, producing multiple `turn.start` events for the
   * same turnIndex with no intervening `turn.end`. That breaks the
   * lifecycle pairing invariant consumers rely on.
   */
  turnStartEmitted: boolean
}

interface MutableUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  costUsd: number
  /**
   * Sticky-OR across the whole session: once any turn was priced via
   * the Sonnet-tier fallback (uncatalogued model), the session's
   * cumulative `totalUsage.costUsd` is also an estimate and the status
   * bar should render `≈ $`. BUG #24.
   */
  isFallbackPricing: boolean
}

/** Tracks cumulative savings from prompt caching across the session */
interface CacheSavingsTracker {
  /** Total tokens that were served from cache (paid 10% rate) */
  totalCacheReadTokens: number
  /** Total tokens written to cache (paid 125% rate) */
  totalCacheCreationTokens: number
  /** Estimated USD saved vs no caching */
  cumulativeSavingsUsd: number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3

/**
 * How many times a single turn may trigger reactive compaction after a
 * context-overflow error. Each attempt forceCompacts further; once exhausted
 * (or forceCompact can shrink no more) the turn fails clean. Bounds the retry
 * so a genuinely-too-large turn can't loop forever, while still allowing a
 * SECOND overflow to recover — the case the old `!hasAttemptedCompaction`
 * gate made fatal once proactive compaction had already run this turn.
 */
const MAX_COMPACTION_RECOVERY = 2

// ---------------------------------------------------------------------------
// The Loop
// ---------------------------------------------------------------------------

/**
 * The agent loop. Call model → execute tools → loop.
 *
 * Yields LoomEvent for real-time streaming to any consumer
 * (TUI, web client, SDK, tests).
 *
 * Returns LoopResult when the agent is done.
 */
export async function* loop(params: LoopParams): AsyncGenerator<LoomEvent, LoopResult> {
  const {
    provider,
    tools,
    config,
    compaction,
    checkpoint,
    checkPermission,
    requestApproval,
  } = params

  // Credential callbacks. All four default to "no credentials wired" — that
  //'s the safe behaviour for tests and minimal embedders. Cortex passes
  // real implementations that route through its vault + HITL.
  const resolvedCredentials: ResolvedCredentialCallbacks = {
    requestCredential: params.credentials?.requestCredential ?? (async () => null),
    resolveCredential: params.credentials?.resolveCredential ?? (() => null),
    listEnvCredentials: params.credentials?.listEnvCredentials ?? (() => EMPTY_ENV_CREDENTIALS),
    listAllCredentialValues: params.credentials?.listAllCredentialValues ?? (() => EMPTY_CREDENTIAL_VALUES),
  }

  const state: LoopState = {
    messages: [...params.messages],
    turnIndex: 0,
    totalUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0, isFallbackPricing: false },
    lastUsage: null,
    maxOutputTokensRecoveryCount: 0,
    rateLimitRetryCount: 0,
    compactionRecoveryCount: 0,
    hasAttemptedCompaction: false,
    hasAttemptedFallback: false,
    toolResultCache: params.toolResultCache ?? new ToolResultCache(),
    activeProvider: provider,
    activeModel: config.model,
    turnStartEmitted: false,
  }

  /**
   * Zero-usage placeholder used when we must close a turn that never
   * produced any model output (e.g. aborted mid-retry, budget exceeded
   * after turn.start).
   */
  const zeroTurnUsage = (): TurnUsage => ({
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    model: state.activeModel,
    costUsd: 0,
  })

  const cacheSavings: CacheSavingsTracker = {
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    cumulativeSavingsUsd: 0,
  }

  // Context pressure thresholds — emit events at these levels
  const PRESSURE_THRESHOLDS = [0.60, 0.70, 0.80] as const
  let lastPressureEmitted = 0
  /**
   * Cooldown after a successful compaction: suppress `context.pressure`
   * emissions for `PRESSURE_COOLDOWN_TURNS` turns. Without this, a
   * compaction that frees (say) 27% would trigger a "Getting full"
   * warning again the very next turn — the model writes new content,
   * pressure climbs back, the threshold re-fires. Real example from
   * the GPT-5.5 thread incident: three "Getting full" events back-
   * to-back, all immediately after a successful compaction.
   *
   * Initialized to -1 so the very first turn never gets suppressed by
   * a never-fired compaction.
   */
  let lastCompactionTurnIndex = -1
  const PRESSURE_COOLDOWN_TURNS = 2

  // Session start
  yield {
    type: 'session.start',
    sessionId: config.sessionId,
    model: config.model,
    timestamp: Date.now(),
  }

  // Run session.start hooks. Outcomes route through the reminder
  // injector (when configured); a block on session.start is treated
  // as informational — we don't have a meaningful "abort the session
  // before any turn" path, and the model will see the `hook.blocked`
  // reminder on the first turn. The block is recorded on the loop's
  // pending state via the injector queue, not via control flow here.
  if (params.hooks?.has('session.start')) {
    await params.hooks.run({
      event: 'session.start',
      turnIndex: state.turnIndex,
      sessionId: config.sessionId,
      model: state.activeModel,
    }, config.abortSignal ?? undefined)
  }

  // -------------------------------------------------------------------------
  // Main loop
  // -------------------------------------------------------------------------
  while (true) {
    // Check abort
    if (config.abortSignal?.aborted) {
      if (state.turnStartEmitted) {
        yield {
          type: 'turn.end',
          turnIndex: state.turnIndex,
          stopReason: 'aborted',
          usage: zeroTurnUsage(),
          timestamp: Date.now(),
        }
        state.turnStartEmitted = false
      }
      return yield* endSession(
        finalize(state, 'aborted', state.activeModel, config.sessionId),
        params.hooks,
      )
    }

    // Check turn limit
    if (config.maxTurns > 0 && state.turnIndex >= config.maxTurns) {
      yield {
        type: 'error',
        code: 'MAX_TURNS',
        message: `Reached maximum turn limit (${config.maxTurns})`,
        recoverable: false,
        turnIndex: state.turnIndex,
      }
      if (state.turnStartEmitted) {
        yield {
          type: 'turn.end',
          turnIndex: state.turnIndex,
          stopReason: 'max_turns',
          usage: zeroTurnUsage(),
          timestamp: Date.now(),
        }
        state.turnStartEmitted = false
      }
      return yield* endSession(
        finalize(state, 'max_turns', state.activeModel, config.sessionId),
        params.hooks,
      )
    }

    // Check budget
    if (config.maxBudgetUsd > 0 && state.totalUsage.costUsd >= config.maxBudgetUsd) {
      yield {
        type: 'error',
        code: 'BUDGET_EXCEEDED',
        message: `Budget exceeded ($${state.totalUsage.costUsd.toFixed(4)} / $${config.maxBudgetUsd})`,
        recoverable: false,
        turnIndex: state.turnIndex,
      }
      if (state.turnStartEmitted) {
        yield {
          type: 'turn.end',
          turnIndex: state.turnIndex,
          stopReason: 'budget_exceeded',
          usage: zeroTurnUsage(),
          timestamp: Date.now(),
        }
        state.turnStartEmitted = false
      }
      return yield* endSession(
        finalize(state, 'budget_exceeded', state.activeModel, config.sessionId),
        params.hooks,
      )
    }

    // -------------------------------------------------------------------
    // TOOL-RESULT DROP — LLM-free, opt-in, runs before full compaction
    // -------------------------------------------------------------------
    //
    // Fires when (a) the profile opted in via `compaction.toolResultDrop`
    // AND (b) estimated context usage has crossed the drop trigger
    // fraction AND (c) full compaction has not already fired on this
    // session (if it had, the history is already minimal and the drop
    // has nothing useful to do).
    //
    // The drop rewrites stale `tool_result` bodies in place. We also
    // recompute pressure after the drop so the full-compaction check
    // below sees the post-drop state; this is what lets a drop delay
    // the full summary call.
    // -------------------------------------------------------------------
    // Browser-aware snapshot supersession (B4b) — runs BEFORE the
    // generic tool-result drop. On a chatty browser session this
    // reclaims context cheaply by dropping superseded snapshots only;
    // unrelated tool results (file reads, shell output) stay
    // verbatim until the generic drop trigger fires.
    // -------------------------------------------------------------------
    const browserCompactionConfig = config.compaction.browserSnapshotCompaction
    if (browserCompactionConfig?.enabled && !state.hasAttemptedCompaction) {
      const fraction = browserCompactionConfig.triggerFraction ?? 0.5
      const usage = getEffectiveContextUsage(
        state.messages,
        state.lastUsage,
        state.activeModel,
      )
      if (usage.fraction >= fraction) {
        const report = compactSupersededBrowserSnapshots(state.messages, {
          keepLatestPerTarget: browserCompactionConfig.keepLatestPerTarget ?? 1,
          keepRecentTurns: browserCompactionConfig.keepRecentTurns ?? 1,
          minBytesToDrop: browserCompactionConfig.minBytesToDrop ?? 500,
        })
        if (report.droppedCount > 0) {
          state.messages = report.messages
          yield {
            type: 'tool_result.drop',
            droppedCount: report.droppedCount,
            bytesReclaimed: report.bytesReclaimed,
            turnIndex: state.turnIndex,
          }
        }
      }
    }

    const dropConfig = config.compaction.toolResultDrop
    if (dropConfig?.enabled && !state.hasAttemptedCompaction) {
      const fraction = dropConfig.triggerFraction ?? 0.6
      // Use the unified context-size helper: exact baseline from the
      // last provider response + small delta estimate for messages
      // added since. No extra `provider.countTokens` round-trip.
      const usage = getEffectiveContextUsage(
        state.messages,
        state.lastUsage,
        state.activeModel,
      )
      if (usage.fraction >= fraction) {
        const report = dropStaleToolResults(state.messages, {
          keepRecentTurns: dropConfig.keepRecentTurns ?? 3,
          minBytesToDrop: dropConfig.minBytesToDrop ?? 500,
          previewBytes: dropConfig.previewBytes ?? 150,
        })
        if (report.droppedCount > 0) {
          state.messages = report.messages
          yield {
            type: 'tool_result.drop',
            droppedCount: report.droppedCount,
            bytesReclaimed: report.bytesReclaimed,
            turnIndex: state.turnIndex,
          }
        }
      }
    }

    // -------------------------------------------------------------------
    // COMPACTION — check before each model call
    // -------------------------------------------------------------------
    if (compaction) {
      // Reuse the effective context size we'll compute below for the
      // pressure check, instead of letting the manager call
      // `provider.countTokens` (extra API round-trip).
      const preCompactUsage = getEffectiveContextUsage(
        state.messages,
        state.lastUsage,
        state.activeModel,
      )
      // Proactive compaction is best-effort. A throw here (the summary
      // model erroring AND the truncation fallback also failing →
      // CompactionError) must NOT escape the loop body past finalize() —
      // that would end the generator with no session.end. Catch it, surface
      // a recoverable error, and proceed: if the context genuinely no longer
      // fits, the provider call below returns prompt_too_long, which the
      // stream catch handles via forceCompact.
      let compactionResult: Awaited<ReturnType<typeof compaction.compactIfNeeded>> = null
      try {
        compactionResult = await compaction.compactIfNeeded(
          state.messages,
          systemPromptToText(params.systemPrompt),
          preCompactUsage.tokens,
        )
      } catch (err) {
        yield {
          type: 'error',
          code: 'COMPACTION_FAILED',
          message: `Proactive compaction failed (${err instanceof Error ? err.message : String(err)}); continuing without it`,
          recoverable: true,
          turnIndex: state.turnIndex,
        }
      }
      if (compactionResult) {
        yield {
          type: 'compaction.start',
          strategy: compactionResult.strategy,
          preTokenCount: compactionResult.preTokenCount,
          turnIndex: state.turnIndex,
        }

        // Capture active skill names BEFORE we replace messages with the
        // compacted set — once the original tool_results are summarized,
        // the only way to surface "skills X and Y were running" to the
        // model post-compaction is via the dedicated reminder below.
        const activeSkills = extractActiveSkillNames(state.messages)

        state.messages = compactionResult.messages
        state.hasAttemptedCompaction = true

        const savedPercent = compactionResult.preTokenCount > 0
          ? Math.round(((compactionResult.preTokenCount - compactionResult.postTokenCount) / compactionResult.preTokenCount) * 100)
          : 0

        yield {
          type: 'compaction.end',
          strategy: compactionResult.strategy,
          preTokenCount: compactionResult.preTokenCount,
          postTokenCount: compactionResult.postTokenCount,
          savedPercent,
          turnIndex: state.turnIndex,
          ...(activeSkills.length > 0 ? { activeSkills } : {}),
        }

        // Push reminders so the next request carries them. The model will
        // see `<system-reminder>` tags on the next user message explaining
        // (a) that compaction happened and tool results may be summarized,
        // and (b) which skills were active before compaction so it doesn't
        // re-execute their setup actions.
        params.reminders?.emit({
          type: 'compaction.done',
          preTokens: compactionResult.preTokenCount,
          postTokens: compactionResult.postTokenCount,
        })
        if (activeSkills.length > 0) {
          params.reminders?.emit({
            type: 'skills.previously-invoked',
            skills: activeSkills,
          })
        }

        // Reset pressure tracking after compaction frees space, but
        // record the turn so the cooldown below can suppress noisy
        // re-warnings while the conversation refills naturally.
        lastPressureEmitted = 0
        lastCompactionTurnIndex = state.turnIndex
      }
    }

    // -------------------------------------------------------------------
    // TURN START
    // -------------------------------------------------------------------
    //
    // Idempotent on re-entry. On a provider-error retry (compaction, rate
    // limit, model fallback) the turn is still "in progress" with the same
    // turnIndex — re-emitting turn.start would break the pairing invariant.
    if (!state.turnStartEmitted) {
      yield {
        type: 'turn.start',
        turnIndex: state.turnIndex,
        timestamp: Date.now(),
      }
      state.turnStartEmitted = true
    }

    // -------------------------------------------------------------------
    // CONTEXT PRESSURE — warn before compaction threshold
    // -------------------------------------------------------------------
    //
    // Single source of truth: exact baseline from the previous provider
    // response + chars÷4 estimate ONLY for messages added since. This
    // replaces a full-conversation chars÷4 walk every turn (which
    // routinely overestimated by ~30% on code-heavy content, causing
    // premature "Getting full" warnings — see BUGS notes around the
    // GPT-5.5 over-firing incident).
    const usage = getEffectiveContextUsage(
      state.messages,
      state.lastUsage,
      state.activeModel,
    )
    const contextWindow = usage.window
    const estimatedTokens = usage.tokens
    const pressureLevel = usage.fraction

    // Cooldown after compaction: skip the entire pressure-emission
    // loop while we're inside the post-compaction window. Avoids the
    // back-to-back "Getting full" event spam users saw before this
    // fix (Loom would emit three warnings within seconds of a single
    // compaction freeing 27% — see PRESSURE_COOLDOWN_TURNS docstring).
    const turnsSinceCompaction = state.turnIndex - lastCompactionTurnIndex
    const inCooldown =
      lastCompactionTurnIndex >= 0 &&
      turnsSinceCompaction <= PRESSURE_COOLDOWN_TURNS

    for (const threshold of PRESSURE_THRESHOLDS) {
      if (inCooldown) break
      if (pressureLevel >= threshold && lastPressureEmitted < threshold) {
        lastPressureEmitted = threshold
        yield {
          type: 'context.pressure',
          level: pressureLevel,
          tokenCount: estimatedTokens,
          contextWindow,
          turnIndex: state.turnIndex,
        }
        // Mirror the pressure event as a budget.warn reminder so the
        // model sees it on the next turn (the LoomEvent flows OUT to
        // consumers; this gets the same signal back IN to the model).
        // Tokens, not USD — USD budgets need a cap defined elsewhere.
        params.reminders?.emit({
          type: 'budget.warn',
          used: estimatedTokens,
          total: contextWindow,
          currency: 'tokens',
        })
      }
    }

    // -------------------------------------------------------------------
    // CALL MODEL (streaming)
    // -------------------------------------------------------------------
    const activeModelBare = state.activeModel.includes(':')
      ? state.activeModel.slice(state.activeModel.indexOf(':') + 1)
      : state.activeModel

    // Multi-tier prompt caching strategy:
    // 1. System prompt → zero or more cache_control markers, one per stable
    //    block. Volatile blocks (date, cwd, memory) emit plain text with no
    //    marker, so changing them does not invalidate the stable prefix.
    // 2. Conversation message prefix → one cache_control marker on the last
    //    block of the final message. Extends the cache to include the full
    //    message history so far; next turn reads the whole thing at 10% rate.
    //
    // The hard cap is CACHE_CONTROL_BLOCK_LIMIT markers total. We budget one
    // for the message tail below, and give the rest to the system prompt.
    // Anything beyond the cap is stripped back to a plain text block so the
    // request itself still passes validation.
    const RESERVED_FOR_MESSAGE_MARKER = 1
    const systemMarkerBudget = Math.max(
      0,
      CACHE_CONTROL_BLOCK_LIMIT - RESERVED_FOR_MESSAGE_MARKER,
    )
    const systemBlocks: ProviderRequest['system'] = buildSystemRequestBlocks(
      params.systemPrompt,
      systemMarkerBudget,
      config.cacheProfile,
    )

    // model.pre hooks — before EACH provider call attempt (retries after
    // compaction / rate-limit recovery fire it again: "before each model
    // call" means each actual call). Deliberately placed BEFORE the
    // reminder drain below so a hook's `additionalContext` is queued in
    // time to be drained onto THIS request — that's what makes model.pre
    // the "inject fresh context per call" moment. Informational: the
    // result's `continue` is ignored (budget/turn gates already exist as
    // engine features; a model-call veto would leave the loop in a state
    // with no clean recovery).
    if (params.hooks?.has('model.pre')) {
      await params.hooks.run({
        event: 'model.pre',
        turnIndex: state.turnIndex,
        model: state.activeModel,
        messageCount: state.messages.length,
      }, config.abortSignal ?? undefined)
    }

    // Drain any queued reminders BEFORE cache marking so the volatile
    // reminder tail picks up the marker (and a stable user-content
    // prefix can still cache from earlier turns). Reminders are
    // appended to the last user-side message as a fresh text block;
    // the session's stored `state.messages` is NOT mutated — only the
    // request payload carries the reminders. If neither an injector
    // nor a persistent reminder is configured, the loop's behaviour
    // is identical to before.
    const drainedReminders = params.reminders
      ? params.reminders.drain({ turnIndex: state.turnIndex })
      : []
    const persistentReminderFragments =
      params.persistentReminder && params.persistentReminder.trim().length > 0
        ? [`<system-reminder>\n${params.persistentReminder.trim()}\n</system-reminder>`]
        : []
    const allReminders = [...persistentReminderFragments, ...drainedReminders]
    const messagesForRequest =
      allReminders.length > 0
        ? attachRemindersToMessages(state.messages, allReminders)
        : state.messages

    // Apply a single cache_control marker to the last conversation message.
    // `reservedSystemMarkers` counts the markers we actually placed on the
    // system blocks above, not the budget — so a prompt that used fewer
    // markers than allowed does not force the message side into a smaller
    // slot than necessary.
    const reservedSystemMarkers = countSystemBlockMarkers(systemBlocks)
    const cachedMessages = applyMessageCacheMarkers(
      messagesForRequest,
      reservedSystemMarkers,
      config.cacheProfile,
    )

    const request: ProviderRequest = {
      model: activeModelBare,
      system: systemBlocks,
      messages: cachedMessages,
      tools: tools.map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
      maxTokens: config.maxTokens,
      temperature: config.temperature,
      signal: config.abortSignal ?? undefined,
      ...(config.thinking ? { thinking: config.thinking } : {}),
    }

    let assistantContent: ContentBlock[] = []
    let turnUsage: TurnUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      model: state.activeModel,
      costUsd: 0,
    }
    let stopReason: StopReason = 'end_turn'

    try {
      // Accumulate streaming response
      const streamResult = yield* streamModelResponse(
        state.activeProvider,
        request,
        state.turnIndex,
        config,
        state.activeModel,
      )
      assistantContent = streamResult.content
      turnUsage = streamResult.usage
      stopReason = streamResult.stopReason
      // [loop-trace] What the streaming layer actually returned. If
      // content.length === 0 but the model clearly emitted a tool
      // call (per its SSE deltas), then message_complete never fired
      // → the adapter dropped the close signal. If content has the
      // tool_use block, the bug is in executeTools. Gated on LOOM_TRACE.
      if (LOOM_TRACE) {
        // eslint-disable-next-line no-console
        console.log('[loop-trace] post-stream', JSON.stringify({
          contentBlocks: assistantContent.length,
          contentTypes: assistantContent.map((b) => b.type),
          stopReason,
          turnIndex: state.turnIndex,
        }))
      }

      // Accumulate total usage
      state.totalUsage.inputTokens += turnUsage.inputTokens
      state.totalUsage.outputTokens += turnUsage.outputTokens
      state.totalUsage.cacheReadTokens += turnUsage.cacheReadTokens
      state.totalUsage.cacheCreationTokens += turnUsage.cacheCreationTokens
      state.totalUsage.costUsd += turnUsage.costUsd
      // Sticky-OR: once any turn fell back to Sonnet-tier pricing, the
      // whole session's `costUsd` is an estimate. BUG #24.
      if (turnUsage.isFallbackPricing === true) {
        state.totalUsage.isFallbackPricing = true
      }

      // Snapshot the exact baseline for the NEXT pre-call context-size
      // calculation. By the time we get here, the assistant's response
      // has been appended to `state.messages`, so the message-count
      // bookmark reflects the post-response conversation length.
      // `getEffectiveContextUsage()` reads this + estimates only the
      // delta of any messages added later — avoiding both a full
      // chars÷4 walk AND an extra `provider.countTokens` round-trip.
      state.lastUsage = {
        inputTokens: turnUsage.inputTokens,
        cacheReadTokens: turnUsage.cacheReadTokens,
        cacheCreationTokens: turnUsage.cacheCreationTokens,
        outputTokens: turnUsage.outputTokens,
        messageCountAtCapture: state.messages.length,
      }

      // Track cache savings and emit cache status event.
      //
      // Savings math is derived from the resolved ModelPricing (provider-aware)
      // rather than hard-coded constants. The previous implementation assumed
      // Anthropic's 0.1× cache-read rate and 90% savings universally — that's
      // wrong for OpenAI o-series (cache_read = ~25% of input) and Gemini Pro
      // (varies by tier), so cumulativeSavingsUsd silently drifted on those.
      cacheSavings.totalCacheReadTokens += turnUsage.cacheReadTokens
      cacheSavings.totalCacheCreationTokens += turnUsage.cacheCreationTokens
      if (turnUsage.cacheReadTokens > 0) {
        const pricing = state.activeProvider.getModelPricing(activeModelBare)
        // Resolve the actual cache-read multiplier from pricing. If the model
        // isn't in any pricing table (pricing == null) or its cacheRead is
        // null (e.g. cache pricing not yet published), fall back to the
        // industry-typical 0.1× — wrong by no more than ~2× in the worst case
        // and conservative (under-reports savings rather than over-reports).
        const inputRate = pricing?.input ?? 0
        const cacheReadRate = pricing?.cacheRead ?? (inputRate * 0.1)
        const cachedReadDiscount = inputRate > 0
          ? Math.max(0, inputRate - cacheReadRate) / inputRate
          : 0.9

        // USD saved this turn = tokens we read from cache × (full input rate
        // − discounted cache rate). All rates are $/MTok, so divide by 1M.
        const turnSavingsUsd = inputRate > 0
          ? (turnUsage.cacheReadTokens * (inputRate - cacheReadRate)) / 1_000_000
          : 0
        cacheSavings.cumulativeSavingsUsd += turnSavingsUsd

        // savingsPercent is the share of total INPUT-side tokens that landed
        // in cache, scaled by the discount fraction. So a turn that reads
        // 100% from cache at a 90% discount reports 90% savings; at a 75%
        // discount it reports 75%.
        const totalInput = turnUsage.inputTokens + turnUsage.cacheReadTokens + turnUsage.cacheCreationTokens
        const savingsPercent = totalInput > 0
          ? Math.round((turnUsage.cacheReadTokens / totalInput) * cachedReadDiscount * 100)
          : 0

        yield {
          type: 'cache.status',
          cacheReadTokens: turnUsage.cacheReadTokens,
          cacheCreationTokens: turnUsage.cacheCreationTokens,
          uncachedInputTokens: turnUsage.inputTokens,
          savingsPercent,
          cumulativeSavingsUsd: cacheSavings.cumulativeSavingsUsd,
          turnIndex: state.turnIndex,
        }
      }
    } catch (error) {
      // ---------------------------------------------------------------
      // ERROR RECOVERY
      // ---------------------------------------------------------------
      if (error instanceof ProviderError) {
        // Context overflow → try reactive compaction. Match on the typed
        // ContextWindowExceededError (the classifier builds it for OpenAI's
        // `context_length_exceeded`, Google's "exceeded the model's context",
        // and OpenRouter-routed models) as well as Anthropic's message-based
        // `isPromptTooLong`. The old code keyed ONLY on `isPromptTooLong`,
        // whose substrings are Anthropic-specific — so a non-Anthropic
        // overflow was classified correctly yet skipped here and hard-errored.
        //
        // Gate on a per-turn attempt counter, NOT `!hasAttemptedCompaction`:
        // when proactive compaction already ran this turn but the call STILL
        // overflowed, the old gate blocked reactive compaction and the turn
        // died. A second (bounded) reactive attempt is the recovery that case
        // needs.
        const isContextOverflow =
          error instanceof ContextWindowExceededError || error.isPromptTooLong
        if (isContextOverflow && compaction && state.compactionRecoveryCount < MAX_COMPACTION_RECOVERY) {
          yield {
            type: 'recovery',
            reason: 'prompt_too_long',
            attempt: state.compactionRecoveryCount + 1,
            detail: 'Attempting reactive compaction',
            turnIndex: state.turnIndex,
          }

          // forceCompact runs its own summary+truncation fallback; if BOTH
          // fail it throws. Don't let that escape the catch (and the loop)
          // past finalize() — null it out and fall through to the
          // unrecoverable-error path below, which emits a clean error +
          // turn.end + session.end.
          let result: Awaited<ReturnType<typeof compaction.forceCompact>> = null
          try {
            result = await compaction.forceCompact(state.messages, systemPromptToText(params.systemPrompt))
          } catch {
            result = null
          }
          if (result) {
            state.messages = result.messages
            state.hasAttemptedCompaction = true
            state.compactionRecoveryCount++
            continue // Retry with compacted messages
          }
        }

        // Rate limit → retry with backoff (max 10 retries)
        if (error.isRateLimit || error.isOverloaded) {
          state.rateLimitRetryCount++
          if (state.rateLimitRetryCount <= 10) {
            const delay = error.retryAfterMs ?? config.retry.baseDelayMs
            yield {
              type: 'recovery',
              reason: 'rate_limit',
              attempt: state.rateLimitRetryCount,
              detail: `Rate limited, retrying in ${delay}ms (attempt ${state.rateLimitRetryCount}/10)`,
              turnIndex: state.turnIndex,
            }
            await sleep(delay)
            continue
          }
          // Exceeded max retries — try fallback model if configured
          if (config.fallbackModel && !state.hasAttemptedFallback) {
            state.hasAttemptedFallback = true
            state.rateLimitRetryCount = 0

            try {
              const resolved = resolveProvider(config.fallbackModel)
              state.activeProvider = resolved.provider
              state.activeModel = config.fallbackModel
            } catch {
              // Could not resolve fallback provider — fall through to error
            }

            if (state.activeModel === config.fallbackModel) {
              yield {
                type: 'recovery',
                reason: 'model_fallback',
                attempt: 1,
                detail: `Switching from ${config.model} to ${config.fallbackModel}`,
                turnIndex: state.turnIndex,
              }
              continue
            }
          }
          // Fall through to unrecoverable error
        }
      }

      // Unrecoverable error
      yield {
        type: 'error',
        code: error instanceof ProviderError ? error.code : 'UNKNOWN',
        message: error instanceof Error ? error.message : String(error),
        recoverable: false,
        turnIndex: state.turnIndex,
      }
      if (state.turnStartEmitted) {
        yield {
          type: 'turn.end',
          turnIndex: state.turnIndex,
          stopReason: 'error',
          usage: turnUsage,
          timestamp: Date.now(),
        }
        state.turnStartEmitted = false
      }
      // `error` hooks fire only on this unrecoverable path (recoverable
      // errors above retried instead of ending the session). Informational:
      // the run is already lost; a hook cannot un-fail it. Runs before the
      // session.end hooks so an operator's onError webhook carries the
      // failure while onComplete carries the terminal reason.
      if (params.hooks?.has('error')) {
        await params.hooks.run({
          event: 'error',
          turnIndex: state.turnIndex,
          code: error instanceof ProviderError ? error.code : 'UNKNOWN',
          message: error instanceof Error ? error.message : String(error),
        })
      }
      return yield* endSession(
        finalize(state, 'error', state.activeModel, config.sessionId),
        params.hooks,
      )
    }

    // Add assistant message to history
    const assistantMessage: AssistantMessage = {
      role: 'assistant',
      content: assistantContent,
    }
    state.messages.push(assistantMessage)

    // -------------------------------------------------------------------
    // NO TOOL CALLS → check if done or needs recovery
    // -------------------------------------------------------------------
    const toolCalls = extractToolCalls(assistantMessage)
    // [loop-trace] Branch decision — how many tool calls were
    // extracted from the assistant message. If 0 and the model meant
    // to call one, the message_complete chunk got lost. Gated on LOOM_TRACE.
    if (LOOM_TRACE) {
      // eslint-disable-next-line no-console
      console.log('[loop-trace] tool-call-extract', JSON.stringify({
        toolCallsCount: toolCalls.length,
        toolNames: toolCalls.map((c) => c.name),
        stopReason,
        turnIndex: state.turnIndex,
      }))
    }

    // model.post hooks — after each SUCCESSFUL provider response, once
    // the assistant message is recorded and its tool calls are counted.
    // The metering moment: per-call usage, cost, stop reason, and how
    // many tools the model asked for. Informational — the response
    // already exists; blocking here would have nothing left to block
    // (vetoing individual tools is tool.pre's job).
    if (params.hooks?.has('model.post')) {
      await params.hooks.run({
        event: 'model.post',
        turnIndex: state.turnIndex,
        model: state.activeModel,
        stopReason,
        inputTokens: turnUsage.inputTokens,
        outputTokens: turnUsage.outputTokens,
        costUsd: turnUsage.costUsd,
        toolCallCount: toolCalls.length,
      }, config.abortSignal ?? undefined)
    }

    if (toolCalls.length === 0) {
      // Max output tokens recovery (3-retry pattern)
      if (stopReason === 'max_tokens' &&
          state.maxOutputTokensRecoveryCount < MAX_OUTPUT_TOKENS_RECOVERY_LIMIT) {
        state.maxOutputTokensRecoveryCount++

        yield {
          type: 'recovery',
          reason: 'max_output_tokens',
          attempt: state.maxOutputTokensRecoveryCount,
          detail: `Output limit hit, recovery attempt ${state.maxOutputTokensRecoveryCount}/${MAX_OUTPUT_TOKENS_RECOVERY_LIMIT}`,
          turnIndex: state.turnIndex,
        }

        // Close the current turn before we bump turnIndex and kick off the
        // continuation turn. Without this, the old turnIndex's turn.start
        // would be orphaned (never paired with a turn.end) and the UI
        // would show it stuck in "thinking" forever.
        yield {
          type: 'turn.end',
          turnIndex: state.turnIndex,
          stopReason: 'max_tokens',
          usage: turnUsage,
          timestamp: Date.now(),
        }
        state.turnStartEmitted = false

        // Inject recovery message to resume without repetition
        state.messages.push({
          role: 'user',
          content: 'Output token limit hit. Resume directly — no apology, no recap. Pick up mid-thought. Break remaining work into smaller pieces.',
        })
        state.turnIndex++
        continue
      }

      // Done. Forward the exact provider stop reason so callers can
      // distinguish a refusal (content-policy block) from a clean end,
      // or act on a pause_turn / stop_sequence signal. Only max_turns /
      // budget_exceeded / aborted / error are loop-owned — those are set
      // elsewhere in this function, not here.
      const finalReason: StopReason =
        stopReason === 'max_tokens' ||
        stopReason === 'refusal' ||
        stopReason === 'pause_turn' ||
        stopReason === 'stop_sequence'
          ? stopReason
          : 'end_turn'

      yield {
        type: 'turn.end',
        turnIndex: state.turnIndex,
        stopReason: finalReason,
        usage: turnUsage,
        timestamp: Date.now(),
      }
      state.turnStartEmitted = false

      return yield* endSession(
        finalize(state, finalReason, state.activeModel, config.sessionId),
        params.hooks,
      )
    }

    // -------------------------------------------------------------------
    // EXECUTE TOOLS
    // -------------------------------------------------------------------
    const toolResults = yield* executeTools(
      toolCalls,
      tools,
      config,
      state.turnIndex,
      checkPermission,
      requestApproval,
      resolvedCredentials,
      params.credentialResolver,
      state.toolResultCache,
      params.hooks,
      params.reminders,
    )

    // Add tool results to messages. The tool's `metadata` rides
    // alongside as a Loom-internal carrier (B4a) — compaction strategies
    // and other consumers read typed signal from there instead of
    // string-matching `content`. Provider serializers strip it before
    // any wire send.
    for (const result of toolResults) {
      state.messages.push(
        createToolResultMessage(
          result.toolCall.id,
          result.result.content,
          result.result.isError,
          result.result.metadata,
        ),
      )
    }

    // Turn end
    yield {
      type: 'turn.end',
      turnIndex: state.turnIndex,
      stopReason: 'tool_use',
      usage: turnUsage,
      timestamp: Date.now(),
    }
    state.turnStartEmitted = false

    // Checkpoint after each turn (if enabled)
    if (checkpoint) {
      // A checkpoint write failure (disk full, Postgres down) is NOT fatal
      // to the live run — without this guard the throw escapes the loop body
      // past finalize(), ending the generator with no session.end and
      // discarding the rest of the turn's lifecycle. Surface a recoverable
      // error and continue: the user keeps their session, they just don't
      // get this turn's restore point.
      try {
        const checkpointId = await checkpoint.save({
          sessionId: config.sessionId,
          messages: state.messages,
          turnIndex: state.turnIndex,
          usage: { ...state.totalUsage },
          timestamp: Date.now(),
        })
        yield {
          type: 'checkpoint.saved',
          checkpointId,
          turnIndex: state.turnIndex,
        }
      } catch (err) {
        yield {
          type: 'error',
          code: 'CHECKPOINT_FAILED',
          message: `Checkpoint save failed (${err instanceof Error ? err.message : String(err)}); session continues`,
          recoverable: true,
          turnIndex: state.turnIndex,
        }
      }
    }

    // Reset recovery counters
    state.maxOutputTokensRecoveryCount = 0
    state.rateLimitRetryCount = 0
    state.compactionRecoveryCount = 0
    state.hasAttemptedCompaction = false
    state.turnIndex++

    // Loop continues → model sees tool results, decides next action
  }
}

// ---------------------------------------------------------------------------
// Stream model response
// ---------------------------------------------------------------------------

async function* streamModelResponse(
  provider: ProviderAdapter,
  request: ProviderRequest,
  turnIndex: number,
  config: LoomConfig,
  activeModel: string,
): AsyncGenerator<LoomEvent, {
  content: ContentBlock[]
  usage: TurnUsage
  stopReason: StopReason
}> {
  const content: ContentBlock[] = []
  let fullText = ''
  let fullThinking = ''
  let currentToolArgs = ''
  let usage: TurnUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    model: activeModel,
    costUsd: 0,
  }
  let stopReason: StopReason = 'end_turn'

  // Stream-idle watchdog. Each chunk we consume resets a 30s timer;
  // if the provider's iterator goes silent for longer than that we
  // abort the upstream stream and throw. The outer agent loop's catch
  // turns that into an `error` + `turn.end` so the run unparks
  // visibly instead of hanging forever on a misbehaving provider /
  // proxy. Provider-agnostic by design — it doesn't care WHY the
  // stream went silent, only that it did.
  //
  // 30s threshold = generous enough to absorb normal model pauses
  // (e.g. long internal reasoning between tool calls on slow routes)
  // while still catching real hangs. Tunable per-provider later.
  const STREAM_IDLE_MS = 30_000
  const iterator = provider.stream(request)[Symbol.asyncIterator]()

  try {
    while (true) {
      if (config.abortSignal?.aborted) break

      let stallTimer: ReturnType<typeof setTimeout> | undefined
      const raced = await Promise.race<
        | { kind: 'chunk'; result: IteratorResult<ProviderChunk> }
        | { kind: 'stall' }
      >([
        iterator.next().then((result) => ({ kind: 'chunk' as const, result })),
        new Promise<{ kind: 'stall' }>((resolve) => {
          stallTimer = setTimeout(() => resolve({ kind: 'stall' }), STREAM_IDLE_MS)
        }),
      ])
      if (stallTimer !== undefined) clearTimeout(stallTimer)

      if (raced.kind === 'stall') {
        // Watchdog fired — log to gateway stderr for forensics, then
        // throw. The catch in the caller turns this into a visible
        // error in the chat + a clean turn.end.
        // eslint-disable-next-line no-console
        console.warn(
          `[watchdog] model stream stalled — no chunks for ${STREAM_IDLE_MS}ms ` +
            `(model=${activeModel}, turnIndex=${turnIndex})`,
        )
        throw new Error(
          `Model stream stalled — no chunks received for ${Math.round(STREAM_IDLE_MS / 1000)}s. ` +
            `The provider may be slow or unresponsive; try again or pick a different model.`,
        )
      }

      const { done, value: chunk } = raced.result
      if (done) break

      switch (chunk.type) {
        case 'text_delta':
          fullText += chunk.text
          yield {
            type: 'text.delta',
            text: chunk.text,
            turnIndex,
          }
          break

        case 'thinking_delta':
          fullThinking += chunk.text
          yield {
            type: 'thinking.delta',
            text: chunk.text,
            turnIndex,
          }
          break

        case 'tool_use_start':
          currentToolArgs = ''
          yield {
            type: 'tool.call.start',
            toolCallId: chunk.id,
            toolName: chunk.name,
            input: {},
            turnIndex,
          }
          break

        case 'tool_use_args_delta':
          currentToolArgs += chunk.delta
          yield {
            type: 'tool.call.args_delta',
            toolCallId: chunk.id,
            delta: chunk.delta,
            turnIndex,
          }
          break

        case 'tool_use_end':
          currentToolArgs = ''
          break

        case 'message_complete':
          content.push(...chunk.content)
          // Forward the provider's normalized stop reason verbatim. The
          // provider types.ts union is a strict subset of StopReason, so this
          // is typesafe and preserves refusal/pause_turn/stop_sequence signals
          // that callers (UI, audit log, caller-side fallback logic) rely on.
          stopReason = chunk.stopReason
          {
            // Cost: prefer the provider's authoritative `reportedCostUsd`
            // (e.g. OpenRouter passes its own billed number through) and
            // only fall through to Loom's pricing math when absent. The
            // fallback path returns a flag so `TurnUsage.isFallbackPricing`
            // surfaces whether the number is estimated — the status bar
            // renders `≈ $` for estimated values (BUG #24).
            const computed = chunk.usage.reportedCostUsd != null
              ? { costUsd: chunk.usage.reportedCostUsd, isFallback: false }
              : computeCost(
                  provider,
                  activeModel,
                  chunk.usage.inputTokens,
                  chunk.usage.outputTokens,
                  chunk.usage.cacheReadTokens,
                  chunk.usage.cacheCreationTokens,
                )
            usage = {
              inputTokens: chunk.usage.inputTokens,
              outputTokens: chunk.usage.outputTokens,
              cacheReadTokens: chunk.usage.cacheReadTokens,
              cacheCreationTokens: chunk.usage.cacheCreationTokens,
              model: activeModel,
              costUsd: computed.costUsd,
              // Only stamp the flag when true — keep events identical to
              // the pre-#24 wire shape for the common authoritative path
              // (back-compat for any external consumer parsing strictly).
              ...(computed.isFallback ? { isFallbackPricing: true } : {}),
            }
          }
          break

        case 'stream_error':
          throw chunk.error
      }
    }
  } finally {
    // Best-effort cleanup. Tells the provider's iterator we're done
    // so the underlying HTTP/SSE connection is closed promptly — on
    // both the happy path (done=true) AND the error path (watchdog
    // fire, abort, exception). Without this, a stalled OpenRouter
    // socket can stay open in the kernel until the OS times it out.
    if (typeof iterator.return === 'function') {
      try { await iterator.return(undefined) } catch { /* ignore */ }
    }
  }

  // Anthropic streams thinking before text, so mirror that order here:
  // thinking.complete first, then text.complete. Consumers rely on the
  // sequence to render the reasoning panel before the final answer.
  if (fullThinking) {
    yield { type: 'thinking.complete', text: fullThinking, turnIndex }
  }
  if (fullText) {
    yield { type: 'text.complete', text: fullText, turnIndex }
  }

  return { content, usage, stopReason }
}

// ---------------------------------------------------------------------------
// Execute tools
// ---------------------------------------------------------------------------

async function* executeTools(
  toolCalls: ToolUseBlock[],
  tools: Tool[],
  config: LoomConfig,
  turnIndex: number,
  checkPermission: (tool: ToolCall) => Promise<'allow' | 'ask' | CheckPermissionResult>,
  requestApproval: (tool: ToolCall) => Promise<boolean>,
  credentials: ResolvedCredentialCallbacks,
  credentialResolver: CredentialResolver | undefined,
  cache: ToolResultCache,
  hooks: HookRuntime | undefined,
  reminders: ReminderInjector | undefined,
): AsyncGenerator<LoomEvent, Array<{ toolCall: ToolCall; result: ToolResult }>> {
  const results: Array<{ toolCall: ToolCall; result: ToolResult }> = []

  // Partition into read-only (parallel) and write (serial)
  const readOnlyCalls: Array<{ call: ToolUseBlock; tool: Tool }> = []
  const writeCalls: Array<{ call: ToolUseBlock; tool: Tool }> = []

  for (const call of toolCalls) {
    const tool = tools.find(t => t.name === call.name)
    if (!tool) {
      // tool.call.start was emitted during streaming. Close the pairing
      // so the UI doesn't leave the tool spinning on an unresolvable name.
      const unknownMessage = `Unknown tool: ${call.name}`
      yield {
        type: 'tool.call.end',
        toolCallId: call.id,
        toolName: call.name,
        result: unknownMessage,
        isError: true,
        durationMs: 0,
        turnIndex,
      }
      results.push({
        toolCall: { id: call.id, name: call.name, input: call.input },
        result: { content: unknownMessage, isError: true },
      })
      continue
    }

    // Partition: pure read-only tools (no permission prompt possible) →
    // parallel batch. Anything that MIGHT block on HITL (permission /
    // credential) → serial path that streams events as the generator
    // yields them. Without the requiresPermission carve-out, a tool
    // like web_fetch (isReadOnly=true, requiresPermission=true) routes
    // to executeSingleTool, which buffers `permission.request` in an
    // array and only flushes it after the generator finishes — but the
    // generator can't finish because it's blocked on `requestApproval`,
    // which is waiting for the user, who never sees the strip because
    // the event is buffered. Classic HITL deadlock; see comment on
    // executeSingleTool.
    if (tool.isReadOnly && !tool.requiresPermission) {
      readOnlyCalls.push({ call, tool })
    } else {
      writeCalls.push({ call, tool })
    }
  }

  // Execute read-only tools in parallel
  if (readOnlyCalls.length > 0) {
    const parallel = readOnlyCalls.map(({ call, tool }) =>
      executeSingleTool(call, tool, config, turnIndex, checkPermission, requestApproval, credentials, credentialResolver, cache, hooks, reminders),
    )

    for await (const { events, result } of parallelExecute(parallel)) {
      for (const event of events) {
        yield event
      }
      results.push(result)
    }
  }

  // Execute write tools serially — use generator directly so
  // permission.request events stream to SSE BEFORE blocking on approval
  for (const { call, tool } of writeCalls) {
    const gen = executeSingleToolGen(call, tool, config, turnIndex, checkPermission, requestApproval, credentials, credentialResolver, cache, hooks, reminders)
    let iterResult = await gen.next()
    while (!iterResult.done) {
      yield iterResult.value
      iterResult = await gen.next()
    }
    results.push(iterResult.value)
  }

  return results
}

// ---------------------------------------------------------------------------
// Execute a single tool
// ---------------------------------------------------------------------------

async function* executeSingleToolGen(
  call: ToolUseBlock,
  tool: Tool,
  config: LoomConfig,
  turnIndex: number,
  checkPermission: (tool: ToolCall) => Promise<'allow' | 'ask' | CheckPermissionResult>,
  requestApproval: (tool: ToolCall) => Promise<boolean>,
  credentials: ResolvedCredentialCallbacks,
  credentialResolver: CredentialResolver | undefined,
  cache: ToolResultCache,
  hooks: HookRuntime | undefined,
  reminders: ReminderInjector | undefined,
): AsyncGenerator<LoomEvent, { toolCall: ToolCall; result: ToolResult }> {
  const toolCall: ToolCall = { id: call.id, name: call.name, input: call.input }
  const startTime = Date.now()

  // tool.pre hooks run BEFORE the permission check. If a hook blocks,
  // we synthesize a denied tool_result mirroring the policy-deny path
  // below so the model sees a clean failure with the hook's reason
  // attached as a `hook.blocked` reminder on the next turn.
  if (hooks?.has('tool.pre')) {
    const hookResult = await hooks.run(
      {
        event: 'tool.pre',
        turnIndex,
        toolName: call.name,
        toolInput: call.input,
      },
      config.abortSignal ?? undefined,
    )
    if (!hookResult.continue) {
      // Build a typed deny reason so the model can extract structured
      // context (which hook fired, why) and react appropriately.
      const decisionReason: DecisionReason = {
        type: 'hook-blocked',
        toolName: call.name,
        reason: hookResult.blockedReason ?? 'Tool blocked by hook',
      }
      const blockedMessage = formatDecisionReason(decisionReason)
      yield {
        type: 'tool.call.end',
        toolCallId: call.id,
        toolName: call.name,
        result: blockedMessage,
        isError: true,
        durationMs: Date.now() - startTime,
        turnIndex,
      }
      return { toolCall, result: { content: blockedMessage, isError: true } }
    }
  }

  // Permission check
  if (tool.requiresPermission) {
    // A throw from `checkPermission` (e.g. ZoneManager classifier
    // failure, host vault I/O error, transient lookup glitch) must
    // NOT tear the turn down. Without this guard the rejection
    // propagates through `await gen.next()` in `executeTools` and
    // through `Promise.all` in `parallelExecute`, killing the whole
    // run — strictly worse than fail-deny because the user can't
    // see why or re-prompt. Map the throw to a synthetic `'ask'`
    // so the HITL path still runs and the user decides; the
    // permission model doesn't specify behavior on classifier
    // failure, so `'ask'` is the right
    // default — it preserves user control instead of silently
    // auto-allowing OR silently killing the run.
    let rawResult: 'allow' | 'ask' | CheckPermissionResult
    try {
      rawResult = await checkPermission(toolCall)
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : String(err)
      rawResult = {
        decision: 'ask',
        explanation: `Permission classifier failed (${errMessage}) — asking for explicit approval`,
        severityTag: 'critical',
        severityReason: 'classifier-error',
      }
    }

    // Normalize the host's response shape. Hosts may return the bare
    // verdict (back-compat) or a rich object carrying classification
    // metadata for the UI. After this block, `verdict` is the policy
    // outcome and `meta` is the optional classification data.
    const verdict: 'allow' | 'ask' = typeof rawResult === 'string'
      ? rawResult
      : rawResult.decision
    const meta: CheckPermissionResult | null = typeof rawResult === 'string'
      ? null
      : rawResult

    // Post-redesign (2026-05-14): there is no policy-level 'deny'.
    // The only outcomes are 'allow' (proceed) or 'ask' (HITL prompt).
    // A user can still decline the prompt — that path is below and
    // returns a structured DecisionReason to the model.

    if (verdict === 'ask') {
      // Yield permission.request IMMEDIATELY so the SSE stream sends it
      // to the UI BEFORE we block on requestApproval(). Attach any
      // classification metadata the host supplied so the UI can render
      // a severity badge + reason copy.
      yield {
        type: 'permission.request',
        requestId: call.id,
        toolName: call.name,
        input: call.input,
        reason: meta?.explanation ?? 'Tool requires explicit approval',
        turnIndex,
        ...(meta?.zoneLevel !== undefined ? { zoneLevel: meta.zoneLevel } : {}),
        ...(meta?.zoneName !== undefined ? { zoneName: meta.zoneName } : {}),
        ...(meta?.explanation !== undefined ? { explanation: meta.explanation } : {}),
        ...(meta?.severityTag !== undefined ? { severityTag: meta.severityTag } : {}),
        ...(meta?.severityReason !== undefined ? { severityReason: meta.severityReason } : {}),
      }

      // This blocks until the user responds via HITL. A throw from the
      // host approval channel — SSE/IPC drop, gateway restart, session
      // teardown, or an abort landing while the prompt is open — must NOT
      // tear the turn down. Without this guard the rejection propagates out
      // of executeTools (yielded at loop.ts:1065, past the stream-only
      // try/catch), discarding every result for the turn and leaving every
      // tool.call.start unclosed → the UI's tool cards spin forever
      // (Principle 1). Mirror the guarded checkPermission path above: treat
      // a throw as a denial so the model still gets a clean tool_result and
      // the user keeps control — fail-closed, never auto-allow on a broken
      // channel.
      let approved: boolean
      try {
        approved = await requestApproval(toolCall)
      } catch {
        approved = false
      }

      if (!approved) {
        // Build a typed DecisionReason for the response event + tool
        // result. The model gets a structured prose message it can
        // react to (file path, command, severity, etc.) instead of
        // three words. Severity surfaces if the host provided it via
        // the rich `CheckPermissionResult` shape.
        const decisionReason: DecisionReason = {
          type: 'user-denied',
          toolName: call.name,
          toolInput: call.input,
          ...(meta?.severityTag !== undefined ? { severityTag: meta.severityTag } : {}),
          ...(meta?.severityReason !== undefined ? { severityReason: meta.severityReason } : {}),
        }
        const deniedResult = formatDecisionReason(decisionReason)

        yield {
          type: 'permission.response',
          requestId: call.id,
          granted: false,
          turnIndex,
          reason: decisionReason,
        }

        reminders?.emit({
          type: 'tool.denied',
          toolName: call.name,
          reason: deniedResult,
        })
        // Close the tool.call that streaming opened — without
        // tool.call.end the UI leaves the tool card spinning.
        yield {
          type: 'tool.call.end',
          toolCallId: call.id,
          toolName: call.name,
          result: deniedResult,
          isError: true,
          durationMs: Date.now() - startTime,
          turnIndex,
        }
        return { toolCall, result: { content: deniedResult, isError: true } }
      }

      yield {
        type: 'permission.response',
        requestId: call.id,
        granted: true,
        turnIndex,
      }
    }
  }

  // Execute with timeout
  const timeoutMs = tool.timeoutMs ?? config.toolExecution.defaultTimeoutMs
  const effectiveCwd = config.workspacePath ?? process.cwd()
  const context: ToolContext = {
    cwd: effectiveCwd,
    signal: config.abortSignal ?? new AbortController().signal,
    sessionId: config.sessionId,
    rootSessionId: config.rootSessionId ?? config.sessionId,
    agentId: config.agentId,
    workspacePath: effectiveCwd,
    additionalWorkspaceRoots: config.additionalWorkspaceRoots,
    config,
    requestPermission: async (action, detail) => {
      return requestApproval({ id: call.id, name: action, input: { detail } })
    },
    // Credential surface — the `request_credential` built-in uses the
    // progress-marker path (yielded via ToolProgress.credentialRequest)
    // rather than this Promise callback so the event emission and the
    // HITL block happen in the loop's generator scope. The callback
    // exists for completeness / non-streaming tools; it routes through
    // the same session-level `requestCredential` function but without
    // any surrounding credential.request / credential.response events —
    // consumers that need the events should use the progress-marker
    // path from an AsyncGenerator tool.
    requestCredential: async (request) => {
      return credentials.requestCredential({ ...request, requestId: call.id })
    },
    resolveCredential: credentials.resolveCredential,
    listEnvCredentials: credentials.listEnvCredentials,
    listAllCredentialValues: credentials.listAllCredentialValues,
    ...(credentialResolver !== undefined ? { credentialResolver } : {}),
  }

  // Cache lookup — only for tools that opted in via `cacheKey`. A
  // returned key === null means "this specific call isn't safe to
  // cache" (tool's choice), so we skip the lookup entirely.
  const cacheKey = tool.cacheKey
    ? tool.cacheKey(call.input as Record<string, unknown>, context)
    : null
  const cachedResult = cacheKey != null ? cache.get(tool.name, cacheKey) : null

  try {
    let result: ToolResult
    let cacheHit = false
    if (cachedResult) {
      result = cachedResult
      cacheHit = true
    } else {
    const resultOrGenerator = tool.execute(call.input, context)

    if (isAsyncGenerator(resultOrGenerator)) {
      // No wall-clock timeout is applied to the generator drain BY DESIGN:
      // its only users (shell, credential) already bound themselves — shell
      // owns a SIGTERM→SIGKILL timeout incl. per-call `timeout` overrides, and
      // credential is HITL-bounded. A framework timeout here would silently
      // override shell's per-call timeout. A *custom* generator tool that
      // neither self-protects nor honors context.signal could hang the turn —
      // a known limitation, deliberately not patched with a blanket timer.
      //
      // Streaming tool — yield progress events. A progress with
      // `credentialRequest` set triggers the HITL credential flow: we emit
      // a credential.request event, await the session's requestCredential
      // callback, emit credential.response, and resume the generator via
      // `.next(handle)` so the tool receives the CredentialHandle (or
      // null on deny) as the value of its `yield` expression.
      let iterResult = await resultOrGenerator.next()
      while (!iterResult.done) {
        const progress = iterResult.value

        if (progress.credentialRequest !== undefined) {
          const credRequest = progress.credentialRequest
          const requestId = crypto.randomUUID()

          yield {
            type: 'credential.request',
            requestId,
            label: credRequest.label,
            hint: credRequest.hint,
            usage: credRequest.usage,
            placement: credRequest.placement,
            isRequired: credRequest.isRequired,
            turnIndex,
          }

          // Block on HITL. A thrown callback (vault I/O failure, thread
          // deleted mid-flight) must NOT tear the loop down — treat it
          // as a deny. The tool receives null and returns a denied result
          // the model can reason about.
          let handle: CredentialHandle | null
          try {
            handle = await credentials.requestCredential({ ...credRequest, requestId })
          } catch {
            handle = null
          }

          yield {
            type: 'credential.response',
            requestId,
            credentialId: handle?.credentialId ?? null,
            label: handle?.label ?? credRequest.label,
            denied: handle === null,
            turnIndex,
          }

          // TNext on ToolProgress generators is `unknown` — the tool
          // casts back to `CredentialHandle | null` at the yield site.
          iterResult = await resultOrGenerator.next(handle as unknown as undefined)
        } else {
          yield {
            type: 'tool.call.progress',
            toolCallId: call.id,
            progress: progress.message,
            turnIndex,
          }
          iterResult = await resultOrGenerator.next()
        }
      }
      result = iterResult.value
    } else if (tool.disableTimeout === true) {
      // Tools that opt out of the wall-clock timeout — agent_spawn and
      // orchestrate, whose sub-agent delegations legitimately run far longer
      // than the 120s default. `disableTimeout` was previously ignored on this
      // Promise path, so a long delegation was killed at the default timeout
      // and the child loop was orphaned (kept spending). They are bounded
      // instead by the session abort signal, which now cascades to sub-agents
      // (R2) — so "stop" still stops them.
      result = await resultOrGenerator
    } else {
      const timeout = timeoutPromise(timeoutMs, call.name, call.id)
      try {
        result = await Promise.race([
          resultOrGenerator,
          timeout.promise,
        ])
      } finally {
        timeout.cancel()
      }
    }

      // Populate cache with the RAW result (pre-truncation). Truncation
      // is a downstream presentation concern; the cached value should
      // remain whatever the tool actually computed so future hits can
      // re-truncate at whatever cap is in force at that moment.
      if (cacheKey != null) cache.set(tool.name, cacheKey, result)
    }

    // Cap result size — UTF-8 byte budget, head+tail preservation so error
    // tails (stack traces, exit codes) survive truncation. When a spill dir
    // is configured, the FULL pre-truncation output is persisted there first
    // and the marker cites the path, so the model can readFile/grep the
    // omitted middle — truncation becomes recoverable instead of silently
    // destroying the dropped bytes. Spilling is best-effort: a write failure
    // (or no spillDir) degrades to in-context-only truncation.
    const maxSize = tool.maxResultSize ?? config.toolExecution.maxResultSize
    const originalBytes = Buffer.byteLength(result.content, 'utf8')
    if (originalBytes > maxSize) {
      const spillPath = await spillToolResult(
        config.toolExecution.spillDir,
        config.sessionId,
        call.id,
        result.content,
      )
      result = {
        ...result,
        content: headTailTruncate(result.content, maxSize) + spillMarker(spillPath),
        metadata: {
          ...result.metadata,
          truncated: true,
          originalSize: originalBytes,
          ...(spillPath ? { spillPath } : {}),
        },
      }
    }

    const durationMs = Date.now() - startTime
    const outputBytesToModel = Buffer.byteLength(result.content, 'utf8')
    yield {
      type: 'tool.call.end',
      toolCallId: call.id,
      toolName: call.name,
      result: result.content,
      isError: result.isError,
      durationMs,
      turnIndex,
      metadata: result.metadata,
      cacheHit,
      outputBytesRaw: originalBytes,
      outputBytesToModel,
      truncated: originalBytes > outputBytesToModel,
    }

    // tool.post hooks fire only when the tool actually executed (not on
    // hook-block / permission-deny / unknown-tool paths). Observational:
    // a tool.post block does NOT retroactively undo the result — the
    // hook's reminder simply lands on the next turn alongside the tool
    // result. Post-hooks never roll back, same as the standard hook
    // convention (a git post-commit hook cannot abort the commit).
    if (hooks?.has('tool.post')) {
      await hooks.run(
        {
          event: 'tool.post',
          turnIndex,
          toolName: call.name,
          toolInput: call.input,
          result: result.content,
          isError: result.isError === true,
        },
        config.abortSignal ?? undefined,
      )
    }

    return { toolCall, result }
  } catch (error) {
    const durationMs = Date.now() - startTime
    const errorMessage = error instanceof Error ? error.message : String(error)

    yield {
      type: 'tool.call.end',
      toolCallId: call.id,
      toolName: call.name,
      result: `Error: ${errorMessage}`,
      isError: true,
      durationMs,
      turnIndex,
    }

    return { toolCall, result: { content: `Error: ${errorMessage}`, isError: true } }
  }
}

/**
 * Wrapper that adapts the generator-based executeSingleToolGen to the
 * old { events, result } return shape expected by executeTools.
 * Events are yielded immediately instead of batched.
 */
async function executeSingleTool(
  call: ToolUseBlock,
  tool: Tool,
  config: LoomConfig,
  turnIndex: number,
  checkPermission: (tool: ToolCall) => Promise<'allow' | 'ask' | CheckPermissionResult>,
  requestApproval: (tool: ToolCall) => Promise<boolean>,
  credentials: ResolvedCredentialCallbacks,
  credentialResolver: CredentialResolver | undefined,
  cache: ToolResultCache,
  hooks: HookRuntime | undefined,
  reminders: ReminderInjector | undefined,
): Promise<{ events: LoomEvent[]; result: { toolCall: ToolCall; result: ToolResult } }> {
  // This wrapper exists for backwards compatibility with parallel execution.
  // Events are collected into an array. For permission/credential events
  // to stream immediately (HITL), use executeSingleToolGen directly —
  // which is why `request_credential` is declared `isReadOnly: false`.
  const events: LoomEvent[] = []
  const gen = executeSingleToolGen(call, tool, config, turnIndex, checkPermission, requestApproval, credentials, credentialResolver, cache, hooks, reminders)
  let iterResult = await gen.next()
  while (!iterResult.done) {
    events.push(iterResult.value)
    iterResult = await gen.next()
  }
  return { events, result: iterResult.value }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function finalize(state: LoopState, reason: StopReason, model: string, sessionId: string): {
  result: LoopResult
  endEvent: SessionEndEvent
} {
  const turnCount = state.turnIndex + 1
  // Pull the cumulative-fallback bit out so it lives behind the optional
  // `isFallbackPricing` field on `TurnUsage` — emitted only when true so
  // the common case keeps the pre-#24 wire shape exactly.
  const { isFallbackPricing, ...counters } = state.totalUsage
  const totalUsage: TurnUsage = {
    ...counters,
    model,
    ...(isFallbackPricing ? { isFallbackPricing: true } : {}),
  }
  return {
    result: {
      reason,
      messages: state.messages,
      totalUsage,
      turnCount,
      lastUsage: state.lastUsage,
    },
    endEvent: {
      type: 'session.end',
      sessionId,
      reason,
      totalUsage,
      turnCount,
      timestamp: Date.now(),
    },
  }
}

/**
 * Terminal yield shared by every loop exit path: run the `session.end`
 * hooks, then yield the session.end event and return the result.
 *
 * Informational by contract — the session is already over, so a hook's
 * `continue: false` is ignored (post-hooks cannot abort, same as the
 * standard hook convention). Runs on normal ends, aborts, limits, and
 * errors alike, so a completion webhook / audit hook never misses a
 * terminal state.
 *
 * Deliberately runs WITHOUT the abort signal: an aborted run still owes
 * its end-of-life hooks (an audit trail that skips aborted runs is not
 * an audit trail). Hooks stay bounded by their own per-spec timeouts.
 */
async function* endSession(
  end: { result: LoopResult; endEvent: SessionEndEvent },
  hooks: HookRuntime | undefined,
): AsyncGenerator<LoomEvent, LoopResult> {
  if (hooks?.has('session.end')) {
    await hooks.run({
      event: 'session.end',
      turnIndex: Math.max(0, end.result.turnCount - 1),
      sessionId: end.endEvent.sessionId,
      reason: end.endEvent.reason,
    })
  }
  yield end.endEvent
  return end.result
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function timeoutPromise(ms: number, toolName: string, toolCallId: string): { promise: Promise<never>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout>
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ToolError(
      `Tool "${toolName}" timed out after ${ms}ms`,
      toolName,
      toolCallId,
    )), ms)
  })
  return { promise, cancel: () => clearTimeout(timer!) }
}

function isAsyncGenerator(value: unknown): value is AsyncGenerator {
  return value !== null &&
    typeof value === 'object' &&
    Symbol.asyncIterator in (value as object)
}

async function* parallelExecute<T>(
  promises: Promise<T>[],
): AsyncGenerator<T> {
  const results = await Promise.all(promises)
  for (const result of results) {
    yield result
  }
}

/**
 * Compute cost using the provider's pricing table. Falls back to
 * a conservative Sonnet-tier estimate if the model isn't recognized,
 * returning a flag so the emit point can mark `TurnUsage.isFallbackPricing`
 * and the status bar can render `≈ $X.XXXX` instead of `$X.XXXX`.
 *
 * Delegates to `computeCostWithFallback` (which both classifies AND fires
 * the one-time `console.warn` for new uncatalogued models) — kept as a
 * thin wrapper so the loop only depends on one pricing entry point.
 */
function computeCost(
  provider: ProviderAdapter,
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheCreationTokens = 0,
): { costUsd: number; isFallback: boolean } {
  return computeCostWithFallback(
    provider.name,
    model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
  )
}

// ---------------------------------------------------------------------------
// Message prefix caching
// ---------------------------------------------------------------------------

/**
 * Anthropic's server-side cap on `cache_control` markers per request. Shared
 * across system blocks, tool defs, and conversation messages. Re-exported
 * from `system-prompt.ts` so the two modules cannot drift apart.
 */
export const CACHE_CONTROL_BLOCK_LIMIT = CACHE_CONTROL_MARKER_LIMIT

/**
 * Translate a `SystemPrompt` into the wire-level `ProviderRequest['system']`
 * shape.
 *
 * Rules:
 *   - Empty prompt → empty string (omits the `system` field semantically).
 *   - Single string → one text block, cache-marked. Preserves the pre-split
 *     behaviour for any caller that hasn't migrated to the block form.
 *   - Array of blocks → one text block per entry; `cache_control` emitted
 *     only on blocks with `cacheControl: true`, honouring `markerBudget`.
 *
 * When the number of cacheable blocks exceeds `markerBudget`, the FIRST
 * `markerBudget` are kept marked and the rest become plain text. The prefix
 * is the most valuable cache entry — it's what a subsequent request reads
 * as a longest-match — so losing a trailing marker is cheaper than losing
 * the prefix marker.
 *
 * `cacheProfile` chooses the TTL tier for every marker this function
 * emits. Omitted → default 5-minute tier; `{ ttl: '1h' }` → extended
 * 1-hour tier. The loop threads the session's profile through on every
 * call so a per-turn override would be possible, but the default path is
 * set-once-at-session-start.
 */
export function buildSystemRequestBlocks(
  sp: SystemPrompt,
  markerBudget: number,
  cacheProfile?: CacheProfile | null,
): ProviderRequest['system'] {
  if (markerBudget < 0) throw new Error(`markerBudget must be >= 0, got ${markerBudget}`)
  const normalized = normalizeSystemPrompt(sp)
  if (normalized.length === 0) {
    // An empty `system` string matches the pre-split behaviour when no
    // system prompt was configured; the Anthropic adapter treats empty
    // strings as "omit system from the request body" (see anthropic.ts).
    return ''
  }

  const marker = buildCacheMarker(cacheProfile)
  const out: Array<{ type: 'text'; text: string; cache_control?: typeof marker }> = []
  let markersUsed = 0
  for (const block of normalized) {
    const wantsMarker = block.cacheControl === true
    const canMark = markersUsed < markerBudget
    if (wantsMarker && canMark) {
      out.push({ type: 'text', text: block.text, cache_control: marker })
      markersUsed++
    } else {
      // Either the block is volatile (no marker wanted) or we ran out of
      // budget. Either way it goes on the wire as plain text.
      out.push({ type: 'text', text: block.text })
    }
  }
  return out
}

/**
 * Count the cache_control markers actually attached to an outgoing system
 * block array. Used to feed the remaining marker budget into the message
 * marker placer so the two never collide with the API's total cap.
 */
export function countSystemBlockMarkers(
  system: ProviderRequest['system'],
): number {
  if (typeof system === 'string') return 0
  let n = 0
  for (const block of system) {
    if (block.cache_control !== undefined) n++
  }
  return n
}

/**
 * Scan a message history and return the unique names of every skill
 * the model invoked via the builtin `skill` tool, in first-seen order.
 *
 * Used by the loop to populate the `activeSkills` field on
 * `compaction.end` and to fire the `skills.previously-invoked` reminder
 * — once compaction summarizes the original `skill` tool_results, the
 * model has no other way to know which workflows were active.
 *
 * Empty array when no skill calls are present (the common case).
 */
export function extractActiveSkillNames(messages: readonly Message[]): readonly string[] {
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    if (!Array.isArray(msg.content)) continue
    for (const block of msg.content) {
      if (block.type !== 'tool_use' || block.name !== 'skill') continue
      const input = block.input as { name?: unknown }
      const name = typeof input.name === 'string' ? input.name : null
      if (!name || seen.has(name)) continue
      seen.add(name)
      ordered.push(name)
    }
  }
  return ordered
}

/**
 * Append `<system-reminder>` text fragments to the last user-side message
 * as a fresh `text` content block. Returns a new messages array; the
 * original is not mutated.
 *
 * Reminders are attached as the FINAL block of the user message so:
 *   - the cache marker (applied later) anchors the volatile reminder tail,
 *     not the user's content. This keeps the user-content prefix
 *     cacheable across turns even though reminders themselves change.
 *   - they read in the natural place where models look for "harness
 *     context appended to my message" — a shape models are well
 *     accustomed to.
 *
 * If there is no user message in the array (rare — `Session.submitMessage`
 * always appends one before calling the loop), reminders are skipped and
 * the messages are returned unchanged. The injector queue keeps the
 * events; the next turn picks them up.
 */
export function attachRemindersToMessages(
  messages: Message[],
  fragments: readonly string[],
): Message[] {
  if (fragments.length === 0) return messages

  let lastUserIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user') {
      lastUserIdx = i
      break
    }
  }
  if (lastUserIdx === -1) return messages

  const reminderText = fragments.join('\n\n')
  const reminderBlock: ContentBlock = { type: 'text', text: reminderText }

  return messages.map((msg, idx) => {
    if (idx !== lastUserIdx) return msg
    if (msg.role !== 'user') return msg

    if (typeof msg.content === 'string') {
      return {
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: msg.content },
          reminderBlock,
        ],
      }
    }
    return {
      role: 'user' as const,
      content: [...msg.content, reminderBlock],
    }
  })
}

/**
 * Place a single `cache_control: { type: 'ephemeral' }` marker on the last
 * content block of the last message.
 *
 * # Why one marker is enough
 *
 * Anthropic's prompt cache performs automatic longest-prefix matching on every
 * request. A `cache_control` marker is a *write* point: it tells the server
 * "snapshot the KV cache up to and including this block." Reads happen
 * automatically — the server walks the new request, finds the longest stored
 * prefix, and skips prefill for those tokens.
 *
 * On turn N we mark the tail. On turn N+1 the request begins with the same
 * messages, so the server hits the prefix we wrote on turn N and only
 * prefills the new user turn (and the assistant turn we just appended). One
 * checkpoint per turn keeps the entire growing conversation cached.
 *
 * # Why we do NOT mark older messages
 *
 * The previous implementation marked every message except the last (N-1
 * markers). That broke once the conversation grew past 4 messages: combined
 * with the system marker, total markers exceeded `CACHE_CONTROL_BLOCK_LIMIT`
 * and the API rejected the request with 400.
 *
 * Marking older messages also adds zero read benefit. Each turn's tail marker
 * already writes a fresh checkpoint that supersedes any older marker as the
 * longest cached prefix on the next request. Older markers only cost the
 * 1.25× cache-write premium without buying any future hit.
 *
 * # Defense-in-depth cap
 *
 * `reservedMarkers` is the number of `cache_control` blocks added outside
 * this message list (today: 1 for the system block when `systemPrompt` is
 * non-empty, 0 for tools). If reserving plus our one message marker would
 * exceed `CACHE_CONTROL_BLOCK_LIMIT`, we skip marking messages entirely.
 * That cannot trigger today (1 + 1 = 2), but it guarantees this class of
 * regression cannot escape if a future change adds more markers elsewhere.
 *
 * Non-Anthropic providers ignore `cache_control` markers, so this is safe to
 * apply unconditionally.
 */
export function applyMessageCacheMarkers(
  messages: Message[],
  reservedMarkers: number,
  cacheProfile?: CacheProfile | null,
): Message[] {
  if (messages.length === 0) return messages
  if (reservedMarkers >= CACHE_CONTROL_BLOCK_LIMIT) return messages

  const marker = buildCacheMarker(cacheProfile)
  const lastIndex = messages.length - 1
  return messages.map((msg, idx) =>
    idx === lastIndex ? markLastBlock(msg, marker) : msg,
  )
}

function markLastBlock(msg: Message, marker: ReturnType<typeof buildCacheMarker>): Message {
  if (typeof msg.content === 'string') {
    return {
      ...msg,
      content: [{
        type: 'text' as const,
        text: msg.content,
        cache_control: marker,
      }],
    } as Message
  }

  if (Array.isArray(msg.content) && msg.content.length > 0) {
    const blocks = [...msg.content]
    const lastBlock = blocks[blocks.length - 1]!
    blocks[blocks.length - 1] = {
      ...lastBlock,
      cache_control: marker,
    }
    return { ...msg, content: blocks } as Message
  }

  return msg
}
