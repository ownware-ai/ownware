/**
 * TeamScheduler — the deterministic kernel (L5, doc 11 Part 2).
 *
 * Code does the bookkeeping; the LLM is consulted only at judgment
 * points. The scheduler:
 *
 *   1. Watches the board (ticked on every board mutation — the tools
 *      call `onBoardChange`, never the model).
 *   2. Dispatches ready work tasks to member sessions — up to
 *      MAX_CONCURRENT_MEMBERS in parallel (S2), one session per
 *      member, skipping co-scheduling of overlapping resourceHints.
 *      The lease gate (lease-gate.ts) makes collisions impossible
 *      regardless of what dispatch decides.
 *   3. Unblocks tasks whose open questions were answered, notifies
 *      members when a denied resource frees, and reclaims tasks whose
 *      member session died (liveness sweep).
 *   4. Wakes the Conductor LLM only at judgment points: unassigned
 *      work, a failed task, an open question, or a dry board.
 *
 * Wake-loop guard: identical wake reasons against an unchanged board
 * escalate (firmer wording), and after MAX_WAKE_ATTEMPTS the run is
 * failed honestly instead of burning tokens forever (Principle 1 —
 * no silent spinning).
 *
 * Member sessions are ordinary loom Sessions assembled from the
 * member's own profile + the three injected team tools + the digest
 * (via ReminderInjector / hook.context). Every member event is
 * persisted through the EventIngestor under agent id `member:<slug>`,
 * so the existing multi-agent UI substrate renders the run.
 */

import {
  Session,
  ReminderInjector,
  createDefaultRegistry,
  mergeConfig,
  type LoomEvent,
  type Tool,
} from '@ownware/loom'
import { classifyError } from '../errors/classify.js'
import { assembleAgent } from '../profile/assembler.js'
import type { ProfileRegistry } from '../profile/registry.js'
import type { GatewayState } from '../gateway/state.js'
import type { SessionRunner } from '../gateway/session-runner.js'
import type { ConnectorToolProvider } from '../connector/providers/types.js'
import { conductorProfileId } from './conductor.js'
import { createMemberTeamTools } from './member-tools.js'
import { applyMemberToolPolicy } from './member-policy.js'
import { withTeamConnectors } from './member-connectors.js'
import { renderReferenceSection } from './references.js'
import { wrapMemberToolsWithLeaseGate } from './lease-gate.js'
import {
  VERIFIER_SLUG,
  VERIFY_ROUND_CAP,
  buildVerifierProfile,
  buildVerifierPrompt,
} from './verifier.js'
import type { TeamEventBus } from './event-bus.js'
import { renderBoardForConductor, renderDigest } from './digest.js'
import {
  OPEN_TASK_STATUSES,
  TEAM_TASK_STATUSES,
  type Team,
  type TeamRun,
  type TeamRunReceipt,
  type TeamTask,
  type TeamTaskStatus,
} from './schema.js'
import type { TeamStore } from './store.js'

const MAX_WAKE_ATTEMPTS = 3
const WAKE_RETRY_MS = 2_000
/** Stop retrying a pending wake after this long — the run is stuck. */
const WAKE_RETRY_DEADLINE_MS = 30 * 60_000
/** S2: concurrent member sessions per run. */
const MAX_CONCURRENT_MEMBERS = 3
/** Liveness sweep cadence — catches orphaned 'active' tasks in-process. */
const LIVENESS_SWEEP_MS = 30_000

/**
 * Advisory hint-overlap check for co-scheduling avoidance. Hints are
 * paths or path globs ("src/styles/**"); two hints overlap when one
 * normalized prefix contains the other. Heuristic only — the lease
 * gate makes collisions impossible regardless (plan = heuristic,
 * gate = guarantee).
 */
export function hintsOverlap(a: readonly string[], b: readonly string[]): boolean {
  const norm = (h: string): string =>
    h.replace(/\/?\*+$/, '').replace(/\/+$/, '') || '/'
  for (const ha of a) {
    for (const hb of b) {
      const na = norm(ha)
      const nb = norm(hb)
      if (na === nb || na.startsWith(`${nb}/`) || nb.startsWith(`${na}/`)) return true
    }
  }
  return false
}

export type WakeReason =
  | 'unassigned-work'
  | 'task-failed'
  | 'question'
  | 'board-dry'
  | 'budget-exceeded'
  | 'verify-cap'

export interface TeamSchedulerDeps {
  readonly store: TeamStore
  readonly state: GatewayState
  readonly registry: ProfileRegistry
  readonly runner: SessionRunner
  readonly toolProviders: readonly ConnectorToolProvider[]
  /** Invalidation-hint bus (rides the multiplexed /api/v1/events SSE). */
  readonly events: TeamEventBus
  /**
   * Provided by the team module: guarantees the conductor session for
   * this run exists in gateway state (creating it from checkpoint when
   * the gateway restarted mid-run).
   */
  readonly ensureConductorSession: (run: TeamRun) => Promise<void>
}

interface ActiveMemberWork {
  readonly session: Session
  readonly injector: ReminderInjector
  readonly memberSlug: string
  readonly taskId: string
}

interface WakeTracker {
  key: string
  boardVersion: string
  attempts: number
}

export class TeamScheduler {
  /** Per-run re-entrancy guard + coalescing for tick. */
  private readonly ticking = new Set<string>()
  private readonly tickQueued = new Set<string>()
  /** Active member sessions, keyed by task id. */
  private readonly activeWork = new Map<string, ActiveMemberWork>()
  /** Pending conductor wakes (conductor was busy), keyed by run id. */
  private readonly pendingWakes = new Map<string, { reasons: Set<WakeReason>; since: number }>()
  private readonly wakeRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly wakeTrackers = new Map<string, WakeTracker>()
  /** Last digest text delivered per (runId, memberSlug) — dedupe. */
  private readonly lastDigests = new Map<string, string>()
  /**
   * Members waiting on a denied resource, per run — notified via their
   * digest channel when the key frees (denial option (c)).
   */
  private readonly leaseWaiters = new Map<string, Map<string, Set<string>>>()
  /** In-process orphan-reclaim counter per task (2nd reclaim → failed). */
  private readonly reclaimAttempts = new Map<string, number>()
  /**
   * Runs whose Conductor relayed something to the USER via ask_user —
   * wakes are suppressed (re-waking while the user types would burn
   * the wake budget and could fail the run mid-conversation). Value =
   * the thread's messageCount at suppression time; the liveness sweep
   * clears the entry when a new user message lands, and any board
   * change clears it immediately (the conductor acted).
   */
  private readonly awaitingUser = new Map<string, number>()
  private livenessTimer: ReturnType<typeof setInterval> | null = null
  private stopped = false

  constructor(private readonly deps: TeamSchedulerDeps) {}

  /**
   * Schedule a tick on the next macrotask. Board mutations happen
   * synchronously inside tool execute() calls — deferring keeps the
   * tool result path free of session-spawning work.
   */
  tickSoon(runId: string): void {
    if (this.stopped) return
    setImmediate(() => {
      void this.tick(runId)
    })
  }

  /** Refresh digests for every member currently working this run. */
  refreshDigests(runId: string): void {
    const run = this.deps.store.getRun(runId)
    if (!run) return
    const team = this.deps.store.getTeam(run.teamId)
    if (!team) return
    const tasks = this.deps.store.listTasks(runId)
    for (const work of this.activeWork.values()) {
      const task = this.deps.store.getTask(work.taskId)
      if (!task || task.runId !== runId) continue
      const digest = renderDigest(team, run, tasks, work.memberSlug, this.deps.store.listLeases(runId))
      const key = `${runId}:${work.memberSlug}`
      if (this.lastDigests.get(key) === digest) continue
      this.lastDigests.set(key, digest)
      work.injector.emit({ type: 'hook.context', hookName: 'team-digest', context: digest })
    }
  }

  /**
   * One deterministic pass over the board: unblock → dispatch → judge.
   * Serialized per run; a tick arriving mid-tick coalesces into one
   * follow-up pass.
   */
  async tick(runId: string): Promise<void> {
    if (this.stopped) return
    if (this.ticking.has(runId)) {
      this.tickQueued.add(runId)
      return
    }
    this.ticking.add(runId)
    try {
      await this.tickOnce(runId)
    } catch (err) {
      const classified = classifyError(err)
      console.error(`[team] tick failed for run ${runId} (${classified.category}):`, classified.message)
    } finally {
      this.ticking.delete(runId)
      if (this.tickQueued.delete(runId)) {
        this.tickSoon(runId)
      }
    }
  }

  private async tickOnce(runId: string): Promise<void> {
    const { store } = this.deps
    const run = store.getRun(runId)
    if (!run || run.status !== 'active') return
    const team = store.getTeam(run.teamId)
    if (!team) {
      console.error(`[team] run ${runId} references missing team ${run.teamId}; failing run`)
      this.failRun(run, 'Team configuration disappeared mid-run.')
      return
    }

    let tasks = store.listTasks(runId)
    const goal = tasks.find((t) => t.kind === 'goal')
    if (!goal) return // still crystallizing — nothing to schedule yet

    // 1. Unblock: a blocked task whose questions are all settled goes
    //    back to ready (it re-dispatches with the answers in its brief).
    for (const task of tasks) {
      if (task.status !== 'blocked') continue
      const openQuestions = tasks.filter(
        (q) => q.kind === 'question' && q.parentId === task.id && OPEN_TASK_STATUSES.has(q.status),
      )
      if (openQuestions.length === 0) {
        store.setTaskStatus(task.id, 'ready')
      }
    }
    tasks = store.listTasks(runId)

    // 1b. Notify members waiting on freed resources ("(c) wait —
    //     you'll be notified"). Runs every tick; freed = no longer
    //     in the lease table.
    this.notifyFreedResources(run)

    // 1c. Budget gate (scenario 8: pause with a decision, never a
    //     silent death). Effective spend = the thread's cost (every
    //     conductor turn) + the run's cost (member + verifier
    //     sessions). Over the cap: no new dispatch, no new verify
    //     round — wake the Conductor to take it to the user. Members
    //     already mid-task finish their current work.
    const spendUsd = run.costUsd + (this.deps.state.getThread(run.threadId)?.totalCost ?? 0)
    if (run.maxCostUsd !== null && spendUsd >= run.maxCostUsd) {
      await this.requestWake(team, run, new Set<WakeReason>(['budget-exceeded']))
      return
    }

    // 1d. Dispatch a pending verify round (filed by the settled-board
    //     branch below; by construction nothing else is open then).
    const pendingVerify = tasks.find((t) => t.kind === 'verify' && t.status === 'ready')
    if (pendingVerify) {
      const updated = store.setTaskStatus(pendingVerify.id, 'active')
      void this.runVerifierTask(team, run, updated)
      this.ensureLivenessSweep()
      return
    }

    // 2. Dispatch — S2: parallel up to MAX_CONCURRENT_MEMBERS.
    //    A task is dispatchable when it's ready work with an owner,
    //    its deps are settled, its OWNER is idle (one session per
    //    member), and its resourceHints don't overlap an active
    //    task's hints (the anti-co-scheduling heuristic — the lease
    //    gate stays the guarantee regardless).
    let activeWorkTasks = tasks.filter((t) => t.kind === 'work' && t.status === 'active')
    const doneOrSettled = (id: string): boolean => {
      const dep = tasks.find((t) => t.id === id)
      // A cancelled dependency no longer gates — the Conductor
      // restructures if its output was genuinely required.
      return dep !== undefined && (dep.status === 'done' || dep.status === 'cancelled')
    }
    let dispatched = false
    for (const candidate of tasks) {
      if (activeWorkTasks.length >= MAX_CONCURRENT_MEMBERS) break
      if (candidate.kind !== 'work' || candidate.status !== 'ready') continue
      if (candidate.owner === null) continue
      if (!candidate.dependsOn.every(doneOrSettled)) continue
      if (activeWorkTasks.some((a) => a.owner === candidate.owner)) continue
      if (activeWorkTasks.some((a) => hintsOverlap(a.resourceHints, candidate.resourceHints))) continue
      const updated = store.setTaskStatus(candidate.id, 'active')
      activeWorkTasks = [...activeWorkTasks, updated]
      dispatched = true
      // Fire-and-forget: each member loop runs in the background and
      // re-ticks on completion. Errors are handled inside.
      void this.runMemberTask(team, run, updated)
    }
    if (dispatched || activeWorkTasks.length > 0) {
      this.ensureLivenessSweep()
      return // members are working; judgment re-evaluated when the board moves
    }

    // 3. Judgment points → wake the Conductor (L5).
    const reasons = new Set<WakeReason>()
    if (tasks.some((t) => t.kind === 'work' && t.status === 'ready' && t.owner === null)) {
      reasons.add('unassigned-work')
    }
    // Failed VERIFY rounds are kernel business — the settled branch
    // retries them up to the cap; the Conductor can't fix a verifier.
    if (tasks.some((t) => t.status === 'failed' && t.kind !== 'verify')) {
      reasons.add('task-failed')
    }
    if (tasks.some((t) => t.kind === 'question' && t.status === 'ready')) {
      reasons.add('question')
    }
    const openBeyondGoal = tasks.filter((t) => t.kind !== 'goal' && OPEN_TASK_STATUSES.has(t.status))
    if (reasons.size === 0 && openBeyondGoal.length === 0) {
      // The board settled. Termination is a VERDICT, not a feeling
      // (L9): done ⇔ settled AND the latest verify passed with no work
      // filed after it. Otherwise the kernel files the next verify
      // round itself — the Conductor is never asked to remember to.
      const doneWork = tasks.filter((t) => t.kind === 'work' && t.status === 'done')
      const verifies = tasks.filter((t) => t.kind === 'verify')
      const latestVerify = verifies[verifies.length - 1]
      const verifiedClean =
        latestVerify !== undefined &&
        latestVerify.status === 'done' &&
        !tasks.some((t) => t.kind === 'work' && t.createdAt > latestVerify.createdAt)
      const needsVerify = doneWork.length > 0 && !verifiedClean

      if (needsVerify) {
        if (verifies.length >= VERIFY_ROUND_CAP) {
          // Don't polish forever — take the remaining gaps to the user.
          reasons.add('verify-cap')
        } else {
          const goal = tasks.find((t) => t.kind === 'goal')
          store.insertTask(runId, {
            kind: 'verify',
            title: `Verification round ${verifies.length + 1}`,
            brief: goal ? `Verify against: ${goal.title}` : 'Verify the completed work.',
            owner: VERIFIER_SLUG,
            filedBy: 'kernel',
            status: 'ready',
          })
          this.tickSoon(runId) // the 1d branch dispatches it
          return
        }
      } else {
        reasons.add('board-dry')
      }
    }
    if (reasons.size > 0) {
      await this.requestWake(team, run, reasons)
    }
  }

  // ── Conductor wakes ──────────────────────────────────────────────

  private async requestWake(team: Team, run: TeamRun, reasons: Set<WakeReason>): Promise<void> {
    const { runner, store } = this.deps

    // The Conductor relayed something to the user (ask_user) and is
    // waiting for a reply — do not wake it again. The liveness sweep
    // clears this when a new user message lands; any board change
    // clears it immediately.
    if (this.awaitingUser.has(run.id)) return

    // Loop guard: identical reasons against an unchanged board burn
    // tokens without progress. Escalate wording, then fail honestly.
    const tasks = store.listTasks(run.id)
    const boardVersion = tasks.map((t) => `${t.id}:${t.status}:${t.updatedAt}`).join('|')
    const key = [...reasons].sort().join(',')
    const tracker = this.wakeTrackers.get(run.id)
    let attempts = 1
    if (tracker && tracker.key === key && tracker.boardVersion === boardVersion) {
      attempts = tracker.attempts + 1
    }
    this.wakeTrackers.set(run.id, { key, boardVersion, attempts })
    if (attempts > MAX_WAKE_ATTEMPTS) {
      console.error(
        `[team] run ${run.id}: conductor failed to act on [${key}] after ${MAX_WAKE_ATTEMPTS} wakes; failing run`,
      )
      this.failRun(
        run,
        `The Conductor was woken ${MAX_WAKE_ATTEMPTS} times for [${key}] without resolving it. The run was stopped to avoid spinning.`,
      )
      return
    }

    if (runner.isRunning(run.threadId)) {
      // Conductor is mid-turn (e.g. talking to the user). Queue and
      // retry on a short timer — bounded, cleared on delivery.
      const pending = this.pendingWakes.get(run.id)
      if (pending) {
        for (const r of reasons) pending.reasons.add(r)
      } else {
        this.pendingWakes.set(run.id, { reasons: new Set(reasons), since: Date.now() })
      }
      this.scheduleWakeRetry(run.id)
      return
    }

    await this.deliverWake(team, run, reasons, attempts)
  }

  private scheduleWakeRetry(runId: string): void {
    if (this.stopped || this.wakeRetryTimers.has(runId)) return
    const timer = setTimeout(() => {
      this.wakeRetryTimers.delete(runId)
      const pending = this.pendingWakes.get(runId)
      if (!pending) return
      if (Date.now() - pending.since > WAKE_RETRY_DEADLINE_MS) {
        this.pendingWakes.delete(runId)
        const run = this.deps.store.getRun(runId)
        if (run && run.status === 'active') {
          console.error(`[team] run ${runId}: pending wake undeliverable for 30m; failing run`)
          this.failRun(run, 'The Conductor stayed busy for 30 minutes; the run was stopped to avoid a silent stall.')
        }
        return
      }
      const run = this.deps.store.getRun(runId)
      if (!run || run.status !== 'active') {
        this.pendingWakes.delete(runId)
        return
      }
      if (this.deps.runner.isRunning(run.threadId)) {
        this.scheduleWakeRetry(runId)
        return
      }
      const team = this.deps.store.getTeam(run.teamId)
      this.pendingWakes.delete(runId)
      if (team) {
        void this.deliverWake(team, run, pending.reasons, 1)
      }
    }, WAKE_RETRY_MS)
    this.wakeRetryTimers.set(runId, timer)
  }

  private async deliverWake(
    team: Team,
    run: TeamRun,
    reasons: Set<WakeReason>,
    attempt: number,
  ): Promise<void> {
    const { state, registry, runner } = this.deps
    if (this.stopped) return

    try {
      await this.deps.ensureConductorSession(run)
      const companions = state.getSessionCompanions(run.threadId)
      const session = state.getSession(run.threadId)
      if (!companions || !session) {
        throw new Error(`Conductor session for thread ${run.threadId} could not be ensured`)
      }
      state.setRuntime(run.threadId, {
        session,
        hitl: companions.hitl,
        zoneManager: companions.zoneManager,
        lastZoneDecision: companions.getLastZoneDecision,
      })
      state.updateThread(run.threadId, { status: 'active' })

      const profileId = conductorProfileId(team.id)
      const profile = await registry.get(profileId)
      const prompt = this.buildWakePrompt(team, run, reasons, attempt)

      try {
        state.eventIngestor.ingestParentEvent(run.threadId, {
          type: 'team.wake',
          runId: run.id,
          reasons: [...reasons],
          attempt,
          timestamp: Date.now(),
        } as unknown as LoomEvent)
      } catch {
        // Observability only — the wake itself is the load-bearing part.
      }

      // Snapshot the root stream's cursor BEFORE the wake so we can
      // tell afterwards whether the Conductor relayed to the user.
      const sinceSeq = state.getAgentEventMaxSeq(run.threadId, 'root')

      let handle
      try {
        handle = runner.start({
          threadId: run.threadId,
          profileId,
          model: profile.config.model,
          prompt,
        })
      } catch (startErr) {
        // Benign race: a user message slipped in between the
        // isRunning() check and start(). Re-queue, don't fail the run.
        if (startErr instanceof Error && startErr.message.includes('already has an active run')) {
          const pending = this.pendingWakes.get(run.id)
          if (pending) {
            for (const r of reasons) pending.reasons.add(r)
          } else {
            this.pendingWakes.set(run.id, { reasons: new Set(reasons), since: Date.now() })
          }
          this.scheduleWakeRetry(run.id)
          return
        }
        throw startErr
      }
      void handle.done.finally(() => {
        // Did this wake end with the Conductor asking the USER
        // something (ask_user)? Then the run is waiting on a human —
        // suppress further wakes until they reply (the latent S1 bug:
        // re-waking three times while the user typed would fail the
        // run mid-conversation).
        try {
          const events = state.listAgentEvents({
            threadId: run.threadId,
            agentId: 'root',
            since: sinceSeq,
          })
          const askedUser = events.some((e) => {
            if (e.type !== 'tool.call.start') return false
            const payload = e.payload as { toolName?: string }
            return payload.toolName === 'ask_user'
          })
          if (askedUser) {
            const thread = state.getThread(run.threadId)
            this.awaitingUser.set(run.id, thread?.messageCount ?? 0)
            this.ensureLivenessSweep()
          }
        } catch (err) {
          console.error('[team] post-wake ask_user scan failed:', err)
        }
        this.tickSoon(run.id)
      })
    } catch (err) {
      const classified = classifyError(err)
      console.error(`[team] conductor wake failed for run ${run.id} (${classified.category}):`, classified.message)
      this.failRun(run, `The Conductor could not be woken: ${classified.message}`)
    }
  }

  private buildWakePrompt(
    team: Team,
    run: TeamRun,
    reasons: Set<WakeReason>,
    attempt: number,
  ): string {
    const { store } = this.deps
    const tasks = store.listTasks(run.id)
    const lines: string[] = ['[TEAM EVENT] The kernel woke you. Pending judgment calls:']
    if (reasons.has('unassigned-work')) {
      const unassigned = tasks.filter((t) => t.kind === 'work' && t.status === 'ready' && t.owner === null)
      lines.push(
        `- Unassigned work: ${unassigned.map((t) => `T${t.seq} "${t.title}" (filed by ${t.filedBy})`).join(' · ')} — assign an owner or cancel.`,
      )
    }
    if (reasons.has('task-failed')) {
      const failed = tasks.filter((t) => t.status === 'failed')
      lines.push(
        `- Failed: ${failed
          .map((t) => `T${t.seq} "${t.title}" (${t.blockedReason ?? 'no reason recorded'})`)
          .join(' · ')} — re-assign (this re-queues it), refile sharper, or surface to the user.`,
      )
    }
    if (reasons.has('question')) {
      const questions = tasks.filter((t) => t.kind === 'question' && t.status === 'ready')
      lines.push(
        `- Open question(s): ${questions
          .map((t) => `T${t.seq} from ${t.filedBy}: "${t.brief.split('\n')[0] ?? t.title}"`)
          .join(' · ')} — answer with board_write answer_question, or relay to the user with ask_user.`,
      )
    }
    if (reasons.has('budget-exceeded')) {
      const spend = run.costUsd + (this.deps.state.getThread(run.threadId)?.totalCost ?? 0)
      lines.push(
        `- BUDGET EXCEEDED: $${spend.toFixed(2)} spent of the $${(run.maxCostUsd ?? 0).toFixed(2)} cap. Work is paused (running members finish their current task; nothing new starts). Take it to the user with ask_user: offer (1) raise the budget to a concrete number, or (2) wrap up now. If they approve a raise, call board_write set_budget with their number. If they wrap up, cancel the open tasks with reason "budget" and call finish_run with an honest partial summary.`,
      )
    }
    if (reasons.has('verify-cap')) {
      lines.push(
        `- VERIFICATION CAP: the verifier has run its maximum ${VERIFY_ROUND_CAP} rounds and gaps may remain (see the board for the latest verify verdict). Do not spin further. Either take the remaining gaps to the user with ask_user, or call finish_run with a summary that names honestly what passed and what did not.`,
      )
    }
    if (reasons.has('board-dry')) {
      lines.push(
        '- The board is dry and the latest verification passed clean. Check the results against the goal with check_status; if the goal is genuinely met, call finish_run with a user-facing summary. If something is missing, file the gap as new tasks.',
      )
    }
    if (attempt > 1) {
      lines.push(
        `This is wake ${attempt} of ${MAX_WAKE_ATTEMPTS} for the SAME unresolved situation — you must act with your tools THIS turn (the run is stopped after ${MAX_WAKE_ATTEMPTS}).`,
      )
    }
    lines.push('', 'Current board:', renderBoardForConductor(team, run, tasks, store.listLeases(run.id)))
    return lines.join('\n')
  }

  // ── Member execution ─────────────────────────────────────────────

  private async runMemberTask(team: Team, run: TeamRun, task: TeamTask): Promise<void> {
    const { store, state, registry, toolProviders } = this.deps
    const member = team.members.find((m) => m.slug === task.owner)
    if (!member) {
      store.setTaskStatus(task.id, 'failed', `Owner "${task.owner}" is not on the roster.`)
      this.tickSoon(run.id)
      return
    }

    const agentId = `member:${member.slug}`
    let session: Session | null = null
    try {
      const profile = await registry.get(member.profileId)
      const workspacePath = run.workspaceId !== null
        ? state.getWorkspace(run.workspaceId)?.path ?? null
        : null

      // In-module profile augmentation (no shared-assembler changes,
      // preserves delete-cleanly): per-team model override + team-granted
      // Composio toolkits merged into a COPY of the member's profile.
      const memberProfile = withTeamConnectors(
        member.model !== undefined && member.model !== profile.config.model
          ? { ...profile, config: { ...profile.config, model: member.model } }
          : profile,
        team.composioToolkits,
      )
      const assembled = await assembleAgent(memberProfile, {
        toolProviders,
        workspacePath,
      })

      const injector = new ReminderInjector(createDefaultRegistry())
      const teamTools: Tool[] = createMemberTeamTools({
        store,
        runId: run.id,
        taskId: task.id,
        memberSlug: member.slug,
        onBoardChange: () => this.onBoardChange(run.id),
      })

      // Member capability (B3a): autonomy + restricts applied as tool
      // ACCESS at the security boundary BEFORE the lease gate. A
      // read-only member's mutating tools are simply absent — the lease
      // gate then has nothing to wrap for it. permissionMode stays
      // 'auto' (a headless run can't answer an 'ask').
      const policiedTools = applyMemberToolPolicy(assembled.tools, member)

      // The lease gate (S2): profile tools wrapped with atomic
      // check-and-acquire on mutating calls + the heartbeat on every
      // call. Team tools stay unwrapped — board writes are their own
      // serialized substrate.
      const gatedProfileTools = wrapMemberToolsWithLeaseGate(policiedTools, {
        store,
        runId: run.id,
        taskId: task.id,
        memberSlug: member.slug,
        workspacePath: workspacePath ?? process.cwd(),
        onDenied: (resourceKey) => this.recordLeaseWaiter(run.id, resourceKey, member.slug),
      })

      const config = mergeConfig(assembled.config, {
        ...(workspacePath !== null ? { workspacePath } : {}),
        sessionId: `team:${run.id}:${task.id}:${Date.now()}`,
      })

      session = new Session({
        config,
        provider: assembled.provider,
        tools: [...gatedProfileTools, ...teamTools],
        checkpoint: assembled.checkpointStore,
        reminders: injector,
        // S1: members run permission-auto. Zone enforcement + the lease
        // gate land together at the checkPermission seam in S2 (the
        // gate wraps zones; wiring them apart would mean re-plumbing
        // this exact spot twice). BUILD-BOARD decision B6.
        permissionMode: 'auto',
      })

      this.activeWork.set(task.id, { session, injector, memberSlug: member.slug, taskId: task.id })

      try {
        state.eventIngestor.ingestParentEvent(run.threadId, {
          type: 'team.handoff',
          runId: run.id,
          taskSeq: task.seq,
          taskTitle: task.title,
          member: member.slug,
          role: member.role,
          timestamp: Date.now(),
        } as unknown as LoomEvent)
      } catch {
        // Observability only.
      }

      const prompt = this.buildHandoffPrompt(team, run, task, member.slug)
      await this.drainMemberTurn(run, agentId, session.submitMessage(prompt))

      // Gateway shutdown aborted this member: stand down without
      // touching the (already-closing) DB. The next boot's resume path
      // re-queues the task from the board.
      if (this.stopped) return

      // End-of-turn verdicts (the kernel writes status, never the model):
      let fresh = store.getTask(task.id)
      if (fresh && fresh.status === 'active') {
        const tasksNow = store.listTasks(run.id)
        const openQuestionFromTask = tasksNow.find(
          (q) => q.kind === 'question' && q.parentId === task.id && OPEN_TASK_STATUSES.has(q.status),
        )
        if (openQuestionFromTask) {
          store.setTaskStatus(
            task.id,
            'blocked',
            `Waiting on T${openQuestionFromTask.seq}: ${openQuestionFromTask.title}`,
          )
        } else {
          // One nudge — models occasionally stop without the closing
          // call. A second silence is an honest failure.
          await this.drainMemberTurn(
            run,
            agentId,
            session.submitMessage(
              'You ended your turn without calling complete_task (or ask_team / file_task). ' +
                'If your done-criteria are met, call complete_task now with the handoff summary. ' +
                'If you are blocked, call ask_team. Do not do anything else.',
            ),
          )
          fresh = store.getTask(task.id)
          if (fresh && fresh.status === 'active') {
            store.setTaskStatus(task.id, 'failed', 'Member ended its session without completing the task.')
          }
        }
      }
    } catch (err) {
      if (this.stopped) return // shutdown abort — not a task failure
      const classified = classifyError(err)
      console.error(
        `[team] member ${member.slug} failed on T${task.seq} (${classified.category}):`,
        classified.message,
      )
      const fresh = store.getTask(task.id)
      if (fresh && fresh.status === 'active') {
        store.setTaskStatus(task.id, 'failed', `${classified.category}: ${classified.message}`)
      }
    } finally {
      if (session && !this.stopped) {
        store.addRunCost(run.id, session.getState().totalUsage.costUsd)
      }
      this.activeWork.delete(task.id)
      this.lastDigests.delete(`${run.id}:${member.slug}`)
      this.reclaimAttempts.delete(task.id)
      this.tickSoon(run.id)
    }
  }

  /**
   * Run one verification round — a fresh-context skeptic session.
   * Mirrors the member runner minus everything that would contaminate
   * fresh eyes: no digest, no handoff inputs, no charter. A verify
   * session that ends without a verdict is nudged once, then failed —
   * a failed verify round retries automatically via the settled-board
   * branch (it counts toward the round cap; never wakes the Conductor).
   */
  private async runVerifierTask(team: Team, run: TeamRun, task: TeamTask): Promise<void> {
    const { store, state } = this.deps
    const agentId = `member:${VERIFIER_SLUG}`
    let session: Session | null = null
    try {
      const workspacePath = run.workspaceId !== null
        ? state.getWorkspace(run.workspaceId)?.path ?? null
        : null
      const profile = buildVerifierProfile(team, run)
      const assembled = await assembleAgent(profile, { workspacePath })
      const teamTools: Tool[] = createMemberTeamTools({
        store,
        runId: run.id,
        taskId: task.id,
        memberSlug: VERIFIER_SLUG,
        onBoardChange: () => this.onBoardChange(run.id),
      })
      const config = mergeConfig(assembled.config, {
        ...(workspacePath !== null ? { workspacePath } : {}),
        sessionId: `team:${run.id}:${task.id}:${Date.now()}`,
      })
      session = new Session({
        config,
        provider: assembled.provider,
        tools: [...assembled.tools, ...teamTools],
        checkpoint: assembled.checkpointStore,
        permissionMode: 'auto',
      })
      this.activeWork.set(task.id, {
        session,
        injector: new ReminderInjector(createDefaultRegistry()),
        memberSlug: VERIFIER_SLUG,
        taskId: task.id,
      })

      try {
        state.eventIngestor.ingestParentEvent(run.threadId, {
          type: 'team.handoff',
          runId: run.id,
          taskSeq: task.seq,
          taskTitle: task.title,
          member: VERIFIER_SLUG,
          role: 'Verification',
          timestamp: Date.now(),
        } as unknown as LoomEvent)
      } catch {
        // Observability only.
      }

      const tasks = store.listTasks(run.id)
      const goal = tasks.find((t) => t.kind === 'goal')
      if (!goal) throw new Error('Verify round dispatched with no goal on the board')
      const round = tasks.filter((t) => t.kind === 'verify').length
      const prompt = buildVerifierPrompt(goal, tasks, round)
      await this.drainMemberTurn(run, agentId, session.submitMessage(prompt))

      if (this.stopped) return
      let fresh = store.getTask(task.id)
      if (fresh && fresh.status === 'active') {
        await this.drainMemberTurn(
          run,
          agentId,
          session.submitMessage(
            'You ended without delivering a verdict. Call complete_task now — "PASS — …" if you filed zero gap tasks, "FAIL — …" otherwise. Nothing else.',
          ),
        )
        fresh = store.getTask(task.id)
        if (fresh && fresh.status === 'active') {
          store.setTaskStatus(task.id, 'failed', 'Verifier ended its session without a verdict.')
        }
      }
    } catch (err) {
      if (this.stopped) return
      const classified = classifyError(err)
      console.error(`[team] verifier failed on T${task.seq} (${classified.category}):`, classified.message)
      const fresh = store.getTask(task.id)
      if (fresh && fresh.status === 'active') {
        store.setTaskStatus(task.id, 'failed', `${classified.category}: ${classified.message}`)
      }
    } finally {
      if (session && !this.stopped) {
        store.addRunCost(run.id, session.getState().totalUsage.costUsd)
      }
      this.activeWork.delete(task.id)
      this.reclaimAttempts.delete(task.id)
      this.tickSoon(run.id)
    }
  }

  private async drainMemberTurn(
    run: TeamRun,
    agentId: string,
    gen: AsyncGenerator<LoomEvent, unknown>,
  ): Promise<void> {
    const { state } = this.deps
    let next = await gen.next()
    while (!next.done) {
      const event = next.value
      const isRecoverableError =
        event.type === 'error' && (event as { recoverable?: boolean }).recoverable === true
      if (!isRecoverableError) {
        try {
          state.eventIngestor.ingestSubagentEvent(run.threadId, agentId, event)
        } catch (err) {
          console.error(`[team] member event ingest failed (${agentId}):`, err)
        }
      }
      next = await gen.next()
    }
  }

  private buildHandoffPrompt(team: Team, run: TeamRun, task: TeamTask, memberSlug: string): string {
    const { store } = this.deps
    const tasks = store.listTasks(run.id)
    const goal = tasks.find((t) => t.kind === 'goal')
    const member = team.members.find((m) => m.slug === memberSlug)

    const inputs = task.dependsOn
      .map((id) => tasks.find((t) => t.id === id))
      .filter((t): t is TeamTask => t !== undefined && t.result !== null)
      .map((t) => `- T${t.seq} "${t.title}" → ${t.result}`)

    const answers = tasks
      .filter((q) => q.kind === 'question' && q.parentId === task.id && q.status === 'done' && q.result !== null)
      .map((q) => `- You asked: "${q.title}" → Answer: ${q.result}`)

    const lines = [
      `[TEAM HANDOFF] You are **${memberSlug}** (${member?.role ?? 'member'}) on team "${team.displayName}".`,
      goal ? `Team goal: ${goal.title} — ${goal.doneCriteria.split('\n')[0] ?? ''}` : '',
      member?.instructions ? `Your standing instructions on this team: ${member.instructions}` : '',
      renderReferenceSection(team.references),
      '',
      `Your task — T${task.seq}: ${task.title}`,
      `Brief: ${task.brief}`,
      `Done means: ${task.doneCriteria}`,
      task.deliverables.length > 0 ? `Deliverables: ${task.deliverables.join(', ')}` : '',
      inputs.length > 0 ? `\nInputs from completed teammate work:\n${inputs.join('\n')}` : '',
      answers.length > 0 ? `\nAnswers to your earlier questions:\n${answers.join('\n')}` : '',
      '',
      'Team rules:',
      '- Do the task yourself, in this workspace, with your own tools.',
      '- Finish by calling `complete_task` with a concise handoff summary (≤120 words) naming every artifact path a teammate needs. This is mandatory — work without complete_task does not count.',
      '- If you discover work outside your task, file it with `file_task` and keep going.',
      '- If a question fully blocks you, call `ask_team`, then end your turn.',
      '',
      'Current team digest:',
      renderDigest(team, run, tasks, memberSlug, store.listLeases(run.id)),
    ]
    return lines.filter((l) => l !== '').join('\n')
  }

  // ── Leases: waiters + liveness (S2) ──────────────────────────────

  private recordLeaseWaiter(runId: string, resourceKey: string, memberSlug: string): void {
    let byKey = this.leaseWaiters.get(runId)
    if (!byKey) {
      byKey = new Map()
      this.leaseWaiters.set(runId, byKey)
    }
    let slugs = byKey.get(resourceKey)
    if (!slugs) {
      slugs = new Set()
      byKey.set(resourceKey, slugs)
    }
    slugs.add(memberSlug)
  }

  /**
   * Denial option (c) made real: when a previously-held resource is no
   * longer leased, every member that was denied it gets a digest-channel
   * note to retry. Waiters whose sessions already ended are dropped
   * silently — their task either completed without the resource or
   * will be re-briefed on re-dispatch.
   */
  private notifyFreedResources(run: TeamRun): void {
    const byKey = this.leaseWaiters.get(run.id)
    if (!byKey || byKey.size === 0) return
    const held = new Set(this.deps.store.listLeases(run.id).map((l) => l.resourceKey))
    for (const [resourceKey, slugs] of byKey) {
      if (held.has(resourceKey)) continue
      byKey.delete(resourceKey)
      for (const slug of slugs) {
        const work = [...this.activeWork.values()].find(
          (w) => w.memberSlug === slug && this.deps.store.getTask(w.taskId)?.runId === run.id,
        )
        if (work) {
          work.injector.emit({
            type: 'hook.context',
            hookName: 'team-resource-freed',
            context: `\`${resourceKey}\` is now free — the hold on it was released. If your task still needs it, retry your write now.`,
          })
        }
      }
    }
    if (byKey.size === 0) this.leaseWaiters.delete(run.id)
  }

  /**
   * In-process liveness: a task stranded in 'active' with no live
   * member session (a code path that died without its finally — which
   * would be a bug, but Principle 1 says the user must not pay for it)
   * is reclaimed to 'ready'. A second reclaim of the same task fails
   * it honestly instead of looping. Cross-process orphans (gateway
   * crash) are handled by resumeRun at boot.
   */
  private ensureLivenessSweep(): void {
    if (this.stopped || this.livenessTimer !== null) return
    this.livenessTimer = setInterval(() => {
      try {
        this.sweepOnce()
      } catch (err) {
        console.error('[team] liveness sweep failed:', err)
      }
    }, LIVENESS_SWEEP_MS)
    // A sweep timer must never hold the gateway process open.
    this.livenessTimer.unref?.()
  }

  private sweepOnce(): void {
    const { store, state } = this.deps
    const activeRuns = store.listActiveRuns()
    let anyActiveWork = false

    // Awaiting-user recheck: a new user message on the thread means
    // the human replied — lift wake suppression and re-judge.
    for (const [runId, messageCountAtAsk] of this.awaitingUser) {
      const run = store.getRun(runId)
      if (!run || run.status !== 'active') {
        this.awaitingUser.delete(runId)
        continue
      }
      const thread = state.getThread(run.threadId)
      if (thread !== undefined && thread.messageCount > messageCountAtAsk) {
        this.awaitingUser.delete(runId)
        this.tickSoon(runId)
      }
    }

    for (const run of activeRuns) {
      for (const task of store.listTasks(run.id)) {
        if (task.kind === 'goal' || task.status !== 'active') continue
        if (this.activeWork.has(task.id)) {
          anyActiveWork = true
          continue
        }
        const attempts = (this.reclaimAttempts.get(task.id) ?? 0) + 1
        this.reclaimAttempts.set(task.id, attempts)
        if (attempts > 1) {
          console.error(`[team] T${task.seq} orphaned twice — failing it for conductor judgment`)
          store.setTaskStatus(task.id, 'failed', 'Member session died twice without completing the task.')
        } else {
          console.error(`[team] T${task.seq} orphaned (no live session) — reclaiming to ready`)
          store.setTaskStatus(task.id, 'ready')
        }
        this.tickSoon(run.id)
      }
    }
    if (
      !anyActiveWork &&
      activeRuns.length === 0 &&
      this.awaitingUser.size === 0 &&
      this.livenessTimer !== null
    ) {
      clearInterval(this.livenessTimer)
      this.livenessTimer = null
    }
  }

  /**
   * Abort one member's in-flight session (ops/UI: "stop this worker").
   * The member-loop's error path marks the task failed with the abort
   * category and wakes the Conductor, whose re-assign re-queues it.
   */
  abortTask(taskId: string, reason: 'user' | 'system' = 'user'): boolean {
    const work = this.activeWork.get(taskId)
    if (!work) return false
    try {
      work.session.abort(reason)
      return true
    } catch {
      return false
    }
  }

  // ── Board-change entry point (called by every team tool) ─────────

  onBoardChange(runId: string): void {
    // (The wake-loop tracker self-resets: its boardVersion is computed
    // from task updatedAt stamps, so any real change restarts the
    // attempt count in requestWake.)
    // The Conductor acted on the board — it is no longer parked on a
    // user question; wakes may flow again.
    this.awaitingUser.delete(runId)
    const run = this.deps.store.getRun(runId)
    if (run) {
      this.deps.events.emit({ scope: 'board', threadId: run.threadId, runId })
      if (run.status !== 'active') {
        // The run reached a terminal state (finish_run) — the
        // directory card's "last run" moved too.
        this.deps.events.emit({ scope: 'teams' })
      }
    }
    this.refreshDigests(runId)
    this.tickSoon(runId)
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  /**
   * Resume after a gateway restart: tasks stranded in 'active' (their
   * member session died with the process) go back to 'ready' and are
   * re-dispatched with a fresh session — the board, results, and
   * artifacts survived on disk; only the in-flight transcript is
   * redone. At-least-once execution, honestly.
   */
  resumeRun(runId: string): void {
    const { store } = this.deps
    const tasks = store.listTasks(runId)
    for (const task of tasks) {
      if (task.kind !== 'goal' && task.status === 'active' && !this.activeWork.has(task.id)) {
        store.setTaskStatus(task.id, 'ready', null)
      }
    }
    this.tickSoon(runId)
  }

  /** Cancel a run: close the board and abort any in-flight member session. */
  cancelRun(runId: string, reason: string): void {
    const { store } = this.deps
    const run = store.getRun(runId)
    if (!run || run.status !== 'active') return
    const tasks = store.listTasks(runId)
    const taskCounts = Object.fromEntries(
      TEAM_TASK_STATUSES.map((s) => [s, tasks.filter((t) => t.status === s).length]),
    ) as Record<TeamTaskStatus, number>
    const receipt: TeamRunReceipt = {
      summary: reason,
      outcome: 'failed',
      taskCounts,
      costUsd: run.costUsd,
      durationMs: Date.now() - new Date(run.createdAt).getTime(),
    }
    store.setRunStatus(runId, 'cancelled', receipt)
    for (const [taskId, work] of this.activeWork) {
      const task = store.getTask(taskId)
      if (task && task.runId === runId) {
        try {
          work.session.abort('user')
        } catch {
          // Session may already be finished — abort is best-effort here.
        }
      }
    }
    this.clearRunTimers(runId)
    this.deps.events.emit({ scope: 'board', threadId: run.threadId, runId })
    this.deps.events.emit({ scope: 'teams' })
  }

  private failRun(run: TeamRun, reason: string): void {
    const { store } = this.deps
    const tasks = store.listTasks(run.id)
    const taskCounts = Object.fromEntries(
      TEAM_TASK_STATUSES.map((s) => [s, tasks.filter((t) => t.status === s).length]),
    ) as Record<TeamTaskStatus, number>
    store.setRunStatus(run.id, 'failed', {
      summary: reason,
      outcome: 'failed',
      taskCounts,
      costUsd: store.getRun(run.id)?.costUsd ?? run.costUsd,
      durationMs: Date.now() - new Date(run.createdAt).getTime(),
    })
    this.clearRunTimers(run.id)
    this.deps.events.emit({ scope: 'board', threadId: run.threadId, runId: run.id })
    this.deps.events.emit({ scope: 'teams' })
  }

  private clearRunTimers(runId: string): void {
    const timer = this.wakeRetryTimers.get(runId)
    if (timer) {
      clearTimeout(timer)
      this.wakeRetryTimers.delete(runId)
    }
    this.pendingWakes.delete(runId)
    this.wakeTrackers.delete(runId)
    this.awaitingUser.delete(runId)
  }

  /** Abort everything — gateway shutdown. */
  shutdown(): void {
    this.stopped = true
    for (const work of this.activeWork.values()) {
      try {
        work.session.abort('system')
      } catch {
        // Already finished — fine.
      }
    }
    for (const timer of this.wakeRetryTimers.values()) {
      clearTimeout(timer)
    }
    this.wakeRetryTimers.clear()
    this.pendingWakes.clear()
    if (this.livenessTimer !== null) {
      clearInterval(this.livenessTimer)
      this.livenessTimer = null
    }
  }
}
