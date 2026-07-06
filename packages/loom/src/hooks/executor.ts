/**
 * Hook Executor
 *
 * Per-spec execution. `fn` hooks run in-process with a timeout; `command`
 * hooks spawn a child process, pipe the context to stdin as JSON, and
 * interpret stdout / exit code.
 *
 * Convention for command hooks (lenient — the standard shell-hook
 * contract: exit code decides, stdout JSON upgrades to structured):
 *   - stdout starts with `{` and parses as JSON  →  treated as a HookResult
 *   - exit code 0, stdout non-JSON              →  `{ continue: true, output: stdout }`
 *   - exit code != 0                            →  `{ continue: false, reason: stderr || "exit N", output: stdout? }`
 *
 * A timeout always blocks the action; the hook owner can lengthen the
 * window with `timeoutMs` per spec.
 */

import { spawn } from 'node:child_process'
import type { HookContext, HookFn, HookResult, HookSpec } from './types.js'

const DEFAULT_TIMEOUT_MS = 5_000

/**
 * Execute a single hook with a timeout. Always resolves — never throws.
 * On timeout, internal error, or external abort the result is
 * `{ continue: false, reason }` so the runtime can block uniformly.
 */
export async function executeHook(
  spec: HookSpec,
  ctx: HookContext,
  signal?: AbortSignal,
): Promise<HookResult> {
  const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS
  switch (spec.type) {
    case 'fn':
      return executeFnHook(spec.fn, ctx, timeoutMs, signal)
    case 'command':
      return executeCommandHook(spec.command, ctx, timeoutMs, signal)
  }
}

// ---------------------------------------------------------------------------
// fn hooks
// ---------------------------------------------------------------------------

async function executeFnHook(
  fn: HookFn,
  ctx: HookContext,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<HookResult> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null
  try {
    const timeoutPromise = new Promise<HookResult>((resolve) => {
      timeoutHandle = setTimeout(
        () => resolve({ continue: false, reason: `Hook timed out after ${timeoutMs}ms` }),
        timeoutMs,
      )
    })

    const abortPromise = externalSignal
      ? new Promise<HookResult>((resolve) => {
          if (externalSignal.aborted) {
            resolve({ continue: false, reason: 'Hook aborted before start' })
            return
          }
          externalSignal.addEventListener(
            'abort',
            () => resolve({ continue: false, reason: 'Hook aborted' }),
            { once: true },
          )
        })
      : null

    // Defer the fn call inside `.then()` so that a synchronous throw
    // (the common case for `() => { throw ... }`) is caught here rather
    // than escaping past Promise.resolve.
    const fnPromise = Promise.resolve()
      .then(() => fn(ctx))
      .catch(
        (err: unknown): HookResult => ({
          continue: false,
          reason: err instanceof Error ? err.message : String(err),
        }),
      )

    const candidates: Array<Promise<HookResult>> = [fnPromise, timeoutPromise]
    if (abortPromise) candidates.push(abortPromise)
    return await Promise.race(candidates)
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
  }
}

// ---------------------------------------------------------------------------
// command hooks
// ---------------------------------------------------------------------------

async function executeCommandHook(
  command: string,
  ctx: HookContext,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<HookResult> {
  return new Promise((resolve) => {
    let settled = false
    const settle = (result: HookResult) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, [], { shell: true, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (err) {
      settle({ continue: false, reason: err instanceof Error ? err.message : String(err) })
      return
    }

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []

    const timeoutHandle = setTimeout(() => {
      child.kill('SIGKILL')
      settle({ continue: false, reason: `Hook timed out after ${timeoutMs}ms` })
    }, timeoutMs)

    const onAbort = () => {
      child.kill('SIGKILL')
      settle({ continue: false, reason: 'Hook aborted' })
    }
    if (externalSignal) {
      if (externalSignal.aborted) {
        clearTimeout(timeoutHandle)
        child.kill('SIGKILL')
        settle({ continue: false, reason: 'Hook aborted before start' })
        return
      }
      externalSignal.addEventListener('abort', onAbort, { once: true })
    }

    child.stdout?.on('data', (d: Buffer) => stdoutChunks.push(d))
    child.stderr?.on('data', (d: Buffer) => stderrChunks.push(d))

    child.on('error', (err) => {
      clearTimeout(timeoutHandle)
      settle({ continue: false, reason: err.message })
    })

    child.on('close', (code) => {
      clearTimeout(timeoutHandle)
      const stdout = Buffer.concat(stdoutChunks).toString('utf8').trim()
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim()

      const parsed = tryParseHookResult(stdout)
      if (parsed) {
        settle(parsed)
        return
      }

      if (code === 0) {
        settle(stdout.length > 0 ? { continue: true, output: stdout } : { continue: true })
      } else {
        settle({
          continue: false,
          reason: stderr.length > 0 ? stderr : `Hook exited with code ${code ?? 'unknown'}`,
          ...(stdout.length > 0 ? { output: stdout } : {}),
        })
      }
    })

    // The child may close its stdin read-end before (or while) we write —
    // `echo`-style commands that ignore stdin exit immediately. That makes
    // the write fail ASYNCHRONOUSLY with EPIPE, surfaced as an 'error' event
    // on the stdin stream rather than a throw from `.write()`. With no
    // listener, Node treats it as an unhandled exception and can take down
    // the process. Swallow it — the child's 'close'/'error' handlers above
    // decide the hook's outcome from the exit code and captured output.
    child.stdin?.on('error', () => {})

    try {
      child.stdin?.write(JSON.stringify(ctx))
      child.stdin?.end()
    } catch {
      // child may already have exited (e.g. command not found). The 'error'
      // / 'close' handlers above will settle the promise either way.
    }
  })
}

function tryParseHookResult(stdout: string): HookResult | null {
  if (stdout.length === 0 || stdout[0] !== '{') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const obj = parsed as Record<string, unknown>
  return {
    ...(typeof obj.continue === 'boolean' ? { continue: obj.continue } : {}),
    ...(typeof obj.reason === 'string' ? { reason: obj.reason } : {}),
    ...(typeof obj.output === 'string' ? { output: obj.output } : {}),
    ...(typeof obj.additionalContext === 'string' ? { additionalContext: obj.additionalContext } : {}),
  }
}
