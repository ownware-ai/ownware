/**
 * Zone Security System — Tool Classifier
 *
 * Five-layer classification pipeline that maps every tool call to a zone level.
 *
 * Layers (priority order):
 *   1. Exact name — hardcoded map for known builtin tools (O(1) lookup)
 *   2. Pattern override — profile-defined glob patterns (customizable per agent)
 *   3. Category — ToolCategory → zone mapping (works for custom tools)
 *   4. Input analysis — shell-security integration, SSRF detection, path analysis
 *   5. Default — MCP → Zone 4, unknown → Zone 2
 *
 * @security Every tool call goes through this classifier before execution.
 * Shell command classification delegates to shell-security.ts (battle-tested 5-level
 * validator) rather than reimplementing naive regex patterns.
 */

import type { SeverityTag, ZoneClassification, ZoneContext, ZoneOverride } from './types.js'
import { ZoneLevel, ZONE_LEVEL_NAMES } from './types.js'
import { validateCommand } from '../tools/builtins/shell-security.js'

/**
 * Internal classification result with optional severity tag. The
 * inner helpers may attach a severity hint (e.g. "this looks like
 * shell injection — render the prompt as 'warn'"); `classifyToolCall`
 * surfaces the hint onto the public ZoneClassification.
 */
interface InnerResult {
  level: ZoneLevel
  reason: string
  severityTag?: SeverityTag
  severityReason?: string
}

// ---------------------------------------------------------------------------
// Layer 1: Exact name map
// ---------------------------------------------------------------------------

/**
 * Hardcoded zone assignments for known builtin tool names.
 *
 * @security Adding a tool here bypasses all other classification layers.
 * Only add tools whose zone level is CERTAIN and PERMANENT.
 */
const EXACT_ZONE_MAP: ReadonlyMap<string, ZoneLevel> = new Map([
  // Zone 0 — SAFE (read-only, no side effects)
  ['readFile', ZoneLevel.SAFE],
  ['listFiles', ZoneLevel.SAFE],
  ['glob', ZoneLevel.SAFE],
  ['grep', ZoneLevel.SAFE],
  ['web_search', ZoneLevel.SAFE],
  ['ask_user', ZoneLevel.SAFE],
  ['filesystem.readFile', ZoneLevel.SAFE],
  ['filesystem.listFiles', ZoneLevel.SAFE],
  ['filesystem.glob', ZoneLevel.SAFE],
  ['filesystem.grep', ZoneLevel.SAFE],
  ['filesystem.exists', ZoneLevel.SAFE],
  ['search.web', ZoneLevel.SAFE],

  // Zone 1 — WORKSPACE (local git ops, agent spawn)
  ['agent_spawn', ZoneLevel.WORKSPACE],

  // Zone 2 — BUILD (filesystem writes — require approval at 'standard' security)
  ['writeFile', ZoneLevel.BUILD],
  ['editFile', ZoneLevel.BUILD],
  ['createFile', ZoneLevel.BUILD],
  ['filesystem.writeFile', ZoneLevel.BUILD],
  ['filesystem.editFile', ZoneLevel.BUILD],
  ['filesystem.createFile', ZoneLevel.BUILD],

  // Zone 2 — BUILD (shell execution — base level, upgraded by input analysis)
  ['shell_execute', ZoneLevel.BUILD],
  ['shell.execute', ZoneLevel.BUILD],
  ['bash', ZoneLevel.BUILD],

  // Zone 3 — NETWORK (internet access)
  ['web_fetch', ZoneLevel.NETWORK],
  ['fetch', ZoneLevel.NETWORK],
  ['browser.navigate', ZoneLevel.NETWORK],
])

// ---------------------------------------------------------------------------
// Layer 2: Pattern matching (glob)
// ---------------------------------------------------------------------------

/**
 * Match a tool name against a glob pattern.
 * Properly escapes all regex metacharacters before converting globs.
 */
function matchesPattern(toolName: string, pattern: string): boolean {
  if (pattern === toolName) return true
  if (pattern === '*') return true

  // Escape everything EXCEPT *
  const safePattern = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  // Now safePattern has * still as literal *
  // Convert ** → .* and * → .*
  const finalRegex = safePattern
    .replace(/\*\*/g, '@@DBL@@')
    .replace(/\*/g, '.*')
    .replace(/@@DBL@@/g, '.*')

  try {
    return new RegExp(`^${finalRegex}$`).test(toolName)
  } catch {
    // Malformed pattern — fail closed (no match)
    return false
  }
}

// ---------------------------------------------------------------------------
// Layer 3: Category-based classification
// ---------------------------------------------------------------------------

/**
 * Map tool category + read-only flag → zone level.
 *
 * @security MCP tools with no category default to EXTERNAL (Zone 4).
 */
function classifyByCategory(
  category: string | undefined,
  isReadOnly: boolean | undefined,
): ZoneLevel | null {
  switch (category) {
    case 'filesystem':
      return isReadOnly ? ZoneLevel.SAFE : ZoneLevel.WORKSPACE
    case 'search':
      return ZoneLevel.SAFE
    case 'memory':
      return ZoneLevel.SAFE
    case 'agent':
      return ZoneLevel.WORKSPACE
    case 'shell':
      return ZoneLevel.BUILD
    case 'browser':
      return ZoneLevel.NETWORK
    case 'custom':
      return ZoneLevel.BUILD
    case 'mcp':
      return ZoneLevel.EXTERNAL
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Layer 4: Input analysis — Shell commands
// ---------------------------------------------------------------------------

/**
 * Intent-based patterns that UPGRADE a shell command's zone beyond BUILD.
 * These run AFTER shell-security.ts validates the command isn't malicious.
 *
 * @security These detect intent (what will the command DO?), not safety.
 * Safety is handled by validateCommand() from shell-security.ts.
 */
const SHELL_INTENT_PATTERNS: ReadonlyArray<{
  readonly pattern: RegExp
  readonly level: ZoneLevel
  readonly reason: string
}> = [
  // Zone 5 — MACHINE: system-level operations
  { pattern: /\bdocker\b/, level: ZoneLevel.MACHINE, reason: 'Docker operation' },
  { pattern: /\bkubectl\b/, level: ZoneLevel.MACHINE, reason: 'Kubernetes operation' },
  { pattern: /\baws\b\s/, level: ZoneLevel.MACHINE, reason: 'AWS CLI operation' },
  { pattern: /\bgcloud\b/, level: ZoneLevel.MACHINE, reason: 'Google Cloud operation' },
  { pattern: /\baz\b\s/, level: ZoneLevel.MACHINE, reason: 'Azure CLI operation' },
  { pattern: /\bssh\b\s/, level: ZoneLevel.MACHINE, reason: 'SSH connection' },
  { pattern: /\bcat\b.*~\/\.(ssh|aws|gnupg)\//, level: ZoneLevel.MACHINE, reason: 'Read sensitive directory' },
  { pattern: /\/proc\/(self|\d+)\/environ/, level: ZoneLevel.MACHINE, reason: 'Process environment access' },

  // Zone 4 — EXTERNAL: visible to others
  { pattern: /\bgit\s+push\b/, level: ZoneLevel.EXTERNAL, reason: 'Git push (visible to team)' },
  { pattern: /\bgit\s+remote\s+(add|set-url|remove)\b/, level: ZoneLevel.EXTERNAL, reason: 'Git remote modification' },
  { pattern: /\bnpm\s+publish\b/, level: ZoneLevel.EXTERNAL, reason: 'Publish npm package' },
  { pattern: /\bvercel\b.*\bdeploy\b/i, level: ZoneLevel.EXTERNAL, reason: 'Deploy to Vercel' },
  { pattern: /\bgh\s+(pr|issue)\s+(create|close|merge)\b/, level: ZoneLevel.EXTERNAL, reason: 'GitHub PR/issue operation' },
  { pattern: /\bheroku\b/, level: ZoneLevel.EXTERNAL, reason: 'Heroku operation' },
  { pattern: /\brailway\b/, level: ZoneLevel.EXTERNAL, reason: 'Railway deployment' },
  { pattern: /\bfly\s+deploy\b/, level: ZoneLevel.EXTERNAL, reason: 'Fly.io deployment' },
  { pattern: /\bterraform\s+(apply|destroy|import)\b/, level: ZoneLevel.EXTERNAL, reason: 'Terraform infrastructure change' },
  { pattern: /\bpulumi\s+(up|destroy|preview)\b/, level: ZoneLevel.EXTERNAL, reason: 'Pulumi infrastructure change' },
  { pattern: /\bcdk\s+deploy\b/, level: ZoneLevel.EXTERNAL, reason: 'AWS CDK deployment' },
  { pattern: /\bserverless\s+deploy\b/, level: ZoneLevel.EXTERNAL, reason: 'Serverless deployment' },
  { pattern: /\bgit\s+push\b.*--force/, level: ZoneLevel.EXTERNAL, reason: 'Git force push (destructive)' },
  { pattern: /\bgh\s+release\s+create\b/, level: ZoneLevel.EXTERNAL, reason: 'GitHub release creation' },

  // Zone 3 — NETWORK: internet access (without shell-to-shell piping)
  { pattern: /\bcurl\b/, level: ZoneLevel.NETWORK, reason: 'Network request (curl)' },
  { pattern: /\bwget\b/, level: ZoneLevel.NETWORK, reason: 'Network request (wget)' },
  { pattern: /\bnc\b\s/, level: ZoneLevel.NETWORK, reason: 'Netcat connection' },

  // Zone 2 — BUILD: package install and build
  { pattern: /\bnpm\s+(install|ci)\b/, level: ZoneLevel.BUILD, reason: 'Package install (npm)' },
  { pattern: /\bpip\s+install\b/, level: ZoneLevel.BUILD, reason: 'Package install (pip)' },
  { pattern: /\byarn\s+(add|install)\b/, level: ZoneLevel.BUILD, reason: 'Package install (yarn)' },
  { pattern: /\bpnpm\s+(add|install)\b/, level: ZoneLevel.BUILD, reason: 'Package install (pnpm)' },
  { pattern: /\bcargo\s+build\b/, level: ZoneLevel.BUILD, reason: 'Cargo build' },
  { pattern: /^\s*(npm\s+test|npm\s+run\s+test|pytest|vitest|jest)\b/, level: ZoneLevel.BUILD, reason: 'Test execution' },
  { pattern: /^\s*(npm\s+run\s+build|make|tsc|go\s+build)\b/, level: ZoneLevel.BUILD, reason: 'Build command' },

  // Zone 0 — SAFE: read-only commands (overrides BUILD default for shell tools)
  { pattern: /^\s*(ls|pwd|echo|cat|head|tail|wc|file|stat|which|type|whoami|hostname|date|uptime|uname)\s/, level: ZoneLevel.SAFE, reason: 'Read-only command' },
  { pattern: /^\s*(ls|pwd|echo|cat|head|tail|wc|file|stat|which|type|whoami|hostname|date|uptime|uname)$/, level: ZoneLevel.SAFE, reason: 'Read-only command' },
  { pattern: /^\s*git\s+(status|log|diff|show|branch|tag|describe|remote\s+-v)\b/, level: ZoneLevel.SAFE, reason: 'Read-only git command' },
  { pattern: /^\s*git\s+(add|commit|stash|checkout|switch|merge|rebase|reset)\b/, level: ZoneLevel.WORKSPACE, reason: 'Local git operation' },
]

/**
 * Classify a shell command using both safety validation and intent analysis.
 *
 * Post-2026-05-14 redesign: shell-security findings translate to a
 * `severityTag` for the UI permission card, NOT a zone-NEVER veto.
 * Only the catastrophic `LEVEL1_BLOCKED` outcomes (rm -rf /, fork
 * bomb, dd of=/dev/sda, mkfs) keep Zone NEVER. Everything else
 * — `dangerous`, `injection`, `exfiltration`, `sensitive` — escalates
 * to MACHINE and surfaces with `severityTag: 'warn'` so the user
 * always sees a real prompt with a clear warning. The regex's
 * known false positives (e.g. `$(...)`, heredocs with redirects)
 * no longer hard-block the agent; the user reads the command and
 * decides.
 *
 * @security shell-security.ts still catches obfuscation and the
 * detection logic is unchanged — only the *interpretation* moved
 * from veto → severity hint.
 */
function classifyShellCommand(command: string): InnerResult | null {
  if (!command || !command.trim()) return null

  // STEP 1: Use shell-security.ts for safety validation (catches obfuscation)
  const validation = validateCommand(command)

  if (!validation.safe) {
    switch (validation.level) {
      case 'blocked':
        // 'blocked' = literal catastrophic patterns (rm -rf /, fork
        // bomb, mkfs, dd of=/dev/sda). Keep NEVER — the user sees
        // a critical-severity prompt and explicitly decides.
        return {
          level: ZoneLevel.NEVER,
          reason: `Blocked: ${validation.reason}`,
          severityTag: 'critical',
          severityReason: `shell-security flagged this command as catastrophic: ${validation.reason}`,
        }
      case 'dangerous':
        return {
          level: ZoneLevel.MACHINE,
          reason: `Dangerous: ${validation.reason}`,
          severityTag: 'warn',
          severityReason: `shell-security flagged this command as dangerous: ${validation.reason}`,
        }
      case 'injection':
        // Regex-based "looks like injection" — high false-positive rate
        // on common idioms ($(...), heredocs, find -exec). The user is
        // shown the command and decides, not auto-denied.
        return {
          level: ZoneLevel.MACHINE,
          reason: `Possible injection pattern: ${validation.reason}`,
          severityTag: 'warn',
          severityReason: `shell-security flagged a possible injection pattern (note: this regex has known false positives on common idioms like $(...) and heredocs): ${validation.reason}`,
        }
      case 'exfiltration':
        return {
          level: ZoneLevel.MACHINE,
          reason: `Possible exfiltration pattern: ${validation.reason}`,
          severityTag: 'warn',
          severityReason: `shell-security flagged a possible exfiltration pattern: ${validation.reason}`,
        }
      case 'sensitive':
        return {
          level: ZoneLevel.MACHINE,
          reason: `Sensitive data: ${validation.reason}`,
          severityTag: 'info',
          severityReason: `shell-security noticed sensitive-looking data in the command: ${validation.reason}`,
        }
    }
  }

  // STEP 2: Intent analysis — what will the command DO? (not is it safe)
  let highestLevel: ZoneLevel = -1 as ZoneLevel
  let matchReason = ''

  for (const { pattern, level, reason } of SHELL_INTENT_PATTERNS) {
    if (pattern.test(command) && level > highestLevel) {
      highestLevel = level
      matchReason = reason
    }
  }

  if (highestLevel >= 0) {
    return { level: highestLevel, reason: matchReason }
  }

  return null
}

// ---------------------------------------------------------------------------
// Layer 4: Input analysis — SSRF detection
// ---------------------------------------------------------------------------

/**
 * Comprehensive SSRF detection for URLs.
 *
 * @security Catches:
 * - Standard private IP ranges (10.x, 172.16-31.x, 192.168.x)
 * - Loopback (127.x, localhost, [::1])
 * - Link-local (169.254.x, fe80::)
 * - Cloud metadata endpoints (169.254.169.254, metadata.google.internal)
 * - Decimal notation (2130706433 = 127.0.0.1)
 * - Octal notation (0177.0.0.1 = 127.0.0.1)
 * - IPv6 variants ([::], [::ffff:127.0.0.1])
 * - Zero address (0.0.0.0)
 */
function isInternalUrl(url: string): { internal: boolean; reason: string } {
  let hostname: string
  try {
    const parsed = new URL(url)
    hostname = parsed.hostname.toLowerCase()
  } catch {
    return { internal: false, reason: '' }
  }

  // Strip brackets from IPv6
  const bare = hostname.replace(/^\[|\]$/g, '')

  // Localhost variants
  if (bare === 'localhost' || bare === 'localhost.localdomain') {
    return { internal: true, reason: 'Localhost' }
  }

  // Cloud metadata endpoints
  const METADATA_HOSTS = [
    'metadata.google.internal',
    'metadata.goog',
    'metadata',
    'instance-data',
  ]
  if (METADATA_HOSTS.includes(bare)) {
    return { internal: true, reason: `Cloud metadata endpoint: ${bare}` }
  }

  // IPv6 patterns
  if (bare === '::1' || bare === '::' || bare === '0:0:0:0:0:0:0:1' || bare === '0:0:0:0:0:0:0:0') {
    return { internal: true, reason: 'IPv6 loopback' }
  }
  if (bare.startsWith('fe80:') || bare.startsWith('fe80%')) {
    return { internal: true, reason: 'IPv6 link-local' }
  }
  if (bare.startsWith('::ffff:')) {
    // IPv4-mapped IPv6 — extract and re-check the IPv4 part
    const v4part = bare.slice(7)
    if (isPrivateIPv4(v4part)) {
      return { internal: true, reason: `IPv4-mapped IPv6 private address: ${bare}` }
    }
  }

  // Pure numeric hostname (decimal notation: 2130706433 = 127.0.0.1)
  if (/^\d+$/.test(bare)) {
    const num = parseInt(bare, 10)
    if (num >= 0 && num <= 0xFFFFFFFF) {
      // Convert to IP and check
      const a = (num >>> 24) & 0xFF
      const b = (num >>> 16) & 0xFF
      const c = (num >>> 8) & 0xFF
      const d = num & 0xFF
      const ip = `${a}.${b}.${c}.${d}`
      if (isPrivateIPv4(ip)) {
        return { internal: true, reason: `Decimal IP ${bare} = ${ip} (private)` }
      }
    }
    return { internal: false, reason: '' }
  }

  // Octal notation detection (e.g., 0177.0.0.1 = 127.0.0.1)
  if (/^0[0-7]*\./.test(bare)) {
    // Could be octal IP — parse each octet
    const parts = bare.split('.')
    if (parts.length === 4) {
      const octets = parts.map(p => parseInt(p, p.startsWith('0') && p.length > 1 ? 8 : 10))
      if (octets.every(o => !isNaN(o) && o >= 0 && o <= 255)) {
        const ip = octets.join('.')
        if (isPrivateIPv4(ip)) {
          return { internal: true, reason: `Octal IP ${bare} = ${ip} (private)` }
        }
      }
    }
  }

  // Standard dotted IPv4 check
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare)) {
    if (isPrivateIPv4(bare)) {
      return { internal: true, reason: `Private IPv4: ${bare}` }
    }
  }

  // Hostname ending with known internal suffixes
  const INTERNAL_SUFFIXES = ['.internal', '.local', '.localhost', '.corp', '.lan', '.intranet']
  for (const suffix of INTERNAL_SUFFIXES) {
    if (bare.endsWith(suffix)) {
      return { internal: true, reason: `Internal hostname suffix: ${suffix}` }
    }
  }

  return { internal: false, reason: '' }
}

/**
 * Check if a dotted IPv4 address is in a private/reserved range.
 */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) return false

  const [a, b] = parts as [number, number, number, number]

  // 0.0.0.0
  if (a === 0) return true
  // 10.0.0.0/8
  if (a === 10) return true
  // 127.0.0.0/8 (loopback)
  if (a === 127) return true
  // 169.254.0.0/16 (link-local / cloud metadata)
  if (a === 169 && b === 254) return true
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true

  return false
}

// ---------------------------------------------------------------------------
// Layer 4: Input analysis — URL field extraction
// ---------------------------------------------------------------------------

/** Field names that commonly contain URLs across tools and MCP servers. */
const URL_FIELD_NAMES = [
  'url', 'href', 'uri', 'endpoint', 'target_url', 'webhook_url',
  'api_url', 'remote_url', 'service_url', 'base_url', 'redirect_url',
  'callback_url', 'remote', 'destination',
] as const

/**
 * Extract a URL from tool input, checking multiple common field names.
 */
function extractUrl(input: Readonly<Record<string, unknown>>): string | null {
  for (const field of URL_FIELD_NAMES) {
    const val = input[field]
    if (typeof val === 'string' && (val.startsWith('http://') || val.startsWith('https://') || val.startsWith('ftp://'))) {
      return val
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Layer 4: Input analysis — Path field extraction
// ---------------------------------------------------------------------------

/** Field names that commonly contain file paths. */
const PATH_FIELD_NAMES = [
  'file_path', 'path', 'filePath', 'target', 'source', 'destination',
  'directory', 'dir', 'folder', 'filename',
] as const

/** Paths that are ALWAYS sensitive regardless of workspace. */
const SENSITIVE_PATH_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /\/(\.ssh|\.gnupg|\.aws)\//i, reason: 'Sensitive credentials directory' },
  { pattern: /\.(bashrc|zshrc|profile|bash_profile|zprofile|zshenv)$/i, reason: 'Shell startup file' },
  { pattern: /\/(\.env|\.env\.\w+)$/i, reason: 'Environment file' },
  { pattern: /\/credentials(\.json)?$/i, reason: 'Credentials file' },
  { pattern: /\/id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/i, reason: 'SSH key' },
  { pattern: /\.(pem|key|p12|pfx|jks)$/i, reason: 'Certificate/key file' },
  { pattern: /\/\.netrc$/i, reason: 'Netrc credentials' },
  { pattern: /\/\.gitconfig$/i, reason: 'Git configuration' },
  { pattern: /\/\.npmrc$/i, reason: 'NPM configuration (may contain tokens)' },
  { pattern: /\/secret[_-]?key/i, reason: 'Secret key file' },
]

/**
 * Extract a file path from tool input and classify it.
 *
 * Post-2026-05-14 redesign: sensitive-looking paths (SSH keys,
 * `.env`, certificates, system directories) escalate the zone to
 * MACHINE and attach a `severityTag` so the UI renders an elevated
 * warning. They no longer hard-deny via Zone NEVER — the user reads
 * the path and decides. Path traversal and out-of-workspace paths
 * are 'warn' severity; SSH/credential files and system directories
 * are 'critical' severity (still asks, but red border + skull icon).
 */
function classifyFilePath(
  input: Readonly<Record<string, unknown>>,
  workspacePath: string | undefined,
): InnerResult | null {
  let filePath: string | null = null
  for (const field of PATH_FIELD_NAMES) {
    const val = input[field]
    if (typeof val === 'string' && val.length > 0) {
      filePath = val
      break
    }
  }
  if (!filePath) return null

  // Check sensitive paths FIRST — regardless of workspace
  for (const { pattern, reason } of SENSITIVE_PATH_PATTERNS) {
    if (pattern.test(filePath)) {
      return {
        level: ZoneLevel.MACHINE,
        reason: `Sensitive path: ${reason} (${filePath})`,
        severityTag: 'critical',
        severityReason: `This path looks sensitive: ${reason}. The user sees the prompt and decides whether to grant access.`,
      }
    }
  }

  // Path traversal detection
  if (filePath.includes('..')) {
    return {
      level: ZoneLevel.MACHINE,
      reason: `Path traversal detected: ${filePath}`,
      severityTag: 'warn',
      severityReason: `Path contains '..' segments — may escape the workspace. Confirm the resolved target before proceeding.`,
    }
  }

  // Absolute path outside workspace
  if (workspacePath && filePath.startsWith('/') && !filePath.startsWith(workspacePath)) {
    // System directories
    if (/^\/(etc|usr|bin|sbin|boot|sys|proc|dev)\//i.test(filePath)) {
      return {
        level: ZoneLevel.MACHINE,
        reason: `System directory access: ${filePath}`,
        severityTag: 'critical',
        severityReason: `Writing to a system directory can affect the whole machine.`,
      }
    }
    return {
      level: ZoneLevel.MACHINE,
      reason: `Outside workspace: ${filePath}`,
      severityTag: 'warn',
      severityReason: `This path is outside the workspace root.`,
    }
  }

  // Absolute path with no workspace context — be cautious
  if (!workspacePath && filePath.startsWith('/')) {
    if (/^\/(etc|usr|bin|sbin|boot|sys|proc|dev)\//i.test(filePath)) {
      return {
        level: ZoneLevel.MACHINE,
        reason: `System directory access: ${filePath}`,
        severityTag: 'critical',
        severityReason: `Writing to a system directory can affect the whole machine.`,
      }
    }
    // Can't determine if inside workspace — classify as MACHINE to be safe
    return {
      level: ZoneLevel.MACHINE,
      reason: `Absolute path without workspace context: ${filePath}`,
      severityTag: 'warn',
      severityReason: `Absolute path on a session with no workspace root — can't verify scope.`,
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Layer 4: Input analysis — Tool name heuristics
// ---------------------------------------------------------------------------

/**
 * Classify MCP and unknown tools by name heuristics.
 * Conservative: ambiguous names get higher zones.
 */
function classifyByToolName(toolName: string): { level: ZoneLevel; reason: string } | null {
  const lower = toolName.toLowerCase()

  // Destructive keywords → EXTERNAL (requires approval)
  if (lower.includes('deploy') || lower.includes('publish') || lower.includes('release')) {
    return { level: ZoneLevel.EXTERNAL, reason: `Tool name suggests deployment: ${toolName}` }
  }
  if (lower.includes('delete') || lower.includes('remove') || lower.includes('destroy') || lower.includes('drop')) {
    return { level: ZoneLevel.EXTERNAL, reason: `Tool name suggests destructive action: ${toolName}` }
  }
  if (lower.includes('send') || lower.includes('post') || lower.includes('notify') || lower.includes('email') || lower.includes('message')) {
    return { level: ZoneLevel.EXTERNAL, reason: `Tool name suggests communication: ${toolName}` }
  }
  if (lower.includes('execute') || lower.includes('exec') || lower.includes('run') || lower.includes('spawn')) {
    return { level: ZoneLevel.BUILD, reason: `Tool name suggests execution: ${toolName}` }
  }
  if (lower.includes('write') || lower.includes('update') || lower.includes('modify') || lower.includes('edit') || lower.includes('patch')) {
    return { level: ZoneLevel.WORKSPACE, reason: `Tool name suggests write operation: ${toolName}` }
  }
  if (lower.includes('read') || lower.includes('get') || lower.includes('list') || lower.includes('search') || lower.includes('find') || lower.includes('query') || lower.includes('fetch') || lower.includes('describe')) {
    return { level: ZoneLevel.SAFE, reason: `Tool name suggests read operation: ${toolName}` }
  }

  return null
}

// ---------------------------------------------------------------------------
// Main classifier
// ---------------------------------------------------------------------------

/**
 * Classify a tool call into a zone level.
 *
 * @security Pure function. Called on every tool invocation.
 * Shell commands are validated by shell-security.ts (5-level validator)
 * which catches obfuscation, encoding tricks, IFS manipulation,
 * command substitution, and exfiltration patterns.
 *
 * @param ctx - Tool call context
 * @param overrides - Profile-defined zone overrides (checked in Layer 2)
 * @returns Classification with zone level, reason, and which layer determined it
 */
export function classifyToolCall(
  ctx: ZoneContext,
  overrides?: readonly ZoneOverride[],
): ZoneClassification {
  const { toolName, input, toolCategory, toolIsReadOnly, workspacePath } = ctx

  // Layer 1: Exact name match (O(1) lookup)
  // NOTE: For shell tools, this returns BUILD as the BASE level.
  // Layer 4 (input analysis) may UPGRADE this based on the actual command.
  const exactZone = EXACT_ZONE_MAP.get(toolName)

  // For shell tools in exact map, we still analyze the command to potentially upgrade
  const isShellTool = toolName === 'shell_execute' || toolName === 'shell.execute' || toolName === 'bash'
  const hasCommand = typeof input.command === 'string'

  if (exactZone !== undefined && !(isShellTool && hasCommand)) {
    // Path-aware escalation. Even when EXACT says SAFE/BUILD for a
    // filesystem tool, the *target path* can change the picture: a
    // read of /etc/passwd or a write outside the workspace must
    // escalate beyond the exact-map default. classifyFilePath only
    // returns non-null for problematic paths (sensitive, path
    // traversal, outside-workspace, system dirs); in-workspace
    // relative/absolute paths return null and the EXACT classification
    // stands. The `> exactZone` guard ensures path analysis can only
    // RAISE the zone, never lower it.
    const pathEscalation = classifyFilePath(input, workspacePath)
    if (pathEscalation && pathEscalation.level > exactZone) {
      return {
        level: pathEscalation.level,
        zoneName: ZONE_LEVEL_NAMES[pathEscalation.level],
        reason: pathEscalation.reason,
        classifier: 'input-analysis',
        ...(pathEscalation.severityTag ? { severityTag: pathEscalation.severityTag } : {}),
        ...(pathEscalation.severityReason ? { severityReason: pathEscalation.severityReason } : {}),
      }
    }

    return {
      level: exactZone,
      zoneName: ZONE_LEVEL_NAMES[exactZone],
      reason: `Known tool: ${toolName}`,
      classifier: 'exact',
    }
  }

  // Layer 2: Pattern override (profile-defined)
  if (overrides && overrides.length > 0) {
    for (const override of overrides) {
      if (matchesPattern(toolName, override.toolPattern)) {
        return {
          level: override.level,
          zoneName: ZONE_LEVEL_NAMES[override.level],
          reason: override.reason ?? `Override: ${override.toolPattern} → ${ZONE_LEVEL_NAMES[override.level]}`,
          classifier: 'pattern',
        }
      }
    }
  }

  // Layer 3: Category-based classification (but don't stop here for shell — need input analysis)
  if (!isShellTool || !hasCommand) {
    const categoryZone = classifyByCategory(toolCategory, toolIsReadOnly)
    if (categoryZone !== null) {
      return {
        level: categoryZone,
        zoneName: ZONE_LEVEL_NAMES[categoryZone],
        reason: `Category '${toolCategory}' ${toolIsReadOnly ? '(read-only)' : ''}`,
        classifier: 'category',
      }
    }
  }

  // Layer 4: Input analysis (deep inspection)

  // 4a: Shell command analysis (delegates to shell-security.ts)
  if (hasCommand) {
    const shellResult = classifyShellCommand(input.command as string)
    if (shellResult) {
      // Ensure shell tools never go below BUILD
      const level = Math.max(shellResult.level, ZoneLevel.BUILD) as ZoneLevel
      return {
        level,
        zoneName: ZONE_LEVEL_NAMES[level],
        reason: shellResult.reason,
        classifier: 'input-analysis',
        ...(shellResult.severityTag ? { severityTag: shellResult.severityTag } : {}),
        ...(shellResult.severityReason ? { severityReason: shellResult.severityReason } : {}),
      }
    }
    // Shell command with no specific classification → BUILD
    return {
      level: ZoneLevel.BUILD,
      zoneName: ZONE_LEVEL_NAMES[ZoneLevel.BUILD],
      reason: `Shell command: ${(input.command as string).slice(0, 60)}`,
      classifier: 'input-analysis',
    }
  }

  // 4b: URL detection with comprehensive SSRF checks
  const url = extractUrl(input)
  if (url) {
    const ssrf = isInternalUrl(url)
    if (ssrf.internal) {
      return {
        level: ZoneLevel.MACHINE,
        zoneName: ZONE_LEVEL_NAMES[ZoneLevel.MACHINE],
        reason: `SSRF risk — ${ssrf.reason}`,
        classifier: 'input-analysis',
      }
    }
    return {
      level: ZoneLevel.NETWORK,
      zoneName: ZONE_LEVEL_NAMES[ZoneLevel.NETWORK],
      reason: `Network access: ${url.slice(0, 80)}`,
      classifier: 'input-analysis',
    }
  }

  // 4c: File path classification
  const pathResult = classifyFilePath(input, workspacePath)
  if (pathResult) {
    return {
      level: pathResult.level,
      zoneName: ZONE_LEVEL_NAMES[pathResult.level],
      reason: pathResult.reason,
      classifier: 'input-analysis',
      ...(pathResult.severityTag ? { severityTag: pathResult.severityTag } : {}),
      ...(pathResult.severityReason ? { severityReason: pathResult.severityReason } : {}),
    }
  }

  // 4d: Tool name heuristics (for MCP and unknown tools)
  const nameResult = classifyByToolName(toolName)
  if (nameResult) {
    return {
      level: nameResult.level,
      zoneName: ZONE_LEVEL_NAMES[nameResult.level],
      reason: nameResult.reason,
      classifier: 'input-analysis',
    }
  }

  // Layer 5: Default — conservative fallback
  const isMcp = toolName.startsWith('mcp__') || toolName.startsWith('mcp.')
  const defaultLevel = isMcp ? ZoneLevel.EXTERNAL : ZoneLevel.BUILD
  return {
    level: defaultLevel,
    zoneName: ZONE_LEVEL_NAMES[defaultLevel],
    reason: isMcp
      ? `Unknown MCP tool defaults to external zone: ${toolName}`
      : `Unknown tool defaults to build zone: ${toolName}`,
    classifier: 'default',
  }
}
