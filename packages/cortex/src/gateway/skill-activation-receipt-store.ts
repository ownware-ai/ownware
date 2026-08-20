import type { SqliteDatabase } from '../storage/sqlite-driver.js'
import { appendActivityLedgerRow } from './activity-ledger.js'

export interface SkillActivationReceipt {
  readonly receiptId: string
  readonly sequence: number
  readonly runId: string
  readonly profileId: string
  readonly profileDigest: string
  readonly skillName: string
  readonly skillDigest: string
  readonly agentId: string | null
  readonly toolCallId: string | null
  readonly turnIndex: number
  readonly activatedAt: number
}

export interface SkillActivationReceiptPage {
  readonly items: readonly SkillActivationReceipt[]
  readonly nextCursor: string | null
}

export interface ObserveSkillActivationInput {
  readonly activationId: string
  readonly runId: string
  readonly profileId: string
  readonly profileDigest: string
  readonly skillName: string
  readonly skillDigest: string
  readonly agentId: string | null
  readonly toolCallId: string | null
  readonly turnIndex: number
}

export interface SkillActivationReceiptRepository {
  observe(
    input: ObserveSkillActivationInput,
    now?: number,
  ): Promise<SkillActivationReceipt>
  listForRun(
    runId: string,
    page: { readonly limit: number; readonly cursor: string | null },
  ): Promise<SkillActivationReceiptPage>
}

export type SkillActivationReceiptErrorCode =
  | 'invalid_input'
  | 'run_missing'
  | 'identity_conflict'
  | 'cursor_invalid'

export class SkillActivationReceiptError extends Error {
  override readonly name = 'SkillActivationReceiptError'

  constructor(readonly code: SkillActivationReceiptErrorCode) {
    super(`Skill activation receipt operation failed (${code}).`)
  }
}

export interface SkillActivationReceiptStorageRow {
  readonly receipt_id: string
  readonly receipt_seq: number
  readonly run_id: string
  readonly profile_id: string
  readonly profile_digest: string
  readonly skill_name: string
  readonly skill_digest: string
  readonly agent_id: string | null
  readonly tool_call_id: string | null
  readonly turn_index: number
  readonly activated_at: number
}

export function validateSkillActivation(
  input: ObserveSkillActivationInput,
): void {
  if (
    !isSkillActivationUuid(input.activationId)
    || !isSkillActivationUuid(input.runId)
    || !boundedText(input.profileId, 240)
    || !isKeyedDigest(input.profileDigest)
    || !boundedText(input.skillName, 240)
    || !isKeyedDigest(input.skillDigest)
    || (input.agentId !== null && !boundedText(input.agentId, 240))
    || (input.toolCallId !== null && !boundedText(input.toolCallId, 240))
    || !Number.isSafeInteger(input.turnIndex)
    || input.turnIndex < 0
  ) {
    throw new SkillActivationReceiptError('invalid_input')
  }
}

export function projectSkillActivationReceipt(
  row: SkillActivationReceiptStorageRow,
): SkillActivationReceipt {
  return {
    receiptId: row.receipt_id,
    sequence: row.receipt_seq,
    runId: row.run_id,
    profileId: row.profile_id,
    profileDigest: row.profile_digest,
    skillName: row.skill_name,
    skillDigest: row.skill_digest,
    agentId: row.agent_id,
    toolCallId: row.tool_call_id,
    turnIndex: row.turn_index,
    activatedAt: row.activated_at,
  }
}

export function sameSkillActivation(
  row: SkillActivationReceiptStorageRow,
  input: ObserveSkillActivationInput,
): boolean {
  return row.receipt_id === input.activationId
    && row.run_id === input.runId
    && row.profile_id === input.profileId
    && row.profile_digest === input.profileDigest
    && row.skill_name === input.skillName
    && row.skill_digest === input.skillDigest
    && row.agent_id === input.agentId
    && row.tool_call_id === input.toolCallId
    && row.turn_index === input.turnIndex
}

export function isSkillActivationUuid(value: string): boolean {
  if (value.length !== 36) return false
  for (let index = 0; index < value.length; index += 1) {
    if (index === 8 || index === 13 || index === 18 || index === 23) {
      if (value[index] !== '-') return false
      continue
    }
    if (!isLowerHex(value.charCodeAt(index))) return false
  }
  const version = value.charCodeAt(14)
  const variant = value.charCodeAt(19)
  return version >= 0x31 && version <= 0x35
    && (variant === 0x38 || variant === 0x39 || variant === 0x61 || variant === 0x62)
}

export class SkillActivationReceiptStore {
  constructor(private readonly db: SqliteDatabase) {}

  observe(
    input: ObserveSkillActivationInput,
    now = Date.now(),
  ): SkillActivationReceipt {
    validateSkillActivation(input)
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new SkillActivationReceiptError('invalid_input')
    }
    return this.db.transaction(() => {
      const run = this.db.prepare('SELECT 1 FROM gateway_runs WHERE id = ?')
        .get(input.runId)
      if (run === undefined) throw new SkillActivationReceiptError('run_missing')

      const existing = this.db.prepare(`
        SELECT * FROM skill_activation_receipts WHERE receipt_id = ?
      `).get(input.activationId) as SkillActivationReceiptStorageRow | undefined
      if (existing !== undefined) {
        if (!sameSkillActivation(existing, input)) {
          throw new SkillActivationReceiptError('identity_conflict')
        }
        return projectSkillActivationReceipt(existing)
      }

      const sequence = this.db.prepare(`
        SELECT COALESCE(MAX(receipt_seq), 0) + 1 AS value
        FROM skill_activation_receipts WHERE run_id = ?
      `).pluck().get(input.runId) as number
      this.db.prepare(`
        INSERT INTO skill_activation_receipts (
          receipt_id, receipt_seq, run_id, profile_id, profile_digest,
          skill_name, skill_digest, agent_id, tool_call_id, turn_index,
          activated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
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
      )
      // Indexed in this same transaction; a converged duplicate returned above
      // never reaches here, so one receipt yields exactly one ledger row.
      // No `outcome`: a placement receipt records that the exact skill body
      // crossed into the conversation, which has no success/failure axis.
      appendActivityLedgerRow(this.db, {
        family: 'skill_activation',
        receiptId: input.activationId,
        runId: input.runId,
        occurredAt: now,
      })
      return {
        receiptId: input.activationId,
        sequence,
        runId: input.runId,
        profileId: input.profileId,
        profileDigest: input.profileDigest,
        skillName: input.skillName,
        skillDigest: input.skillDigest,
        agentId: input.agentId,
        toolCallId: input.toolCallId,
        turnIndex: input.turnIndex,
        activatedAt: now,
      }
    })()
  }

  listForRun(
    runId: string,
    page: { readonly limit: number; readonly cursor: string | null },
  ): SkillActivationReceiptPage {
    if (
      !isSkillActivationUuid(runId)
      || !Number.isSafeInteger(page.limit)
      || page.limit < 1
      || page.limit > 100
      || (page.cursor !== null && !isSkillActivationUuid(page.cursor))
    ) throw new SkillActivationReceiptError('cursor_invalid')

    let cursorSequence: number | null = null
    if (page.cursor !== null) {
      const cursor = this.db.prepare(`
        SELECT receipt_seq FROM skill_activation_receipts
        WHERE run_id = ? AND receipt_id = ?
      `).get(runId, page.cursor) as { readonly receipt_seq: number } | undefined
      if (cursor === undefined) throw new SkillActivationReceiptError('cursor_invalid')
      cursorSequence = cursor.receipt_seq
    }
    const rows = this.db.prepare(`
      SELECT * FROM skill_activation_receipts
      WHERE run_id = ? AND (? IS NULL OR receipt_seq > ?)
      ORDER BY receipt_seq LIMIT ?
    `).all(
      runId,
      cursorSequence,
      cursorSequence,
      page.limit + 1,
    ) as SkillActivationReceiptStorageRow[]
    const more = rows.length > page.limit
    if (more) rows.pop()
    return {
      items: rows.map(projectSkillActivationReceipt),
      nextCursor: more ? rows.at(-1)!.receipt_id : null,
    }
  }
}

function boundedText(value: string, max: number): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) return false
  return ![...value].some(char => {
    const code = char.codePointAt(0) ?? 0
    return code < 0x20 || code === 0x7f
  })
}

function isKeyedDigest(value: string): boolean {
  const prefix = 'hmac-sha256:'
  if (!value.startsWith(prefix) || value.length !== prefix.length + 64) return false
  for (let index = prefix.length; index < value.length; index += 1) {
    if (!isLowerHex(value.charCodeAt(index))) return false
  }
  return true
}

function isLowerHex(code: number): boolean {
  return (code >= 0x30 && code <= 0x39) || (code >= 0x61 && code <= 0x66)
}
