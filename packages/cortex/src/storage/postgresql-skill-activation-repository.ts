import {
  SkillActivationReceiptError,
  isSkillActivationUuid,
  projectSkillActivationReceipt,
  sameSkillActivation,
  validateSkillActivation,
  type ObserveSkillActivationInput,
  type SkillActivationReceipt,
  type SkillActivationReceiptRepository,
  type SkillActivationReceiptStorageRow,
} from '../gateway/skill-activation-receipt-store.js'
import type { PostgreSqlRootRepositoryContext } from './postgresql-adapter.js'
import type { PostgreSqlQueryClient } from './postgresql-repository.js'
import {
  repositoryCall,
  safeInteger,
  withPostgreSqlTransaction,
} from './postgresql-repository.js'

interface PostgreSqlSkillActivationReceiptRow extends Omit<
  SkillActivationReceiptStorageRow,
  'receipt_seq' | 'turn_index' | 'activated_at'
> {
  readonly receipt_seq: string
  readonly turn_index: string
  readonly activated_at: string
}

function normalized(
  row: PostgreSqlSkillActivationReceiptRow,
): SkillActivationReceiptStorageRow {
  return {
    ...row,
    receipt_seq: safeInteger(row.receipt_seq),
    turn_index: safeInteger(row.turn_index),
    activated_at: safeInteger(row.activated_at),
  }
}

async function observeInTransaction(
  client: PostgreSqlQueryClient,
  input: ObserveSkillActivationInput,
  now: number,
): Promise<SkillActivationReceipt> {
  const run = await client.query(
    'SELECT 1 FROM ownware.gateway_runs WHERE id = $1 FOR UPDATE',
    [input.runId],
  )
  if (run.rowCount !== 1) throw new SkillActivationReceiptError('run_missing')

  const existingResult = await client.query<PostgreSqlSkillActivationReceiptRow>(`
    SELECT * FROM ownware.skill_activation_receipts WHERE receipt_id = $1
  `, [input.activationId])
  const existing = existingResult.rows[0]
  if (existing !== undefined) {
    const row = normalized(existing)
    if (!sameSkillActivation(row, input)) {
      throw new SkillActivationReceiptError('identity_conflict')
    }
    return projectSkillActivationReceipt(row)
  }

  const sequenceResult = await client.query<{ readonly value: string }>(`
    SELECT (COALESCE(MAX(receipt_seq), 0) + 1)::text AS value
    FROM ownware.skill_activation_receipts WHERE run_id = $1
  `, [input.runId])
  const sequence = safeInteger(sequenceResult.rows[0]?.value ?? '')
  const inserted = await client.query<PostgreSqlSkillActivationReceiptRow>(`
    INSERT INTO ownware.skill_activation_receipts (
      receipt_id, receipt_seq, run_id, profile_id, profile_digest,
      skill_name, skill_digest, agent_id, tool_call_id, turn_index,
      activated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    RETURNING *
  `, [
    input.activationId,
    sequence,
    input.runId,
    input.profileId,
    input.profileDigest,
    input.skillName,
    input.skillDigest,
    input.agentId,
    input.toolCallId,
    input.turnIndex,
    now,
  ])
  const row = inserted.rows[0]
  if (row === undefined) throw new SkillActivationReceiptError('identity_conflict')
  return projectSkillActivationReceipt(normalized(row))
}

export function createPostgreSqlSkillActivationReceiptRepository(
  context: PostgreSqlRootRepositoryContext,
): SkillActivationReceiptRepository {
  return {
    observe(input, now = Date.now()) {
      validateSkillActivation(input)
      if (!Number.isSafeInteger(now) || now < 0) {
        return Promise.reject(new SkillActivationReceiptError('invalid_input'))
      }
      return repositoryCall(
        context,
        'skill_activation_receipts',
        'observe',
        'write_failed',
        async () => withPostgreSqlTransaction(
          context.pool,
          client => observeInTransaction(client, input, now),
        ),
      )
    },
    listForRun(runId, page) {
      if (
        !isSkillActivationUuid(runId)
        || !Number.isSafeInteger(page.limit)
        || page.limit < 1
        || page.limit > 100
        || (page.cursor !== null && !isSkillActivationUuid(page.cursor))
      ) return Promise.reject(new SkillActivationReceiptError('cursor_invalid'))
      return repositoryCall(
        context,
        'skill_activation_receipts',
        'list',
        'read_failed',
        async client => {
          let cursorSequence: number | null = null
          if (page.cursor !== null) {
            const cursor = await client.query<{ readonly receipt_seq: string }>(`
              SELECT receipt_seq FROM ownware.skill_activation_receipts
              WHERE run_id = $1 AND receipt_id = $2
            `, [runId, page.cursor])
            if (cursor.rows[0] === undefined) {
              throw new SkillActivationReceiptError('cursor_invalid')
            }
            cursorSequence = safeInteger(cursor.rows[0].receipt_seq)
          }
          const result = await client.query<PostgreSqlSkillActivationReceiptRow>(`
            SELECT * FROM ownware.skill_activation_receipts
            WHERE run_id = $1
              AND ($2::bigint IS NULL OR receipt_seq > $2)
            ORDER BY receipt_seq LIMIT $3
          `, [runId, cursorSequence, page.limit + 1])
          const rows = result.rows.map(normalized)
          const more = rows.length > page.limit
          if (more) rows.pop()
          return {
            items: rows.map(projectSkillActivationReceipt),
            nextCursor: more ? rows.at(-1)!.receipt_id : null,
          }
        },
      )
    },
  }
}
