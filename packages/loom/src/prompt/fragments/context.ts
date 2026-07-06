/**
 * Context Fragment
 *
 * Creates the context section of the system prompt with environment
 * information: current date, OS, platform, working directory, git branch.
 * This content is volatile — it changes between sessions.
 */

import type { PromptFragment } from '../types.js'

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ContextFragmentOptions {
  /** Override current date (ISO string). Defaults to now. */
  date?: string
  /** Override platform. Defaults to process.platform. */
  platform?: string
  /** Override working directory. Defaults to process.cwd(). */
  cwd?: string
  /** Current git branch name (null = not in a git repo) */
  gitBranch?: string | null
  /** Git status summary */
  gitStatus?: string | null
  /** Additional context lines to include */
  extra?: string[]
}

// ---------------------------------------------------------------------------
// Fragment factory
// ---------------------------------------------------------------------------

/**
 * Create a context prompt fragment with environment information.
 *
 * @param opts - Override auto-detected values for testing or remote agents
 * @returns A prompt fragment in the context slot
 */
export function createContextFragment(opts?: ContextFragmentOptions): PromptFragment {
  const date = opts?.date ?? new Date().toISOString().split('T')[0]
  const platform = opts?.platform ?? process.platform
  const cwd = opts?.cwd ?? process.cwd()
  const arch = process.arch

  const lines: string[] = [
    '# Environment',
    '',
    `- Date: ${date}`,
    `- Platform: ${platform} (${arch})`,
    `- Working directory: ${cwd}`,
  ]

  if (opts?.gitBranch !== undefined) {
    if (opts.gitBranch) {
      lines.push(`- Git branch: ${opts.gitBranch}`)
    }
  }

  if (opts?.gitStatus) {
    lines.push(`- Git status: ${opts.gitStatus}`)
  }

  if (opts?.extra) {
    for (const line of opts.extra) {
      lines.push(`- ${line}`)
    }
  }

  return {
    slot: 'context',
    content: lines.join('\n'),
    priority: 50,
    label: 'environment',
    cacheControl: false, // volatile — changes every session
  }
}
