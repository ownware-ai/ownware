/**
 * ShellRunner — pluggable execution backend for `shell_execute`.
 *
 * When consumers (e.g. Cortex) provide an implementation on
 * `config.shellRunner`, the shell tool routes the already-validated
 * command through it instead of spawning a detached child process.
 * This is the integration seam for running commands in a workspace
 * PTY so the agent and the user share one shell.
 *
 * Security invariant: the runner is called AFTER all guards run
 * (sanitize → validate → permission → env-file check → inline-
 * credential check). It does NOT see or run commands that the
 * security pipeline rejected. Redaction of the runner's output
 * happens back in the tool, with the same pipeline that runs on
 * detached-spawn output.
 *
 * The interface is intentionally minimal: one `run()` call in, one
 * result out. No streaming callback — the PTY already streams to the
 * terminal panel via its own bus; the agent doesn't need delta
 * events, it just needs the final string and exit code.
 */

export interface ShellRunInput {
  /** The command string (already security-validated). */
  readonly command: string
  /** Working directory hint. Implementations may ignore it (the PTY
   *  carries its own cwd). */
  readonly cwd: string
  /** Environment hint. Implementations may ignore it — PTY inherits
   *  the shell's env plus any overlay the session configured. */
  readonly env: Readonly<Record<string, string>>
  /** Per-call timeout in ms. Runner SHOULD kill the command on
   *  expiry (Ctrl+C + prompt recovery for PTY runners). */
  readonly timeoutMs: number
  /** Abort signal. Runner SHOULD observe and interrupt on abort. */
  readonly signal: AbortSignal
}

export interface ShellRunResult {
  /** Captured output (stdout + stderr interleaved) with ANSI
   *  escape sequences stripped. */
  readonly output: string
  /**
   * Exit code of the command. `null` when the command was terminated
   * by signal or the runner couldn't determine it.
   */
  readonly exitCode: number | null
  /**
   * When the runner bailed early (timeout, abort), a machine-readable
   * reason for the tool to surface in its metadata.
   */
  readonly terminated?: 'timeout' | 'aborted' | undefined
}

export interface ShellRunner {
  /**
   * Execute the command. MUST resolve (or reject) — rejections
   * surface as errors in the tool result. Implementations SHOULD NOT
   * throw for timeout/abort; prefer `terminated` on the result so the
   * tool can tag the metadata appropriately.
   */
  run(input: ShellRunInput): Promise<ShellRunResult>
}
