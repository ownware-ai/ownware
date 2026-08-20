import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GatewayRunStore } from '../../../src/gateway/run-store.js'
import { GatewayState } from '../../../src/gateway/state.js'

/**
 * AL3's write path sits on EE2's enforcement boundary, so these cases are about
 * what must NOT happen: an approval attributed to the wrong call, a decision
 * that leaves no durable record, or a link invented where none was observed.
 */

/** Policy revisions are 64 hex characters at the schema boundary. */
const POLICY_REVISION = 'a'.repeat(64)

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ownware-permission-evidence-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

interface DecisionReceipt {
  readonly receipt_id: string
  readonly receipt_seq: number
  readonly request_id: string
  readonly decision: string
  readonly tool_name: string
}

async function fixture() {
  const state = new GatewayState(join(dir, 'permissions.db'))
  const thread = await state.createThread('permission-test')
  const runs = new GatewayRunStore(state.rawDbHandle, 'permission-secret')
  const run = runs.create({
    threadId: thread.id,
    profileId: 'permission-test',
    model: 'test:model',
    timeoutMs: 60_000,
    startSeq: 0,
  }, 100)
  runs.markRunning(run.runId, 101)
  const db = state.rawDbHandle
  return {
    runs,
    runId: run.runId,
    db,
    receipts: () => db.prepare(
      'SELECT * FROM run_permission_decision_receipts ORDER BY receipt_seq',
    ).all() as DecisionReceipt[],
    ledger: () => db.prepare(
      "SELECT * FROM activity_ledger WHERE family = 'permission_decision' ORDER BY ledger_seq",
    ).all() as Array<{ receipt_id: string; outcome: string; tool_name: string }>,
    consumptions: () => db.prepare(
      'SELECT request_id, tool_call_id FROM run_permission_consumptions',
    ).all() as Array<{ request_id: string; tool_call_id: string | null }>,
  }
}

function request(
  f: Awaited<ReturnType<typeof fixture>>,
  requestId: string,
  toolName: string,
  input: Record<string, unknown>,
) {
  return f.runs.recordPermissionRequest({
    runId: f.runId,
    requestId,
    toolName,
    toolInput: input,
    policyRevision: POLICY_REVISION,
    agentId: null,
  })
}

describe('permission decision evidence', () => {
  it('records an immutable receipt and a ledger row for a decision', async () => {
    const f = await fixture()
    const pending = request(f, 'req-1', 'send_email', { to: 'a@example.com' })
    expect(f.runs.decidePermission(f.runId, 'req-1', pending.operationHash, 'approve'))
      .toBe('decided')

    const receipts = f.receipts()
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({
      request_id: 'req-1', decision: 'approved', tool_name: 'send_email', receipt_seq: 1,
    })
    expect(f.ledger()).toEqual([expect.objectContaining({
      receipt_id: receipts[0]!.receipt_id,
      outcome: 'approved',
      tool_name: 'send_email',
    })])
  })

  it('keeps the decision answerable after expiry overwrites the status', async () => {
    // This is why the receipt exists: run_permission_requests.status is mutable
    // and expiry rewrites it, so without a receipt "what did you decide" has no
    // durable answer.
    const f = await fixture()
    const pending = request(f, 'req-1', 'send_email', {})
    f.runs.decidePermission(f.runId, 'req-1', pending.operationHash, 'approve')
    f.runs.expirePermission(f.runId, 'req-1', pending.operationHash)

    expect(f.runs.getPermissionRequest(f.runId, 'req-1')?.status).toBe('expired')
    expect(f.receipts()[0]).toMatchObject({ decision: 'approved' })
  })

  it('refuses to rewrite a recorded decision', async () => {
    const f = await fixture()
    const pending = request(f, 'req-1', 'send_email', {})
    f.runs.decidePermission(f.runId, 'req-1', pending.operationHash, 'approve')
    expect(() => f.db.prepare(
      "UPDATE run_permission_decision_receipts SET decision = 'denied'",
    ).run()).toThrow(/immutable/)
    expect(() => f.db.prepare(
      'DELETE FROM run_permission_decision_receipts',
    ).run()).toThrow(/immutable/)
  })

  it('writes exactly one receipt when a decision is replayed', async () => {
    const f = await fixture()
    const pending = request(f, 'req-1', 'send_email', {})
    expect(f.runs.decidePermission(f.runId, 'req-1', pending.operationHash, 'approve'))
      .toBe('decided')
    expect(f.runs.decidePermission(f.runId, 'req-1', pending.operationHash, 'deny'))
      .toBe('already_decided')
    expect(f.receipts()).toHaveLength(1)
    expect(f.receipts()[0]!.decision).toBe('approved')
    expect(f.ledger()).toHaveLength(1)
  })

  it('records no decision evidence when the intent hash does not match', async () => {
    const f = await fixture()
    request(f, 'req-1', 'send_email', {})
    expect(f.runs.decidePermission(f.runId, 'req-1', 'f'.repeat(64), 'approve'))
      .toBe('hash_mismatch')
    expect(f.receipts()).toHaveLength(0)
    expect(f.ledger()).toHaveLength(0)
  })

  it('attributes two calls to the same tool to their own approvals', async () => {
    // The reason (run_id, tool_name) was rejected as a join key: these two are
    // indistinguishable by name, and one was approved while the other was not.
    const f = await fixture()
    const first = request(f, 'req-1', 'send_email', { to: 'a@example.com' })
    const second = request(f, 'req-2', 'send_email', { to: 'b@example.com' })
    f.runs.decidePermission(f.runId, 'req-1', first.operationHash, 'approve')
    f.runs.decidePermission(f.runId, 'req-2', second.operationHash, 'deny')

    expect(f.runs.consumePermissionApproval({
      runId: f.runId,
      requestId: 'req-1',
      toolName: 'send_email',
      toolInput: { to: 'a@example.com' },
      policyRevision: POLICY_REVISION,
      agentId: null,
      toolCallId: 'call-approved',
    })).toBe('consumed')

    // The denied one cannot be spent, whatever call it is offered against.
    expect(f.runs.consumePermissionApproval({
      runId: f.runId,
      requestId: 'req-2',
      toolName: 'send_email',
      toolInput: { to: 'b@example.com' },
      policyRevision: POLICY_REVISION,
      agentId: null,
      toolCallId: 'call-denied',
    })).toBe('not_approved')

    expect(f.consumptions()).toEqual([
      { request_id: 'req-1', tool_call_id: 'call-approved' },
    ])
    const decisions = Object.fromEntries(f.receipts().map((r) => [r.request_id, r.decision]))
    expect(decisions).toEqual({ 'req-1': 'approved', 'req-2': 'denied' })
  })

  it('leaves the link unknown rather than inventing one when no call is supplied', async () => {
    // The hook-approval path has no tool call to name. Absent must read as
    // unknown, never as "no effect".
    const f = await fixture()
    const pending = request(f, 'req-1', 'send_email', {})
    f.runs.decidePermission(f.runId, 'req-1', pending.operationHash, 'approve')
    expect(f.runs.consumePermissionApproval({
      runId: f.runId,
      requestId: 'req-1',
      toolName: 'send_email',
      toolInput: {},
      policyRevision: POLICY_REVISION,
      agentId: null,
    })).toBe('consumed')
    expect(f.consumptions()).toEqual([{ request_id: 'req-1', tool_call_id: null }])
  })

  it('stores no malformed call identity', async () => {
    const f = await fixture()
    const pending = request(f, 'req-1', 'send_email', {})
    f.runs.decidePermission(f.runId, 'req-1', pending.operationHash, 'approve')
    expect(f.runs.consumePermissionApproval({
      runId: f.runId,
      requestId: 'req-1',
      toolName: 'send_email',
      toolInput: {},
      policyRevision: POLICY_REVISION,
      agentId: null,
      toolCallId: 'call id with spaces',
    })).toBe('consumed')
    // Rejected at the boundary and stored as unknown, not persisted raw.
    expect(f.consumptions()).toEqual([{ request_id: 'req-1', tool_call_id: null }])
  })

  it('rolls the receipt back with a failed decision transaction', async () => {
    const f = await fixture()
    const pending = request(f, 'req-1', 'send_email', {})
    f.db.exec('ALTER TABLE activity_ledger RENAME TO activity_ledger_moved')
    expect(() => f.runs.decidePermission(f.runId, 'req-1', pending.operationHash, 'approve'))
      .toThrow()
    f.db.exec('ALTER TABLE activity_ledger_moved RENAME TO activity_ledger')
    // Neither the status change nor the receipt survived.
    expect(f.runs.getPermissionRequest(f.runId, 'req-1')?.status).toBe('pending')
    expect(f.receipts()).toHaveLength(0)
  })
})
