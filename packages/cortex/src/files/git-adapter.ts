/**
 * GitAdapter — thin, arg-safe async wrapper over `spawn('git', [...])`.
 *
 * Exposes exactly what the Files panel needs:
 *   - `isGitRepo(root)` — true when `<root>/.git` exists as a git dir.
 *   - `listStatus(root)` — parsed `git status --porcelain=v1 -z`.
 *   - `loadDiff(root, relPath, side)` — unified diff text for one
 *     path, either the working-tree (`unstaged`) or index (`staged`).
 *
 * All commands use `spawn('git', [...args, '--', path])` with the
 * `--` sentinel so a path that starts with `-` is never parsed as a
 * flag. We never concatenate strings into a shell command.
 *
 * Timeouts are enforced per-call; a stalled git process is killed
 * to keep the gateway free of zombie children.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { isBlockedFilePath } from '@ownware/loom'
import type { FileEntry } from './files-event-bus.js'

// ---------------------------------------------------------------------------
// Constants + typed errors
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 5_000
const IS_REPO_TIMEOUT_MS = 2_000
const DIFF_SIZE_CAP_BYTES = 1024 * 1024 // 1 MiB — matches instructions §F hard cap.

export class GitSpawnError extends Error {
  readonly kind = 'spawn_failed' as const
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'GitSpawnError'
  }
}

export class PathTraversalError extends Error {
  readonly kind = 'path_traversal' as const
  constructor(readonly relPath: string) {
    super(`Path escapes workspace root: ${relPath}`)
    this.name = 'PathTraversalError'
  }
}

export class BlockedPathError extends Error {
  readonly kind = 'blocked_path' as const
  constructor(readonly relPath: string) {
    super(`Path is blocked from diff rendering: ${relPath}`)
    this.name = 'BlockedPathError'
  }
}

export class PathNotFoundError extends Error {
  readonly kind = 'not_found' as const
  constructor(readonly relPath: string) {
    super(`Path not found in workspace: ${relPath}`)
    this.name = 'PathNotFoundError'
  }
}

// ---------------------------------------------------------------------------
// spawn helper — all git invocations go through here
// ---------------------------------------------------------------------------

interface SpawnResult {
  readonly stdout: Buffer
  readonly stderr: string
  readonly exitCode: number | null
  readonly truncated: boolean
}

function spawnGit(
  args: readonly string[],
  opts: { timeoutMs?: number; maxStdoutBytes?: number } = {},
): Promise<SpawnResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxStdout = opts.maxStdoutBytes ?? Number.POSITIVE_INFINITY

  return new Promise<SpawnResult>((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawn('git', [...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      reject(new GitSpawnError('Failed to spawn git', err))
      return
    }
    const stdout = child.stdout
    const stderrStream = child.stderr
    if (stdout == null || stderrStream == null) {
      reject(new GitSpawnError('git spawned without stdio pipes'))
      return
    }

    const stdoutChunks: Buffer[] = []
    let stdoutSize = 0
    let truncated = false
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill('SIGKILL')
      } catch {
        // already gone
      }
      reject(new GitSpawnError(`git ${args[0] ?? '?'} timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    stdout.on('data', (chunk: Buffer) => {
      if (stdoutSize >= maxStdout) {
        truncated = true
        return
      }
      const room = maxStdout - stdoutSize
      if (chunk.length > room) {
        stdoutChunks.push(chunk.subarray(0, room))
        stdoutSize += room
        truncated = true
      } else {
        stdoutChunks.push(chunk)
        stdoutSize += chunk.length
      }
    })
    stderrStream.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new GitSpawnError('git child process error', err))
    })
    child.on('close', (exitCode) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        stdout: Buffer.concat(stdoutChunks),
        stderr,
        exitCode,
        truncated,
      })
    })
  })
}

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

/**
 * Resolve `relPath` against `root`, refusing any result outside the
 * root directory (path traversal defense). Returns the absolute path
 * on success, throws `PathTraversalError` on violation.
 */
export function resolveInsideRoot(root: string, relPath: string): string {
  const absRoot = resolve(root)
  const absTarget = resolve(absRoot, relPath)
  const rootWithSep = absRoot.endsWith(sep) ? absRoot : absRoot + sep
  if (absTarget !== absRoot && !absTarget.startsWith(rootWithSep)) {
    throw new PathTraversalError(relPath)
  }
  return absTarget
}

// ---------------------------------------------------------------------------
// Porcelain parser
// ---------------------------------------------------------------------------

/**
 * Parse the payload of `git status --porcelain=v1 -z` into a flat
 * `FileEntry[]`.
 *
 * Record layout (per `git status --help`):
 *   - Each record is `XY <path>\0` where `X` is the index status and
 *     `Y` is the worktree status.
 *   - `R` or `C` records append a second `<oldPath>\0` after the
 *     primary `<newPath>\0`. We detect them at `XY === 'R '` etc.
 *     and consume a second NUL-delimited field.
 *
 * Emits ONE entry per record, even when both index and worktree
 * changed — the `staged` flag picks the side. If both sides changed,
 * we emit two entries (staged + unstaged) so the client can show the
 * file in both the Staged and Changes groups.
 */
export function parsePorcelainV1(payload: Buffer): FileEntry[] {
  // `-z` uses NUL separators, but the parser consumes specific byte
  // counts (XY + space + path) rather than split-all-on-NUL so
  // rename pairs are handled correctly.
  const text = payload.toString('utf8')
  const entries: FileEntry[] = []
  let i = 0
  const len = text.length

  while (i < len) {
    // Each non-rename record starts with "XY ", 3 bytes.
    if (i + 3 > len) break
    const x = text[i]!
    const y = text[i + 1]!
    const space = text[i + 2]!
    if (space !== ' ') {
      // Malformed — skip to the next NUL to resync.
      const nextNul = text.indexOf('\0', i)
      if (nextNul < 0) break
      i = nextNul + 1
      continue
    }
    i += 3

    // Read path up to the next NUL.
    const nulAt = text.indexOf('\0', i)
    if (nulAt < 0) break
    const path = text.slice(i, nulAt)
    i = nulAt + 1

    // Rename / copy records have a second NUL-delimited field: oldPath.
    let oldPath: string | undefined
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      const nul2 = text.indexOf('\0', i)
      if (nul2 < 0) break
      oldPath = text.slice(i, nul2)
      i = nul2 + 1
    }

    // Classify.
    if (x === '?' && y === '?') {
      entries.push({ path, status: 'untracked', staged: false })
      continue
    }

    // Merge conflicts: DD, AU, UD, UA, DU, AA, UU → conflict.
    if (
      (x === 'U' || y === 'U') ||
      (x === 'A' && y === 'A') ||
      (x === 'D' && y === 'D')
    ) {
      entries.push({ path, status: 'conflict', staged: false })
      continue
    }

    const classify = (c: string): FileEntry['status'] | null => {
      switch (c) {
        case 'M': return 'modified'
        case 'A': return 'added'
        case 'D': return 'deleted'
        case 'R': return 'renamed'
        case 'C': return 'copied'
        default: return null
      }
    }

    const stagedStatus = classify(x)
    const worktreeStatus = classify(y)

    if (stagedStatus != null) {
      const entry: FileEntry =
        oldPath != null && (stagedStatus === 'renamed' || stagedStatus === 'copied')
          ? { path, status: stagedStatus, staged: true, renamedFrom: oldPath }
          : { path, status: stagedStatus, staged: true }
      entries.push(entry)
    }
    if (worktreeStatus != null) {
      const entry: FileEntry =
        oldPath != null && (worktreeStatus === 'renamed' || worktreeStatus === 'copied')
          ? { path, status: worktreeStatus, staged: false, renamedFrom: oldPath }
          : { path, status: worktreeStatus, staged: false }
      entries.push(entry)
    }
  }

  return entries
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type DiffSide = 'unstaged' | 'staged'

export interface LoadDiffResult {
  readonly diff: string
  readonly truncated: boolean
  readonly kind: 'diff' | 'new-file'
}

export interface GitAdapter {
  isGitRepo(root: string): Promise<boolean>
  listStatus(root: string): Promise<FileEntry[]>
  loadDiff(root: string, relPath: string, side: DiffSide): Promise<LoadDiffResult>
  /**
   * The file's content at HEAD (`git show HEAD:<relPath>`), or `null` when the
   * path isn't in HEAD (new/untracked file). Used as the "original" side of the
   * Monaco diff editor. Path-safety checked before shelling out.
   */
  showHead(root: string, relPath: string): Promise<string | null>
}

export function createGitAdapter(): GitAdapter {
  return {
    async isGitRepo(root: string): Promise<boolean> {
      try {
        const res = await spawnGit(['-C', root, 'rev-parse', '--git-dir'], {
          timeoutMs: IS_REPO_TIMEOUT_MS,
        })
        return res.exitCode === 0
      } catch (err) {
        if (err instanceof GitSpawnError) return false
        throw err
      }
    },

    async listStatus(root: string): Promise<FileEntry[]> {
      // Speed flags (matching what VS Code's Git extension uses):
      //
      //   `--no-optional-locks`
      //     Skips `index.lock` acquisition. If another git process
      //     is running (e.g. the user is committing in their
      //     terminal), we don't serialize against it. Safe because
      //     we're read-only.
      //
      //   `--ignore-submodules=all`
      //     On monorepos with submodules (even if unused),
      //     recursing into each submodule to compute its status
      //     is a multi-second hit. We don't show submodule-
      //     internal changes in the panel anyway.
      //
      //   Default `git status --porcelain=v1 -z` reports renames as
      //   `R <new>\0<old>` pairs; we parse that shape in
      //   `parsePorcelainV1`.
      const res = await spawnGit([
        '--no-optional-locks',
        '-C', root,
        'status',
        '--porcelain=v1',
        '-z',
        '--ignore-submodules=all',
      ])
      if (res.exitCode !== 0) {
        throw new GitSpawnError(
          `git status exited with ${String(res.exitCode)}: ${res.stderr.trim()}`,
        )
      }
      return parsePorcelainV1(res.stdout)
    },

    async loadDiff(root: string, relPath: string, side: DiffSide): Promise<LoadDiffResult> {
      // 1. Path safety — defense in depth. The service layer ALSO
      //    runs these checks, but we repeat here so any future caller
      //    (internal scripts, tests) is safe by default.
      const absTarget = resolveInsideRoot(root, relPath)
      if (isBlockedFilePath(absTarget)) {
        throw new BlockedPathError(relPath)
      }

      // 2. Does the target exist? If not, caller wants 404 — but we
      //    also want this check AFTER the traversal/blocked checks so
      //    an attacker can't probe for file existence.
      let exists = true
      try {
        await stat(absTarget)
      } catch {
        exists = false
      }
      if (!exists) {
        throw new PathNotFoundError(relPath)
      }

      // 3. Figure out whether git knows about the path. Untracked
      //    files: synthesise a new-file diff.
      const lsRes = await spawnGit([
        '-C', root,
        'ls-files', '--error-unmatch', '--', relPath,
      ])
      const isTracked = lsRes.exitCode === 0

      if (!isTracked) {
        // Synthetic diff for an untracked file. The user sees every
        // line as an add; consistent with "new file" in git diff.
        const content = await readFile(absTarget)
        const truncated = content.length > DIFF_SIZE_CAP_BYTES
        const slice = truncated ? content.subarray(0, DIFF_SIZE_CAP_BYTES) : content
        const text = slice.toString('utf8')
        const lines = text.length === 0 ? [] : text.split('\n')
        // Strip a trailing empty element from a file that ends with \n
        // so we don't render a spurious blank add-line at the end.
        if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
        const body = lines.map((l) => `+${l}`).join('\n')
        const header =
          `--- /dev/null\n` +
          `+++ b/${relPath}\n` +
          `@@ -0,0 +1,${lines.length} @@\n`
        return {
          diff: header + body + (body.length > 0 ? '\n' : ''),
          truncated,
          kind: 'new-file',
        }
      }

      // 4. Tracked file — shell out to `git diff`.
      // `--no-optional-locks` prevents serializing behind any
      // concurrent git process the user may have running; safe
      // because we're read-only.
      const args =
        side === 'staged'
          ? ['--no-optional-locks', '-C', root, 'diff', '--no-color', '--cached', '--', relPath]
          : ['--no-optional-locks', '-C', root, 'diff', '--no-color', '--', relPath]
      const res = await spawnGit(args, {
        maxStdoutBytes: DIFF_SIZE_CAP_BYTES,
      })
      if (res.exitCode !== 0) {
        throw new GitSpawnError(
          `git diff exited with ${String(res.exitCode)}: ${res.stderr.trim()}`,
        )
      }
      return {
        diff: res.stdout.toString('utf8'),
        truncated: res.truncated,
        kind: 'diff',
      }
    },

    async showHead(root: string, relPath: string): Promise<string | null> {
      // Path safety — defense in depth (the service layer also checks).
      const absTarget = resolveInsideRoot(root, relPath)
      if (isBlockedFilePath(absTarget)) {
        throw new BlockedPathError(relPath)
      }
      // `git show HEAD:<path>` expects a repo-relative, forward-slash path.
      const res = await spawnGit(
        ['-C', root, 'show', `HEAD:${relPath}`],
        { maxStdoutBytes: DIFF_SIZE_CAP_BYTES },
      )
      // Non-zero exit = path not in HEAD (new file) or no commits yet — the
      // caller treats null as "no original side" (renders as all-additions).
      if (res.exitCode !== 0) return null
      return res.stdout.toString('utf8')
    },
  }
}

// Exported only for tests that want to exercise the parser directly.
export const __testables = {
  spawnGit,
  resolveInsideRoot,
  DIFF_SIZE_CAP_BYTES,
} as const
