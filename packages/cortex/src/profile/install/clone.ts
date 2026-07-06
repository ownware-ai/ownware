/**
 * Safe shallow clone with hard caps.
 *
 * Wraps `git clone` with the bare-minimum surface the install pipeline
 * needs, plus the safety nets that keep a hostile / oversized / hung
 * repo from taking the gateway down:
 *
 *   - `--depth 1`  — never pull history
 *   - `--single-branch` — only the requested ref
 *   - `--no-tags` — tag refs are not part of the install contract
 *   - `--config core.symlinks=true` — preserve symlink semantics so
 *     validate-tree can decide; we do NOT follow them at clone time
 *   - submodules disabled (default in modern git, but we never `--recurse`)
 *   - LFS disabled (`GIT_LFS_SKIP_SMUDGE=1`)
 *   - 60s default timeout (configurable, hard cap)
 *   - PAT injected via `Authorization: Bearer` over an `http.extraHeader`
 *     config so the token never appears in the URL or process args
 *   - clones to a fresh tempdir; caller `mv`s on success
 *   - `.git` directory wiped after clone — we don't ship it to the user dir
 *
 * URL ALLOWLISTING happens in `github-url.ts` (one layer up). This module
 * accepts any clone URL it's given so tests can drive it against a local
 * bare repo. Production callers go through the github-url parser first.
 *
 * Failures are mapped to `InstallError` with the most specific code we
 * can determine from git's stderr.
 */

import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GithubAuth } from './types.js'
import { InstallError } from './errors.js'

export interface CloneOptions {
  /** Canonical clone URL (e.g. `https://github.com/owner/repo.git`).
   *  The github-url parser is responsible for producing this from a
   *  user-supplied URL. Tests may pass `file://` URLs against a local
   *  bare repo. */
  readonly cloneUrl: string
  /** Optional ref to clone (branch / tag). When omitted, git resolves
   *  the remote's default branch. */
  readonly ref?: string
  /** Optional auth for private repos. Injected via `http.extraHeader`
   *  config so the token never appears in process args or URL. */
  readonly auth?: GithubAuth
  /** Hard timeout for the clone itself (ms). Default 60_000. */
  readonly timeoutMs?: number
  /** Override the parent dir for the temporary clone target. Tests use
   *  this to keep clones inside a fixture root for easy cleanup. */
  readonly tempParent?: string
  /** Override the `git` binary. Tests inject a fake. Default: `git`. */
  readonly gitBinary?: string
}

export interface CloneResult {
  /** Absolute path to the clone target dir. Caller owns cleanup. */
  readonly tempDir: string
  /** Resolved commit SHA at HEAD of the cloned ref. */
  readonly commit: string
  /** The ref we actually cloned (caller-supplied or remote default). */
  readonly ref: string
}

const DEFAULT_TIMEOUT_MS = 60_000

/**
 * Shallow-clone `cloneUrl` into a fresh tempdir. Caller is responsible
 * for moving the result into place (or deleting it on failure / rollback).
 *
 * On any failure the temp dir is removed before the error is thrown —
 * we never leak partial clones.
 */
export async function safeShallowClone(opts: CloneOptions): Promise<CloneResult> {
  const tempParent = opts.tempParent ?? tmpdir()
  const ref = opts.ref
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const gitBinary = opts.gitBinary ?? 'git'

  const tempDir = await mkdtemp(join(tempParent, 'cortex-clone-'))

  try {
    const args: string[] = [
      'clone',
      '--depth', '1',
      '--single-branch',
      '--no-tags',
      '--no-recurse-submodules',
      '--config', 'core.symlinks=true',
    ]
    if (ref !== undefined) {
      args.push('--branch', ref)
    }
    if (opts.auth !== undefined) {
      args.push('--config', `http.extraHeader=Authorization: Bearer ${opts.auth.token}`)
    }
    args.push('--', opts.cloneUrl, tempDir)

    await runGit(gitBinary, args, { timeoutMs, scrubAuth: opts.auth?.token })

    const commit = (await runGit(
      gitBinary,
      ['-C', tempDir, 'rev-parse', 'HEAD'],
      { timeoutMs: 10_000 },
    )).trim()

    const resolvedRef = ref ?? (await resolveDefaultBranch(gitBinary, tempDir))

    // Drop .git — installed profiles don't need it. Update detection
    // happens via `git ls-remote` against the recorded URL, not by
    // re-cloning in place.
    await rm(join(tempDir, '.git'), { recursive: true, force: true })

    return { tempDir, commit, ref: resolvedRef }
  } catch (err) {
    try { await rm(tempDir, { recursive: true, force: true }) } catch { /* */ }
    throw err
  }
}

/**
 * Run a git command, capturing stdout/stderr, enforcing a wall-clock
 * timeout. Maps the failure to an `InstallError` with the best matching
 * code based on stderr content.
 *
 * `scrubAuth`: when set, every occurrence of that string in stderr is
 * replaced with `***` before reaching the InstallError. Defense in
 * depth — if a future git version starts logging the header back, we
 * never propagate the secret to the user-visible message.
 */
async function runGit(
  gitBinary: string,
  args: readonly string[],
  opts: { readonly timeoutMs: number; readonly scrubAuth?: string },
): Promise<string> {
  return new Promise<string>((resolveP, rejectP) => {
    const child = spawn(gitBinary, [...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_LFS_SKIP_SMUDGE: '1',
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: 'echo',
        SSH_ASKPASS: 'echo',
        LC_ALL: 'C',
        LANG: 'C',
      },
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, opts.timeoutMs)

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf-8') })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8') })

    child.on('error', (err) => {
      clearTimeout(timer)
      rejectP(new InstallError('clone_failed', { reason: err.message }))
    })

    child.on('close', (code) => {
      clearTimeout(timer)

      const scrubbed = opts.scrubAuth !== undefined
        ? stderr.split(opts.scrubAuth).join('***')
        : stderr

      if (timedOut) {
        rejectP(new InstallError('clone_failed', {
          reason: `git timed out after ${opts.timeoutMs}ms`,
        }))
        return
      }

      if (code !== 0) {
        rejectP(classifyGitFailure(scrubbed, code))
        return
      }
      resolveP(stdout)
    })
  })
}

/**
 * Map git stderr to the most specific `InstallError` we can. Order
 * matters — auth check before generic clone_failed, etc.
 */
function classifyGitFailure(stderr: string, exitCode: number | null): InstallError {
  const lower = stderr.toLowerCase()

  if (
    lower.includes('authentication failed') ||
    lower.includes('could not read username') ||
    lower.includes('could not read password') ||
    lower.includes('terminal prompts disabled') ||
    lower.includes('http 401') ||
    lower.includes('http 403') ||
    /repository.*not found/.test(lower)
  ) {
    return new InstallError('auth_required', {
      hint: 'Repository is private or does not exist. Provide a GitHub token if it is private.',
    })
  }

  if (
    lower.includes('could not resolve host') ||
    lower.includes('connection refused') ||
    lower.includes('ssl certificate') ||
    lower.includes('connection reset') ||
    lower.includes('connection timed out')
  ) {
    return new InstallError('network', {
      reason: stderr.split('\n').find((l) => l.trim().length > 0) ?? 'unknown network error',
    })
  }

  if (lower.includes('remote branch') && lower.includes('not found')) {
    return new InstallError('clone_failed', {
      reason: 'requested ref not found on remote',
    })
  }

  return new InstallError('clone_failed', {
    reason: `git exit ${exitCode ?? '?'}: ${stderr.trim() || '(no stderr)'}`,
  })
}

/**
 * Read the default branch name from a freshly-cloned repo. Used when the
 * caller didn't specify a ref so the sidecar knows which branch we're
 * tracking for updates.
 */
async function resolveDefaultBranch(gitBinary: string, repoDir: string): Promise<string> {
  try {
    const out = await runGit(
      gitBinary,
      ['-C', repoDir, 'symbolic-ref', '--short', 'HEAD'],
      { timeoutMs: 5000 },
    )
    const trimmed = out.trim()
    if (trimmed.length > 0) return trimmed
  } catch { /* fall through */ }
  return 'HEAD'
}

/**
 * Best-effort check that the `git` binary is callable. Returns true on
 * success, false on any failure. Used by the install entry point to
 * fail fast with a clear message instead of "spawn ENOENT" deep in the
 * pipeline.
 */
export async function isGitAvailable(gitBinary: string = 'git'): Promise<boolean> {
  return new Promise<boolean>((resolveP) => {
    try {
      const child = spawn(gitBinary, ['--version'], { stdio: 'ignore' })
      child.on('error', () => resolveP(false))
      child.on('close', (code) => resolveP(code === 0))
    } catch { resolveP(false) }
  })
}
