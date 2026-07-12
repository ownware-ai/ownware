/**
 * Session Runner — decoupled loop consumption.
 *
 * The single most important file for connection resilience. Previously,
 * the Loom generator was consumed INSIDE the HTTP handler — when the
 * SSE connection dropped (tab close, refresh, network blip), the loop
 * died with it. This module moves consumption into a fire-and-forget
 * async function that runs independently of any HTTP connection.
 *
 * The pipeline:
 *
 *   POST /run → startRun() → returns { threadId } immediately
 *                   ↓
 *            Background async function iterates session.submitMessage()
 *                   ↓
 *            Each event → EventIngestor (SQLite + EventBus)
 *                   ↓
 *            Any SSE client → GET /threads/:tid/agents/root/events
 *                              (subscribe-before-read, replay + tail)
 *
 * SSE disconnect = unsubscribe from EventBus. Loop keeps running.
 * The only way to stop the loop is POST /threads/:tid/abort.
 *
 * Lifecycle:
 *   - Runner starts when POST /run fires
 *   - Runner ends when: loop completes, abort is called, or an
 *     unrecoverable error occurs
 *   - On end: usage is recorded, thread title is updated, runtime
 *     is cleaned up, completion event is published to EventBus
 */

import type { LoomEvent, ContentBlock, ZoneDecision } from '@ownware/loom'
import { ZONE_LEVEL_NAMES } from '@ownware/loom'
import type { GatewayState } from './state.js'
import type { ThreadMessage, ToolCallRecord, SubAgentRecord, PermissionRecord, CredentialRecord, AttachmentMeta, MessagePart } from './types.js'
import type { TurnInterruptedEvent } from './events.js'
import { trace, traceEnabled } from './trace.js'
import type { PendingReconciles } from './pending-reconcile.js'
import type { ProfileRegistry } from '../profile/registry.js'
import type { ConnectorToolProvider } from '../connector/providers/types.js'
import { reconcileSessionTools } from '../profile/reconcile.js'
import type { GatewayRunStore } from './run-store.js'

/**
 * Dependencies needed to perform turn-boundary reconcile. Optional on
 * `SessionRunner` so existing code paths + tests that don't exercise
 * reconcile still compile.
 */
export interface ReconcileDeps {
  readonly pending: PendingReconciles
  readonly profileRegistry: ProfileRegistry
  readonly toolProviders: readonly ConnectorToolProvider[]
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RunParams {
  /** Immutable durable run identity. */
  readonly runId?: string
  /** Thread ID (already created by the run handler). */
  readonly threadId: string
  /** Profile ID for usage tracking. */
  readonly profileId: string
  /** Model string (e.g. "anthropic:claude-sonnet-4-20250514"). */
  readonly model: string
  /** Prompt content — string or multimodal blocks. */
  readonly prompt: string | ContentBlock[]
  /** Attachment metadata (for the session.end event). */
  readonly attachments?: AttachmentMeta[]
  /**
   * Wall-clock timeout in milliseconds. When set, the runner starts a
   * timer at loop entry; on fire, it calls `session.abort('timeout')`
   * which terminates the generator. The catch block maps the timeout
   * reason to `status: 'aborted'` so the SSE stream closes cleanly.
   *
   * `undefined` or `<= 0` → no wall-clock enforcement. Derived from
   * the profile's `execution.timeout` string by the run handler.
   */
  readonly timeoutMs?: number
}

export type RunStatus = 'running' | 'completed' | 'error' | 'aborted'

export interface ActiveRun {
  readonly runId: string
  readonly threadId: string
  readonly profileId: string
  readonly model: string
  readonly status: RunStatus
  readonly startedAt: string
  /** Sequence number of the last event written. */
  readonly lastSeq: number
  /** Number of turns completed so far. */
  readonly turnCount: number
  /** Total cost so far. */
  readonly costUsd: number
}

/** Resolved when the run finishes (any reason). Exposes final stats. */
export interface RunHandle {
  readonly runId: string
  readonly threadId: string
  /** Promise that resolves when the background loop terminates. */
  readonly done: Promise<RunResult>
}

export interface RunResult {
  readonly status: RunStatus
  readonly turnCount: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly costUsd: number
  /** Error message if status is 'error'. */
  readonly error?: string
  /**
   * An in-band error surfaced DURING the run — a provider/tool error
   * recorded as a `role:'error'` message — even though the loop returned
   * normally (so `status` stays `'completed'` and the thread status is
   * unchanged). The scheduler reads this to classify the run as
   * `failed-to-run` instead of a false success (BUGS HON-1). Undefined
   * when no error event occurred.
   */
  readonly errorEvent?: string
}

// ---------------------------------------------------------------------------
// Session Runner
// ---------------------------------------------------------------------------

/**
 * Manages all active background runs. One instance per gateway.
 *
 * The runner keeps a Map of active runs keyed by threadId. The gateway
 * state still holds the Session + HITL runtime (since those are needed
 * by the resume/abort endpoints too). The runner just owns the iteration
 * lifecycle.
 */
export class SessionRunner {
  private readonly runs = new Map<string, MutableRun>()
  /**
   * Per-active-run callback that routes a sub-agent lifecycle event
   * (`agent.spawn`, `agent.complete`) from the spawner's onEvent hook
   * into the parent run's TurnAccumulator.
   *
   * Why this exists: those events are yielded by the spawner's own
   * generator, not by the parent's `session.submitMessage()` generator.
   * The runner's main `consumeLoop` therefore never sees them, so the
   * `case 'agent.spawn'` branch in `accumulateEvent` would otherwise
   * be unreachable for real sub-agent invocations and the parent's
   * `messages.subAgents[]` + `messages.parts[]` snapshot would silently
   * lose the helper. The hook closes that loop without changing Loom or
   * modifying the spawner contract.
   *
   * Key is the parent threadId. Map entry exists for the lifetime of
   * one `consumeLoop` invocation; cleared in its `finally`. Lookup is a
   * no-op when no run is active for the thread (late events are
   * dropped silently — the `messages` row was already saved).
   */
  private readonly lifecycleCallbacks = new Map<string, (event: LoomEvent) => void>()

  /**
   * Optional reconcile wiring. When present, the runner reconciles
   * each thread's connector-sourced tool list against the latest
   * profile + vault state at the top of every turn where the
   * thread is marked pending. Absent — existing behaviour unchanged
   * (session's initial tool list stays frozen until restart / new
   * thread).
   *
   * Settable (not a constructor arg) because `SessionRunner` is
   * built at gateway boot BEFORE the connector providers and
   * profile registry are fully resolved — the deps land later in
   * the same boot sequence. `setReconcileDeps` is idempotent and
   * expected to be called exactly once.
   */
  private reconcileDeps?: ReconcileDeps

  /**
   * Optional post-flight LLM-cost sink. Invoked once per finished run
   * with the run's real total cost (Loom computes this from the
   * models.dev pricing table; the runner accumulates it into
   * `run.costUsd`). The gateway wires this to attribute the cost back
   * to the backing credential so the Settings → Credentials cost panel
   * shows real spend.
   *
   * A callback (not a direct store/audit dependency) keeps the runner
   * decoupled from credential internals — `session-runner` has no
   * business importing the credential store. Settable, not a
   * constructor arg, because the runner is built before the credential
   * store during boot (same reason as `reconcileDeps`).
   */
  private llmCostSink?: (params: {
    readonly model: string
    readonly costUsd: number
    readonly threadId: string
    readonly profileId: string
  }) => void

  constructor(
    private readonly state: GatewayState,
    private readonly runStore?: GatewayRunStore,
  ) {}

  /** Install the reconcile dependencies. Called once during boot. */
  setReconcileDeps(deps: ReconcileDeps): void {
    this.reconcileDeps = deps
  }

  /** Install the post-flight LLM-cost sink. Called once during boot. */
  setLlmCostSink(sink: SessionRunner['llmCostSink']): void {
    this.llmCostSink = sink
  }

  /**
   * Forward a sub-agent lifecycle event into the parent's accumulator.
   * Called by the spawner's `onEvent` wiring in `run.ts` for every
   * `agent.spawn` and `agent.complete` event.
   *
   * Returns true if the event was consumed by an active run's
   * accumulator, false if no run is active for the thread. When false,
   * the caller is responsible for back-patching the message row directly
   * (the saved row's sub_agents JSON won't reflect this completion).
   */
  notifyParentLifecycleEvent(threadId: string, event: LoomEvent): boolean {
    const cb = this.lifecycleCallbacks.get(threadId)
    if (cb) {
      cb(event)
      return true
    }
    return false
  }

  /**
   * Start a background run. Returns immediately with a handle.
   *
   * The caller (run handler) must have already:
   *   - Created or retrieved the thread
   *   - Created the Session + runtime (state.setRuntime)
   *   - Saved the user message
   *   - Ingested the user.message event
   *
   * This function kicks off the generator consumption in the background
   * and returns a handle with a `done` promise.
   */
  start(params: RunParams): RunHandle {
    if (this.runs.has(params.threadId)) {
      throw new Error(`Thread "${params.threadId}" already has an active run`)
    }

    const runId = params.runId ?? crypto.randomUUID()
    const run: MutableRun = {
      runId,
      threadId: params.threadId,
      profileId: params.profileId,
      model: params.model,
      status: 'running',
      startedAt: new Date().toISOString(),
      lastSeq: 0,
      turnCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    }

    this.runs.set(params.threadId, run)
    this.runStore?.markRunning(runId)

    // Fire-and-forget — the promise is exposed via the handle but never
    // awaited inside the HTTP handler. Errors are caught internally.
    const done = this.consumeLoop(run, params)
      .finally(() => {
        this.runs.delete(params.threadId)
      })

    return { runId, threadId: params.threadId, done }
  }

  /** Get an active run's live stats. */
  get(threadId: string): ActiveRun | undefined {
    return this.runs.get(threadId)
  }

  /** List all active runs. */
  listActive(): ActiveRun[] {
    return [...this.runs.values()]
  }

  /** Number of currently active runs. */
  get activeCount(): number {
    return this.runs.size
  }

  /** Check if a thread has an active run. */
  isRunning(threadId: string): boolean {
    return this.runs.has(threadId)
  }

  /**
   * Wait for all active runs to finish. Called on gateway shutdown.
   * Optionally abort all runs first.
   */
  async drainAll(abortFirst = false): Promise<void> {
    if (abortFirst) {
      for (const [threadId] of this.runs) {
        const session = this.state.getSession(threadId)
        session?.abort('system')
      }
    }
    const promises = [...this.runs.values()].map(r => r.donePromise).filter(Boolean)
    await Promise.allSettled(promises as Promise<unknown>[])
  }

  // ── Internal: the background loop ───────────────────────────────────

  private async consumeLoop(
    run: MutableRun,
    params: RunParams,
  ): Promise<RunResult> {
    const { threadId, profileId, model } = params
    const session = this.state.getSession(threadId)
    const runtime = this.state.getRuntime(threadId)

    if (!session || !runtime) {
      run.status = 'error'
      return { status: 'error', turnCount: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, error: 'Missing session or runtime' }
    }

    // Stash the done promise so drainAll can await it
    let resolveDone!: (r: RunResult) => void
    run.donePromise = new Promise<RunResult>(resolve => { resolveDone = resolve })

    // Wall-clock timeout enforcement (F-09). A positive `timeoutMs`
    // arms a one-shot timer; on fire we call `session.abort('timeout')`
    // which propagates through the generator and lands in the catch
    // block below as `message === 'timeout'` → `status = 'aborted'`.
    //
    // The timer is cleared in the `finally` block regardless of
    // outcome so a completed short run never leaks a pending timer.
    // Node's `Timeout` keeps the event loop alive, which is exactly
    // what we want while the run is in flight.
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null
    if (params.timeoutMs !== undefined && params.timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        try {
          session.abort('timeout')
        } catch (err) {
          console.error('[session-runner] timeout abort failed:', err)
        }
      }, params.timeoutMs)
    }

    const getLastZoneDecision = (runtime as any).lastZoneDecision as (() => ZoneDecision | null) | undefined

    // Single mutable accumulator for per-turn history assembly. Reused
    // across turns (reset inside `accumulateEvent` on every turn.end) and
    // flushed one last time by `flushPartialTurn` in the finally block if
    // the run terminates mid-turn (abort, error, timeout, shutdown).
    const acc: TurnAccumulator = createAccumulator()

    const saveMessage = (msg: ThreadMessage) => {
      try { this.state.addMessage(threadId, msg) } catch { /* best effort */ }
    }
    const generateMsgId = () => `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`

    // Track the last observed turnIndex so the finalizer can tag a
    // turn.interrupted event correctly even if turn.end never fires.
    let observedTurnIndex = 0

    // Captures the precise reason the run terminated. RunStatus collapses
    // user-abort, timeout, and system-abort into the single 'aborted'
    // bucket; the finalizer's turn.interrupted event needs the original
    // signal so the client can render "timed out" vs "you stopped it".
    let interruptReason: TurnInterruptedEvent['reason'] | null = null

    // Register the lifecycle callback so the spawner's onEvent hook can
    // route agent.spawn / agent.complete events into THIS run's
    // accumulator. Cleared in the finally block so a late event after
    // the run is gone is silently dropped (the messages row is already
    // written by then). The callback closes over `acc`, so each run
    // gets its own isolated accumulator path.
    this.lifecycleCallbacks.set(threadId, event => {
      trace('runner-lifecycle-cb', threadId, 'root', event.type)
      this.accumulateEvent(event, event, acc, run, saveMessage, generateMsgId)
    })

    try {
      // ── Turn-boundary reconcile ──────────────────────────────────
      // Before handing control to Loom, if this thread was marked
      // pending (by an attach/detach handler or a status-bus event
      // since the last turn), diff the profile's current declared
      // connector tools against the session's managed snapshot and
      // apply add/remove. Emitted `tools.reconciled` so the client can
      // render "Gmail added" inline above the assistant's next reply.
      //
      // Serialized with `withReconcileLock` so two concurrent
      // submitMessage calls on the same thread can't race the
      // `session.tools` mutation. `addTool`/`removeTool` are the only
      // mutators Loom exposes publicly (verified via grep); keeping
      // all reconciles behind this lock keeps the session's tool list
      // consistent with this tracker's managed snapshot.
      if (
        this.reconcileDeps !== undefined
        && this.reconcileDeps.pending.consume(threadId)
      ) {
        const deps = this.reconcileDeps
        try {
          const profile = await deps.profileRegistry.get(profileId)
          const prior = deps.pending.getManaged(threadId) ?? new Map()
          const reconciled = await deps.pending.withReconcileLock(
            threadId,
            () => reconcileSessionTools(session, prior, profile, {
              providers: deps.toolProviders,
            }),
          )
          deps.pending.setManaged(threadId, reconciled.managed)

          // Emit an observable event ONLY if something actually
          // changed or a provider errored. Silent no-op on clean
          // reconcile — keeps the SSE stream quiet on every turn.
          if (
            reconciled.added.length > 0
            || reconciled.removed.length > 0
            || reconciled.errors.length > 0
          ) {
            try {
              this.state.eventIngestor.ingestParentEvent(
                threadId,
                {
                  type: 'tools.reconciled',
                  added: reconciled.added,
                  removed: reconciled.removed,
                  errors: reconciled.errors,
                  durationMs: reconciled.durationMs,
                  timestamp: Date.now(),
                } as unknown as LoomEvent,
              )
            } catch { /* observability best-effort */ }
          }
        } catch (err) {
          // Reconcile should never throw (documented invariant) but
          // a defensive wrapper here means a regression doesn't bring
          // down a user's turn. Old tool list stays; user sends their
          // next message to retry.
          console.error(
            '[session-runner] reconcile failed for thread',
            threadId,
            err instanceof Error ? err.message : err,
          )
        }
      }

      const events = session.submitMessage(params.prompt)
      let result = await events.next()

      while (!result.done) {
        const event = result.value

        trace('runner-recv', threadId, 'root', event.type)

        // ── Enrich permission events with zone metadata ──────────
        let enriched = enrichEvent(event, getLastZoneDecision)
        if (event.type === 'permission.request' && this.runStore) {
          const permission = this.runStore.recordPermissionRequest({
            runId: run.runId,
            requestId: event.requestId,
            toolName: event.toolName,
            toolInput: event.input,
          })
          enriched = {
            ...enriched,
            operationHash: permission.operationHash,
          } as unknown as LoomEvent
          this.runStore.markWaiting(run.runId)
        } else if (event.type === 'permission.response' && this.runStore) {
          const permission = this.runStore.getPermissionRequest(run.runId, event.requestId)
          if (permission?.status === 'pending') {
            this.runStore.decidePermission(
              run.runId,
              event.requestId,
              permission.operationHash,
              event.granted ? 'approve' : 'deny',
            )
          }
          if (runtime.hitl.pendingCount === 0) {
            this.runStore.markRunningAfterDecision(run.runId)
          }
        }

        // ── Persist to SQLite + fan out to EventBus ──────────────
        // Skip transient recoverable errors — they're retry noise.
        const isRecoverableError = event.type === 'error' &&
          (event as { recoverable?: boolean }).recoverable === true

        if (isRecoverableError) {
          trace('runner-skip', threadId, 'root', event.type, { reason: 'recoverable_error' })
        } else {
          // Always-on perm-trace for permission events: the receive
          // side (runner sees the yielded event from Loom). Pairs with
          // the cortex-ingest-{db,bus} lines so we can confirm the
          // event made the trip across the seam.
          const isPermEvent = event.type === 'permission.request'
            || event.type === 'permission.response'
          if (isPermEvent && traceEnabled) {
            // eslint-disable-next-line no-console
            console.log('[perm-trace] cortex-runner-recv', {
              threadId,
              requestId: (event as { requestId?: string }).requestId ?? null,
              type: event.type,
              ts: Date.now(),
            })
          }
          try {
            run.lastSeq = this.state.eventIngestor.ingestParentEvent(threadId, enriched)
          } catch (err) {
            trace('runner-ingest-fail', threadId, 'root', event.type, {
              err: err instanceof Error ? err.message : String(err),
            })
            console.error('[session-runner] event ingest failed:', err)
            if (isPermEvent && traceEnabled) {
              // eslint-disable-next-line no-console
              console.log('[perm-trace] cortex-runner-INGEST-SWALLOWED', {
                threadId,
                requestId: (event as { requestId?: string }).requestId ?? null,
                type: event.type,
                err: err instanceof Error ? err.message : String(err),
                ts: Date.now(),
              })
            }
          }
        }

        // ── Legacy in-memory debug log ───────────────────────────
        this.state.logEvent(threadId, event)

        // Track most recent turnIndex across event shapes.
        if (typeof (event as { turnIndex?: number }).turnIndex === 'number') {
          observedTurnIndex = (event as { turnIndex: number }).turnIndex
        }

        // ── Accumulate messages for thread history ────────────────
        this.accumulateEvent(event, enriched, acc, run, saveMessage, generateMsgId)

        result = await events.next()
      }

      // Generator returned — loop completed successfully.
      run.status = 'completed'

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)

      // Check if this was an abort. Session.abort() throws with the
      // reason as the error message — 'user' | 'timeout' | 'system'.
      if (message === 'user' || message === 'system') {
        run.status = 'aborted'
        interruptReason = 'aborted'
      } else if (message === 'timeout') {
        run.status = 'aborted'
        interruptReason = 'timeout'
      } else {
        run.status = 'error'
        interruptReason = 'error'
        // Emit error event so SSE clients see it
        try {
          this.state.eventIngestor.ingestParentEvent(threadId, {
            type: 'error',
            message,
            code: 'run_error',
            recoverable: false,
          } as LoomEvent)
        } catch { /* best effort */ }
      }
    } finally {
      // Clear wall-clock timer first — no matter why the loop ended,
      // we must not leave a pending Timeout queued.
      if (timeoutHandle !== null) {
        clearTimeout(timeoutHandle)
        timeoutHandle = null
      }

      // Drop the lifecycle callback so any late sub-agent event can't
      // mutate a stale accumulator. Late events still land in
      // agent_events via the ingestor — they just no longer back-stamp
      // the parent's saved messages row (which has already been written
      // by either turn.end or flushPartialTurn below).
      this.lifecycleCallbacks.delete(threadId)

      // ── Partial-turn finalization ────────────────────────────
      //
      // If the run terminated outside a turn.end (abort, error, timeout,
      // shutdown), the accumulator still holds streamed content, pending
      // tool calls, pending sub-agents, and pending permission requests.
      // Flush them as one last assistant row so the thread snapshot is
      // complete — a client hydrating from /messages should see the full
      // conversation, not a truncated transcript.
      //
      // Safe to always call: if the run ended cleanly on turn.end the
      // accumulator is already empty and this is a no-op.
      if (run.status !== 'completed' && accumulatorHasContent(acc)) {
        try {
          this.flushPartialTurn(
            threadId,
            acc,
            interruptReason ?? 'error',
            observedTurnIndex,
            saveMessage,
            generateMsgId,
          )
        } catch (err) {
          console.error('[session-runner] partial-turn flush failed:', err)
        }
      }

      // ── Post-run bookkeeping ─────────────────────────────────

      // 1. Update thread title from first user message.
      //
      // Two paths:
      //   - Profile declared `smallFastModel` → ask that model to
      //     condense the first user message into a 3-7 word title.
      //     Costs ~$0.0001 per thread on Haiku and produces titles
      //     much more useful than a substring slice ("Bug fix in
      //     baz.ts" vs "Now, fix the bug in baz.ts line 42 and...").
      //   - Otherwise → fall back to the substring of the first user
      //     message. Free, predictable, what the gateway has always
      //     done.
      // Either path is wrapped in best-effort; a failure must never
      // leave the thread in an inconsistent state — at worst the
      // title stays the placeholder.
      try {
        const messages = this.state.getMessages(threadId)
        const thread = this.state.getThread(threadId)
        const currentTitle = thread?.title
        const isPlaceholder = !currentTitle || currentTitle === 'New chat'
        if (isPlaceholder) {
          const firstUser = messages.find(m => m.role === 'user')
          if (firstUser) {
            const session = this.state.getSession(threadId)
            const companions = this.state.getSessionCompanions(threadId)
            const smallFastModel = companions?.smallFastModel ?? null
            let title: string | null = null

            if (session && smallFastModel) {
              try {
                const { text } = await session.querySide({
                  model: smallFastModel,
                  systemPrompt:
                    'You generate short, clear thread titles. Reply with ONLY the title — ' +
                    '3 to 7 words, no quotes, no trailing punctuation. Do not explain.',
                  prompt: `Generate a thread title for this user message:\n\n${firstUser.content.slice(0, 800)}`,
                  maxTokens: 32,
                })
                const cleaned = text.trim().replace(/^["'`]|["'`.]$/g, '').trim()
                if (cleaned.length > 0 && cleaned.length <= 120) {
                  title = cleaned
                }
              } catch (err) {
                // Side-call failed — log once and fall through to the
                // substring fallback so the thread still gets a title.
                console.warn(
                  `[session-runner] thread title side-call failed for ${threadId}: ` +
                    (err instanceof Error ? err.message : String(err)),
                )
              }
            }

            if (title === null) {
              title = firstUser.content.slice(0, 80)
              if (firstUser.content.length > 80) title += '...'
            }

            this.state.updateThread(threadId, { title })
          }
        }
      } catch { /* best effort */ }

      // 2. Update thread status. Aborted runs are recorded as 'completed'
      //    on the thread for now — the Thread wire type only has
      //    'active' | 'completed' | 'error', and aborted threads are
      //    not errors. A dedicated 'aborted' thread status is a future
      //    schema addition; the interrupted assistant turn is already
      //    surfaced via the partial-turn flush above and the
      //    turn.interrupted event in the agent_events stream.
      try {
        this.state.updateThread(threadId, {
          status: run.status === 'error' ? 'error' : 'completed',
        })
      } catch { /* best effort */ }

      // 3. Record usage
      try {
        const providerName = model.includes(':') ? model.split(':')[0]! : 'unknown'
        this.state.addUsageRecord({
          threadId,
          profileId,
          model,
          provider: providerName,
          inputTokens: run.inputTokens,
          outputTokens: run.outputTokens,
          costUsd: run.costUsd,
        })
        this.state.incrementProfileUsage(profileId, run.costUsd)
        // Attribute the real cost back to the backing credential so the
        // Settings → Credentials cost panel reflects actual spend. Only
        // when the run cost something — a free/zero-cost run has nothing
        // to true up. The sink owns its own error handling.
        if (run.costUsd > 0) {
          this.llmCostSink?.({ model, costUsd: run.costUsd, threadId, profileId })
        }
      } catch { /* best effort */ }

      // 4. Clean up runtime (Session stays for context, runtime is per-run)
      this.state.deleteRuntime(threadId)

      const finalResult: RunResult = {
        status: run.status,
        turnCount: run.turnCount,
        inputTokens: run.inputTokens,
        outputTokens: run.outputTokens,
        costUsd: run.costUsd,
        error: run.status === 'error' ? 'Run failed' : undefined,
        ...(run.errorEventMessage != null ? { errorEvent: run.errorEventMessage } : {}),
      }

      if (this.runStore) {
        const endSeq = this.state.getAgentEventMaxSeq(threadId, 'root')
        if (run.status === 'completed' && run.errorEventMessage == null) {
          this.runStore.markTerminal(run.runId, 'succeeded', { endSeq })
        } else if (run.status === 'aborted' && interruptReason === 'timeout') {
          this.runStore.markTerminal(run.runId, 'timed_out', { endSeq, code: 'run_timeout' })
        } else if (run.status === 'aborted') {
          this.runStore.markTerminal(run.runId, 'cancelled', { endSeq, code: 'run_cancelled' })
        } else {
          this.runStore.markTerminal(run.runId, 'failed', { endSeq, code: 'run_failed' })
        }
      }

      resolveDone(finalResult)
      return finalResult
    }
  }

  /**
   * Accumulate a single event into thread-history structures.
   * This is the production message-persistence path for background runs.
   *
   * Mutates `acc` in place — cheaper than the old callback-ref pattern
   * and makes the partial-turn flush path trivial (flushPartialTurn reads
   * the same struct).
   */
  private accumulateEvent(
    event: LoomEvent,
    enrichedEvent: LoomEvent,
    acc: TurnAccumulator,
    run: MutableRun,
    saveMessage: (msg: ThreadMessage) => void,
    generateMsgId: () => string,
  ): void {
    switch (event.type) {
      case 'text.delta':
        acc.text += event.text
        appendTextPart(acc, event.text)
        break

      case 'thinking.delta':
        acc.thinking += event.text
        appendThinkingPart(acc, event.text)
        break

      case 'tool.call.start':
        acc.toolInputs.set(event.toolCallId, event.input)
        acc.toolRawArgs.set(event.toolCallId, '')
        acc.toolStartTimes.set(event.toolCallId, new Date().toISOString())
        // Tool appears in the timeline at the start point — that is when
        // the user saw the "calling tool" card. The MutableMessagePart
        // carries the stable toolCallId so consumers can resolve it
        // against acc.tools[] regardless of when the tool finishes.
        acc.parts.push({ kind: 'tool', toolCallId: event.toolCallId })
        break

      case 'tool.call.end': {
        // Resolve final input. tool.call.start.input is `{}` for
        // streaming-args providers (Kimi/OpenAI) — the actual args
        // arrive as `tool.call.args_delta` chunks. Parse the
        // accumulated raw JSON if non-empty; fall back to whatever
        // start gave us. Defensive parse: malformed JSON falls back
        // to the start value (no crash, no false positives).
        let toolInput: unknown = acc.toolInputs.get(event.toolCallId) ?? {}
        const rawArgs = acc.toolRawArgs.get(event.toolCallId) ?? ''
        if (rawArgs.length > 0) {
          try {
            const parsed = JSON.parse(rawArgs)
            if (parsed != null && typeof parsed === 'object') {
              toolInput = parsed
            }
          } catch {
            // Malformed JSON — keep start.input as-is.
          }
        }
        acc.tools.push({
          toolCallId: event.toolCallId,
          name: event.toolName,
          input: toolInput,
          output: event.result,
          isError: event.isError,
          durationMs: event.durationMs,
          startedAt: acc.toolStartTimes.get(event.toolCallId),
          metadata: event.metadata,
        })

        // Sub-agent prompt/task capture.
        //
        // Loom's `AgentSpawnEvent` does NOT carry the helper's task label
        // or prompt — those fields live in the `agent_spawn` tool input,
        // which is cortex-level domain (the model calls a tool named
        // `agent_spawn`; Loom just routes the call). The tool's
        // implementation returns `metadata.agentId` on `tool.call.end`,
        // which is the stable correlator between the tool call and the
        // helper it spawned.
        //
        // We correlate here because `tool.call.end` is the first point
        // where both are in scope:
        //   • acc.toolInputs still has the input (drained below).
        //   • event.metadata.agentId identifies the spawned helper.
        //
        // Two timings to handle:
        //   • Foreground (default): agent.spawn/complete fire BEFORE
        //     tool.call.end (parent tool awaits `waitForAgent`), so the
        //     SubAgentRecord is already in acc.agents — we patch it.
        //   • Background: agent.spawn may fire AFTER tool.call.end — we
        //     pre-register the fields on acc.spawnInputsByAgentId so the
        //     later `agent.spawn` handler can pick them up.
        if (event.toolName === 'agent_spawn') {
          const spawnedAgentId = event.metadata &&
            typeof event.metadata === 'object' &&
            typeof (event.metadata as { agentId?: unknown }).agentId === 'string'
            ? (event.metadata as { agentId: string }).agentId
            : null
          const captured = captureSpawnFields(toolInput)
          if (spawnedAgentId !== null && captured !== null) {
            const pending = acc.pendingAgents.get(spawnedAgentId)
            if (pending) {
              const patched: SubAgentRecord = { ...pending, ...captured }
              acc.pendingAgents.set(spawnedAgentId, patched)
              const idx = acc.agents.findIndex(a => a.agentId === spawnedAgentId)
              if (idx !== -1) acc.agents[idx] = patched
            } else {
              const idx = acc.agents.findIndex(a => a.agentId === spawnedAgentId)
              if (idx !== -1) {
                acc.agents[idx] = { ...acc.agents[idx]!, ...captured }
              } else {
                // Background case: agent.spawn hasn't arrived yet. Stash
                // the fields so the agent.spawn handler below can attach
                // them when the event finally lands.
                acc.spawnInputsByAgentId.set(spawnedAgentId, captured)
              }
            }
          }
        }

        acc.toolInputs.delete(event.toolCallId)
        acc.toolRawArgs.delete(event.toolCallId)
        acc.toolStartTimes.delete(event.toolCallId)
        break
      }

      case 'agent.spawn': {
        const preRegistered = acc.spawnInputsByAgentId.get(event.agentId)
        // Enriched fields off the Loom event (L3). `orchestrate` spawns workers
        // INSIDE one tool call, so the `agent_spawn`-tool-input correlation
        // never fires for them — the event itself is the source of truth for
        // name/model/task. Fall back to the agent_spawn-captured fields when
        // the event doesn't carry them (older emitters / the single-helper path).
        const ev = event as { task?: string; name?: string; model?: string }
        const task = ev.task ?? preRegistered?.task ?? ev.name
        const record: SubAgentRecord = {
          agentId: event.agentId,
          profileName: event.profileName,
          ...(ev.model !== undefined ? { model: ev.model } : {}),
          ...(task !== undefined ? { task } : {}),
          ...(preRegistered?.prompt !== undefined ? { prompt: preRegistered.prompt } : {}),
          status: 'running',
        }
        acc.spawnInputsByAgentId.delete(event.agentId)
        acc.pendingAgents.set(event.agentId, record)
        acc.agents.push(record)
        acc.parts.push({ kind: 'subagent', agentId: event.agentId })
        break
      }

      case 'agent.complete': {
        // Enriched terminal fields (L3): status + usage. SubAgentRecord has no
        // 'aborted' state yet, so an aborted worker collapses to 'error' here
        // (a future S-slice can add a distinct state). Legacy emitters that omit
        // status default to 'completed'.
        const ev = event as {
          status?: 'completed' | 'error' | 'aborted'
          usage?: { inputTokens: number; outputTokens: number; costUsd: number }
          toolCount?: number
          turnCount?: number
        }
        const recordStatus: SubAgentRecord['status'] =
          ev.status === 'error' || ev.status === 'aborted' ? 'error' : 'completed'
        const completed: SubAgentRecord = {
          ...(acc.pendingAgents.get(event.agentId) ?? { agentId: event.agentId, profileName: 'agent' }),
          status: recordStatus,
          result: event.result,
          durationMs: event.durationMs,
          toolCount: ev.toolCount,
          turnCount: ev.turnCount,
          ...(ev.usage
            ? { usage: { inputTokens: ev.usage.inputTokens, outputTokens: ev.usage.outputTokens, costUsd: ev.usage.costUsd } }
            : {}),
        }
        acc.pendingAgents.delete(event.agentId)
        const idx = acc.agents.findIndex(a => a.agentId === event.agentId)
        if (idx !== -1) acc.agents[idx] = completed
        break
      }

      case 'permission.request': {
        const permReq = enrichedEvent as {
          requestId: string
          toolName: string
          input?: Record<string, unknown>
          reason: string
          zoneLevel?: number
          zoneName?: string
          explanation?: string
          severityTag?: 'info' | 'warn' | 'critical'
          severityReason?: string
        }
        const record: PermissionRecord = {
          requestId: permReq.requestId,
          toolName: permReq.toolName,
          input: permReq.input,
          reason: permReq.reason,
          decision: 'pending',
          zoneLevel: permReq.zoneLevel,
          zoneName: permReq.zoneName,
          explanation: permReq.explanation,
          ...(permReq.severityTag ? { severityTag: permReq.severityTag } : {}),
          ...(permReq.severityReason ? { severityReason: permReq.severityReason } : {}),
        }
        acc.pendingPermissions.set(permReq.requestId, record)
        trace('runner-perm-request', run.threadId, 'root', 'permission.request', {
          requestId: permReq.requestId,
          tool: permReq.toolName,
        })
        // Permission card appears in the timeline at request time so
        // hydrated runs show the prompt where it actually appeared, not
        // bunched at the end of the turn.
        acc.parts.push({ kind: 'permission', requestId: permReq.requestId })
        break
      }

      case 'permission.response': {
        const pending = acc.pendingPermissions.get(event.requestId)
        if (pending) {
          const resolved: PermissionRecord = {
            ...pending,
            decision: event.granted ? 'approved' : 'denied',
          }
          acc.pendingPermissions.delete(event.requestId)
          acc.permissions.push(resolved)
        }
        break
      }

      case 'security.block':
        saveMessage({
          id: generateMsgId(),
          role: 'system',
          content: `Blocked: ${event.toolName} — ${event.reason}`,
          tools: [{
            name: event.toolName,
            input: event.command ? { command: event.command } : {},
            output: event.reason,
            isError: true,
            durationMs: 0,
          }],
          ...(acc.model.length > 0 ? { model: acc.model } : {}),
          timestamp: new Date().toISOString(),
        })
        break

      case 'error':
        saveMessage({
          id: generateMsgId(),
          role: 'error',
          content: event.message,
          ...(acc.model.length > 0 ? { model: acc.model } : {}),
          timestamp: new Date().toISOString(),
        })
        // Remember the in-band error so the final RunResult is honest even
        // when the loop returns 'completed' (BUGS HON-1). Keep the latest.
        run.errorEventMessage = event.message
        break

      case 'compaction.end':
        // Drain-shimmer events (chunk #24 Option B) fire when the user
        // submits a new turn before the previous turn's BACKGROUND
        // proactive compaction has resolved. On the SUCCESS path, the
        // drain carries the real strategy/pre/post numbers, so a
        // single "Context compacted: N → M (strategy)" row is correct
        // and we write it like any other compaction.end.
        //
        // On the FAILURE path (proactive threw or was cancelled), the
        // drain emits placeholder numbers tagged with the
        // 'proactive-drain' strategy marker. The loop's sync
        // compactIfNeeded safety net then fires its own start/end pair
        // on the SAME submitMessage with the real numbers. Writing
        // both would produce two system rows for one real compaction;
        // skip the placeholder so the transcript stays accurate.
        if (event.strategy === 'proactive-drain' && event.preTokenCount === 0) {
          break
        }
        saveMessage({
          id: generateMsgId(),
          role: 'system',
          content: `Context compacted: ${event.preTokenCount} → ${event.postTokenCount} tokens (${event.strategy})`,
          ...(acc.model.length > 0 ? { model: acc.model } : {}),
          timestamp: new Date().toISOString(),
        })
        break

      case 'recovery':
        saveMessage({
          id: generateMsgId(),
          role: 'system',
          content: `Recovery: ${event.reason} (attempt ${event.attempt}) — ${event.detail}`,
          ...(acc.model.length > 0 ? { model: acc.model } : {}),
          timestamp: new Date().toISOString(),
        })
        break

      case 'turn.end': {
        run.turnCount += 1
        run.inputTokens += event.usage.inputTokens
        run.outputTokens += event.usage.outputTokens
        run.costUsd += event.usage.costUsd

        const hasContent = acc.text.trim().length > 0
        const hasTools = acc.tools.length > 0
        const hasAgents = acc.agents.length > 0
        const hasPermissions = acc.permissions.length > 0
        const hasCredentials = acc.credentials.length > 0
        const hasThinking = acc.thinking.trim().length > 0

        // A turn that only produced a credential / permission / thinking
        // emission (no text, no tool text, no sub-agent) still needs a
        // row — otherwise the hydrated transcript loses the card entirely.
        // Mirrors the partial-turn finalizer's gate below.
        if (hasContent || hasTools || hasAgents || hasPermissions || hasCredentials || hasThinking) {
          saveMessage({
            id: generateMsgId(),
            role: 'assistant',
            content: acc.text,
            tools: hasTools ? [...acc.tools] : undefined,
            subAgents: hasAgents ? [...acc.agents] : undefined,
            permissions: hasPermissions ? [...acc.permissions] : undefined,
            credentials: hasCredentials ? [...acc.credentials] : undefined,
            thinking: hasThinking ? acc.thinking : undefined,
            usage: {
              inputTokens: event.usage.inputTokens,
              outputTokens: event.usage.outputTokens,
              // Cache fields (migration 027). Loom's TurnUsage always
              // carries both — the client's context-fill indicator sums
              // these into the inputTokens to compute true window-fill.
              cacheReadTokens: event.usage.cacheReadTokens,
              cacheCreationTokens: event.usage.cacheCreationTokens,
            },
            parts: acc.parts.length > 0 ? acc.parts.map(snapshotPart) : undefined,
            // Per-message model attribution — what produced THIS turn.
            // Captured from session.start.model into acc.model and
            // frozen onto the row at INSERT.
            ...(acc.model.length > 0 ? { model: acc.model } : {}),
            timestamp: new Date().toISOString(),
          })
        }

        resetAccumulator(acc)
        break
      }

      // session.start carries the canonical model id producing this
      // run. We capture it onto the accumulator so every saveMessage
      // call this run makes (assistant turn.end, error, security.block,
      // compaction.end, recovery, system) can stamp `model` onto the
      // messages row. Without this stamp, hydrating the chat after
      // reload shows a generic 'agent' badge instead of the actual
      // brain that produced the turn — the bug this work fixes.
      case 'session.start':
        if (typeof event.model === 'string' && event.model.length > 0) {
          acc.model = event.model
        }
        break

      // ── Events we deliberately do NOT reduce into messages ─────────
      //
      // These are persisted to agent_events for live SSE consumers and
      // for raw replay, but they do not contribute to the messages
      // snapshot — either because they have no UI representation
      // (audit, cache, context.pressure), because the lifecycle markers
      // are derived from the messages we already write (session.end /
      // turn.start), or because they are streaming-only duplicates of
      // the canonical "complete" event we already record (text.complete,
      // thinking.complete, tool.call.args_delta, tool.call.progress,
      // compaction.start, checkpoint.saved, security.redact). Listed
      // explicitly so the exhaustive-switch guard below cannot silently
      // drop a future event type.
      case 'tool.call.args_delta': {
        // Accumulate the streamed JSON arg chunks. Replaces the
        // empty `tool.call.start.input` at `tool.call.end` time for
        // streaming providers (Kimi, OpenAI). Without this, persisted
        // tool records have `input: {}` and hydrated tool rows can't
        // resolve their file_path / command / etc.
        const prev = acc.toolRawArgs.get(event.toolCallId) ?? ''
        acc.toolRawArgs.set(event.toolCallId, prev + event.delta)
        break
      }
      case 'session.end':
      case 'turn.start':
      case 'text.complete':
      case 'thinking.complete':
      case 'tool.call.progress':
      case 'compaction.start':
      case 'tool_result.drop':
      case 'context.pressure':
      case 'cache.status':
      case 'checkpoint.saved':
      case 'security.redact':
      case 'audit.entry':
        break

      case 'credential.request': {
        // Mirrors permission.request: stash a pending record keyed by
        // requestId, push a timeline part so the hydrated transcript
        // knows where the card sits in the turn, and wait for the
        // matching credential.response to resolve the decision.
        //
        // Security: only metadata is stored. The secret value never
        // flows through this accumulator — it goes from the client-facing
        // vault endpoint directly into the credentials runtime, and
        // this row only carries the pointer (`credentialId`) once
        // stored.
        const record: CredentialRecord = {
          requestId: event.requestId,
          label: event.label,
          hint: event.hint,
          usage: event.usage,
          placement: event.placement,
          isRequired: event.isRequired,
          decision: 'pending',
        }
        acc.pendingCredentials.set(event.requestId, record)
        acc.parts.push({ kind: 'credential', requestId: event.requestId })
        break
      }

      case 'credential.response': {
        const pending = acc.pendingCredentials.get(event.requestId)
        if (pending) {
          const resolved: CredentialRecord = event.denied
            ? { ...pending, decision: 'denied' }
            : {
                ...pending,
                decision: 'stored',
                // credentialId is guaranteed non-null when denied=false
                // (CredentialResponseEvent contract in @ownware/loom).
                // We fall back to pending.requestId defensively so the
                // row is never silently incomplete if a provider ever
                // drifts off contract.
                credentialId: event.credentialId ?? pending.requestId,
              }
          acc.pendingCredentials.delete(event.requestId)
          acc.credentials.push(resolved)
        }
        break
      }

      default: {
        // Exhaustiveness guard: if Loom adds a new event type to
        // LoomEvent, TypeScript fails this assignment and the build
        // breaks here. That's the signal to decide whether the new
        // event reduces into messages or joins the no-op list above.
        const _exhaustive: never = event
        void _exhaustive
        break
      }
    }
  }

  /**
   * Flush whatever the accumulator still holds to the messages table as
   * one final assistant row, mark any running sub-agents as interrupted,
   * and emit a `turn.interrupted` gateway event so live SSE subscribers
   * know the turn ended mid-stream.
   *
   * Called exactly once from the finally block of `consumeLoop`. Must be
   * idempotent — after it runs the accumulator is reset so a second call
   * is a no-op.
   */
  private flushPartialTurn(
    threadId: string,
    acc: TurnAccumulator,
    reason: TurnInterruptedEvent['reason'],
    turnIndex: number,
    saveMessage: (msg: ThreadMessage) => void,
    generateMsgId: () => string,
  ): void {
    // Downgrade any still-running sub-agents. The parent aborted before
    // agent.complete arrived, so we record 'error' with a synthetic
    // result string so the client's UI shows the correct badge rather than
    // a permanent "running" spinner.
    for (const running of acc.pendingAgents.values()) {
      const idx = acc.agents.findIndex(a => a.agentId === running.agentId)
      const interrupted: SubAgentRecord = {
        ...running,
        status: 'error',
        result: `<interrupted: parent ${reason}>`,
      }
      if (idx !== -1) acc.agents[idx] = interrupted
      else acc.agents.push(interrupted)
    }
    acc.pendingAgents.clear()

    // Tools that started but never received tool.call.end. parts has a
    // 'tool' entry referencing each toolCallId; without a matching
    // record in acc.tools, hydration would render an unresolved card.
    // Materialize a synthetic interrupted ToolCallRecord per pending
    // toolCallId, in start order, so the lookup-by-toolCallId resolves.
    for (const [toolCallId, input] of acc.toolInputs) {
      acc.tools.push({
        toolCallId,
        // Loom's tool.call.start carries `toolName` but acc.toolInputs
        // only retains the input payload. The name is best-effort
        // recovered from any tool.* event with the same id; if we
        // don't have it, fall back to a placeholder so the record is
        // self-describing rather than silently nameless.
        name: '<unknown>',
        input,
        output: `<interrupted: parent ${reason}>`,
        isError: true,
        startedAt: acc.toolStartTimes.get(toolCallId),
      })
    }
    acc.toolInputs.clear()
    acc.toolRawArgs.clear()
    acc.toolStartTimes.clear()

    // Pending permission requests (user never responded before abort)
    // promote to the permissions list with decision='pending' so the UI
    // can render them as outstanding rather than dropping them.
    const pendingPermissionCount = acc.pendingPermissions.size
    for (const pending of acc.pendingPermissions.values()) {
      acc.permissions.push(pending)
    }
    acc.pendingPermissions.clear()

    // Pending credential requests promote the same way. The abort
    // handler's `denyAll()` normally resolves these into credential.response
    // events first, which turn the record into 'denied' via the regular
    // accumulator path — so this branch only fires when the run crashed
    // in a way that bypassed denyAll (error, shutdown, non-abort-aware
    // await). Promoting as 'pending' preserves the truth on disk.
    const pendingCredentialCount = acc.pendingCredentials.size
    for (const pending of acc.pendingCredentials.values()) {
      acc.credentials.push(pending)
    }
    acc.pendingCredentials.clear()

    const hasContent = acc.text.trim().length > 0
    const hasTools = acc.tools.length > 0
    const hasAgents = acc.agents.length > 0
    const hasPermissions = acc.permissions.length > 0
    const hasCredentials = acc.credentials.length > 0
    const hasThinking = acc.thinking.trim().length > 0

    if (hasContent || hasTools || hasAgents || hasPermissions || hasCredentials || hasThinking) {
      saveMessage({
        id: generateMsgId(),
        role: 'assistant',
        content: acc.text,
        tools: hasTools ? [...acc.tools] : undefined,
        subAgents: hasAgents ? [...acc.agents] : undefined,
        permissions: hasPermissions ? [...acc.permissions] : undefined,
        credentials: hasCredentials ? [...acc.credentials] : undefined,
        thinking: hasThinking ? acc.thinking : undefined,
        parts: acc.parts.length > 0 ? acc.parts.map(snapshotPart) : undefined,
        // Partial-turn flush still records the model that was producing
        // this turn — interrupted runs aren't anonymous in history.
        ...(acc.model.length > 0 ? { model: acc.model } : {}),
        timestamp: new Date().toISOString(),
      })
    }

    // Publish the interruption marker to the agent_events log + live bus.
    // The client's reducer uses this to render the "interrupted" badge and
    // any hydrating client gets the same signal on replay.
    try {
      const marker: TurnInterruptedEvent = {
        type: 'turn.interrupted',
        reason,
        turnIndex,
        hadContent: hasContent,
        hadTools: hasTools,
        hadSubAgents: hasAgents,
        hadPendingPermissions: pendingPermissionCount > 0,
        hadPendingCredentials: pendingCredentialCount > 0,
        timestamp: Date.now(),
      }
      this.state.eventIngestor.ingestParentEvent(threadId, marker as unknown as LoomEvent)
    } catch { /* best effort */ }

    resetAccumulator(acc)
  }
}

// ---------------------------------------------------------------------------
// Turn accumulator
// ---------------------------------------------------------------------------

/**
 * Per-turn state built up by the runner as events stream in. Reset on
 * every `turn.end` and flushed one last time by `flushPartialTurn` if
 * the run terminates without a closing turn.end.
 *
 * Kept as a plain mutable struct (not a class) so the accumulate switch
 * reads like an imperative reducer — easy to audit, easy to test.
 */
/**
 * Mutable mirror of `MessagePart`. The public type marks every entry
 * `readonly`; the accumulator needs to mutate (merge consecutive text
 * deltas in place) so we keep an internal mutable shape and freeze on
 * snapshot.
 */
type MutableMessagePart =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; toolCallId: string }
  | { kind: 'subagent'; agentId: string }
  | { kind: 'permission'; requestId: string }
  | { kind: 'credential'; requestId: string }

interface TurnAccumulator {
  text: string
  thinking: string
  tools: ToolCallRecord[]
  agents: SubAgentRecord[]
  permissions: PermissionRecord[]
  credentials: CredentialRecord[]
  /**
   * Canonical model id producing this turn (e.g. `claude-sonnet-4-6`).
   * Captured from `session.start.model` and stamped onto every message
   * row this turn writes, so per-message attribution survives reload.
   * Empty string until the first `session.start` for the run; after that
   * it stays set for the lifetime of the accumulator.
   */
  model: string
  /**
   * Ordered timeline of what happened in this turn. Mirrors what a
   * live SSE consumer saw, in arrival order. Drained on turn.end and
   * partial-flush, then captured into the saved ThreadMessage.parts.
   */
  parts: MutableMessagePart[]
  /** tool.call.start inputs, keyed by toolCallId, drained on tool.call.end. */
  readonly toolInputs: Map<string, unknown>
  /**
   * Accumulated raw JSON args streamed via `tool.call.args_delta`,
   * keyed by toolCallId. Parsed and replaces `toolInputs[id]` at
   * `tool.call.end`. Without this, streaming-args providers (OpenAI,
   * Kimi, etc.) lose the actual input on persistence — `tool.call.start`
   * carries `input: {}` and the `args_delta` chunks are the source of
   * truth for the actual arguments. Drained on `tool.call.end`.
   */
  readonly toolRawArgs: Map<string, string>
  /** tool.call.start timestamps, keyed by toolCallId, drained on tool.call.end. */
  readonly toolStartTimes: Map<string, string>
  /** agent.spawn records awaiting agent.complete. */
  readonly pendingAgents: Map<string, SubAgentRecord>
  /** permission.request records awaiting permission.response. */
  readonly pendingPermissions: Map<string, PermissionRecord>
  /** credential.request records awaiting credential.response. */
  readonly pendingCredentials: Map<string, CredentialRecord>
  /**
   * Sub-agent task/prompt captured at `tool.call.end` for `agent_spawn`,
   * keyed by the spawned helper's agentId (from `event.metadata.agentId`).
   * Drained by a matching `agent.spawn` event. Used for the background
   * spawn path where `agent.spawn` arrives after `tool.call.end`; for the
   * foreground path the record is patched in place and this map stays
   * empty.
   */
  readonly spawnInputsByAgentId: Map<string, { task?: string; prompt?: string }>
}

function createAccumulator(): TurnAccumulator {
  return {
    text: '',
    thinking: '',
    tools: [],
    agents: [],
    permissions: [],
    credentials: [],
    model: '',
    parts: [],
    toolInputs: new Map(),
    toolRawArgs: new Map(),
    toolStartTimes: new Map(),
    pendingAgents: new Map(),
    pendingPermissions: new Map(),
    pendingCredentials: new Map(),
    spawnInputsByAgentId: new Map(),
  }
}

/**
 * Pull the `name` and `prompt` fields out of an `agent_spawn` tool input
 * and return them shaped for SubAgentRecord. Returns `null` when the
 * input isn't an object — defensive because `acc.toolInputs` stores raw
 * `tool.call.start` payloads and the model can emit malformed args in
 * rare cases.
 *
 * `name` is mapped to SubAgentRecord.task (historical name — the record
 * field was called `task` before prompt was added and the client's
 * AgentSpawnChatItem.taskName keys on it).
 */
function captureSpawnFields(
  toolInput: unknown,
): { task?: string; prompt?: string } | null {
  if (toolInput === null || typeof toolInput !== 'object') return null
  const obj = toolInput as Record<string, unknown>
  const out: { task?: string; prompt?: string } = {}
  if (typeof obj.name === 'string' && obj.name.length > 0) {
    out.task = obj.name
  }
  if (typeof obj.prompt === 'string' && obj.prompt.length > 0) {
    out.prompt = obj.prompt
  }
  if (out.task === undefined && out.prompt === undefined) return null
  return out
}

/**
 * Append text to the timeline. Consecutive text deltas merge into one
 * `text` part — the live UI sees N delta events but the snapshot
 * collapses them into one segment per "run of text between non-text
 * parts." Empty deltas are silently dropped.
 */
function appendTextPart(acc: TurnAccumulator, text: string): void {
  if (text === '') return
  const last = acc.parts[acc.parts.length - 1]
  if (last && last.kind === 'text') {
    last.text += text
  } else {
    acc.parts.push({ kind: 'text', text })
  }
}

/** Same as appendTextPart, for thinking deltas. */
function appendThinkingPart(acc: TurnAccumulator, text: string): void {
  if (text === '') return
  const last = acc.parts[acc.parts.length - 1]
  if (last && last.kind === 'thinking') {
    last.text += text
  } else {
    acc.parts.push({ kind: 'thinking', text })
  }
}

/**
 * Detach a mutable accumulator part into a frozen snapshot suitable for
 * persisting. Each kind maps 1:1 to the public `MessagePart` shape — no
 * runtime fields are dropped.
 */
function snapshotPart(p: MutableMessagePart): MessagePart {
  switch (p.kind) {
    case 'text':       return { kind: 'text', text: p.text }
    case 'thinking':   return { kind: 'thinking', text: p.text }
    case 'tool':       return { kind: 'tool', toolCallId: p.toolCallId }
    case 'subagent':   return { kind: 'subagent', agentId: p.agentId }
    case 'permission': return { kind: 'permission', requestId: p.requestId }
    case 'credential': return { kind: 'credential', requestId: p.requestId }
  }
}

function resetAccumulator(acc: TurnAccumulator): void {
  acc.text = ''
  acc.thinking = ''
  acc.tools.length = 0
  acc.agents.length = 0
  acc.permissions.length = 0
  acc.credentials.length = 0
  acc.parts.length = 0
  acc.toolInputs.clear()
  acc.toolRawArgs.clear()
  acc.toolStartTimes.clear()
  acc.pendingAgents.clear()
  acc.pendingPermissions.clear()
  acc.pendingCredentials.clear()
  acc.spawnInputsByAgentId.clear()
}

/**
 * True when the accumulator holds anything worth flushing as a partial
 * turn. Pending maps count too — a tool that started but never finished,
 * or a permission request that never got a response, is signal the user
 * should see.
 */
function accumulatorHasContent(acc: TurnAccumulator): boolean {
  return (
    acc.text.trim().length > 0 ||
    acc.thinking.trim().length > 0 ||
    acc.tools.length > 0 ||
    acc.agents.length > 0 ||
    acc.permissions.length > 0 ||
    acc.credentials.length > 0 ||
    acc.parts.length > 0 ||
    acc.toolInputs.size > 0 ||
    acc.pendingAgents.size > 0 ||
    acc.pendingPermissions.size > 0 ||
    acc.pendingCredentials.size > 0
  )
}


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Enrich permission.request events with zone metadata. */
function enrichEvent(
  event: LoomEvent,
  getLastZoneDecision: (() => ZoneDecision | null) | undefined,
): LoomEvent {
  if (event.type === 'permission.request' && getLastZoneDecision) {
    const zd = getLastZoneDecision()
    if (zd) {
      return {
        ...event,
        zoneLevel: zd.classification.level,
        zoneName: ZONE_LEVEL_NAMES[zd.classification.level],
        explanation: zd.explanation,
      }
    }
  }
  return event
}

// ---------------------------------------------------------------------------
// Internal mutable run state
// ---------------------------------------------------------------------------

interface MutableRun extends ActiveRun {
  status: RunStatus
  lastSeq: number
  turnCount: number
  inputTokens: number
  outputTokens: number
  costUsd: number
  /** Latest in-band `error` event message seen during the run (BUGS HON-1). */
  errorEventMessage?: string
  /** Set inside consumeLoop so drainAll can await it. */
  donePromise?: Promise<RunResult>
}
