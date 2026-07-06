/**
 * Debouncer (SH-deb) — coalesce rapid messages per conversation.
 *
 * People send "hi" / "quick q" / "..." as three messages in a row. Without
 * debouncing the agent answers three times. This buffers items per key for a
 * quiet period; a new item resets the timer; a `maxWaitMs` cap keeps a chatty
 * user from being delayed forever. `bump()` extends the window on a typing
 * signal. Learned from omni's message-debouncer.
 */

export interface DebouncerOptions {
  /** Quiet period (ms) with no new item before the batch flushes. */
  readonly debounceMs: number
  /** Hard cap (ms) on total buffering, so a chatty user still gets answered. */
  readonly maxWaitMs?: number
  /** Injectable clock (tests without fake timers). Default Date.now. */
  readonly now?: () => number
}

export class Debouncer<T> {
  private readonly buffers = new Map<string, { items: T[]; timer: ReturnType<typeof setTimeout>; firstAt: number }>()
  private readonly debounceMs: number
  private readonly maxWaitMs: number | undefined
  private readonly now: () => number

  constructor(
    opts: DebouncerOptions,
    private readonly onFlush: (key: string, items: T[]) => void | Promise<void>,
  ) {
    this.debounceMs = opts.debounceMs
    this.maxWaitMs = opts.maxWaitMs
    this.now = opts.now ?? Date.now
  }

  /** Add an item to `key`'s buffer, (re)starting the quiet timer. */
  push(key: string, item: T): void {
    const existing = this.buffers.get(key)
    if (existing) {
      existing.items.push(item)
      clearTimeout(existing.timer)
      if (this.maxWaitMs !== undefined && this.now() - existing.firstAt >= this.maxWaitMs) {
        this.flush(key)
        return
      }
      existing.timer = setTimeout(() => this.flush(key), this.debounceMs)
    } else {
      const timer = setTimeout(() => this.flush(key), this.debounceMs)
      this.buffers.set(key, { items: [item], timer, firstAt: this.now() })
    }
  }

  /** Extend the quiet window (e.g. the platform signalled the user is typing). */
  bump(key: string): void {
    const b = this.buffers.get(key)
    if (!b) return
    clearTimeout(b.timer)
    b.timer = setTimeout(() => this.flush(key), this.debounceMs)
  }

  /** Flush `key`'s buffer now, delivering the batch to `onFlush`. */
  flush(key: string): void {
    const b = this.buffers.get(key)
    if (!b) return
    clearTimeout(b.timer)
    this.buffers.delete(key)
    void this.onFlush(key, b.items)
  }

  /** Number of items currently buffered for a key. */
  pendingCount(key: string): number {
    return this.buffers.get(key)?.items.length ?? 0
  }
}
