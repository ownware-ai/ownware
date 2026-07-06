/**
 * SlackShuttle — the Slack channel via Socket Mode (SH4), on the base.
 *
 * The agent is a bot MEMBER you @mention. Socket Mode dials out over a
 * WebSocket (no public webhook / app review). The reply goes back via the Web
 * API. `processEvent` is public so the mapping+dispatch is testable without a
 * live socket; `start()` runs the real Socket Mode loop.
 *
 * NOTE: the WS loop uses the global `WebSocket` (Node ≥ 22) and is exercised by
 * a live pass, not unit tests. Subscribe to `app_mention` (channels) + `message.im`
 * (DMs); wire `schedules[].deliver.channel` for the "every morning" post.
 */

import { ShuttleAdapter, type ShuttleConfig, type ShuttleDeps } from '../adapter.js'
import { InMemoryThreadMap } from '../thread-map.js'
import type { ThreadMap, GroupPolicy, ShuttleMessage } from '../types.js'
import type { DeliveryPolicy } from '../delivery.js'
import type { LinePolicy, LlmGate } from '../gate.js'
import type { PairingStore } from '../pairing.js'
import type { GatewayClient } from '../gateway-client.js'
import { SlackApi } from './api.js'
import { SlackTransport } from './transport.js'
import { toShuttleMessage, type SlackEvent } from './message.js'

export interface SlackShuttleOptions {
  /** Bot token `xoxb-…`. */
  readonly botToken: string
  /** App-level token `xapp-…` (Socket Mode). */
  readonly appToken: string
  readonly profileId: string
  readonly gateway: GatewayClient
  readonly threads?: ThreadMap
  /** Default `edit-stream` (Slack can update messages). */
  readonly delivery?: DeliveryPolicy
  readonly line?: LinePolicy
  readonly groupPolicy?: GroupPolicy
  readonly pairing?: PairingStore
  readonly llmGate?: LlmGate
  readonly isPaused?: (msg: ShuttleMessage) => boolean | Promise<boolean>
  readonly debounce?: { readonly ms: number; readonly maxWaitMs?: number }
  readonly fetch?: typeof fetch
  readonly baseUrl?: string
  /** Bot user id; resolved via auth.test on start if omitted (for @mention stripping). */
  readonly botUserId?: string
}

const DEFAULT_DELIVERY: DeliveryPolicy = { mode: 'edit-stream' }

export class SlackShuttle {
  private readonly api: SlackApi
  private readonly adapter: ShuttleAdapter
  private readonly transport: SlackTransport
  private botUserId: string | undefined
  private ws: WebSocket | undefined
  private running = false

  constructor(opts: SlackShuttleOptions) {
    this.api = new SlackApi({
      botToken: opts.botToken,
      appToken: opts.appToken,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
    })
    this.botUserId = opts.botUserId
    this.transport = new SlackTransport(this.api)

    const config: ShuttleConfig = {
      profileId: opts.profileId,
      channel: 'slack',
      delivery: opts.delivery ?? DEFAULT_DELIVERY,
      ...(opts.line ? { line: opts.line } : {}),
      ...(opts.groupPolicy ? { groupPolicy: opts.groupPolicy } : {}),
      ...(opts.debounce ? { debounce: opts.debounce } : {}),
    }
    const deps: ShuttleDeps = {
      gateway: opts.gateway,
      threads: opts.threads ?? new InMemoryThreadMap(),
      transport: this.transport,
      ...(opts.pairing ? { pairing: opts.pairing } : {}),
      ...(opts.llmGate ? { llmGate: opts.llmGate } : {}),
      ...(opts.isPaused ? { isPaused: opts.isPaused } : {}),
    }
    this.adapter = new ShuttleAdapter(config, deps)
  }

  /** Outbound push (schedule delivery): post `text` to a channel/DM id. */
  async sendText(target: string, text: string): Promise<void> {
    await this.transport.sendText(target, text)
  }

  async ensureIdentity(): Promise<string | undefined> {
    if (!this.botUserId) {
      const auth = await this.api.authTest()
      this.botUserId = auth.user_id
    }
    return this.botUserId
  }

  /** Map + handle one Slack event. Public for testing without a live socket. */
  async processEvent(event: SlackEvent): Promise<void> {
    const msg = toShuttleMessage(event, this.botUserId)
    if (!msg) return
    try {
      await this.adapter.handle(msg)
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[shuttle:slack] handle failed:', err instanceof Error ? err.message : err)
    }
  }

  /** Open the Socket Mode connection and stream events. */
  async start(): Promise<void> {
    await this.ensureIdentity()
    this.running = true
    const { url } = await this.api.openConnection()
    this.connect(url)
  }

  private connect(url: string): void {
    const ws = new WebSocket(url)
    this.ws = ws
    ws.addEventListener('message', (ev: MessageEvent) => {
      let env: { type?: string; envelope_id?: string; payload?: { event?: SlackEvent } }
      try {
        env = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
      } catch {
        return
      }
      if (env.type === 'events_api') {
        if (env.envelope_id) ws.send(JSON.stringify({ envelope_id: env.envelope_id })) // ack
        const event = env.payload?.event
        if (event) void this.processEvent(event)
      } else if (env.type === 'disconnect') {
        void this.reconnect()
      }
    })
    ws.addEventListener('close', () => {
      if (this.running) void this.reconnect()
    })
    ws.addEventListener('error', () => {
      /* the close handler drives reconnect */
    })
  }

  private async reconnect(): Promise<void> {
    if (!this.running) return
    try {
      const { url } = await this.api.openConnection()
      this.connect(url)
    } catch {
      /* give up until next start() */
    }
  }

  stop(): void {
    this.running = false
    this.ws?.close()
  }
}
