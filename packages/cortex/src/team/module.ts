/**
 * TeamModule — the team vertical's composition root.
 *
 * Constructed once at gateway boot over the shared SQLite handle (the
 * SqliteTaskStore / ConnectorConnectionsStore pattern). Owns:
 *
 *   - the TeamStore + TeamScheduler
 *   - conductor profile registration (in-memory, re-done every boot —
 *     teams are rows, conductors are materialized, never on disk)
 *   - conductor SESSION creation. The session is built here, with the
 *     three board tools appended, and parked in GatewayState BEFORE any
 *     /run hits the thread — run.ts then reuses the cached session
 *     untouched (its `state.getSession(threadId)` branch). This is
 *     what keeps the vertical out of run.ts entirely.
 *   - restart resume: on boot, every active run's conductor session is
 *     rebuilt from its loom file checkpoint, orphaned active tasks go
 *     back to ready, and the scheduler re-dispatches.
 */

import { join } from 'node:path'
import {
  HumanInTheLoop,
  ReminderInjector,
  Session,
  createDefaultRegistry,
  mergeConfig,
  type Message,
} from '@ownware/loom'
import { classifyError } from '../errors/classify.js'
import { assembleAgent } from '../profile/assembler.js'
import type { ProfileRegistry } from '../profile/registry.js'
import type { GatewayState } from '../gateway/state.js'
import type { SessionRunner } from '../gateway/session-runner.js'
import type { ConnectorToolProvider } from '../connector/providers/types.js'
import { asHitlLike, type HITLLike } from '../gateway/hitl-registry.js'
import { CredentialHITL } from '../credential/hitl.js'
import { ThreadCredentialRuntime } from '../credential/runtime.js'
import { credentialVault } from '../connector/credentials/vault.js'
import { conductorProfileId, materializeConductor } from './conductor.js'
import { createConductorTools } from './conductor-tools.js'
import { createTeamEventBus, type TeamEventBus } from './event-bus.js'
import { TeamScheduler } from './scheduler.js'
import { TeamStore } from './store.js'
import type { CreateTeamInput, Team, TeamRun, UpdateTeamInput } from './schema.js'

export interface TeamModuleDeps {
  readonly state: GatewayState
  readonly registry: ProfileRegistry
  readonly runner: SessionRunner
  readonly dataDir: string
  readonly toolProviders?: readonly ConnectorToolProvider[]
}

export class TeamModule {
  readonly store: TeamStore
  readonly scheduler: TeamScheduler
  /** Invalidation hints — folded into the multiplexed /api/v1/events SSE. */
  readonly events: TeamEventBus
  private readonly checkpointDir: string

  constructor(private readonly deps: TeamModuleDeps) {
    this.store = new TeamStore(deps.state.rawDbHandle)
    this.events = createTeamEventBus()
    this.checkpointDir = join(deps.dataDir, 'team-checkpoints')
    this.scheduler = new TeamScheduler({
      store: this.store,
      state: deps.state,
      registry: deps.registry,
      runner: deps.runner,
      toolProviders: deps.toolProviders ?? [],
      events: this.events,
      ensureConductorSession: (run) => this.ensureConductorSession(run),
    })
  }

  /**
   * Boot: register every team's conductor profile (in-memory
   * registrations don't survive restarts) and resume active runs.
   */
  async boot(): Promise<void> {
    for (const team of this.store.listTeams()) {
      this.registerConductor(team)
    }
    for (const run of this.store.listActiveRuns()) {
      try {
        await this.ensureConductorSession(run)
        this.scheduler.resumeRun(run.id)
      } catch (err) {
        const classified = classifyError(err)
        console.error(
          `[team] failed to resume run ${run.id} (${classified.category}): ${classified.message}`,
        )
      }
    }
  }

  shutdown(): void {
    this.scheduler.shutdown()
  }

  // ── Team CRUD (store + conductor registration kept in lockstep) ──

  createTeam(input: CreateTeamInput): Team {
    this.assertMemberProfilesExist(input.members.map((m) => m.profileId))
    const team = this.store.createTeam(input)
    this.registerConductor(team)
    this.events.emit({ scope: 'teams' })
    return team
  }

  updateTeam(id: string, input: UpdateTeamInput): Team | null {
    if (input.members !== undefined) {
      this.assertMemberProfilesExist(input.members.map((m) => m.profileId))
    }
    const team = this.store.updateTeam(id, input)
    if (team) {
      // Re-materialize: charter / roster / model changes shape the
      // conductor's SOUL. Existing SESSIONS keep their old prompt until
      // the next session creation — acceptable: a mid-run roster edit
      // changing a live conductor's identity silently would be worse.
      this.registerConductor(team)
      this.events.emit({ scope: 'teams' })
    }
    return team
  }

  deleteTeam(id: string): boolean {
    const active = this.store
      .listRunsForTeam(id)
      .filter((r) => r.status === 'active')
    for (const run of active) {
      this.scheduler.cancelRun(run.id, 'Team was deleted while the run was active.')
    }
    const deleted = this.store.deleteTeam(id)
    if (deleted) this.events.emit({ scope: 'teams' })
    return deleted
  }

  private assertMemberProfilesExist(profileIds: readonly string[]): void {
    for (const profileId of profileIds) {
      if (!this.deps.registry.has(profileId)) {
        throw new Error(
          `Member profile "${profileId}" is not registered. Create the profile first, then add it to the team.`,
        )
      }
    }
  }

  private registerConductor(team: Team): void {
    const { profileId, config } = materializeConductor(team, {
      checkpointDir: this.checkpointDir,
    })
    this.deps.registry.register(profileId, config)
  }

  // ── Runs ─────────────────────────────────────────────────────────

  /**
   * Start a run: create the thread, bind it, and park the conductor
   * session in gateway state. The caller (a UI client / a test) then drives
   * the conversation through the existing POST /api/v1/run with
   * `{ threadId, profileId: conductorProfileId }` — the standard chat
   * pipeline, untouched (D16).
   */
  async createRun(
    teamId: string,
    workspaceId: string | null,
  ): Promise<{ run: TeamRun; conductorProfileId: string; model: string }> {
    const team = this.store.getTeam(teamId)
    if (!team) throw new Error(`Team "${teamId}" not found`)
    if (workspaceId !== null && !this.deps.state.getWorkspace(workspaceId)) {
      throw new Error(`Workspace "${workspaceId}" not found`)
    }

    const profileId = conductorProfileId(teamId)
    if (!this.deps.registry.has(profileId)) {
      this.registerConductor(team)
    }

    const thread = this.deps.state.createThread(profileId, `${team.displayName} — run`, workspaceId ?? undefined)
    const run = this.store.createRun(teamId, thread.id, workspaceId)
    await this.ensureConductorSession(run)

    const profile = await this.deps.registry.get(profileId)
    return { run, conductorProfileId: profileId, model: profile.config.model }
  }

  /**
   * Build (or rebuild, after a restart) the conductor's session and
   * companions, and park them in GatewayState under the run's thread.
   * Idempotent: an existing live session is left untouched.
   */
  async ensureConductorSession(run: TeamRun): Promise<void> {
    const { state, registry } = this.deps
    if (state.getSession(run.threadId) && state.getSessionCompanions(run.threadId)) {
      return
    }

    const team = this.store.getTeam(run.teamId)
    if (!team) throw new Error(`Team "${run.teamId}" not found for run "${run.id}"`)

    const profileId = conductorProfileId(team.id)
    if (!registry.has(profileId)) {
      this.registerConductor(team)
    }
    const profile = await registry.get(profileId)

    const workspacePath = run.workspaceId !== null
      ? state.getWorkspace(run.workspaceId)?.path ?? null
      : null

    // No toolProviders, no memory system, no panes: the conductor's
    // surface is closed by design (L6) — allow-listed builtins from
    // the profile + the three board tools appended below.
    const assembled = await assembleAgent(profile, {
      workspacePath,
    })

    const conductorTools = createConductorTools({
      store: this.store,
      runId: run.id,
      onBoardChange: () => this.scheduler.onBoardChange(run.id),
    })

    // Run-stable session id → the file checkpoint store persists the
    // conductor's conversation across gateway restarts.
    const sessionId = `team-conductor:${run.id}`
    const config = mergeConfig(assembled.config, {
      sessionId,
      ...(workspacePath !== null ? { workspacePath } : {}),
    })

    let initialMessages: Message[] | undefined
    if (assembled.checkpointStore) {
      try {
        const checkpoint = await assembled.checkpointStore.load(sessionId)
        if (checkpoint && checkpoint.messages.length > 0) {
          initialMessages = [...checkpoint.messages] as Message[]
        }
      } catch (err) {
        // A corrupt checkpoint must not brick the run — start the
        // conductor fresh; the board still carries the durable truth.
        const classified = classifyError(err)
        console.error(
          `[team] conductor checkpoint load failed for run ${run.id} (${classified.category}): ${classified.message} — starting fresh`,
        )
      }
    }

    const hitl = new HumanInTheLoop({ timeoutMs: profile.config.security.hitlTimeoutMs })
    const credentialRuntime = new ThreadCredentialRuntime(run.threadId, credentialVault)
    const credentialHITL = new CredentialHITL({ timeoutMs: profile.config.security.hitlTimeoutMs })

    const session = new Session({
      config,
      provider: assembled.provider,
      tools: [...assembled.tools, ...conductorTools],
      checkpoint: assembled.checkpointStore,
      ...(initialMessages !== undefined ? { initialMessages } : {}),
      reminders: new ReminderInjector(createDefaultRegistry()),
      // The conductor's whole surface is conversational + board-backed
      // (ask_user, todo_write, the three board tools) — nothing it can
      // call touches files, shell, or the network. Permission prompts
      // would be pure friction with no security value here.
      permissionMode: 'auto',
    })

    state.setSession(run.threadId, session)
    state.setMCPManager(run.threadId, assembled.mcpManager)
    const hitls: readonly HITLLike[] = [
      asHitlLike('permission', hitl),
      asHitlLike('credential', credentialHITL),
    ]
    state.setSessionCompanions(run.threadId, {
      hitl,
      zoneManager: assembled.zoneManager ?? null,
      getLastZoneDecision: () => null,
      credentialHITL,
      credentialRuntime,
      smallFastModel: profile.config.smallFastModel ?? null,
      hitls,
      sessionAdditionalRoots: [],
    })
  }
}
