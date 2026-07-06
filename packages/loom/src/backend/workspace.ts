/**
 * Workspace Manager
 *
 * Manages isolated workspace directories for agent sessions.
 * Workspaces live under ~/.ownware/workspaces/ by default.
 *
 * The `.ownware` directory name mirrors cortex's
 * `DEFAULT_DATA_DIR_NAME`. Loom can't import from cortex (foundation
 * layer), so the constant is duplicated; both must move in lockstep on
 * any future rename.
 */

import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_WORKSPACE_ROOT = join(homedir(), '.ownware', 'workspaces')

// ---------------------------------------------------------------------------
// WorkspaceManager
// ---------------------------------------------------------------------------

export class WorkspaceManager {
  private readonly root: string

  /**
   * @param root - Root directory for all workspaces. Default: ~/.ownware/workspaces/
   */
  constructor(root?: string) {
    this.root = root ?? DEFAULT_WORKSPACE_ROOT
  }

  /** Get the workspace root directory */
  getRoot(): string {
    return this.root
  }

  /**
   * Create a new workspace directory.
   * @param name - Workspace name (used as directory name)
   * @returns Absolute path to the created workspace
   */
  async createWorkspace(name: string): Promise<string> {
    const path = this.workspacePath(name)
    await mkdir(path, { recursive: true })
    return path
  }

  /**
   * Get the path of an existing workspace.
   * @param name - Workspace name
   * @returns Absolute path, or null if workspace doesn't exist
   */
  async getWorkspace(name: string): Promise<string | null> {
    const path = this.workspacePath(name)
    try {
      const s = await stat(path)
      return s.isDirectory() ? path : null
    } catch {
      return null
    }
  }

  /**
   * List all workspace names.
   * @returns Array of workspace names
   */
  async listWorkspaces(): Promise<string[]> {
    try {
      const entries = await readdir(this.root, { withFileTypes: true })
      return entries
        .filter(e => e.isDirectory())
        .map(e => e.name)
        .sort()
    } catch {
      return [] // Root doesn't exist yet
    }
  }

  /**
   * Remove a workspace directory and all its contents.
   * @param name - Workspace name
   * @returns true if removed, false if it didn't exist
   */
  async cleanupWorkspace(name: string): Promise<boolean> {
    const path = this.workspacePath(name)
    try {
      await rm(path, { recursive: true, force: true })
      return true
    } catch {
      return false
    }
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private workspacePath(name: string): string {
    // Sanitize name to prevent path traversal
    const safe = name.replace(/[^a-zA-Z0-9_\-\.]/g, '_')
    return join(this.root, safe)
  }
}
