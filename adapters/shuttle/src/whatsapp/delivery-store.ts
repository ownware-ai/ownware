/**
 * Durable WhatsApp message ownership and provider-effect truth (ADR-0008).
 *
 * This is intentionally WhatsApp-specific. WAMIDs, Cloud API acceptance and
 * status webhooks are provider semantics, not a generic channel queue.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
} from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import type { ThreadMap } from '../types.js'

export type WhatsAppInboundState =
  | 'queued'
  | 'processing'
  | 'replied'
  | 'run_unknown'
  | 'delivery_failed'
  | 'delivery_unknown'
  | 'handoff_requested'
  | 'handoff_deferred'

export type WhatsAppAttemptState =
  | 'prepared'
  | 'accepted'
  | 'sent'
  | 'delivered'
  | 'read'
  | 'rejected'
  | 'failed'
  | 'unknown'

export type WhatsAppHandoffState = 'requested' | 'accepted' | 'resumed'

export interface WhatsAppDeliveryAttempt {
  readonly attemptId: string
  readonly chunk: number
  readonly target: string
  readonly contentDigest: string
  readonly contentLength: number
  readonly state: WhatsAppAttemptState
  readonly providerMessageId: string | null
  readonly outcomeCode: string | null
  readonly preparedAt: number
  readonly updatedAt: number
}

export interface WhatsAppInboundRecord {
  readonly key: string
  readonly channelId: string
  readonly phoneNumberId: string
  readonly inboundId: string
  readonly from: string
  readonly text: string | null
  readonly runIdempotencyKey: string
  readonly runThreadResolved: boolean
  readonly runThreadId: string | null
  readonly state: WhatsAppInboundState
  readonly attempts: readonly WhatsAppDeliveryAttempt[]
  readonly receivedAt: number
  readonly updatedAt: number
}

export interface WhatsAppHandoff {
  readonly requestId: string
  readonly channelId: string
  readonly customer: string
  readonly state: WhatsAppHandoffState
  readonly requestedAt: number
  readonly acceptedAt: number | null
  readonly resumedAt: number | null
  readonly updatedAt: number
}

export interface EnqueueWhatsAppInbound {
  readonly channelId: string
  readonly phoneNumberId: string
  readonly inboundId: string
  readonly from: string
  readonly text: string
}

export type WhatsAppProviderStatus = 'sent' | 'delivered' | 'read' | 'failed' | 'deleted'

interface StoredProviderStatus {
  readonly providerMessageId: string
  readonly status: WhatsAppProviderStatus
  readonly outcomeCode: string | null
  readonly observedAt: number
}

interface DeliveryState {
  readonly version: 1
  inbounds: WhatsAppInboundRecord[]
  handoffs: WhatsAppHandoff[]
  orphanStatuses: StoredProviderStatus[]
  threadBindings: Array<{ readonly sessionKey: string; readonly threadId: string }>
}

export interface WhatsAppDeliveryStore {
  enqueue(input: EnqueueWhatsAppInbound, now?: number): { added: boolean; record: WhatsAppInboundRecord }
  hasInbound(channelId: string, inboundId: string): boolean
  getInbound(key: string): WhatsAppInboundRecord | null
  listInbounds(channelId?: string, limit?: number): WhatsAppInboundRecord[]
  claim(key: string, now?: number): WhatsAppInboundRecord | null
  bindRunThread(key: string, threadId: string | null, now?: number): WhatsAppInboundRecord
  queued(channelId?: string): WhatsAppInboundRecord[]
  recover(now?: number): { requeued: number; unknown: number; replied: number }
  prepareAttempt(key: string, target: string, text: string, now?: number): WhatsAppDeliveryAttempt
  markAttemptAccepted(key: string, attemptId: string, providerMessageId: string, now?: number): void
  markAttemptRejected(key: string, attemptId: string, outcomeCode: string, now?: number): void
  markAttemptUnknown(key: string, attemptId: string, outcomeCode: string, now?: number): void
  finishReply(key: string, now?: number): void
  finishFailure(key: string, now?: number): void
  recordStatus(providerMessageId: string, status: WhatsAppProviderStatus, outcomeCode?: string, now?: number): void
  requestHandoff(key: string, now?: number): WhatsAppHandoff
  handoffFor(channelId: string, customer: string): WhatsAppHandoff | null
  listHandoffs(channelId?: string): WhatsAppHandoff[]
  acceptHandoff(requestId: string, now?: number): WhatsAppHandoff
  resumeHandoff(requestId: string, now?: number): WhatsAppHandoff
  deferToHuman(key: string, now?: number): void
  pruneTerminal(before: number): number
  getThread(sessionKey: string): string | undefined
  setThread(sessionKey: string, threadId: string): void
  deleteThread(sessionKey: string): void
}

const EMPTY_STATE = (): DeliveryState => ({
  version: 1,
  inbounds: [],
  handoffs: [],
  orphanStatuses: [],
  threadBindings: [],
})

abstract class BaseWhatsAppDeliveryStore implements WhatsAppDeliveryStore {
  protected abstract readState(): DeliveryState
  protected abstract mutate<T>(fn: (state: DeliveryState) => T): T

  enqueue(input: EnqueueWhatsAppInbound, now = Date.now()): { added: boolean; record: WhatsAppInboundRecord } {
    assertNonEmpty(input.channelId, 'channelId')
    assertNonEmpty(input.phoneNumberId, 'phoneNumberId')
    assertNonEmpty(input.inboundId, 'inboundId')
    assertNonEmpty(input.from, 'from')
    assertNonEmpty(input.text, 'text')
    return this.mutate((state) => {
      const key = inboundKey(input.channelId, input.inboundId)
      const existing = state.inbounds.find((item) => item.key === key)
      if (existing) return { added: false, record: clone(existing) }
      const record: WhatsAppInboundRecord = {
        key,
        channelId: input.channelId,
        phoneNumberId: input.phoneNumberId,
        inboundId: input.inboundId,
        from: input.from,
        text: input.text,
        runIdempotencyKey: deterministicRunKey(input.channelId, input.inboundId),
        runThreadResolved: false,
        runThreadId: null,
        state: 'queued',
        attempts: [],
        receivedAt: now,
        updatedAt: now,
      }
      state.inbounds.push(record)
      return { added: true, record: clone(record) }
    })
  }

  hasInbound(channelId: string, inboundId: string): boolean {
    const key = inboundKey(channelId, inboundId)
    return this.readState().inbounds.some((item) => item.key === key)
  }

  getInbound(key: string): WhatsAppInboundRecord | null {
    const record = this.readState().inbounds.find((item) => item.key === key)
    return record ? clone(record) : null
  }

  listInbounds(channelId?: string, limit = 50): WhatsAppInboundRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('limit must be 1..500')
    return this.readState().inbounds
      .filter((item) => channelId === undefined || item.channelId === channelId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit)
      .map(clone)
  }

  claim(key: string, now = Date.now()): WhatsAppInboundRecord | null {
    return this.mutate((state) => {
      const index = state.inbounds.findIndex((item) => item.key === key)
      if (index < 0 || state.inbounds[index]!.state !== 'queued') return null
      state.inbounds[index] = { ...state.inbounds[index]!, state: 'processing', updatedAt: now }
      return clone(state.inbounds[index]!)
    })
  }

  bindRunThread(key: string, threadId: string | null, now = Date.now()): WhatsAppInboundRecord {
    return this.mutate((state) => {
      const record = requiredInbound(state, key)
      if (record.runThreadResolved) return clone(record)
      if (record.state !== 'processing') {
        throw new Error(`WhatsApp inbound ${key} cannot bind a run thread from ${record.state}`)
      }
      const updated = { ...record, runThreadResolved: true, runThreadId: threadId, updatedAt: now }
      replaceInbound(state, updated)
      return clone(updated)
    })
  }

  queued(channelId?: string): WhatsAppInboundRecord[] {
    return this.readState().inbounds
      .filter((item) => item.state === 'queued' && (channelId === undefined || item.channelId === channelId))
      .map(clone)
  }

  recover(now = Date.now()): { requeued: number; unknown: number; replied: number } {
    return this.mutate((state) => {
      let requeued = 0
      let unknown = 0
      let replied = 0
      for (let i = 0; i < state.inbounds.length; i++) {
        const record = state.inbounds[i]!
        if (record.state !== 'processing') continue
        const attempts = record.attempts.map((attempt) =>
          attempt.state === 'prepared'
            ? { ...attempt, state: 'unknown' as const, outcomeCode: 'process_restarted', updatedAt: now }
            : attempt,
        )
        if (attempts.some((attempt) => attempt.state === 'unknown')) {
          state.inbounds[i] = scrub({ ...record, attempts, state: 'delivery_unknown', updatedAt: now })
          unknown++
        } else if (attempts.length > 0 && attempts.every(isAcceptedOrLater)) {
          state.inbounds[i] = scrub({ ...record, attempts, state: 'replied', updatedAt: now })
          replied++
        } else {
          state.inbounds[i] = { ...record, attempts, state: 'queued', updatedAt: now }
          requeued++
        }
      }
      return { requeued, unknown, replied }
    })
  }

  prepareAttempt(key: string, target: string, text: string, now = Date.now()): WhatsAppDeliveryAttempt {
    assertNonEmpty(target, 'target')
    assertNonEmpty(text, 'text')
    return this.mutate((state) => {
      const record = requiredInbound(state, key)
      if (record.state !== 'processing' && record.state !== 'handoff_requested') {
        throw new Error(`WhatsApp inbound ${key} cannot prepare delivery from ${record.state}`)
      }
      const attempt: WhatsAppDeliveryAttempt = {
        attemptId: randomUUID(),
        chunk: record.attempts.length,
        target,
        contentDigest: createHash('sha256').update(text).digest('hex'),
        contentLength: text.length,
        state: 'prepared',
        providerMessageId: null,
        outcomeCode: null,
        preparedAt: now,
        updatedAt: now,
      }
      replaceInbound(state, { ...record, attempts: [...record.attempts, attempt], updatedAt: now })
      return clone(attempt)
    })
  }

  markAttemptAccepted(key: string, attemptId: string, providerMessageId: string, now = Date.now()): void {
    assertNonEmpty(providerMessageId, 'providerMessageId')
    this.mutate((state) => {
      let record = requiredInbound(state, key)
      record = updateAttempt(record, attemptId, (attempt) => ({
        ...attempt,
        state: 'accepted',
        providerMessageId,
        outcomeCode: null,
        updatedAt: now,
      }))
      const orphan = state.orphanStatuses.find((item) => item.providerMessageId === providerMessageId)
      if (orphan) {
        record = updateAttempt(record, attemptId, (attempt) => applyStatus(attempt, orphan, now))
        state.orphanStatuses = state.orphanStatuses.filter((item) => item.providerMessageId !== providerMessageId)
      }
      replaceInbound(state, record)
    })
  }

  markAttemptRejected(key: string, attemptId: string, outcomeCode: string, now = Date.now()): void {
    this.updateAttemptState(key, attemptId, 'rejected', safeCode(outcomeCode), now)
  }

  markAttemptUnknown(key: string, attemptId: string, outcomeCode: string, now = Date.now()): void {
    this.updateAttemptState(key, attemptId, 'unknown', safeCode(outcomeCode), now)
  }

  finishReply(key: string, now = Date.now()): void {
    this.mutate((state) => {
      const record = requiredInbound(state, key)
      if (record.attempts.some((attempt) => attempt.state === 'prepared')) {
        throw new Error('Cannot finish WhatsApp reply with a prepared attempt')
      }
      const nextState: WhatsAppInboundState = record.attempts.some((attempt) => attempt.state === 'unknown')
        ? 'delivery_unknown'
        : record.attempts.some((attempt) => attempt.state === 'rejected' || attempt.state === 'failed')
          ? 'delivery_failed'
          : 'replied'
      replaceInbound(state, scrub({ ...record, state: nextState, updatedAt: now }))
    })
  }

  finishFailure(key: string, now = Date.now()): void {
    this.mutate((state) => {
      let record = requiredInbound(state, key)
      const attempts = record.attempts.map((attempt) =>
        attempt.state === 'prepared'
          ? { ...attempt, state: 'unknown' as const, outcomeCode: 'send_outcome_unknown', updatedAt: now }
          : attempt,
      )
      const nextState: WhatsAppInboundState = attempts.length === 0
        ? 'run_unknown'
        : attempts.some((attempt) => attempt.state === 'unknown')
          ? 'delivery_unknown'
          : 'delivery_failed'
      record = scrub({ ...record, attempts, state: nextState, updatedAt: now })
      replaceInbound(state, record)
    })
  }

  recordStatus(
    providerMessageId: string,
    status: WhatsAppProviderStatus,
    outcomeCode = '',
    now = Date.now(),
  ): void {
    assertNonEmpty(providerMessageId, 'providerMessageId')
    this.mutate((state) => {
      const observed: StoredProviderStatus = {
        providerMessageId,
        status,
        outcomeCode: outcomeCode ? safeCode(outcomeCode) : null,
        observedAt: now,
      }
      for (let i = 0; i < state.inbounds.length; i++) {
        const record = state.inbounds[i]!
        const attempt = record.attempts.find((item) => item.providerMessageId === providerMessageId)
        if (!attempt) continue
        const updated = updateAttempt(record, attempt.attemptId, (item) => applyStatus(item, observed, now))
        state.inbounds[i] = observed.status === 'failed' || observed.status === 'deleted'
          ? scrub({ ...updated, state: 'delivery_failed', updatedAt: now })
          : updated
        return
      }
      state.orphanStatuses = [
        ...state.orphanStatuses.filter((item) => item.providerMessageId !== providerMessageId),
        observed,
      ].slice(-1000)
    })
  }

  requestHandoff(key: string, now = Date.now()): WhatsAppHandoff {
    return this.mutate((state) => {
      const inbound = requiredInbound(state, key)
      const active = state.handoffs.find(
        (item) => item.channelId === inbound.channelId && item.customer === inbound.from && item.state !== 'resumed',
      )
      if (active) {
        replaceInbound(state, scrub({ ...inbound, state: 'handoff_requested', updatedAt: now }))
        return clone(active)
      }
      const handoff: WhatsAppHandoff = {
        requestId: randomUUID(),
        channelId: inbound.channelId,
        customer: inbound.from,
        state: 'requested',
        requestedAt: now,
        acceptedAt: null,
        resumedAt: null,
        updatedAt: now,
      }
      state.handoffs.push(handoff)
      replaceInbound(state, scrub({ ...inbound, state: 'handoff_requested', updatedAt: now }))
      return clone(handoff)
    })
  }

  handoffFor(channelId: string, customer: string): WhatsAppHandoff | null {
    const found = this.readState().handoffs.find(
      (item) => item.channelId === channelId && item.customer === customer && item.state !== 'resumed',
    )
    return found ? clone(found) : null
  }

  listHandoffs(channelId?: string): WhatsAppHandoff[] {
    return this.readState().handoffs
      .filter((item) => item.state !== 'resumed' && (channelId === undefined || item.channelId === channelId))
      .sort((a, b) => a.requestedAt - b.requestedAt)
      .map(clone)
  }

  acceptHandoff(requestId: string, now = Date.now()): WhatsAppHandoff {
    return this.transitionHandoff(requestId, 'accepted', now)
  }

  resumeHandoff(requestId: string, now = Date.now()): WhatsAppHandoff {
    return this.transitionHandoff(requestId, 'resumed', now)
  }

  deferToHuman(key: string, now = Date.now()): void {
    this.mutate((state) => {
      const record = requiredInbound(state, key)
      replaceInbound(state, scrub({ ...record, state: 'handoff_deferred', updatedAt: now }))
    })
  }

  pruneTerminal(before: number): number {
    return this.mutate((state) => {
      const terminal = new Set<WhatsAppInboundState>(['replied', 'handoff_deferred'])
      const original = state.inbounds.length
      state.inbounds = state.inbounds.filter((item) => !(terminal.has(item.state) && item.updatedAt < before))
      state.handoffs = state.handoffs.filter((item) => !(item.state === 'resumed' && item.updatedAt < before))
      return original - state.inbounds.length
    })
  }

  getThread(sessionKey: string): string | undefined {
    return this.readState().threadBindings.find((item) => item.sessionKey === sessionKey)?.threadId
  }

  setThread(sessionKey: string, threadId: string): void {
    assertNonEmpty(sessionKey, 'sessionKey')
    assertNonEmpty(threadId, 'threadId')
    this.mutate((state) => {
      state.threadBindings = [
        ...state.threadBindings.filter((item) => item.sessionKey !== sessionKey),
        { sessionKey, threadId },
      ]
    })
  }

  deleteThread(sessionKey: string): void {
    this.mutate((state) => {
      state.threadBindings = state.threadBindings.filter((item) => item.sessionKey !== sessionKey)
    })
  }

  private updateAttemptState(
    key: string,
    attemptId: string,
    attemptState: 'rejected' | 'unknown',
    outcomeCode: string,
    now: number,
  ): void {
    this.mutate((state) => {
      const record = requiredInbound(state, key)
      replaceInbound(state, updateAttempt(record, attemptId, (attempt) => ({
        ...attempt,
        state: attemptState,
        outcomeCode,
        updatedAt: now,
      })))
    })
  }

  private transitionHandoff(
    requestId: string,
    next: 'accepted' | 'resumed',
    now: number,
  ): WhatsAppHandoff {
    return this.mutate((state) => {
      const index = state.handoffs.findIndex((item) => item.requestId === requestId)
      if (index < 0) throw new Error(`WhatsApp handoff ${requestId} not found`)
      const current = state.handoffs[index]!
      if (next === 'accepted' && current.state !== 'requested') {
        throw new Error(`WhatsApp handoff ${requestId} cannot be accepted from ${current.state}`)
      }
      if (next === 'resumed' && current.state !== 'accepted') {
        throw new Error(`WhatsApp handoff ${requestId} cannot be resumed from ${current.state}`)
      }
      const updated: WhatsAppHandoff = {
        ...current,
        state: next,
        acceptedAt: next === 'accepted' ? now : current.acceptedAt,
        resumedAt: next === 'resumed' ? now : current.resumedAt,
        updatedAt: now,
      }
      state.handoffs[index] = updated
      return clone(updated)
    })
  }
}

export class InMemoryWhatsAppDeliveryStore extends BaseWhatsAppDeliveryStore {
  private state = EMPTY_STATE()

  protected readState(): DeliveryState {
    return clone(this.state)
  }

  protected mutate<T>(fn: (state: DeliveryState) => T): T {
    const state = clone(this.state)
    const result = fn(state)
    this.state = state
    return clone(result)
  }
}

export interface FileWhatsAppDeliveryStoreOptions {
  readonly dir: string
  readonly secret?: string
}

export class FileWhatsAppDeliveryStore extends BaseWhatsAppDeliveryStore {
  private readonly file: string
  private readonly lockFile: string
  private readonly key: Buffer

  constructor(opts: FileWhatsAppDeliveryStoreOptions) {
    super()
    mkdirSync(opts.dir, { recursive: true })
    this.file = join(opts.dir, 'whatsapp-delivery.enc')
    this.lockFile = join(opts.dir, 'whatsapp-delivery.lock')
    this.key = resolveKey(opts.dir, opts.secret)
  }

  protected readState(): DeliveryState {
    return this.withLock(() => this.readUnlocked())
  }

  protected mutate<T>(fn: (state: DeliveryState) => T): T {
    return this.withLock(() => {
      const state = this.readUnlocked()
      const result = fn(state)
      this.writeUnlocked(state)
      return clone(result)
    })
  }

  private readUnlocked(): DeliveryState {
    if (!existsSync(this.file)) return EMPTY_STATE()
    const decoded = decrypt(readFileSync(this.file), this.key) as DeliveryState
    if (decoded.version !== 1 || !Array.isArray(decoded.inbounds) || !Array.isArray(decoded.handoffs)) {
      throw new Error('Unsupported WhatsApp delivery store format')
    }
    return {
      ...decoded,
      inbounds: decoded.inbounds.map((record) => ({
        ...record,
        runThreadResolved: record.runThreadResolved === true,
        runThreadId: typeof record.runThreadId === 'string' ? record.runThreadId : null,
      })),
      orphanStatuses: Array.isArray(decoded.orphanStatuses) ? decoded.orphanStatuses : [],
      threadBindings: Array.isArray(decoded.threadBindings) ? decoded.threadBindings : [],
    }
  }

  private writeUnlocked(state: DeliveryState): void {
    const temp = `${this.file}.${process.pid}.${randomUUID()}.tmp`
    const fd = openSync(temp, 'wx', 0o600)
    try {
      writeSync(fd, encrypt(state, this.key))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, this.file)
    try {
      const dirFd = openSync(dirname(this.file), 'r')
      try {
        fsyncSync(dirFd)
      } finally {
        closeSync(dirFd)
      }
    } catch {
      // Some platforms do not permit fsync on directories; the file itself is synced.
    }
  }

  private withLock<T>(fn: () => T): T {
    let fd: number
    try {
      fd = openSync(this.lockFile, 'wx', 0o600)
    } catch (error) {
      if (existsSync(this.lockFile) && Date.now() - statSync(this.lockFile).mtimeMs > 30_000) {
        unlinkSync(this.lockFile)
        fd = openSync(this.lockFile, 'wx', 0o600)
      } else {
        throw new Error(`WhatsApp delivery store is busy: ${error instanceof Error ? error.message : error}`)
      }
    }
    try {
      writeSync(fd, `${process.pid} ${Date.now()}\n`)
      fsyncSync(fd)
      return fn()
    } finally {
      closeSync(fd)
      unlinkSync(this.lockFile)
    }
  }
}

export function deterministicRunKey(channelId: string, inboundId: string): string {
  const hex = createHash('sha256')
    .update('ownware.whatsapp.run.v1\0')
    .update(channelId)
    .update('\0')
    .update(inboundId)
    .digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** ThreadMap facade over the encrypted WhatsApp provider store. */
export class WhatsAppDeliveryThreadMap implements ThreadMap {
  constructor(private readonly store: WhatsAppDeliveryStore) {}

  async get(sessionKey: string): Promise<string | undefined> {
    return this.store.getThread(sessionKey)
  }

  async set(sessionKey: string, threadId: string): Promise<void> {
    this.store.setThread(sessionKey, threadId)
  }

  async delete(sessionKey: string): Promise<void> {
    this.store.deleteThread(sessionKey)
  }
}

function inboundKey(channelId: string, inboundId: string): string {
  return `${channelId}\0${inboundId}`
}

function requiredInbound(state: DeliveryState, key: string): WhatsAppInboundRecord {
  const record = state.inbounds.find((item) => item.key === key)
  if (!record) throw new Error(`WhatsApp inbound ${key} not found`)
  return record
}

function replaceInbound(state: DeliveryState, record: WhatsAppInboundRecord): void {
  const index = state.inbounds.findIndex((item) => item.key === record.key)
  if (index < 0) throw new Error(`WhatsApp inbound ${record.key} not found`)
  state.inbounds[index] = record
}

function updateAttempt(
  record: WhatsAppInboundRecord,
  attemptId: string,
  update: (attempt: WhatsAppDeliveryAttempt) => WhatsAppDeliveryAttempt,
): WhatsAppInboundRecord {
  let found = false
  const attempts = record.attempts.map((attempt) => {
    if (attempt.attemptId !== attemptId) return attempt
    found = true
    return update(attempt)
  })
  if (!found) throw new Error(`WhatsApp delivery attempt ${attemptId} not found`)
  return { ...record, attempts }
}

const STATUS_RANK: Record<WhatsAppAttemptState, number> = {
  prepared: 0,
  accepted: 1,
  sent: 2,
  delivered: 3,
  read: 4,
  rejected: 99,
  failed: 99,
  unknown: 99,
}

function applyStatus(
  attempt: WhatsAppDeliveryAttempt,
  observed: StoredProviderStatus,
  now: number,
): WhatsAppDeliveryAttempt {
  if (observed.status === 'failed' || observed.status === 'deleted') {
    return {
      ...attempt,
      state: 'failed',
      outcomeCode: observed.outcomeCode ?? observed.status,
      updatedAt: now,
    }
  }
  if (attempt.state === 'failed' || attempt.state === 'rejected' || attempt.state === 'unknown') return attempt
  const next = observed.status
  if (STATUS_RANK[next] < STATUS_RANK[attempt.state]) return attempt
  return { ...attempt, state: next, updatedAt: now }
}

function isAcceptedOrLater(attempt: WhatsAppDeliveryAttempt): boolean {
  return attempt.state === 'accepted' || attempt.state === 'sent' ||
    attempt.state === 'delivered' || attempt.state === 'read'
}

function scrub(record: WhatsAppInboundRecord): WhatsAppInboundRecord {
  return { ...record, text: null }
}

function safeCode(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_.:-]+/g, '_').slice(0, 128)
  return normalized || 'unknown'
}

function assertNonEmpty(value: string, name: string): void {
  if (!value.trim()) throw new Error(`${name} is required`)
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function encrypt(data: unknown, key: Buffer): Buffer {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(data), 'utf-8')), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), enc])
}

function decrypt(buf: Buffer, key: Buffer): unknown {
  const iv = buf.subarray(0, 12)
  const tag = buf.subarray(12, 28)
  const enc = buf.subarray(28)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  const dec = Buffer.concat([decipher.update(enc), decipher.final()])
  return JSON.parse(dec.toString('utf-8'))
}

function resolveKey(dir: string, secret?: string): Buffer {
  if (secret) return scryptSync(secret, 'ownware-whatsapp-delivery-store', 32)
  const keyFile = join(dir, 'whatsapp-delivery.key')
  if (existsSync(keyFile)) return Buffer.from(readFileSync(keyFile, 'utf-8'), 'hex')
  const key = randomBytes(32)
  writeFileSync(keyFile, key.toString('hex'), { mode: 0o600 })
  return key
}
