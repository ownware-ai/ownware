/**
 * ShellSessionClient — pluggable backend for the persistent-shell
 * actions of `shell_execute` (spawn / read / write / signal / list /
 * kill). Parallel to `ShellRunner` (one-shot runs) — one interface
 * per lifecycle flavour so callers can mix and match.
 *
 * Host packages (Cortex) provide an implementation on
 * `config.shellSessionClient`. The Loom tool calls the interface; it
 * does NOT know about HTTP, SSE, PTYs, or the gateway. This keeps
 * Loom's "depends on nothing" rule intact — a Loom tool that spoke
 * HTTP directly would pull in network concerns Loom has no business
 * owning.
 *
 * Security invariant: session-action paths in `shell_execute` run
 * the SAME input-sanitization + validation pipeline as `run`
 * (the one-shot path). Only the execute step differs. Output going
 * back to the agent is redacted identically — the session buffer
 * can still contain secrets if the user typed them, or if a command
 * echoed them to stdout.
 *
 * Contract:
 *   - All methods are async. Rejections surface as errors in the
 *     tool result.
 *   - Implementations MUST NOT block longer than is needed to reach
 *     the underlying registry — the tool's own timeout handling is
 *     separate.
 *   - `list` returns every session visible to the caller's scope.
 *     Cortex's implementation filters to the calling thread's PTYs,
 *     so the agent never sees sessions from another thread or
 *     workspace.
 */

export type ShellSessionStatus = 'running' | 'killing' | 'exited' | 'killed'

export type ShellSessionSignal = 'SIGINT' | 'SIGTERM' | 'SIGKILL'

export interface ShellSessionInfo {
  readonly id: string
  readonly status: ShellSessionStatus
  /** null while running; set on exit. */
  readonly exitCode: number | null
  readonly pid: number
  readonly createdAt: string
  readonly parentThreadId: string | null
  readonly parentAgent: string | null
}

/** One line of session output, 1-based line number preserved. */
export interface ShellSessionLine {
  readonly lineNumber: number
  readonly text: string
  /** Set when the line was clipped (> 2000 chars) before being
   *  returned, so the agent knows bytes were dropped. */
  readonly truncated?: boolean
}

export interface ShellSessionReadResult {
  readonly lines: readonly ShellSessionLine[]
  /** Total lines in the buffer, OR total matches when `pattern` was
   *  set — pagination applies to whichever the filter produced. */
  readonly totalLines: number
  readonly offset: number
  readonly hasMore: boolean
  /** Echo of the applied filter, or null if none. */
  readonly filter: {
    readonly pattern: string
    readonly ignoreCase: boolean
    readonly matchCount: number
  } | null
}

export interface ShellSessionSpawnInput {
  /** The command the session will run. Passed through the shell the
   *  registry's PTY was configured with. Example: "npm run dev". */
  readonly command: string
  /**
   * When true, the registry emits `terminal.exited` on exit with
   * `lineCount` + `lastLine`. Use for long-running commands that
   * are expected to finish (builds, tests, migrations). Do NOT use
   * for sessions meant to keep running (dev servers, watch modes,
   * REPLs) — pair with a read-after-notification pattern instead.
   */
  readonly notifyOnExit?: boolean
  /**
   * Auto-kill the session after N seconds. Positive integer. Omit
   * for sessions meant to keep running indefinitely. Recommended
   * for builds / tests / migrations so a runaway process can't hold
   * the budget open forever.
   */
  readonly timeoutSeconds?: number
  /** Human-readable title for UI tabs. Falls back to the command. */
  readonly title?: string
}

export interface ShellSessionReadInput {
  readonly id: string
  /** 0-based line offset. When `pattern` is set, paginates MATCHES. */
  readonly offset?: number
  /** Max lines to return per call. Hard-capped by the gateway. */
  readonly limit?: number
  /** Optional regex source. Server compiles + validates. */
  readonly pattern?: string
  readonly ignoreCase?: boolean
}

/**
 * Same shape as `ShellSessionReadInput` minus `id` — the workspace's
 * agent PTY is singular (no id needed). Used by `readAgent()` so the
 * agent can paginate its own tab's scrollback on demand instead of
 * relying on recall from prior tool_results (which compound context
 * cost across turns).
 */
export interface ShellSessionReadAgentInput {
  readonly offset?: number
  readonly limit?: number
  readonly pattern?: string
  readonly ignoreCase?: boolean
}

export interface ShellSessionWriteInput {
  readonly id: string
  /** Raw bytes to write to the session's stdin. Include `\n` to
   *  press Enter; include `\x03` to send Ctrl+C (or use `signal`). */
  readonly data: string
}

export interface ShellSessionSignalInput {
  readonly id: string
  readonly signal: ShellSessionSignal
}

/**
 * Offloaded buffer dump response. Returned by `dump` when the agent
 * wants a file on disk instead of the full buffer inlined into its
 * context window. Mirrors Anthropic's effective-context-engineering
 * rule: "when tool output > 20K tokens, offload to the filesystem
 * and return a file path + a small preview."
 */
export interface ShellSessionDumpResult {
  /** Absolute path the gateway wrote to. Under `~/.ownware/sessions/`. */
  readonly path: string
  /** UTF-8 byte length of the dumped buffer. */
  readonly byteLength: number
  /** Total lines after `\r\n` normalization. */
  readonly lineCount: number
  /** First N lines (N = 20 today) so the agent has context without
   *  having to open the file unless it needs more. */
  readonly preview: readonly ShellSessionLine[]
}

/**
 * Pluggable backend for `shell_execute`'s session actions. The Loom
 * tool depends on this interface — NOT on the concrete Cortex gateway
 * implementation.
 */
export interface ShellSessionClient {
  /** Create a new persistent shell session. Returns its id + info. */
  spawn(input: ShellSessionSpawnInput): Promise<{
    readonly id: string
    readonly info: ShellSessionInfo
  }>

  /** Paginated, optionally regex-filtered read of the session buffer. */
  read(input: ShellSessionReadInput): Promise<ShellSessionReadResult>

  /**
   * Paginated, optionally regex-filtered read of the **workspace agent
   * PTY's** scrollback — the pinned "Agent" tab in the UI client. Unlike
   * `read` (which addresses a user-kind session by id), `readAgent`
   * targets the single workspace-scoped agent terminal. Lets the
   * agent re-pull its own prior command output instead of relying
   * on recall from conversation history — critical when the answer
   * lived in a tool_result that's been compacted or dropped.
   */
  readAgent(input: ShellSessionReadAgentInput): Promise<ShellSessionReadResult>

  /** Write raw bytes to the session's stdin. */
  write(input: ShellSessionWriteInput): Promise<void>

  /**
   * Deliver a POSIX signal. `SIGINT` is the safe default for stopping
   * a foreground command (the tty line discipline forwards it to the
   * process group). `SIGTERM`/`SIGKILL` kill the shell itself.
   */
  signal(input: ShellSessionSignalInput): Promise<void>

  /** List every session visible to the caller. */
  list(): Promise<readonly ShellSessionInfo[]>

  /** Hard-kill + drop a session. Equivalent to closing the tab. */
  kill(id: string): Promise<void>

  /**
   * Dump the full session buffer to disk and return the path + a
   * small preview. Use when the buffer is large enough to pollute
   * the agent's context window — the file stays on disk and the
   * agent can re-read specific windows with `read` or hand the path
   * to another tool.
   */
  dump(id: string): Promise<ShellSessionDumpResult>
}
