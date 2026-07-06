/**
 * ThreadMap implementations — the sessionKey → gateway threadId store.
 *
 * `InMemoryThreadMap` is the default for tests and single-process runs.
 * A persistent implementation (SQLite/file) is added in SH1 so a shuttle
 * restart doesn't start every customer's conversation over; it satisfies
 * the same {@link ThreadMap} interface, so nothing above it changes.
 */

import type { ThreadMap } from './types.js'

/** Process-local map. Lost on restart — fine for tests and ephemeral runs. */
export class InMemoryThreadMap implements ThreadMap {
  private readonly map = new Map<string, string>()

  async get(sessionKey: string): Promise<string | undefined> {
    return this.map.get(sessionKey)
  }

  async set(sessionKey: string, threadId: string): Promise<void> {
    this.map.set(sessionKey, threadId)
  }

  async delete(sessionKey: string): Promise<void> {
    this.map.delete(sessionKey)
  }

  /** Number of bound keys (test/introspection helper). */
  get size(): number {
    return this.map.size
  }
}
