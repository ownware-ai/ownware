/**
 * ChannelWebhookHost — the HTTP mount for webhook-driven channels (CC0).
 *
 * Self-driving channels (telegram/slack/discord) run in ChannelRunner; the
 * webhook channels (whatsapp/sms) need a public HTTP surface a provider can
 * POST to. This host reads the SAME channel store, builds one shuttle per
 * enabled webhook channel, and mounts each at a per-channel path:
 *
 *   GET  /webhooks/whatsapp/<channelId>   Meta verification handshake
 *   POST /webhooks/whatsapp/<channelId>   Meta Cloud API events
 *   POST /webhooks/sms/<channelId>        Twilio inbound form
 *   GET  /healthz                         liveness (for tunnels/proxies)
 *
 * Discipline (learned from production BSPs — see the channel-connect board):
 *   - verify the signature FIRST, on the raw body
 *   - respond 200 fast, process async — never make the provider wait
 *   - a bad Meta signature gets 200 + drop (a 4xx makes Meta retry-storm a
 *     stale app config forever); a bad Twilio signature gets 403
 *   - dedup by provider message id (Meta re-delivers the same event)
 *   - a payload for the wrong phone_number_id is dropped, not misrouted
 *
 * Binds to loopback by default: exposing the port is an explicit act (a
 * tunnel or reverse proxy in front, or OWNWARE_WEBHOOK_HOST=0.0.0.0).
 * The listener starts only when at least one enabled webhook channel exists.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { HttpGatewayClient, type GatewayClient } from '../gateway-client.js'
import type { PairingStore } from '../pairing.js'
import { WhatsAppShuttle } from '../whatsapp/shuttle.js'
import { SmsShuttle } from '../sms/shuttle.js'
import { verifyWhatsAppSignature, type WhatsAppWebhookBody } from '../whatsapp/message.js'
import {
  InMemoryWhatsAppDeliveryStore,
  WhatsAppDeliveryThreadMap,
  type WhatsAppDeliveryStore,
  type WhatsAppProviderStatus,
} from '../whatsapp/delivery-store.js'
import type { WhatsAppSendObserver } from '../whatsapp/transport.js'
import { validateTwilioSignature } from '../sms/message.js'
import type { ChannelConfig } from './config.js'
import type { ChannelStore } from './store.js'
import { sessionKey } from '../session-key.js'

const MAX_BODY_BYTES = 1024 * 1024 // 1 MiB — provider webhooks are far smaller
const DEDUP_CAPACITY = 5000 // SMS only; WhatsApp WAMIDs use the durable provider-specific store.
const WHATSAPP_TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

export type WebhookInstance =
  | { readonly kind: 'whatsapp'; readonly config: ChannelConfig; readonly shuttle: WhatsAppShuttle }
  | { readonly kind: 'sms'; readonly config: ChannelConfig; readonly shuttle: SmsShuttle }

export type WebhookShuttleFactory = (
  config: ChannelConfig,
  gateway: GatewayClient,
  deps: {
    readonly pairing?: PairingStore
    readonly fetch?: typeof fetch
    readonly whatsappDelivery?: WhatsAppDeliveryStore
  },
) => WebhookInstance | null

/** Default factory: the webhook-driven channels. Self-driving kinds return null. */
export function defaultWebhookFactory(
  config: ChannelConfig,
  gateway: GatewayClient,
  deps: {
    readonly pairing?: PairingStore
    readonly fetch?: typeof fetch
    readonly whatsappDelivery?: WhatsAppDeliveryStore
  } = {},
): WebhookInstance | null {
  const cred = (key: string): string => {
    const v = config.credentials[key]
    if (!v) throw new Error(`channel "${config.id}" missing credential: ${key}`)
    return v
  }
  switch (config.channel) {
    case 'whatsapp': {
      return {
        kind: 'whatsapp',
        config,
        shuttle: new WhatsAppShuttle({
          accessToken: cred('accessToken'),
          phoneNumberId: cred('phoneNumberId'),
          appSecret: cred('appSecret'),
          profileId: config.profileId,
          gateway,
          ...(deps.whatsappDelivery
            ? { threads: new WhatsAppDeliveryThreadMap(deps.whatsappDelivery) }
            : {}),
          ...(config.line ? { line: config.line } : {}),
          ...(deps.pairing ? { pairing: deps.pairing } : {}),
          ...(deps.fetch ? { fetch: deps.fetch } : {}),
        }),
      }
    }
    case 'sms':
      return {
        kind: 'sms',
        config,
        shuttle: new SmsShuttle({
          accountSid: cred('accountSid'),
          authToken: cred('authToken'),
          from: cred('from'),
          profileId: config.profileId,
          gateway,
          ...(deps.fetch ? { fetch: deps.fetch } : {}),
        }),
      }
    default:
      return null // telegram / slack / discord are self-driving (ChannelRunner)
  }
}

/** Bounded insertion-order LRU of provider message ids (webhook re-delivery dedup). */
class SeenIds {
  private readonly ids = new Map<string, true>()
  constructor(private readonly capacity = DEDUP_CAPACITY) {}
  has(id: string): boolean {
    return this.ids.has(id)
  }
  add(id: string): void {
    if (this.ids.has(id)) this.ids.delete(id)
    this.ids.set(id, true)
    if (this.ids.size > this.capacity) {
      const oldest = this.ids.keys().next().value
      if (oldest !== undefined) this.ids.delete(oldest)
    }
  }
}

export interface WhatsAppFilterResult {
  readonly body: WhatsAppWebhookBody
  /** WAMIDs of the messages kept (mark them seen before async dispatch). */
  readonly ids: string[]
  readonly droppedSeen: number
  readonly droppedMismatch: number
}

/**
 * Keep only messages this channel should process: drop changes addressed to a
 * different phone_number_id (one Meta app can carry many numbers — never
 * misroute), and drop already-seen WAMIDs (Meta re-delivers). Messages
 * without an id are kept — they can't be deduped.
 */
export function filterWhatsAppInbound(
  body: WhatsAppWebhookBody,
  phoneNumberId: string,
  isSeen: (id: string) => boolean,
): WhatsAppFilterResult {
  const ids: string[] = []
  let droppedSeen = 0
  let droppedMismatch = 0
  const entry = (body.entry ?? []).map((e) => ({
    ...e,
    changes: (e.changes ?? []).flatMap((change) => {
      const value = change.value
      if (!value?.messages?.length) return [change]
      const pid = value.metadata?.phone_number_id
      if (pid !== undefined && pid !== phoneNumberId) {
        droppedMismatch += value.messages.length
        return []
      }
      const messages = value.messages.filter((m) => {
        if (m.id && isSeen(m.id)) {
          droppedSeen++
          return false
        }
        if (m.id) ids.push(m.id)
        return true
      })
      return [{ ...change, value: { ...value, messages } }]
    }),
  }))
  return { body: { ...body, entry }, ids, droppedSeen, droppedMismatch }
}

export interface WebhookHostOptions {
  readonly gateway?: GatewayClient
  readonly gatewayUrl?: string
  readonly gatewayToken?: string
  /** Pairing store handed to personal-line channels. */
  readonly pairing?: PairingStore
  /** Public base URL (e.g. the tunnel URL). Enables Twilio signature validation. */
  readonly publicBaseUrl?: string
  /** Injectable outbound fetch for provider APIs (tests). */
  readonly fetch?: typeof fetch
  readonly factory?: WebhookShuttleFactory
  /** Durable WhatsApp WAMID/delivery/handoff owner. File-backed in real CLIs. */
  readonly whatsappDelivery?: WhatsAppDeliveryStore
  /** Diagnostics sink. Default: console.error. Never receives secrets. */
  readonly log?: (line: string) => void
}

export interface WebhookHostStartOptions {
  /** Listen port. Default 3012 (`OWNWARE_WEBHOOK_PORT` in the CLIs). 0 = ephemeral. */
  readonly port?: number
  /** Bind host. Default 127.0.0.1 — exposing is an explicit act. */
  readonly host?: string
}

export interface WebhookHostStatus {
  /** Actual listen port, or null while no enabled webhook channel exists. */
  readonly port: number | null
  /** Mounted webhook paths, one per channel. */
  readonly paths: string[]
}

export class ChannelWebhookHost {
  private readonly instances = new Map<string, WebhookInstance>()
  private readonly gateway: GatewayClient
  private readonly factory: WebhookShuttleFactory
  private readonly smsSeen = new SeenIds()
  private readonly whatsappDelivery: WhatsAppDeliveryStore
  private readonly inFlight = new Set<Promise<unknown>>()
  /** Per-customer chain: preserves turn order and prevents two first messages creating two threads. */
  private readonly whatsappQueues = new Map<string, Promise<void>>()
  private readonly log: (line: string) => void
  private server: Server | null = null
  private listen: Required<WebhookHostStartOptions> = { port: 3012, host: '127.0.0.1' }
  private boundPort: number | null = null
  private recovered = false

  constructor(
    private readonly store: ChannelStore,
    private readonly opts: WebhookHostOptions = {},
  ) {
    this.gateway =
      opts.gateway ??
      new HttpGatewayClient({
        baseUrl: opts.gatewayUrl ?? 'http://127.0.0.1:3011',
        ...(opts.gatewayToken ? { token: opts.gatewayToken } : {}),
      })
    this.factory = opts.factory ?? defaultWebhookFactory
    this.whatsappDelivery = opts.whatsappDelivery ?? new InMemoryWhatsAppDeliveryStore()
    this.log = opts.log ?? ((line): void => console.error(line))
  }

  /** Build instances from the store and listen if any webhook channel exists. */
  async start(opts: WebhookHostStartOptions = {}): Promise<WebhookHostStatus> {
    this.listen = { port: opts.port ?? this.listen.port, host: opts.host ?? this.listen.host }
    await this.reload()
    return this.status()
  }

  /** Diff the store vs running instances; start/stop the listener as needed. */
  async reload(): Promise<WebhookHostStatus> {
    const wanted = new Map(
      (await this.store.list())
        .filter((c) => c.enabled !== false)
        .filter((c) => c.channel === 'whatsapp' || c.channel === 'sms')
        .map((c) => [c.id, c]),
    )
    for (const id of [...this.instances.keys()]) {
      if (!wanted.has(id)) this.instances.delete(id)
    }
    for (const [id, config] of wanted) {
      if (this.instances.has(id)) continue
      const instance = this.factory(config, this.gateway, {
        ...(this.opts.pairing ? { pairing: this.opts.pairing } : {}),
        ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}),
        whatsappDelivery: this.whatsappDelivery,
      })
      if (instance) this.instances.set(id, instance)
    }

    if (!this.recovered) {
      const pruned = this.whatsappDelivery.pruneTerminal(Date.now() - WHATSAPP_TERMINAL_RETENTION_MS)
      const recovery = this.whatsappDelivery.recover()
      this.recovered = true
      if (pruned > 0) this.log(`[webhook] WhatsApp retention: pruned ${pruned} terminal receipt(s)`)
      if (recovery.requeued > 0 || recovery.unknown > 0 || recovery.replied > 0) {
        this.log(
          `[webhook] WhatsApp recovery: ${recovery.requeued} requeued, ` +
            `${recovery.unknown} unknown, ${recovery.replied} already accepted`,
        )
      }
    }
    for (const [id, instance] of this.instances) {
      if (instance.kind !== 'whatsapp') continue
      for (const record of this.whatsappDelivery.queued(id)) {
        this.scheduleWhatsApp(instance, record.key, record.from)
      }
    }

    if (this.instances.size > 0 && !this.server) await this.startServer()
    if (this.instances.size === 0 && this.server) await this.stopServer()
    return this.status()
  }

  status(): WebhookHostStatus {
    return {
      port: this.boundPort,
      paths: [...this.instances.values()].map((i) => `/webhooks/${i.kind}/${i.config.id}`),
    }
  }

  get activeIds(): string[] {
    return [...this.instances.keys()]
  }

  /** Await all in-flight async dispatches (tests / graceful shutdown). */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight])
  }

  async stop(): Promise<void> {
    this.instances.clear()
    await this.stopServer()
    await this.idle()
  }

  private startServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        void this.route(req, res).catch((err) => {
          this.log(`[webhook] error handling ${req.method} ${req.url}: ${err instanceof Error ? err.message : err}`)
          if (!res.headersSent) respond(res, 500, 'internal error')
        })
      })
      server.once('error', reject)
      server.listen(this.listen.port, this.listen.host, () => {
        server.removeListener('error', reject)
        const addr = server.address()
        this.boundPort = typeof addr === 'object' && addr ? addr.port : this.listen.port
        this.server = server
        resolve()
      })
    })
  }

  private stopServer(): Promise<void> {
    const server = this.server
    this.server = null
    this.boundPort = null
    if (!server) return Promise.resolve()
    return new Promise((resolve) => server.close(() => resolve()))
  }

  private track(work: Promise<unknown>): void {
    const p = work.catch((err) => {
      this.log(`[webhook] dispatch failed: ${err instanceof Error ? err.message : err}`)
    })
    this.inFlight.add(p)
    void p.finally(() => this.inFlight.delete(p))
  }

  private scheduleWhatsApp(
    instance: Extract<WebhookInstance, { kind: 'whatsapp' }>,
    key: string,
    customer: string,
  ): void {
    const queueKey = `${instance.config.id}\0${customer}`
    const previous = this.whatsappQueues.get(queueKey) ?? Promise.resolve()
    const work = previous.catch(() => {}).then(() => this.dispatchWhatsApp(instance, key))
    this.whatsappQueues.set(queueKey, work)
    this.track(work.finally(() => {
      if (this.whatsappQueues.get(queueKey) === work) this.whatsappQueues.delete(queueKey)
    }))
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/healthz') return respond(res, 200, 'ok')

    const [root, kind, id] = url.pathname.split('/').filter(Boolean)
    if (root !== 'webhooks' || !kind || !id) return respond(res, 404, 'not found')
    const instance = this.instances.get(id)
    if (!instance || instance.kind !== kind) return respond(res, 404, 'not found')

    if (instance.kind === 'whatsapp') {
      if (req.method === 'GET') return this.whatsappChallenge(url, instance, res)
      if (req.method === 'POST') return this.whatsappInbound(req, res, instance)
      return respond(res, 405, 'method not allowed')
    }
    // sms
    if (req.method === 'POST') return this.smsInbound(req, res, url, instance)
    return respond(res, 405, 'method not allowed')
  }

  private whatsappChallenge(
    url: URL,
    instance: Extract<WebhookInstance, { kind: 'whatsapp' }>,
    res: ServerResponse,
  ): void {
    const verifyToken = instance.config.credentials['verifyToken']
    if (!verifyToken) {
      this.log(
        `[webhook] ${instance.config.id}: Meta verification arrived but the channel has no verifyToken credential — add one (ownware channel add whatsapp … --verify-token <value>)`,
      )
      return respond(res, 403, 'verify token not configured')
    }
    const challenge = instance.shuttle.verifyChallenge(
      {
        ...(url.searchParams.has('hub.mode') ? { 'hub.mode': url.searchParams.get('hub.mode')! } : {}),
        ...(url.searchParams.has('hub.verify_token')
          ? { 'hub.verify_token': url.searchParams.get('hub.verify_token')! }
          : {}),
        ...(url.searchParams.has('hub.challenge') ? { 'hub.challenge': url.searchParams.get('hub.challenge')! } : {}),
      },
      verifyToken,
    )
    if (challenge === null) return respond(res, 403, 'verification failed')
    respond(res, 200, challenge)
  }

  private async whatsappInbound(
    req: IncomingMessage,
    res: ServerResponse,
    instance: Extract<WebhookInstance, { kind: 'whatsapp' }>,
  ): Promise<void> {
    const raw = await readBody(req)
    if (raw === null) return respond(res, 413, 'payload too large')

    const appSecret = instance.config.credentials['appSecret']
    if (appSecret) {
      const signature = req.headers['x-hub-signature-256']
      if (typeof signature !== 'string' || !verifyWhatsAppSignature(appSecret, raw, signature)) {
        // 200, not 4xx: a 4xx makes Meta retry the same (stale/foreign) event
        // indefinitely. Log and drop — the event never reaches the agent.
        this.log(`[webhook] ${instance.config.id}: invalid Meta signature — event dropped`)
        return respond(res, 200, 'ok')
      }
    }

    let body: WhatsAppWebhookBody
    try {
      body = JSON.parse(raw) as WhatsAppWebhookBody
    } catch {
      this.log(`[webhook] ${instance.config.id}: unparseable Meta payload — dropped`)
      return respond(res, 200, 'ok')
    }
    if (body.object !== 'whatsapp_business_account') {
      this.log(`[webhook] ${instance.config.id}: non-WhatsApp webhook object — dropped`)
      return respond(res, 200, 'ok')
    }

    const phoneNumberId = instance.config.credentials['phoneNumberId'] ?? ''
    const filtered = filterWhatsAppInbound(
      body,
      phoneNumberId,
      (wamid) => this.whatsappDelivery.hasInbound(instance.config.id, wamid),
    )
    if (filtered.droppedMismatch > 0) {
      this.log(
        `[webhook] ${instance.config.id}: dropped ${filtered.droppedMismatch} message(s) for a different phone_number_id`,
      )
    }

    const queued: Array<{ readonly key: string; readonly customer: string }> = []
    for (const entry of filtered.body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value
        if (change.field !== 'messages' || value?.messaging_product !== 'whatsapp') continue
        if (!value || (value.metadata?.phone_number_id !== undefined && value.metadata.phone_number_id !== phoneNumberId)) {
          continue
        }
        for (const status of value.statuses ?? []) {
          if (!status.id || !isWhatsAppProviderStatus(status.status)) continue
          const code = status.errors?.[0]?.code
          this.whatsappDelivery.recordStatus(
            status.id,
            status.status,
            code === undefined ? '' : `meta_${code}`,
            parseProviderTimestamp(status.timestamp),
          )
        }
        for (const message of value.messages ?? []) {
          if (message.type !== 'text' || !message.from || !message.text?.body?.trim()) continue
          if (!message.id) {
            this.log(`[webhook] ${instance.config.id}: text message without WAMID — dropped`)
            continue
          }
          const accepted = this.whatsappDelivery.enqueue({
            channelId: instance.config.id,
            phoneNumberId,
            inboundId: message.id,
            from: message.from,
            text: message.text.body,
          })
          if (accepted.added) queued.push({ key: accepted.record.key, customer: accepted.record.from })
        }
      }
    }

    // Durable ownership is established above. Meta can now stop retrying while
    // the run and outbound delivery proceed asynchronously.
    respond(res, 200, 'ok')
    for (const item of queued) this.scheduleWhatsApp(instance, item.key, item.customer)
  }

  private async dispatchWhatsApp(
    instance: Extract<WebhookInstance, { kind: 'whatsapp' }>,
    key: string,
  ): Promise<void> {
    const record = this.whatsappDelivery.claim(key)
    if (!record || record.text === null) return

    const observer: WhatsAppSendObserver = {
      prepare: (target, text) => this.whatsappDelivery.prepareAttempt(key, target, text).attemptId,
      accepted: (attemptId, providerMessageId) => {
        this.whatsappDelivery.markAttemptAccepted(key, attemptId, providerMessageId)
      },
      rejected: (attemptId, code) => {
        this.whatsappDelivery.markAttemptRejected(key, attemptId, code)
      },
      unknown: (attemptId, code) => {
        this.whatsappDelivery.markAttemptUnknown(key, attemptId, code)
      },
    }

    if (record.text.trim() === '/human') {
      if (instance.config.line?.handoff !== 'on-request') {
        try {
          await instance.shuttle.sendText(
            record.from,
            'Human takeover is not configured for this line. Please contact the business through its published support route.',
            observer,
          )
          this.whatsappDelivery.finishReply(key)
        } catch {
          this.whatsappDelivery.finishFailure(key)
        }
        return
      }
      const handoff = this.whatsappDelivery.requestHandoff(key)
      try {
        await instance.shuttle.sendText(
          record.from,
          'I’ve asked a person to take over. They have not accepted yet; you can keep using this chat when they do.',
          observer,
        )
      } catch {
        this.whatsappDelivery.finishFailure(key)
      }
      this.log(`[webhook] ${instance.config.id}: human handoff requested (${handoff.requestId})`)
      return
    }

    if (this.whatsappDelivery.handoffFor(record.channelId, record.from)) {
      this.whatsappDelivery.deferToHuman(key)
      return
    }

    const body: WhatsAppWebhookBody = {
      object: 'whatsapp_business_account',
      entry: [{
        changes: [{
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { phone_number_id: record.phoneNumberId },
            messages: [{
              from: record.from,
              id: record.inboundId,
              type: 'text',
              text: { body: record.text },
            }],
          },
        }],
      }],
    }
    const stableRun = this.whatsappDelivery.bindRunThread(
      key,
      this.whatsappDelivery.getThread(sessionKey({
        profile: instance.config.profileId,
        channel: 'whatsapp',
        chatType: 'dm',
        chatId: record.from,
      })) ?? null,
    )
    try {
      await instance.shuttle.handleInbound(body, {
        runIdempotencyKey: record.runIdempotencyKey,
        gatewayThreadId: stableRun.runThreadId,
        sendObserver: observer,
      })
      this.whatsappDelivery.finishReply(key)
    } catch (error) {
      this.whatsappDelivery.finishFailure(key)
      this.log(
        `[webhook] ${instance.config.id}: inbound ${record.inboundId} failed ` +
          `(${error instanceof Error ? error.name : 'unknown_error'})`,
      )
    }
  }

  private async smsInbound(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    instance: Extract<WebhookInstance, { kind: 'sms' }>,
  ): Promise<void> {
    const raw = await readBody(req)
    if (raw === null) return respond(res, 413, 'payload too large')
    const params = Object.fromEntries(new URLSearchParams(raw))

    const authToken = instance.config.credentials['authToken']
    const signature = req.headers['x-twilio-signature']
    if (this.opts.publicBaseUrl && authToken) {
      const fullUrl = this.opts.publicBaseUrl.replace(/\/+$/, '') + url.pathname
      if (typeof signature !== 'string' || !validateTwilioSignature(authToken, fullUrl, params, signature)) {
        this.log(`[webhook] ${instance.config.id}: invalid Twilio signature — rejected`)
        return respond(res, 403, 'invalid signature')
      }
    }

    const sid = params['MessageSid']
    if (sid) {
      if (this.smsSeen.has(sid)) return respondTwiml(res)
      this.smsSeen.add(sid)
    }

    respondTwiml(res) // reply goes out via the REST API, not the webhook response
    this.track(instance.shuttle.handleInbound(params))
  }
}

function isWhatsAppProviderStatus(value: string | undefined): value is WhatsAppProviderStatus {
  return value === 'sent' || value === 'delivered' || value === 'read' ||
    value === 'failed' || value === 'deleted'
}

function parseProviderTimestamp(value: string | undefined): number {
  if (value && /^\d+$/.test(value)) {
    const millis = Number(value) * 1000
    if (Number.isSafeInteger(millis) && millis >= 0) return millis
  }
  return Date.now()
}

function respond(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end(text)
}

function respondTwiml(res: ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'text/xml' })
  res.end('<?xml version="1.0" encoding="UTF-8"?><Response/>')
}

/**
 * Read the request body up to MAX_BODY_BYTES; null when over the cap. On
 * overflow the rest of the stream is drained (not destroyed) so the 413
 * response can still be written on the open connection.
 */
function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let overflow = false
    req.on('data', (chunk: Buffer) => {
      if (overflow) return // drain
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        overflow = true
        chunks.length = 0
        resolve(null)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!overflow) resolve(Buffer.concat(chunks).toString('utf-8'))
    })
    req.on('error', (err) => {
      if (!overflow) reject(err)
    })
  })
}
