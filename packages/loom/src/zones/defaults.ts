/**
 * Zone Security System — Default Configurations
 *
 * Provides default ZoneConfig per SecurityLevel, including
 * zone thresholds, combination rules, and override templates.
 *
 * @security These defaults determine out-of-box security posture.
 * standard = safe for development. paranoid = safe for enterprise.
 */

import type { SecurityLevel } from '../security/types.js'
import type { ZoneConfig, CombinationRule, ZoneLevel as ZoneLevelType } from './types.js'
import { ZoneLevel } from './types.js'

// ---------------------------------------------------------------------------
// Default combination rules
// ---------------------------------------------------------------------------

/**
 * Exfiltration prevention: if a tool recently accessed sensitive files,
 * block subsequent network access.
 *
 * Checks multiple field names for file paths and matches against known
 * sensitive file patterns from our sandbox backend.
 *
 * @security Novel cross-zone detection.
 */
const EXFILTRATION_RULE: CombinationRule = {
  name: 'exfiltration-prevention',
  description: 'Block network access after reading sensitive files',
  triggers: [
    {
      tag: 'read-secrets',
      zone: ZoneLevel.SAFE,
      // Matches sensitive file paths in ANY field value (JSON serialized)
      // Covers: .env, .pem, .key, credentials, SSH keys, AWS, .netrc, secrets
      inputPattern: /\.(env|pem|key|p12|pfx|jks)\b|credentials|id_rsa|id_ed25519|\.aws\/|\.ssh\/|secret[_-]?key|\.netrc|\.npmrc|\.pypirc/i,
    },
    {
      tag: 'network-access',
      zone: ZoneLevel.NETWORK,
    },
  ],
  decision: 'ask',
  windowMs: 120_000,
}

/**
 * Credential harvesting: if search/grep was used with credential patterns,
 * block subsequent network access.
 *
 * Matches ANY search tool (not just 'grep') by checking for credential
 * keywords in serialized input.
 */
const CREDENTIAL_HARVESTING_RULE: CombinationRule = {
  name: 'credential-harvesting',
  description: 'Block network after searching for credentials',
  triggers: [
    {
      tag: 'search-credentials',
      zone: ZoneLevel.SAFE,
      // Match any tool that searches for credential patterns
      inputPattern: /password|secret|token|api[_-]?key|private[_-]?key|credential|bearer|authorization/i,
    },
    {
      tag: 'network-access',
      zone: ZoneLevel.NETWORK,
    },
  ],
  decision: 'ask',
  windowMs: 120_000,
}

/**
 * Shell after sensitive read: if sensitive files were read,
 * shell execution requires approval (could pipe secrets to network).
 */
const SHELL_AFTER_SECRETS_RULE: CombinationRule = {
  name: 'shell-after-secrets',
  description: 'Require approval for shell execution after reading sensitive files',
  triggers: [
    {
      tag: 'read-secrets',
      zone: ZoneLevel.SAFE,
      inputPattern: /\.(env|pem|key)\b|credentials|id_rsa|id_ed25519|\.aws\/|\.ssh\//i,
    },
    {
      tag: 'shell-execution',
      zone: ZoneLevel.BUILD,
    },
  ],
  decision: 'ask',
  windowMs: 60_000,
}

/**
 * DNS exfiltration: if secrets were read and a DNS tool is used,
 * block it (nslookup/dig with command substitution can exfil data).
 */
const DNS_EXFILTRATION_RULE: CombinationRule = {
  name: 'dns-exfiltration',
  description: 'Block DNS queries after reading sensitive files',
  triggers: [
    {
      tag: 'read-secrets',
      zone: ZoneLevel.SAFE,
      inputPattern: /\.(env|pem|key)\b|credentials|id_rsa|\.aws\/|\.ssh\//i,
    },
    {
      tag: 'dns-query',
      zone: ZoneLevel.BUILD,
      inputPattern: /\b(dig|nslookup|host)\b/i,
    },
  ],
  decision: 'ask',
  windowMs: 60_000,
}

/**
 * Clipboard exfiltration: if secrets were read and clipboard is accessed,
 * require approval.
 */
const CLIPBOARD_EXFIL_RULE: CombinationRule = {
  name: 'clipboard-exfiltration',
  description: 'Require approval for clipboard access after reading sensitive files',
  triggers: [
    {
      tag: 'read-secrets',
      zone: ZoneLevel.SAFE,
      inputPattern: /\.(env|pem|key)\b|credentials|id_rsa|\.aws\/|\.ssh\//i,
    },
    {
      tag: 'clipboard-access',
      zone: ZoneLevel.BUILD,
      inputPattern: /\b(pbcopy|pbpaste|xclip|xsel|clip)\b/i,
    },
  ],
  decision: 'ask',
  windowMs: 60_000,
}

/** All default combination rules. */
export const DEFAULT_COMBINATION_RULES: readonly CombinationRule[] = [
  EXFILTRATION_RULE,
  CREDENTIAL_HARVESTING_RULE,
  SHELL_AFTER_SECRETS_RULE,
  DNS_EXFILTRATION_RULE,
  CLIPBOARD_EXFIL_RULE,
]

// ---------------------------------------------------------------------------
// Default zone configs per security level
// ---------------------------------------------------------------------------

/**
 * Zone threshold configs per security level.
 *
 * | Level      | Auto-allow up to | Ask up to    | Above = deny |
 * |------------|-----------------|-------------|--------------|
 * | permissive | NETWORK (3)     | MACHINE (5) | NEVER only   |
 * | standard   | WORKSPACE (1)   | MACHINE (5) | NEVER only   |
 * | strict     | SAFE (0)        | BUILD (2)   | NETWORK+     |
 * | paranoid   | SAFE (0)        | SAFE (0)    | Everything   |
 *
 * Standard treats Zone 5 (MACHINE — read outside workspace, browser with
 * auth, cloud CLI) as **ask**, not deny: the agent can roam beyond the
 * workspace, but the user gates every step out. Zone 6 (NEVER — rm -rf /,
 * sudo, .ssh writes) is still a hard deny with no override.
 */
export const ZONE_CONFIGS: Readonly<Record<SecurityLevel, ZoneConfig>> = {
  permissive: {
    securityLevel: 'permissive',
    maxAutoZone: ZoneLevel.NETWORK,
    maxAskZone: ZoneLevel.MACHINE,
    combinationRules: DEFAULT_COMBINATION_RULES,
    overrides: [],
  },
  standard: {
    securityLevel: 'standard',
    maxAutoZone: ZoneLevel.WORKSPACE,
    maxAskZone: ZoneLevel.MACHINE,
    combinationRules: DEFAULT_COMBINATION_RULES,
    overrides: [],
  },
  strict: {
    securityLevel: 'strict',
    maxAutoZone: ZoneLevel.SAFE,
    maxAskZone: ZoneLevel.BUILD,
    combinationRules: DEFAULT_COMBINATION_RULES,
    overrides: [],
  },
  paranoid: {
    securityLevel: 'paranoid',
    maxAutoZone: ZoneLevel.SAFE,
    maxAskZone: ZoneLevel.SAFE,
    combinationRules: DEFAULT_COMBINATION_RULES,
    overrides: [],
  },
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a ZoneConfig for a security level with optional overrides.
 *
 * @param level - Security level preset
 * @param overrides - Partial overrides to merge
 */
export function createZoneConfig(
  level: SecurityLevel,
  overrides?: {
    readonly maxAutoZone?: ZoneLevelType
    readonly maxAskZone?: ZoneLevelType
    readonly combinationRules?: readonly CombinationRule[]
    readonly overrides?: readonly import('./types.js').ZoneOverride[]
  },
): ZoneConfig {
  const base = ZONE_CONFIGS[level]
  if (!overrides) return base

  return {
    securityLevel: level,
    maxAutoZone: overrides.maxAutoZone ?? base.maxAutoZone,
    maxAskZone: overrides.maxAskZone ?? base.maxAskZone,
    combinationRules: overrides.combinationRules ?? base.combinationRules,
    overrides: overrides.overrides ?? base.overrides,
  }
}
