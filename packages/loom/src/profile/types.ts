/**
 * Profile Types
 *
 * A profile defines everything about an agent: its model, tools, skills,
 * memory, system prompt, MCP servers, and behavioral rules. Profiles are
 * loaded from directories containing agent.json + SOUL.md + AGENTS.md.
 */

import type { MCPServerConfig } from '../mcp/types.js'

// ---------------------------------------------------------------------------
// Profile configuration (agent.json schema)
// ---------------------------------------------------------------------------

/** Full profile configuration as defined in agent.json or agent.yaml */
export interface ProfileConfig {
  /** Profile name (unique identifier) */
  readonly name: string

  /** Human-readable description */
  readonly description?: string

  /** Model identifier (e.g., "anthropic:claude-sonnet-4-20250514") */
  readonly model?: string

  /** Temperature (0-2). Null = provider default. */
  readonly temperature?: number

  /** Maximum turns per session */
  readonly maxTurns?: number

  /** Maximum output tokens per model call */
  readonly maxTokens?: number

  /** Raw system prompt (overrides SOUL.md if set) */
  readonly systemPrompt?: string

  /** Tool configuration */
  readonly tools?: ToolConfig

  /** Legacy middleware list (ignored by Loom, kept for backwards compat) */
  readonly middleware?: readonly string[]

  /** Paths to skill directories (relative to profile dir) */
  readonly skills?: readonly string[]

  /** Paths to memory files (AGENTS.md) */
  readonly memory?: readonly string[]

  /** MCP server configurations */
  readonly mcpServers?: readonly MCPServerConfig[]

  /** Workspace configuration */
  readonly workspace?: WorkspaceConfig

  /** Sandbox configuration */
  readonly sandbox?: SandboxConfig

  /** Sub-agent definitions */
  readonly subagents?: readonly SubagentSpec[]
}

// ---------------------------------------------------------------------------
// Sub-types
// ---------------------------------------------------------------------------

/** Tool access control */
export interface ToolConfig {
  /** Built-in tool names to enable */
  readonly builtin?: readonly string[]
  /** Paths to custom tool modules */
  readonly custom?: readonly string[]
  /** Tool names to explicitly deny */
  readonly deny?: readonly string[]
}

/** Workspace mode */
export interface WorkspaceConfig {
  /** Root directory for the workspace */
  readonly root?: string
  /** 'cwd' = use current directory, 'isolated' = create isolated workspace */
  readonly mode?: 'cwd' | 'isolated'
}

/** Sandbox settings */
export interface SandboxConfig {
  /** Whether sandboxing is enabled */
  readonly enabled: boolean
}

/** Sub-agent specification */
export interface SubagentSpec {
  /** Agent name (used for spawning) */
  readonly name: string
  /** Description of what this agent does */
  readonly description: string
  /** Profile name to load (null = inline config) */
  readonly profile?: string
  /** Model override */
  readonly model?: string
  /** Tool names available to this agent */
  readonly tools?: readonly string[]
}

// ---------------------------------------------------------------------------
// Loaded profile (fully resolved)
// ---------------------------------------------------------------------------

/** A profile that has been loaded and resolved from disk */
export interface LoadedProfile {
  /** The validated configuration */
  readonly config: ProfileConfig
  /** Content of SOUL.md (system prompt identity) */
  readonly soulMd: string
  /** Content of AGENTS.md (memory) */
  readonly agentsMd: string
  /** Path to skills directory (if exists) */
  readonly skillsDir?: string
  /** Absolute path to the profile directory */
  readonly basePath: string
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ProfileError extends Error {
  constructor(
    message: string,
    public readonly profilePath: string,
    public readonly field?: string,
  ) {
    super(message)
    this.name = 'ProfileError'
  }
}
