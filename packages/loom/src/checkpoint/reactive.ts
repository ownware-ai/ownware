/**
 * Reactive Checkpointer
 *
 * Wraps any CheckpointStore with debounced, fire-and-forget saving.
 * Useful for auto-saving session state without blocking the main loop.
 */

import type { Checkpoint, CheckpointStore } from './types.js'

export interface ReactiveCheckpointerOptions {
  /** Debounce interval in milliseconds (default 1000). */
  debounceMs?: number
  /** Error handler — defaults to console.error. */
  onError?: (err: Error) => void
}

export class ReactiveCheckpointer {
  private readonly store: CheckpointStore
  private readonly debounceMs: number
  private readonly onError: (err: Error) => void
  private pending: ReturnType<typeof setTimeout> | null = null
  private pendingCheckpoint: Checkpoint | null = null
  private lastSaved: Checkpoint | null = null

  constructor(store: CheckpointStore, opts?: ReactiveCheckpointerOptions) {
    this.store = store
    this.debounceMs = opts?.debounceMs ?? 1000
    this.onError = opts?.onError ?? ((err) => console.error('[ReactiveCheckpointer]', err))
  }

  /**
   * Schedule a save. If called again within debounceMs the previous
   * timer is cancelled and a new one starts. Never throws — errors
   * are routed to the onError callback.
   */
  scheduleCheckpoint(checkpoint: Checkpoint): void {
    this.pendingCheckpoint = checkpoint

    if (this.pending !== null) {
      clearTimeout(this.pending)
    }

    this.pending = setTimeout(() => {
      this.pending = null
      const cp = this.pendingCheckpoint
      if (cp === null) return
      this.pendingCheckpoint = null
      this.store.save(cp).then(
        () => {
          this.lastSaved = cp
        },
        (err: unknown) => {
          this.onError(err instanceof Error ? err : new Error(String(err)))
        },
      )
    }, this.debounceMs)
  }

  /**
   * Force an immediate save, cancelling any pending debounce timer.
   * Returns the checkpoint ID from the store.
   */
  async saveNow(checkpoint: Checkpoint): Promise<string> {
    // Cancel any pending debounce
    if (this.pending !== null) {
      clearTimeout(this.pending)
      this.pending = null
    }
    this.pendingCheckpoint = null

    const id = await this.store.save(checkpoint)
    this.lastSaved = checkpoint
    return id
  }

  /** True if a debounced save is waiting to fire. */
  get hasPending(): boolean {
    return this.pending !== null
  }

  /**
   * If there is a pending checkpoint, save it immediately.
   * No-op if nothing is pending.
   */
  async flush(): Promise<void> {
    if (this.pending !== null) {
      clearTimeout(this.pending)
      this.pending = null
    }

    const cp = this.pendingCheckpoint
    if (cp === null) return
    this.pendingCheckpoint = null

    try {
      await this.store.save(cp)
      this.lastSaved = cp
    } catch (err: unknown) {
      this.onError(err instanceof Error ? err : new Error(String(err)))
    }
  }

  /** The most recently saved checkpoint, or null if none saved yet. */
  get lastCheckpoint(): Checkpoint | null {
    return this.lastSaved
  }

  /** Cancel any pending save and clean up. */
  dispose(): void {
    if (this.pending !== null) {
      clearTimeout(this.pending)
      this.pending = null
    }
    this.pendingCheckpoint = null
  }
}
