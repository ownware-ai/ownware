/**
 * Loom Session
 *
 * Holds all mutable state for a single agent conversation.
 * This is what gets checkpointed and restored.
 *
 * Wraps the agent loop with session lifecycle management
 * (multi-turn, usage tracking, persistence).
 */

import type { LoomConfig } from './config.js'
import type { SystemPrompt } from './system-prompt.js'
import type { LoomEvent, TurnUsage } from './events.js'
import type { CredentialCallbacks, LoopResult } from './loop.js'
import type { CredentialResolver } from '../credentials/resolver.js'
import type { Message, ContentBlock } from '../messages/types.js'
import type { ReminderInjector } from '../reminders/index.js'
import type { HookRuntime } from '../hooks/index.js'
import type { ContextUsage } from '../context/index.js'
import { measureContextUsage } from '../context/index.js'
import type { CostBreakdown, SessionMetrics } from '../metrics/index.js'
import { computeCostBreakdown } from '../metrics/index.js'
import type { Tool, ToolCall } from '../tools/types.js'
import type { ToolResultCache } from '../tools/result-cache.js'
import type { PermissionMode } from '../permissions/types.js'
import type { ProviderAdapter, ProviderRequest, ProviderUsage } from '../provider/types.js'
import type { CompactionManager } from '../compaction/manager.js'
import { createCompactionManager } from '../compaction/manager.js'
import type { CheckpointStore } from '../checkpoint/types.js'
import type { CheckPermissionResult, PolicyDecision } from '../permissions/types.js'
import { SessionPermissionStore } from '../permissions/session-store.js'
import { loop } from './loop.js'
import { systemPromptToText } from './system-prompt.js'
import { createDefaultConfig, mergeConfig } from './config.js'
import { resolveProvider } from '../provider/registry.js'
import { calculateCost, estimateCostFallback, warnIfFallbackPricing } from '../provider/pricing.js'
import {
  getEffectiveContextUsage,
  getModelContextWindow,
  type UsageBaseline,
} from '../messages/tokens.js'

// ---------------------------------------------------------------------------
// Permission callback types (injectable by consumers like Cortex gateway)
// ---------------------------------------------------------------------------

/**
 * Custom permission checker. Called before every tool execution that has
 * `requiresPermission: true`. Return 'allow' or 'ask'.
 *
 * When provided to Session, overrides the default check (which returns 'ask').
 */
/**
 * Host-supplied permission gate. Returns either the bare verdict
 * (back-compat) or a rich `CheckPermissionResult` carrying
 * classification metadata. The loop normalizes both shapes and
 * attaches the metadata to the `permission.request` event so the UI
 * can render a severity badge + reason copy (S5 / 2026-05-14
 * permission redesign).
 */
export type CheckPermissionFn = (tool: ToolCall) => Promise<PolicyDecision | CheckPermissionResult>

/**
 * Custom approval handler. Called when checkPermission returns 'ask'.
 * Return true to approve, false to deny.
 *
 * When provided to Session, overrides the default handler (which returns false).
 * This is where consumers wire HumanInTheLoop, zone UI prompts, etc.
 */
export type RequestApprovalFn = (tool: ToolCall) => Promise<boolean>

// ---------------------------------------------------------------------------
// Side-call (one-shot meta-task helper)
// ---------------------------------------------------------------------------

/**
 * Options for `Session.querySide` — a one-shot LLM call that does NOT
 * touch the main loop or the session's message history.
 *
 * Use this for cheap meta-tasks that need a quick model answer but
 * have nothing to do with the conversation in flight: thread title
 * generation, permission classification, summarising a single tool
 * result before injecting it, parsing a shell command, etc.
 *
 * Why a separate method instead of "just submit a message":
 *   - The main loop runs tools, manages permissions, drives compaction,
 *     emits a stream of events. None of that is wanted (or correct) for
 *     a "summarise this in 5 words" call.
 *   - The model used for the meta-task is usually different from the
 *     session's main model — typically a small/fast tier (e.g. Haiku)
 *     that costs an order of magnitude less. `querySide` resolves a
 *     fresh provider per call from the supplied model string, so a
 *     Sonnet session can ask Haiku for a title without rewiring.
 *   - The conversation must NOT be polluted. The user's chat history
 *     should not contain "what is the title of this thread?".
 */
export interface QuerySideOptions {
  /**
   * Model identifier (`provider:model`, e.g. `"anthropic:claude-haiku-4-5"`).
   * A fresh provider is resolved per call; pick whichever model fits
   * the meta-task best regardless of the session's main model.
   */
  readonly model: string
  /** Single user prompt. Plain text only — no tool blocks, no images. */
  readonly prompt: string
  /** Optional system prompt. Steers tone/format for the side task. */
  readonly systemPrompt?: string
  /**
   * Output token cap. Default 256 — meta-tasks are by definition tiny;
   * a larger cap usually points to using the main loop instead.
   */
  readonly maxTokens?: number
  /** Temperature override. Null (default) → provider default. */
  readonly temperature?: number | null
  /**
   * Optional abort signal. Independent of the session's main abort
   * controller — aborting the side call must not cancel the main turn
   * in flight.
   */
  readonly signal?: AbortSignal
}

/** Result of a `Session.querySide` call. */
export interface QuerySideResult {
  /** Concatenated text the model produced. */
  readonly text: string
  /** Token + cost accounting for this single call. */
  readonly usage: TurnUsage
}

// ---------------------------------------------------------------------------
// Session state (serializable for checkpointing)
// ---------------------------------------------------------------------------

export interface SessionState {
  readonly sessionId: string
  readonly messages: Message[]
  readonly turnCount: number
  readonly totalUsage: TurnUsage
  readonly createdAt: number
  readonly updatedAt: number
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export class Session {
  readonly sessionId: string
  private messages: Message[]
  private turnCount: number
  private totalUsage: MutableUsage
  /**
   * Snapshot of the LAST loop run's lastUsage report. Used by
   * `scheduleProactiveCompaction` to compute current context size
   * cheaply via `getEffectiveContextUsage` — exact baseline from the
   * most-recent provider response + delta estimate for any messages
   * appended after the loop returned. Refreshed on every
   * `submitMessage` / `querySide` completion.
   *
   * `null` until the first loop run that produced a successful provider
   * call. While `null`, proactive compaction falls back to the
   * heuristic chars÷4 walk inside `getEffectiveContextUsage` — safe
   * because the conversation is small at that point.
   */
  private lastUsage: UsageBaseline | null = null
  private abortController: AbortController
  private config: LoomConfig
  private provider: ProviderAdapter
  private tools: Tool[]
  private compaction: CompactionManager | null
  private checkpoint: CheckpointStore | null
  private createdAt: number
  private permissionStore?: SessionPermissionStore
  private customCheckPermission?: CheckPermissionFn
  private customRequestApproval?: RequestApprovalFn
  private credentialCallbacks?: CredentialCallbacks
  /**
   * Unified credential resolver (board: credentials-unification — C20).
   * When set, the loop forwards it onto every `ToolContext` so tools
   * can resolve credentials by canonical variable name. Coexists with
   * the legacy `credentialCallbacks` during the cutover.
   */
  private credentialResolver?: CredentialResolver
  /** Optional override for the loop's tool result cache. When undefined,
   *  each loop run constructs its own default ToolResultCache. */
  private toolResultCacheOverride?: ToolResultCache
  /** Default policy for tool calls when no `checkPermission` callback is
   *  supplied. Defaults to 'ask' (the historical behavior). */
  private permissionMode: PermissionMode
  /**
   * Optional reminder injector. When set, the loop drains queued
   * reminder events on every provider call and attaches the rendered
   * `<system-reminder>` tags to the last user-side message in the
   * request payload. The session's stored message history is not
   * mutated. Default: undefined (no reminders).
   */
  private reminders?: ReminderInjector
  /**
   * Optional persistent reminder text injected as `<system-reminder>`
   * on every turn. See constructor option doc.
   */
  private persistentReminder?: string
  /**
   * Optional hook runtime. When set, the loop runs hooks at lifecycle
   * points (session.start, tool.pre, tool.post). A tool.pre block
   * synthesizes a denied tool_result; tool.post is observational.
   */
  private hooks?: HookRuntime

  // ---------------------------------------------------------------------------
  // Proactive (async) compaction scheduling — background-compaction pattern
  // ---------------------------------------------------------------------------
  //
  // After every `submitMessage` finishes, if context pressure is approaching
  // the trigger threshold, compaction is scheduled in the background. Most
  // sessions never see a perceived pause for compaction because the work
  // happens while the user is reading the previous assistant response.
  //
  // The next `submitMessage` awaits this promise (if any) before running, so:
  //   - Fast-typing user → brief sync wait, but compaction is already in
  //     progress, so the wait is shorter than today's full sync compaction.
  //   - Normal-paced user → wait completes during read time, zero pause.
  //
  // The loop's sync `compactIfNeeded` stays as a SAFETY NET for two cases:
  //   - Mid-`submitMessage` tool-chain iterations (the agent calls tools in
  //     a row without yielding back to the user — no reading gap exists).
  //   - Proactive compaction failed or was cancelled.
  //
  // Defaults: trigger proactive compaction at a fraction slightly lower than
  // the configured sync trigger so it fires FIRST during read-time. See
  // `proactiveTriggerFraction()`.
  //
  // Cancellation: `abort()` aborts any in-flight compaction (just discards
  // the result; the API call still completes and incurs cost). Acceptable
  // trade-off vs. plumbing an AbortSignal through every strategy.

  /** Promise of an in-flight proactive compaction. Null when idle. */
  private inFlightCompaction: Promise<void> | null = null

  /** Flag set when an in-flight compaction has been cancelled. The promise
   *  still completes (we can't abort the LLM call cheaply), but its result
   *  is discarded. Reset each time a new compaction is scheduled. */
  private compactionCancelled = false

  /**
   * Captured pre/post/strategy metadata from the most recent SUCCESSFUL
   * proactive compaction whose result was applied to `this.messages`.
   * Read once by `drainInFlightCompaction` to synthesize the
   * `compaction.start` / `compaction.end` pair that surfaces the
   * background work to the next user turn (Option B — chunk #24).
   *
   * Reset to `null` whenever:
   *   - the proactive run produced no result (manager returned null),
   *   - the run was cancelled mid-flight by `abort()`,
   *   - the run failed and the catch branch ran,
   *   - the drain has already consumed it (so a subsequent drain that
   *     races a brand-new proactive run cannot emit stale numbers).
   *
   * Storing it on the session — not on the compaction promise — keeps
   * the drain a pure transformation over session state: no closures,
   * no leaks if the promise itself is GC'd before drain runs.
   */
  private lastProactiveResult: {
    readonly strategy: string
    readonly preTokenCount: number
    readonly postTokenCount: number
  } | null = null

  constructor(opts: {
    config: LoomConfig
    provider: ProviderAdapter
    tools: Tool[]
    /**
     * Compaction manager for this session.
     *
     *  - `undefined` (default) → Session auto-constructs a manager from
     *    `config.compaction` and the supplied `provider`. This is the
     *    usual path: every profile's `compaction` block is honoured
     *    automatically without the caller having to wire it.
     *  - `null` → compaction is EXPLICITLY disabled for this session,
     *    regardless of what `config.compaction` says. Use this in
     *    tests or in short-lived one-shot sessions where the overhead
     *    of the pressure check is unwanted.
     *  - A `CompactionManager` instance → use it verbatim. Use this
     *    when you need to share a manager across multiple sessions or
     *    inject a test double.
     *
     * The `undefined` → auto-construct path was added after discovery
     * that many consumers (including the production gateway) forgot to
     * wire the manager, so the carefully-configured `compaction` block
     * on every profile was a no-op at runtime. If you actually want
     * that behaviour, pass `null` explicitly — it's now a conscious
     * opt-out instead of an accidental omission.
     */
    compaction?: CompactionManager | null
    checkpoint?: CheckpointStore | null
    initialMessages?: Message[]
    permissionStore?: SessionPermissionStore
    /**
     * Custom permission checker. Overrides the default (which checks
     * permissionStore then returns 'ask'). Use this to wire zone security.
     */
    checkPermission?: CheckPermissionFn
    /**
     * Custom approval handler. Overrides the default (which returns false).
     * Use this to wire HumanInTheLoop or zone-aware approval UI.
     */
    requestApproval?: RequestApprovalFn
    /**
     * Credential callbacks — passed through to the loop on every
     * submitMessage. Consumers (Cortex) wire these to their vault + HITL
     * so the `request_credential` tool and shell env-injection work.
     * When omitted, the loop installs no-op defaults: requests deny,
     * resolves return null, lists are empty.
     */
    credentials?: CredentialCallbacks
    /**
     * Unified credential resolver (board: credentials-unification —
     * C20). When set, the loop forwards it onto every `ToolContext`
     * so tools can resolve credentials by canonical variable name
     * via the gateway. Coexists with the legacy `credentials`
     * callbacks during the cutover.
     */
    credentialResolver?: CredentialResolver
    /**
     * Optional override for the per-loop tool result cache. Pass an
     * instance to share a cache across loop runs in the session, or
     * `new ToolResultCache({ maxEntries: 0 })` to effectively disable
     * caching for this session (the cache stores then immediately
     * evicts every entry, so every call is a miss). When omitted, each
     * loop run constructs a fresh default cache scoped to that turn.
     */
    toolResultCache?: ToolResultCache
    /**
     * Default policy for tool calls when no `checkPermission` callback
     * is supplied. Determines the fallback decision returned by the
     * built-in checkPermission/requestApproval pair:
     *   - 'auto'      → permission requests are auto-allowed
     *   - 'ask'       → permission requests fall through to HITL (default)
     *   - 'deny'      → **deprecated** — coerced to 'ask' after the
     *                   2026-05-14 redesign. No policy-level deny exists.
     *   - 'allowlist' → fall through to HITL for anything not on the
     *                   allowlist (use a custom checkPermission to
     *                   auto-allow specific tools)
     *
     * If `checkPermission` is also provided, the explicit callback wins
     * — `permissionMode` only governs the default. Default: 'ask' for
     * backwards compatibility.
     */
    permissionMode?: PermissionMode
    /**
     * Optional reminder injector. When set, the loop drains queued
     * reminder events on every provider call and attaches the rendered
     * `<system-reminder>` tags to the last user-side message in the
     * request payload. Runtime sources (mode transitions, hooks,
     * compaction, permissions, …) call `injector.emit(event)` between
     * turns; the next request carries the rendered tags.
     */
    reminders?: ReminderInjector
    /**
     * Optional hook runtime. When set, the loop runs hooks at
     * lifecycle points (session.start, tool.pre, tool.post). When
     * paired with a reminder injector, hook outcomes (success / blocked
     * / additional context) flow back to the model as
     * `<system-reminder>` tags on the next turn.
     */
    hooks?: HookRuntime
    /**
     * Optional persistent reminder text. When set, the loop wraps it
     * in `<system-reminder>...</system-reminder>` and attaches it to
     * every outgoing user-side message — every turn — in addition to
     * any event-driven reminders from `reminders`. The string is
     * applied verbatim; Loom carries no content of its own. A profile
     * pins this when it needs a hard guarantee on every turn (e.g. a
     * verifier subagent pinning "must end with VERDICT: …"). When
     * omitted or empty, the loop's behaviour is unchanged.
     */
    persistentReminder?: string
  }) {
    this.config = opts.config
    this.provider = opts.provider
    this.tools = opts.tools
    this.toolResultCacheOverride = opts.toolResultCache
    this.permissionMode = opts.permissionMode ?? 'ask'
    // Three paths — see the constructor field doc on `compaction` for
    // why `undefined` vs `null` matter.
    if (opts.compaction === undefined) {
      this.compaction = createCompactionManager({
        config: opts.config.compaction,
        provider: opts.provider,
        contextWindowTokens: getModelContextWindow(opts.config.model),
      })
    } else {
      // Caller explicitly passed `null` (disable) or an instance.
      this.compaction = opts.compaction
    }
    this.checkpoint = opts.checkpoint ?? null
    this.permissionStore = opts.permissionStore
    this.customCheckPermission = opts.checkPermission
    this.customRequestApproval = opts.requestApproval
    this.credentialCallbacks = opts.credentials
    this.credentialResolver = opts.credentialResolver
    this.reminders = opts.reminders
    this.hooks = opts.hooks
    this.persistentReminder = opts.persistentReminder
    this.sessionId = opts.config.sessionId
    this.messages = opts.initialMessages ?? []
    this.turnCount = 0
    this.totalUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 }
    this.abortController = new AbortController()
    this.createdAt = Date.now()
  }

  /**
   * Submit a message and stream the agent's response.
   *
   * This is the main entry point for each user turn.
   * Returns an AsyncGenerator that yields LoomEvents.
   */
  async *submitMessage(
    prompt: string | ContentBlock[],
    overrides?: Partial<LoomConfig>,
  ): AsyncGenerator<LoomEvent, LoopResult> {
    // Drain any in-flight proactive compaction from the previous turn BEFORE
    // pushing the new user message. If async beat the user (common case),
    // this is a zero-event no-op. If the user was fast, the drain yields
    // `compaction.start` / `compaction.end` events through the same
    // generator so the UI client's reducer flips the inline shimmer for
    // the duration of the wait. Chunk #24, Option B — no new event types,
    // no new wire channel.
    yield* this.drainInFlightCompaction()

    // Add user message (string or multimodal content blocks)
    this.messages.push({ role: 'user', content: prompt })

    // Merge any per-turn overrides
    const turnConfig = overrides
      ? mergeConfig(this.config, {
          ...overrides,
          abortSignal: this.abortController.signal,
        })
      : { ...this.config, abortSignal: this.abortController.signal }

    // Run the loop
    const result = yield* loop({
      messages: this.messages,
      systemPrompt: turnConfig.systemPrompt,
      provider: this.provider,
      tools: this.tools,
      config: turnConfig,
      compaction: this.compaction,
      checkpoint: this.checkpoint,
      checkPermission: async (tool) => {
        // 'auto' is a true bypass — short-circuit BEFORE any custom
        // callback runs. The user explicitly opted into "no prompts,
        // I trust this run" by setting the mode; a host wiring a
        // zone manager or safety pipeline must not be able to
        // re-introduce friction here. Same semantics as a
        // "dangerously skip permissions" bypass flag.
        if (this.permissionMode === 'auto') {
          return 'allow'
        }

        // Host-provided checkPermission (cortex's zone manager wiring,
        // CLI custom hosts, …) takes precedence over the default.
        if (this.customCheckPermission) {
          return this.customCheckPermission(tool)
        }

        // Default builder: session-stored grants win, then mode default.
        if (this.permissionStore) {
          const storedDecision = this.permissionStore.check(tool.name)
          if (storedDecision) {
            return storedDecision
          }
        }
        // After the 2026-05-14 redesign, the policy layer never denies:
        // every non-'auto' mode (including the deprecated 'deny' value
        // preserved for back-compat) falls through to 'ask'. The user
        // is the only party that can decline a call.
        switch (this.permissionMode) {
          case 'deny': return 'ask'
          case 'allowlist': return 'ask'
          case 'ask':
          default: return 'ask'
        }
      },
      requestApproval: async (tool) => {
        // Same bypass invariant — if the host or default somehow
        // reaches requestApproval in 'auto' mode (shouldn't happen
        // since checkPermission returned 'allow', but defense in depth),
        // succeed without prompting.
        if (this.permissionMode === 'auto') {
          return true
        }

        if (this.customRequestApproval) {
          return this.customRequestApproval(tool)
        }

        // Default: session-stored "always allow" → true. Otherwise
        // false — but real deployments wire a HITL handler that asks
        // the user; this fallback is only reached when no UI is
        // attached at all.
        if (this.permissionStore) {
          const storedDecision = this.permissionStore.check(tool.name)
          if (storedDecision === 'allow') return true
        }
        return false
      },
      ...(this.credentialCallbacks ? { credentials: this.credentialCallbacks } : {}),
      ...(this.credentialResolver ? { credentialResolver: this.credentialResolver } : {}),
      ...(this.toolResultCacheOverride ? { toolResultCache: this.toolResultCacheOverride } : {}),
      ...(this.reminders ? { reminders: this.reminders } : {}),
      ...(this.hooks ? { hooks: this.hooks } : {}),
      ...(this.persistentReminder && this.persistentReminder.trim().length > 0
        ? { persistentReminder: this.persistentReminder }
        : {}),
    })

    // Update session state
    this.messages = result.messages
    this.turnCount += result.turnCount
    this.totalUsage.inputTokens += result.totalUsage.inputTokens
    this.totalUsage.outputTokens += result.totalUsage.outputTokens
    this.totalUsage.cacheReadTokens += result.totalUsage.cacheReadTokens
    this.totalUsage.cacheCreationTokens += result.totalUsage.cacheCreationTokens
    this.totalUsage.costUsd += result.totalUsage.costUsd

    // Refresh the exact baseline for the next pre-call context-size
    // check (used by `scheduleProactiveCompaction` below). Falls back
    // to the previous snapshot when the run didn't produce a usage —
    // never `null`-overwrite a valid baseline.
    if (result.lastUsage != null) {
      this.lastUsage = result.lastUsage
    }

    // Proactive (async) compaction — schedule if pressure is approaching the
    // trigger fraction. Fires in the background while the user reads the
    // response. Next `submitMessage` awaits it (see top of method).
    this.scheduleProactiveCompaction()

    return result
  }

  /**
   * Proactive trigger fraction. Always slightly lower than the configured
   * sync trigger so proactive fires FIRST during read-time, leaving the
   * sync check in the loop as a safety net.
   *
   * For non-fraction-based triggers (token count or message count), we fall
   * back to a sensible default of 0.65 — proactive doesn't need pixel-perfect
   * alignment with the sync trigger because the sync check is the safety net.
   */
  private proactiveTriggerFraction(): number {
    const trigger = this.config.compaction.trigger
    if (trigger.type === 'fraction') {
      // Fire proactive at 15 percentage points before sync. Floor at 0.30
      // — proactive at very low fractions wastes summarize calls on tiny
      // conversations.
      return Math.max(0.3, trigger.threshold - 0.15)
    }
    return 0.65
  }

  /**
   * If pressure is approaching the trigger threshold, schedule compaction
   * in the background. Safe to call multiple times — only the first
   * schedules; subsequent calls are no-ops while a compaction is in flight.
   */
  private scheduleProactiveCompaction(): void {
    if (this.compaction === null) return
    if (this.inFlightCompaction !== null) return

    // Use the unified context-size helper — exact baseline from the
    // most-recent provider response + chars÷4 delta estimate ONLY for
    // messages added since. Replaces a full chars÷4 walk of
    // `this.messages` every submit, which routinely overestimated by
    // ~30% on code-heavy content and over-fired proactive compaction.
    const usage = getEffectiveContextUsage(
      this.messages,
      this.lastUsage,
      this.config.model,
    )
    if (usage.fraction < this.proactiveTriggerFraction()) return

    this.compactionCancelled = false
    this.inFlightCompaction = this.runProactiveCompaction()
  }

  /**
   * Run compaction against a snapshot of the current messages. When it
   * resolves, apply the compacted history back to the session — unless
   * the user submitted a new turn mid-flight, in which case merge the
   * compacted history with any newer messages so we don't lose data.
   *
   * Failures are silent — the loop's sync `compactIfNeeded` will fire on
   * the next turn if pressure is still high. Cancellation discards the
   * result (the API call still completes and incurs cost — acceptable
   * trade-off vs. plumbing AbortSignal through every strategy).
   */
  private async runProactiveCompaction(): Promise<void> {
    const compaction = this.compaction
    if (compaction === null) {
      this.inFlightCompaction = null
      return
    }

    // Snapshot WHAT we're compacting. Concurrent mutations of
    // `this.messages` during the await won't disturb us — we apply the
    // result based on length comparison below.
    const snapshotLen = this.messages.length
    const snapshotMessages = this.messages.slice()
    const systemPromptText = systemPromptToText(this.config.systemPrompt)

    try {
      const result = await compaction.compactIfNeeded(snapshotMessages, systemPromptText)
      if (result === null) {
        this.lastProactiveResult = null
        return
      }

      // Cancelled mid-flight (user called abort()) → discard.
      if (this.compactionCancelled) {
        this.lastProactiveResult = null
        return
      }

      // If new messages arrived since we took the snapshot, splice them
      // onto the end of the compacted history so we don't lose the user's
      // new turn. The user's submitMessage is awaiting this promise, so
      // any newer messages are present in `this.messages` already.
      const newer = this.messages.slice(snapshotLen)
      this.messages = newer.length > 0
        ? [...result.messages, ...newer]
        : result.messages

      // Capture the metadata so the next drain (if the user beats the
      // promise to the next submitMessage) can synthesize a
      // compaction.start / compaction.end pair and flip the UI's
      // shimmer for the duration of the wait. Background compactions
      // that finish before the user submits set this then drain consumes
      // nothing (no wait → no shimmer) — see drainInFlightCompaction.
      this.lastProactiveResult = {
        strategy: result.strategy,
        preTokenCount: result.preTokenCount,
        postTokenCount: result.postTokenCount,
      }
    } catch {
      // Async compaction failure → fall through silently. The loop's sync
      // compactIfNeeded acts as the safety net on the next turn.
      this.lastProactiveResult = null
    } finally {
      this.inFlightCompaction = null
    }
  }

  /**
   * Drain any in-flight proactive compaction at the START of the next
   * `submitMessage`. Yields immediately when nothing is in flight (the
   * happy case — background work beat the user, no wait, no shimmer).
   *
   * When the user beats the background work, we DO wait — and during
   * that wait we synthesize `compaction.start` / `compaction.end`
   * events so the client's reducer flips `isCompacting=true` and renders
   * the inline shimmer. The events carry the REAL pre/post token
   * counts captured by `runProactiveCompaction` when it applied the
   * result, so the "Caught up · freed X%" toast shows accurate numbers.
   *
   * If the proactive run failed or was cancelled (no captured result),
   * the drain still waits silently — the loop's sync `compactIfNeeded`
   * safety net will fire on the same submitMessage and emit its own
   * pair from inside the loop. No events are synthesized here because
   * there's nothing to confirm to the user; emitting fake numbers
   * would mislead the "Caught up" toast.
   *
   * The events go through the existing `submitMessage` AsyncGenerator
   * — no new wire channel, no new event types. Chunk #24, Option B.
   */
  private async *drainInFlightCompaction(): AsyncGenerator<LoomEvent, void> {
    if (this.inFlightCompaction === null) return

    // Snapshot the result-metadata BEFORE awaiting. The proactive run
    // resets `lastProactiveResult` itself; reading it after the await
    // is fine, but stashing the promise here removes any ordering
    // ambiguity if a second proactive run somehow gets scheduled before
    // this generator resumes (it can't today — schedule is a no-op while
    // a run is in flight — but the snapshot keeps it true going forward).
    const inFlight = this.inFlightCompaction

    // Emit compaction.start eagerly. We don't yet know the final
    // pre/post numbers, but the client's reducer only needs the flip to
    // render the shimmer immediately; we'll surface real numbers on
    // compaction.end below.
    yield {
      type: 'compaction.start',
      // Marker on the strategy field so consumers that need to
      // distinguish a drain (background compaction surfaced to the
      // next turn) from a sync compaction (mid-loop, in turnIndex N)
      // can. A client's reducer treats both identically — both flip
      // isCompacting and emit the same SystemEventChatItem.
      strategy: 'proactive-drain',
      preTokenCount: 0,
      turnIndex: this.turnCount,
    }

    try {
      await inFlight
    } catch {
      // runProactiveCompaction swallows errors and resets state — this
      // catch is belt-and-braces in case the promise rejects unexpectedly.
    }

    // After the await, the proactive run has populated (or cleared)
    // `lastProactiveResult`. Consume + clear it so a future drain on the
    // same session can't re-emit stale numbers.
    const captured = this.lastProactiveResult
    this.lastProactiveResult = null

    const preTokenCount = captured?.preTokenCount ?? 0
    const postTokenCount = captured?.postTokenCount ?? 0
    const strategy = captured?.strategy ?? 'proactive-drain'
    const savedPercent = preTokenCount > 0
      ? Math.round(((preTokenCount - postTokenCount) / preTokenCount) * 100)
      : 0

    yield {
      type: 'compaction.end',
      strategy,
      preTokenCount,
      postTokenCount,
      savedPercent,
      turnIndex: this.turnCount,
    }
  }

  /** Abort the current turn */
  abort(reason: 'user' | 'timeout' | 'system' = 'user'): void {
    this.abortController.abort(reason)
    this.abortController = new AbortController()
    // Mark any in-flight proactive compaction as cancelled. The compaction
    // promise itself still completes (the API call cannot be cheaply
    // aborted), but its result will be discarded in runProactiveCompaction.
    if (this.inFlightCompaction !== null) {
      this.compactionCancelled = true
    }
  }

  /**
   * One-shot side call to a (potentially different) model.
   *
   * Bypasses the main agent loop entirely: no tools, no streaming
   * back to the consumer, no compaction trigger, no checkpoint, no
   * mutation of `this.messages`. Resolves a fresh provider per call
   * from `opts.model` so a Sonnet-driven session can ask Haiku for a
   * thread title without rewiring anything.
   *
   * Cost + token accounting roll up into the session's `totalUsage`
   * so the dashboard remains the single source of truth for the
   * thread's spend. The returned `usage` covers ONLY this call so
   * callers that want to record it as a separate ledger row can do
   * so without having to diff totals.
   *
   * Errors propagate straight to the caller — no retry, no fallback,
   * no recovery. Side calls are by design cheap and idempotent; if
   * the meta-task fails the caller can either skip the feature or
   * call again at its discretion.
   */
  async querySide(opts: QuerySideOptions): Promise<QuerySideResult> {
    const { provider } = resolveProvider(opts.model)
    // Strip provider prefix for the wire model id (mirrors the main loop).
    const bareModel = opts.model.includes(':')
      ? opts.model.slice(opts.model.indexOf(':') + 1)
      : opts.model

    const request: ProviderRequest = {
      model: bareModel,
      // Empty system prompt becomes a no-op on the wire (matches how the
      // main loop handles the same case).
      system: opts.systemPrompt ?? '',
      messages: [{ role: 'user', content: opts.prompt }],
      tools: [],
      maxTokens: opts.maxTokens ?? 256,
      temperature: opts.temperature ?? null,
      ...(opts.signal ? { signal: opts.signal } : {}),
    }

    let text = ''
    let providerUsage: ProviderUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    }

    for await (const chunk of provider.stream(request)) {
      if (chunk.type === 'text_delta') {
        text += chunk.text
      } else if (chunk.type === 'message_complete') {
        providerUsage = chunk.usage
        // The model COULD return tool_use blocks even though we sent
        // an empty tool list. We ignore them — the side-call surface
        // does not execute tools by design. The model's text response
        // (if any) is what the caller wanted.
      }
      // Other chunks (tool_use_*, thinking_delta) are intentionally
      // dropped: the side surface is text-only.
    }

    const cost = providerUsage.reportedCostUsd ?? computeSideCallCost(provider, bareModel, providerUsage)
    const usage: TurnUsage = {
      ...providerUsage,
      model: opts.model,
      costUsd: cost,
    }

    // Roll into session totals so the dashboard reflects every dollar.
    this.totalUsage.inputTokens += usage.inputTokens
    this.totalUsage.outputTokens += usage.outputTokens
    this.totalUsage.cacheReadTokens += usage.cacheReadTokens
    this.totalUsage.cacheCreationTokens += usage.cacheCreationTokens
    this.totalUsage.costUsd += usage.costUsd

    // Refresh the exact-baseline snapshot used by the proactive
    // compaction scheduler. A side query doesn't add to the main
    // message array (it's a one-off prompt), so the bookmark stays
    // at the current message count.
    this.lastUsage = {
      inputTokens: usage.inputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      outputTokens: usage.outputTokens,
      messageCountAtCapture: this.messages.length,
    }

    return { text, usage }
  }

  /**
   * Compute a typed breakdown of how the model's context window is being
   * spent right now — total used, free space, per-category split
   * (system prompt / tools / memory / skills / messages).
   *
   * Defaults to anchoring on the active provider's `countTokens` API
   * (free + exact for Anthropic and Google) when available, falling
   * back to the local chars/4 estimator on counter failure. Pass
   * `{ exact: false }` to skip the network call and use the estimator
   * unconditionally — useful for live UI updates that need to be
   * sub-millisecond and don't tolerate a per-render API hit.
   *
   * The result's `method` field reports `'mixed'` (counter anchored
   * system+messages+skills, tools estimate), `'exact'` (full counter),
   * or `'estimate'` (counter unavailable / failed / suppressed).
   */
  async getContextUsage(opts: { readonly exact?: boolean } = {}): Promise<ContextUsage> {
    const useCounter = opts.exact !== false
    const counter = useCounter
      ? {
          count: async (messages: Message[], system?: string) =>
            this.provider.countTokens(messages, system),
        }
      : undefined
    return measureContextUsage({
      model: this.config.model,
      systemPrompt: this.config.systemPrompt,
      messages: this.messages,
      tools: this.tools,
      ...(counter ? { counter } : {}),
    })
  }

  /**
   * Typed USD cost + tokens + cache breakdown for this session.
   *
   * Synchronous-by-nature (no I/O — pulls from the session's already-
   * accumulated state and the provider's pricing table) but typed as
   * `Promise` to mirror `getContextUsage` and `getMetrics` for a
   * consistent gateway / client call surface.
   *
   * Returns zeros (and `cache.savedUsd: null`) for a session that
   * hasn't completed a turn yet — never throws.
   */
  async getCostBreakdown(): Promise<CostBreakdown> {
    const bareModel = this.config.model.includes(':')
      ? this.config.model.slice(this.config.model.indexOf(':') + 1)
      : this.config.model
    const pricing = this.provider.getModelPricing(bareModel)
    return computeCostBreakdown({
      totalUsd: this.totalUsage.costUsd,
      turnCount: this.turnCount,
      inputTokens: this.totalUsage.inputTokens,
      outputTokens: this.totalUsage.outputTokens,
      cacheReadTokens: this.totalUsage.cacheReadTokens,
      cacheCreationTokens: this.totalUsage.cacheCreationTokens,
      pricing,
    })
  }

  /**
   * Unified session metrics — context utilization + USD cost + tokens
   * + cache stats in one typed snapshot. The single source of truth
   * the gateway exposes to UI clients (and the model's `/metrics` skill,
   * eventually) for "where is this session right now."
   *
   * Pass `{ exact: false }` to skip the provider's `countTokens` API
   * for the context portion — useful for live UI updates that need
   * sub-millisecond latency.
   */
  async getMetrics(opts: { readonly exact?: boolean } = {}): Promise<SessionMetrics> {
    const [context, cost] = await Promise.all([
      this.getContextUsage(opts),
      this.getCostBreakdown(),
    ])
    return {
      model: this.config.model,
      turnCount: this.turnCount,
      context,
      cost,
    }
  }

  /** Get current session state (for checkpointing) */
  getState(): SessionState {
    return {
      sessionId: this.sessionId,
      messages: [...this.messages],
      turnCount: this.turnCount,
      totalUsage: { ...this.totalUsage, model: this.config.model },
      createdAt: this.createdAt,
      updatedAt: Date.now(),
    }
  }

  /** Restore session from checkpoint */
  restore(state: SessionState): void {
    this.messages = [...state.messages]
    this.turnCount = state.turnCount
    if (state.totalUsage) {
      this.totalUsage.inputTokens = state.totalUsage.inputTokens
      this.totalUsage.outputTokens = state.totalUsage.outputTokens
      this.totalUsage.cacheReadTokens = state.totalUsage.cacheReadTokens
      this.totalUsage.cacheCreationTokens = state.totalUsage.cacheCreationTokens
      this.totalUsage.costUsd = state.totalUsage.costUsd ?? 0
    }
  }

  /** Get message count */
  get messageCount(): number {
    return this.messages.length
  }

  /** Get all messages (read-only copy) */
  getMessages(): readonly Message[] {
    return [...this.messages]
  }

  /**
   * Swap the model mid-session WITHOUT losing conversation history.
   *
   * The user picked a different model on the SAME thread. The host
   * resolves a fresh provider adapter for the new model and calls this;
   * `messages`, usage, turn count, tools, permissions, credentials and
   * every other companion are preserved — only the provider and the
   * model-derived config change. The next `submitMessage` runs the loop
   * against the new provider.
   *
   * Why this exists: a Session binds its provider at construction. Before
   * this, a host that wanted to change the model had to build a whole new
   * Session, which dropped the in-memory history. Now the gateway can
   * keep the live session and just re-point its provider.
   */
  setModel(model: string, provider: ProviderAdapter): void {
    if (model === this.config.model && provider === this.provider) return
    this.provider = provider
    this.config = { ...this.config, model }
    // Re-point compaction at the new provider + context window so summaries
    // run on the active model and the trigger threshold matches its window.
    // Only when compaction is the live default manager — a caller that
    // explicitly disabled it (null) stays disabled.
    if (this.compaction != null) {
      this.compaction = createCompactionManager({
        config: this.config.compaction,
        provider,
        contextWindowTokens: getModelContextWindow(model),
      })
    }
  }

  /** Add a tool at runtime */
  addTool(tool: Tool): void {
    this.tools.push(tool)
  }

  /** Remove a tool at runtime */
  removeTool(name: string): void {
    this.tools = this.tools.filter(t => t.name !== name)
  }

  /** Set a permission for a tool for this session */
  setPermission(toolName: string, decision: PolicyDecision): void {
    if (!this.permissionStore) {
      this.permissionStore = new SessionPermissionStore()
    }
    this.permissionStore.remember(toolName, decision)
  }

  /** Check what permission is set for a tool */
  getPermission(toolName: string): PolicyDecision | null {
    return this.permissionStore?.check(toolName) ?? null
  }

  /** Clear all permissions for this session */
  clearPermissions(): void {
    this.permissionStore?.clear()
  }

  /**
   * Clean up session state. Clears messages, resets usage counters,
   * and aborts any in-flight operations. Call this when the session
   * is no longer needed to release memory held by message history.
   *
   * After cleanup(), the session can still be used (it resets to initial state),
   * but any in-progress operations will be aborted.
   */
  cleanup(): void {
    this.abort('system')
    this.messages = []
    this.turnCount = 0
    this.totalUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 }
    this.permissionStore?.clear()
  }
}

// ---------------------------------------------------------------------------
// Convenience: create a session with minimal config
// ---------------------------------------------------------------------------

export function createSession(
  model: string,
  opts: {
    provider: ProviderAdapter
    tools?: Tool[]
    systemPrompt?: SystemPrompt
    config?: Partial<LoomConfig>
  },
): Session {
  const config = mergeConfig(
    createDefaultConfig(model),
    {
      systemPrompt: opts.systemPrompt ?? '',
      ...opts.config,
    },
  )

  return new Session({
    config,
    provider: opts.provider,
    tools: opts.tools ?? [],
  })
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

interface MutableUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  costUsd: number
}

/**
 * Compute USD cost for a one-shot side call. Mirrors the main loop's
 * pricing path so the side call's cost is comparable to (and rolls
 * cleanly into) the session totals computed by `loop.ts`.
 *
 * Falls back to Sonnet-tier pricing when the model is unknown, with
 * a one-time warn — same behaviour as the main loop's `computeCost`.
 */
function computeSideCallCost(
  provider: ProviderAdapter,
  model: string,
  usage: {
    readonly inputTokens: number
    readonly outputTokens: number
    readonly cacheReadTokens: number
    readonly cacheCreationTokens: number
  },
): number {
  const pricing = provider.getModelPricing(model)
  if (pricing != null) {
    return calculateCost(
      pricing,
      usage.inputTokens,
      usage.outputTokens,
      usage.cacheReadTokens,
      usage.cacheCreationTokens,
    )
  }
  warnIfFallbackPricing(provider.name, model)
  return estimateCostFallback(
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheReadTokens,
    usage.cacheCreationTokens,
  )
}
