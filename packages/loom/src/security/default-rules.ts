/**
 * Default Safety Rule Presets
 *
 * Loom ships with NO opinions baked in — these are opt-in rule sets
 * that consumers (like Cortex) import based on their deployment context.
 *
 * Usage:
 *   import { ENTERPRISE_AGENT_RULES } from '@ownware/loom/security'
 *   const evaluator = new PermissionEvaluator({ safetyRules: ENTERPRISE_AGENT_RULES })
 */

import type { SafetyRule } from '../permissions/types.js'

// ---------------------------------------------------------------------------
// CODING AGENT RULES — Good for developer tools
// ---------------------------------------------------------------------------

/** Block destructive shell commands */
const blockDestructiveShell: SafetyRule = (toolName, input) => {
  if (toolName !== 'shell.execute' && toolName !== 'bash') return null
  const cmd = typeof input.command === 'string' ? input.command : ''
  if (!cmd) return null

  const patterns = [
    /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+\//,  // rm -rf /
    /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?\/\s/,        // rm / or rm -f /
    /\bsudo\s+rm\b/,
    /\bmkfs\b/,
    /\bdd\s+.*of=\/dev\//,
    /:\(\)\s*\{\s*:\s*\|\s*:&\s*\}/,                  // fork bomb
    /\bshutdown\b/,
    /\breboot\b/,
    /\bcurl\b.*\|\s*(sudo\s+)?(ba)?sh\b/,
    /\bwget\b.*\|\s*(sudo\s+)?(ba)?sh\b/,
  ]
  for (const p of patterns) {
    if (p.test(cmd)) return 'ask'
  }
  if (/\bsudo\b/.test(cmd)) return 'ask'
  return null
}

/** Surface writes to system directories with a prompt — never auto-deny. */
const blockSystemWrites: SafetyRule = (toolName, input) => {
  if (!toolName.includes('write') && !toolName.includes('edit')) return null
  const p = typeof input.file_path === 'string' ? input.file_path : typeof input.path === 'string' ? input.path : ''
  if (!p) return null
  const blocked = ['/etc/', '/usr/', '/bin/', '/sbin/', '/boot/', '/sys/', '/proc/', '/dev/']
  for (const prefix of blocked) {
    if (p.startsWith(prefix)) return 'ask'
  }
  return null
}

/** Flag potential secrets in tool input */
const flagSecrets: SafetyRule = (_toolName, input) => {
  const str = JSON.stringify(input)
  const patterns = [
    /(?:api[_-]?key|secret|token|password)\s*[=:]\s*['"][^'"]{8,}/i,
    /(?:AKIA|ASIA)[A-Z0-9]{16}/,
    /\bsk-[a-zA-Z0-9]{20,}/,
    /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/,
  ]
  for (const p of patterns) {
    if (p.test(str)) return 'ask'
  }
  return null
}

export const CODING_AGENT_RULES: SafetyRule[] = [
  blockDestructiveShell,
  blockSystemWrites,
  flagSecrets,
]

// ---------------------------------------------------------------------------
// ENTERPRISE AGENT RULES — For legal, finance, healthcare
// ---------------------------------------------------------------------------

/** Block all shell execution by default */
const blockShellByDefault: SafetyRule = (toolName) => {
  if (toolName === 'shell.execute' || toolName === 'bash') return 'ask'
  return null
}

/** Block network access by default */
const blockNetworkAccess: SafetyRule = (toolName, input) => {
  if (toolName !== 'browser' && toolName !== 'browser.navigate' && toolName !== 'fetch') return null
  const url = typeof input.url === 'string' ? input.url : ''
  if (!url) return null
  // Block internal IPs (SSRF)
  try {
    const parsed = new URL(url)
    const h = parsed.hostname
    if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|localhost)/i.test(h)) return 'ask'
  } catch { /* invalid URL */ }
  return 'ask' // All network access requires approval in enterprise
}

/** Block all file writes outside workspace */
const strictWorkspaceBoundary: SafetyRule = (toolName, input) => {
  if (!toolName.includes('write') && !toolName.includes('edit')) return null
  const p = typeof input.file_path === 'string' ? input.file_path : typeof input.path === 'string' ? input.path : ''
  if (!p) return null
  // In enterprise mode, ANY absolute path write requires approval
  if (p.startsWith('/')) return 'ask'
  return null
}

/** Flag PII patterns */
const flagPII: SafetyRule = (_toolName, input) => {
  const str = JSON.stringify(input)
  if (/\b\d{3}-\d{2}-\d{4}\b/.test(str)) return 'ask' // SSN
  if (/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/.test(str)) return 'ask' // Credit card
  return null
}

export const ENTERPRISE_AGENT_RULES: SafetyRule[] = [
  blockDestructiveShell,
  blockShellByDefault,
  blockNetworkAccess,
  strictWorkspaceBoundary,
  blockSystemWrites,
  flagSecrets,
  flagPII,
]

// ---------------------------------------------------------------------------
// SANDBOX AGENT RULES — Permissive, for isolated environments
// ---------------------------------------------------------------------------

/** Only block the absolute worst (fork bombs, disk wipe) */
const blockCatastrophic: SafetyRule = (toolName, input) => {
  if (toolName !== 'shell.execute' && toolName !== 'bash') return null
  const cmd = typeof input.command === 'string' ? input.command : ''
  if (/:\(\)\s*\{\s*:\s*\|\s*:&\s*\}/.test(cmd)) return 'ask'
  if (/\bdd\s+.*of=\/dev\//.test(cmd)) return 'ask'
  if (/\bmkfs\b/.test(cmd)) return 'ask'
  if (/\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+\/\s*$/.test(cmd)) return 'ask'
  return null
}

export const SANDBOX_AGENT_RULES: SafetyRule[] = [
  blockCatastrophic,
]
