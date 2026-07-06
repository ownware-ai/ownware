/**
 * Connector Types
 *
 * Types for the MCP connector layer: registry entries, credential storage,
 * and connection status tracking.
 */

// ---------------------------------------------------------------------------
// MCP Registry (from registry.modelcontextprotocol.io)
// ---------------------------------------------------------------------------

/** An environment variable required by an MCP server */
export interface MCPEnvVar {
  readonly name: string
  readonly description: string
  readonly isRequired: boolean
  /** Whether this is a secret (API key, token). Masked in UI, encrypted at rest. */
  readonly isSecret: boolean
  /**
   * Optional URL where the user can obtain this credential (vendor dashboard,
   * OAuth playground, settings page). Rendered as a "Get your {label} →" link
   * below the input in the credential dialog.
   */
  readonly helpUrl?: string
  /**
   * Optional transform hint for the UI + save path. When set, the credential
   * dialog renders a friendlier prompt (not the raw env var name) and wraps
   * the user's input before it is persisted.
   *
   * - `notion-headers` — user pastes a Notion integration token (e.g.
   *   `secret_abc…`) and it is wrapped into the JSON header object Notion's
   *   MCP server actually expects:
   *   `{"Authorization":"Bearer <token>","Notion-Version":"2022-06-28"}`
   */
  readonly transform?: 'notion-headers'
}

/** An entry from the official MCP registry */
export interface MCPRegistryEntry {
  /** Unique registry ID (e.g., "io.github.user/weather") */
  readonly id: string
  /** Display name */
  readonly title: string
  /** Short description (max ~100 chars) */
  readonly description: string
  /** Icon URL (if available) */
  readonly icon: string | null
  /** Server category */
  readonly category: MCPCategory
  /** Transport type */
  readonly transport: 'stdio' | 'sse' | 'http'
  /** Package identifier (e.g., "@modelcontextprotocol/server-github") */
  readonly package: string | null
  /** Runtime hint (e.g., "npx", "uvx", "docker") */
  readonly runtime: string | null
  /** Required environment variables */
  readonly requiredEnv: readonly MCPEnvVar[]
  /** Optional environment variables */
  readonly optionalEnv: readonly MCPEnvVar[]
  /** Remote URL (for hosted servers — no install needed) */
  readonly remoteUrl: string | null
  /** Repository URL */
  readonly repository: string | null
  /** Website/docs URL */
  readonly websiteUrl: string | null
  /** Package arguments (e.g., ["--port", "3000"]) */
  readonly packageArgs: readonly string[]
  /** Server version */
  readonly version: string
}

export type MCPCategory =
  | 'dev-tools'
  | 'communication'
  | 'data'
  | 'browser'
  | 'productivity'
  | 'ai'
  | 'cloud'
  | 'finance'
  | 'other'

// ---------------------------------------------------------------------------
// Credential store
// ---------------------------------------------------------------------------

/** Stored credentials for an MCP server */
export interface MCPCredentials {
  /** Server registry ID */
  readonly serverId: string
  /** Environment variable values (name → value) */
  readonly env: Record<string, string>
  /** When credentials were last saved */
  readonly updatedAt: string
}

// ---------------------------------------------------------------------------
// Connected MCP server (profile-level)
// ---------------------------------------------------------------------------

/** An MCP server attached to a profile */
export interface ProfileMCPServer {
  /** Server registry ID or custom ID */
  readonly serverId: string
  /** Display name */
  readonly name: string
  /** Transport */
  readonly transport: 'stdio' | 'sse' | 'http' | 'websocket'
  /** Connection status */
  readonly status: 'ready' | 'missing_credentials' | 'connected' | 'error'
  /** Number of tools discovered (null if not connected) */
  readonly toolCount: number | null
  /** Which required env vars are set */
  readonly envStatus: readonly EnvVarStatus[]
  /** Error message (if status is 'error') */
  readonly error?: string
  /** Is this from the registry (vs custom) */
  readonly isRegistry: boolean
}

export interface EnvVarStatus {
  readonly name: string
  readonly description: string
  readonly isRequired: boolean
  readonly isSecret: boolean
  /** Whether this env var is currently set */
  readonly isSet: boolean
}
