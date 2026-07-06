/**
 * Zone Security System — Type Definitions
 *
 * Seven-level zone classification for agent tool calls.
 * Every tool call is classified into a zone (0=SAFE through 6=NEVER),
 * then evaluated against the session's security policy.
 *
 * @security Core types for the zone security framework.
 * All properties are readonly. All types are serializable.
 */

import type { PolicyDecision } from '../permissions/types.js'
import type { SecurityLevel } from '../security/types.js'

// ---------------------------------------------------------------------------
// Zone levels
// ---------------------------------------------------------------------------

/**
 * Zone levels as numeric constants for threshold comparison.
 *
 * Higher numbers = more dangerous.
 * Policy uses `<=` comparison: if zone <= maxAutoZone → auto-allow.
 */
export const ZoneLevel = {
  /** Read workspace, read-only commands, web search, save memory */
  SAFE: 0,
  /** Write/edit/delete in workspace, local git ops */
  WORKSPACE: 1,
  /** Shell execution in workspace, package install, tests */
  BUILD: 2,
  /** Fetch URLs, API calls, download packages */
  NETWORK: 3,
  /** Git push, create PR, deploy, send messages, MCP writes */
  EXTERNAL: 4,
  /** Read outside workspace, browser with auth, cloud CLI */
  MACHINE: 5,
  /** rm -rf /, sudo, .ssh writes, fork bombs — always blocked */
  NEVER: 6,
} as const

export type ZoneLevel = typeof ZoneLevel[keyof typeof ZoneLevel]

// ---------------------------------------------------------------------------
// Zone level names
// ---------------------------------------------------------------------------

/** Human-readable zone names for serialization and display. */
export type ZoneLevelName =
  | 'safe'
  | 'workspace'
  | 'build'
  | 'network'
  | 'external'
  | 'machine'
  | 'never'

/** Map numeric zone level → name. */
export const ZONE_LEVEL_NAMES: Readonly<Record<ZoneLevel, ZoneLevelName>> = {
  [ZoneLevel.SAFE]: 'safe',
  [ZoneLevel.WORKSPACE]: 'workspace',
  [ZoneLevel.BUILD]: 'build',
  [ZoneLevel.NETWORK]: 'network',
  [ZoneLevel.EXTERNAL]: 'external',
  [ZoneLevel.MACHINE]: 'machine',
  [ZoneLevel.NEVER]: 'never',
}

/** Map name → numeric zone level. */
export const ZONE_NAME_LEVELS: Readonly<Record<ZoneLevelName, ZoneLevel>> = {
  safe: ZoneLevel.SAFE,
  workspace: ZoneLevel.WORKSPACE,
  build: ZoneLevel.BUILD,
  network: ZoneLevel.NETWORK,
  external: ZoneLevel.EXTERNAL,
  machine: ZoneLevel.MACHINE,
  never: ZoneLevel.NEVER,
}

// ---------------------------------------------------------------------------
// Classification result
// ---------------------------------------------------------------------------

/** Which classifier layer determined the zone. */
export type ClassifierLayer =
  | 'exact'
  | 'pattern'
  | 'category'
  | 'input-analysis'
  | 'default'

/**
 * Severity tag for the UI permission card.
 *
 * Independent of zone level — a Zone BUILD call can carry a
 * 'critical' severity (e.g. a shell command flagged as injection by
 * shell-security) so the prompt UI renders a red warning even though
 * the policy decides via the usual threshold. The user reads the
 * warning and decides.
 *
 *   - 'info'     — informational, render plainly
 *   - 'warn'     — yellow border, "this looked unusual"
 *   - 'critical' — red border + skull icon, "destructive or sensitive"
 */
export type SeverityTag = 'info' | 'warn' | 'critical'

/** Result of classifying a tool call into a zone. */
export interface ZoneClassification {
  /** The zone level assigned to this tool call */
  readonly level: ZoneLevel
  /** Human-readable zone name */
  readonly zoneName: ZoneLevelName
  /** Why this zone was chosen */
  readonly reason: string
  /** Which classifier layer determined it */
  readonly classifier: ClassifierLayer
  /**
   * Optional UI severity tag. Travels alongside the policy decision
   * so the permission card can style the prompt independently of the
   * zone level. Absent = no special warning, render plainly.
   */
  readonly severityTag?: SeverityTag
  /** Human-readable explanation tied to the severity tag. */
  readonly severityReason?: string
}

// ---------------------------------------------------------------------------
// Zone decision
// ---------------------------------------------------------------------------

/** Result of evaluating a zone classification against policy. */
export interface ZoneDecision {
  /** The classification that was evaluated */
  readonly classification: ZoneClassification
  /** The policy decision: allow, deny, or ask */
  readonly decision: PolicyDecision
  /** Human-readable explanation for the user */
  readonly explanation: string
  /** Set if blocked by a combination rule */
  readonly combinationBlock?: CombinationBlockReason
}

// ---------------------------------------------------------------------------
// Combination detection
// ---------------------------------------------------------------------------

/** Why a combination rule blocked a tool call. */
export interface CombinationBlockReason {
  /** Rule name (e.g., 'exfiltration-prevention') */
  readonly rule: string
  /** Recent tool calls that contributed to the trigger */
  readonly recentTools: readonly CombinationToolEntry[]
  /** Human-readable explanation */
  readonly explanation: string
}

/** A recorded tool call in the combination history. */
export interface CombinationToolEntry {
  readonly toolName: string
  readonly zone: ZoneLevel
  readonly timestamp: number
  /** Tags from trigger matching (e.g., 'read-secrets', 'network') */
  readonly tags: readonly string[]
}

/** A declarative combination rule. */
export interface CombinationRule {
  /** Unique rule identifier */
  readonly name: string
  /** Human-readable description */
  readonly description: string
  /** All triggers must be satisfied for the rule to fire */
  readonly triggers: readonly CombinationTrigger[]
  /** Decision when this combination is detected */
  readonly decision: PolicyDecision
  /** Window in ms to look back for triggers (default: 60_000) */
  readonly windowMs?: number
}

/** A single trigger condition within a combination rule. */
export interface CombinationTrigger {
  /** Match by zone level */
  readonly zone?: ZoneLevel
  /** Match by tool name (glob pattern) */
  readonly toolPattern?: string
  /** Match by JSON-serialized input content */
  readonly inputPattern?: RegExp
  /** Label for this trigger (e.g., 'read-secrets', 'network-access') */
  readonly tag: string
}

// ---------------------------------------------------------------------------
// Zone configuration
// ---------------------------------------------------------------------------

/** Zone configuration — determines how zones map to policy decisions. */
export interface ZoneConfig {
  /** Security level this config is based on */
  readonly securityLevel: SecurityLevel
  /** Highest zone level that auto-allows (no prompt) */
  readonly maxAutoZone: ZoneLevel
  /** Highest zone level that prompts user (above this = deny) */
  readonly maxAskZone: ZoneLevel
  /** Cross-zone combination rules */
  readonly combinationRules: readonly CombinationRule[]
  /** Tool-specific zone overrides (checked by pattern classifier) */
  readonly overrides: readonly ZoneOverride[]
}

/** Override classification for a specific tool pattern. */
export interface ZoneOverride {
  /** Glob pattern matching tool name */
  readonly toolPattern: string
  /** Zone level to assign */
  readonly level: ZoneLevel
  /** Optional reason for the override */
  readonly reason?: string
}

// ---------------------------------------------------------------------------
// Zone expansion
// ---------------------------------------------------------------------------

/** A user-approved zone escalation. */
export interface ZoneExpansion {
  /** Zone level that was approved */
  readonly level: ZoneLevel
  /** Tool pattern that was approved (could be specific or glob) */
  readonly toolPattern: string
  /** When the expansion was granted */
  readonly grantedAt: number
  /** When the expansion expires (null = session lifetime) */
  readonly expiresAt: number | null
  /** Scope of the approval */
  readonly scope: 'once' | 'session' | 'tool-pattern'
}

// ---------------------------------------------------------------------------
// Zone context
// ---------------------------------------------------------------------------

/** Context passed through the zone evaluation pipeline. */
export interface ZoneContext {
  /** Tool being invoked */
  readonly toolName: string
  /** Tool input parameters */
  readonly input: Readonly<Record<string, unknown>>
  /** Tool category if known */
  readonly toolCategory?: string
  /** Whether the tool is read-only */
  readonly toolIsReadOnly?: boolean
  /** Current session ID */
  readonly sessionId: string
  /** Agent ID (null = root agent) */
  readonly agentId?: string
  /** Workspace path for relative path resolution */
  readonly workspacePath?: string
}
