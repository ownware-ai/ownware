/**
 * Gateway State — SQLite-backed persistence + in-memory runtime state.
 *
 * Persisted (survives restart):
 *   - Threads → SQLite (ownware.db)
 *   - Messages → SQLite (ownware.db)
 *   - Usage records → SQLite (ownware.db)
 *
 * In-memory only (lost on restart):
 *   - Sessions → live Loom Session objects (can't be serialized)
 *   - Event logs → debug data, 2000 cap per thread
 */

import type { Session, MCPManager, RunningChrome, DeferredChromeLauncher } from '@ownware/loom'
import type { LoomEvent } from '@ownware/loom'
import { HumanInTheLoop, ZoneManager } from '@ownware/loom'
import type { CredentialHITL } from '../credential/hitl.js'
import type { ThreadCredentialRuntime } from '../credential/runtime.js'
import type { HITLLike } from './hitl-registry.js'
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

const MAX_EVENT_LOG_SIZE = 2000

export interface EventLogEntry {
  readonly event: LoomEvent
  readonly ts: number
}

/** Runtime context for a thread's active session. */
export interface ThreadRuntime {
  readonly session: Session
  readonly hitl: HumanInTheLoop
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
  readonly hitl: HumanInTheLoop
  readonly zoneManager: ZoneManager | null
  /** Accessor for the last zone decision (used by SSE enricher). */
  readonly getLastZoneDecision: () => unknown
  /**
   * Credential HITL — Cortex counterpart to Loom's `HumanInTheLoop`,
   * scoped to credential requests. The session's
   * `credentials.requestCredential` closure captures this instance; the
   * gateway credential endpoints call `.respond` / `.deny` on it.
   */
  readonly credentialHITL: CredentialHITL
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
   * or how many HITLs the session has. `hitl` and `credentialHITL`
   * above are the two today; both are also present here (wrapped via
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
  private readonly db: CortexDatabase
  private readonly sessions = new Map<string, Session>()
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
  /**
   * Per-(thread, agent) live event bus. Long-lived — one per gateway.
   * SSE handlers subscribe here to tail live events after replaying
   * the durable log from SQLite.
   */
  readonly eventBus = new EventBus()
  /**
   * Single write path for every parent/subagent event. Writes to SQLite
   * then publishes to the bus — "live is always a suffix of disk".
   */
  readonly eventIngestor: EventIngestor

  constructor(dbPath?: string) {
    this.db = new CortexDatabase(dbPath)
    this.eventIngestor = new EventIngestor(this.db, this.eventBus)
  }

  /**
   * Raw main-db handle. Exposed for connector-owned tables
   * (`connector_connections`, future vendor catalogues that we own)
   * that ship their own CRUD module instead of growing CortexDatabase.
   * See `CortexDatabase.rawMainHandle` for the rationale.
   */
  get rawDbHandle(): import('better-sqlite3').Database {
    return this.db.rawMainHandle
  }

  // ── Agent events (SQLite-backed, fed by EventIngestor) ────────────────

  /**
   * Look up a thread by id.
   */
  getThreadAnywhere(id: string): Thread | undefined {
    return this.db.getThread(id)
  }

  /** Read events for a specific agent stream. */
  listAgentEvents(params: {
    threadId: string
    agentId: string
    since?: number
    limit?: number
  }) {
    return this.db.listAgentEvents(params)
  }

  /** Latest seq number for an agent's stream. 0 if none. */
  getAgentEventMaxSeq(threadId: string, agentId: string): number {
    return this.db.getAgentEventMaxSeq(threadId, agentId)
  }

  /**
   * Highest seq of `turn.end` on this agent's stream (0 if none).
   * The client uses this as the SSE `?since` cursor on hydrate so an
   * in-flight turn reconnects without losing turn.start.
   */
  getLastTurnEndSeq(threadId: string, agentId: string): number {
    return this.db.getLastTurnEndSeq(threadId, agentId)
  }

  /** True iff the agent has ever emitted an event of the given type. */
  hasAgentEventOfType(threadId: string, agentId: string, type: string): boolean {
    return this.db.hasAgentEventOfType(threadId, agentId, type)
  }

  /** List every agent_id that has events on a thread. */
  listAgentsForThread(threadId: string) {
    return this.db.listAgentsForThread(threadId)
  }

  // ── Retention helpers (main db only) ──────────────────────────────────

  /** Terminal threads whose updated_at is older than the cutoff. */
  listTerminalThreadsOlderThan(cutoffIso: string): string[] {
    return this.db.listTerminalThreadsOlderThan(cutoffIso)
  }

  /** Delete every agent_events row for one thread. Returns rows deleted. */
  pruneAgentEvents(threadId: string): number {
    return this.db.pruneAgentEvents(threadId)
  }

  /** Raw database handle — used by the retention module. */
  get rawDatabase(): CortexDatabase {
    return this.db
  }

  // ── Thread CRUD (SQLite-backed) ─────────────────────────────────────

  createThread(profileId: string, title?: string, workspaceId?: string): Thread {
    return this.db.createThread(profileId, title, workspaceId)
  }

  getThread(id: string): Thread | undefined {
    return this.db.getThread(id)
  }

  listThreads(profileId?: string, opts?: { limit?: number; offset?: number }): PaginatedResult<Thread> {
    return this.db.listThreads(profileId, opts)
  }

  updateThread(id: string, updates: Partial<Pick<Thread, 'title' | 'status' | 'messageCount' | 'totalTokens' | 'totalCost'>>): Thread | undefined {
    return this.db.updateThread(id, updates)
  }

  /**
   * Persist the canonical model id last dispatched on this thread.
   * Called by the run handler after model resolution so a refresh /
   * restart restores the user's last brain pick. Idempotent.
   */
  setThreadModel(id: string, model: string): void {
    this.db.setThreadModel(id, model)
  }

  recoverOrphanedThreads(): number {
    return this.db.recoverOrphanedThreads()
  }

  deleteThread(id: string): boolean {
    // Credential runtime cleanup first — must happen BEFORE we drop the
    // companion entry, because the runtime needs the vault reference it
    // holds to remove this thread's `runtime_<id>_*` vault files.
    // Best-effort, fire-and-forget: a stuck vault delete cannot block
    // the thread-delete path.
    const companions = this.sessionCompanions.get(id)
    if (companions) {
      try { companions.credentialHITL.dispose() } catch { /* best-effort */ }
      void companions.credentialRuntime.cleanup().catch(() => { /* best-effort */ })
    }

    // Clean up in-memory state for this thread
    this.sessions.delete(id)
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
    // Delete from DB (cascades to messages)
    return this.db.deleteThread(id)
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
    for (const [threadId] of this.runtimes) {
      const thread = this.db.getThread(threadId)
      if (thread?.profileId === profileId) return true
    }
    return false
  }

  /** Get count of active runtimes. */
  get activeRuntimeCount(): number {
    return this.runtimes.size
  }

  // ── Message management (SQLite-backed) ──────────────────────────────

  addMessage(threadId: string, msg: ThreadMessage): void {
    this.db.addMessage(threadId, msg)
  }

  getMessages(threadId: string): ThreadMessage[] {
    return this.db.getMessages(threadId)
  }

  patchMessageSubAgent(threadId: string, agentId: string, patch: {
    status: 'running' | 'completed' | 'error'
    result?: string
    durationMs?: number
    toolCount?: number
    turnCount?: number
  }): boolean {
    return this.db.patchMessageSubAgent(threadId, agentId, patch)
  }

  // ── Usage tracking (SQLite-backed) ──────────────────────────────────

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
  }): void {
    this.db.addUsageRecord(record)
  }

  getUsageSummary(profileId?: string) {
    return this.db.getUsageSummary(profileId)
  }

  // ── Workspace management (SQLite-backed) ────────────────────────────

  createWorkspace(path: string, name?: string): Workspace {
    return this.db.createWorkspace(path, name)
  }

  getWorkspace(id: string): Workspace | undefined {
    return this.db.getWorkspace(id)
  }

  getWorkspaceByPath(path: string): Workspace | undefined {
    return this.db.getWorkspaceByPath(path)
  }

  listWorkspaces(status?: 'active' | 'archived', opts?: { limit?: number; offset?: number }): PaginatedResult<Workspace> {
    return this.db.listWorkspaces(status, opts)
  }

  getWorkspaceDetail(id: string): WorkspaceDetail | undefined {
    return this.db.getWorkspaceDetail(id)
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
  ): Workspace | undefined {
    return this.db.updateWorkspace(id, updates)
  }

  deleteWorkspace(id: string): boolean {
    return this.db.deleteWorkspace(id)
  }

  touchWorkspace(id: string): void {
    this.db.touchWorkspace(id)
  }

  listThreadsByWorkspace(workspaceId: string): Thread[] {
    return this.db.listThreadsByWorkspace(workspaceId)
  }

  // ── MCP Server management (SQLite-backed) ──────────────────────────

  createMCPServer(server: Parameters<typeof this.db.createMCPServer>[0]): MCPServerRecord {
    return this.db.createMCPServer(server)
  }

  getMCPServer(id: string): MCPServerRecord | undefined {
    return this.db.getMCPServer(id)
  }

  listMCPServers(opts?: { limit?: number; offset?: number }): PaginatedResult<MCPServerRecord> {
    return this.db.listMCPServers(opts)
  }

  updateMCPServer(id: string, updates: { name?: string; status?: string; toolCount?: number; error?: string | null; toolsJson?: string | null }): MCPServerRecord | undefined {
    return this.db.updateMCPServer(id, updates)
  }

  deleteMCPServer(id: string): boolean {
    return this.db.deleteMCPServer(id)
  }

  assignServerToProfile(serverId: string, profileId: string): void {
    this.db.assignServerToProfile(serverId, profileId)
  }

  removeServerFromProfile(serverId: string, profileId: string): boolean {
    return this.db.removeServerFromProfile(serverId, profileId)
  }

  getServersForProfile(profileId: string): MCPServerRecord[] {
    return this.db.getServersForProfile(profileId)
  }

  // ── Dashboard (SQLite aggregation + in-memory runtime) ─────────────

  getDashboardStats(): DashboardStats {
    const stats = this.db.getDashboardStats()
    // Enrich with live runtime data
    return { ...stats, activeAgents: this.runtimes.size }
  }

  getUsageTimeSeries(range: DashboardRange = '7d'): UsageBucket[] {
    return this.db.getUsageTimeSeries(range)
  }

  getKPIs(range: DashboardRange = '7d'): DashboardKPIs {
    return this.db.getKPIs(range)
  }

  getProfileBreakdown(): ProfileBreakdownRow[] {
    return this.db.getProfileBreakdown()
  }

  getRecentActivity(limit: number = 20): RecentActivityRow[] {
    return this.db.getRecentActivity(limit)
  }

  incrementProfileUsage(profileId: string, cost: number): void {
    this.db.incrementProfileUsage(profileId, cost)
  }

  // ── Local Profile (SQLite-backed) ───────────────────────────────────

  createLocalProfile(displayName: string, avatarUrl?: string): LocalProfile {
    return this.db.createLocalProfile(displayName, avatarUrl)
  }

  getLocalProfile(): LocalProfile | undefined {
    return this.db.getLocalProfile()
  }

  updateLocalProfile(id: string, updates: { displayName?: string; avatarUrl?: string | null }): LocalProfile | undefined {
    return this.db.updateLocalProfile(id, updates)
  }

  // ── User Settings (SQLite-backed) ──────────────────────────────────

  getSetting(key: string): UserSettings | undefined {
    return this.db.getSetting(key)
  }

  setSetting(key: string, value: string): UserSettings {
    return this.db.setSetting(key, value)
  }

  getAllSettings(): UserSettings[] {
    return this.db.getAllSettings()
  }

  deleteSetting(key: string): boolean {
    return this.db.deleteSetting(key)
  }

  // ── Profile Metadata (SQLite-backed) ──────────────────────────────

  getProfileMetadata(profileId: string): ProfileMetadata | undefined {
    return this.db.getProfileMetadata(profileId)
  }

  setProfileMetadata(profileId: string, updates: { icon?: string | null; color?: string | null; category?: string | null }): ProfileMetadata {
    return this.db.setProfileMetadata(profileId, updates)
  }

  listProfileMetadata(): ProfileMetadata[] {
    return this.db.listProfileMetadata()
  }

  // (Desktop pane/history proxy methods removed with the legacy desktop shell.)


  /**
   * User-chosen side-track width (px) for the workspace. Returns
   * `null` when the user hasn't dragged the shell splitter yet —
   * the client falls back to its computed default in that case.
   */
  getWorkspaceSideTrackWidth(workspaceId: string): number | null {
    return this.db.getWorkspaceSideTrackWidth(workspaceId)
  }

  setWorkspaceSideTrackWidth(workspaceId: string, widthPx: number): void {
    this.db.setWorkspaceSideTrackWidth(workspaceId, widthPx)
  }

  // ── App State (SQLite-backed) ─────────────────────────────────────

  getAppState(key: string): AppState | undefined {
    return this.db.getAppState(key)
  }

  setAppState(key: string, value: string): AppState {
    return this.db.setAppState(key, value)
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

  // ── Audit Log (SQLite-backed) ─────────────────────────────────────

  addAuditLog(entry: { action: string; entityType: string; entityId?: string; detail?: string; ipAddress?: string }): AuditLogEntry {
    return this.db.addAuditLog(entry)
  }

  // ── Event log (in-memory — debug data, not worth persisting) ────────

  logEvent(threadId: string, event: LoomEvent): void {
    let log = this.eventLogs.get(threadId)
    if (!log) {
      log = []
      this.eventLogs.set(threadId, log)
    }
    log.push({ event, ts: Date.now() })
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

  getStorageStats(): { threadCount: number; messageCount: number; usageRecordCount: number } {
    return this.db.getStorageStats()
  }

  get dbPath(): string {
    return this.db.dbPath
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
  exportAllData(): ReturnType<typeof this.db.exportAllData> {
    return this.db.exportAllData()
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

  get threadCount(): number {
    return this.db.threadCount
  }

  close(): void {
    this.eventBus.clear()
    this.db.close()
  }

  /**
   * @deprecated Use close() instead. clear() only clears in-memory state.
   */
  clear(): void {
    this.sessions.clear()
    this.runtimes.clear()
    this.eventLogs.clear()
  }
}
