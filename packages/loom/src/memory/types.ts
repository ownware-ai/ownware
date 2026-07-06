/**
 * Memory Module Types
 *
 * Memory sources provide persistent context to the agent — things like
 * AGENTS.md files, correction history, and session summaries.
 */

// ---------------------------------------------------------------------------
// Memory source
// ---------------------------------------------------------------------------

/** Where a memory file lives and how to parse it */
export interface MemorySource {
  /** Absolute path to the memory file */
  readonly path: string
  /** File format */
  readonly format: 'markdown' | 'yaml'
}

// ---------------------------------------------------------------------------
// Memory entry
// ---------------------------------------------------------------------------

/** A loaded memory file with its content and metadata */
export interface MemoryEntry {
  /** The source this was loaded from */
  readonly source: MemorySource
  /** Raw file content */
  readonly content: string
  /** Unix timestamp (ms) when this was loaded */
  readonly loadedAt: number
}

// ---------------------------------------------------------------------------
// Memory config
// ---------------------------------------------------------------------------

/** Configuration for the memory subsystem */
export interface MemoryConfig {
  /** Ordered list of memory sources (later sources override earlier) */
  readonly sources: readonly MemorySource[]
  /** Whether to enable auto-learning from corrections */
  readonly autoLearn: boolean
}

// ---------------------------------------------------------------------------
// Session summary (for recall)
// ---------------------------------------------------------------------------

/** Summary of a past session for cross-session recall */
export interface SessionSummary {
  /** Session identifier */
  readonly sessionId: string
  /** Brief summary text */
  readonly summary: string
  /** Keywords extracted from the session */
  readonly keywords: readonly string[]
  /** ISO timestamp of the session */
  readonly timestamp: string
}
