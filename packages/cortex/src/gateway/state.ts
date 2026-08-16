/**
 * Gateway State — selected-adapter persistence + in-memory runtime state.
 *
 * Persisted (survives restart):
 *   - Threads, messages and usage records → selected storage adapter
 *   - Credentials, grants, principals and run authority → selected storage adapter
 *   - Sources, uploads, source jobs and deletion authority → selected storage adapter
 *   - Connectors, channels, schedules, tasks, teams, memory and candidates → selected storage adapter
 *
 * In-memory only (lost on restart):
 *   - Sessions → live Loom Session objects (can't be serialized)
 *   - Event logs → debug data, 2000 cap per thread
 */

import type { EgressMode, Session, MCPManager, RunningChrome, DeferredChromeLauncher } from '@ownware/loom'
import type { LoomEvent } from '@ownware/loom'
import { HumanInTheLoop, ZoneManager } from '@ownware/loom'
import { randomBytes } from 'node:crypto'
import type { CredentialHITL } from '../credential/hitl.js'
import type { ThreadCredentialRuntime } from '../credential/runtime.js'
import type { HITLLike } from './hitl-registry.js'
import type { SensitiveInputBroker } from './sensitive-input-broker.js'
import type { ExecutionRuntime } from '../runtime/port.js'
import type {
  Thread, ThreadMessage, Workspace, WorkspaceDetail,
  MCPServerRecord, DashboardStats,
  PaginatedResult, UsageBucket, DashboardRange, DashboardKPIs,
  ProfileBreakdownRow, RecentActivityRow,
  LocalProfile, UserSettings, ProfileMetadata,
  AppState, AuditLogEntry,
} from './types.js'
import { CortexDatabase } from './db/database.js'
import { EventBus } from './event-bus.js'
import { EventIngestor } from './event-ingestor.js'
import { redactEventForStorage } from './redact-event.js'
import type {
  StorageAdapter,
  StorageHealth,
  StorageKind,
  StorageLifecycleState,
} from '../storage/contracts.js'
import { SqliteStorageAdapter } from '../storage/sqlite-adapter.js'
import { PostgreSqlStorageAdapter } from '../storage/postgresql-adapter.js'
import type { ValidatedStoragePlan } from '../storage/config.js'
import type {
  AgentEventRepository,
  CoreStorageRepositories,
} from '../storage/core-repositories.js'
import type { UsageEvidenceRepository } from '../storage/usage-evidence-repository.js'
import { createSqliteCoreRepositories } from '../storage/sqlite-core-repositories.js'
import { createPostgreSqlCoreRepositories } from '../storage/postgresql-core-repositories.js'
import type {
  SecurityRepositories,
  SecurityTransactionRepositories,
} from '../storage/security-repositories.js'
import {
  createSqliteSecurityRepositories,
  createSqliteSecurityTransactionRepositories,
} from '../storage/sqlite-security-repositories.js'
import {
  createPostgreSqlSecurityRepositories,
  createPostgreSqlSecurityTransactionRepositories,
} from '../storage/postgresql-security-repositories.js'
import type { SourceRepositories } from '../storage/source-repositories.js'
import { createSqliteSourceRepositories } from '../storage/sqlite-source-repositories.js'
import { createPostgreSqlSourceRepositories } from '../storage/postgresql-source-repositories.js'
import type { PlatformRepositories } from '../storage/platform-repositories.js'
import { createSqlitePlatformRepositories } from '../storage/sqlite-platform-repositories.js'
import { createPostgreSqlPlatformRepositories } from '../storage/postgresql-platform-repositories.js'
import type { GatewayRepositories } from '../storage/gateway-repositories.js'
import { createSqliteGatewayRepositories } from '../storage/sqlite-gateway-repositories.js'
import { createPostgreSqlGatewayRepositories } from '../storage/postgresql-gateway-repositories.js'
import type { PluginRepository } from '../storage/plugin-repository.js'
import { createSqlitePluginRepository } from '../storage/sqlite-plugin-repository.js'
import { createPostgreSqlPluginRepository } from '../storage/postgresql-plugin-repository.js'
import type { SqliteDatabase } from '../storage/sqlite-driver.js'
import type { EvidenceSearchCache } from './evidence-search-cache.js'
import type { SourceQuotaLimits } from './source-quota-policy.js'
import { MemoryEventBus } from '../memory/event-bus.js'
import { TaskEventBus } from '../tasks/event-bus.js'
import { SkillActivationEvidenceAuthority } from './skill-activation-evidence.js'

const MAX_EVENT_LOG_SIZE = 2000

interface GatewayStorageRepositories {
  readonly core: CoreStorageRepositories
  readonly security: SecurityRepositories
  readonly sources: SourceRepositories
  readonly platform: PlatformRepositories
  readonly gateway: GatewayRepositories
  readonly plugins: PluginRepository
}

function deferredRepository<T extends object>(resolve: () => T): T {
  return new Proxy(Object.create(null) as T, {
    get(_target, property) {
      return (...args: readonly unknown[]) => {
        const repository = resolve()
        const method = Reflect.get(repository, property)
        if (typeof method !== 'function') {
          throw new TypeError(`Storage repository method is unavailable (${String(property)}).`)
        }
        return Reflect.apply(method, repository, args)
      }
    },
  })
}

export interface EventLogEntry {
  readonly event: LoomEvent
  readonly ts: number
}

/** Runtime context for a thread's active session. */
export interface ThreadRuntime {
  /** Profile identity captured when the runtime is installed. */
  readonly profileId?: string
  /**
   * Present for the built-in Ownware loop. External executions deliberately
   * omit it so the kernel cannot accidentally depend on engine internals.
   */
  readonly session?: Session
  /**
   * Provider-neutral execution boundary. Optional only for compatibility
   * with callers that install a structural Session in tests; SessionRunner
   * wraps those sessions with the default Ownware driver before iteration.
   */
  readonly execution?: ExecutionRuntime
  /**
   * Present only for the built-in Ownware loop. External runtime permissions
   * are tracked and answered by `execution`.
   */
  readonly hitl?: HumanInTheLoop
  readonly zoneManager: ZoneManager | null
  /** Accessor for the last zone decision (used by SSE enricher). */
  readonly lastZoneDecision?: () => unknown
}

/**
 * Long-lived companion resources that share lifetime with the cached
 * Session, NOT with a single run.
 *
 * Background: `hitl` and `zoneManager` are captured by closures inside
 * the Session (`requestApproval`, `checkPermission`). The session reuses
 * them across every turn. The earlier runtime model recreated these
 * per-run, which produced a subtle lifetime bug — on the second run
 * the runtime entry was missing, the runner bailed silently, and the
 * thread froze. Worse, even if the runner had recreated them, the
 * session's closures still referenced the originals, so permission
 * responses sent through a fresh hitl would never reach the session.
 *
 * Fix: stash these once at session-creation time and reuse them every
 * run. The per-run `runtime` entry now exists purely as a sentinel for
 * "is this thread actively iterating right now" — it is rebuilt at the
 * start of every run from the same companion instances and torn down
 * in the runner's finally block.
 */
export interface SessionCompanions {
  /** Fixed for the cached session; changing the envelope requires a new thread. */
  readonly egressMode: EgressMode
  readonly hitl: HumanInTheLoop
  readonly zoneManager: ZoneManager | null
  /** Opaque revision of the exact policy/tool envelope assembled for this session. */
  readonly permissionPolicyRevision: string
  /** Accessor for the last zone decision (used by SSE enricher). */
  readonly getLastZoneDecision: () => unknown
  /**
   * Credential HITL — Cortex counterpart to Loom's `HumanInTheLoop`,
   * scoped to credential requests. The session's
   * `credentials.requestCredential` closure captures this instance; the
   * gateway credential endpoints call `.respond` / `.deny` on it.
   */
  readonly credentialHITL: CredentialHITL
  /** Dedicated in-memory value authority; absent on non-interactive hosts. */
  readonly sensitiveInputBroker?: SensitiveInputBroker
  /** Fixed client transport negotiation for the lifetime of the cached session. */
  readonly sensitiveInputEnabled?: boolean
  /**
   * Per-thread credential state. Holds the vault-backed handles visible
   * to this session (auto-imported .env + runtime-stored) plus the
   * synchronous value cache the shell tool needs for env-injection +
   * output redaction.
   */
  readonly credentialRuntime: ThreadCredentialRuntime
  /**
   * Optional small / fast model id (`provider:model`) for one-shot
   * meta-tasks routed through `Session.querySide` — title generation,
   * permission classification, single-turn parsing. Resolved once at
   * assemble-time from `profile.config.smallFastModel`. When `null`
   * the gateway uses its non-LLM default for those tasks (e.g.
   * substring titling).
   */
  readonly smallFastModel: string | null
  /**
   * Every HITL this session owns, in register order. The abort handler
   * iterates this array and calls `denyAll()` on each so a user abort
   * structurally unblocks any parked HITL await — regardless of which
   * or how many HITLs the session has. Type-specific authority fields
   * above remain available to direct callers; all are also present here (wrapped via
   * `asHitlLike`). New HITLs register here at construction time and
   * the abort path handles them automatically — no edit to the abort
   * handler per new HITL.
   */
  readonly hitls: readonly HITLLike[]
  /**
   * Session-scoped workspace grants. The user grants access to a folder
   * outside the workspace via the HITL "Allow this folder for the
   * session" affordance; the permission-response endpoint pushes the
   * canonicalized path here. The SAME array reference is wired into
   * `LoomConfig.additionalWorkspaceRoots`, so the loop sees grants on
   * the next ToolContext build (no session restart). Lifetime: until
   * the session ends (thread aborted, gateway restart). For durable
   * "always allow this folder" use the persistent permission store
   * (Phase 3 — not yet wired).
   */
  readonly sessionAdditionalRoots: string[]
}

export class GatewayState {
  private readonly storage: StorageAdapter<
    GatewayStorageRepositories,
    SecurityTransactionRepositories
  >
  private readonly sqliteStorage: SqliteStorageAdapter<
    GatewayStorageRepositories,
    SecurityTransactionRepositories
  > | null
  private readonly core: CoreStorageRepositories
  private readonly security: SecurityRepositories
  private readonly sources: SourceRepositories
  private readonly platform: PlatformRepositories
  private readonly gateway: GatewayRepositories
  private readonly plugins: PluginRepository
  private readonly sessions = new Map<string, Session>()
  private readonly sessionCandidateIds = new Map<string, string | null>()
  private readonly runtimes = new Map<string, ThreadRuntime>()
  /**
   * Companion resources keyed by thread. Lifetime tied to the cached
   * Session — set in the run handler at session-creation time, deleted
   * in `deleteThread`. NOT cleared at end of run.
   */
  private readonly sessionCompanions = new Map<string, SessionCompanions>()
  private readonly eventLogs = new Map<string, EventLogEntry[]>()
  private readonly shutdownListeners = new Set<() => void | Promise<void>>()
  /**
   * 2026-04-11 audit Hazard 21 fix.
   *
   * Live MCPManager instances keyed by threadId. The assembler creates
   * one per session via `connectMCPServers()` — without storing it
   * here, the gateway forgot about it the moment assembleAgent
   * returned, so:
   *   1. The child processes were orphaned when the thread ended
   *      (no .shutdown() ever ran).
   *   2. The /api/v1/mcp/* endpoints had no view of which servers
   *      were actually running for which profile, leading to a
   *      separate (also broken) `liveManagers` Map in mcp.ts that
   *      was declared but never written.
   *
   * Lifetime: lives with the session, not with a single run. Removed
   * + shut down in `deleteThread` and at `stop()`.
   */
  private readonly mcpManagers = new Map<string, MCPManager>()
  /**
   * Managed Chromium instances keyed by threadId. Populated by the
   * deferred launcher's `onLaunched` hook the first time a browser_*
   * tool fires on a session whose profile opted into `browser.autoLaunch`.
   * Stays empty for sessions that never use a browser tool.
   *
   * Lifetime: same as the cached session. Removed and killed in
   * `deleteThread` and at `stop()`. Keeping the map keyed by thread
   * (not by session, not by profile) means parallel agents each get
   * their own Chrome instance with their own temp profile — no
   * cross-contamination.
   */
  private readonly chromeLaunches = new Map<string, RunningChrome>()
  /**
   * Deferred Chrome launchers keyed by threadId. Registered at session
   * creation time for profiles that *might* use a browser; the launcher
   * itself does NOT spawn Chrome until its `getCdpUrl()` is called.
   *
   * Tracking the launcher (in addition to the RunningChrome) lets the
   * kill path stay uniform: `deleteThread` / `stop()` calls the
   * launcher's idempotent `stop()`, which is a no-op if Chrome never
   * started and a real SIGTERM→SIGKILL if it did.
   */
  private readonly chromeLaunchers = new Map<string, DeferredChromeLauncher>()
  /** Process-local invalidation buses; durable stores publish only after commit. */
  readonly taskEventBus = new TaskEventBus()
  readonly memoryEventBus = new MemoryEventBus()
  /**
   * Per-(thread, agent) live event bus. Long-lived — one per gateway.
   * SSE handlers subscribe here to tail live events after replaying
   * the durable log from the selected storage adapter.
   */
  readonly eventBus = new EventBus()
  /** Install-local keyed identity authority for run skill catalogues. */
  readonly skillActivationEvidence: SkillActivationEvidenceAuthority
  /**
   * Single write path for every parent/subagent event. Writes to durable storage
   * then publishes to the bus — "live is always a suffix of disk".
   */
  readonly eventIngestor: EventIngestor

  constructor(dbPath?: string, options: {
    readonly permissionHashSecret?: string
    readonly evidenceSearchCache?: EvidenceSearchCache
    readonly sourceQuotaLimits?: SourceQuotaLimits
    /** Internal validated plan supplied by OwnwareGateway. */
    readonly storagePlan?: ValidatedStoragePlan
  } = {}) {
    const permissionHashSecret = options.permissionHashSecret ?? randomBytes(32).toString('hex')
    this.skillActivationEvidence = new SkillActivationEvidenceAuthority(
      permissionHashSecret,
    )
    const plan = options.storagePlan ?? {
      kind: 'sqlite' as const,
      path: dbPath,
      summary: { kind: 'sqlite' as const, location: 'file' as const },
    }
    if (plan.kind === 'sqlite') {
      const storage = new SqliteStorageAdapter<
        GatewayStorageRepositories,
        SecurityTransactionRepositories
      >({
        dbPath: plan.path,
        // Preserve the existing constructor-time SQLite failure contract.
        openMode: 'eager',
        repositories: {
          createRoot: (context) => ({
            core: createSqliteCoreRepositories(context),
            security: createSqliteSecurityRepositories(context, {
              permissionHashSecret,
              ...(options.evidenceSearchCache !== undefined
                ? { evidenceSearchCache: options.evidenceSearchCache }
                : {}),
            }),
            sources: createSqliteSourceRepositories(context, {
              ...(options.sourceQuotaLimits !== undefined
                ? { quotaLimits: options.sourceQuotaLimits }
                : {}),
              ...(options.evidenceSearchCache !== undefined
                ? { evidenceSearchCache: options.evidenceSearchCache }
                : {}),
            }),
            platform: createSqlitePlatformRepositories(context, {
              taskEvents: this.taskEventBus,
              memoryEvents: this.memoryEventBus,
            }),
            gateway: createSqliteGatewayRepositories(context),
            plugins: createSqlitePluginRepository(context),
          }),
          createTransaction: createSqliteSecurityTransactionRepositories,
        },
      })
      this.storage = storage
      this.sqliteStorage = storage
    } else {
      this.storage = new PostgreSqlStorageAdapter<
        GatewayStorageRepositories,
        SecurityTransactionRepositories
      >({
        plan,
        repositories: {
          createRoot: (context) => ({
            core: createPostgreSqlCoreRepositories(context),
            security: createPostgreSqlSecurityRepositories(context, {
              permissionHashSecret,
              ...(options.evidenceSearchCache !== undefined
                ? { evidenceSearchCache: options.evidenceSearchCache }
                : {}),
            }),
            sources: createPostgreSqlSourceRepositories(context, {
              ...(options.sourceQuotaLimits !== undefined
                ? { quotaLimits: options.sourceQuotaLimits }
                : {}),
              ...(options.evidenceSearchCache !== undefined
                ? { evidenceSearchCache: options.evidenceSearchCache }
                : {}),
            }),
            platform: createPostgreSqlPlatformRepositories(context, {
              taskEvents: this.taskEventBus,
              memoryEvents: this.memoryEventBus,
            }),
            gateway: createPostgreSqlGatewayRepositories(context),
            plugins: createPostgreSqlPluginRepository(context),
          }),
          createTransaction: createPostgreSqlSecurityTransactionRepositories,
        },
      })
      this.sqliteStorage = null
    }
    const root = (): GatewayStorageRepositories => this.storage.repositories
    this.core = {
      threads: deferredRepository(() => root().core.threads),
      messages: deferredRepository(() => root().core.messages),
      usage: deferredRepository(() => root().core.usage),
      usageEvidence: deferredRepository(() => root().core.usageEvidence),
      events: deferredRepository(() => root().core.events),
    }
    this.security = {
      credentials: deferredRepository(() => root().security.credentials),
      credentialAudit: deferredRepository(() => root().security.credentialAudit),
      credentialSpend: deferredRepository(() => root().security.credentialSpend),
      credentialMigrations: deferredRepository(() => root().security.credentialMigrations),
      principals: deferredRepository(() => root().security.principals),
      threadBindings: deferredRepository(() => root().security.threadBindings),
      runs: deferredRepository(() => root().security.runs),
      effectReceipts: deferredRepository(() => root().security.effectReceipts),
      egressReceipts: deferredRepository(() => root().security.egressReceipts),
      skillActivationReceipts: deferredRepository(
        () => root().security.skillActivationReceipts,
      ),
      effectReversals: deferredRepository(() => root().security.effectReversals),
      idempotency: deferredRepository(() => root().security.idempotency),
      accessGrants: deferredRepository(() => root().security.accessGrants),
      oauthRefresh: deferredRepository(() => root().security.oauthRefresh),
      codexThreadReferences: deferredRepository(() => root().security.codexThreadReferences),
    }
    this.sources = {
      sources: deferredRepository(() => root().sources.sources),
      uploads: deferredRepository(() => root().sources.uploads),
      jobs: deferredRepository(() => root().sources.jobs),
      dataViews: deferredRepository(() => root().sources.dataViews),
      deletions: deferredRepository(() => root().sources.deletions),
      get quotaLimits() { return root().sources.quotaLimits },
    }
    this.platform = {
      connectorConnections: deferredRepository(() => root().platform.connectorConnections),
      channelJobs: deferredRepository(() => root().platform.channelJobs),
      schedules: deferredRepository(() => root().platform.schedules),
      approvals: deferredRepository(() => root().platform.approvals),
      tasks: deferredRepository(() => root().platform.tasks),
      memories: deferredRepository(() => root().platform.memories),
      memoryProposals: deferredRepository(() => root().platform.memoryProposals),
      userIdentity: deferredRepository(() => root().platform.userIdentity),
      candidates: deferredRepository(() => root().platform.candidates),
      teams: deferredRepository(() => root().platform.teams),
    }
    this.gateway = {
      workspaces: deferredRepository(() => root().gateway.workspaces),
      mcpServers: deferredRepository(() => root().gateway.mcpServers),
      localProfile: deferredRepository(() => root().gateway.localProfile),
      settings: deferredRepository(() => root().gateway.settings),
      profileMetadata: deferredRepository(() => root().gateway.profileMetadata),
      appState: deferredRepository(() => root().gateway.appState),
      auditLog: deferredRepository(() => root().gateway.auditLog),
      diagnostics: deferredRepository(() => root().gateway.diagnostics),
    }
    this.plugins = deferredRepository(() => root().plugins)
    this.eventIngestor = new EventIngestor(this.core.events, this.eventBus)
  }

  /** Async startup seam; idempotent for every supported storage adapter. */
  initializeStorage(): Promise<void> {
    return this.storage.initialize()
  }

  storageHealth(): Promise<StorageHealth> {
    return this.storage.health()
  }

  get storageKind(): StorageKind {
    return this.storage.kind
  }

  get storageLifecycleState(): StorageLifecycleState {
    return this.storage.lifecycleState
  }

  /**
   * @deprecated Internal SQLite compatibility surface for physical tests and
   * legacy consumers. Product code must use the async repository ports. No
   * equivalent will be added to another storage adapter.
   */
  get rawDbHandle(): SqliteDatabase {
    return this.requireSqliteDatabase().rawMainHandle
  }

  // ── Agent events (selected storage, fed by EventIngestor) ─────────────

  /**
   * Look up a thread by id.
   */
  getThreadAnywhere(id: string): Promise<Thread | undefined> {
    return this.core.threads.get(id)
  }

  /** Read events for a specific agent stream. */
  listAgentEvents(params: {
    threadId: string
    agentId: string
    since?: number
    limit?: number
  }) {
    return this.core.events.list(params)
  }

  /** Latest seq number for an agent's stream. 0 if none. */
  getAgentEventMaxSeq(threadId: string, agentId: string): Promise<number> {
    return this.core.events.maxSeq(threadId, agentId)
  }

  getAgentEventMinSeq(
    threadId: string,
    agentId: string,
    afterSeq: number,
    throughSeq?: number,
  ): Promise<number | null> {
    return this.core.events.minSeq(threadId, agentId, afterSeq, throughSeq)
  }

  /**
   * Highest seq of `turn.end` on this agent's stream (0 if none).
   * The client uses this as the SSE `?since` cursor on hydrate so an
   * in-flight turn reconnects without losing turn.start.
   */
  getLastTurnEndSeq(threadId: string, agentId: string): Promise<number> {
    return this.core.events.lastTurnEndSeq(threadId, agentId)
  }

  /** True iff the agent has ever emitted an event of the given type. */
  hasAgentEventOfType(threadId: string, agentId: string, type: string): Promise<boolean> {
    return this.core.events.hasType(threadId, agentId, type)
  }

  /** List every agent_id that has events on a thread. */
  listAgentsForThread(threadId: string) {
    return this.core.events.listAgents(threadId)
  }

  // ── Retention helpers (main db only) ──────────────────────────────────

  /** Terminal threads whose updated_at is older than the cutoff. */
  listTerminalThreadsOlderThan(cutoffIso: string): Promise<string[]> {
    return this.core.events.listTerminalThreadsOlderThan(cutoffIso)
  }

  /** Delete every agent_events row for one thread. Returns rows deleted. */
  pruneAgentEvents(threadId: string): Promise<number> {
    return this.core.events.pruneRootStream(threadId)
  }

  countAgentEvents(): Promise<number> {
    return this.core.events.count()
  }

  /** Backend-neutral event repository for retention and other services. */
  get eventRepository(): AgentEventRepository {
    return this.core.events
  }

  /** Immutable Provider Hub usage facts and append-only cost observations. */
  get usageEvidenceRepository(): UsageEvidenceRepository {
    return this.core.usageEvidence
  }

  /** Installed plugin identity, migration evidence and revisioned scope decisions. */
  get pluginRepository(): PluginRepository {
    return this.plugins
  }

  /**
   * @deprecated Internal SQLite compatibility surface. Product code must use
   * repository ports; this concrete object will be removed in a major release.
   */
  get rawDatabase(): CortexDatabase {
    return this.requireSqliteDatabase()
  }

  /** Backend-neutral async repositories for security and run authority. */
  get securityRepositories(): SecurityRepositories {
    return this.security
  }

  /** Backend-neutral async repositories for source metadata and durable work. */
  get sourceRepositories(): SourceRepositories {
    return this.sources
  }

  /** Backend-neutral async repositories for the remaining persistent subsystems. */
  get platformRepositories(): PlatformRepositories {
    return this.platform
  }

  /**
   * Establish a delegated thread and its one-way principal binding in one
   * adapter-owned write transaction. A caller never observes an unbound thread.
   */
  createDelegatedThread(
    profileId: string,
    workspaceId: string | undefined,
    principalKey: string,
  ): Promise<Thread> {
    return this.storage.transaction(
      { mode: 'write', isolation: 'serializable', retry: 'never' },
      (tx) => tx.repositories.threadAuthority.createAndBind(
        profileId,
        workspaceId,
        principalKey,
      ),
    )
  }

  // ── Thread CRUD (backend-neutral async repository) ─────────────────

  createThread(profileId: string, title?: string, workspaceId?: string): Promise<Thread> {
    return this.core.threads.create(profileId, title, workspaceId)
  }

  getThread(id: string): Promise<Thread | undefined> {
    return this.core.threads.get(id)
  }

  listThreads(
    profileId?: string,
    opts?: { limit?: number; offset?: number },
  ): Promise<PaginatedResult<Thread>> {
    return this.core.threads.list(profileId, opts)
  }

  updateThread(
    id: string,
    updates: Partial<Pick<Thread, 'title' | 'status' | 'messageCount' | 'totalTokens' | 'totalCost'>>,
  ): Promise<Thread | undefined> {
    return this.core.threads.update(id, updates)
  }

  /**
   * Persist the canonical model id last dispatched on this thread.
   * Called by the run handler after model resolution so a refresh /
   * restart restores the user's last brain pick. Idempotent.
   */
  setThreadModel(id: string, model: string): Promise<void> {
    return this.core.threads.setModel(id, model)
  }

  recoverOrphanedThreads(): Promise<number> {
    return this.core.threads.recoverOrphaned()
  }

  async deleteThread(id: string): Promise<boolean> {
    // Establish the durable fact first. A failed delete must not tear down a
    // live session while leaving the thread present in storage.
    const deleted = await this.core.threads.delete(id)
    if (!deleted) return false

    // Credential runtime cleanup first — must happen BEFORE we drop the
    // companion entry, because the runtime needs the vault reference it
    // holds to remove this thread's `runtime_<id>_*` vault files.
    // Best-effort, fire-and-forget: a stuck vault delete cannot block
    // the thread-delete path.
    const companions = this.sessionCompanions.get(id)
    if (companions) {
      try { companions.credentialHITL.dispose() } catch { /* best-effort */ }
      try { companions.sensitiveInputBroker?.dispose() } catch { /* best-effort */ }
      void companions.credentialRuntime.cleanup().catch(() => { /* best-effort */ })
    }

    // Clean up in-memory state for this thread
    this.sessions.delete(id)
    this.sessionCandidateIds.delete(id)
    this.sessionCompanions.delete(id)
    this.eventLogs.delete(id)
    // Tear down any MCP child processes attached to this thread.
    // Audit Hazard 21 fix — without this, every thread leaked one
    // child process per MCP server it used.
    void this.shutdownMCPManagerForThread(id)
    // Same discipline for any managed Chrome attached to this thread
    // via `browser.autoLaunch` — without this call, deleting a thread
    // while its Chrome is still running orphans the process. Both
    // paths are idempotent and no-op cleanly when nothing was launched.
    void this.shutdownChromeLaunchForThread(id)
    void this.shutdownChromeLauncherForThread(id)
    return true
  }

  // ── MCP manager lifecycle (Hazard 21) ────────────────────────────────

  /**
   * Attach an MCPManager to a thread. The manager is created by
   * `assembleAgent` in the run handler; passing `null` clears the slot
   * (used when a profile has no MCP servers — the assembler returns
   * null and we want to drop any stale manager from a previous run).
   */
  setMCPManager(threadId: string, manager: MCPManager | null): void {
    if (manager) {
      this.mcpManagers.set(threadId, manager)
    } else {
      this.mcpManagers.delete(threadId)
    }
  }

  /** Get the MCPManager attached to a thread, if any. */
  getMCPManager(threadId: string): MCPManager | undefined {
    return this.mcpManagers.get(threadId)
  }

  /**
   * Best-effort shutdown of a thread's MCP manager. Always removes
   * the entry from the map, even if shutdown throws — we don't want
   * a stuck child process to leak the slot.
   */
  async shutdownMCPManagerForThread(threadId: string): Promise<void> {
    const mgr = this.mcpManagers.get(threadId)
    if (!mgr) return
    this.mcpManagers.delete(threadId)
    try { await mgr.shutdown() } catch { /* best-effort */ }
  }

  /**
   * Shut down every live MCP manager. Called from gateway.stop().
   * Awaited so child processes get a chance to receive SIGTERM and
   * exit cleanly before the gateway process itself exits.
   */
  async shutdownAllMCPManagers(): Promise<void> {
    const all = [...this.mcpManagers.values()]
    this.mcpManagers.clear()
    await Promise.allSettled(all.map(m => m.shutdown()))
  }

  // ── Managed Chrome lifecycle (browser.autoLaunch) ──────────────────

  /**
   * Attach (or clear) the managed Chrome for a thread. Call with `null`
   * to evict a stale entry without killing a live process; use
   * `shutdownChromeLaunchForThread` when you actually want to stop it.
   */
  setChromeLaunch(threadId: string, running: RunningChrome | null): void {
    if (running) {
      this.chromeLaunches.set(threadId, running)
    } else {
      this.chromeLaunches.delete(threadId)
    }
  }

  /** Retrieve the managed Chrome attached to a thread, if any. */
  getChromeLaunch(threadId: string): RunningChrome | undefined {
    return this.chromeLaunches.get(threadId)
  }

  /**
   * Best-effort stop of a thread's Chrome. Always evicts the entry,
   * even if stop() throws — a stuck child cannot leak the slot.
   * `RunningChrome.stop` is idempotent, so callers that race us are safe.
   */
  async shutdownChromeLaunchForThread(threadId: string): Promise<void> {
    const running = this.chromeLaunches.get(threadId)
    if (!running) return
    this.chromeLaunches.delete(threadId)
    try { await running.stop() } catch { /* best-effort */ }
  }

  /**
   * Stop every managed Chrome. Called from `gateway.stop()`. Awaited so
   * SIGTERM has a chance to land before the gateway process exits.
   */
  async shutdownAllChromeLaunches(): Promise<void> {
    const all = [...this.chromeLaunches.values()]
    this.chromeLaunches.clear()
    await Promise.allSettled(all.map(r => r.stop()))
  }

  /**
   * Attach the deferred launcher for a thread. Called at session-create
   * time for profiles that may use a browser; the launcher itself does
   * not spawn Chrome until its `getCdpUrl()` is invoked.
   */
  setChromeLauncher(threadId: string, launcher: DeferredChromeLauncher | null): void {
    if (launcher) {
      this.chromeLaunchers.set(threadId, launcher)
    } else {
      this.chromeLaunchers.delete(threadId)
    }
  }

  /** Retrieve the deferred launcher attached to a thread, if any. */
  getChromeLauncher(threadId: string): DeferredChromeLauncher | undefined {
    return this.chromeLaunchers.get(threadId)
  }

  /**
   * Stop the deferred launcher for a thread. No-op if no Chrome was
   * ever started through this launcher (launcher.stop() is idempotent).
   */
  async shutdownChromeLauncherForThread(threadId: string): Promise<void> {
    const launcher = this.chromeLaunchers.get(threadId)
    if (!launcher) return
    this.chromeLaunchers.delete(threadId)
    try { await launcher.stop() } catch { /* best-effort */ }
  }

  /**
   * Stop every registered deferred launcher. Called from `gateway.stop()`
   * alongside `shutdownAllChromeLaunches` — one covers sessions that
   * actually spawned Chrome, the other covers sessions that registered
   * a launcher but never triggered it.
   */
  async shutdownAllChromeLaunchers(): Promise<void> {
    const all = [...this.chromeLaunchers.values()]
    this.chromeLaunchers.clear()
    await Promise.allSettled(all.map(l => l.stop()))
  }

  // ── Session management (in-memory — live Loom sessions) ──────────────

  setSession(threadId: string, session: Session): void {
    this.sessions.set(threadId, session)
  }

  getSession(threadId: string): Session | undefined {
    return this.sessions.get(threadId)
  }

  setSessionCandidateId(threadId: string, candidateId: string | null): void {
    this.sessionCandidateIds.set(threadId, candidateId)
  }

  getSessionCandidateId(threadId: string): string | null | undefined {
    return this.sessionCandidateIds.get(threadId)
  }

  /** Drop cached assembly resources between runs without deleting thread history. */
  async resetSession(threadId: string): Promise<void> {
    const companions = this.sessionCompanions.get(threadId)
    if (companions) {
      try { companions.credentialHITL.dispose() } catch { /* best-effort */ }
      try { companions.sensitiveInputBroker?.dispose() } catch { /* best-effort */ }
      try { await companions.credentialRuntime.cleanup() } catch { /* best-effort */ }
    }
    this.sessions.delete(threadId)
    this.sessionCandidateIds.delete(threadId)
    this.sessionCompanions.delete(threadId)
    await Promise.allSettled([
      this.shutdownMCPManagerForThread(threadId),
      this.shutdownChromeLaunchForThread(threadId),
      this.shutdownChromeLauncherForThread(threadId),
    ])
  }

  // ── Session companions (long-lived per-thread resources) ─────────────

  /**
   * Stash hitl + zoneManager + lastZoneDecision accessor alongside the
   * session. Called once at session creation; the same instances are
   * reused for every run on this thread until the session is deleted.
   */
  setSessionCompanions(threadId: string, companions: SessionCompanions): void {
    this.sessionCompanions.set(threadId, companions)
  }

  /** Retrieve the companion resources for a thread's cached session. */
  getSessionCompanions(threadId: string): SessionCompanions | undefined {
    return this.sessionCompanions.get(threadId)
  }

  /**
   * Iterate every (threadId, companions) pair the gateway currently has
   * a cached session for. Used by the credential manager to attach live
   * labels to vault entries — a thread may be idle (no active runtime)
   * but still have companions stashed, and we want the label regardless.
   */
  *iterSessionCompanions(): IterableIterator<{ threadId: string; companions: SessionCompanions }> {
    for (const [threadId, companions] of this.sessionCompanions) {
      yield { threadId, companions }
    }
  }

  // ── Runtime management (HITL + ZoneManager per thread) ──────────────

  setRuntime(threadId: string, runtime: ThreadRuntime): void {
    this.runtimes.set(threadId, runtime)
  }

  getRuntime(threadId: string): ThreadRuntime | undefined {
    return this.runtimes.get(threadId)
  }

  /** Remove a thread's runtime. Called when a run completes or aborts. */
  deleteRuntime(threadId: string): void {
    this.runtimes.delete(threadId)
  }

  /** Check if any thread with this profileId has an active runtime. */
  hasActiveRuntime(profileId: string): boolean {
    for (const runtime of this.runtimes.values()) {
      if (runtime.profileId === profileId) return true
    }
    return false
  }

  /** Get count of active runtimes. */
  get activeRuntimeCount(): number {
    return this.runtimes.size
  }

  // ── Message management (backend-neutral async repository) ──────────

  addMessage(threadId: string, msg: ThreadMessage): Promise<void> {
    return this.core.messages.add(threadId, msg)
  }

  getMessages(threadId: string): Promise<ThreadMessage[]> {
    return this.core.messages.list(threadId)
  }

  patchMessageSubAgent(threadId: string, agentId: string, patch: {
    status: 'running' | 'completed' | 'error'
    result?: string
    durationMs?: number
    toolCount?: number
    turnCount?: number
  }): Promise<boolean> {
    return this.core.messages.patchSubAgent(threadId, agentId, patch)
  }

  // ── Usage tracking (backend-neutral async repository) ──────────────

  addUsageRecord(record: {
    threadId?: string
    profileId: string
    model: string
    provider: string
    inputTokens: number
    outputTokens: number
    costUsd: number
    durationMs?: number
    success?: boolean
  }): Promise<void> {
    return this.core.usage.add(record)
  }

  getUsageSummary(profileId?: string) {
    return this.core.usage.summary(profileId)
  }

  // ── Workspace management (selected storage adapter) ─────────────────

  createWorkspace(path: string, name?: string): Promise<Workspace> {
    return this.gateway.workspaces.create(path, name)
  }

  getWorkspace(id: string): Promise<Workspace | undefined> {
    return this.gateway.workspaces.get(id)
  }

  getWorkspaceByPath(path: string): Promise<Workspace | undefined> {
    return this.gateway.workspaces.getByPath(path)
  }

  listWorkspaces(status?: 'active' | 'archived', opts?: { limit?: number; offset?: number }): Promise<PaginatedResult<Workspace>> {
    return this.gateway.workspaces.list(status, opts)
  }

  getWorkspaceDetail(id: string): Promise<WorkspaceDetail | undefined> {
    return this.gateway.workspaces.detail(id)
  }

  updateWorkspace(
    id: string,
    updates: {
      name?: string
      pinned?: boolean
      status?: string
      lastProfileId?: string
      activeProducts?: readonly string[]
    },
  ): Promise<Workspace | undefined> {
    return this.gateway.workspaces.update(id, updates)
  }

  deleteWorkspace(id: string): Promise<boolean> {
    return this.gateway.workspaces.delete(id)
  }

  touchWorkspace(id: string): Promise<void> {
    return this.gateway.workspaces.touch(id)
  }

  listThreadsByWorkspace(workspaceId: string): Promise<Thread[]> {
    return this.gateway.workspaces.listThreads(workspaceId)
  }

  // ── MCP Server management (selected storage adapter) ───────────────

  createMCPServer(server: {
    id: string
    name: string
    transport: string
    url?: string
    command?: string
    args?: readonly string[]
    env?: Record<string, string>
    headers?: Record<string, string>
    registryId?: string
  }): Promise<MCPServerRecord> {
    return this.gateway.mcpServers.create(server)
  }

  getMCPServer(id: string): Promise<MCPServerRecord | undefined> {
    return this.gateway.mcpServers.get(id)
  }

  listMCPServers(opts?: { limit?: number; offset?: number }): Promise<PaginatedResult<MCPServerRecord>> {
    return this.gateway.mcpServers.list(opts)
  }

  updateMCPServer(id: string, updates: { name?: string; status?: string; toolCount?: number; error?: string | null; toolsJson?: string | null }): Promise<MCPServerRecord | undefined> {
    return this.gateway.mcpServers.update(id, updates)
  }

  deleteMCPServer(id: string): Promise<boolean> {
    return this.gateway.mcpServers.delete(id)
  }

  assignServerToProfile(serverId: string, profileId: string): Promise<void> {
    return this.gateway.mcpServers.assignToProfile(serverId, profileId)
  }

  removeServerFromProfile(serverId: string, profileId: string): Promise<boolean> {
    return this.gateway.mcpServers.removeFromProfile(serverId, profileId)
  }

  getServersForProfile(profileId: string): Promise<MCPServerRecord[]> {
    return this.gateway.mcpServers.listForProfile(profileId)
  }

  // ── Dashboard (storage aggregation + in-memory runtime) ────────────

  async getDashboardStats(): Promise<DashboardStats> {
    const stats = await this.core.usage.dashboardStats()
    // Enrich with live runtime data
    return { ...stats, activeAgents: this.runtimes.size }
  }

  getUsageTimeSeries(range: DashboardRange = '7d'): Promise<UsageBucket[]> {
    return this.core.usage.timeSeries(range)
  }

  getKPIs(range: DashboardRange = '7d'): Promise<DashboardKPIs> {
    return this.core.usage.kpis(range)
  }

  getProfileBreakdown(): Promise<ProfileBreakdownRow[]> {
    return this.core.usage.profileBreakdown()
  }

  getRecentActivity(limit: number = 20): Promise<RecentActivityRow[]> {
    return this.core.usage.recentActivity(limit)
  }

  incrementProfileUsage(profileId: string, cost: number): Promise<void> {
    return this.core.usage.incrementProfile(profileId, cost)
  }

  // ── Local Profile (selected storage adapter) ────────────────────────

  createLocalProfile(displayName: string, avatarUrl?: string): Promise<LocalProfile> {
    return this.gateway.localProfile.create(displayName, avatarUrl)
  }

  getLocalProfile(): Promise<LocalProfile | undefined> {
    return this.gateway.localProfile.get()
  }

  updateLocalProfile(id: string, updates: { displayName?: string; avatarUrl?: string | null }): Promise<LocalProfile | undefined> {
    return this.gateway.localProfile.update(id, updates)
  }

  // ── User Settings (selected storage adapter) ───────────────────────

  getSetting(key: string): Promise<UserSettings | undefined> {
    return this.gateway.settings.get(key)
  }

  setSetting(key: string, value: string): Promise<UserSettings> {
    return this.gateway.settings.set(key, value)
  }

  getAllSettings(): Promise<UserSettings[]> {
    return this.gateway.settings.list()
  }

  deleteSetting(key: string): Promise<boolean> {
    return this.gateway.settings.delete(key)
  }

  // ── Profile Metadata (selected storage adapter) ───────────────────

  getProfileMetadata(profileId: string): Promise<ProfileMetadata | undefined> {
    return this.gateway.profileMetadata.get(profileId)
  }

  setProfileMetadata(profileId: string, updates: { icon?: string | null; color?: string | null; category?: string | null }): Promise<ProfileMetadata> {
    return this.gateway.profileMetadata.set(profileId, updates)
  }

  listProfileMetadata(): Promise<ProfileMetadata[]> {
    return this.gateway.profileMetadata.list()
  }

  // (Desktop pane/history proxy methods removed with the legacy desktop shell.)


  /**
   * User-chosen side-track width (px) for the workspace. Returns
   * `null` when the user hasn't dragged the shell splitter yet —
   * the client falls back to its computed default in that case.
   */
  getWorkspaceSideTrackWidth(workspaceId: string): Promise<number | null> {
    return this.gateway.appState.getWorkspaceSideTrackWidth(workspaceId)
  }

  setWorkspaceSideTrackWidth(workspaceId: string, widthPx: number): Promise<void> {
    return this.gateway.appState.setWorkspaceSideTrackWidth(workspaceId, widthPx)
  }

  // ── App State (selected storage adapter) ──────────────────────────

  getAppState(key: string): Promise<AppState | undefined> {
    return this.gateway.appState.get(key)
  }

  setAppState(key: string, value: string): Promise<AppState> {
    return this.gateway.appState.set(key, value)
  }

  /**
   * Register a callback that fires once the gateway begins shutting down.
   *
   * SSE handlers use this to flush a final transport lifecycle frame before
   * the HTTP server closes their sockets.
   */
  subscribeToShutdown(listener: () => void | Promise<void>): () => void {
    this.shutdownListeners.add(listener)
    return () => {
      this.shutdownListeners.delete(listener)
    }
  }

  /**
   * Notify all registered shutdown listeners. Listener failures are isolated
   * so one broken stream never blocks gateway shutdown.
   */
  async notifyShutdown(): Promise<void> {
    const listeners = [...this.shutdownListeners]
    this.shutdownListeners.clear()
    await Promise.allSettled(
      listeners.map(listener => Promise.resolve().then(listener)),
    )
  }

  // ── Audit Log (selected storage adapter) ──────────────────────────

  addAuditLog(entry: { action: string; entityType: string; entityId?: string; detail?: string; ipAddress?: string }): Promise<AuditLogEntry> {
    return this.gateway.auditLog.add(entry)
  }

  // ── Event log (in-memory — debug data, not worth persisting) ────────

  logEvent(threadId: string, event: LoomEvent): void {
    let log = this.eventLogs.get(threadId)
    if (!log) {
      log = []
      this.eventLogs.set(threadId, log)
    }
    // This log is served verbatim by `/api/v1/debug/*`. Redact here — the
    // single write path — rather than trusting every caller to hand us an
    // already-clean event. See `redact-event.ts` for the store table.
    log.push({ event: redactEventForStorage(event), ts: Date.now() })
    // Trim to max size
    if (log.length > MAX_EVENT_LOG_SIZE) {
      log.splice(0, log.length - MAX_EVENT_LOG_SIZE)
    }
  }

  getEventLog(threadId: string, opts?: {
    type?: string
    agentId?: string
    limit?: number
    since?: number
  }): EventLogEntry[] {
    let log = this.eventLogs.get(threadId) ?? []
    if (opts?.type) log = log.filter(e => e.event.type === opts.type)
    if (opts?.agentId) log = log.filter(e => (e.event as any).agentId === opts.agentId)
    if (opts?.since) log = log.filter(e => e.ts >= opts.since!)
    if (opts?.limit) log = log.slice(-opts.limit)
    return log
  }

  // ── Storage stats + data export ─────────────────────────────────────

  getStorageStats(): Promise<{
    databaseSizeBytes: number
    threadCount: number
    messageCount: number
    usageRecordCount: number
  }> {
    return this.gateway.diagnostics.stats()
  }

  get dbPath(): string {
    return this.requireSqliteDatabase().dbPath
  }

  /** Count total event log entries across all threads. */
  get eventLogEntryCount(): number {
    let total = 0
    for (const log of this.eventLogs.values()) {
      total += log.length
    }
    return total
  }

  /** Clear all in-memory event logs. Returns the number of entries cleared. */
  clearEventLogs(): number {
    const count = this.eventLogEntryCount
    this.eventLogs.clear()
    return count
  }

  /** List all active thread IDs that have a running runtime. */
  listActiveRuntimes(): Array<{ threadId: string; runtime: ThreadRuntime }> {
    const entries: Array<{ threadId: string; runtime: ThreadRuntime }> = []
    for (const [threadId, runtime] of this.runtimes.entries()) {
      entries.push({ threadId, runtime })
    }
    return entries
  }

  /** Export all user data for portability. */
  exportAllData() {
    return this.gateway.diagnostics.exportAll()
  }

  // ── Session persistence (crash recovery) ────────────────────────────

  /**
   * (Removed) Desktop crash-restore persistence lived here — dropped with the
   * legacy desktop client's `/session/{state,restore}` endpoints.
   */

  // (Design-canvas proxy methods removed — the legacy desktop design
  // vertical's HTTP surface was deleted; the tables drop in a later
  // cleanup migration.)

  // ── Utility ──────────────────────────────────────────────────────────

  threadCount(): Promise<number> {
    return this.gateway.diagnostics.threadCount()
  }

  close(): void {
    this.eventBus.clear()
    if (this.sqliteStorage === null) {
      throw new Error('GatewayState.close() is SQLite-only; use closeStorage() for PostgreSQL.')
    }
    this.sqliteStorage.closeSynchronouslyForLegacyCaller()
  }

  async closeStorage(): Promise<void> {
    this.eventBus.clear()
    await this.eventIngestor.drain()
    await this.storage.close()
  }

  private requireSqliteDatabase(): CortexDatabase {
    if (this.sqliteStorage === null) {
      throw new Error('This compatibility surface is available only with SQLite storage.')
    }
    return this.sqliteStorage.legacyDatabase
  }

  /**
   * @deprecated Use close() instead. clear() only clears in-memory state.
   */
  clear(): void {
    this.sessions.clear()
    this.sessionCandidateIds.clear()
    this.runtimes.clear()
    this.eventLogs.clear()
  }
}
