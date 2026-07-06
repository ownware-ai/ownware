/**
 * Zone Security System — Human-Readable Explanations
 *
 * Generates plain-language descriptions of zone decisions for users.
 * Instead of "Allow Bash(git push origin main)?", users see:
 * "I want to push 3 commits to origin/main. This will be visible to your team."
 *
 * Explanation depth scales with zone level:
 * - Zone 0-1: Silent (no explanation needed)
 * - Zone 2: Brief note ("Installing dependencies...")
 * - Zone 3: One-line ask ("Access npmjs.com to install packages?")
 * - Zone 4: Detailed context ("Push changes to GitHub...")
 * - Zone 5: Strong warning ("Read system file outside workspace...")
 * - Zone 6: Block message ("Blocked: Cannot write to SSH keys")
 *
 * @security Explanations must never leak sensitive data from tool input.
 */

import type { ZoneContext, ZoneDecision, CombinationBlockReason } from './types.js'
import { ZoneLevel, ZONE_LEVEL_NAMES } from './types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Truncate a string to maxLen, adding ellipsis if truncated. */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str
  return str.slice(0, maxLen - 3) + '...'
}

/** Extract the most relevant field from tool input for display. */
function summarizeInput(toolName: string, input: Readonly<Record<string, unknown>>): string {
  // Shell commands
  if (typeof input.command === 'string') {
    return truncate(input.command, 120)
  }
  // File operations
  if (typeof input.file_path === 'string') {
    return input.file_path
  }
  if (typeof input.path === 'string') {
    return input.path
  }
  // Network
  if (typeof input.url === 'string') {
    return truncate(input.url, 100)
  }
  // Search
  if (typeof input.query === 'string') {
    return truncate(input.query, 80)
  }
  // Generic
  if (typeof input.pattern === 'string') {
    return truncate(input.pattern, 80)
  }
  return toolName
}

/** Describe a file path relative to workspace. */
function describeFilePath(path: string, workspacePath?: string): string {
  if (!workspacePath || !path.startsWith(workspacePath)) {
    return path
  }
  const relative = path.slice(workspacePath.length)
  return relative.startsWith('/') ? `.${relative}` : `./${relative}`
}

/** Parse a shell command into a brief human description. */
function describeShellCommand(command: string): string {
  const trimmed = command.trim()

  // Git operations
  if (/^\s*git\s+push\b/.test(trimmed)) {
    const match = trimmed.match(/git\s+push\s+(\S+)\s*(\S*)/)
    const remote = match?.[1] ?? 'origin'
    const branch = match?.[2] ?? ''
    return `Push to ${remote}${branch ? '/' + branch : ''}`
  }
  if (/^\s*git\s+commit\b/.test(trimmed)) return 'Create git commit'
  if (/^\s*git\s+merge\b/.test(trimmed)) return 'Merge branches'
  if (/^\s*git\s+rebase\b/.test(trimmed)) return 'Rebase branch'

  // Package managers
  if (/^\s*npm\s+install\b/.test(trimmed)) return 'Install npm packages'
  if (/^\s*npm\s+test\b/.test(trimmed)) return 'Run tests (npm test)'
  if (/^\s*npm\s+run\s+build\b/.test(trimmed)) return 'Build project (npm run build)'
  if (/^\s*npm\s+run\s+(\S+)/.test(trimmed)) {
    const script = trimmed.match(/npm\s+run\s+(\S+)/)?.[1]
    return `Run npm script: ${script}`
  }
  if (/^\s*pip\s+install\b/.test(trimmed)) return 'Install Python packages'
  if (/^\s*yarn\s+add\b/.test(trimmed)) return 'Install packages (yarn)'
  if (/^\s*pnpm\s+(add|install)\b/.test(trimmed)) return 'Install packages (pnpm)'

  // Deployment
  if (/^\s*vercel\b/.test(trimmed)) return 'Deploy to Vercel'
  if (/^\s*npm\s+publish\b/.test(trimmed)) return 'Publish npm package'

  // Generic: first 80 chars
  return truncate(trimmed, 80)
}

// ---------------------------------------------------------------------------
// Main explainer
// ---------------------------------------------------------------------------

/**
 * Generate a human-readable explanation for a zone decision.
 *
 * @param ctx - Tool call context
 * @param decision - Zone decision to explain
 * @returns Human-readable explanation string
 */
export function explainZoneDecision(
  ctx: ZoneContext,
  decision: ZoneDecision,
): string {
  const { toolName, input, workspacePath } = ctx
  const { classification } = decision

  // Combination block — highest priority explanation
  if (decision.combinationBlock) {
    return explainCombinationBlock(decision.combinationBlock)
  }

  const level = classification.level
  const summary = summarizeInput(toolName, input)

  switch (level) {
    case ZoneLevel.SAFE:
      return '' // No explanation needed

    case ZoneLevel.WORKSPACE: {
      const path = typeof input.file_path === 'string' ? input.file_path
        : typeof input.path === 'string' ? input.path : null
      if (path) {
        return `Write to ${describeFilePath(path, workspacePath)}`
      }
      return `Workspace operation: ${summary}`
    }

    case ZoneLevel.BUILD: {
      if (typeof input.command === 'string') {
        return describeShellCommand(input.command)
      }
      return `Execute in workspace: ${summary}`
    }

    case ZoneLevel.NETWORK: {
      const url = typeof input.url === 'string' ? input.url
        : typeof input.href === 'string' ? input.href : null
      if (url) {
        try {
          const parsed = new URL(url)
          return `Access ${parsed.hostname}${parsed.pathname !== '/' ? parsed.pathname : ''}`
        } catch {
          return `Network access: ${truncate(url, 80)}`
        }
      }
      return `Network operation: ${summary}`
    }

    case ZoneLevel.EXTERNAL: {
      if (typeof input.command === 'string') {
        const desc = describeShellCommand(input.command)
        return `${desc} — this will be visible externally`
      }
      return `External action: ${summary}. This may be visible to others.`
    }

    case ZoneLevel.MACHINE: {
      const path = typeof input.file_path === 'string' ? input.file_path
        : typeof input.path === 'string' ? input.path : null
      if (path) {
        return `Access ${path} (outside workspace). ${classification.reason}`
      }
      return `System-level operation: ${summary}. ${classification.reason}`
    }

    case ZoneLevel.NEVER:
      return `Blocked: ${classification.reason}`

    default:
      return `${ZONE_LEVEL_NAMES[level]} zone: ${summary}`
  }
}

/**
 * Generate explanation for a combination block.
 */
function explainCombinationBlock(block: CombinationBlockReason): string {
  const recentNames = block.recentTools
    .map(t => t.toolName)
    .filter((v, i, a) => a.indexOf(v) === i) // deduplicate
    .slice(0, 3)
    .join(', ')

  return `Blocked by security rule "${block.rule}": ${block.explanation}. ` +
    `Recent actions (${recentNames}) created a risky combination.`
}
