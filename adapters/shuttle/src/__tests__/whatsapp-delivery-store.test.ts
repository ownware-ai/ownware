import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FileWhatsAppDeliveryStore,
  InMemoryWhatsAppDeliveryStore,
  deterministicRunKey,
  type WhatsAppDeliveryStore,
} from '../whatsapp/delivery-store.js'

function enqueue(store: WhatsAppDeliveryStore, inboundId = 'wamid.IN', text = 'hello') {
  return store.enqueue({
    channelId: 'whatsapp-acme',
    phoneNumberId: 'PID',
    inboundId,
    from: '15550001111',
    text,
  }, 100)
}

describe('WhatsApp delivery store — provider effect truth', () => {
  it('deduplicates WAMIDs and derives one stable Gateway run key', () => {
    const store = new InMemoryWhatsAppDeliveryStore()
    const first = enqueue(store)
    const replay = enqueue(store)

    expect(first.added).toBe(true)
    expect(replay.added).toBe(false)
    expect(replay.record.key).toBe(first.record.key)
    expect(first.record.runIdempotencyKey).toBe(deterministicRunKey('whatsapp-acme', 'wamid.IN'))
    expect(first.record.runIdempotencyKey).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('requeues interrupted work with no provider effect under the same run key', () => {
    const store = new InMemoryWhatsAppDeliveryStore()
    const { record } = enqueue(store)
    const claimed = store.claim(record.key, 110)
    expect(claimed?.state).toBe('processing')

    expect(store.recover(120)).toEqual({ requeued: 1, unknown: 0, replied: 0 })
    expect(store.getInbound(record.key)).toMatchObject({
      state: 'queued',
      runIdempotencyKey: record.runIdempotencyKey,
      text: 'hello',
    })
  })

  it('freezes the Gateway thread input so an idempotent retry has the same request body', () => {
    const store = new InMemoryWhatsAppDeliveryStore()
    const { record } = enqueue(store)
    store.claim(record.key, 110)
    expect(store.bindRunThread(record.key, null, 111)).toMatchObject({
      runThreadResolved: true,
      runThreadId: null,
    })

    // A thread binding may be persisted after the first Gateway response, but
    // retrying this same WAMID must keep its original null thread input.
    store.setThread('ownware:acme:whatsapp:dm:customer', 'thread-1')
    store.recover(120)
    store.claim(record.key, 121)
    expect(store.bindRunThread(record.key, 'thread-1', 122).runThreadId).toBeNull()
  })

  it('turns a prepared attempt stranded by restart into unknown and never queues it', () => {
    const store = new InMemoryWhatsAppDeliveryStore()
    const { record } = enqueue(store)
    store.claim(record.key, 110)
    store.prepareAttempt(record.key, '15550001111', 'reply', 111)

    expect(store.recover(120)).toEqual({ requeued: 0, unknown: 1, replied: 0 })
    expect(store.queued()).toEqual([])
    expect(store.getInbound(record.key)).toMatchObject({
      state: 'delivery_unknown',
      text: null,
      attempts: [{ state: 'unknown', outcomeCode: 'process_restarted' }],
    })
  })

  it('distinguishes API acceptance from later sent/delivered/read status', () => {
    const store = new InMemoryWhatsAppDeliveryStore()
    const { record } = enqueue(store)
    store.claim(record.key, 110)
    const attempt = store.prepareAttempt(record.key, record.from, 'reply', 111)
    store.markAttemptAccepted(record.key, attempt.attemptId, 'wamid.OUT', 112)
    store.finishReply(record.key, 113)

    expect(store.getInbound(record.key)?.attempts[0]?.state).toBe('accepted')
    store.recordStatus('wamid.OUT', 'sent', '', 114)
    store.recordStatus('wamid.OUT', 'delivered', '', 115)
    store.recordStatus('wamid.OUT', 'read', '', 116)
    expect(store.getInbound(record.key)).toMatchObject({
      state: 'replied',
      text: null,
      attempts: [{ state: 'read', providerMessageId: 'wamid.OUT' }],
    })
  })

  it('reconciles a status that races ahead of the send response', () => {
    const store = new InMemoryWhatsAppDeliveryStore()
    const { record } = enqueue(store)
    store.claim(record.key)
    const attempt = store.prepareAttempt(record.key, record.from, 'reply')
    store.recordStatus('wamid.OUT', 'delivered', '', 120)
    store.markAttemptAccepted(record.key, attempt.attemptId, 'wamid.OUT', 121)
    store.finishReply(record.key, 122)

    expect(store.getInbound(record.key)?.attempts[0]?.state).toBe('delivered')
  })

  it('a failed provider status changes a previously accepted reply to delivery_failed', () => {
    const store = new InMemoryWhatsAppDeliveryStore()
    const { record } = enqueue(store)
    store.claim(record.key)
    const attempt = store.prepareAttempt(record.key, record.from, 'reply')
    store.markAttemptAccepted(record.key, attempt.attemptId, 'wamid.OUT')
    store.finishReply(record.key)
    store.recordStatus('wamid.OUT', 'failed', 'meta_131047', 130)

    expect(store.getInbound(record.key)).toMatchObject({
      state: 'delivery_failed',
      attempts: [{ state: 'failed', outcomeCode: 'meta_131047' }],
    })
  })
})

describe('WhatsApp delivery store — explicit human handoff', () => {
  it('requires request → accept → resume and defers messages while human-owned', () => {
    const store = new InMemoryWhatsAppDeliveryStore()
    const { record } = enqueue(store, 'wamid.HUMAN', '/human')
    store.claim(record.key)
    const requested = store.requestHandoff(record.key, 110)

    expect(requested.state).toBe('requested')
    expect(() => store.resumeHandoff(requested.requestId, 111)).toThrow(/cannot be resumed/)
    expect(store.acceptHandoff(requested.requestId, 112).state).toBe('accepted')

    const next = enqueue(store, 'wamid.WAITING', 'are you there?').record
    store.claim(next.key)
    store.deferToHuman(next.key, 113)
    expect(store.getInbound(next.key)).toMatchObject({ state: 'handoff_deferred', text: null })

    expect(store.resumeHandoff(requested.requestId, 114).state).toBe('resumed')
    expect(store.handoffFor('whatsapp-acme', '15550001111')).toBeNull()
  })
})

describe('FileWhatsAppDeliveryStore', () => {
  let dir = ''
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('survives a process-style reopen and encrypts pending customer text', () => {
    dir = mkdtempSync(join(tmpdir(), 'ownware-wa-delivery-'))
    const first = new FileWhatsAppDeliveryStore({ dir, secret: 'master' })
    const accepted = enqueue(first, 'wamid.PERSIST', 'private order details')

    const bytes = readFileSync(join(dir, 'whatsapp-delivery.enc'))
    expect(bytes.includes(Buffer.from('private order details'))).toBe(false)
    expect(bytes.includes(Buffer.from('15550001111'))).toBe(false)

    const reopened = new FileWhatsAppDeliveryStore({ dir, secret: 'master' })
    expect(enqueue(reopened, 'wamid.PERSIST', 'private order details').added).toBe(false)
    expect(reopened.getInbound(accepted.record.key)).toMatchObject({
      state: 'queued',
      text: 'private order details',
    })
  })
})
