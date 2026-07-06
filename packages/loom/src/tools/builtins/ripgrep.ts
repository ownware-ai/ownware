/**
 * Ripgrep dispatcher for the `grep` builtin.
 *
 * Uses the `@vscode/ripgrep` bundled binary — postinstall downloads the right
 * binary per platform, so no manual install is needed.
 *
 * Exposes a single `runRipgrep()` that returns parsed matches OR throws so the
 * caller can fall back to the JS walker. Never fails silently.
 *
 * @security
 *   - Binary path is resolved from the shipped module — no PATH lookup, so
 *     PATH hijack (e.g. a malicious `rg` in CWD) cannot redirect us.
 *   - Output is hard-capped at `maxBytes` bytes to prevent OOM on pathological
 *     queries (e.g. searching for "a" in a huge tree).
 *   - Child process is killed on AbortSignal.
 */

import { spawn } from 'node:child_process'
import * as fs from 'node:fs/promises'
import { rgPath as vscodeRgPath } from '@vscode/ripgrep'
import { BLOCKED_FILE_GLOBS } from '../../credentials/patterns.js'

export interface RipgrepOptions {
  readonly pattern: string
  readonly cwd: string
  readonly fixedStrings: boolean
  readonly multiline: boolean
  readonly caseSensitive: boolean
  readonly includeHidden: boolean
  readonly respectIgnore: boolean
  readonly glob?: string
  readonly maxBytes: number
  readonly maxResults: number
  readonly signal: AbortSignal
}

export interface RipgrepLine {
  readonly file: string // path relative to cwd
  readonly lineNo: number // 1-based
  readonly text: string
}

export interface RipgrepResult {
  readonly lines: RipgrepLine[]
  readonly truncatedByBytes: boolean
  readonly truncatedByResults: boolean
}

/** Cached availability check — ripgrep binary presence doesn't change within a process. */
let cachedAvailable: boolean | null = null

/**
 * Returns true if the bundled ripgrep binary is accessible and executable.
 * Result is cached after first call.
 */
export async function isRipgrepAvailable(): Promise<boolean> {
  if (cachedAvailable !== null) return cachedAvailable
  try {
    await fs.access(vscodeRgPath, fs.constants.X_OK)
    cachedAvailable = true
  } catch {
    cachedAvailable = false
  }
  return cachedAvailable
}

/** Exposed for tests. */
export function _resetRipgrepCache(): void {
  cachedAvailable = null
}

/** Absolute path to the bundled ripgrep binary. */
export function ripgrepBinaryPath(): string {
  return vscodeRgPath
}

/**
 * Run ripgrep and parse its output into structured matches.
 *
 * Uses the `--json` output mode for unambiguous parsing (filenames with colons,
 * binary-detected skips, etc. all come through as typed events).
 *
 * Throws on:
 *   - ripgrep missing / not executable
 *   - spawn failure
 *   - non-zero exit that isn't "no matches" (exit 1)
 *   - abort via signal
 */
export async function runRipgrep(opts: RipgrepOptions): Promise<RipgrepResult> {
  if (!(await isRipgrepAvailable())) {
    throw new Error('Ripgrep binary not available')
  }

  const args: string[] = [
    '--json',
    '--no-messages', // suppress "cannot read" stderr noise per-file
  ]

  if (opts.fixedStrings) args.push('--fixed-strings')
  if (opts.multiline) args.push('--multiline', '--multiline-dotall')
  args.push(opts.caseSensitive ? '--case-sensitive' : '--ignore-case')
  if (opts.includeHidden) args.push('--hidden')
  if (opts.respectIgnore) {
    // Honor .gitignore even in directories without a .git/ (otherwise
    // ripgrep silently skips ignore rules outside git repos).
    args.push('--no-require-git')
  } else {
    args.push('--no-ignore')
  }

  // Always prune VCS and node_modules even when --hidden or --no-ignore are on.
  args.push(
    '--glob', '!.git/',
    '--glob', '!.hg/',
    '--glob', '!.svn/',
    '--glob', '!.bzr/',
    '--glob', '!.jj/',
    '--glob', '!.sl/',
    '--glob', '!node_modules/',
  )

  // Credential isolation — exclude every secret-material path so ripgrep
  // cannot surface values from .env, private keys, etc. even when
  // `--hidden` or `--no-ignore` is on. Source of truth is
  // `credentials/patterns.ts`, so adding a new blocked file type there
  // lights up every tool that already respects the list.
  for (const glob of BLOCKED_FILE_GLOBS) {
    args.push('--glob', glob)
  }

  if (opts.glob) args.push('--glob', opts.glob)

  // Note: we intentionally do NOT pass --max-columns. In JSON mode ripgrep
  // omits the matched line text when it exceeds that length, which is less
  // useful than returning a truncated prefix. We truncate post-hoc instead.

  // Don't pass -m (per-file cap) because we want a total cap across files.
  // We enforce maxResults in the parser.

  args.push('--', opts.pattern)

  return new Promise<RipgrepResult>((resolve, reject) => {
    const child = spawn(vscodeRgPath, args, {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Detach stdin; ripgrep would otherwise try to read from terminal.
    })

    const lines: RipgrepLine[] = []
    let stdoutBuf = ''
    let totalBytes = 0
    let truncatedByBytes = false
    let truncatedByResults = false
    let settled = false

    const onAbort = () => {
      if (!settled) {
        settled = true
        child.kill('SIGTERM')
        reject(new Error('Ripgrep aborted'))
      }
    }
    if (opts.signal.aborted) {
      onAbort()
      return
    }
    opts.signal.addEventListener('abort', onAbort, { once: true })

    const finish = (err: Error | null) => {
      if (settled) return
      settled = true
      opts.signal.removeEventListener('abort', onAbort)
      if (err) reject(err)
      else resolve({ lines, truncatedByBytes, truncatedByResults })
    }

    child.on('error', (e) => finish(e))

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (settled) return
      stdoutBuf += chunk

      let nl: number
      while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
        const raw = stdoutBuf.slice(0, nl)
        stdoutBuf = stdoutBuf.slice(nl + 1)
        if (!raw) continue

        // Parse a single ripgrep --json event.
        let ev: unknown
        try {
          ev = JSON.parse(raw)
        } catch {
          continue // skip malformed line
        }
        const line = parseMatchEvent(ev)
        if (!line) continue

        // Budget checks before appending
        const approxBytes = line.file.length + line.text.length + 16
        if (totalBytes + approxBytes > opts.maxBytes) {
          truncatedByBytes = true
          child.kill('SIGTERM')
          finish(null)
          return
        }
        lines.push(line)
        totalBytes += approxBytes

        if (lines.length >= opts.maxResults) {
          truncatedByResults = true
          child.kill('SIGTERM')
          finish(null)
          return
        }
      }
    })

    // Drain stderr so the child doesn't block on a full pipe.
    child.stderr.on('data', () => { /* intentionally ignored; --no-messages */ })

    child.on('close', (code, sig) => {
      if (settled) return
      // ripgrep exits 0 (matches), 1 (no matches), 2 (error).
      // When we killed it ourselves via budget, code will be null / sig set.
      if (sig === 'SIGTERM' && (truncatedByBytes || truncatedByResults)) {
        finish(null)
        return
      }
      if (code === 0 || code === 1) {
        finish(null)
      } else {
        finish(new Error(`Ripgrep exited with code ${code ?? 'null'}`))
      }
    })
  })
}

/**
 * Extract a match line from a ripgrep JSON event.
 * Event shapes we care about: `{type: 'match', data: {path:{text}, line_number, lines:{text}}}`.
 * Everything else (begin, end, context, summary, binary-skip) we ignore.
 */
function parseMatchEvent(ev: unknown): RipgrepLine | null {
  if (!ev || typeof ev !== 'object') return null
  const e = ev as Record<string, unknown>
  if (e.type !== 'match') return null
  const data = e.data as Record<string, unknown> | undefined
  if (!data) return null

  const pathField = data.path as Record<string, unknown> | undefined
  const file = typeof pathField?.text === 'string' ? pathField.text : null
  if (!file) return null

  const lineNo = typeof data.line_number === 'number' ? data.line_number : null
  if (lineNo === null) return null

  const linesField = data.lines as Record<string, unknown> | undefined
  const rawText = typeof linesField?.text === 'string' ? linesField.text : ''
  // ripgrep includes the trailing newline; strip it.
  const text = rawText.endsWith('\n') ? rawText.slice(0, -1) : rawText

  return { file, lineNo, text }
}
