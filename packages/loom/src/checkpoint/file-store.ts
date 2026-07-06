/**
 * File-based Checkpoint Store
 *
 * Persists checkpoints as JSON files in a directory.
 * Each checkpoint is stored at `{dir}/{sessionId}.json`.
 *
 * Creates the directory on first write if it doesn't exist.
 * Survives process restarts — good for local development and CLI tools.
 */

import { mkdir, readFile, writeFile, readdir, unlink, stat } from 'fs/promises'
import { join } from 'path'
import type { Checkpoint, CheckpointStore } from './types.js'
import { serializeCheckpoint, deserializeCheckpoint } from './serializer.js'

export class FileCheckpointStore implements CheckpointStore {
  private readonly dir: string
  private dirEnsured = false

  /**
   * @param dir - Directory path where checkpoint files will be stored
   */
  constructor(dir: string) {
    this.dir = dir
  }

  /**
   * Save a checkpoint to disk. Creates the directory if needed.
   * Returns the session ID as the checkpoint identifier.
   */
  async save(checkpoint: Checkpoint): Promise<string> {
    await this.ensureDir()

    const filePath = this.pathFor(checkpoint.sessionId)
    const json = serializeCheckpoint(checkpoint)
    await writeFile(filePath, json, 'utf-8')
    return checkpoint.sessionId
  }

  /**
   * Load a checkpoint from disk by session ID.
   * Returns null if the file doesn't exist or is corrupted.
   */
  async load(sessionId: string): Promise<Checkpoint | null> {
    const filePath = this.pathFor(sessionId)

    let content: string
    try {
      content = await readFile(filePath, 'utf-8')
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        return null
      }
      throw err
    }

    try {
      return deserializeCheckpoint(content)
    } catch (err) {
      console.warn(
        `FileCheckpointStore: corrupt checkpoint at ${filePath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
      return null
    }
  }

  /**
   * List all stored sessions by scanning the directory for .json files.
   * Returns session IDs with timestamps, sorted most recent first.
   */
  async list(): Promise<Array<{ sessionId: string; timestamp: number }>> {
    try {
      const entries = await readdir(this.dir)
      const results: Array<{ sessionId: string; timestamp: number }> = []

      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue

        const sessionId = entry.slice(0, -5) // strip .json
        const filePath = join(this.dir, entry)

        try {
          // Use file mtime as a fast proxy for timestamp.
          // For exact checkpoint timestamps, we'd need to read+parse each file.
          const fileStat = await stat(filePath)
          results.push({ sessionId, timestamp: fileStat.mtimeMs })
        } catch {
          // File may have been deleted between readdir and stat — skip it
        }
      }

      results.sort((a, b) => b.timestamp - a.timestamp)
      return results
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        return [] // Directory doesn't exist yet
      }
      throw err
    }
  }

  /**
   * Delete a checkpoint file. No-op if the file doesn't exist.
   */
  async delete(sessionId: string): Promise<void> {
    const filePath = this.pathFor(sessionId)
    try {
      await unlink(filePath)
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        return // Already gone
      }
      throw err
    }
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private pathFor(sessionId: string): string {
    // Sanitize sessionId to prevent path traversal
    const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
    return join(this.dir, `${safe}.json`)
  }

  private async ensureDir(): Promise<void> {
    if (this.dirEnsured) return
    await mkdir(this.dir, { recursive: true })
    this.dirEnsured = true
  }
}

/**
 * Type guard for Node.js errors with a `code` property.
 */
function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err
}
