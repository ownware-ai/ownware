/**
 * Context Helpers
 *
 * Assemble granular context fragments for the system prompt.
 * Each function returns a formatted string ready for the PromptBuilder.
 */

import { execFile } from 'child_process'
import { readFile } from 'fs/promises'
import { join } from 'path'

// ---------------------------------------------------------------------------
// Git context
// ---------------------------------------------------------------------------

/**
 * Get current git branch.
 * Returns empty string if not in a git repo.
 *
 * Only the branch name is included. Working-tree status is intentionally
 * excluded: it changes on every file edit, which would invalidate the
 * Anthropic prompt cache (exact-prefix match) mid-session and force a
 * full re-write of the system-prompt block every turn. Agents that need
 * current working-tree state should run `git status` through their
 * shell tool — that output lives in the conversation, not the cached
 * system prompt.
 */
export async function getGitContext(cwd?: string): Promise<string> {
  try {
    const branch = await execAsync('git', ['branch', '--show-current'], cwd)
    const branchName = branch.trim() || 'HEAD (detached)'
    return `Git branch: ${branchName}`
  } catch {
    // Not a git repo or git not installed
    return ''
  }
}

// ---------------------------------------------------------------------------
// OS context
// ---------------------------------------------------------------------------

/**
 * Get platform, architecture, and Node.js version.
 */
export function getOsContext(): string {
  return `Platform: ${process.platform} ${process.arch}\nNode: ${process.version}`
}

// ---------------------------------------------------------------------------
// Date context
// ---------------------------------------------------------------------------

/**
 * Get current date, rounded to day granularity.
 *
 * Returns `YYYY-MM-DD` plus a human form. The sub-second portion of the
 * timestamp is intentionally dropped: Anthropic's prompt cache does
 * exact-prefix matching, so any sub-day volatility in the system prompt
 * would invalidate the cache on every turn and force a cache-write at
 * 1.25× input rate. Day-level granularity keeps the whole session (and
 * typically the whole day) on a single cache entry.
 *
 * Callers that need the wall-clock time should read it out-of-band (e.g.
 * a `date` tool call) rather than inject it into the system prompt.
 */
export function getDateContext(): string {
  const now = new Date()
  const dateOnly = now.toISOString().slice(0, 10) // "YYYY-MM-DD"
  const human = now.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
  return `Current date: ${dateOnly}\n${human}`
}

// ---------------------------------------------------------------------------
// Project context
// ---------------------------------------------------------------------------

/**
 * Load the project's OWNWARE.md context file.
 * Checks .ownware/OWNWARE.md first, then OWNWARE.md in root.
 * Returns null if not found.
 */
export async function getProjectContext(projectDir: string): Promise<string | null> {
  const paths = [
    join(projectDir, '.ownware', 'OWNWARE.md'),
    join(projectDir, 'OWNWARE.md'),
  ]

  for (const p of paths) {
    const content = await tryReadFile(p)
    if (content !== null) return content
  }

  return null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read a file, returning null if it doesn't exist.
 */
export async function tryReadFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf-8')
  } catch {
    return null
  }
}

/**
 * Execute a command and return stdout as string.
 */
function execAsync(command: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const opts: { timeout: number; cwd?: string } = { timeout: 5_000 }
    if (cwd) opts.cwd = cwd
    execFile(command, args, opts, (error, stdout) => {
      if (error) {
        reject(error)
        return
      }
      resolve(stdout)
    })
  })
}
