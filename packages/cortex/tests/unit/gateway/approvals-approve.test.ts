/**
 * Pure unit tests for the approve→execute handler (Slice 8d-4). Fake stores +
 * a spy `executeHeldTool` + a mock ServerResponse — no DB, no model — so this
 * runs under plain node (ENV-2 unaffected).
 *
 * The security invariants it locks (Principle 23):
 *   - ONLY a still-`pending` approval executes (idempotent, at-most-once).
 *   - the action (toolName) + args (toolInput) come ONLY from the STORED
 *     approval row — never a request body.
 *   - the outcome is recorded honestly: approved on success, failed on an
 *     error result / missing schedule / thrown error (never swallowed).
 */
import { describe, it, expect, vi } from 'vitest'
import type { ServerResponse } from 'node:http'
import { createApprovalHandlers, type ExecuteHeldTool } from '../../../src/gateway/handlers/approvals.js'
import type { ApprovalDto } from '../../../src/schedules/approvals.js'

function mockRes(): { res: ServerResponse; out: { status?: number; body?: unknown } } {
  const out: { status?: number; body?: unknown } = {}
  const res = {
    writeHead: (status: number): unknown => { out.status = status; return res },
    end: (body?: string): void => { out.body = body != null ? JSON.parse(body) : undefined },
  } as unknown as ServerResponse
  return { res, out }
}

function approval(over: Partial<ApprovalDto> = {}): ApprovalDto {
  return {
    id: 'appr_1', scheduleId: 'sched_1', runId: 'run_1', threadId: 'thread_1',
    toolName: 'writeFile', toolInput: { file_path: 'note.txt', content: 'hi' },
    summary: 'writeFile → note.txt', status: 'pending', result: null,
    errorMessage: null, createdAt: 1, decidedAt: null, ...over,
  }
}

function harness(opts: {
  approval: ApprovalDto | null
  schedule?: { profileId: string; workspaceId: string | null } | null
  execute: ExecuteHeldTool
}) {
  const decided: Array<{ id: string; input: Record<string, unknown> }> = []
  const store = {
    get: (): ApprovalDto | null => opts.approval,
    decide: (id: string, input: Record<string, unknown>): ApprovalDto =>
      (decided.push({ id, input }), { ...(opts.approval as ApprovalDto), ...input, decidedAt: 2 }),
  } as unknown as Parameters<typeof createApprovalHandlers>[0]['store']
  const scheduleStore = {
    // `undefined` (omitted) → a default live schedule; explicit `null` → deleted.
    get: (): unknown => (opts.schedule === undefined ? { profileId: 'adam', workspaceId: 'ws_1' } : opts.schedule),
  } as unknown as Parameters<typeof createApprovalHandlers>[0]['scheduleStore']
  const handlers = createApprovalHandlers({ store, scheduleStore, executeHeldTool: opts.execute })
  return { handlers, decided }
}

describe('approveApproval (8d-4 — approve → execute the held call)', () => {
  it('executes the EXACT stored call (not the request body) and records approved on success', async () => {
    const spy = vi.fn<ExecuteHeldTool>(async () => ({ content: 'wrote note.txt', isError: false }))
    const { handlers, decided } = harness({ approval: approval(), execute: spy })
    const { res, out } = mockRes()
    await handlers.approveApproval({} as never, res, { id: 'appr_1' })
    // Action + args come ONLY from the stored approval row.
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({
      profileId: 'adam',
      toolName: 'writeFile',
      toolInput: { file_path: 'note.txt', content: 'hi' },
    }))
    expect(decided[0]!.input['status']).toBe('approved')
    expect(out.status).toBe(200)
  })

  it('does NOT execute a non-pending approval (idempotent, at-most-once)', async () => {
    const spy = vi.fn<ExecuteHeldTool>(async () => ({ content: 'x', isError: false }))
    const { handlers, decided } = harness({ approval: approval({ status: 'approved' }), execute: spy })
    const { res } = mockRes()
    await handlers.approveApproval({} as never, res, { id: 'appr_1' })
    expect(spy).not.toHaveBeenCalled()
    expect(decided).toHaveLength(0) // never re-decided / re-sent
  })

  it('records failed when the held tool returns an error result', async () => {
    const spy = vi.fn<ExecuteHeldTool>(async () => ({ content: 'token expired', isError: true }))
    const { handlers, decided } = harness({ approval: approval({ toolName: 'slack_send' }), execute: spy })
    const { res } = mockRes()
    await handlers.approveApproval({} as never, res, { id: 'appr_1' })
    expect(decided[0]!.input['status']).toBe('failed')
    expect(String(decided[0]!.input['errorMessage'])).toContain('token expired')
  })

  it('records failed (never throws) when executeHeldTool throws', async () => {
    const spy = vi.fn<ExecuteHeldTool>(async () => { throw new Error('boom') })
    const { handlers, decided } = harness({ approval: approval(), execute: spy })
    const { res } = mockRes()
    await handlers.approveApproval({} as never, res, { id: 'appr_1' })
    expect(decided[0]!.input['status']).toBe('failed')
    expect(String(decided[0]!.input['errorMessage'])).toContain('boom')
  })

  it('records failed (does not execute) when the schedule no longer exists', async () => {
    const spy = vi.fn<ExecuteHeldTool>(async () => ({ content: 'x', isError: false }))
    const { handlers, decided } = harness({ approval: approval(), schedule: null, execute: spy })
    const { res } = mockRes()
    await handlers.approveApproval({} as never, res, { id: 'appr_1' })
    expect(spy).not.toHaveBeenCalled()
    expect(decided[0]!.input['status']).toBe('failed')
  })

  it('404s an unknown approval and never executes', async () => {
    const spy = vi.fn<ExecuteHeldTool>(async () => ({ content: 'x', isError: false }))
    const { handlers } = harness({ approval: null, execute: spy })
    const { res, out } = mockRes()
    await handlers.approveApproval({} as never, res, { id: 'nope' })
    expect(out.status).toBe(404)
    expect(spy).not.toHaveBeenCalled()
  })
})
