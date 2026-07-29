import type Database from 'better-sqlite3'
import {
  parseCodexThreadReference,
  type CodexThreadReference,
} from './official-thread.js'

interface CodexThreadReferenceRow {
  readonly local_thread_id: string
  readonly remote_thread_id: string
  readonly revision: number
  readonly account_binding: string
  readonly model: string
  readonly model_provider: string
  readonly profile_report_id: string
  readonly sandbox_report_id: string
  readonly bound_at: string
  readonly active_turn_id: string | null
  readonly active_started_at: string | null
  readonly active_consequence: string | null
  readonly last_turn_id: string | null
  readonly last_turn_status: string | null
  readonly last_turn_completed_at: string | null
  readonly last_turn_authority: string | null
  readonly recovery_state: string
}

export type CodexThreadReferenceStoreErrorCode =
  | 'invalid_reference'
  | 'stale_write'
  | 'write_failed'
  | 'read_failed'

export class CodexThreadReferenceStoreError extends Error {
  public override readonly name = 'CodexThreadReferenceStoreError'

  constructor(readonly code: CodexThreadReferenceStoreErrorCode) {
    super(`Codex thread reference store failed (${code}).`)
  }
}

const SELECT_COLUMNS = `
  local_thread_id,
  remote_thread_id,
  revision,
  account_binding,
  model,
  model_provider,
  profile_report_id,
  sandbox_report_id,
  bound_at,
  active_turn_id,
  active_started_at,
  active_consequence,
  last_turn_id,
  last_turn_status,
  last_turn_completed_at,
  last_turn_authority,
  recovery_state
`

function hydrate(row: CodexThreadReferenceRow): CodexThreadReference {
  return parseCodexThreadReference({
    schemaVersion: 1,
    revision: row.revision,
    selection: {
      runtime: 'openai-codex',
      access: { route: 'openai-chatgpt-managed' },
    },
    localThreadId: row.local_thread_id,
    remoteThreadId: row.remote_thread_id,
    accountBinding: row.account_binding,
    model: row.model,
    modelProvider: row.model_provider,
    profileReportId: row.profile_report_id,
    sandboxReportId: row.sandbox_report_id,
    boundAt: row.bound_at,
    activeTurn: row.active_turn_id == null
      ? null
      : {
          id: row.active_turn_id,
          startedAt: row.active_started_at,
          consequence: row.active_consequence,
        },
    lastTerminalTurn: row.last_turn_id == null
      ? null
      : {
          id: row.last_turn_id,
          status: row.last_turn_status,
          completedAt: row.last_turn_completed_at,
          authority: row.last_turn_authority,
        },
    recoveryState: row.recovery_state,
  })
}

function sameReference(
  left: CodexThreadReference | undefined,
  right: CodexThreadReference,
): boolean {
  return left !== undefined && JSON.stringify(left) === JSON.stringify(right)
}

function writeValues(reference: CodexThreadReference): readonly unknown[] {
  return [
    reference.remoteThreadId,
    reference.revision,
    reference.accountBinding,
    reference.model,
    reference.modelProvider,
    reference.profileReportId,
    reference.sandboxReportId,
    reference.boundAt,
    reference.activeTurn?.id ?? null,
    reference.activeTurn?.startedAt ?? null,
    reference.activeTurn?.consequence ?? null,
    reference.lastTerminalTurn?.id ?? null,
    reference.lastTerminalTurn?.status ?? null,
    reference.lastTerminalTurn?.completedAt ?? null,
    reference.lastTerminalTurn?.authority ?? null,
    reference.recoveryState,
    Date.now(),
  ]
}

/**
 * Persists only the allowlisted continuity binding. Revision is a strict
 * compare-and-swap fence: an older process can neither erase a live turn nor
 * turn an indeterminate outcome back into a resumable thread.
 */
export class CodexThreadReferenceStore {
  constructor(private readonly db: Database.Database) {}

  load(localThreadId: string): CodexThreadReference | undefined {
    try {
      const row = this.db.prepare(
        `SELECT ${SELECT_COLUMNS}
         FROM codex_thread_references
         WHERE local_thread_id = ?`,
      ).get(localThreadId) as CodexThreadReferenceRow | undefined
      return row === undefined ? undefined : hydrate(row)
    } catch {
      throw new CodexThreadReferenceStoreError('read_failed')
    }
  }

  save(input: unknown): CodexThreadReference {
    let reference: CodexThreadReference
    try {
      reference = parseCodexThreadReference(input)
    } catch {
      throw new CodexThreadReferenceStoreError('invalid_reference')
    }

    if (reference.revision === 0) {
      try {
        this.db.prepare(`
          INSERT INTO codex_thread_references (
            local_thread_id, remote_thread_id, revision, account_binding,
            model, model_provider, profile_report_id, sandbox_report_id,
            bound_at, active_turn_id, active_started_at, active_consequence,
            last_turn_id, last_turn_status, last_turn_completed_at,
            last_turn_authority, recovery_state, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(reference.localThreadId, ...writeValues(reference))
        return reference
      } catch {
        let existing: CodexThreadReference | undefined
        try {
          existing = this.load(reference.localThreadId)
        } catch {
          throw new CodexThreadReferenceStoreError('write_failed')
        }
        if (sameReference(existing, reference)) return reference
        if (existing !== undefined) {
          throw new CodexThreadReferenceStoreError('stale_write')
        }
        throw new CodexThreadReferenceStoreError('write_failed')
      }
    }

    try {
      const result = this.db.prepare(`
        UPDATE codex_thread_references
        SET remote_thread_id = ?,
            revision = ?,
            account_binding = ?,
            model = ?,
            model_provider = ?,
            profile_report_id = ?,
            sandbox_report_id = ?,
            bound_at = ?,
            active_turn_id = ?,
            active_started_at = ?,
            active_consequence = ?,
            last_turn_id = ?,
            last_turn_status = ?,
            last_turn_completed_at = ?,
            last_turn_authority = ?,
            recovery_state = ?,
            updated_at = ?
        WHERE local_thread_id = ?
          AND revision = ?
      `).run(
        ...writeValues(reference),
        reference.localThreadId,
        reference.revision - 1,
      )
      if (result.changes === 1) return reference
    } catch {
      throw new CodexThreadReferenceStoreError('write_failed')
    }

    let existing: CodexThreadReference | undefined
    try {
      existing = this.load(reference.localThreadId)
    } catch {
      throw new CodexThreadReferenceStoreError('write_failed')
    }
    if (sameReference(existing, reference)) return reference
    throw new CodexThreadReferenceStoreError('stale_write')
  }
}
