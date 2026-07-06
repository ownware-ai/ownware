/**
 * TerminalSessionRegistry — typed registry for two kinds of PTY:
 *
 *   - `agent` — exactly one per workspace, lazy-spawned. Written to
 *     only by Loom's `shell_execute` via the scoped runner. User
 *     cannot address this PTY's stdin through the HTTP surface.
 *   - `user` — 0..N per workspace, created explicitly by the client.
 *     Each user PTY has an opaque UUID. Agent has no handle to it.
 *
 * Each spawned session registers listeners that forward PTY output +
 * exit events onto `TerminalEventBus`, tagged with `kind` and
 * `terminalId`. HTTP handlers subscribe to the bus and filter per
 * kind / id.
 *
 * Storage is a single flat `Map<string, Entry>` keyed by composed
 * strings (`agent::<wsId>`, `user::<wsId>::<id>`). Flat beats nested
 * because every mutation path is one lookup and shutdown is one
 * iteration.
 *
 * Cleanup:
 *   - `dropAgent(wsId)` / `dropUser(wsId, id)` kill one entry.
 *   - `dropWorkspace(wsId)` kills agent + every user PTY for the ws.
 *   - `shutdown()` kills every live session. Called by gateway stop.
 */

import { randomUUID } from 'node:crypto'
import { PtySession, type PtySessionOptions } from './pty-session.js'
import { prepareShellIntegration } from './shell-integration.js'
import {
  TerminalEventBus,
  type TerminalEvent,
  type TerminalKind,
} from './event-bus.js'

export interface WorkspaceResolver {
  /** Return the filesystem path for a workspace, or null if unknown. */
  getWorkspacePath(workspaceId: string): string | null
}

export interface TerminalSessionRegistryOptions {
  readonly workspaces: WorkspaceResolver
  readonly bus: TerminalEventBus
  /** Testing seam — defaults to the real PtySession constructor. */
  readonly factory?: (opts: PtySessionOptions) => PtySession
}

interface Entry {
  readonly session: PtySession
  readonly kind: TerminalKind
  readonly workspaceId: string
  /** null for `agent` kind, the UUID otherwise. */
  readonly terminalId: string | null
  /**
   * Owning thread id when this session was spawned by an agent run.
   * null for human-created user shells AND for the per-workspace
   * `agent` PTY (that one is scoped to the workspace, not a thread).
   * Drives `cleanupByThread()`.
   */
  readonly parentThreadId: string | null
  /**
   * Profile/agent id when this session was spawned by an agent run.
   * Used by the client to label tabs ("Agent is using Shell 3"). null for
   * human-created user shells.
   */
  readonly parentAgent: string | null
  /** When true, emit `terminal.exited` on exit (Item 5). */
  readonly notifyOnExit: boolean
  /** Wall-clock time the session was registered. ISO string. */
  readonly createdAt: string
  readonly unsubscribers: ReadonlyArray<() => void>
  /**
   * Mutable flag flipped to true when the session is killed because
   * of `timeoutSeconds` expiry (Item 6). Not `readonly` because it
   * must be set from inside the timeout callback before `kill()`.
   */
  timedOut: boolean
}

/** Optional ownership fields propagated to the entry on create. */
export interface SessionOwner {
  readonly parentThreadId?: string
  readonly parentAgent?: string
  /**
   * When true, emit a `terminal.exited` event on this session's exit
   * (Item 5). Loom's `shell_execute` sets this for long-running
   * commands so the agent can be notified without polling.
   */
  readonly notifyOnExit?: boolean
  /**
   * Auto-kill the session after N seconds (Item 6). Must be a
   * positive integer. Omit for sessions meant to keep running
   * indefinitely (dev servers, watch modes, REPLs).
   */
  readonly timeoutSeconds?: number
  /** Human-readable title for UI. Falls back to a generated label. */
  readonly title?: string
}

/**
 * Public read-only view of a session, safe to return from HTTP
 * handlers. Includes the lifecycle status, ownership fields, and
 * scrollback line count — enough for the client to render a tab without
 * a second round-trip.
 */
export interface SessionInfo {
  readonly kind: TerminalKind
  readonly workspaceId: string
  readonly terminalId: string | null
  readonly parentThreadId: string | null
  readonly parentAgent: string | null
  readonly status: 'running' | 'killing' | 'exited' | 'killed'
  readonly exitCode: number | null
  readonly pid: number
  readonly createdAt: string
}

function agentKey(wsId: string): string {
  return `agent::${wsId}`
}

/**
 * Fixed terminal id for the agent's shell (a stable user-kind session shared by
 * all of a workspace's runs). A fixed id makes it get-or-create + appear once in
 * `listUser`. Plain ascii so it can't collide with a `randomUUID()` user id.
 */
const AGENT_SHELL_ID = 'agent'

function userKey(wsId: string, id: string): string {
  return `user::${wsId}::${id}`
}

function userKeyPrefix(wsId: string): string {
  return `user::${wsId}::`
}

export interface CreateUserResult {
  readonly id: string
  readonly session: PtySession
}

export class TerminalSessionRegistry {
  private readonly entries = new Map<string, Entry>()
  private readonly timeouts = new Map<string, ReturnType<typeof setTimeout>>()
  /** OSC-633 integration nonce per workspace's live agent shell (null shells
   *  that aren't integrated, e.g. non-zsh). Set on spawn, cleared on drop. */
  private readonly agentIntegrations = new Map<string, { readonly nonce: string }>()
  private readonly opts: TerminalSessionRegistryOptions

  constructor(opts: TerminalSessionRegistryOptions) {
    this.opts = opts
  }

  // ── Agent PTY ──────────────────────────────────────────────────────

  /**
   * Return the existing agent session for `workspaceId`, or lazy-spawn
   * one. Returns null when the workspace path cannot be resolved —
   * callers should surface that as a 404 / error, not silently spawn.
   */
  getAgent(workspaceId: string): PtySession | null {
    const key = agentKey(workspaceId)
    const existing = this.entries.get(key)
    if (existing != null && existing.session.exited == null) {
      return existing.session
    }
    if (existing != null) {
      this.cleanupEntry(key, existing)
    }

    const cwd = this.opts.workspaces.getWorkspacePath(workspaceId)
    if (cwd == null) return null

    const session = this.spawn({ cwd })
    const entry = this.attachListeners(session, {
      key,
      workspaceId,
      kind: 'agent',
      terminalId: null,
      parentThreadId: null,
      parentAgent: null,
      notifyOnExit: false,
    })
    this.entries.set(key, entry)
    return session
  }

  /** True when a live agent session exists. Does NOT spawn. */
  hasAgent(workspaceId: string): boolean {
    const entry = this.entries.get(agentKey(workspaceId))
    return entry != null && entry.session.exited == null
  }

  /**
   * True when the workspace id resolves to a path. Used by read-only
   * endpoints so they can return 404 for unknown workspaces without
   * having to call `getAgent` (which would spawn a PTY as a
   * side-effect).
   */
  workspaceExists(workspaceId: string): boolean {
    return this.opts.workspaces.getWorkspacePath(workspaceId) != null
  }

  /**
   * Return the existing agent session without spawning. Used by the
   * output/read endpoint so a read doesn't accidentally warm a PTY
   * the workspace never asked for; the caller renders an empty buffer
   * when this returns null but the workspace itself exists.
   */
  peekAgent(workspaceId: string): PtySession | null {
    const entry = this.entries.get(agentKey(workspaceId))
    if (entry == null) return null
    if (entry.session.exited != null) return null
    return entry.session
  }

  /** Kill + remove the agent session. No-op when absent. */
  dropAgent(workspaceId: string): void {
    const key = agentKey(workspaceId)
    const entry = this.entries.get(key)
    if (entry == null) return
    this.clearTimeout(key)
    entry.session.kill()
    this.cleanupEntry(key, entry)
  }

  // ── User PTYs ──────────────────────────────────────────────────────

  /**
   * Create a new user-kind PTY for the workspace. Returns null when
   * the workspace path cannot be resolved.
   *
   * `owner` lets callers tag the session with the thread / agent that
   * spawned it (see `SessionOwner`). Omit the options object for
   * human-created shells. Agent-spawned shells (via Loom's
   * `shell_execute`, later board items) MUST set both fields so
   * the client can label the tab and `cleanupByThread` can reap it.
   */
  createUser(workspaceId: string, owner?: SessionOwner): CreateUserResult | null {
    if (owner?.timeoutSeconds !== undefined) {
      if (
        !Number.isInteger(owner.timeoutSeconds) ||
        owner.timeoutSeconds <= 0
      ) {
        throw new Error('`timeoutSeconds` must be a positive integer')
      }
    }

    const cwd = this.opts.workspaces.getWorkspacePath(workspaceId)
    if (cwd == null) return null

    const id = randomUUID()
    const key = userKey(workspaceId, id)
    const session = this.spawn({ cwd })
    const entry = this.attachListeners(session, {
      key,
      workspaceId,
      kind: 'user',
      terminalId: id,
      parentThreadId: owner?.parentThreadId ?? null,
      parentAgent: owner?.parentAgent ?? null,
      notifyOnExit: owner?.notifyOnExit ?? false,
    })
    this.entries.set(key, entry)
    if (owner?.timeoutSeconds !== undefined) {
      this.scheduleTimeout(key, owner.timeoutSeconds)
    }
    this.emitCreated(workspaceId, id)
    return { id, session }
  }

  /**
   * Get-or-create the agent's shell as a STABLE user-kind session.
   *
   * This is what Loom's `shell_execute` runs in (via the scoped runner). Making
   * it a `user` session — rather than the dedicated read-only `agent` PTY —
   * means the agent's commands show up in the terminal dock as a normal,
   * interactive tab, indistinguishable from a human one (the unified-terminal
   * decision). The id is fixed (`AGENT_SHELL_ID`) so it's reused across runs and
   * appears once in `listUser`.
   *
   * `parentThreadId: null` keeps it workspace-stable (NOT reaped by
   * `cleanupByThread`) — it lives for the workspace like the old agent PTY did.
   */
  getOrCreateAgentShell(workspaceId: string): PtySession | null {
    const key = userKey(workspaceId, AGENT_SHELL_ID)
    const existing = this.entries.get(key)
    if (existing != null && existing.session.exited == null) {
      return existing.session
    }
    if (existing != null) {
      this.cleanupEntry(key, existing)
    }
    const cwd = this.opts.workspaces.getWorkspacePath(workspaceId)
    if (cwd == null) return null
    // Integrate the shell (OSC-633 markers + clean prompt) when possible (zsh);
    // otherwise spawn normally and the runner uses its Stage-1 fallback.
    const integration = prepareShellIntegration({})
    const session =
      integration != null
        ? this.spawn({ cwd, shell: integration.shell, args: [...integration.args], env: integration.env })
        : this.spawn({ cwd })
    if (integration != null) {
      this.agentIntegrations.set(workspaceId, { nonce: integration.nonce })
    } else {
      this.agentIntegrations.delete(workspaceId)
    }
    const entry = this.attachListeners(session, {
      key,
      workspaceId,
      kind: 'user',
      terminalId: AGENT_SHELL_ID,
      parentThreadId: null,
      parentAgent: 'root',
      notifyOnExit: false,
    })
    this.entries.set(key, entry)
    this.emitCreated(workspaceId, AGENT_SHELL_ID)
    return session
  }

  /**
   * OSC-633 integration for the workspace's LIVE agent shell, or null when it's
   * absent / not integrated. The scoped shell runner calls this per run to pick
   * OSC mode (and the right nonce) vs. its Stage-1 fallback.
   */
  getAgentShellIntegration(workspaceId: string): { readonly nonce: string } | null {
    const entry = this.entries.get(userKey(workspaceId, AGENT_SHELL_ID))
    if (entry == null || entry.session.exited != null) return null
    return this.agentIntegrations.get(workspaceId) ?? null
  }

  /** Announce a new user session on the bus so the multiplexed stream can add a
   *  tab live (no polling). */
  private emitCreated(workspaceId: string, terminalId: string): void {
    this.opts.bus.emit({
      type: 'terminal.created',
      workspaceId,
      kind: 'user',
      terminalId,
      at: new Date().toISOString(),
    })
  }

  /** List live user-PTY ids for a workspace. Dead entries filtered out. */
  listUser(workspaceId: string): readonly string[] {
    const prefix = userKeyPrefix(workspaceId)
    const out: string[] = []
    for (const [key, entry] of this.entries) {
      if (!key.startsWith(prefix)) continue
      if (entry.session.exited != null) continue
      if (entry.terminalId != null) out.push(entry.terminalId)
    }
    return out
  }

  /** Get a specific user PTY by id, or null. Does NOT spawn. */
  getUser(workspaceId: string, id: string): PtySession | null {
    const entry = this.entries.get(userKey(workspaceId, id))
    if (entry == null) return null
    if (entry.session.exited != null) return null
    return entry.session
  }

  /** Kill + remove one user PTY. No-op when absent. */
  dropUser(workspaceId: string, id: string): void {
    const key = userKey(workspaceId, id)
    const entry = this.entries.get(key)
    if (entry == null) return
    this.clearTimeout(key)
    entry.session.kill()
    this.cleanupEntry(key, entry)
  }

  // ── Bulk cleanup ───────────────────────────────────────────────────

  /** Kill every PTY (agent + user) for a single workspace. */
  dropWorkspace(workspaceId: string): void {
    const agentKeyStr = agentKey(workspaceId)
    const prefix = userKeyPrefix(workspaceId)
    const victims: string[] = []
    for (const key of this.entries.keys()) {
      if (key === agentKeyStr || key.startsWith(prefix)) {
        victims.push(key)
      }
    }
    for (const key of victims) {
      const entry = this.entries.get(key)
      if (entry == null) continue
      this.clearTimeout(key)
      entry.session.kill()
      this.cleanupEntry(key, entry)
    }
  }

  /**
   * Kill every session owned by a thread. Called when the thread is
   * closed / deleted so orphan PTYs don't survive the run that
   * spawned them. No-op for threads that never owned any PTY.
   *
   * The per-workspace `agent` PTY is NOT reaped here — it lives for
   * the workspace, not the thread. Use `dropAgent(wsId)` for that.
   */
  cleanupByThread(threadId: string): void {
    const victims: string[] = []
    for (const [key, entry] of this.entries) {
      if (entry.parentThreadId === threadId) {
        victims.push(key)
      }
    }
    for (const key of victims) {
      const entry = this.entries.get(key)
      if (entry == null) continue
      this.clearTimeout(key)
      entry.session.kill()
      this.cleanupEntry(key, entry)
    }
  }

  /** Read-only view of a session by (kind, workspaceId, terminalId). */
  getInfo(
    workspaceId: string,
    kind: TerminalKind,
    terminalId: string | null,
  ): SessionInfo | null {
    const key =
      kind === 'agent'
        ? agentKey(workspaceId)
        : userKey(workspaceId, terminalId ?? '')
    const entry = this.entries.get(key)
    if (entry == null) return null
    return toInfo(entry)
  }

  /** List session info for every live session owned by a thread. */
  listByThread(threadId: string): readonly SessionInfo[] {
    const out: SessionInfo[] = []
    for (const entry of this.entries.values()) {
      if (entry.parentThreadId !== threadId) continue
      out.push(toInfo(entry))
    }
    return out
  }

  /** Kill every live session. Safe to call multiple times. */
  shutdown(): void {
    // Snapshot keys first — cleanupEntry mutates this.entries under
    // iteration.
    for (const key of [...this.entries.keys()]) {
      const entry = this.entries.get(key)
      if (entry == null) continue
      this.clearTimeout(key)
      entry.session.kill()
      this.cleanupEntry(key, entry)
    }
  }

  // ── Internals ──────────────────────────────────────────────────────

  private spawn(options: PtySessionOptions): PtySession {
    const factory =
      this.opts.factory ??
      ((o: PtySessionOptions) => new PtySession(o))
    return factory(options)
  }

  private attachListeners(
    session: PtySession,
    ctx: {
      readonly key: string
      readonly workspaceId: string
      readonly kind: TerminalKind
      readonly terminalId: string | null
      readonly parentThreadId: string | null
      readonly parentAgent: string | null
      readonly notifyOnExit: boolean
    },
  ): Entry {
    const { bus } = this.opts
    const unsubOutput = session.onData((data) => {
      const event: TerminalEvent = {
        type: 'terminal.output',
        workspaceId: ctx.workspaceId,
        kind: ctx.kind,
        terminalId: ctx.terminalId,
        data,
        at: new Date().toISOString(),
      }
      bus.emit(event)
    })
    const unsubExit = session.onExit((info) => {
      const nowIso = new Date().toISOString()
      const payload: TerminalEvent =
        info.signal == null
          ? {
              type: 'terminal.exit',
              workspaceId: ctx.workspaceId,
              kind: ctx.kind,
              terminalId: ctx.terminalId,
              exitCode: info.exitCode,
              at: nowIso,
            }
          : {
              type: 'terminal.exit',
              workspaceId: ctx.workspaceId,
              kind: ctx.kind,
              terminalId: ctx.terminalId,
              exitCode: info.exitCode,
              signal: info.signal,
              at: nowIso,
            }
      bus.emit(payload)

      // Rich `terminal.exited` notification (Item 5). Only fired for
      // sessions flagged `notifyOnExit: true`. Carries `lineCount` +
      // `lastLine` + `timedOut` so the agent's next turn has enough
      // context to act without polling.
      const entryAtExit = this.entries.get(ctx.key)
      if (ctx.notifyOnExit) {
        const scrollback = session.scrollback()
        const { lineCount, lastLine } = summarizeScrollback(scrollback)
        const exited: TerminalEvent = {
          type: 'terminal.exited',
          workspaceId: ctx.workspaceId,
          kind: ctx.kind,
          terminalId: ctx.terminalId,
          exitCode: info.exitCode,
          ...(info.signal != null ? { signal: info.signal } : {}),
          lineCount,
          lastLine,
          timedOut: entryAtExit?.timedOut ?? false,
          at: nowIso,
        }
        bus.emit(exited)
      }

      // Clear any outstanding auto-kill timer (Item 6) and drop the
      // entry so the next lookup starts fresh (agents respawn lazily;
      // user sessions stay gone until createUser is called again).
      this.clearTimeout(ctx.key)
      if (entryAtExit != null && entryAtExit.session === session) {
        this.cleanupEntry(ctx.key, entryAtExit)
      }
    })

    return {
      session,
      kind: ctx.kind,
      workspaceId: ctx.workspaceId,
      terminalId: ctx.terminalId,
      parentThreadId: ctx.parentThreadId,
      parentAgent: ctx.parentAgent,
      notifyOnExit: ctx.notifyOnExit,
      createdAt: new Date().toISOString(),
      unsubscribers: [unsubOutput, unsubExit],
      timedOut: false,
    }
  }

  /**
   * Schedule an auto-kill N seconds from now (Item 6). Idempotent —
   * re-scheduling replaces any prior pending timer for the same key.
   */
  private scheduleTimeout(key: string, timeoutSeconds: number): void {
    this.clearTimeout(key)
    const handle = setTimeout(() => {
      this.timeouts.delete(key)
      const entry = this.entries.get(key)
      if (entry == null) return
      if (entry.session.status !== 'running') return
      entry.timedOut = true
      entry.session.kill()
    }, timeoutSeconds * 1000)
    this.timeouts.set(key, handle)
  }

  private clearTimeout(key: string): void {
    const handle = this.timeouts.get(key)
    if (handle == null) return
    clearTimeout(handle)
    this.timeouts.delete(key)
  }

  private cleanupEntry(key: string, entry: Entry): void {
    for (const off of entry.unsubscribers) off()
    this.entries.delete(key)
  }
}

function toInfo(entry: Entry): SessionInfo {
  return {
    kind: entry.kind,
    workspaceId: entry.workspaceId,
    terminalId: entry.terminalId,
    parentThreadId: entry.parentThreadId,
    parentAgent: entry.parentAgent,
    status: entry.session.status,
    exitCode: entry.session.exited?.exitCode ?? null,
    pid: entry.session.pid,
    createdAt: entry.createdAt,
  }
}

/**
 * Summarize a scrollback string for a `terminal.exited` notification.
 * Returns the total line count (empty-trailing-line aware) and the
 * last non-empty line truncated to the agent-friendly 250-char cap.
 * Enough context for "why did it exit" without bloating the agent's
 * context window.
 */
const LAST_LINE_MAX_CHARS = 250

function summarizeScrollback(scrollback: string): {
  readonly lineCount: number
  readonly lastLine: string | null
} {
  if (scrollback.length === 0) return { lineCount: 0, lastLine: null }
  // Split on \n, strip trailing empty entry, strip \r suffix per
  // line (PTY emits \r\n). Same semantics as
  // `PtySession.splitBufferLines()` — keeping them consistent so
  // agent-facing line counts match between `pty_read` and the
  // notification payload.
  const parts = scrollback.split('\n')
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop()
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!
    if (p.length > 0 && p.charCodeAt(p.length - 1) === 13) {
      parts[i] = p.slice(0, -1)
    }
  }
  // Find the last non-empty line; callers want a useful signal, not
  // a blank final line.
  let last: string | null = null
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i]!.length > 0) {
      last = parts[i]!
      break
    }
  }
  if (last != null && last.length > LAST_LINE_MAX_CHARS) {
    const dropped = last.length - LAST_LINE_MAX_CHARS
    last = `${last.slice(0, LAST_LINE_MAX_CHARS)}… (+${dropped} more chars)`
  }
  return { lineCount: parts.length, lastLine: last }
}
