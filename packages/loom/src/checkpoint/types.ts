/**
 * Checkpoint Types
 *
 * Checkpoints are serializable snapshots of session state.
 * Any backend (memory, file, Postgres) can store them.
 */

import type { Message } from '../messages/types.js'

export interface Checkpoint {
  readonly sessionId: string
  readonly messages: Message[]
  readonly turnIndex: number
  readonly usage: {
    readonly inputTokens: number
    readonly outputTokens: number
    readonly cacheReadTokens: number
    readonly cacheCreationTokens: number
    readonly costUsd: number
  }
  readonly timestamp: number
}

export interface CheckpointStore {
  save(checkpoint: Checkpoint): Promise<string>
  load(sessionId: string): Promise<Checkpoint | null>
  list(): Promise<Array<{ sessionId: string; timestamp: number }>>
  delete(sessionId: string): Promise<void>
}
