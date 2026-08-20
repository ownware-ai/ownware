import { describe, expect, it } from 'vitest'
import { OwnwareClient } from '../index.js'

const RUN_ID = '88888888-8888-4888-8888-888888888888'
const RECEIPT_A = '11111111-1111-4111-8111-111111111111'
const RECEIPT_B = '22222222-2222-4222-8222-222222222222'
const EFFECT_A = '33333333-3333-4333-8333-333333333333'
const EFFECT_B = '44444444-4444-4444-8444-444444444444'

function clientReturning(body: unknown, status = 200): OwnwareClient {
  const injectedFetch = (async () => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })) as typeof fetch
  return new OwnwareClient({ baseUrl: 'https://ownware.invalid', fetch: injectedFetch })
}

const entry = (ledgerSeq: number, receiptId: string) => ({
  ledgerSeq,
  family: 'effect',
  receiptId,
  runId: RUN_ID,
  threadId: 'thread_1',
  profileId: 'assistant',
  workspaceId: null,
  occurredAt: 1000 + ledgerSeq,
  origin: 'live',
  outcome: 'succeeded',
  consequence: 'effect_possible',
  toolName: 'send_email',
})

const coverage = { reconstructedThrough: 0, reconstructedCount: 0, observedFrom: 1 }

describe('listActivityReceipts validation', () => {
  it('accepts a well-formed newest-first page', async () => {
    const page = await clientReturning({
      items: [entry(2, RECEIPT_B), entry(1, RECEIPT_A)],
      nextCursor: null,
      coverage,
    }).listActivityReceipts()
    expect(page.items.map((item) => item.ledgerSeq)).toEqual([2, 1])
    expect(page.coverage.observedFrom).toBe(1)
  })

  it('rejects an out-of-order or duplicated page instead of rendering it', async () => {
    // Ascending order or a repeated row means the server (or a middlebox)
    // broke the pagination contract; trusting it would drop or double rows.
    await expect(clientReturning({
      items: [entry(1, RECEIPT_A), entry(2, RECEIPT_B)],
      nextCursor: null,
      coverage,
    }).listActivityReceipts()).rejects.toMatchObject({ code: 'activity_ledger_page_invalid' })
    await expect(clientReturning({
      items: [entry(2, RECEIPT_A), entry(2, RECEIPT_B)],
      nextCursor: null,
      coverage,
    }).listActivityReceipts()).rejects.toMatchObject({ code: 'activity_ledger_page_invalid' })
  })

  it('rejects a page whose coverage is missing or malformed', async () => {
    await expect(clientReturning({
      items: [entry(1, RECEIPT_A)],
      nextCursor: null,
    }).listActivityReceipts()).rejects.toMatchObject({ code: 'activity_ledger_page_invalid' })
    await expect(clientReturning({
      items: [],
      nextCursor: null,
      coverage: { reconstructedThrough: -1, reconstructedCount: 0, observedFrom: null },
    }).listActivityReceipts()).rejects.toMatchObject({ code: 'activity_ledger_page_invalid' })
  })

  it('rejects an unknown family or malformed cursor', async () => {
    await expect(clientReturning({
      items: [{ ...entry(1, RECEIPT_A), family: 'wire_transfer' }],
      nextCursor: null,
      coverage,
    }).listActivityReceipts()).rejects.toMatchObject({ code: 'activity_ledger_page_invalid' })
    await expect(clientReturning({
      items: [entry(1, RECEIPT_A)],
      nextCursor: '0',
      coverage,
    }).listActivityReceipts()).rejects.toMatchObject({ code: 'activity_ledger_page_invalid' })
  })
})

const action = (effectId: string, overrides: Record<string, unknown> = {}) => ({
  effectId,
  toolCallId: `call-${effectId.slice(0, 4)}`,
  toolName: 'send_email',
  outcome: 'succeeded',
  consequence: 'effect_possible',
  disposition: 'completed',
  firstObservedAt: 100,
  lastObservedAt: 200,
  receiptCount: 2,
  ...overrides,
})

const receipt = (actions: readonly unknown[], totals: Record<string, number>) => ({
  runId: RUN_ID,
  status: 'succeeded',
  terminal: true,
  stopRequested: false,
  stopRequestedAt: null,
  consequence: 'effect_possible',
  actions,
  totals,
})

const goodTotals = {
  observedActions: 2,
  completed: 1,
  indeterminate: 1,
  succeeded: 1,
  failed: 0,
  denied: 0,
  effectPossibleOrStronger: 2,
  effectConfirmed: 0,
}

describe('getJobReceipt validation', () => {
  it('accepts a receipt whose totals match its actions', async () => {
    const value = await clientReturning(receipt([
      action(EFFECT_A),
      action(EFFECT_B, { outcome: 'unknown', disposition: 'indeterminate' }),
    ], goodTotals)).getJobReceipt(RUN_ID)
    expect(value.totals.indeterminate).toBe(1)
  })

  it('rejects totals that disagree with the actions they summarize', async () => {
    // A summary that flatters its own items is exactly the kind of drift this
    // boundary exists to catch — whichever half is wrong.
    await expect(clientReturning(receipt([
      action(EFFECT_A),
      action(EFFECT_B, { outcome: 'unknown', disposition: 'indeterminate' }),
    ], { ...goodTotals, indeterminate: 0, completed: 2 })).getJobReceipt(RUN_ID))
      .rejects.toMatchObject({ code: 'job_receipt_invalid' })
  })

  it('rejects a receipt for a different run', async () => {
    await expect(clientReturning(receipt([], {
      ...goodTotals, observedActions: 0, completed: 0, indeterminate: 0,
      succeeded: 0, effectPossibleOrStronger: 0,
    })).getJobReceipt('99999999-9999-4999-8999-999999999999'))
      .rejects.toMatchObject({ code: 'job_receipt_invalid' })
  })

  it('rejects a duplicated action identity', async () => {
    await expect(clientReturning(receipt([
      action(EFFECT_A), action(EFFECT_A),
    ], { ...goodTotals, completed: 2, indeterminate: 0 })).getJobReceipt(RUN_ID))
      .rejects.toMatchObject({ code: 'job_receipt_invalid' })
  })
})

const thread = (id: string) => ({
  id,
  profileId: 'assistant',
  workspaceId: null,
  title: null,
  status: 'active',
  messageCount: 0,
  totalTokens: 0,
  totalCost: 0,
  model: null,
  createdAt: '2026-08-20T00:00:00.000Z',
  updatedAt: '2026-08-20T00:00:00.000Z',
  lastMessagePreview: null,
})

describe('listThreads validation', () => {
  it('accepts a well-formed page', async () => {
    const page = await clientReturning({
      items: [thread('thread_a'), thread('thread_b')], total: 2, limit: 50, offset: 0,
    }).listThreads()
    expect(page.items.map((item) => item.id)).toEqual(['thread_a', 'thread_b'])
  })

  it('rejects duplicates, overflow pages and malformed envelopes', async () => {
    await expect(clientReturning({
      items: [thread('thread_a'), thread('thread_a')], total: 2, limit: 50, offset: 0,
    }).listThreads()).rejects.toMatchObject({ code: 'thread_page_invalid' })
    await expect(clientReturning({
      items: [thread('thread_a'), thread('thread_b')], total: 2, limit: 1, offset: 0,
    }).listThreads()).rejects.toMatchObject({ code: 'thread_page_invalid' })
    await expect(clientReturning({
      items: [thread('thread_a')], total: -1, limit: 50, offset: 0,
    }).listThreads()).rejects.toMatchObject({ code: 'thread_page_invalid' })
  })
})
