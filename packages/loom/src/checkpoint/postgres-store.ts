/**
 * PostgreSQL Checkpoint Store
 *
 * Stores checkpoints in a PostgreSQL table using parameterized queries.
 * No ORM, no 'pg' import — accepts any pool that satisfies the PgPool interface.
 */

import type { Checkpoint, CheckpointStore } from './types.js'

/** Generic pool interface so we don't depend on 'pg' at the type level. */
export interface PgPool {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>> }>
}

export class PostgresCheckpointStore implements CheckpointStore {
  private readonly pool: PgPool
  private readonly tableName: string

  constructor(pool: PgPool, tableName = 'loom_checkpoints') {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableName)) {
      throw new Error(`Invalid table name: "${tableName}". Must be alphanumeric with underscores.`)
    }
    this.pool = pool
    this.tableName = tableName
  }

  /** Create the checkpoints table if it doesn't already exist. */
  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        session_id   TEXT          NOT NULL,
        turn_index   INT           NOT NULL,
        data         JSONB         NOT NULL,
        created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        PRIMARY KEY (session_id, turn_index)
      )
    `)
  }

  /**
   * Save a checkpoint. Uses INSERT ... ON CONFLICT UPDATE so the latest
   * data for a given (session_id, turn_index) pair always wins.
   * Returns a unique checkpoint ID (UUID).
   */
  async save(checkpoint: Checkpoint): Promise<string> {
    await this.pool.query(
      `INSERT INTO ${this.tableName} (session_id, turn_index, data)
       VALUES ($1, $2, $3)
       ON CONFLICT (session_id, turn_index)
       DO UPDATE SET data = $3, created_at = NOW()`,
      [checkpoint.sessionId, checkpoint.turnIndex, JSON.stringify(checkpoint)],
    )
    return `${checkpoint.sessionId}:${checkpoint.turnIndex}`
  }

  /**
   * Load the most recent checkpoint for a session (highest turn_index).
   * Returns null if no checkpoint exists for the given session.
   */
  async load(sessionId: string): Promise<Checkpoint | null> {
    const { rows } = await this.pool.query(
      `SELECT data FROM ${this.tableName}
       WHERE session_id = $1
       ORDER BY turn_index DESC
       LIMIT 1`,
      [sessionId],
    )
    if (rows.length === 0) return null
    return rows[0]!.data as Checkpoint
  }

  /**
   * List all sessions that have at least one checkpoint,
   * ordered by most-recently-created first.
   */
  async list(): Promise<Array<{ sessionId: string; timestamp: number }>> {
    const { rows } = await this.pool.query(
      `SELECT session_id, MAX(created_at) AS max_ts
       FROM ${this.tableName}
       GROUP BY session_id
       ORDER BY max_ts DESC`,
    )
    return rows.map((r) => ({
      sessionId: r.session_id as string,
      timestamp: new Date(r.max_ts as string).getTime(),
    }))
  }

  /** Delete all checkpoints for a session. */
  async delete(sessionId: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM ${this.tableName} WHERE session_id = $1`,
      [sessionId],
    )
  }
}
