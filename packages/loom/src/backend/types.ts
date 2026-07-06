/**
 * Backend Protocol Types
 *
 * Defines the filesystem abstraction layer for Loom. All file operations
 * go through a BackendProtocol, enabling local, remote, sandboxed, and
 * zone-routed backends with a single interface.
 */

// ---------------------------------------------------------------------------
// File system primitives
// ---------------------------------------------------------------------------

/** A directory entry with metadata */
export interface FileEntry {
  /** File or directory name */
  readonly name: string
  /** Full absolute path */
  readonly path: string
  /** Whether this entry is a directory */
  readonly isDirectory: boolean
  /** File size in bytes (0 for directories) */
  readonly size: number
  /** Last modification time (Unix ms) */
  readonly modifiedAt: number
}

/** A single grep match */
export interface GrepResult {
  /** File path containing the match */
  readonly path: string
  /** 1-based line number */
  readonly lineNumber: number
  /** Line content containing the match */
  readonly content: string
}

/** Result of a shell command execution */
export interface ExecResult {
  /** Standard output */
  readonly stdout: string
  /** Standard error */
  readonly stderr: string
  /** Process exit code */
  readonly exitCode: number
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Options for readFile */
export interface ReadFileOptions {
  /** Start reading from this line (0-based). Default 0. */
  readonly offset?: number
  /** Maximum number of lines to read. Default: all. */
  readonly limit?: number
}

/** Options for execute */
export interface ExecOptions {
  /** Timeout in milliseconds. Default: 120_000. */
  readonly timeout?: number
  /** Working directory for the command. */
  readonly cwd?: string
  /** Abort signal for cancellation. */
  readonly signal?: AbortSignal
}

// ---------------------------------------------------------------------------
// Backend protocol
// ---------------------------------------------------------------------------

/**
 * Filesystem abstraction protocol.
 *
 * Every file operation the agent performs goes through this interface.
 * Implementations: LocalBackend, SandboxBackend, ZoneRouter.
 */
export interface BackendProtocol {
  /** Read file content, optionally with line offset and limit */
  readFile(path: string, opts?: ReadFileOptions): Promise<string>

  /** Write content to a file (creates parent dirs if needed) */
  writeFile(path: string, content: string): Promise<void>

  /** Replace an exact string in a file */
  editFile(path: string, oldString: string, newString: string): Promise<void>

  /** List entries in a directory */
  listFiles(path: string): Promise<FileEntry[]>

  /** Find files matching a glob pattern */
  glob(pattern: string, path?: string): Promise<string[]>

  /** Search file contents for a pattern */
  grep(pattern: string, path?: string, glob?: string): Promise<GrepResult[]>

  /** Check whether a path exists */
  exists(path: string): Promise<boolean>

  /** Execute a shell command (optional — not all backends support this) */
  execute?(command: string, opts?: ExecOptions): Promise<ExecResult>
}

// ---------------------------------------------------------------------------
// Zones
// ---------------------------------------------------------------------------

/** Permission level for a filesystem zone */
export type ZonePermission = 'ro' | 'rw'

/**
 * A filesystem zone maps a path prefix to a backend with a permission level.
 * The ZoneRouter uses these to route operations.
 */
export interface Zone {
  /** Path prefix this zone covers (e.g., '/', '/memory') */
  readonly path: string
  /** Permission level */
  readonly permission: ZonePermission
  /** Backend that handles operations in this zone */
  readonly backend: BackendProtocol
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class BackendError extends Error {
  constructor(
    message: string,
    public readonly code: BackendErrorCode,
    public readonly path?: string,
  ) {
    super(message)
    this.name = 'BackendError'
  }
}

export type BackendErrorCode =
  | 'NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'PATH_TRAVERSAL'
  | 'SENSITIVE_FILE'
  | 'EDIT_MISMATCH'
  | 'TIMEOUT'
  | 'EXEC_FAILED'
  | 'INVALID_PATH'
