/**
 * In-Memory Checkpoint Store
 *
 * Stores checkpoints in a Map. Fastest store — zero I/O latency.
 * Good for development, testing, and short-lived processes.
 * All data is lost on process exit.
 */

import type { Checkpoint, CheckpointStore } from './types.js'

export class MemoryCheckpointStore implements CheckpointStore {
  private readonly store = new Map<string, Checkpoint>()

  /**
   * Save a checkpoint. Returns the session ID as the checkpoint identifier.
   */
  async save(checkpoint: Checkpoint): Promise<string> {
    this.store.set(checkpoint.sessionId, {
      ...checkpoint,
      timestamp: checkpoint.timestamp || Date.now(),
    })
    return checkpoint.sessionId
  }

  /**
   * Load a checkpoint by session ID. Returns null if not found.
   */
  async load(sessionId: string): Promise<Checkpoint | null> {
    return this.store.get(sessionId) ?? null
  }

  /**
   * List all stored sessions with their timestamps.
   * Sorted by timestamp descending (most recent first).
   */
  async list(): Promise<Array<{ sessionId: string; timestamp: number }>> {
    const entries = Array.from(this.store.entries()).map(([sessionId, cp]) => ({
      sessionId,
      timestamp: cp.timestamp,
    }))
    entries.sort((a, b) => b.timestamp - a.timestamp)
    return entries
  }

  /**
   * Delete a checkpoint by session ID. No-op if not found.
   */
  async delete(sessionId: string): Promise<void> {
    this.store.delete(sessionId)
  }

  /** Number of stored checkpoints (useful for testing) */
  get size(): number {
    return this.store.size
  }

  /** Clear all checkpoints (useful for testing) */
  clear(): void {
    this.store.clear()
  }
}
